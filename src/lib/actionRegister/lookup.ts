/** Shared action-register primitives. Code is open-ended; warning emission keeps its own closed list. */
import type { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { canReadMemory, filterReadableMemoryIds } from '../../mcp/access-control.js';
import { findEffectiveNodeIdByLoc, systemMemoryChain } from '../effectiveSystemMemory.js';
import { locateTeamAgent } from '../../api/graphql/schema/resolvers.worker.js';

export function registerTaskLoc(data: unknown, code: string): string | null {
  const entry = (data as { registerEntry?: { code?: unknown; taskLoc?: unknown } } | null | undefined)?.registerEntry;
  if (!entry || entry.code !== code) return null;
  const loc = entry.taskLoc;
  return typeof loc === 'string' && loc.trim() !== '' && loc.length <= 512 ? loc : null;
}

/** Legacy warning semantics: nearest effective entry, then gate; never fall through on refusal/malformed data. */
export async function registerEntry(tx: Prisma.TransactionClient, memoryId: string, code: string, readable: (id: string) => Promise<boolean>): Promise<{ taskLoc: string; memoryId: string } | null> {
  const hit = await findEffectiveNodeIdByLoc(tx, memoryId, 'register:' + code);
  const node = hit && await readable(hit.memoryId) ? await tx.node.findFirst({ where: { id: hit.id, memoryId: hit.memoryId, deletedAt: null }, select: { data: true, deletedAt: true } }) : null;
  const taskLoc = registerTaskLoc(node?.deletedAt ? null : node?.data, code);
  return taskLoc && hit ? { taskLoc, memoryId: hit.memoryId } : null;
}

export type RoleTask = { memoryId: string; task: { loc: string; urn: string } | null };
/** Locate once, gate the chosen memory, and never substitute a farther task after refusal. */
export async function nearestRoleTask(tx: Prisma.TransactionClient, memoryId: string, loc: string, readable: (id: string) => Promise<boolean>): Promise<RoleTask | null> {
  const hit = await findEffectiveNodeIdByLoc(tx, memoryId, loc);
  if (!hit) return null;
  if (!await readable(hit.memoryId)) return { memoryId: hit.memoryId, task: null };
  const node = await tx.node.findFirst({ where: { id: hit.id, memoryId: hit.memoryId, deletedAt: null }, select: { loc: true, isRunnable: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } } });
  return { memoryId: hit.memoryId, task: node && !node.deletedAt && !node.memory.deletedAt && node.isRunnable
    ? { loc: node.loc, urn: 'hrn:node:' + node.memory.urn + ':' + node.loc } : null };
}

export type RegisterEntry =
  | { state: 'UNMAPPED'; checkedMemoryIds: string[] }
  | { state: 'WITHHELD'; checkedMemoryIds: string[] }
  | { state: 'FOUND'; taskLoc: string; memoryId: string; checkedMemoryIds: string[] };

type EntryRow = { data: unknown; nodeType: string; role: string | null; memoryDeleted: boolean };
type TaskRow = { loc: string; isRunnable: boolean | null; urn: string; memoryDeleted: boolean };

/**
 * #2950: the register rows one bounded transaction reads, shared by every
 * {@link RegisterLookup} of that transaction. It holds ROWS, never an answer
 * about who may read them: a principal reaches a row only through its own
 * lookup, after its own `readable` check on the memory the row lives in
 * (cor:agt:110:03, resolution never borrows another principal's access).
 * Every read stays pinned to the memory being walked or gated, as the
 * per-principal reads it replaces were.
 *
 * Entries: when `codes` lists the codes this transaction will ask for, the
 * first read of a memory fetches that memory's `register:<code>` rows for all
 * of them in one query, so the cost of a code no longer multiplies by holders
 * or chain depth (#2852: 83 codes x 5 holders x depth repeated one findFirst
 * each). A code outside `codes` is read alone, as before.
 *
 * Tasks: the nearest-first location of a loc through a memory's chain, and the
 * row at that location (fetched by id AND the located memory, so a node moved
 * meanwhile is not followed), are computed once per transaction for every
 * principal.
 */
export class RegisterData {
  private entryBatches = new Map<string, Promise<Map<string, EntryRow>>>();
  private entrySingles = new Map<string, Promise<EntryRow | null>>();
  private locations = new Map<string, ReturnType<typeof findEffectiveNodeIdByLoc>>();
  private taskRows = new Map<string, Promise<TaskRow | null>>();
  private readonly codes: ReadonlySet<string>;
  /** #3048: per-principal batched readability for this transaction. Answers are keyed by principal, never shared. */
  readonly readability: PrincipalReadability;
  constructor(readonly tx: Prisma.TransactionClient, codes: Iterable<string> = []) {
    this.codes = new Set(codes);
    this.readability = new PrincipalReadability(tx);
  }

  /** The live `register:<code>` row of `memoryId`, unfiltered by role or type (the caller applies the chain rule). */
  entryRow(memoryId: string, code: string): Promise<EntryRow | null> {
    if (this.codes.has(code)) {
      let batch = this.entryBatches.get(memoryId);
      if (!batch) {
        batch = this.tx.node.findMany({
          where: { memoryId, loc: { in: [...this.codes].map(c => 'register:' + c) }, deletedAt: null },
          select: { loc: true, data: true, nodeType: true, role: true, memory: { select: { deletedAt: true } } },
        }).then(rows => new Map(rows.map(r => [r.loc, { data: r.data, nodeType: r.nodeType, role: r.role, memoryDeleted: !!r.memory.deletedAt }])));
        this.entryBatches.set(memoryId, batch);
      }
      return batch.then(rows => rows.get('register:' + code) ?? null);
    }
    const key = memoryId + '\u0000' + code;
    let single = this.entrySingles.get(key);
    if (!single) {
      single = this.tx.node.findFirst({
        where: { memoryId, loc: 'register:' + code, deletedAt: null },
        select: { data: true, nodeType: true, role: true, memory: { select: { deletedAt: true } } },
      }).then(r => r ? { data: r.data, nodeType: r.nodeType, role: r.role, memoryDeleted: !!r.memory.deletedAt } : null);
      this.entrySingles.set(key, single);
    }
    return single;
  }

  /** Nearest-first location of `loc` through `memoryId`'s chain (principal-independent). */
  taskLocation(memoryId: string, loc: string): ReturnType<typeof findEffectiveNodeIdByLoc> {
    const key = memoryId + '\u0000' + loc;
    let hit = this.locations.get(key);
    if (!hit) { hit = findEffectiveNodeIdByLoc(this.tx, memoryId, loc); this.locations.set(key, hit); }
    return hit;
  }

  /** The located node, pinned to the memory it was located (and gated) in. */
  taskRow(id: string, memoryId: string): Promise<TaskRow | null> {
    const key = id + '\u0000' + memoryId;
    let row = this.taskRows.get(key);
    if (!row) {
      row = this.tx.node.findFirst({ where: { id, memoryId, deletedAt: null }, select: { loc: true, isRunnable: true, memory: { select: { urn: true, deletedAt: true } } } })
        .then(n => n ? { loc: n.loc, isRunnable: n.isRunnable, urn: n.memory.urn, memoryDeleted: !!n.memory.deletedAt } : null);
      this.taskRows.set(key, row);
    }
    return row;
  }
}

/** Not inherited through a chain: a comment, or a boot prompt (the filter `readEntry` applied in SQL before #2950). */
export function inheritable(row: Pick<EntryRow, 'nodeType' | 'role'>): boolean {
  return row.nodeType !== 'comment' && (row.role === null || (row.role !== 'boot-prompt' && !row.role.startsWith('boot-prompt.')));
}

/**
 * #3048: each principal's memory readability, answered for a whole set of
 * memories in ONE read instead of one `canReadMemory` round per memory.
 *
 * The caller declares the memories the transaction will ask about
 * ({@link cover}); the first question a principal asks about one of them reads
 * that principal's answers for all of them through `filterReadableMemoryIds`,
 * the batch companion of the mcp `canReadMemory` (src/mcp/access-control.ts):
 * the same rows, the same access map (`getMemoryAccess`, or none for a
 * platform ADMIN/OWNER, exactly as `canReadMemory` leaves it), and the same
 * per-row decision (`canReadMemoryRow`, which keeps FR-016: a personal memory
 * stays its owner's, even for ADMIN/OWNER). No GraphQL gate and no copy of a
 * predicate is used.
 *
 * Answers are keyed by the principal's OWN context object and never consulted
 * for another (cor:agt:110:03): the reader and each holder have their own
 * batch, even when they are the same person. A memory outside a principal's
 * batch (not declared before that principal's first question) is answered by
 * `canReadMemory` alone, as before. The batch lives as long as the
 * transaction's {@link RegisterData}: one enrichment call, never cached across
 * calls, so a revocation is honoured on the next call (cor:agt:080:23).
 *
 * Only membership is batched; the walks still ask nearest first and stop at the
 * first unreadable memory, so a farther readable memory never replaces a nearer
 * unreadable one (cor:agt:110:03 step 2).
 */
export class PrincipalReadability {
  private readonly covered = new Set<string>();
  private readonly batches = new Map<Context, { ids: ReadonlySet<string>; readable: Promise<Set<string>> }>();
  constructor(private readonly tx: Prisma.TransactionClient) {}

  /** Declare memories this transaction will ask about. A principal's batch covers what was declared before its first question. */
  cover(memoryIds: Iterable<string>): void { for (const id of memoryIds) this.covered.add(id); }

  /** `ctx`'s answer for `memoryId` from its own batch, or null when the memory is outside it (ask `canReadMemory`). */
  answer(ctx: Context, memoryId: string): Promise<boolean> | null {
    if (!this.covered.has(memoryId)) return null;
    let batch = this.batches.get(ctx);
    if (!batch) {
      const ids: ReadonlySet<string> = new Set(this.covered);
      batch = { ids, readable: filterReadableMemoryIds(this.tx as never, ctx as never, ids) };
      this.batches.set(ctx, batch);
    }
    if (!batch.ids.has(memoryId)) return null;
    return batch.readable.then(readable => readable.has(memoryId));
  }
}

/**
 * One bounded transaction owns this memo, for ONE principal. Neither principals nor answers escape to another
 * request, and no answer is shared between principals: only the rows in {@link RegisterData} are (#2950).
 */
export class RegisterLookup {
  private entries = new Map<string, Promise<RegisterEntry>>();
  private tasks = new Map<string, ReturnType<typeof nearestRoleTask>>();
  private readability = new Map<string, Promise<boolean>>();
  private chains = new Map<string, Promise<string[]>>();
  private team: Promise<string | null> | undefined;
  readonly data: RegisterData;
  constructor(readonly tx: Prisma.TransactionClient, readonly ctx: Context, readonly appId: string, readonly deadline: number, readonly ungatedWorker = false, readonly teamMemoryHint?: string | null, data?: RegisterData) {
    // The shared rows belong to ONE bounded transaction; a lookup gating in another would read rows outside its own.
    if (data && data.tx !== tx) throw new Error('RegisterLookup: shared RegisterData belongs to another transaction');
    this.data = data ?? new RegisterData(tx);
  }

  checkDeadline(): void { if (Date.now() >= this.deadline) throw new Error('Register read deadline'); }

  /** Complete bounded topology for the tick reader's whole-chain disclosure gate. */
  chain(memoryId: string): Promise<string[]> {
    this.checkDeadline();
    let result = this.chains.get(memoryId);
    if (!result) {
      result = systemMemoryChain(this.tx, memoryId).then(links => links.length ? links.map(link => link.memoryId) : [memoryId]);
      this.chains.set(memoryId, result);
    }
    return result;
  }

  readable(ctx: Context, memoryId: string, principalKey: string): Promise<boolean> {
    this.checkDeadline();
    if (this.ungatedWorker) return Promise.resolve(true);
    const key = principalKey + '\u0000' + memoryId;
    let answer = this.readability.get(key);
    if (!answer) {
      answer = this.data.readability.answer(ctx, memoryId) ?? canReadMemory(this.tx as never, ctx as never, memoryId);
      this.readability.set(key, answer);
    }
    return answer;
  }

  async teamMemory(): Promise<string | null> {
    this.checkDeadline();
    if (this.teamMemoryHint !== undefined) return this.teamMemoryHint;
    this.team ??= (async () => {
      try { return (await locateTeamAgent(this.ctx, this.appId, undefined)).systemMemoryId; }
      catch (e) {
        const code = (e as { extensions?: { code?: string } }).extensions?.code;
        if (code === 'TEAM_AGENT_NOT_FOUND' || code === 'TEAM_AGENT_AMBIGUOUS') return null;
        throw e;
      }
    })();
    return this.team;
  }

  /** R1=C: never consult the contents of an unreadable link, including an empty one. */
  entry(code: string): Promise<RegisterEntry> {
    this.checkDeadline();
    let result = this.entries.get(code);
    if (!result) { result = this.readEntry(code); this.entries.set(code, result); }
    return result;
  }

  private async readEntry(code: string): Promise<RegisterEntry> {
    const memoryId = await this.teamMemory();
    if (!memoryId) return { state: 'UNMAPPED', checkedMemoryIds: [] };
    const chain = await this.chain(memoryId);
    const checkedMemoryIds: string[] = [];
    let malformed = false;
    for (const id of chain) {
      this.checkDeadline();
      checkedMemoryIds.push(id);
      if (!await this.readable(this.ctx, id, 'reader')) return { state: 'WITHHELD', checkedMemoryIds };
      if (malformed) continue; // no farther mapping may replace the nearest malformed entry
      // #2950: the row comes from the transaction's shared rows, read only after THIS principal's gate above.
      const row = await this.data.entryRow(id, code);
      const node = row && (id === memoryId || inheritable(row)) ? row : null;
      if (!node) continue;
      const loc = node.memoryDeleted ? null : registerTaskLoc(node.data, code);
      if (loc) return { state: 'FOUND', taskLoc: loc, memoryId: id, checkedMemoryIds };
      malformed = true;
    }
    return { state: 'UNMAPPED', checkedMemoryIds };
  }

  task(memoryId: string, loc: string): ReturnType<typeof nearestRoleTask> {
    this.checkDeadline();
    const key = memoryId + '\u0000' + loc;
    let result = this.tasks.get(key);
    if (!result) { result = this.resolveTask(memoryId, loc); this.tasks.set(key, result); }
    return result;
  }

  /** {@link nearestRoleTask} over the shared rows: locate once, gate the chosen memory as THIS principal, never substitute a farther task. */
  private async resolveTask(memoryId: string, loc: string): Promise<RoleTask | null> {
    const hit = await this.data.taskLocation(memoryId, loc);
    if (!hit) return null;
    if (!await this.readable(this.ctx, hit.memoryId, 'self')) return { memoryId: hit.memoryId, task: null };
    const node = await this.data.taskRow(hit.id, hit.memoryId);
    return { memoryId: hit.memoryId, task: node && !node.memoryDeleted && node.isRunnable
      ? { loc: node.loc, urn: 'hrn:node:' + node.urn + ':' + node.loc } : null };
  }
}
