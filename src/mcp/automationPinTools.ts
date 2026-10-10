/** Thin MCP parity for #1719's generic preview/re-adopt operation. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { automationPinQueries, automationPinMutations } from '../api/graphql/schema/resolvers.automationPin.js';
export function registerAutomationPinTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const schema = { triggerKind: z.enum(['SCHEDULE', 'WEBHOOK', 'MANUAL']), triggerRef: z.string().min(1) };
  const ctx = () => ({ db: deps.db, ...deps.auth });
  const wrap = async (fn: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(), null, 2) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: String((e as Error).message) }] }; }
  };
  server.tool('hadron_preview_automation', 'Review the exact graph and hash before re-adopting a changed automation. Trigger refs are row IDs.', schema,
    args => wrap(() => automationPinQueries.previewAutomation({}, args, ctx())));
  server.tool('hadron_re_adopt_automation', 'Re-adopt a trigger using the hash from hadron_preview_automation. Only the run-as user can adopt their automation.', { ...schema, expectedHash: z.string().regex(/^[a-f0-9]{64}$/) },
    args => wrap(() => automationPinMutations.reAdoptAutomation({}, args, ctx())));
}
