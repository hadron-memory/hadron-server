/**
 * #1562 — the interactive surface for page-monitor watches (`web_poll_*`),
 * which until now existed only as run tools. Org ADMIN gated through the
 * shared `requireOrgRole`, org-scoped by the core routing binding, and held
 * to the same `tool.web_poll` policy action the run tools walk. Both the
 * GraphQL fields and the MCP tools call these resolvers, so the gate is
 * computed once.
 */
import { GraphQLError } from 'graphql';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { cancelOrgWebPoll, listOrgWebPolls, webPollPolicyAllows } from '../../../lib/webPolls.js';
import type { Context } from './resolvers.helpers.js';
import { requireOrgRole } from './resolvers.helpers.js';

/** ADMIN on the org, then the policy chain; returns the resolved org id. */
async function authorize(ctx: Context, orgRef: string): Promise<string> {
  const { id: organizationId } = await resolveOrgRef(ctx.db, orgRef);
  await requireOrgRole(ctx, organizationId, 'ADMIN');
  if (!(await webPollPolicyAllows(ctx.db, { organizationId, userId: ctx.userId, appId: ctx.appId }))) {
    throw new GraphQLError('Policy does not allow tool.web_poll for this caller.', {
      extensions: { code: 'POLICY_DENIED' },
    });
  }
  return organizationId;
}

export const webPollQueries = {
  /** The org's active watches (org ADMIN/OWNER; `tool.web_poll` policy). */
  webPolls: async (_: unknown, { orgRef }: { orgRef: string }, ctx: Context) =>
    listOrgWebPolls(ctx.db, await authorize(ctx, orgRef)),
};

export const webPollMutations = {
  /** Stop one watch. Another org's job id reads as NOT_FOUND, like a missing one. */
  cancelWebPoll: async (_: unknown, { orgRef, jobId }: { orgRef: string; jobId: string }, ctx: Context) => {
    const result = await cancelOrgWebPoll(ctx.db, await authorize(ctx, orgRef), jobId);
    if (!result) throw new GraphQLError('Web poll not found in this organization.', { extensions: { code: 'NOT_FOUND' } });
    return result;
  },
};
