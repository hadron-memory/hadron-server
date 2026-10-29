/** #1719 R5b: a changed automation must fail before any execution. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { automationPinQueries, automationPinMutations } from '../api/graphql/schema/resolvers.automationPin.js';
import { appRunMutations } from '../api/graphql/schema/resolvers.appRun.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { materializeMcpRunTools } from '../lib/runner/tools/mcpTools.js';
import { materializeHaRunTools } from '../lib/runner/tools/haTools.js';
import { ToolExecutionError } from '../lib/llm/index.js';
import { storedAutomationPin } from '../lib/automation/pins.js';
import { makeProdRunDeps } from './appRunDeps.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
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
  // #2712: a run needs an installed Agent with a served boot prompt (R74).
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'pin.test:runner', name: 'runner' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const ctx = { db, userId: user.id, roles: [] };
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name: 'Pinned', cron: '* * * * *', entryNodeUrn: 'hrn:node:pin.test:flow:entry', runAsSelf: true, agentRef: agent.id } }, ctx);
  const run = () => mintAppRun(db, { appId: app.id, organizationId: org.id, userId: user.id, agentId: agent.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn });
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test' }));
  const writeOutput = vi.fn(async () => null);
  const deps: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: {} }) as never), llm, writeOutput };
  return { user, org, app, agent, memory, entry, next, dependency, edge, ctx, schedule, run, deps, llm, writeOutput };
}
describe('R5b setup consent', () => {
  it.each(['entry', 'next'] as const)('fails before executing after %s content is altered', async key => {
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
    const legacy = await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, agentId: f.agent.id, userId: f.user.id, name: 'Legacy', cron: '* * * * *', entryNodeUrn: f.schedule.entryNodeUrn } });
    const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind: 'SCHEDULE', triggerId: legacy.id, entryNodeUrn: legacy.entryNodeUrn });
    expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
    expect(f.llm).not.toHaveBeenCalled();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_UNADOPTED', message: expect.stringMatching(/re-adopt/) });
  });
});


async function adopt(f: Awaited<ReturnType<typeof fixture>>, triggerKind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL' = 'SCHEDULE', triggerRef = f.schedule.id) {
  const input = { triggerKind, triggerRef };
  const pin = await automationPinQueries.previewAutomation({}, input, f.ctx);
  await automationPinMutations.reAdoptAutomation({}, { ...input, expectedHash: pin.hash }, f.ctx);
  return storedAutomationPin(pin);
}

it('executes an unchanged adopted graph', async () => {
  const f = await fixture(); const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
  expect(f.llm).toHaveBeenCalledTimes(2);
});
it('re-adoption applies to future runs and poll events, never changing an already minted run', async () => {
  const f = await fixture(); const origin = await f.run();
  await db.node.update({ where: { id: f.next.id }, data: { content: 'new reviewed instructions' } });
  const pin = await adopt(f);
  expect(await executeAppRun(db, origin.id, f.deps)).toBe('failed');
  const next = await f.run();
  expect(await executeAppRun(db, next.id, f.deps)).toBe('completed');
  const poll = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind: 'INTEGRATION', parentRunId: origin.id, entryNodeUrn: f.schedule.entryNodeUrn });
  expect(poll.automationPin).toEqual(storedAutomationPin(pin));
  expect(await executeAppRun(db, poll.id, f.deps)).toBe('completed');
});
it('a child outside the setup graph is refused, while a pinned child is admitted', async () => {
  const f = await fixture(); const parent = await f.run();
  const outside = await db.node.create({ data: { memoryId: f.memory.id, loc: 'outside', name: 'Outside', isRunnable: true, content: 'unapproved child' } });
  for (const [loc, outcome] of [['outside', 'failed'], ['next', 'completed']] as const) {
    const child = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind: 'SPAWN', parentRunId: parent.id, entryNodeUrn: `hrn:node:pin.test:flow:${loc}` });
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
  expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: f.schedule.id } })).automationPin).toEqual(storedAutomationPin(pin));
});
it.each(['WEBHOOK', 'MANUAL'] as const)('generic re-adoption also binds %s triggers; event input cannot replace the pin', async triggerKind => {
  const f = await fixture();
  const row = triggerKind === 'WEBHOOK'
    ? await db.agentWebhook.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, agentId: f.agent.id, userId: f.user.id, name: 'Hook', secret: generateId(), entryNodeUrn: f.schedule.entryNodeUrn } })
    : await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind, entryNodeUrn: f.schedule.entryNodeUrn });
  const adopted = await adopt(f, triggerKind, row.id);
  await db.node.update({ where: { id: f.entry.id }, data: { content: 'swapped flow' } });
  const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id,
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
it.each(['delete-node', 'add-edge', 'delete-edge', 'revision'] as const)('detects %s drift before any step', async alteration => {
  const f = await fixture();
  if (alteration === 'delete-node') await db.node.update({ where: { id: f.next.id }, data: { deletedAt: new Date() } });
  else if (alteration === 'delete-edge') await db.edge.update({ where: { id: f.edge.id }, data: { deletedAt: new Date() } });
  // #2438 (v4): a bare revSeq bump over identical bytes is NOT drift — an
  // address move bumps it too, and the approved bytes are what executes. The
  // drift case pairs the bump with an authored change, as a real edit does.
  else if (alteration === 'revision') await db.node.update({ where: { id: f.entry.id }, data: { revSeq: { increment: 1 }, abstract: 'revised' } });
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
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
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

it.each(['personal-orgless', 'public-cross-org'] as const)('pins an admitted %s dependency without changing routing tenant bounds', async kind => {
  const f = await fixture();
  const elsewhere = await db.organization.create({ data: { name: 'Docs', urn: 'docs.test' } });
  const memory = await db.memory.create({ data: kind === 'personal-orgless'
    ? { name: 'Personal doc', urn: 'pin-owner:doc', class: 'personal', userId: f.user.id, ownerUserId: f.user.id }
    : { name: 'Public doc', urn: 'docs.test:doc', class: 'knowledge', organizationId: elsewhere.id, visibility: 'PUBLIC' } });
  await db.node.update({ where: { id: f.dependency.id }, data: { memoryId: memory.id } });
  await adopt(f);
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
  expect(JSON.stringify(f.llm.mock.calls)).toContain('approved doc');
});

// Review regressions: pins carry consent hashes, never memory plaintext.
it('setup and re-adoption persist no authored bytes on triggers, manual consent or runs', async () => {
  const f = await fixture();
  const preview = await automationPinQueries.previewAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.schedule.id }, f.ctx);
  await adopt(f);
  expect(JSON.stringify(preview)).toContain('approved next');
  const manual = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind: 'MANUAL', entryNodeUrn: f.schedule.entryNodeUrn });
  const run = await f.run();
  const schedule = await db.agentSchedule.findUniqueOrThrow({ where: { id: f.schedule.id } });
  const consent = await db.manualAutomationPin.findUniqueOrThrow({ where: { runId: manual.id } });
  for (const pin of [schedule.automationPin, run.automationPin, manual.automationPin, consent.pin]) {
    expect(JSON.stringify(pin)).not.toContain('approved doc');
    // v3 stored nodes are {urn,hash}; v4 (#2438) are bare digests — either
    // way, nothing but addresses and hashes persists.
    if ((pin as any).format === 'hadron-automation-pin-v3')
      expect(Object.values((pin as any).nodes).every((node: any) => Object.keys(node).sort().join() === 'hash,urn')).toBe(true);
    else
      expect(Object.values((pin as any).nodes).every((node: any) => typeof node === 'string')).toBe(true);
  }
});
it('setup refuses a routed definition the creator cannot read before copying any bytes', async () => {
  const f = await fixture();
  const other = await db.user.create({ data: { handle: 'hidden-owner' } });
  const memory = await db.memory.create({ data: { name: 'Hidden', urn: 'hidden-owner:secret', class: 'personal', userId: other.id, ownerUserId: other.id } });
  await db.node.update({ where: { id: f.next.id }, data: { memoryId: memory.id, content: 'SECRET-NOT-COPIED' } });
  const row = await appRunMutations.createAgentSchedule({}, { input: { appRef: f.app.id, name: 'Unreadable', cron: '* * * * *', entryNodeUrn: f.schedule.entryNodeUrn, runAsSelf: true } }, f.ctx);
  expect(row.automationPin).toMatchObject({ format: 'hadron-automation-unadopted-v1' });
  expect(JSON.stringify(row.automationPin)).not.toContain('SECRET-NOT-COPIED');
  await expect(adopt(f)).rejects.toBeDefined();
});
it('drift messages expose counts rather than dependency locs or IDs to run readers', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.next.id }, data: { content: 'changed' } });
  const run = await f.run();
  await executeAppRun(db, run.id, f.deps);
  const row = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
  const message = JSON.stringify(row.failure);
  expect(message).not.toContain('pin.test:flow:next');
  expect(message).not.toContain(f.next.id);
  expect(message).toContain('1 node');
});
it.each(['entry', 'runAsSelf'] as const)('an authorized owner %s edit re-captures consent in its transaction', async field => {
  const f = await fixture();
  if (field === 'runAsSelf') await db.memory.update({ where: { id: f.memory.id }, data: { class: 'app', appId: f.app.id } });
  const row = await appRunMutations.updateAgentSchedule({}, { id: f.schedule.id, input: field === 'entry' ? { entryNodeUrn: 'hrn:node:pin.test:flow:next' } : { runAsSelf: false } }, f.ctx);
  // #2438: v4 keys the consent by the stable entry id (stamped with the
  // re-capture) instead of the literal URN.
  expect((row.automationPin as any).entryId).toBe(row.entryNodeId);
  expect((row.automationPin as any).userId).toBe(row.userId);
  const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: row.userId ?? undefined, triggerKind: 'SCHEDULE', triggerId: row.id, entryNodeUrn: row.entryNodeUrn });
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
});

it('tool-loop wrapping preserves AUTOMATION_CHANGED and refuses the effect', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { data: { tools: ['hadron_log'] } } });
  await adopt(f);
  const run = await f.run();
  const effect = vi.fn();
  f.deps.llmTools = async (_run, _resolved, _request, _tools, opts) => {
    await db.node.update({ where: { id: f.next.id }, data: { content: 'tool-time edit' } });
    try { await opts.onToolCall('tool.hadron_log', 0); }
    catch (cause) { throw new ToolExecutionError('hadron_log', 'gate failed', { cause }); }
    effect();
    throw new Error('unreachable');
  };
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(effect).not.toHaveBeenCalled();
  expect(f.writeOutput).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
});
it('walks the whole graph once per hop and uses revision proofs before effects', async () => {
  const f = await fixture(); const run = await f.run();
  const full = vi.spyOn(f.deps, 'verifyAutomation');
  const cheap = vi.spyOn(f.deps, 'checkAutomationEffect');
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
  expect(full).toHaveBeenCalledTimes(2);
  expect(cheap.mock.calls.length).toBeGreaterThan(2);
});
it.each(['edge', 'memory'] as const)('cheap effect checks detect %s drift after assembly', async kind => {
  const f = await fixture();
  const run = await f.run(); const assemble = f.deps.assemble;
  f.deps.assemble = async (...args) => {
    const text = await assemble(...args);
    if (kind === 'edge') await db.edge.update({ where: { id: f.edge.id }, data: { name: 'documents' } });
    else if (kind === 'memory') await db.memory.update({ where: { id: f.memory.id }, data: { isEncrypted: true } });
    return text;
  };
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect(f.writeOutput).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
});

it('document contents, self-written logs and template data are mutable data outside consent', async () => {
  const f = await fixture();
  const original = (await db.agentSchedule.findUniqueOrThrow({ where: { id: f.schedule.id } })).automationPin;
  await db.node.update({ where: { id: f.dependency.id }, data: { content: 'run-written log data', revSeq: { increment: 1 } } });
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
  expect(JSON.stringify(f.llm.mock.calls)).toContain('run-written log data');
  expect((original as any).nodes).not.toHaveProperty(f.dependency.id);
});
it.each(['provider', 'endpoint', 'model', 'replacement'] as const)('AI %s identity drift fails before execution; adoption rebinds it', async change => {
  const f = await fixture();
  const config = await db.aiServiceConfig.create({ data: { appId: f.app.id, name: 'default', provider: 'openai', model: 'before', endpoint: 'https://before.example/v1' } });
  await adopt(f);
  if (change === 'replacement') {
    await db.aiServiceConfig.delete({ where: { id: config.id } });
    await db.aiServiceConfig.create({ data: { appId: f.app.id, name: 'default', provider: 'openai', model: 'before', endpoint: 'https://before.example/v1' } });
  } else await db.aiServiceConfig.update({ where: { id: config.id }, data: { [change]: change === 'endpoint' ? 'https://after.example/v1' : 'after' } });
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
  await adopt(f);
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
});
it.each(['mcp', 'ha'] as const)('%s URL and allowed-operation identity drift refuses execution', async kind => {
  const f = await fixture();
  const name = kind === 'mcp' ? 'mcp__pin__echo' : 'ha__pin__list_states';
  const registry = kind === 'mcp'
    ? await db.mcpServer.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://before.example/mcp', toolAllowlist: ['echo'] } })
    : await db.homeAssistantInstance.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://before.example/ha', tokenEncrypted: 'TOKEN-NOT-PINNED', opAllowlist: ['list_states'] } });
  await db.node.update({ where: { id: f.entry.id }, data: { data: { tools: [name] } } });
  await adopt(f);
  if (kind === 'mcp') await db.mcpServer.update({ where: { id: registry.id }, data: { url: 'https://after.example/mcp' } });
  else await db.homeAssistantInstance.update({ where: { id: registry.id }, data: { opAllowlist: ['call_service'] } });
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
});

it.each(['template-data'] as const)('%s creation and edits stay mutable data', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{field}}' } });
  await adopt(f);
  const node = await db.node.create({ data: { memoryId: f.memory.id, loc: 'data', name: 'Data', content: 'first partial', data: { field: 'first field' } } });
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
  await db.node.update({ where: { id: node.id }, data: { content: 'second partial', data: { field: 'second field' } } });
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
  expect(JSON.stringify(f.llm.mock.calls)).toContain('second field');
});
it('real output writes to a document in the prompt do not invalidate later unattended runs', async () => {
  const f = await fixture();
  await db.memory.update({ where: { id: f.memory.id }, data: { class: 'app', appId: f.app.id } });
  await db.node.update({ where: { id: f.entry.id }, data: { data: { output: { writeTo: 'hrn:node:pin.test:flow:doc', mode: 'append' } } } });
  await adopt(f);
  f.deps.writeOutput = makeProdRunDeps(db).writeOutput;
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
  expect((await db.node.findUniqueOrThrow({ where: { id: f.dependency.id } })).content).toContain('ok');
});

it('checks the actual resolved AI identity even if the registry changes back before the next gate', async () => {
  const f = await fixture();
  const config = await db.aiServiceConfig.create({ data: { appId: f.app.id, name: 'default', provider: 'openai', model: 'before', endpoint: 'https://before.example/v1' } });
  await adopt(f);
  const resolve = makeProdRunDeps(db).resolveConfig;
  f.deps.resolveConfig = async run => {
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { endpoint: 'https://rogue.example/v1' } });
    try { return await resolve(run); }
    finally { await db.aiServiceConfig.update({ where: { id: config.id }, data: { endpoint: config.endpoint } }); }
  };
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
});
it.each(['mcp', 'ha'] as const)('checks the loaded %s identity before materializing or contacting its endpoint', async kind => {
  const f = await fixture();
  const name = kind === 'mcp' ? 'mcp__pin__echo' : 'ha__pin__list_states';
  const row = kind === 'mcp'
    ? await db.mcpServer.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://before.example/mcp', toolAllowlist: ['echo'] } })
    : await db.homeAssistantInstance.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://before.example/ha', tokenEncrypted: 'NEVER-DECRYPT-ME', opAllowlist: ['list_states'] } });
  await db.node.update({ where: { id: f.entry.id }, data: { data: { tools: [name] } } });
  await adopt(f); const run = await f.run();
  if (kind === 'mcp') await db.mcpServer.update({ where: { id: row.id }, data: { url: 'https://rogue.example/mcp' } });
  else await db.homeAssistantInstance.update({ where: { id: row.id }, data: { url: 'https://rogue.example/ha' } });
  await expect(kind === 'mcp' ? materializeMcpRunTools(db, run, [name]) : materializeHaRunTools(db, run, [name])).rejects.toMatchObject({ code: 'AUTOMATION_CHANGED' });
});

it('credential rotations neither drift consent nor put secrets in the pin or preview', async () => {
  const f = await fixture();
  const ai = await db.aiServiceConfig.create({ data: { appId: f.app.id, name: 'default', provider: 'openai', model: 'stable', apiKeyEncrypted: 'AI-SECRET-ORIGINAL' } });
  const mcp = await db.mcpServer.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://stable.example/mcp', headersEncrypted: 'MCP-SECRET-ORIGINAL', toolAllowlist: ['echo'] } });
  const ha = await db.homeAssistantInstance.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://stable.example/ha', tokenEncrypted: 'HA-SECRET-ORIGINAL', opAllowlist: ['list_states'] } });
  await db.node.update({ where: { id: f.entry.id }, data: { data: { tools: ['mcp__pin__echo', 'ha__pin__list_states'] } } });
  const pin = await adopt(f);
  for (const value of [pin, await automationPinQueries.previewAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.schedule.id }, f.ctx)]) expect(JSON.stringify(value)).not.toContain('SECRET-ORIGINAL');
  await db.aiServiceConfig.update({ where: { id: ai.id }, data: { apiKeyEncrypted: 'AI-SECRET-ROTATED' } });
  await db.mcpServer.update({ where: { id: mcp.id }, data: { headersEncrypted: 'MCP-SECRET-ROTATED' } });
  await db.homeAssistantInstance.update({ where: { id: ha.id }, data: { tokenEncrypted: 'HA-SECRET-ROTATED' } });
  f.deps.llmTools = async (_run, _config, _request, _tools, opts) => {
    expect(await opts.onToolCall('tool.mcp__pin__echo', 1)).toBe(true);
    return { text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test', toolCalls: [] };
  };
  const after = await automationPinQueries.previewAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.schedule.id }, f.ctx);
  expect(after.hash).toBe(pin.hash);
  expect(JSON.stringify(after)).not.toContain('SECRET-ROTATED');
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
});
it.each(['mcp', 'ha'] as const)('each %s registration binds both its URL and its allowed operations', async kind => {
  const f = await fixture();
  const name = kind === 'mcp' ? 'mcp__pin__echo' : 'ha__pin__list_states';
  const row = kind === 'mcp'
    ? await db.mcpServer.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://before.example/mcp', toolAllowlist: ['echo'] } })
    : await db.homeAssistantInstance.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://before.example/ha', tokenEncrypted: 'NO-PIN-SECRET', opAllowlist: ['list_states'] } });
  await db.node.update({ where: { id: f.entry.id }, data: { data: { tools: [name] } } });
  await adopt(f);
  if (kind === 'mcp') await db.mcpServer.update({ where: { id: row.id }, data: { toolAllowlist: ['another'] } });
  else await db.homeAssistantInstance.update({ where: { id: row.id }, data: { url: 'https://after.example/ha' } });
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
  expect(f.llm).not.toHaveBeenCalled();
});
it('a declared named AI config is pinned at setup and payload overrides cannot switch it', async () => {
  const f = await fixture();
  await db.aiServiceConfig.create({ data: { appId: f.app.id, name: 'default', provider: 'openai', model: 'default' } });
  const custom = await db.aiServiceConfig.create({ data: { appId: f.app.id, name: 'custom', provider: 'openai', model: 'custom' } });
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: f.app.id, name: 'named', cron: '* * * * *', entryNodeUrn: f.schedule.entryNodeUrn, aiConfigName: 'custom', runAsSelf: true, agentRef: f.agent.id } }, f.ctx);
  expect((schedule.automationPin as any).resources.ai.id).toBe(custom.id);
  const input = { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind: 'SCHEDULE' as const, triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn };
  expect(await executeAppRun(db, (await mintAppRun(db, { ...input, eventData: { __aiConfigName: 'custom' } })).id, f.deps)).toBe('completed');
  const swapped = await mintAppRun(db, { ...input, eventData: { __aiConfigName: 'default' } });
  expect(await executeAppRun(db, swapped.id, f.deps)).toBe('failed');
});

it('registration drift while materializing a tool retains AUTOMATION_CHANGED in the run', async () => {
  const f = await fixture();
  const row = await db.mcpServer.create({ data: { organizationId: f.org.id, slug: 'pin', name: 'Pin', url: 'https://before.example/mcp', toolAllowlist: ['echo'] } });
  await db.node.update({ where: { id: f.entry.id }, data: { data: { tools: ['mcp__pin__echo'] } } });
  await adopt(f);
  f.deps.llmTools = async (run, _config, _request, names) => {
    await db.mcpServer.update({ where: { id: row.id }, data: { url: 'https://rogue.example/mcp' } });
    await materializeMcpRunTools(db, run, names);
    throw new Error('unreachable');
  };
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
});

it('private reference data is never copied into consent and its runtime read stays R5a-refused', async () => {
  const f = await fixture();
  const memory = await db.memory.create({ data: { name: 'Private data', urn: 'pin-owner:private', class: 'private', userId: f.user.id, ownerUserId: f.user.id } });
  await db.node.update({ where: { id: f.dependency.id }, data: { memoryId: memory.id, content: 'PRIVATE-DATA-NEVER-COPIED' } });
  await db.edge.create({ data: { memoryId: f.memory.id, sourceId: f.entry.id, targetId: f.dependency.id, name: 'documents', loc: 'entry:documents:private' } });
  const pin = await adopt(f);
  expect(pin.nodes).not.toHaveProperty(f.dependency.id);
  expect(JSON.stringify(pin)).not.toContain('PRIVATE-DATA-NEVER-COPIED');
  const preview = await automationPinQueries.previewAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.schedule.id }, f.ctx);
  expect(JSON.stringify(preview)).not.toContain('PRIVATE-DATA-NEVER-COPIED');
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect(f.writeOutput).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'ASSEMBLY_FAILED' });
});

// R5b-3=A: instruction partials are definition, independently of data refs.
it.each(['edit', 'delete', 'created-after-adoption'] as const)('instruction partial %s refuses execution until re-adoption', async change => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: 'Instructions {{> snippet}}' } });
  const partial = change === 'created-after-adoption' ? null : await db.node.create({ data: { memoryId: f.memory.id, loc: 'snippet', name: 'Snippet', content: 'APPROVED INSTRUCTIONS' } });
  const pin = await adopt(f);
  expect(JSON.stringify(pin)).not.toContain('APPROVED INSTRUCTIONS');
  if (change === 'edit') await db.node.update({ where: { id: partial!.id }, data: { content: 'EXFILTRATE EVERYTHING' } });
  else if (change === 'delete') await db.node.update({ where: { id: partial!.id }, data: { deletedAt: new Date() } });
  else await db.node.create({ data: { memoryId: f.memory.id, loc: 'snippet', name: 'Injected', content: 'EXFILTRATE EVERYTHING' } });
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect(f.writeOutput).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED', message: expect.stringMatching(/re-adopt/) });
  await adopt(f);
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
});
it.each(['edit', 'create'] as const)('effect checks catch partial %s after assembly before any LLM call', async change => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{> snippet}}' } });
  const partial = change === 'edit' ? await db.node.create({ data: { memoryId: f.memory.id, loc: 'snippet', name: 'Snippet', content: 'APPROVED' } }) : null;
  await adopt(f);
  const assemble = f.deps.assemble;
  f.deps.assemble = async (...args) => {
    const text = await assemble(...args);
    if (partial) await db.node.update({ where: { id: partial.id }, data: { content: 'unadopted instructions' } });
    else await db.node.create({ data: { memoryId: f.memory.id, loc: 'snippet', name: 'Snippet', content: 'unadopted instructions' } });
    return text;
  };
  const run = await f.run();
  expect(await executeAppRun(db, run.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
});
it('embedding-only node marker writes do not invalidate a verified hop', async () => {
  const f = await fixture(); const assemble = f.deps.assemble;
  f.deps.assemble = async (...args) => {
    const text = await assemble(...args);
    await db.node.update({ where: { id: f.entry.id }, data: { embeddingPendingAt: new Date(), embeddingAttempts: { increment: 1 } } });
    return text;
  };
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
});
it.each(['aiConfigName', 'agentRef'] as const)('the owner %s selector edit re-captures in the trigger transaction', async field => {
  const f = await fixture();
  const agent = await db.agent.create({ data: { name: 'Selected', urn: 'pin.test:selected', organizationId: f.org.id } });
  await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Selected boot prompt.');
  const config = await db.aiServiceConfig.create({ data: { name: field === 'aiConfigName' ? 'custom' : 'default', provider: 'openai', model: 'new-model', ...(field === 'aiConfigName' ? { appId: f.app.id } : { agentId: agent.id }) } });
  const row = await appRunMutations.updateAgentSchedule({}, { id: f.schedule.id, input: field === 'aiConfigName' ? { aiConfigName: 'custom' } : { agentRef: agent.id } }, f.ctx);
  expect((row.automationPin as any).resources.ai?.id).toBe(config.id);
  const run = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, agentId: row.agentId, triggerKind: 'SCHEDULE', triggerId: row.id, entryNodeUrn: row.entryNodeUrn,
    eventData: row.aiConfigName ? { __aiConfigName: row.aiConfigName } : {} });
  expect(await executeAppRun(db, run.id, f.deps)).toBe('completed');
});

it('nested partial definitions are pinned while dot-reference values remain mutable data', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{> outer}} {{> inner}} {{doc.field}}' } });
  await db.node.create({ data: { memoryId: f.memory.id, loc: 'outer', name: 'Outer', content: 'Outer {{> inner}}' } });
  const inner = await db.node.create({ data: { memoryId: f.memory.id, loc: 'inner', name: 'Inner', content: 'APPROVED NESTED' } });
  await db.node.update({ where: { id: f.dependency.id }, data: { data: { field: 'first value' } } });
  const pin = await adopt(f);
  expect(pin.nodes).toHaveProperty(inner.id);
  expect(pin.nodes).not.toHaveProperty(f.dependency.id);
  expect(JSON.stringify(pin)).not.toContain('APPROVED NESTED');
  await db.node.update({ where: { id: f.dependency.id }, data: { data: { field: 'second value' } } });
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
  expect(JSON.stringify(f.llm.mock.calls)).toContain('Outer APPROVED NESTED');
  expect(JSON.stringify(f.llm.mock.calls)).toContain('second value');
  f.llm.mockClear();
  await db.node.update({ where: { id: inner.id }, data: { content: 'UNADOPTED NESTED' } });
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
});
it('a missing partial is explicitly pinned absent and cyclic references terminate capture', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{> missing}} {{> loop}}' } });
  const loop = await db.node.create({ data: { memoryId: f.memory.id, loc: 'loop', name: 'Loop', content: '{{> loop}}' } });
  const pin = await adopt(f);
  expect(pin.nodes).toHaveProperty(loop.id);
  expect(pin.absentPartials).toEqual([{ urn: 'hrn:node:pin.test:flow:missing', memoryId: f.memory.id, loc: 'missing' }]);
});
it('a definition partial does not grant a spawned child permission to execute it as a flow', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{> snippet}}' } });
  const partial = await db.node.create({ data: { memoryId: f.memory.id, loc: 'snippet', name: 'Snippet', content: 'static instructions', isRunnable: true, data: { tools: ['mcp__unused__tool'] } } });
  const pin = await adopt(f);
  expect(pin.nodes).toHaveProperty(partial.id);
  expect(pin.flows).not.toContain(partial.id);
  expect(pin.resources.tools).not.toContain('mcp__unused__tool');
  const parent = await f.run();
  const child = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, agentId: f.agent.id, userId: f.user.id, triggerKind: 'SPAWN', parentRunId: parent.id, entryNodeUrn: 'hrn:node:pin.test:flow:snippet' });
  expect(await executeAppRun(db, child.id, f.deps)).toBe('failed');
  expect(f.llm).not.toHaveBeenCalled();
  expect((await db.appRun.findUniqueOrThrow({ where: { id: child.id } })).failure).toMatchObject({ code: 'AUTOMATION_CHANGED' });
});
it('a routed flow that is also a partial remains executable and is captured only once', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{> next}}' } });
  const pin = await adopt(f);
  expect(pin.flows).toContain(f.next.id);
  expect(Object.keys(pin.nodes).filter(id => id === f.next.id)).toHaveLength(1);
  expect(await executeAppRun(db, (await f.run()).id, f.deps)).toBe('completed');
});

// #2040: the shared include parser feeds the pin.
it('a loc tag with settings pins its target, and a tag in code pins nothing', async () => {
  const f = await fixture();
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{> snippet rev=2 approved}} `{{> literal}}`' } });
  const snippet = await db.node.create({ data: { memoryId: f.memory.id, loc: 'snippet', name: 'Snippet', content: 'S' } });
  const pin = await adopt(f);
  expect(pin.nodes).toHaveProperty(snippet.id);
  expect(pin.absentPartials).toEqual([]);
});
it('a URN tag pins a readable same-organization target and records an unreadable one as absent', async () => {
  const f = await fixture();
  const other = await db.memory.create({ data: { name: 'Other', urn: 'pin.test:other', class: 'knowledge', organizationId: f.org.id } });
  const shared = await db.node.create({ data: { memoryId: other.id, loc: 'shared', name: 'Shared', content: 'SHARED' } });
  const foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: 'foreign.test' } });
  const foreign = await db.memory.create({ data: { name: 'F', urn: 'foreign.test:f', class: 'knowledge', organizationId: foreignOrg.id } });
  await db.node.create({ data: { memoryId: foreign.id, loc: 'secret', name: 'Secret', content: 'SECRET' } });
  await db.node.update({ where: { id: f.entry.id }, data: { content: '{{> hrn:node:pin.test:other:shared}} {{> hrn:node:foreign.test:f:secret}}' } });
  const pin = await adopt(f);
  expect(pin.nodes).toHaveProperty(shared.id);
  expect(JSON.stringify(pin)).not.toContain('SECRET');
  expect(pin.absentPartials.map((p) => p.urn)).toEqual(['hrn:node:foreign.test:f:secret']);
});
