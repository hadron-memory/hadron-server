/** #1744 / cor:dmo:050:05: App credential inventory and issuance share the manager predicate. */
import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/index.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { managesApp, lockAppManagerMemberships } from '../../../lib/auth/appManagement.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { currentActor } from '../../../lib/requestActor.js';
import type { Context } from './resolvers.helpers.js';

type KeyApp = { id: string; organizationId: string | null; ownerUserId: string | null };

/**
 * Only whoever manages the App may see or manage its keys.
 * The person-only helper for the nested and remaining door: it refuses every bound worker. Listing and revoking an
 * App's credentials on a holder's instruction (cor:dmo:050:12 S6, #3311) no longer pass here: they go through
 * `admitCredentialList` and `admitAppManagement` in resolvers.instruction.ts. Minting and rotating are person-only and
 * go through {@link requireAppKeyIssuer} instead.
 * Use the authenticated actor, not App participation: org admins need no AppMember row.
 */
export async function requireAppKeyManager(ctx: Context, app: KeyApp): Promise<void> {
  if (!(await isAppKeyManager(ctx, app))) throw authorizationDenied();
}

/**
 * The same person-only manager decision as {@link requireAppKeyManager}, as a boolean, for a door that must answer
 * a refusal as something else: #2944's usage key filter answers a key the caller may not filter by exactly as an
 * unknown key (hrn:node:hadronmemory.com:specs:cor:acl:090:01). One predicate, so the two doors cannot drift.
 */
export async function isAppKeyManager(ctx: Context, app: KeyApp): Promise<boolean> {
  if (currentActor().workerId) return false;
  return managesApp(ctx, app);
}

/**
 * #3277: minting (`createAppKey`) and rotating (`regenerateAppKey`) an App key are PERSON-ONLY
 * (hrn:node:hadronmemory.com:specs:cor:dmo:050:12, ruling 0098 A): the one person gate first, so a worker session in
 * any shape (header binding, session row, ambiguous actor, refused binding), a run principal, an impersonation and an
 * App key are refused, with the same `Forbidden` as before; then the manager check.
 */
export async function requireAppKeyIssuer(
  ctx: Context, app: KeyApp,
  /** #5259: removing a host of a team App revokes its keys under this same gate (hrn:node:hadronmemory.com:specs:cor:agt:070:07). */
  act: 'app-key.mint' | 'app-key.rotate' | 'agent-team-host.remove',
): Promise<void> {
  await requirePersonOnlyAct(ctx, act, authorizationDenied);
  await requireAppKeyManager(ctx, app);
}

/**
 * Hold the caller's deciding memberships through the key write. Called after authority
 * anchors and owner/App rows, before re-reading managesApp on the transaction client.
 * A demotion or removal that committed first is seen; one arriving later waits for commit.
 */
export async function lockAppKeyManagerMemberships(tx: Prisma.TransactionClient, ctx: Context, app: KeyApp): Promise<void> {
  await lockAppManagerMemberships(tx, ctx.userId, app);
}

/**
 * #5259: the one writer of a new App key row, shared by `createAppKey` and `joinAgentTeamHost` (which issues a host's key
 * under createAppKey's gate, hrn:node:hadronmemory.com:specs:cor:agt:070:07). The raw key is `hdr_app_` and 64 hex
 * characters (256 bits); only its hash and a preview are stored. The caller returns the raw key once and never logs it.
 */
export function newAppKeyMaterial(): { rawKey: string; keyHash: string; keyPreview: string } {
  const rawKey = APP_KEY_PREFIX + randomBytes(32).toString('hex');
  return { rawKey, keyHash: hashAppKey(rawKey), keyPreview: rawKey.slice(0, 12) + '...' + rawKey.slice(-4) };
}

export function createAppKeyRow(
  tx: Prisma.TransactionClient,
  a: { appId: string; label: string | null; createdBy: string | null; material: { keyHash: string; keyPreview: string } },
) {
  return tx.appKey.create({
    data: { appId: a.appId, keyHash: a.material.keyHash, keyPreview: a.material.keyPreview, label: a.label, createdBy: a.createdBy },
  });
}
