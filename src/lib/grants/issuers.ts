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
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { requireScheduleAdmin } from '../../api/graphql/schema/resolvers.appRun.js';
import { PLATFORM_ACTIONS } from './actions.js';

type IssuerGate = (ctx: Context, appRef: string) => Promise<unknown>;

export const ISSUER_RULES: Readonly<Record<string, IssuerGate>> = {
  APP_SCHEDULE_ADMIN: requireScheduleAdmin,
  APP_WEBHOOK_ADMIN: requireScheduleAdmin,
};

/**
 * Throws unless the caller may issue a grant for `actionName` in the App `appRef` (id or URN). An unknown action, or one whose
 * rule has no gate, has NO issuer: it refuses everyone, platform admins included. Never answers for a caller it cannot identify.
 */
export async function requireActionIssuer(ctx: Context, actionName: string, appRef: string): Promise<void> {
  const action = PLATFORM_ACTIONS.find((a) => a.name === actionName);
  const gate = action ? ISSUER_RULES[action.issuerRule] : undefined;
  if (!action || !gate) throw new GraphQLError('Unknown action.', { extensions: { code: 'BAD_USER_INPUT' } });
  await gate(ctx, appRef);
}
