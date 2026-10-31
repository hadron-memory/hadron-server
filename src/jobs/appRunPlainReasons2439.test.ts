/** #2439: a failed run states its cause, who can fix it and where in plain words, and a finished run exposes its cost. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';
import { plainRunFailure } from '../lib/automation/plainReason.js';
import { recordLlmUsage } from '../lib/metering/index.js';
import type { Prisma } from '../generated/prisma/index.js';
import { assertObjectType, buildASTSchema, parse } from 'graphql';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

async function fixture() {
  const user = await db.user.create({ data: { handle: 'plain-owner' } });
  const org = await db.organization.create({ data: { name: 'Plain', urn: 'plain.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Plain', urn: 'plain.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  // #2712: a run needs an installed Agent with a served boot prompt (R74).
  const agent = await db.agent.create({ data: { name: 'Plain agent', urn: 'plain.test:agent', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'plain.test:flow', class: 'knowledge', organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
    await db.aiModelPrice.create({ data: { id: generateId(), provider: 'test', model: 'test', tier: 1, inputMicroCentsPerMTok: 300_000_000n, outputMicroCentsPerMTok: 1_500_000_000n, effectiveAt: new Date('2020-01-01') } as never });
  const ctx = { db, userId: user.id, roles: [] };
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name: 'Plain', cron: '* * * * *', entryNodeUrn: 'hrn:node:plain.test:flow:entry', runAsSelf: true } }, ctx);
  const run = () => mintAppRun(db, { appId: app.id, organizationId: org.id, agentId: agent.id, userId: user.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn });
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'test' }));
  const deps: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: { provider: 'test', model: 'test' }, ownerType: 'HADRON_SERVER' }) as never), llm, writeOutput: vi.fn(async () => null) };
  return { user, org, app, agent, memory, ctx, schedule, run, deps, llm };
}
const reasonOf = (id: string, ctx: unknown) => db.appRun.findUniqueOrThrow({ where: { id } })
  .then(r => (resolvers as never as { AppRun: { failureReason: (r: unknown, a: unknown, c: unknown) => unknown } }).AppRun.failureReason(r, {}, ctx));
const PLAIN = (r: unknown) => {
  const t = JSON.stringify(r);
  expect(t).not.toMatch(/[0-9a-f]{16,}/); // no row ids or hashes
  expect(t).not.toMatch(/hrn:|hadron_|AUTOMATION_|ACTIVATION_/); // no urns, tool names or codes
};

/**
 * #2560 test-local injector for the metering rollup. It wraps the real `$transaction`,
 * forwards EVERY argument (callback and options; a non-callback overload is passed straight
 * through), lets the real event insert and the real counter update run inside the real
 * transaction, then throws `fault` once, and only inside a transaction that already inserted an
 * `app-run` usage event and then updates THIS run (the rollup), so an unrelated
 * `appRun.updateMany` (status, budget) can never trigger it.
 */
function injectRollupFault(
  runId: string,
  fault: Error,
  observe: (tx: Prisma.TransactionClient, eventId: string) => Promise<void>,
  real: (...args: unknown[]) => Promise<unknown> = db.$transaction.bind(db) as never,
) {
  const state = { transactions: 0, fired: 0 };
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((...args: unknown[]) => {
    const [callback, ...options] = args;
    state.transactions++;
    if (typeof callback !== 'function') return real(...args);
    return real((tx: Prisma.TransactionClient) => {
      let eventId: string | undefined;
      const appRun = new Proxy(tx.appRun, { get(model, member) {
        if (member !== 'updateMany') return Reflect.get(model, member, model);
        return async (...a: Parameters<typeof tx.appRun.updateMany>) => {
          const result = await model.updateMany(...a);
          const where = a[0]?.where as { id?: string } | undefined;
          if (eventId && where?.id === runId) { state.fired++; await observe(tx, eventId); throw fault; }
          return result;
        };
      } });
      const usageEvent = new Proxy(tx.usageEvent, { get(model, member) {
        if (member !== 'create') return Reflect.get(model, member, model);
        return async (...a: Parameters<typeof tx.usageEvent.create>) => {
          const created = await model.create(...a);
          if ((a[0].data as { type?: string }).type === 'app-run') eventId = created.id;
          return created;
        };
      } });
      return (callback as (t: Prisma.TransactionClient) => unknown)(new Proxy(tx, { get(target, property) {
        if (property === 'appRun') return appRun;
        if (property === 'usageEvent') return usageEvent;
        return Reflect.get(target, property, target);
      } }));
    }, ...options);
  }) as never);
  return { state, restore: () => spy.mockRestore() };
}

describe('plain failure reasons', () => {
  it('unadopted: says who adopts and where', async () => {
    const f = await fixture();
    const legacy = await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Legacy', cron: '* * * * *', entryNodeUrn: f.schedule.entryNodeUrn } });
    const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind: 'SCHEDULE', triggerId: legacy.id, entryNodeUrn: legacy.entryNodeUrn });
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
  it('losing read access MID-hop (after a priced hop) reports MEMORY_UNREADABLE too', async () => {
    const f = await fixture();
    const other = await db.user.create({ data: { handle: 'mid-hop-owner' } });
    const run = await f.run();
    f.llm.mockImplementationOnce(async () => {
      await db.memory.update({ where: { id: f.memory.id }, data: { class: 'private', userId: other.id } });
      return { text: 'ok', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'test' };
    });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    const row = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.tokensSpent).toBe(1500); // the hop really ran before access was lost
    expect((await reasonOf(run.id, f.ctx) as { kind: string }).kind).toBe('MEMORY_UNREADABLE');
    // and an edit that keeps the memory readable is still CHANGED
  });
  it('an edit mid-hop that keeps the memory readable stays CHANGED', async () => {
    const f = await fixture();
    const run = await f.run();
    f.llm.mockImplementationOnce(async () => {
      await db.node.updateMany({ where: { memoryId: f.memory.id, loc: 'entry' }, data: { content: 'edited mid-hop' } });
      return { text: 'ok', tokensIn: 10, tokensOut: 10, provider: 'test', model: 'test' };
    });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect((await reasonOf(run.id, f.ctx) as { kind: string }).kind).toBe('CHANGED');
  });
  it('a failed rollup rolls the usage event back together with it and the run still finishes', async () => {
    const f = await fixture();
    const run = await f.run();
    const fault = new Error('injected counter failure after the real event insert and counter update');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let observed: { eventRows: number; cost: bigint | null } | undefined;
    const injector = injectRollupFault(run.id, fault, async (tx, eventId) => {
      observed = {
        eventRows: await tx.usageEvent.count({ where: { id: eventId } }),
        cost: (await tx.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents,
      };
    });
    let outcome: string;
    let loggedCalls: unknown[][] = [];
    try { outcome = await executeAppRun(db, run.id, f.deps); } finally { loggedCalls = [...logged.mock.calls]; injector.restore(); logged.mockRestore(); }
    expect(outcome).not.toBe('failed');
    expect(injector.state.fired).toBe(1); // the sentinel was reached, once, at the rollup seam
    expect(observed).toEqual({ eventRows: 1, cost: 1_050_000n }); // both writes ran inside the transaction first
    expect(loggedCalls.some(([message, error]) => String(message).startsWith('recordLlmUsage failed') && error === fault))
      .toBe(true); // metering's fail-open path consumed THIS error, not an unrelated one
    expect(await db.usageEvent.count({ where: { appId: f.app.id, type: 'app-run' } })).toBe(0);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents).toBe(0n);
  });
  it('cost keeps accumulating across hops and a legacy NULL run stays unknown', async () => {
    const f = await fixture();
    const legacy = await f.run();
    await db.appRun.update({ where: { id: legacy.id }, data: { costMicroCents: null } });
    await executeAppRun(db, legacy.id, f.deps);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: legacy.id } })).costMicroCents).toBeNull();
  });
});

describe('per-run cost', () => {
  it('documents every plain failure kind, including POLICY_DENIED (#2506)', () => {
    const fields = assertObjectType(buildASTSchema(parse(typeDefs)).getType('AppRunFailureReason')).getFields();
    const source = ts.createSourceFile('plainReason.ts',
      readFileSync(new URL('../lib/automation/plainReason.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.filter(ts.isTypeAliasDeclaration)
      .find((statement) => statement.name.text === 'PlainRunFailureKind');
    if (!declaration || !ts.isUnionTypeNode(declaration.type)) throw new Error('PlainRunFailureKind must be a literal union');
    const kinds = declaration.type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) throw new Error('Expected a failure-kind string literal');
      return member.literal.text;
    });
    expect(fields.kind.description?.match(/[A-Z][A-Z_]+/g)?.sort()).toEqual(kinds.sort());
  });

  it('rolls back an inserted usage event and updated counter on a mid-transaction fault (#2506)', async () => {
    const f = await fixture();
    const run = await f.run();
    const fault = new Error('fault after event insert and counter update');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let observed: { eventRows: number; cost: bigint | null } | undefined;
    const injector = injectRollupFault(run.id, fault, async (tx, eventId) => {
      observed = {
        eventRows: await tx.usageEvent.count({ where: { id: eventId } }),
        cost: (await tx.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents,
      };
    });
    let recorded: Awaited<ReturnType<typeof recordLlmUsage>>;
    let loggedCalls: unknown[][] = [];
    try {
      recorded = await recordLlmUsage(db, {
        type: 'app-run', appId: f.app.id, appRunId: run.id,
        provider: 'test', model: 'test', tokensIn: 1000, tokensOut: 500,
      });
    } finally { loggedCalls = [...logged.mock.calls]; injector.restore(); logged.mockRestore(); }
    expect(injector.state).toEqual({ transactions: 1, fired: 1 }); // the metering transaction, faulted once
    // (1000 in x 300,000,000 + 500 out x 1,500,000,000 micro-cents/MTok) / 1,000,000 = 1,050,000
    expect(observed).toEqual({ eventRows: 1, cost: 1_050_000n }); // both writes really ran inside the transaction
    expect(loggedCalls.some(([message, error]) => String(message).startsWith('recordLlmUsage failed') && error === fault))
      .toBe(true); // the logged error IS the injected fault
    expect(await db.usageEvent.count({ where: { appId: f.app.id, type: 'app-run' } })).toBe(0);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents).toBe(0n);
    expect(recorded).toBeNull(); // metering stays fail-open
  });

  it('the injector forwards every transaction option, passes other overloads through and ignores unrelated writes (#2560)', async () => {
    const calls: unknown[][] = [];
    const real = vi.fn(async (...args: unknown[]) => { calls.push(args); return 'real-result'; });
    const injector = injectRollupFault('some-run', new Error('unused'), async () => {}, real as never);
    try {
      const options = { maxWait: 1234, timeout: 5678, isolationLevel: 'Serializable' as const };
      await db.$transaction(async () => 'cb', options as never);
      expect(calls[0]!.length).toBe(2);
      expect(calls[0]![1]).toBe(options); // forwarded as the same object, nothing dropped
      const batch = [Promise.resolve(1)];
      await db.$transaction(batch as never);
      expect(calls[1]).toEqual([batch]); // the array overload is not wrapped
    } finally { injector.restore(); }
    expect(injector.state).toEqual({ transactions: 2, fired: 0 });
  });

  it('accumulates priced hops, ignores an unpriced hop and preserves spend when the run fails (#2506)', async () => {
    const f = await fixture();
    const run = await f.run();
    f.llm.mockResolvedValueOnce({ text: 'one', tokensIn: 1000, tokensOut: 500, provider: 'test', model: 'test' })
      .mockResolvedValueOnce({ text: 'two', tokensIn: 2000, tokensOut: 1000, provider: 'test', model: 'test' })
      .mockResolvedValueOnce({ text: 'three', tokensIn: 10, tokensOut: 20, provider: 'unpriced', model: 'unpriced' });
    const costs: Array<bigint | null> = [];
    f.deps.selectNext = async () => {
      costs.push((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents);
      if (costs.length === 3) throw new Error('routing fails after the third hop was metered');
      return { targetUrn: f.schedule.entryNodeUrn, edgeName: 'next', edgeId: generateId() };
    };
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect(f.llm).toHaveBeenCalledTimes(3);
    // Units: micro-cents per MTok, input 300,000,000 and output 1,500,000,000. Hop 1 =
    // (1000 x 300,000,000 + 500 x 1,500,000,000) / 1,000,000 = 1,050,000; hop 2 (2000 in, 1000 out)
    // costs 2,100,000, so the running total is 3,150,000; the unpriced hop adds nothing (3,150,000).
    // The expectations are literals on purpose: the oracle must not be the production pricing helper.
    expect(costs).toEqual([1_050_000n, 3_150_000n, 3_150_000n]);
    const row = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('FAILED');
    expect(row.costMicroCents).toBe(3_150_000n);
    expect(row.tokensSpent).toBe(4530);
    const events = await db.usageEvent.findMany({ where: { appId: f.app.id, type: 'app-run' } });
    expect(events).toHaveLength(3);
    expect(events.find((event) => event.model === 'unpriced')?.costMicroCents).toBeNull();
    expect(events.reduce((sum, event) => sum + (event.costMicroCents ?? 0n), 0n)).toBe(row.costMicroCents);
  });

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
