/**
 * #2973 PR2 (cor:agt:040:09 "Switching signing on" and "Who turns the switch, and sees the preview"; rulings:0262,
 * R35/R36) — the organisation's boot-prompt signing switch: who may turn it, what it reads, the preview shown before it
 * goes on, and the preview-acknowledgement token the switch-on must present.
 *
 *  - AUDIENCE (G1): the organisation's live ADMINs and OWNERs, acting as themselves. NO platform bypass (a platform admin
 *    who is not a member is a non-member), and every non-human or borrowed principal is refused before the organisation
 *    is looked at: a worker session, an App key or run, impersonation. The refusal is the one `FORBIDDEN` for every shape
 *    — an unknown organisation included — so the audience check reveals nothing.
 *  - PREVIEW: every compiled boot prompt served in the organisation's Apps whose served revision would differ if the
 *    switch were on, per (App, installed Agent) and per worker with its own pointer. It reuses the serve's own resolver
 *    (`previewServedBootPrompt`) for "served today" and the serve's own signed walk (R35) for "served if on".
 *  - TOKEN (C4): stateless, HMAC-signed with a key derived from the existing server signing secret (no new variable),
 *    binding the organisation, the caller, a digest of the FULL preview (every row, every page) and the issue time on the
 *    DATABASE clock (so instances agree). It grants nothing: switch-on re-checks the audience live, takes the lock, checks
 *    freshness and the binding and recomputes the digest on one stable snapshot.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { authorizationDenied } from '../auth/authorizationDenied.js';
import { LIVE_ORG_MEMBERSHIP } from '../auth/liveOrgMembership.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { ROLE_ORDER } from '../auth/orgRole.js';
import { approvalHoldsFor, approvalRecordOf, newestApprovedAndSignedRevisionForServe, newestApprovedRevisionForServe } from '../nodeApproval.js';
import { computeApprovalHash } from '../approvalHash.js';
import { parseCompiledProvenance } from '../bootCompile/provenance.js';
import { lazyRevisionSignatureStatus } from '../signing/revisionSignatureCounts.js';
import { signingSurfacePolicy } from '../signing/surface.js';
import { composeWorkerUrn } from '../entityRef/workerRef.js';
import { normalizeUrnForLookup } from '../urn.js';
import { emitEntityUrnV2, safeNodeUrnV2 } from '../urnEmit.js';
import { previewServedBootPrompt } from './serve.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const SIGNING_PREVIEW_STALE_CODE = 'BOOT_PROMPT_SIGNING_PREVIEW_STALE';
/** Adopted at the #2973 gate (6745905876): ten minutes, judged on the database clock. */
export const SIGNING_PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;
export const SIGNING_PREVIEW_DEFAULT_PAGE = 20;
export const SIGNING_PREVIEW_MAX_PAGE = 200;

export type SigningPreviewState = 'SIGNATURE_PENDING' | 'REVISION_CHANGES' | 'UNSIGNED_STOPS';

export interface SigningPreviewRow {
  appId: string;
  appUrn: string;
  agentId: string;
  agentName: string;
  agentUrn: string | null;
  /** Null for the install-level row (an uncustomised worker, or a chat, shares it). */
  workerId: string | null;
  workerName: string | null;
  workerUrn: string | null;
  compiledNodeId: string;
  compiledNodeUrn: string | null;
  /** The revision served today. */
  servedRevSeq: number;
  state: SigningPreviewState;
  /** Set with `REVISION_CHANGES`: the older revision the serve would fall back to (R35). */
  changesToRevSeq: number | null;
}

/** `required` is the stored switch; `enforced` is the truth: the switch AND the deployment ships signing (G2). */
export function signingSwitchStatus(row: { bootPromptSigningRequired: boolean }): { required: boolean; enforced: boolean; deploymentSigns: boolean } {
  const deploymentSigns = signingSurfacePolicy().signing;
  return { required: row.bootPromptSigningRequired, enforced: row.bootPromptSigningRequired && deploymentSigns, deploymentSigns };
}

/** The principal shapes the audience refuses whatever the organisation (G1). Judged before the organisation is resolved. */
export function requireSelfActingUser(ctx: {
  userId?: string; appId?: string; appKeyId?: string; sessionId?: string; clientId?: string; impersonation?: unknown;
}): string {
  if (!ctx.userId || ctx.appId || ctx.appKeyId || ctx.sessionId || ctx.impersonation || isRunPrincipal(ctx)) throw authorizationDenied();
  return ctx.userId;
}

/**
 * The live membership gate, on `db` (pass the transaction client): a CURRENT ADMIN or OWNER of a live organisation.
 * Deliberately no platform-role bypass (cor:agt:040:09: a non-member is refused) and `findFirst` with the live-membership
 * filter, so a revoked membership never authorizes.
 */
export async function requireSigningSwitchAudience(db: Db, userId: string, orgId: string, opts: { lock?: boolean } = {}): Promise<void> {
  // A WRITER passes `lock` on its transaction client: the transaction's REPEATABLE READ snapshot was taken before the
  // authority-anchor wait, so a plain read can still see a membership a revoker committed while this one waited
  // (Dorian, local review of 295fb658). A locking read of a row changed since the snapshot fails 40001 and the
  // caller's retry re-runs on a fresh snapshot, where the revocation is seen and the audience refuses.
  if (opts.lock) await db.$queryRaw`SELECT user_id FROM org_members WHERE organization_id = ${orgId} AND user_id = ${userId} FOR SHARE`;
  const member = await db.orgMember.findFirst({
    where: { organizationId: orgId, userId, ...LIVE_ORG_MEMBERSHIP },
    select: { role: true },
  });
  if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER.ADMIN) throw authorizationDenied();
}

const SEP = '\u0000';
const keyOf = (r: { appId: string; agentId: string; workerId: string | null }) => `${r.appId}${SEP}${r.agentId}${SEP}${r.workerId ?? ''}`;

/** #4017: only synchronous URN composition is caught; an un-emittable display address is null, never a fabricated/raw URN. */
function previewAddress(compose: () => string): string | null {
  try { return compose(); } catch { return null; }
}

type PreviewTarget = {
  appId: string; appUrn: string; agentId: string; agentName: string; agentUrn: string | null;
  workerId: string | null; workerName: string | null; workerUrn: string | null;
  /** The pointer of the install (or worker) itself; null falls to the Agent's. */
  ownPointer: string | null;
};

type SignatureStatusReader = ReturnType<typeof lazyRevisionSignatureStatus>;

/** Ids per `IN (...)` read: far below the driver's bound-parameter ceiling. */
const BULK_CHUNK = 500;
function chunkedBy<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const chunked = <T,>(items: readonly T[]): T[][] => chunkedBy(items, BULK_CHUNK);

/** The facts of one compiled node the bulk path judges in memory (one read for every node the preview points at). */
type BulkNode = {
  id: string; loc: string; deletedAt: Date | null; memoryId: string; name: string; abstract: string | null; content: string | null;
  revSeq: number; contentRevSeq: number; approvedRevNo: number | null; approvedBy: string | null; approvedByInfo: string | null; approvedAt: Date | null; approvalHash: string | null;
  memory: { urn: string; deletedAt: Date | null; isEncrypted: boolean };
};

/**
 * Every row of the preview, in the stable order (app, agent, worker). Empty while the switch is already ENFORCED
 * (nothing would change). A target the serve refuses today (no pointer, nothing approved, licence inactive, …) has no
 * served revision to change and is not a row.
 *
 * #4016 (#4008 slice 2): a SET-WISE path. The per-target serve cost ~23 statements a row inside one 30 s snapshot, and
 * switch-on's recompute runs the same function, so a 2,000-row organisation sat near the limit. This reads the pointers,
 * the compiled nodes, their snapshot and provenance and signature presence ONCE for the whole organisation and judges
 * each target in memory with the serve's own predicates (`approvalRecordOf` / `approvalHoldsFor`, `parseCompiledProvenance`).
 * It is a fast path, never a second definition: a target it cannot prove identical (a node with revision snapshots, a
 * provenance record that does not parse, a node carrying signatures) is handed to the unchanged per-target code
 * (`previewServedBootPrompt`, `newestApprovedRevisionForServe`, `lazyRevisionSignatureStatus`), so a corrupt record
 * throws exactly what it threw. The organisation's Apps carry an organisation, so the install licence question
 * (`personalOrgAgentLicenseHolds`) answers true without a read; the audience gates run in the callers, before this.
 */
export async function computeSigningPreviewRows(db: Db, orgId: string): Promise<SigningPreviewRow[]> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { bootPromptSigningRequired: true } });
  if (!org || signingSwitchStatus(org).enforced) return [];

  const apps = await db.app.findMany({
    where: { organizationId: orgId, deletedAt: null, uninstalledAt: null },
    select: { id: true, urn: true },
    orderBy: { id: 'asc' },
  });
  if (apps.length === 0) return [];
  const appIds = apps.map((a) => a.id);
  const [installs, workers] = await Promise.all([
    db.appAgent.findMany({
      where: { appId: { in: appIds } },
      select: { appId: true, agentId: true, bootPromptNodeId: true, agent: { select: { name: true, urn: true } } },
      orderBy: [{ appId: 'asc' }, { agentId: 'asc' }],
    }),
    db.worker.findMany({
      where: { appId: { in: appIds }, retiredAt: null, bootPromptNodeId: { not: null } },
      select: { id: true, appId: true, name: true, slug: true, agentId: true, bootPromptNodeId: true, agent: { select: { name: true, urn: true } } },
      orderBy: [{ appId: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const appUrn = new Map(apps.map((a) => [a.id, a.urn]));
  const targets: PreviewTarget[] = [
    ...installs.map((i) => ({
      appId: i.appId, appUrn: appUrn.get(i.appId)!, agentId: i.agentId, agentName: i.agent.name, agentUrn: previewAddress(() => emitEntityUrnV2('agent', i.agent.urn)),
      workerId: null, workerName: null, workerUrn: null, ownPointer: i.bootPromptNodeId,
    })),
    ...workers.map((w) => ({
      appId: w.appId, appUrn: appUrn.get(w.appId)!, agentId: w.agentId, agentName: w.agent.name, agentUrn: previewAddress(() => emitEntityUrnV2('agent', w.agent.urn)),
      workerId: w.id, workerName: w.name, workerUrn: previewAddress(() => composeWorkerUrn(normalizeUrnForLookup(appUrn.get(w.appId)!), w.slug)), ownPointer: w.bootPromptNodeId,
    })),
  ];

  // The deciding pointer (worker, else install, else Agent): the Agent's is read once for every install without its own.
  const needAgent = [...new Set(targets.filter((t) => !t.ownPointer).map((t) => t.agentId))];
  const agentPointer = new Map<string, string | null>();
  for (const ids of chunked(needAgent)) {
    for (const a of await db.agent.findMany({ where: { id: { in: ids } }, select: { id: true, bootPromptNodeId: true } })) agentPointer.set(a.id, a.bootPromptNodeId);
  }
  const pointed = (t: PreviewTarget): string | null => t.ownPointer ?? agentPointer.get(t.agentId) ?? null;
  const nodeIds = [...new Set(targets.map(pointed).filter((id): id is string => id !== null))];

  const nodes = new Map<string, BulkNode>();
  const withSnapshots = new Set<string>();
  const withSignatures = new Set<string>();
  for (const ids of chunked(nodeIds)) {
    for (const n of await db.node.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, loc: true, deletedAt: true, memoryId: true, name: true, abstract: true, content: true, revSeq: true, contentRevSeq: true,
        approvedRevNo: true, approvedBy: true, approvedByInfo: true, approvedAt: true, approvalHash: true,
        memory: { select: { urn: true, deletedAt: true, isEncrypted: true } },
      },
    })) nodes.set(n.id, n);
    for (const g of await db.nodeRevision.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids } } })) withSnapshots.add(g.nodeId);
    for (const g of await db.nodeSignature.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids } } })) withSignatures.add(g.nodeId);
  }
  // The serve share-locks the node it serves from (in one statement here, in id order so two previews cannot deadlock).
  const liveIds = [...nodes.values()].filter((n) => n.deletedAt === null && n.memory.deletedAt === null).map((n) => n.id).sort();
  for (const ids of chunked(liveIds)) await db.$queryRaw`SELECT id FROM nodes WHERE id = ANY(${ids}::text[]) ORDER BY id FOR SHARE`;

  // The approval selection: for a node that has NO revision snapshots the only candidate is its live revision, and
  // `revisionApprovalOf` then answers APPROVED exactly when the node's current approval still covers its text. A node
  // with snapshots keeps the serve's own walk (memoized per node).
  const walked = new Map<string, Promise<number | null>>();
  const servedRevOf = (n: BulkNode): Promise<number | null> => {
    if (!withSnapshots.has(n.id)) {
      if (n.memory.isEncrypted) return Promise.resolve(null);
      const hash = computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });
      const record = approvalRecordOf(n);
      return Promise.resolve(record && approvalHoldsFor(n) && hash === record.hash ? n.revSeq : null);
    }
    let p = walked.get(n.id);
    if (!p) walked.set(n.id, p = newestApprovedRevisionForServe(db, n.id).then((r) => r.found?.revNo ?? null));
    return p;
  };
  // The compile record the serve reads provenance from: the greatest at or below the served revision. Its parse and
  // occurrence count are checked here from one bulk read; anything that does not hold is `unproven`, which hands the
  // target to the serve itself, so a corrupt record throws exactly what it threw.
  // One row per (node, served revision): the greatest compile record at or below it, picked by the database, so the
  // history a node has accumulated is never read into memory and nothing spreads it into a call.
  const provenanceAtMap = new Map<string, number>();
  const loadProvenanceAt = async (pairs: Array<{ nodeId: string; rev: number }>): Promise<void> => {
    const wanted = pairs.filter((p) => !provenanceAtMap.has(`${p.nodeId}${SEP}${p.rev}`));
    for (const group of chunkedBy(wanted, 1000)) {
      const rowsRead = await db.$queryRaw<Array<{ node_id: string; rev: number; at: number | null }>>`
        SELECT w.node_id, w.rev, (SELECT MAX(c.compiled_rev_no) FROM compiled_prompt_revisions c
          WHERE c.compiled_node_id = w.node_id AND c.compiled_rev_no <= w.rev) AS at
        FROM unnest(${group.map((p) => p.nodeId)}::text[], ${group.map((p) => p.rev)}::int[]) AS w(node_id, rev)`;
      for (const r of rowsRead) provenanceAtMap.set(`${r.node_id}${SEP}${r.rev}`, r.at ?? -1);
    }
  };
  const provenanceAt = (nodeId: string, servedRevSeq: number): number => provenanceAtMap.get(`${nodeId}${SEP}${servedRevSeq}`) ?? -1;
  const provenanceOk = new Map<string, boolean>();
  const verifyProvenance = async (pairs: Array<{ nodeId: string; at: number }>): Promise<void> => {
    const wanted = pairs.filter((p) => !provenanceOk.has(`${p.nodeId}${SEP}${p.at}`));
    for (const group of chunkedBy(wanted, 200)) {
      const rowsRead = await db.compiledPromptRevision.findMany({
        where: { OR: group.map((p) => ({ compiledNodeId: p.nodeId, compiledRevNo: p.at })) },
        select: { compiledNodeId: true, compiledRevNo: true, provenance: true, occurrenceCount: true },
      });
      const byKey = new Map(rowsRead.map((r) => [`${r.compiledNodeId}${SEP}${r.compiledRevNo}`, r]));
      for (const p of group) {
        const r = byKey.get(`${p.nodeId}${SEP}${p.at}`);
        let ok = false;
        try { ok = !!r && parseCompiledProvenance(r.provenance, p.nodeId, p.at).occurrences.length === r.occurrenceCount; } catch { ok = false; }
        provenanceOk.set(`${p.nodeId}${SEP}${p.at}`, ok);
      }
    }
  };

  const statusByNode = new Map<string, SignatureStatusReader>();
  const nodeUrns = new Map<string, string | null>();
  for (const n of nodes.values()) nodeUrns.set(n.id, safeNodeUrnV2(n.memory.urn, n.loc));
  const nodeUrnOf = async (nodeId: string): Promise<string | null> => {
    if (!nodeUrns.has(nodeId)) {
      const n = await db.node.findUnique({ where: { id: nodeId }, select: { loc: true, memory: { select: { urn: true } } } });
      nodeUrns.set(nodeId, n ? safeNodeUrnV2(n.memory.urn, n.loc) : null);
    }
    return nodeUrns.get(nodeId) ?? null;
  };

  // Phase 1: which revision each target would be served (null: refused today).
  const decided = new Map<PreviewTarget, { node: BulkNode; rev: number } | null>();
  for (const t of targets) {
    const id = pointed(t);
    const node = id ? nodes.get(id) : undefined;
    const rev = node && node.deletedAt === null && node.memory.deletedAt === null ? await servedRevOf(node) : null;
    decided.set(t, node && rev !== null ? { node, rev } : null);
  }
  await loadProvenanceAt([...decided.values()].flatMap((d) => (d ? [{ nodeId: d.node.id, rev: d.rev }] : [])));
  await verifyProvenance([...decided.values()].flatMap((d) => {
    if (!d) return [];
    const at = provenanceAt(d.node.id, d.rev);
    return at < 0 ? [] : [{ nodeId: d.node.id, at }];
  }));

  const rows: SigningPreviewRow[] = [];
  for (const t of targets) {
    let served: { compiledNodeId: string; servedRevSeq: number } | null | 'unproven' = null;
    const d = decided.get(t);
    if (d) {
      const at = provenanceAt(d.node.id, d.rev);
      if (at >= 0) served = provenanceOk.get(`${d.node.id}${SEP}${at}`) ? { compiledNodeId: d.node.id, servedRevSeq: d.rev } : 'unproven';
    }
    if (served === 'unproven') {
      const today = await previewServedBootPrompt(db, { surface: 'bind', appId: t.appId, agent: { id: t.agentId, name: t.agentName }, workerId: t.workerId });
      served = today.served ? { compiledNodeId: today.served.compiledNodeId, servedRevSeq: today.served.servedRevSeq } : null;
    }
    if (!served) continue;
    const { compiledNodeId, servedRevSeq } = served;
    // #4008: the preview only has rows while the switch is OFF (`computeSigningPreviewRows` returns [] once it is
    // enforced, and a switch-on's recompute runs before it flips), so the serve is the approval-only walk and
    // `servedRevSeq` is the newest approved revision, and every revision above it is unapproved. When it itself counts as
    // signed it IS the newest approved-and-signed one, so the second walk is skipped. A first revision has nothing older
    // to change to and nothing approved above it, so it is skipped too. Anything else runs the walk FROM THE TOP, as
    // the enforced serve does (same scan ceiling): a signed revision the serve would not reach must not show as one a
    // switch-on changes to.
    // #4016: a node with no signature record at all can count nothing and has nothing pending, so no walk can find a
    // signed revision: the answer is UNSIGNED_STOPS without a read. A node with any signature runs the walk as before.
    let state: SigningPreviewState = 'UNSIGNED_STOPS';
    let changesToRevSeq: number | null = null;
    if (withSignatures.has(compiledNodeId) || !nodes.has(compiledNodeId)) {
      let status = statusByNode.get(compiledNodeId);
      if (!status) statusByNode.set(compiledNodeId, status = lazyRevisionSignatureStatus(db, compiledNodeId, 'compiled-boot-prompt'));
      if ((await status(servedRevSeq)).counts) continue;
      const walk = servedRevSeq <= 1
        ? { found: null as { revNo: number } | null }
        : await newestApprovedAndSignedRevisionForServe(db, compiledNodeId, async (rev) => (await status!(rev)).counts);
      if (walk.found) { state = 'REVISION_CHANGES'; changesToRevSeq = walk.found.revNo; }
      else state = (await status(servedRevSeq)).pending ? 'SIGNATURE_PENDING' : 'UNSIGNED_STOPS';
    }
    // #4061: canonical v2 like the sibling addresses (cor:urn:010:01); `appUrn` is non-null, so a stored form that cannot
    // emit is served as stored, silently (#4054's diagnostic carries no address), rather than the null the nullable siblings use.
    rows.push({
      appId: t.appId, appUrn: previewAddress(() => emitEntityUrnV2('app', t.appUrn)) ?? t.appUrn, agentId: t.agentId, agentName: t.agentName, agentUrn: t.agentUrn,
      workerId: t.workerId, workerName: t.workerName, workerUrn: t.workerUrn,
      compiledNodeId, compiledNodeUrn: await nodeUrnOf(compiledNodeId), servedRevSeq, state, changesToRevSeq,
    });
  }
  warnAddressCompositionFailures(rows);
  return rows.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

/**
 * #4054: one aggregate, redacted warning per computation when a RETURNED row's display address could not be composed
 * (the row still carries null). Counts displayed nulls per row, not distinct entities; an install-level row's absent
 * Worker is not a failure. The payload is four fixed keys and carries no identifier, name, address or exception text.
 */
function warnAddressCompositionFailures(rows: readonly SigningPreviewRow[]): void {
  const agentFailures = rows.filter((r) => r.agentUrn === null).length;
  const workerFailures = rows.filter((r) => r.workerId !== null && r.workerUrn === null).length;
  if (agentFailures + workerFailures === 0) return;
  console.warn('signing.preview.address_composition_failed', { schemaVersion: 1, reason: 'COMPOSITION_FAILED', agentFailures, workerFailures });
}

/** The digest of the FULL preview: every row's target, served revision and state, across all pages. */
export function signingPreviewDigest(rows: readonly SigningPreviewRow[]): string {
  const h = createHash('sha256');
  for (const r of rows) h.update(JSON.stringify([r.appId, r.agentId, r.workerId, r.compiledNodeId, r.servedRevSeq, r.state, r.changesToRevSeq])).update('\n');
  return h.digest('hex');
}

/** One page of the already-sorted rows, `after` being the opaque cursor of the last row of the previous page. */
export function pageSigningPreview(
  rows: readonly SigningPreviewRow[],
  first: number | null | undefined,
  after: string | null | undefined,
): { rows: SigningPreviewRow[]; hasMore: boolean; endCursor: string | null } {
  const size = first == null ? SIGNING_PREVIEW_DEFAULT_PAGE : first;
  if (!Number.isInteger(size) || size < 1) {
    throw new GraphQLError('first must be a positive integer.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  // cor:api:120:04: a request over the cap is served at the cap, never refused.
  const pageSize = Math.min(size, SIGNING_PREVIEW_MAX_PAGE);
  let start = 0;
  if (after != null) {
    let key: string;
    try { key = Buffer.from(after, 'base64url').toString('utf8'); } catch { key = ''; }
    if (!key.includes(SEP)) throw new GraphQLError('after is not a cursor from this preview.', { extensions: { code: 'BAD_USER_INPUT' } });
    start = rows.findIndex((r) => keyOf(r) > key);
    if (start < 0) start = rows.length;
  }
  const slice = rows.slice(start, start + pageSize);
  const last = slice[slice.length - 1];
  return { rows: slice, hasMore: start + pageSize < rows.length, endCursor: last ? Buffer.from(keyOf(last)).toString('base64url') : null };
}

// ---- the acknowledgement token ------------------------------------------------------------------------------------

interface TokenPayload { v: 1; org: string; user: string; digest: string; iat: number }

function tokenKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new GraphQLError('The signing-preview token signer is not configured.', { extensions: { code: 'BOOT_PROMPT_SIGNING_NOT_CONFIGURED' } });
  // Its own HMAC domain: the token never shares the JWT signing domain (same derivation pattern as the team-attention token).
  return createHmac('sha256', secret).update('hadron/boot-prompt-signing-preview/v1').digest();
}

/** Sign a token. `iatMs` is the DATABASE clock's now at issue (`dbNowMs`). Exported for the pins, which mint expired and future-dated tokens. */
export function mintSigningPreviewToken(p: { orgId: string; userId: string; digest: string; iatMs: number }): string {
  const payload: TokenPayload = { v: 1, org: p.orgId, user: p.userId, digest: p.digest, iat: p.iatMs };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', tokenKey()).update(body).digest('base64url')}`;
}

function parseToken(token: unknown): TokenPayload | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, supplied] = parts;
  const expected = createHmac('sha256', tokenKey()).update(body).digest('base64url');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TokenPayload>;
    if (v.v !== 1 || typeof v.org !== 'string' || typeof v.user !== 'string' || typeof v.digest !== 'string' || typeof v.iat !== 'number' || !Number.isFinite(v.iat)) return null;
    return v as TokenPayload;
  } catch {
    return null;
  }
}

/** The database clock, in ms: one clock for every instance, so a token minted by one is judged fairly by another. */
export async function dbNowMs(db: Db): Promise<number> {
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return now.getTime();
}

export function signingPreviewStale(): GraphQLError {
  return new GraphQLError('The signing preview this switch-on relied on is missing, expired or out of date. Fetch the preview again and review it before switching on.', {
    extensions: { code: SIGNING_PREVIEW_STALE_CODE },
  });
}

/**
 * Judge a switch-on's token: bound to this organisation and this caller, fresh on the database clock (an expired AND a
 * future-dated issue time both refuse) and carrying the digest of the preview as it is NOW. Throws the one
 * `BOOT_PROMPT_SIGNING_PREVIEW_STALE` for every failure, so a caller learns nothing about which leg failed. The caller
 * runs it only after the audience gate, so it never discloses an organisation to someone outside it.
 */
export async function requireFreshSigningPreview(
  db: Db,
  p: { token: string | null | undefined; orgId: string; userId: string },
): Promise<void> {
  const t = parseToken(p.token);
  if (!t || t.org !== p.orgId || t.user !== p.userId) throw signingPreviewStale();
  const now = await dbNowMs(db);
  if (t.iat > now || now - t.iat > SIGNING_PREVIEW_TOKEN_TTL_MS) throw signingPreviewStale();
  const current = signingPreviewDigest(await computeSigningPreviewRows(db, p.orgId));
  const a = Buffer.from(t.digest);
  const b = Buffer.from(current);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw signingPreviewStale();
}
