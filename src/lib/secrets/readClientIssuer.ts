/**
 * #3998 (S3 of #3991, plan R4, rulings Q21 and Q26 of 2026-11-12): who may ISSUE a read client for an App secret.
 *
 * The caller is a PERSON acting as themselves (`requirePersonOnlyAct`: a worker session, a run, an impersonation and an App
 * key are refused), and is one of:
 *   - a MANAGER of the App: its user-owner, an owner-role member, a live org ADMIN/OWNER. There is NO platform-only arm
 *     (Q26): the platform roles are stripped before the shared predicate runs. A manager's client follows the latest version.
 *   - the person who WROTE the secret's current version, while still an App participant. Only that version: when someone
 *     else has since written a newer one, a former writer is refused with SECRET_READ_CLIENT_SUPERSEDED (Q21). A version a
 *     worker wrote has no person writer, so only a manager issues for it.
 * Anyone else, and a missing or deleted secret or App, gets the uniform authorization refusal: someone who may not issue sees
 * nothing of the secret. Reads through `ctx.db`: the issuing transaction's client, called after the secret row is locked, so a newer write cannot slip in.
 */
import { GraphQLError } from 'graphql';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { isAppParticipant } from '../auth/appParticipantRead.js';
import { authorizationDenied } from '../auth/authorizationDenied.js';
import { requirePersonOnlyAct } from '../auth/personAsThemselves.js';
import { managesApp } from '../auth/appManagement.js';

export const SECRET_READ_CLIENT_SUPERSEDED = 'SECRET_READ_CLIENT_SUPERSEDED';

export interface SecretIssuance {
  userId: string;
  secretId: string;
  secretName: string;
  appId: string;
  /** True when the caller issues as the current version's writer rather than as a manager. */
  asWriter: boolean;
}

const autoDeleteNotAllowed = () => new GraphQLError('You may not set an auto-delete mark for this secret.', { extensions: { code: 'SECRET_AUTO_DELETE_NOT_ALLOWED' } });

/**
 * S6 preserves S3's issuer set; only the marked request's refusal code differs. #5335 (cor:sec:060:03 arming rule; the
 * cor:sec:070:01 auto-delete exception refused): a mark on a PROTECTED secret also needs the secret's `deleteAfterUse`, else
 * the same SECRET_AUTO_DELETE_NOT_ALLOWED. Judged only AFTER the issuer rule passed, so a caller who may not issue gets the one
 * refusal whether the secret is protected, unprotected or missing, and learns nothing of its protection. Both doors run this:
 * `issueSecretReadClient` (under the secret row lock) and the generic grant door's issuer rule at signing.
 */
export async function requireSecretReadClientIssuer(ctx: Context, secretId: string, autoDelete = false): Promise<SecretIssuance> {
  let issuance: SecretIssuance;
  try {
    const userId = await requirePersonOnlyAct(ctx, 'secret.issue-read-client', authorizationDenied);
    issuance = await judgeSecretReadClientIssuer(ctx, userId, secretId);
  } catch (error) {
    if (autoDelete && error instanceof GraphQLError && ['FORBIDDEN', SECRET_READ_CLIENT_SUPERSEDED].includes(String(error.extensions?.code))) {
      throw autoDeleteNotAllowed();
    }
    throw error;
  }
  if (autoDelete) {
    const secret = await ctx.db.secret.findUnique({ where: { id: secretId }, select: { protected: true, deleteAfterUse: true } });
    if (!secret || (secret.protected && !secret.deleteAfterUse)) throw autoDeleteNotAllowed();
  }
  return issuance;
}

/**
 * The issuer rule for a NAMED person, without the person-only door. The reveal path judges the stored issuer again with it,
 * so a client whose issuer was demoted, left the App or was superseded as writer stops reading (Q21).
 */
export async function judgeSecretReadClientIssuer(ctx: Context, userId: string, secretId: string): Promise<SecretIssuance> {
  const tx = ctx.db;
  // The NAMED person is judged, never the caller: on the reveal path the caller is the holder's driver, not the issuer.
  const named = { ...ctx, userId, roles: [] as string[], impersonation: undefined } as Context;
  const secret = await tx.secret.findUnique({ where: { id: secretId }, select: { id: true, name: true, ownerType: true, ownerId: true } });
  if (!secret || secret.ownerType !== 'app') throw authorizationDenied();
  const app = await tx.app.findUnique({
    where: { id: secret.ownerId },
    select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
  });
  if (!app || app.deletedAt || app.uninstalledAt) throw authorizationDenied();
  if (app.organizationId && !(await tx.organization.findFirst({ where: { id: app.organizationId, deletedAt: null }, select: { id: true } }))) throw authorizationDenied();
  const base = { secretId: secret.id, secretName: secret.name, appId: app.id, userId };

  // No platform arm: judge the manager predicate without the caller's platform roles (Q26).
  if (await managesApp(named, app)) return { ...base, asWriter: false };

  if (!(await isAppParticipant(named, app))) throw authorizationDenied();
  const newest = await tx.secretVersion.findFirst({
    where: { secretId: secret.id }, orderBy: { versionNo: 'desc' },
    select: { writtenByUserId: true, writtenByWorkerId: true },
  });
  if (newest && newest.writtenByUserId === userId && newest.writtenByWorkerId === null) return { ...base, asWriter: true };

  // A former writer is told SUPERSEDED. Their version row may be gone (the retention purge, #4003), so their own STORE or
  // VERSION event also proves it: events outlive a purged version for the App's whole life (R25). A worker's write has no
  // person writer (Q21), so an event carrying a worker proves nothing for its driver, exactly as a version row would not.
  const wroteEarlier = await tx.secretVersion.findFirst({
    where: { secretId: secret.id, writtenByUserId: userId, writtenByWorkerId: null }, select: { id: true },
  }) ?? await tx.secretEvent.findFirst({
    where: { secretId: secret.id, ownerType: 'app', kind: { in: ['STORE', 'VERSION'] }, outcome: 'OK', actorUserId: userId, workerId: null },
    select: { id: true },
  });
  if (wroteEarlier) {
    throw new GraphQLError('A newer version of this secret has been written since yours.', { extensions: { code: SECRET_READ_CLIENT_SUPERSEDED } });
  }
  throw authorizationDenied();
}
