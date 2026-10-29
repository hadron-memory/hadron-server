/** #2479: per-trigger budgets only narrow platform per-run defaults. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { automationPinQueries, automationPinMutations } from '../api/graphql/schema/resolvers.automationPin.js';
import { mintAppRun } from './appRuns.js';
import { schedulerTick } from './scheduler.js';
import express from 'express';
import { mountWebhookRoutes } from '../api/webhooks.js';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('RUN_DEFAULT_TOKEN_BUDGET', '100000');
  vi.stubEnv('RUN_DEFAULT_ACTION_BUDGET', '50');
});
afterEach(() => vi.unstubAllEnvs());
const M = appRunMutations as any;
async function fixture() {
  const user = await db.user.create({ data: { handle: 'budget-owner' } });
  const org = await db.organization.create({ data: { name: 'Budget', urn: 'budget.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Budget', urn: 'budget.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'budget.test:flow', class: 'knowledge', organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Budgeted flow', isRunnable: true, content: 'approved' } });
  const ctx = { db, userId: user.id, roles: [] };
  const input = { appRef: app.id, name: 'budget-trigger', cron: '* * * * *', entryNodeUrn: 'hrn:node:budget.test:flow:entry', runAsSelf: true };
  return { user, org, app, ctx, input };
}
const requested = { budgetTokens: 500, budgetActions: 3 };
const amounts = (r: any, tokens = 500, actions = 3) => expect(r).toMatchObject({ budgetTokens: tokens, budgetActions: actions, budgetTokensInitial: tokens, budgetActionsInitial: actions });

it.each(['SCHEDULE', 'WEBHOOK', 'MANUAL'] as const)('persists and seeds narrowed live/initial budgets for %s', async kind => {
  const f = await fixture();
  let run;
  if (kind === 'MANUAL') run = await M.triggerAppRun({}, { input: { ...f.input, ...requested } }, f.ctx);
  else {
    const made = kind === 'SCHEDULE'
      ? await M.createAgentSchedule({}, { input: { ...f.input, ...requested } }, f.ctx)
      : (await M.createAgentWebhook({}, { input: { ...f.input, ...requested } }, f.ctx)).webhook;
    expect(made).toMatchObject(requested);
    run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: kind, triggerId: made.id, entryNodeUrn: f.input.entryNodeUrn });
  }
  amounts(run);
  amounts(await db.appRun.findUniqueOrThrow({ where: { id: run.id } }));
});

it.each(['SCHEDULE', 'WEBHOOK', 'MANUAL'] as const)('refuses invalid and above-default budgets at the %s save door', async kind => {
  const f = await fixture();
  for (const extra of [{ budgetTokens: 0 }, { budgetTokens: -1 }, { budgetTokens: 1.5 }, { budgetTokens: NaN }, { budgetTokens: 100001 }, { budgetActions: 0 }, { budgetActions: 51 }]) {
    const method = kind === 'SCHEDULE' ? 'createAgentSchedule' : kind === 'WEBHOOK' ? 'createAgentWebhook' : 'triggerAppRun';
    await expect(M[method]({}, { input: { ...f.input, ...extra } }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  }
  expect(await db.appRun.count()).toBe(0);
});

it('uses current defaults for omitted values and narrows an old stored limit again at schedule launch', async () => {
  const f = await fixture();
  const s = await M.createAgentSchedule({}, { input: { ...f.input, ...requested } }, f.ctx);
  vi.stubEnv('RUN_DEFAULT_TOKEN_BUDGET', '200');
  vi.stubEnv('RUN_DEFAULT_ACTION_BUDGET', '2');
  await db.agentSchedule.update({ where: { id: s.id }, data: { nextRunAt: new Date(0) } });
  expect(await schedulerTick(db)).toBe(1);
  const run = await db.appRun.findFirstOrThrow({ where: { triggerId: s.id } });
  amounts(run, 200, 2);
  const omitted = await M.triggerAppRun({}, { input: f.input }, f.ctx);
  amounts(omitted, 200, 2);
  vi.stubEnv('RUN_DEFAULT_TOKEN_BUDGET', '100');
  amounts(await db.appRun.findUniqueOrThrow({ where: { id: run.id } }), 200, 2); // immutable mint snapshot
});

it('updates schedule limits, leaves omitted fields alone, and clears explicit null back to defaults', async () => {
  const f = await fixture();
  const s = await M.createAgentSchedule({}, { input: { ...f.input, ...requested } }, f.ctx);
  const updated = await M.updateAgentSchedule({}, { id: s.id, input: { budgetTokens: 400 } }, f.ctx);
  expect(updated).toMatchObject({ budgetTokens: 400, budgetActions: 3 });
  await expect(M.updateAgentSchedule({}, { id: s.id, input: { budgetActions: 51 } }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  const cleared = await M.updateAgentSchedule({}, { id: s.id, input: { budgetTokens: null } }, f.ctx);
  expect(cleared).toMatchObject({ budgetTokens: null, budgetActions: 3 });
});

it('shows effective budget in the existing plain approval projection after a platform reduction', async () => {
  const f = await fixture();
  const s = await M.createAgentSchedule({}, { input: { ...f.input, ...requested } }, f.ctx);
  vi.stubEnv('RUN_DEFAULT_TOKEN_BUDGET', '200');
  const detail = await (automationPinQueries as any).automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: s.id }, f.ctx);
  const limits = detail.summary.limits.join(' ');
  expect(limits).toContain('200'); expect(limits).toContain('3');
  expect(limits).toMatch(/tokens/i); expect(limits).toMatch(/actions/i);
  expect(limits).not.toMatch(/hrn:|[0-9a-f]{24}/);
});


it('webhook HTTP payload cannot widen setup limits, including after defaults are lowered', async () => {
  const f = await fixture();
  const made = await M.createAgentWebhook({}, { input: { ...f.input, ...requested } }, f.ctx);
  const api = express(); api.use(express.json()); mountWebhookRoutes(api, db);
  const server = api.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const launch = async () => {
    const res = await fetch(`http://127.0.0.1:${address.port}${made.path}?hpt=${made.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ budgetTokens: 100000, budgetActions: 50 }) });
    expect(res.status).toBe(202);
    const body = await res.json() as { runId: string };
    return db.appRun.findUniqueOrThrow({ where: { id: body.runId } });
  };
  try {
    amounts(await launch());
    vi.stubEnv('RUN_DEFAULT_TOKEN_BUDGET', '200'); vi.stubEnv('RUN_DEFAULT_ACTION_BUDGET', '2');
    amounts(await launch(), 200, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

it('narrowed budgets do not bypass daily token quota or launch a run on refusal', async () => {
  const f = await fixture();
  await M.triggerAppRun({}, { input: { ...f.input, ...requested } }, f.ctx);
  await db.quotaCounter.updateMany({ where: { scopeKind: 'app', scopeId: f.app.id, action: 'llm.tokens' }, data: { limit: 1, used: 1 } });
  await expect(M.triggerAppRun({}, { input: { ...f.input, budgetTokens: 1, budgetActions: 1 } }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'QUOTA_EXCEEDED' } });
  expect(await db.appRun.count()).toBe(1);
});

it('existing manual run snapshots and live decrements remain separate from later trigger changes', async () => {
  const f = await fixture();
  const old = await M.triggerAppRun({}, { input: { ...f.input, ...requested } }, f.ctx);
  await db.appRun.update({ where: { id: old.id }, data: { budgetTokens: { decrement: 20 }, budgetActions: { decrement: 1 } } });
  const next = await M.triggerAppRun({}, { input: { ...f.input, budgetTokens: 100, budgetActions: 1 } }, f.ctx);
  amounts(next, 100, 1);
  expect(await db.appRun.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ budgetTokens: 480, budgetActions: 2, budgetTokensInitial: 500, budgetActionsInitial: 3 });
});

it('legacy manual approval does not interpret exhausted live counters as trigger setup limits', async () => {
  const f = await fixture();
  const run = await M.triggerAppRun({}, { input: f.input }, f.ctx);
  await db.appRun.update({ where: { id: run.id }, data: { budgetTokensInitial: null, budgetActionsInitial: null, budgetTokens: 0, budgetActions: 0 } });
  const detail = await (automationPinQueries as any).automationApproval({}, { triggerKind: 'MANUAL', triggerRef: run.id }, f.ctx);
  expect(detail.summary.limits.join(' ')).toContain('100000');
  expect(await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ budgetTokensInitial: null, budgetActionsInitial: null, budgetTokens: 0, budgetActions: 0 });
});


it.each(['SCHEDULE', 'WEBHOOK', 'MANUAL'] as const)('accepts the exact platform-default ceiling at the %s save door', async kind => {
  const f = await fixture();
  const ceiling = { budgetTokens: 100000, budgetActions: 50 };
  if (kind === 'MANUAL') amounts(await M.triggerAppRun({}, { input: { ...f.input, ...ceiling } }, f.ctx), 100000, 50);
  else {
    const made = kind === 'SCHEDULE'
      ? await M.createAgentSchedule({}, { input: { ...f.input, ...ceiling } }, f.ctx)
      : (await M.createAgentWebhook({}, { input: { ...f.input, ...ceiling } }, f.ctx)).webhook;
    expect(made).toMatchObject(ceiling);
    amounts(await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: kind, triggerId: made.id, entryNodeUrn: f.input.entryNodeUrn }), 100000, 50);
  }
});

it.each(['SCHEDULE', 'WEBHOOK'] as const)('refuses a missing, deleted or foreign %s without default widening or quota consumption', async kind => {
  const f = await fixture();
  const made = kind === 'SCHEDULE'
    ? await M.createAgentSchedule({}, { input: { ...f.input, ...requested } }, f.ctx)
    : (await M.createAgentWebhook({}, { input: { ...f.input, ...requested } }, f.ctx)).webhook;
  const model = kind === 'SCHEDULE' ? db.agentSchedule : db.agentWebhook;
  await (model as any).update({ where: { id: made.id }, data: { deletedAt: new Date() } });
  const foreign = await db.app.create({ data: { name: 'Foreign', urn: 'budget.test:foreign', organizationId: f.org.id } });
  for (const [triggerId, appId] of [[made.id, f.app.id], ['missing-trigger', f.app.id], [null, f.app.id], [made.id, foreign.id]] as const) {
    if (appId === foreign.id) await (model as any).update({ where: { id: made.id }, data: { deletedAt: null } });
    await expect(mintAppRun(db, { appId, organizationId: f.org.id, triggerKind: kind, triggerId, entryNodeUrn: f.input.entryNodeUrn }))
      .rejects.toMatchObject({ code: 'TRIGGER_DISABLED' });
  }
  expect(await db.appRun.count()).toBe(0);
  expect(await db.quotaCounter.count()).toBe(0);
});

it('keeps omitted historical limits but refuses supplied above-current-default values on schedule update', async () => {
  const f = await fixture();
  const s = await M.createAgentSchedule({}, { input: { ...f.input, ...requested } }, f.ctx);
  vi.stubEnv('RUN_DEFAULT_TOKEN_BUDGET', '200'); vi.stubEnv('RUN_DEFAULT_ACTION_BUDGET', '2');
  await expect(M.updateAgentSchedule({}, { id: s.id, input: { budgetTokens: 500, budgetActions: 3 } }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  const same = await M.updateAgentSchedule({}, { id: s.id, input: { name: 'renamed' } }, f.ctx);
  expect(same).toMatchObject(requested);
  amounts(await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: 'SCHEDULE', triggerId: s.id, entryNodeUrn: f.input.entryNodeUrn }), 200, 2);
});

it.each(['SCHEDULE', 'WEBHOOK'] as const)('updates the %s budget projection without changing the consent hash or adopted state', async kind => {
  const f = await fixture();
  const s = kind === 'SCHEDULE'
    ? await M.createAgentSchedule({}, { input: { ...f.input, ...requested } }, f.ctx)
    : (await M.createAgentWebhook({}, { input: { ...f.input, ...requested } }, f.ctx)).webhook;
  const Q = automationPinQueries as any;
  const ref = { triggerKind: kind, triggerRef: s.id };
  const before = await Q.automationApproval({}, ref, f.ctx);
  vi.stubEnv('RUN_DEFAULT_TOKEN_BUDGET', '200'); vi.stubEnv('RUN_DEFAULT_ACTION_BUDGET', '2');
  expect(await (automationPinMutations as any).approveAutomation({}, { ...ref, expectedHash: before.hash }, f.ctx)).toBe(true);
  const after = await Q.automationApproval({}, ref, f.ctx);
  expect(after.hash).toBe(before.hash); expect(after.state).toBe('ADOPTED');
  expect(after.summary.limits).not.toEqual(before.summary.limits);
  amounts(await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: kind, triggerId: s.id, entryNodeUrn: f.input.entryNodeUrn }), 200, 2);
});
