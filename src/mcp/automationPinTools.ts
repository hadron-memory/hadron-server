/** Thin MCP parity for #1719's generic preview/re-adopt operation. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { automationPinQueries, automationPinMutations } from '../api/graphql/schema/resolvers.automationPin.js';
export function registerAutomationPinTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const ctx = () => ({ db: deps.db, ...deps.auth });
  const wrap = async (fn: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(), null, 2) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: String((e as Error).message) }] }; }
  };
  server.tool('hadron_preview_automation', 'Review the exact graph and hash before re-adopting a changed automation. Trigger refs are row IDs.', AUTOMATION_TRIGGER_SHAPE,
    args => wrap(() => automationPinQueries.previewAutomation({}, args, ctx())));
  server.tool('hadron_re_adopt_automation', 'Re-adopt a trigger using the hash from hadron_preview_automation. The run-as user adopts their own automation; an App-only trigger (no run-as user) is adopted by the App\'s owner, or by an ADMIN or OWNER of the organization that owns the App, or by a platform admin on an organization-owned App.', SHAPE_HADRON_RE_ADOPT_AUTOMATION,
    args => wrap(() => automationPinMutations.reAdoptAutomation({}, args, ctx())));
}

const AUTOMATION_TRIGGER_SHAPE = { triggerKind: z.enum(['SCHEDULE', 'WEBHOOK', 'MANUAL']), triggerRef: z.string().min(1) };

// ── #2260: parameter shapes, built ONCE per process ──────────────────────────
// A shape is pure data (no session state: moved here only because nothing in it resolves to a
// function- or block-scoped binding, so `tsc` rejects one that captures `auth` or any other
// per-session value). Every MCP session registers these same objects instead of rebuilding ~15 MB.

const SHAPE_HADRON_RE_ADOPT_AUTOMATION = { ...AUTOMATION_TRIGGER_SHAPE, expectedHash: z.string().regex(/^[a-f0-9]{64}$/) };
