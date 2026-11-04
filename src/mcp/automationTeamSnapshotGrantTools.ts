/** #3350: MCP parity delegates every authority decision and audit to the GraphQL doors. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GraphQLError } from 'graphql';
import { runTeamSnapshotMutations, runTeamSnapshotQueries } from '../api/graphql/schema/resolvers.runTeamSnapshot.js';
import type { Context } from '../api/graphql/schema/resolvers.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';
import type { AuthContext } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { AUTOMATION_GRANT_INSTRUCTION } from './automationGrantInstructionShape.js';

export const SHAPE_SET_TEAM_SNAPSHOT_GRANT = {
  app: z.string().min(1), triggerKind: z.enum(['SCHEDULE', 'WEBHOOK']), triggerId: z.string().min(1),
};
export const SHAPE_GET_TEAM_SNAPSHOT_GRANT = { id: z.string().min(1) };
export const SHAPE_REVOKE_TEAM_SNAPSHOT_GRANT = { id: z.string().min(1), instruction: AUTOMATION_GRANT_INSTRUCTION };
export const SHAPE_LIST_TEAM_SNAPSHOT_GRANTS = {
  instruction: AUTOMATION_GRANT_INSTRUCTION,
  app: z.string().min(1), includeRevoked: z.boolean().optional(), limit: z.number().int().optional(), offset: z.number().int().optional(),
};
export function registerAutomationTeamSnapshotGrantTools(server: McpServer, { db, auth }: { db: PrismaClient; auth: AuthContext }) {
  const ctx = (): Context => ({ db, transport: 'mcp', userId: auth.userId ?? undefined, appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined, clientId: auth.clientId ?? undefined, sessionId: auth.sessionId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined, sessionBindingRefused: auth.sessionBindingRefused, impersonation: auth.impersonation });
  const call = async (fn: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] }; }
    catch (e) {
      if (e instanceof GraphQLError && isTrustedRefusal(e)) return { isError: true as const, content: [{ type: 'text' as const, text: `[${String(e.extensions.code).toLowerCase()}] ${e.message}` }] };
      throw e;
    }
  };
  server.tool('hadron_set_automation_team_snapshot_grant',
    'Give one live automation a read-only own-App roster/tasks grant (cor:agt:050:23). Person managing the App only; no worker, run, key or impersonation. Other automations gain nothing.',
    SHAPE_SET_TEAM_SNAPSHOT_GRANT, ({ app, triggerKind, triggerId }) => call(() => runTeamSnapshotMutations.setAutomationTeamSnapshotGrant(null, { appRef: app, triggerKind, triggerId }, ctx())));
  server.tool('hadron_revoke_automation_team_snapshot_grant',
    'Revoke one automation team snapshot grant, terminal and recorded. App managers only. A held worker may act on its holder\'s instruction within its own App.',
    SHAPE_REVOKE_TEAM_SNAPSHOT_GRANT, ({ id, instruction: claim }) => call(() => runTeamSnapshotMutations.revokeAutomationTeamSnapshotGrant(null, { id, instruction: claim }, ctx())));
  server.tool('hadron_get_automation_team_snapshot_grant',
    'Read one team snapshot grant by id, including revoked rows, as a person managing its App. Returns eight metadata fields. Unknown and unauthorized ids both refuse NOT_FOUND; no worker instruction arm (cor:agt:050:23).',
    SHAPE_GET_TEAM_SNAPSHOT_GRANT, ({ id }) => call(() => runTeamSnapshotQueries.automationTeamSnapshotGrant(null, { id }, ctx())));
  server.tool('hadron_list_automation_team_snapshot_grants',
    'Page the App team snapshot grants as its manager. includeRevoked defaults false; limit defaults20, capped200, zero counts only; offset defaults0. A held worker may list on an instruction within its own App; each admitted instructed list records one ids-only team event.',
    SHAPE_LIST_TEAM_SNAPSHOT_GRANTS, ({ app, ...args }) => call(() => runTeamSnapshotQueries.automationTeamSnapshotGrants(null, { appRef: app, ...args }, ctx())));
}
