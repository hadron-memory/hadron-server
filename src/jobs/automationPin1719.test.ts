/** #1719 R5b: a changed automation must fail before any execution. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { automationPinQueries, automationPinMutations } from '../api/graphql/schema/resolvers.automationPin.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { mintAppRun, executeAppRun } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });
async function fixture() {
  const user = await db.user.create({ data: { handle: 'pin-owner' } });
  const org = await db.organization.create({ data: { name: 'Pin', urn: 'pin.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Pin', urn: 'pin.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'pin.test:flow', class: 'knowledge', organizationId: org.id } });
  const entry = await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  const next = await db.node.create({ data: { memoryId: memory.id, loc: 'next', name: 'Next', isRunnable: true, content: 'approved next' } });
  const dependency = await db.node.create({ data: { memoryId: memory.id, loc: 'doc', name: 'Dependency', content: 'approved doc' } });
  const edge = await db.edge.create({ data: { memoryId: memory.id, sourceId: entry.id, targetId: next.id, name: 'next', loc: 'entry:next:next' } });
  await db.edge.create({ data: { memoryId: memory.id, sourceId: next.id, targetId: dependency.id, name: 'documents', loc: 'next:documents:doc' } });
  const ctx = { db, userId: user.id, roles: [] };
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name: 'Pinned', cron: '* * * * *', entryNodeUrn: 'hrn:node:pin.test:flow:entry', runAsSelf: true } }, ctx);
  const run = () => mintAppRun(db, { appId: app.id, organizationId: org.id, userId: user.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn });
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test' }));
  const writeOutput = vi.fn(async () => null);
  const deps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: {} }) as never), llm, writeOutput };
  return { user, org, app, memory, entry, next, dependency, edge, ctx, schedule, run, deps, llm, writeOutput };
}
describe('R5b setup consent', () => {
  it.each(['entry', 'next', 'dependency'] as const)('fails before executing after %s content is altered', async key => {
    const f = await fixture();
    await db.node.update({ where: { id: f[key].id }, data: { content: 'unapproved' } });
    const run = await f.run();
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect(f.llm).not.toHaveBeenCalled();
    expect(f.writeOutput).not.toHaveBeenCalled();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED', message: expect.stringMatching(/re-adopt/) });
  });
  it('fails before executing after a routing condition changes', async () => {
    const f = await fixture();
    await db.edge.update({ where: { id: f.edge.id }, data: { condition: { '==': [1, 1] } } });
    const run = await f.run();
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect(f.llm).not.toHaveBeenCalled();
  });
  it('fails loudly for a legacy unpinned trigger, never adopting it at mint', async () => {
    const f = await fixture();
    const legacy = await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Legacy', cron: '* * * * *', entryNodeUrn: f.schedule.entryNodeUrn } });
    const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: 'SCHEDULE', triggerId: legacy.id, entryNodeUrn: legacy.entryNodeUrn });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect(f.llm).not.toHaveBeenCalled();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_UNADOPTED', message: expect.stringMatching(/re-adopt/) });
  });
});


async function adopt(f: Awaited<ReturnType<typeof fixture>>, triggerKind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL' = 'SCHEDULE', triggerRef = f.schedule.id) {
  const input = { triggerKind, triggerRef };
  const pin = await automationPinQueries.previewAutomation({}, input, f.ctx);
  await automationPinMutations.reAdoptAutomation({}, { ...input, expectedHash: pin.hash }, f.ctx);
  return pin;
}

it('executes an unchanged adopted graph', async () => {
  const f = await fixture(); const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
  expect(f.llm).toHaveBeenCalledTimes(2);
});
it('re-adoption applies to future runs and poll events, never changing an already minted run', async () => {
  const f = await fixture(); const origin = await f.run();
  await db.node.update({ where: { id: f.dependency.id }, data: { content: 'new reviewed dependency' } });
  const pin = await adopt(f);
  expect(await executeAppRun(db, origin.id, f.deps)).toBe('failed');
  const next = await f.run();
  expect(await executeAppRun(db, next.id, f.deps)).toBe('completed');
  const poll = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: 'INTEGRATION', parentRunId: origin.id, entryNodeUrn: f.schedule.entryNodeUrn });
  expect(poll.automationPin).toEqual(pin);
  expect(await executeAppRun(db, poll.id, f.deps)).toBe('completed');
});
it('a child outside the setup graph is refused, while a pinned child is admitted', async () => {
  const f = await fixture(); const parent = await f.run();
  const outside = await db.node.create({ data: { memoryId: f.memory.id, loc: 'outside', name: 'Outside', isRunnable: true, content: 'unapproved child' } });
  for (const [loc, outcome] of [['outside', 'failed'], ['next', 'completed']] as const) {
    const child = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: 'SPAWN', parentRunId: parent.id, entryNodeUrn: `hrn:node:pin.test:flow:${loc}` });
    f.llm.mockClear();
    expect(await executeAppRun(db, child.id, f.deps)).toBe(outcome);
    if (outcome === 'failed') {
      expect(f.llm).not.toHaveBeenCalled();
      expect((await db.appRun.findUniqueOrThrow({ where: { id: child.id } })).failure).toMatchObject({ message: expect.stringMatching(/outside the adopted graph/) });
    }
  }
  expect(await db.node.findUnique({ where: { id: outside.id } })).toEqual(outside);
});
it('only the run-as user may re-adopt, and a stale preview never grants consent', async () => {
  const f = await fixture(); const input = { triggerKind: 'SCHEDULE' as const, triggerRef: f.schedule.id };
  const pin = await automationPinQueries.previewAutomation({}, input, f.ctx);
  const other = await db.user.create({ data: { handle: 'pin-other', roles: ['ADMIN'] } });
  for (const ctx of [ { db, userId: other.id, roles: ['ADMIN'] },
    { ...f.ctx, clientId: 'run:forged' }, { ...f.ctx, impersonation: { orgId: f.org.id } } ]) {
    await expect(automationPinMutations.reAdoptAutomation({}, { ...input, expectedHash: pin.hash }, ctx as never)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  }
  await db.node.update({ where: { id: f.entry.id }, data: { content: 'changed during review' } });
  await expect(automationPinMutations.reAdoptAutomation({}, { ...input, expectedHash: pin.hash }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'AUTOMATION_CHANGED' } });
  expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: f.schedule.id } })).automationPin).toEqual(pin);
});
it.each(['WEBHOOK', 'MANUAL'] as const)('generic re-adoption also binds %s triggers; event input cannot replace the pin', async triggerKind => {
  const f = await fixture();
  const row = triggerKind === 'WEBHOOK'
    ? await db.agentWebhook.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Hook', secret: generateId(), entryNodeUrn: f.schedule.entryNodeUrn } })
    : await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind, entryNodeUrn: f.schedule.entryNodeUrn });
  const adopted = await adopt(f, triggerKind, row.id);
  await db.node.update({ where: { id: f.entry.id }, data: { content: 'swapped flow' } });
  const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id,
    triggerKind: triggerKind === 'MANUAL' ? 'INTEGRATION' : triggerKind, triggerId: row.id,
    parentRunId: triggerKind === 'MANUAL' ? row.id : undefined, entryNodeUrn: f.schedule.entryNodeUrn,
    eventData: { automationPin: adopted, grants: ['everything'] } });
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  if (triggerKind === 'MANUAL') {
    const reAdopted = await adopt(f, triggerKind, row.id);
    expect(reAdopted.hash).not.toBe(adopted.hash);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: row.id } })).automationPin).toEqual(adopted);
    expect((await db.manualAutomationPin.findUniqueOrThrow({ where: { runId: row.id } })).pin).toEqual(reAdopted);
  }
});
it.each(['delete-node', 'add-edge', 'delete-edge', 'template-data', 'partial', 'revision'] as const)('detects %s drift before any step', async alteration => {
  const f = await fixture();
  if (alteration === 'template-data' || alteration === 'partial') {
    await db.node.update({ where: { id: f.entry.id }, data: { content: alteration === 'partial' ? '{{> partial}}' : '{{field}}' } });
    await adopt(f);
    await db.node.create({ data: { memoryId: f.memory.id, loc: alteration === 'partial' ? 'partial' : 'data', name: 'New dependency', content: 'new partial', data: { field: 'injected' } } });
  } else if (alteration === 'delete-node') await db.node.update({ where: { id: f.dependency.id }, data: { deletedAt: new Date() } });
  else if (alteration === 'delete-edge') await db.edge.update({ where: { id: f.edge.id }, data: { deletedAt: new Date() } });
  else if (alteration === 'revision') await db.node.update({ where: { id: f.entry.id }, data: { revSeq: { increment: 1 } } });
  else await db.edge.create({ data: { memoryId: f.memory.id, sourceId: f.entry.id, targetId: f.dependency.id, name: 'documents', loc: 'entry:documents:doc' } });
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
});
it('checks drift again after assembly, before the LLM sees the changed instructions', async () => {
  const f = await fixture(); const run = await f.run();
  const realAssemble = f.deps.assemble;
  f.deps.assemble = async (...args) => {
    await db.node.update({ where: { id: f.entry.id }, data: { content: 'changed after initial validation' } });
    return realAssemble(...args);
  };
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect(f.writeOutput).not.toHaveBeenCalled();
});


it.each(['App', 'user'] as const)('a deleted %s cannot re-adopt a trigger', async anchor => {
  const f = await fixture(); const input = { triggerKind: 'SCHEDULE' as const, triggerRef: f.schedule.id };
  const pin = await automationPinQueries.previewAutomation({}, input, f.ctx);
  if (anchor === 'App') await db.app.update({ where: { id: f.app.id }, data: { deletedAt: new Date() } });
  else await db.user.update({ where: { id: f.user.id }, data: { deletedAt: new Date() } });
  await expect(automationPinMutations.reAdoptAutomation({}, { ...input, expectedHash: pin.hash }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
});

it('a tombstoned dependency edge cannot inline an unpinned target after re-adoption', async () => {
  const f = await fixture();
  await db.edge.updateMany({ where: { sourceId: f.next.id, targetId: f.dependency.id }, data: { deletedAt: new Date() } });
  await adopt(f);
  await db.node.update({ where: { id: f.dependency.id }, data: { content: 'UNPINNED TOMBSTONE PAYLOAD' } });
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
  expect(f.llm).toHaveBeenCalledTimes(2);
  for (const call of f.llm.mock.calls) expect(JSON.stringify(call)).not.toContain('UNPINNED TOMBSTONE PAYLOAD');
});

it('the graph edge bound also applies when the last node has only tombstoned edges', async () => {
  const f = await fixture();
  await db.edge.updateMany({ where: { sourceId: f.entry.id }, data: { deletedAt: new Date() } });
  await db.edge.createMany({ data: Array.from({ length: 1001 }, (_, index) => ({
    memoryId: f.memory.id, sourceId: f.entry.id, targetId: f.next.id,
    name: 'documents', loc: `entry:history-${index}:next`, deletedAt: new Date(),
  })) });
  await expect(automationPinQueries.previewAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.schedule.id }, f.ctx)).rejects.toThrow('1000 edges');
});
