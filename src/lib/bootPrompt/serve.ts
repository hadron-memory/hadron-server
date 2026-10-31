/**
 * #2047 (S10, cor:agt:040:07/:09/:10) — the ONE resolver that decides which boot prompt a bind, a chatbot chat or a
 * headless run is served, and refuses all three the same way.
 *
 * Serve order is a replacement, never an append: the worker's pointer, else the install's (`AppAgent`), else the Agent's.
 * The first pointer that is SET decides; a set pointer whose node is gone is `BOOT_PROMPT_TARGET_DELETED`, never a
 * fall-through to a lower level (R27). The node served is the pointed-to compiled node's NEWEST APPROVED revision, as it
 * was approved (`newestApprovedRevisionOf`: the text that qualified, so a newer unapproved edit is not served and not
 * a refusal). Only the compiled node is checked; the parts it was compiled from are not re-checked (cor:agt:040:09).
 *
 * The result carries the compiled text with its platform variables still unfilled: the caller fills them from what it
 * knows (a bind knows its worker, a chat only its Agent) and records the values it used.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { newestApprovedRevisionOf } from '../nodeApproval.js';
import { resolveBootPromptPointer, type StoredBootPromptPointer } from '../bootPromptPointer.js';
import { readCompiledRevision, sha256Hex } from '../bootCompile/provenance.js';
import { generateId } from '../id.js';
import { bootPromptRefusal, type BootPromptSurface } from './refusal.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type ServedPointerLevel = 'WORKER' | 'APP_AGENT' | 'AGENT';

export interface ServedBootPrompt {
  pointerLevel: ServedPointerLevel;
  compiledNodeId: string;
  /** `Node.revSeq` of the revision served. */
  servedRevSeq: number;
  /** The compile revision that owns the provenance: the greatest compile revision at or below `servedRevSeq`. */
  provenanceRevSeq: number;
  compiledContentHash: string;
  /** `[{nodeId, revSeq, hash}]`, copied from the compile revision's own provenance. */
  provenance: Array<{ nodeId: string; revSeq: number; hash: string }>;
  /** The compiled text, platform variables unfilled. */
  content: string;
}

export interface ServeTarget {
  surface: BootPromptSurface;
  /** The serving App. A chat held in a memory with no App has none: it serves the Agent's pointer only. */
  appId: string | null;
  agent: { id: string; name: string };
  /** Present on a bind (and a run that names a worker); a chat and an agent-only run have none. */
  workerId?: string | null;
}

/**
 * The seam for the organisation's signing switch (#1614, ruled a seam in v3 Gap 5). Until that switch exists no App's
 * organisation can require a signed prompt, so nothing is refused as unsigned; when it ships this is the one place that
 * reads the SERVING App's organisation and `BOOT_PROMPT_NOT_SIGNED` follows.
 */
async function servingAppRequiresSignature(_db: Db, _appId: string): Promise<boolean> {
  return false;
}

/** The pointer that decides, highest level first, or null when none is set anywhere. `skipWorker`: the worker level was already judged. */
async function decidingPointer(
  db: Db,
  t: ServeTarget,
  skipWorker = false,
): Promise<{ level: ServedPointerLevel; stored: StoredBootPromptPointer } | null> {
  const select = { bootPromptNodeId: true, bootPromptUrn: true } as const;
  if (t.workerId && !skipWorker) {
    const w = await db.worker.findUnique({ where: { id: t.workerId }, select });
    if (w?.bootPromptNodeId) return { level: 'WORKER', stored: w };
  }
  const install = t.appId ? await db.appAgent.findFirst({ where: { appId: t.appId, agentId: t.agent.id }, select }) : null;
  if (install?.bootPromptNodeId) return { level: 'APP_AGENT', stored: install };
  const agent = await db.agent.findUnique({ where: { id: t.agent.id }, select });
  if (agent?.bootPromptNodeId) return { level: 'AGENT', stored: agent };
  return null;
}

/**
 * #2971 — what the workers of ONE `workers` page share: the serve below the worker level (install, then Agent) is the
 * same for every uncustomised worker of one (App, Agent), so one page resolves it once. The map holds the PROMISE of the
 * outcome, a typed refusal included (R27: a deleted install target is a refusal for every worker below it, never a
 * fall-through). It belongs to one page resolution and is dropped with its rows: a briefing is never cached
 * (cor:agt:020:01), so nothing here may be attached to a request context or outlive the page.
 */
export type PageServedMemo = Map<string, Promise<ServedBootPrompt>>;

/**
 * Resolve what to serve, or throw the typed refusal. Reads only; the caller records what it served.
 *
 * With `page`, a worker's OWN pointer is still read and judged first, per worker (cor:agt:040:07: a customised worker
 * is never answered with the install's or the Agent's text, and its own deleted target never falls through); only a worker
 * with no pointer of its own shares the lower levels' outcome with the rest of the page. `workerPointer` is that worker's
 * pointer columns when the caller already holds the row (a page does), else they are read.
 */
export async function resolveServedBootPrompt(
  db: Db,
  t: ServeTarget,
  page?: { memo: PageServedMemo; workerPointer?: { bootPromptNodeId: string | null; bootPromptUrn: string | null } | null },
): Promise<ServedBootPrompt> {
  if (page && t.workerId) {
    const own = page.workerPointer !== undefined
      ? page.workerPointer
      : await db.worker.findUnique({ where: { id: t.workerId }, select: { bootPromptNodeId: true, bootPromptUrn: true } });
    if (!own?.bootPromptNodeId) {
      const key = `${t.appId ?? ''}:${t.agent.id}`;
      let outcome = page.memo.get(key);
      if (!outcome) {
        outcome = resolveFrom(db, t, true);
        page.memo.set(key, outcome);
        // A refusal is the answer and stays; anything else (a dropped connection) must not be served to the rest of the page.
        outcome.catch((err) => {
          const code = (err as { extensions?: { code?: unknown } }).extensions?.code;
          if (typeof code !== 'string' || !code.startsWith('BOOT_PROMPT_')) page.memo.delete(key);
        });
      }
      return outcome;
    }
  }
  return resolveFrom(db, t, false);
}

async function resolveFrom(db: Db, t: ServeTarget, skipWorker: boolean): Promise<ServedBootPrompt> {
  const where = { surface: t.surface, agentName: t.agent.name };
  const pointer = await decidingPointer(db, t, skipWorker);
  if (!pointer) throw bootPromptRefusal('BOOT_PROMPT_NOT_SET', where);
  const resolved = await resolveBootPromptPointer(db, pointer.stored);
  if (!resolved || resolved.deleted) throw bootPromptRefusal('BOOT_PROMPT_TARGET_DELETED', where);

  // #2047 PR-C: share-lock the compiled node BEFORE selecting the revision, and hold it to the end of the caller's
  // transaction (a bind and a run select and record in one). Cap-pruning takes the node's row lock first, so a prune that
  // started earlier finishes before this selects (the revision it removed is no longer a candidate) and one that starts
  // later waits until the record commits and then sees it. Outside a transaction (a preview, a chat) the lock is released
  // at once, which is harmless: those retain nothing.
  await db.$queryRaw`SELECT id FROM nodes WHERE id = ${resolved.nodeId} FOR SHARE`;

  if (t.appId && (await servingAppRequiresSignature(db, t.appId))) {
    // Unreachable until #1614 supplies the signature check; fail closed rather than serve unsigned text.
    throw bootPromptRefusal('BOOT_PROMPT_NOT_SIGNED', where);
  }

  // Selection and retrieval are two reads, so a recompile between them could pair an old revision number with newer,
  // unapproved text. The content is therefore read ONLY at the selected revision number (live row if it is still that
  // revision, else its retained snapshot); when neither can be pinned the selection moved, so select again.
  let found: NonNullable<Awaited<ReturnType<typeof newestApprovedRevisionOf>>['found']> | null = null;
  let content: string | null = null;
  for (let attempt = 0; attempt < APPROVED_READ_ATTEMPTS && content === null; attempt++) {
    ({ found } = await newestApprovedRevisionOf(db, resolved.nodeId));
    if (!found) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);
    content = await approvedContent(db, resolved.nodeId, found.revNo);
  }
  if (!found || content === null) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);

  const provenanceRevSeq = await provenanceRevisionAtOrBelow(db, resolved.nodeId, found.revNo);
  if (provenanceRevSeq === null) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);
  const revision = await readCompiledRevision(db, resolved.nodeId, provenanceRevSeq);
  if (!revision) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);
  return {
    pointerLevel: pointer.level,
    compiledNodeId: resolved.nodeId,
    servedRevSeq: found.revNo,
    provenanceRevSeq,
    compiledContentHash: sha256Hex(content),
    provenance: revision.provenance.occurrences.map((o) => ({ nodeId: o.nodeId, revSeq: o.revNo, hash: o.hash })),
    content,
  };
}

/** How many times the approved revision is re-selected when a concurrent edit moves it between selection and read. */
const APPROVED_READ_ATTEMPTS = 3;

/** The content of revision `revNo` exactly, or null when it can no longer be pinned (the caller re-selects). */
async function approvedContent(db: Db, nodeId: string, revNo: number): Promise<string | null> {
  const live = await db.node.findUnique({ where: { id: nodeId }, select: { revSeq: true, content: true } });
  if (live && live.revSeq === revNo) return live.content ?? '';
  const row = await db.nodeRevision.findFirst({ where: { nodeId, revNo }, orderBy: { id: 'desc' }, select: { content: true } });
  return row ? (row.content ?? '') : null;
}

async function provenanceRevisionAtOrBelow(db: Db, nodeId: string, revNo: number): Promise<number | null> {
  const row = await db.compiledPromptRevision.findFirst({
    where: { compiledNodeId: nodeId, compiledRevNo: { lte: revNo } },
    orderBy: { compiledRevNo: 'desc' },
    select: { compiledRevNo: true },
  });
  return row?.compiledRevNo ?? null;
}

export interface ServedPromptOwner {
  kind: 'BIND' | 'CHAT' | 'RUN';
  sessionId?: string;
  chatId?: string;
  runId?: string;
  /** A chat records again when its served revision changes (R37); the next ordinal is the caller's to compute. */
  ordinal?: number;
  /** Null only for a chat held in a memory no App owns. */
  appId: string | null;
  agentId: string;
  workerId?: string | null;
}

/**
 * Write the immutable record of what was served (cor:agt:040:03): the revision, the provenance copied from it now (so a
 * recompile never rewrites it) and the variable values this serve filled. No composed text and no derived blocks. Call it
 * in the transaction that creates the owner, so a bind that rolls back leaves no record and a record never outlives
 * a failed bind.
 */
export async function recordServedPrompt(
  db: Db,
  owner: ServedPromptOwner,
  served: ServedBootPrompt,
  variables: Record<string, string>,
): Promise<void> {
  await db.servedPrompt.create({
    data: {
      id: generateId(),
      kind: owner.kind,
      sessionId: owner.sessionId ?? null,
      chatId: owner.chatId ?? null,
      runId: owner.runId ?? null,
      ordinal: owner.ordinal ?? 1,
      appId: owner.appId,
      agentId: owner.agentId,
      workerId: owner.workerId ?? null,
      pointerLevel: served.pointerLevel,
      compiledNodeId: served.compiledNodeId,
      servedRevSeq: served.servedRevSeq,
      provenanceRevSeq: served.provenanceRevSeq,
      compiledContentHash: served.compiledContentHash,
      provenance: served.provenance as unknown as Prisma.InputJsonValue,
      variables: variables as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * The compiled text of a revision a session was already given (its record), so a session finishes under the revision it
 * was bound with. The node's current revision has no history row; an older one does until it is pruned. `null` when the
 * revision is gone: the caller refuses `BOOT_PROMPT_RECORDED_REVISION_DELETED` (final, never a fall back to newer text).
 */
export async function readRecordedRevisionContent(db: Db, nodeId: string, revSeq: number): Promise<string | null> {
  const live = await db.node.findUnique({ where: { id: nodeId }, select: { revSeq: true, content: true, deletedAt: true } });
  if (!live || live.deletedAt) return null;
  const snapshot = await db.nodeRevision.findFirst({ where: { nodeId, revNo: revSeq }, orderBy: { id: 'desc' }, select: { content: true } });
  if (snapshot) return snapshot.content ?? '';
  return live.revSeq === revSeq ? (live.content ?? '') : null;
}
