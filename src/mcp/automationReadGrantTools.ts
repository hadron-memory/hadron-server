/**
 * #2883 — an automation's read grant on the MCP surface (cor:agt:010:01). A thin call into the SAME GraphQL
 * resolvers (`src/api/graphql/schema/resolvers.automationReadGrant.ts`): who may give, revoke and see a grant, the
 * authority recheck under locks and the audit row are decided once, so the two surfaces cannot drift. A refusal is the
 * one `Forbidden`, the same answer as an unknown App, trigger, memory or grant.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GraphQLError } from 'graphql';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';
import type { AuthContext } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';

type Row = {
  id: string; appId: string; triggerKind: string; triggerId: string; memoryUrn: string | null;
  prefix: string | null; grantedBy: string; createdAt: Date; revokedAt: Date | null; revokedBy: string | null;
};
type Fields = {
  Query: { automationReadGrants: (p: unknown, a: { appRef?: string; memoryRef?: string; includeRevoked?: boolean }, c: Context) => Promise<Row[]> };
  Mutation: {
    setAutomationReadGrant: (p: unknown, a: { appRef: string; triggerKind: string; triggerId: string; memoryRef: string; prefix?: string }, c: Context) => Promise<Row>;
    revokeAutomationReadGrant: (p: unknown, a: { id: string }, c: Context) => Promise<Row>;
  };
};

const line = (r: Row): string =>
  `${r.id}: ${r.triggerKind} ${r.triggerId} (App ${r.appId}) reads ${r.memoryUrn ?? '(memory)'}${r.prefix ? ` under ${r.prefix}` : ' (whole memory)'}; ` +
  `given by ${r.grantedBy}${r.revokedAt ? `; REVOKED by ${r.revokedBy}` : ''}`;
export const SHAPE_HADRON_SET_AUTOMATION_READ_GRANT = {
  app: z.string().min(1).describe('The App (URN or id).'),
  triggerKind: z.enum(['SCHEDULE', 'WEBHOOK']).describe('Which kind of trigger the automation is.'),
  triggerId: z.string().min(1).describe('The schedule or webhook id.'),
  memory: z.string().min(1).describe('The memory to read (URN or id).'),
  prefix: z.string().optional().describe('A loc prefix: the loc itself and its colon-boundary descendants. Omit for the whole memory.'),
};
export const SHAPE_HADRON_REVOKE_AUTOMATION_READ_GRANT = { id: z.string().min(1).describe('The grant id.') };
export const SHAPE_HADRON_LIST_AUTOMATION_READ_GRANTS = {
  app: z.string().optional().describe('The App (URN or id).'),
  memory: z.string().optional().describe('The memory (URN or id).'),
  includeRevoked: z.boolean().optional().describe('Include revoked grants. Default false.'),
};
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function registerAutomationReadGrantTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db, transport: 'mcp',
    clientId: auth.clientId ?? undefined, userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined, sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'], organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });
  const r = resolvers as unknown as Fields;
  const guard = async (fn: () => Promise<string>) => {
    try { return text(await fn()); } catch (e) {
      if (e instanceof GraphQLError && isTrustedRefusal(e)) return { isError: true as const, ...text(`[${String(e.extensions?.code).toLowerCase()}] ${e.message}`) };
      throw e;
    }
  };

  server.tool(
    'hadron_set_automation_read_grant',
    'Give an automation (a live schedule or webhook of an App) a read grant on one memory or one loc prefix (cor:agt:010:01). Read-only, used only by that automation\'s runs reading a node, checked live. Only whoever manages the target may give it: the Agent\'s manager for an Agent\'s system memory (the Agent must be installed in the App), the memory\'s manager otherwise. Never personal, private, encrypted, install, Worker or session memories or another App\'s team space. Omit prefix for the whole memory.',
    SHAPE_HADRON_SET_AUTOMATION_READ_GRANT,
    async ({ app, triggerKind, triggerId, memory, prefix }) => guard(async () =>
      `Granted. ${line(await r.Mutation.setAutomationReadGrant(null, { appRef: app, triggerKind, triggerId, memoryRef: memory, prefix }, ctxOf()))}`),
  );
  server.tool(
    'hadron_revoke_automation_read_grant',
    'End an automation read grant (terminal). The App\'s managers or the target\'s manager may.',
    SHAPE_HADRON_REVOKE_AUTOMATION_READ_GRANT,
    async ({ id }) => guard(async () => `Revoked. ${line(await r.Mutation.revokeAutomationReadGrant(null, { id }, ctxOf()))}`),
  );
  server.tool(
    'hadron_list_automation_read_grants',
    'List automation read grants for an App (its managers see them) and/or a memory (its manager, or the Agent\'s manager for a system memory, sees the grants on it). You see only the grants whose App or target you manage. Give app, memory or both.',
    SHAPE_HADRON_LIST_AUTOMATION_READ_GRANTS,
    async ({ app, memory, includeRevoked }) => guard(async () => {
      const rows = await r.Query.automationReadGrants(null, { appRef: app, memoryRef: memory, includeRevoked }, ctxOf());
      return rows.length === 0 ? 'No automation read grants.' : rows.map(line).join('\n');
    }),
  );
}
