/** #2479: per-trigger budgets only narrow platform per-run defaults. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { automationPinQueries } from '../api/graphql/schema/resolvers.automationPin.js';
import { mintAppRun } from './appRuns.js';
import { schedulerTick } from './scheduler.js';
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
