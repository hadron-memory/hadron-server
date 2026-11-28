/**
 * #2883's automation read grant on the MCP surface, RETIRED by #5404 (hrn:node:hadronmemory.com:specs:cor:acl:140:02; Holger,
 * 2026-11-27, "Retire all"). The three tools keep their names and input shapes for the deprecation window and delegate to the
 * GraphQL doors (`src/api/graphql/schema/resolvers.retiredGrantDoors.ts`), which refuse every call with `DOOR_RETIRED`: an App's
 * runs read outside it through a signed `memory.read` grant, given with `createGrant`. They are removed when the window ends.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GraphQLError } from 'graphql';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';
import type { AuthContext } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { AUTOMATION_GRANT_INSTRUCTION } from './automationGrantInstructionShape.js';

type Retired = (p: unknown, a: unknown, c: Context) => Promise<never>;
type Fields = {
  Query: { automationReadGrants: Retired };
  Mutation: { setAutomationReadGrant: Retired; revokeAutomationReadGrant: Retired };
};

const RETIRED_NOTE = 'RETIRED (#5404): every call is refused with DOOR_RETIRED. Give a signed memory.read grant with createGrant instead.';

export const SHAPE_HADRON_SET_AUTOMATION_READ_GRANT = {
  app: z.string().min(1).describe('The App (URN or id).'),
  triggerKind: z.enum(['SCHEDULE', 'WEBHOOK']).describe('Which kind of trigger the automation is.'),
  triggerId: z.string().min(1).describe('The schedule or webhook id.'),
  memory: z.string().min(1).describe('The memory to read (URN or id).'),
  prefix: z.string().optional().describe('A loc prefix: the loc itself and its colon-boundary descendants. Omit for the whole memory.'),
};
export const SHAPE_HADRON_REVOKE_AUTOMATION_READ_GRANT = { id: z.string().min(1).describe('The grant id.'), instruction: AUTOMATION_GRANT_INSTRUCTION };
export const SHAPE_HADRON_LIST_AUTOMATION_READ_GRANTS = {
  instruction: AUTOMATION_GRANT_INSTRUCTION,
  app: z.string().optional().describe('The App (URN or id).'),
  memory: z.string().optional().describe('The memory (URN or id).'),
  includeRevoked: z.boolean().optional().describe('Include revoked grants. Default false.'),
};
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function registerAutomationReadGrantTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db, transport: 'mcp',
    appKeyId: auth.appKeyId ?? undefined, clientId: auth.clientId ?? undefined, userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined, sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'], organizationId: auth.organizationId ?? undefined,
    sessionBindingRefused: auth.sessionBindingRefused, impersonation: auth.impersonation,
  });
  const r = resolvers as unknown as Fields;
  const guard = async (fn: () => Promise<never>) => {
    try { return text(await fn()); } catch (e) {
      if (e instanceof GraphQLError && isTrustedRefusal(e)) return { isError: true as const, ...text(`[${String(e.extensions?.code).toLowerCase()}] ${e.message}`) };
      throw e;
    }
  };

  server.tool(
    'hadron_set_automation_read_grant',
    `Formerly gave an automation a read grant on one memory or loc prefix. ${RETIRED_NOTE}`,
    SHAPE_HADRON_SET_AUTOMATION_READ_GRANT,
    async (args) => guard(() => r.Mutation.setAutomationReadGrant(null, args, ctxOf())),
  );
  server.tool(
    'hadron_revoke_automation_read_grant',
    `Formerly ended an automation read grant. ${RETIRED_NOTE}`,
    SHAPE_HADRON_REVOKE_AUTOMATION_READ_GRANT,
    async (args) => guard(() => r.Mutation.revokeAutomationReadGrant(null, args, ctxOf())),
  );
  server.tool(
    'hadron_list_automation_read_grants',
    `Formerly listed automation read grants. ${RETIRED_NOTE}`,
    SHAPE_HADRON_LIST_AUTOMATION_READ_GRANTS,
    async (args) => guard(() => r.Query.automationReadGrants(null, args, ctxOf())),
  );
}
