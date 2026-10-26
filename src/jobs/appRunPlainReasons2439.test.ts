/** #2439: a failed run states its cause, who can fix it and where in plain words, and a finished run exposes its cost. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';
import { plainRunFailure } from '../lib/automation/plainReason.js';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

async function fixture() {
  const user = await db.user.create({ data: { handle: 'plain-owner' } });
  const org = await db.organization.create({ data: { name: 'Plain', urn: 'plain.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Plain', urn: 'plain.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'plain.test:flow', class: 'knowledge', organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  const ctx = { db, userId: user.id, roles: [] };
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name: 'Plain', cron: '* * * * *', entryNodeUrn: 'hrn:node:plain.test:flow:entry', runAsSelf: true } }, ctx);
  const run = () => mintAppRun(db, { appId: app.id, organizationId: org.id, userId: user.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn });
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'test' }));
  const deps: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: { provider: 'test', model: 'test' }, ownerType: 'HADRON_SERVER' }) as never), llm, writeOutput: vi.fn(async () => null) };
  return { user, org, app, memory, ctx, schedule, run, deps, llm };
}
const reasonOf = (id: string, ctx: unknown) => db.appRun.findUniqueOrThrow({ where: { id } })
  .then(r => (resolvers as never as { AppRun: { failureReason: (r: unknown, a: unknown, c: unknown) => unknown } }).AppRun.failureReason(r, {}, ctx));
const PLAIN = (r: unknown) => {
  const t = JSON.stringify(r);
  expect(t).not.toMatch(/[0-9a-f]{16,}/); // no row ids or hashes
  expect(t).not.toMatch(/hrn:|hadron_|AUTOMATION_|ACTIVATION_/); // no urns, tool names or codes
};

describe('plain failure reasons', () => {
  it('unadopted: says who adopts and where', async () => {
    const f = await fixture();
    const legacy = await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Legacy', cron: '* * * * *', entryNodeUrn: f.schedule.entryNodeUrn } });
    const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: 'SCHEDULE', triggerId: legacy.id, entryNodeUrn: legacy.entryNodeUrn });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    const r = await reasonOf(run.id, f.ctx) as { kind: string; summary: string; whoCanFix: string; nextStep: string };
    expect(r.kind).toBe('NOT_ADOPTED');
    expect(r.summary).toMatch(/not been approved|not adopted/i);
    expect(r.whoCanFix).toMatch(/run-as user/i);
    expect(r.nextStep).toMatch(/preview and adopt|adopt/i);
    PLAIN(r);
  });
  it('unreadable memory: distinct kind that does not name the memory', async () => {
    const f = await fixture();
    const run = await f.run();
    await db.appRun.update({ where: { id: run.id }, data: { status: 'FAILED', failure: { code: 'AUTOMATION_UNADOPTED', reason: 'MEMORY_UNREADABLE', message: 'Automation definition is not readable by its run principal for plain.test:flow' } } });
    const r = await reasonOf(run.id, f.ctx) as { kind: string; summary: string };
    expect(r.kind).toBe('MEMORY_UNREADABLE');
    expect(JSON.stringify(r)).not.toMatch(/plain\.test/);
    PLAIN(r);
  });
  it('over budget: a distinct kind and a next step', async () => {
    const f = await fixture();
    const run = await f.run();
    await db.appRun.update({ where: { id: run.id }, data: { status: 'FAILED', budgetActions: 0, failure: { code: 'ACTIVATION_DENIED', reason: 'DENIED_BUDGET', message: 'memory.write denied (policy, cancellation, or action budget).' } } });
    const r = await reasonOf(run.id, f.ctx) as { kind: string; nextStep: string };
    expect(r.kind).toBe('OVER_BUDGET');
    expect(r.nextStep.length).toBeGreaterThan(10);
    PLAIN(r);
  });
  it('the three kinds are distinct and a run with no failure has no reason', async () => {
    expect(plainRunFailure({ failure: null, budgetTokens: 5, budgetActions: 5, status: 'SUCCEEDED' } as never)).toBeNull();
    const kinds = [
      plainRunFailure({ failure: { code: 'AUTOMATION_UNADOPTED', message: 'x' }, budgetTokens: 5, budgetActions: 5, status: 'FAILED' } as never)?.kind,
      plainRunFailure({ failure: { code: 'AUTOMATION_UNADOPTED', reason: 'MEMORY_UNREADABLE', message: 'x' }, budgetTokens: 5, budgetActions: 5, status: 'FAILED' } as never)?.kind,
      plainRunFailure({ failure: { code: 'ACTIVATION_DENIED', reason: 'DENIED_BUDGET', message: 'x' }, budgetTokens: 0, budgetActions: 5, status: 'FAILED' } as never)?.kind,
    ];
    expect(new Set(kinds).size).toBe(3);
  });
  it('an unknown code still reads plainly, never as a raw code', async () => {
    const r = plainRunFailure({ failure: { code: 'SOMETHING_NEW', message: 'boom' }, budgetTokens: 5, budgetActions: 5, status: 'FAILED' } as never)!;
    expect(r.kind).toBe('OTHER');
    expect(r.nextStep).toMatch(/\w/);
  });
});

describe('review fixes (#2492)', () => {
  it('a policy denial with an exhausted budget is a policy reason, not a budget one', () => {
    const r = plainRunFailure({ failure: { code: 'ACTIVATION_DENIED', reason: 'DENIED_POLICY', message: 'x' }, budgetTokens: 0, budgetActions: 0, status: 'FAILED' } as never)!;
    expect(r.kind).toBe('POLICY_DENIED');
    expect(plainRunFailure({ failure: { code: 'ACTIVATION_DENIED', message: 'x' }, budgetTokens: 0, budgetActions: 0, status: 'FAILED' } as never)!.kind).toBe('OTHER');
  });
  it('a real policy denial at execution records its cause at the source', async () => {
    const f = await fixture();
    const run = await f.run();
    await db.appRun.update({ where: { id: run.id }, data: { policy: { chain: [{ allow: [] }] } as never, budgetTokens: 0 } });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    const failure = (await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure as { code: string; reason?: string };
    expect(failure.code).toBe('ACTIVATION_DENIED');
    expect(failure.reason).toBe('DENIED_POLICY');
  });
  it('a real budget denial records DENIED_BUDGET', async () => {
    const f = await fixture();
    const run = await f.run();
    await db.appRun.update({ where: { id: run.id }, data: { budgetTokens: 0 } });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect((await reasonOf(run.id, f.ctx) as { kind: string }).kind).toBe('OVER_BUDGET');
  });
  it('no unadopted/changed/unreadable text claims that nothing ran', () => {
    for (const reason of [undefined, 'MEMORY_UNREADABLE'] as const) for (const code of ['AUTOMATION_UNADOPTED', 'AUTOMATION_CHANGED']) {
      const r = plainRunFailure({ failure: { code, reason, message: 'x' }, status: 'FAILED' } as never)!;
      expect(`${r.summary} ${r.nextStep}`).not.toMatch(/nothing ran|before doing anything/i);
      expect(r.nextStep).toMatch(/already did/i);
    }
  });
  it('real execution after the memory became unreadable reports MEMORY_UNREADABLE, not CHANGED', async () => {
    const f = await fixture();
    const run = await f.run();
    const other = await db.user.create({ data: { handle: 'other-plain-owner' } });
    await db.memory.update({ where: { id: f.memory.id }, data: { class: 'private', userId: other.id } });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect((await reasonOf(run.id, f.ctx) as { kind: string }).kind).toBe('MEMORY_UNREADABLE');
    expect(f.llm).not.toHaveBeenCalled();
  });
  it('a failed rollup rolls the usage event back together with it and the run still finishes', async () => {
    const f = await fixture();
    await db.aiModelPrice.create({ data: { id: generateId(), provider: 'test', model: 'test', tier: 1, inputMicroCentsPerMTok: 300_000_000n, outputMicroCentsPerMTok: 1_500_000_000n, effectiveAt: new Date('2020-01-01') } as never });
    const run = await f.run();
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('injected counter failure') as never);
    const outcome = await executeAppRun(db, run.id, f.deps);
    spy.mockRestore();
    expect(outcome).not.toBe('failed');
    expect(await db.usageEvent.count({ where: { appId: f.app.id, type: 'app-run' } })).toBe(0);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents).toBe(0n);
  });
  it('cost keeps accumulating across hops and a legacy NULL run stays unknown', async () => {
    const f = await fixture();
    await db.aiModelPrice.create({ data: { id: generateId(), provider: 'test', model: 'test', tier: 1, inputMicroCentsPerMTok: 300_000_000n, outputMicroCentsPerMTok: 1_500_000_000n, effectiveAt: new Date('2020-01-01') } as never });
    const legacy = await f.run();
    await db.appRun.update({ where: { id: legacy.id }, data: { costMicroCents: null } });
    await executeAppRun(db, legacy.id, f.deps);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: legacy.id } })).costMicroCents).toBeNull();
  });
});

describe('per-run cost', () => {
  it('a finished run exposes spend, cost and budget; a run minted before the counter is unknown, not zero', async () => {
    const f = await fixture();
    const run = await f.run();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents).toBe(0n);
    const legacy = await db.appRun.update({ where: { id: (await f.run()).id }, data: { costMicroCents: null } });
    const field = (resolvers as never as { AppRun: { costMicroCents: (r: unknown) => unknown } }).AppRun.costMicroCents;
    expect(field(legacy)).toBeNull();
    expect(field({ costMicroCents: 12345n })).toBe('12345');
  });
  it('executing a priced hop adds its usage-event cost to the run', async () => {
    const f = await fixture();
    await db.aiModelPrice.create({ data: { id: generateId(), provider: 'test', model: 'test', tier: 1, inputMicroCentsPerMTok: 300_000_000n, outputMicroCentsPerMTok: 1_500_000_000n, effectiveAt: new Date('2020-01-01') } as never });
    const run = await f.run();
    await executeAppRun(db, run.id, f.deps);
    const events = await db.usageEvent.findMany({ where: { appId: f.app.id, type: 'app-run' } });
    const priced = events.reduce((n, e) => n + (e.costMicroCents ?? 0n), 0n);
    const row = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(priced).toBeGreaterThan(0n);
    expect(row.costMicroCents).toBe(priced);
    expect(row.tokensSpent).toBe(1500);
  });
});
