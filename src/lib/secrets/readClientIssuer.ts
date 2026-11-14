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

export async function requireSecretReadClientIssuer(ctx: Context, secretId: string): Promise<SecretIssuance> {
  const userId = await requirePersonOnlyAct(ctx, 'secret.issue-read-client', authorizationDenied);
  return judgeSecretReadClientIssuer(ctx, userId, secretId);
}

/**
 * The issuer rule for a NAMED person, without the person-only door. The reveal path judges the stored issuer again with it,
 * so a client whose issuer was demoted, left the App or was superseded as writer stops reading (Q21).
 */
export async function judgeSecretReadClientIssuer(ctx: Context, userId: string, secretId: string): Promise<SecretIssuance> {
  const tx = ctx.db;
  const secret = await tx.secret.findUnique({ where: { id: secretId }, select: { id: true, name: true, ownerType: true, ownerId: true } });
  if (!secret || secret.ownerType !== 'app') throw authorizationDenied();
  const app = await tx.app.findUnique({
    where: { id: secret.ownerId },
    select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
  });
  if (!app || app.deletedAt || app.uninstalledAt) throw authorizationDenied();
  const base = { secretId: secret.id, secretName: secret.name, appId: app.id, userId };

  // No platform arm: judge the manager predicate without the caller's platform roles (Q26).
  if (await managesApp({ ...ctx, roles: [] }, app)) return { ...base, asWriter: false };

  if (!(await isAppParticipant(ctx, app))) throw authorizationDenied();
  const newest = await tx.secretVersion.findFirst({
    where: { secretId: secret.id }, orderBy: { versionNo: 'desc' },
    select: { writtenByUserId: true, writtenByWorkerId: true },
  });
  if (newest && newest.writtenByUserId === userId && newest.writtenByWorkerId === null) return { ...base, asWriter: true };

  const wroteEarlier = await tx.secretVersion.findFirst({
    where: { secretId: secret.id, writtenByUserId: userId, writtenByWorkerId: null }, select: { id: true },
  });
  if (wroteEarlier) {
    throw new GraphQLError('A newer version of this secret has been written since yours.', { extensions: { code: SECRET_READ_CLIENT_SUPERSEDED } });
  }
  throw authorizationDenied();
}
