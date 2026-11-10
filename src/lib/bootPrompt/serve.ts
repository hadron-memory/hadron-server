import { personalOrgAgentLicenseHolds } from '../auth/personalOrgAgentInstall.js';
import { readInstallBootPrompt } from '../appInstallations.js';
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
import { newestApprovedAndSignedRevisionForServe, newestApprovedRevisionForServe } from '../nodeApproval.js';
import { resolveBootPromptPointer, type StoredBootPromptPointer } from '../bootPromptPointer.js';
import { readCompiledRevision, sha256Hex } from '../bootCompile/provenance.js';
import { generateId } from '../id.js';
import { revisionSignatureCounts } from '../signing/revisionSignatureCounts.js';
import { signingSurfacePolicy } from '../signing/surface.js';
import { BOOT_PROMPT_REFUSAL_CODES, bootPromptRefusal, type BootPromptRefusalCode, type BootPromptSurface } from './refusal.js';

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
 * #2973 (cor:agt:040:10, G2) — does the SERVING App require a signed prompt? The organisation's switch AND the
 * deployment's signing policy, both read per call: `signingSurfacePolicy().signing` (PASSKEY_SIGNING_ENABLED) first,
 * then the App's organisation column (PR2 adds the audience-gated control API; PR1 tests set it directly, and the
 * column's DEFAULT false keeps the check inert everywhere). An App with no organisation has no switch and serves on
 * approval alone — today's behaviour, resting on cor:agt:040:09's open question "does a user-owned App ever require
 * signing"; a chat with no App is the same by construction (no App to ask about).
 */
async function servingAppRequiresSignature(db: Db, appId: string): Promise<boolean> {
  if (!signingSurfacePolicy().signing) return false;
  const app = await db.app.findUnique({
    where: { id: appId },
    select: { organization: { select: { bootPromptSigningRequired: true } } },
  });
  return app?.organization?.bootPromptSigningRequired === true;
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
  const install = t.appId ? await readInstallBootPrompt(db, t.appId, t.agent.id) : null;
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
 * #3655: one page asks the #1148 licence question once per (App, Agent), not once per worker. The answer is kept beside
 * the page's memo and dropped with it, like the memo (cor:agt:020:01); a failed read is not kept, so the next worker asks
 * again. Every worker is still refused when the licence does not hold, and still before anything else is read.
 */
const pageLicences = new WeakMap<PageServedMemo, Map<string, Promise<boolean>>>();

async function installLicenceHolds(db: Db, appId: string, agentId: string, memo?: PageServedMemo): Promise<boolean> {
  const ask = async () => {
    const app = await db.app.findUnique({ where: { id: appId }, select: { organizationId: true, ownerUserId: true } });
    return !app || await personalOrgAgentLicenseHolds(db, app, agentId);
  };
  if (!memo) return ask();
  let licences = pageLicences.get(memo);
  if (!licences) pageLicences.set(memo, licences = new Map());
  const key = `${appId}:${agentId}`;
  let answer = licences.get(key);
  if (!answer) {
    answer = ask();
    licences.set(key, answer);
    answer.catch(() => licences!.delete(key));
  }
  return answer;
}

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
  if(t.appId && !(await installLicenceHolds(db, t.appId, t.agent.id, page?.memo))) {
    throw bootPromptRefusal('BOOT_PROMPT_INSTALL_LICENSE_INACTIVE',{surface:t.surface,agentName:''});
  }
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

  // #2973 (cor:agt:040:10, G2): where the serving organisation has switched signing on AND the deployment ships
  // signing, the selection below demands a signed revision too — judged here, inside the revision walk. The ONLY row
  // held is the NODE row's share lock above: what the walk then reads (the org switch, the signatures, the passkeys)
  // is NOT locked — a change there races this read and is picked up by the next resolve, exactly as the approval
  // walk's reads already race (Bob Q2, delta review of 77c9fda85b: the comment used to claim more than the lock
  // gives). Either conjunct false keeps today's approval-only serving: the walk is the unchanged #2041 one.
  const requiresSignature = t.appId != null && (await servingAppRequiresSignature(db, t.appId));

  // Selection and retrieval are two reads, so a recompile between them could pair an old revision number with newer,
  // unapproved text. The content is therefore read ONLY at the selected revision number (live row if it is still that
  // revision, else its retained snapshot); when neither can be pinned the selection moved, so select again.
  let selectedRevNo: number | null = null;
  let content: string | null = null;
  for (let attempt = 0; attempt < APPROVED_READ_ATTEMPTS && content === null; attempt++) {
    if (requiresSignature) {
      // R35: the newest revision that is BOTH approved and signed — a newer approved-but-unsigned revision neither
      // serves nor refuses. R36: with none, an approved revision existing (a pending-only signature included) is
      // NOT_SIGNED; nothing approved at all is NOT_APPROVED. The walk continues past its scan cap in bounded batches
      // (#3801 adoption, Bob P2-1: an older SIGNED revision buried under more than `cap` approved-but-unsigned ones
      // still serves; past the batch ceiling the serve fails closed with the R36 refusal, never wrong text).
      const walk = await newestApprovedAndSignedRevisionForServe(
        db, resolved.nodeId, (revNo) => revisionSignatureCounts(db, resolved.nodeId, revNo, 'compiled-boot-prompt'),
      );
      if (!walk.found) throw bootPromptRefusal(walk.approvedUnsigned ? 'BOOT_PROMPT_NOT_SIGNED' : 'BOOT_PROMPT_NOT_APPROVED', where);
      selectedRevNo = walk.found.revNo;
    } else {
      const { found } = await newestApprovedRevisionForServe(db, resolved.nodeId);
      if (!found) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);
      selectedRevNo = found.revNo;
    }
    content = await approvedContent(db, resolved.nodeId, selectedRevNo);
  }
  if (selectedRevNo === null || content === null) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);

  const provenanceRevSeq = await provenanceRevisionAtOrBelow(db, resolved.nodeId, selectedRevNo);
  if (provenanceRevSeq === null) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);
  const revision = await readCompiledRevision(db, resolved.nodeId, provenanceRevSeq);
  if (!revision) throw bootPromptRefusal('BOOT_PROMPT_NOT_APPROVED', where);
  return {
    pointerLevel: pointer.level,
    compiledNodeId: resolved.nodeId,
    servedRevSeq: selectedRevNo,
    provenanceRevSeq,
    compiledContentHash: sha256Hex(content),
    provenance: revision.provenance.occurrences.map((o) => ({ nodeId: o.nodeId, revSeq: o.revNo, hash: o.hash })),
    content,
  };
}

/** The refusals a fresh serve can return (a recorded-revision refusal belongs to an open session, never to a new serve). */
export type BootPromptServeRefusalCode = Exclude<BootPromptRefusalCode, 'BOOT_PROMPT_RECORDED_REVISION_DELETED'>;

/** Exactly one of `served` and `refusal` is set. */
export type BootPromptServeOutcome =
  | { served: ServedBootPrompt; refusal: null }
  | { served: null; refusal: BootPromptServeRefusalCode };

const SERVE_REFUSALS: ReadonlySet<string> = new Set(
  BOOT_PROMPT_REFUSAL_CODES.filter((c) => c !== 'BOOT_PROMPT_RECORDED_REVISION_DELETED'),
);

/**
 * #2708 (cor:agt:040:10) — what a serve to `t` would decide NOW, as a value: the decision, or the typed code the serve
 * would be refused with. It IS `resolveServedBootPrompt`, the resolver a bind, a chat and a run use, so it applies the
 * same resolution rules and never substitutes a fallback. It is a preview of the CURRENT state: a later serve agrees
 * with it only while that state is unchanged (a pointer edit or an approval in between can change the answer). Only the typed serve refusals are caught; anything
 * else (a dropped connection) still throws. Reads only and records nothing. The CALLER gates: run it only for a caller
 * who may see the target's pointer, so a masked caller learns nothing (not even NOT_SET).
 */
export async function previewServedBootPrompt(db: Db, t: ServeTarget): Promise<BootPromptServeOutcome> {
  try {
    return { served: await resolveServedBootPrompt(db, t), refusal: null };
  } catch (err) {
    const code = (err as { extensions?: { code?: unknown } }).extensions?.code;
    if (typeof code === 'string' && SERVE_REFUSALS.has(code)) return { served: null, refusal: code as BootPromptServeRefusalCode };
    throw err;
  }
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
