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
import { newestApprovedAndSignedRevisionForServe } from '../nodeApproval.js';
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

/**
 * Every row of the preview, in the stable order (app, agent, worker). Empty while the switch is already ENFORCED
 * (nothing would change). A target the serve refuses today (no pointer, nothing approved, licence inactive, …) has no
 * served revision to change and is not a row. Cost is bounded by the organisation's installs and customised workers,
 * not by revision history: one lazy signature read per distinct compiled node.
 */
export async function computeSigningPreviewRows(db: Db, orgId: string): Promise<SigningPreviewRow[]> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { bootPromptSigningRequired: true } });
  if (!org || signingSwitchStatus(org).enforced) return [];

  const apps = await db.app.findMany({
    where: { organizationId: orgId, deletedAt: null, uninstalledAt: null },
    select: { id: true, urn: true },
    orderBy: { id: 'asc' },
  });
  const rows: SigningPreviewRow[] = [];
  const statusByNode = new Map<string, ReturnType<typeof lazyRevisionSignatureStatus>>();
  const nodeUrns = new Map<string, string | null>();
  const nodeUrnOf = async (nodeId: string): Promise<string | null> => {
    if (!nodeUrns.has(nodeId)) {
      const n = await db.node.findUnique({ where: { id: nodeId }, select: { loc: true, memory: { select: { urn: true } } } });
      nodeUrns.set(nodeId, n ? safeNodeUrnV2(n.memory.urn, n.loc) : null);
    }
    return nodeUrns.get(nodeId) ?? null;
  };

  for (const app of apps) {
    const [installs, workers] = await Promise.all([
      db.appAgent.findMany({ where: { appId: app.id }, select: { agentId: true, agent: { select: { name: true, urn: true } } }, orderBy: { agentId: 'asc' } }),
      db.worker.findMany({
        where: { appId: app.id, retiredAt: null, bootPromptNodeId: { not: null } },
        select: { id: true, name: true, slug: true, agentId: true, agent: { select: { name: true, urn: true } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const targets: Array<{ agentId: string; agentName: string; agentUrn: string | null; workerId: string | null; workerName: string | null; workerUrn: string | null }> = [
      ...installs.map((i) => ({ agentId: i.agentId, agentName: i.agent.name, agentUrn: previewAddress(() => emitEntityUrnV2('agent', i.agent.urn)), workerId: null, workerName: null, workerUrn: null })),
      ...workers.map((w) => ({ agentId: w.agentId, agentName: w.agent.name, agentUrn: previewAddress(() => emitEntityUrnV2('agent', w.agent.urn)), workerId: w.id, workerName: w.name, workerUrn: previewAddress(() => composeWorkerUrn(normalizeUrnForLookup(app.urn), w.slug)) })),
    ];
    for (const t of targets) {
      const today = await previewServedBootPrompt(db, {
        surface: 'bind', appId: app.id, agent: { id: t.agentId, name: t.agentName }, workerId: t.workerId,
      });
      if (!today.served) continue;
      const { compiledNodeId, servedRevSeq } = today.served;
      let status = statusByNode.get(compiledNodeId);
      if (!status) statusByNode.set(compiledNodeId, status = lazyRevisionSignatureStatus(db, compiledNodeId, 'compiled-boot-prompt'));
      // #4008: the preview only has rows while the switch is OFF (`computeSigningPreviewRows` returns [] once it is
      // enforced, and a switch-on's recompute runs before it flips), so the serve above is the approval-only walk and
      // `servedRevSeq` is the newest approved revision, and every revision above it is unapproved. When it itself counts as
      // signed it IS the newest approved-and-signed one, so the second walk is skipped. A first revision has nothing older
      // to change to and nothing approved above it, so it is skipped too. Anything else runs the walk FROM THE TOP, as
      // the enforced serve does (same scan ceiling): a signed revision the serve would not reach must not show as one a
      // switch-on changes to.
      if ((await status(servedRevSeq)).counts) continue;
      const walk = servedRevSeq <= 1
        ? { found: null as { revNo: number } | null }
        : await newestApprovedAndSignedRevisionForServe(db, compiledNodeId, async (rev) => (await status!(rev)).counts);
      const base = {
        appId: app.id, appUrn: app.urn, agentId: t.agentId, agentName: t.agentName, agentUrn: t.agentUrn, workerId: t.workerId, workerName: t.workerName, workerUrn: t.workerUrn,
        compiledNodeId, compiledNodeUrn: await nodeUrnOf(compiledNodeId), servedRevSeq,
      };
      if (walk.found) rows.push({ ...base, state: 'REVISION_CHANGES', changesToRevSeq: walk.found.revNo });
      else rows.push({ ...base, state: (await status(servedRevSeq)).pending ? 'SIGNATURE_PENDING' : 'UNSIGNED_STOPS', changesToRevSeq: null });
    }
  }
  return rows.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
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
