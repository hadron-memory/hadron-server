/** Shared action-register primitives. Code is open-ended; warning emission keeps its own closed list. */
import type { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { canReadMemory } from '../../mcp/access-control.js';
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
  const node = hit && await readable(hit.memoryId) ? await tx.node.findUnique({ where: { id: hit.id }, select: { data: true, deletedAt: true } }) : null;
  const taskLoc = registerTaskLoc(node?.deletedAt ? null : node?.data, code);
  return taskLoc && hit ? { taskLoc, memoryId: hit.memoryId } : null;
}

export type RoleTask = { memoryId: string; task: { loc: string; urn: string } | null };
/** Locate once, gate the chosen memory, and never substitute a farther task after refusal. */
export async function nearestRoleTask(tx: Prisma.TransactionClient, memoryId: string, loc: string, readable: (id: string) => Promise<boolean>): Promise<RoleTask | null> {
  const hit = await findEffectiveNodeIdByLoc(tx, memoryId, loc);
  if (!hit) return null;
  if (!await readable(hit.memoryId)) return { memoryId: hit.memoryId, task: null };
  const node = await tx.node.findUnique({ where: { id: hit.id }, select: { loc: true, isRunnable: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } } });
  return { memoryId: hit.memoryId, task: node && !node.deletedAt && !node.memory.deletedAt && node.isRunnable
    ? { loc: node.loc, urn: 'hrn:node:' + node.memory.urn + ':' + node.loc } : null };
}

export type RegisterEntry =
  | { state: 'UNMAPPED'; checkedMemoryIds: string[] }
  | { state: 'WITHHELD'; checkedMemoryIds: string[] }
  | { state: 'FOUND'; taskLoc: string; memoryId: string; checkedMemoryIds: string[] };

/** One bounded transaction owns this memo. Neither principals nor answers escape to another request. */
export class RegisterLookup {
  private entries = new Map<string, Promise<RegisterEntry>>();
  private tasks = new Map<string, ReturnType<typeof nearestRoleTask>>();
  private readability = new Map<string, Promise<boolean>>();
  private team: Promise<string | null> | undefined;
  constructor(readonly tx: Prisma.TransactionClient, readonly ctx: Context, readonly appId: string, readonly deadline: number, readonly ungatedWorker = false, readonly teamMemoryHint?: string | null) {}

  checkDeadline(): void { if (Date.now() >= this.deadline) throw new Error('Register read deadline'); }

  readable(ctx: Context, memoryId: string, principalKey: string): Promise<boolean> {
    this.checkDeadline();
    if (this.ungatedWorker) return Promise.resolve(true);
    const key = principalKey + '\u0000' + memoryId;
    let answer = this.readability.get(key);
    if (!answer) {
      answer = canReadMemory(this.tx as never, ctx as never, memoryId);
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
    const chain = await systemMemoryChain(this.tx, memoryId);
    const checkedMemoryIds: string[] = [];
    let malformed = false;
    for (const link of chain.length ? chain : [{ memoryId }]) {
      this.checkDeadline();
      checkedMemoryIds.push(link.memoryId);
      if (!await this.readable(this.ctx, link.memoryId, 'reader')) return { state: 'WITHHELD', checkedMemoryIds };
      if (malformed) continue; // no farther mapping may replace the nearest malformed entry
      const node = await this.tx.node.findFirst({
        where: { memoryId: link.memoryId, loc: 'register:' + code, deletedAt: null,
          ...(link.memoryId !== memoryId ? { nodeType: { not: 'comment' }, OR: [{ role: null }, { NOT: [{ role: 'boot-prompt' }, { role: { startsWith: 'boot-prompt.' } }] }] } : {}) },
        select: { data: true, memory: { select: { deletedAt: true } } },
      });
      if (!node) continue;
      const loc = node.memory.deletedAt ? null : registerTaskLoc(node.data, code);
      if (loc) return { state: 'FOUND', taskLoc: loc, memoryId: link.memoryId, checkedMemoryIds };
      malformed = true;
    }
    return { state: 'UNMAPPED', checkedMemoryIds };
  }

  task(memoryId: string, loc: string): ReturnType<typeof nearestRoleTask> {
    this.checkDeadline();
    const key = memoryId + '\u0000' + loc;
    let result = this.tasks.get(key);
    if (!result) { result = nearestRoleTask(this.tx, memoryId, loc, id => this.readable(this.ctx, id, 'self')); this.tasks.set(key, result); }
    return result;
  }
}
