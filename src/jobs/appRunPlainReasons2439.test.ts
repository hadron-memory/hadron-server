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
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('injected counter failure') as never);
    const outcome = await executeAppRun(db, run.id, f.deps);
    spy.mockRestore();
    expect(outcome).not.toBe('failed');
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
    const transaction = db.$transaction.bind(db);
    const fault = new Error('fault after event insert and counter update');
    let insertedId: string | undefined;
    let observedCost: bigint | null | undefined;
    const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => transaction(async (tx) => callback(new Proxy(tx, { get(target, property) {
      if (property !== 'appRun') return Reflect.get(target, property, target);
      return new Proxy(tx.appRun, { get(model, member) {
        if (member !== 'updateMany') return Reflect.get(model, member, model);
        return async (...args: Parameters<typeof tx.appRun.updateMany>) => {
          await tx.appRun.updateMany(...args);
          insertedId = (await tx.usageEvent.findFirstOrThrow({ where: { appId: f.app.id, type: 'app-run' } })).id;
          observedCost = (await tx.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents;
          throw fault;
        };
      } });
    } })))) as never);
    let recorded: Awaited<ReturnType<typeof recordLlmUsage>>;
    try {
      recorded = await recordLlmUsage(db, {
        type: 'app-run', appId: f.app.id, appRunId: run.id,
        provider: 'test', model: 'test', tokensIn: 1000, tokensOut: 500,
      });
    } finally { spy.mockRestore(); }
    expect(insertedId).toBeDefined();
    expect(observedCost).toBe(1_050_000n); // both writes really ran inside the transaction
    expect(await db.usageEvent.findUnique({ where: { id: insertedId! } })).toBeNull();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).costMicroCents).toBe(0n);
    expect(recorded).toBeNull(); // metering stays fail-open
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
