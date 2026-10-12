/** #1719 R5b: one owner-controlled preview/re-adopt door for every trigger. */
import { configSelection } from '../../../lib/automation/identities.js';
import { GraphQLError } from 'graphql';
import { captureAutomationPin, storedAutomationPin } from '../../../lib/automation/pins.js';
import { runAuthContext, isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';
import { hasAppRelationship } from '../../../lib/auth/appRelationship.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { requireOwnerOrOrgRole, type Context } from './resolvers.helpers.js';

export type AutomationTriggerKind = 'SCHEDULE' | 'WEBHOOK' | 'MANUAL';
export interface AutomationTriggerRef { triggerKind: AutomationTriggerKind; triggerRef: string }
const denied = () => new GraphQLError('Only the run-as user may preview and re-adopt this automation; an App-only trigger requires its manager.', { extensions: { code: 'FORBIDDEN' } });
async function load(ctx: Context, input: AutomationTriggerRef) {
  if (!ctx.userId || ctx.impersonation || isRunPrincipal(ctx)) throw denied();
  const where = { id: input.triggerRef };
  const row = input.triggerKind === 'SCHEDULE'
    ? await ctx.db.agentSchedule.findFirst({ where: { ...where, deletedAt: null } })
    : input.triggerKind === 'WEBHOOK'
      ? await ctx.db.agentWebhook.findFirst({ where: { ...where, deletedAt: null } })
      : input.triggerKind === 'MANUAL'
        ? await ctx.db.appRun.findFirst({ where: { ...where, triggerKind: 'MANUAL' } }) : null;
  if (!row) throw new GraphQLError('Automation trigger not found.', { extensions: { code: 'NOT_FOUND' } });
  const app = await ctx.db.app.findFirst({ where: { id: row.appId, organizationId: row.organizationId, deletedAt: null, uninstalledAt: null } });
  const actor = await ctx.db.user.findFirst({ where: { id: ctx.userId, deletedAt: null }, select: { id: true } });
  if (!app || !actor) throw denied();
  if (row.userId !== null) {
    if (!isStrictOwner(ctx, row.userId) || !await hasAppRelationship(ctx.db, row.appId, row.userId)) throw denied();
  } else {
    await requireOwnerOrOrgRole(ctx, app, 'ADMIN', 'app');
  }
  return row;
}
async function preview(ctx: Context, row: Awaited<ReturnType<typeof load>>) {
  const pin = await captureAutomationPin(ctx.db, row.appId, row.userId, row.entryNodeUrn, row.organizationId, ctx, configSelection(row));
  const memories = new Set(Object.values(pin.nodes).map(n => String(n.state.memoryId)));
  for (const id of memories) if (!await canReadMemory(ctx.db, ctx, id)) throw denied();
  return pin;
}
export const automationPinQueries = {
  /** Returns the exact graph bytes and digest the actor must review. */
  previewAutomation: async (_: unknown, input: AutomationTriggerRef, ctx: Context) => preview(ctx, await load(ctx, input)),
};
export const automationPinMutations = {
  /** Rebind only the actor's exact preview hash; graph drift rejects adoption. */
  reAdoptAutomation: async (_: unknown, input: AutomationTriggerRef & { expectedHash: string }, ctx: Context) => {
    const observed = await load(ctx, input);
    let row = observed;
    return withAuthorizedTx(ctx, [ { kind: 'app', id: observed.appId },
      { kind: 'org', id: observed.organizationId },
      ...(observed.userId ? [{ kind: 'user' as const, id: observed.userId }] : []) ],
      async txCtx => { row = await load(txCtx, input); if (row.appId !== observed.appId || row.userId !== observed.userId || row.organizationId !== observed.organizationId) throw denied(); },
      async (tx, txCtx) => {
        const pin = await preview(txCtx, row);
        if (pin.hash !== input.expectedHash) throw new GraphQLError('Automation changed since preview; preview and re-adopt again.', { extensions: { code: 'AUTOMATION_CHANGED' } });
        for (const node of Object.values(pin.nodes)) if (!await canReadMemory(txCtx.db, runAuthContext({ ...row, id: 'setup' }), String(node.state.memoryId))) throw denied();
        const data = { automationPin: storedAutomationPin(pin) as never, updatedBy: ctx.userId };
        if (input.triggerKind === 'SCHEDULE') await tx.agentSchedule.update({ where: { id: row.id }, data });
        else if (input.triggerKind === 'WEBHOOK') await tx.agentWebhook.update({ where: { id: row.id }, data });
        else await tx.manualAutomationPin.upsert({ where: { runId: row.id }, create: { runId: row.id, pin: storedAutomationPin(pin) as never, adoptedBy: ctx.userId }, update: { pin: storedAutomationPin(pin) as never, adoptedAt: new Date(), adoptedBy: ctx.userId } });
        return true;
      }, { afterLock: async tx => {
        if (input.triggerKind === 'SCHEDULE') await tx.$queryRaw`SELECT id FROM agent_schedules WHERE id = ${observed.id} FOR UPDATE`;
        else if (input.triggerKind === 'WEBHOOK') await tx.$queryRaw`SELECT id FROM agent_webhooks WHERE id = ${observed.id} FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM app_runs WHERE id = ${observed.id} FOR UPDATE`;
      } });
  },
};
