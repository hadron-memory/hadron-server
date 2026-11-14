/**
 * #3707 (S1b, cor:acl:140:02, cor:acl:140:04): who may ISSUE a grant for an action. An action's `issuerRule` is a closed key
 * the server maps to a gate function here; it is never SQL or code. "A manager can't grant what they can't do": the issuer is
 * whoever may do the thing themselves, so each rule delegates to the gate the creating mutation already uses, not a copy of it.
 *
 * Today `createAgentSchedule` AND `createAgentWebhook` both call `requireScheduleAdmin` (the App's owner or an org ADMIN;
 * revoked membership and user-owned Apps judged as that gate judges them). The two keys stay separate so the two actions can
 * diverge with their creating mutations without a schema change. NOTHING calls this yet: producers of grants are S2a, which
 * the gate's S1a hold still covers.
 */
import { GraphQLError } from 'graphql';
import { authorizationDenied } from '../auth/authorizationDenied.js';
import { requirePersonOnlyAct } from '../auth/personAsThemselves.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { requireScheduleAdmin } from '../../api/graphql/schema/resolvers.appRun.js';
import { PLATFORM_ACTIONS } from './actions.js';
import { managesApp } from '../auth/appManagement.js';
import { resolveAppRef } from '../entityRef/appRef.js';
import { requireSecretReadClientIssuer } from '../secrets/readClientIssuer.js';

/** #3823: whoever manages the App (the gate the boot-prompt actions' signer faces; the node-specific part is judged where the grant is spent). */
async function requireAppManager(ctx: Context, appRef: string): Promise<void> {
  const { id } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findFirst({ where: { id, deletedAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app || !(await managesApp(ctx, app))) throw authorizationDenied();
}

/** #3998: a gate that depends on what the grant names (one secret) also receives the grant's stored values. */
type IssuerGate = (ctx: Context, appRef: string, values?: unknown) => Promise<unknown>;

/** The read-client issuer rule (plan R4): judged on the secret the grant names, in the App the grant is for. Any mismatch is the one refusal. */
async function requireSecretReadIssuer(ctx: Context, appRef: string, values?: unknown): Promise<void> {
  const id = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>).secret : undefined;
  if (typeof id !== 'string') throw authorizationDenied();
  const { id: appId } = await resolveAppRef(ctx.db, appRef);
  const issuance = await requireSecretReadClientIssuer(ctx, id);
  if (issuance.appId !== appId) throw authorizationDenied();
}

export const ISSUER_RULES: Readonly<Record<string, IssuerGate>> = {
  APP_SCHEDULE_ADMIN: requireScheduleAdmin,
  APP_WEBHOOK_ADMIN: requireScheduleAdmin,
  APP_MANAGER: requireAppManager,
  SECRET_READ_CLIENT: requireSecretReadIssuer,
};

/**
 * Throws unless the caller may issue a grant for `actionName` in the App `appRef` (id or URN). Two conditions, in this order:
 * (1) the caller is a PERSON acting as themselves (cor:acl:140:04, cor:dmo:050:12, ruling 0099: giving a grant is person-only, so
 * a worker carrying its holder's user id, a run principal, an impersonation or an App key is refused, exactly as every other grant
 * door refuses it via `requirePersonOnlyAct`); (2) that person may do the thing themselves (the action's gate). Authority over the
 * App is necessary, never sufficient. An unknown action, or one whose rule has no gate, has NO issuer: it refuses everyone,
 * platform admins included. Never answers for a caller it cannot identify.
 */
export async function requireActionIssuer(ctx: Context, actionName: string, appRef: string, values?: unknown): Promise<void> {
  const action = PLATFORM_ACTIONS.find((a) => a.name === actionName);
  const gate = action ? ISSUER_RULES[action.issuerRule] : undefined;
  if (!action || !gate) throw new GraphQLError('Unknown action.', { extensions: { code: 'BAD_USER_INPUT' } });
  if (ctx.appKeyId) throw authorizationDenied();
  await requirePersonOnlyAct(ctx, 'grant.give', authorizationDenied);
  await gate(ctx, appRef, values);
}
