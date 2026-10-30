import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RegisterLookup } from '../actionRegister/lookup.js';
import { renderTickText } from './tickActions.js';
import * as effectiveMemory from '../effectiveSystemMemory.js';
import { acknowledgeWakes } from './acknowledge.js';
import * as memoryGate from '../../mcp/access-control.js';
import { db } from '../../integrations/db/client.js';
import { tickFixture2733, tickNow2733, tickTaskLoc2733 } from '../../test/tickRegister2733.js';
import { computeDueWakes } from './dueWakes.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
let f: Awaited<ReturnType<typeof tickFixture2733>>;
beforeEach(async () => { f = await tickFixture2733(); });
afterEach(() => vi.restoreAllMocks());
const due = () => computeDueWakes({
  ctx: f.context(), app: f.app, reader: { manager: true, userId: f.admin.id },
  requester: { userId: f.admin.id }, now: tickNow2733,
});
const action = (out: Awaited<ReturnType<typeof due>>, id: string) =>
  (out.wakes.find(w => w.workerId === id)!.wake.reasons.find(r => r.kind === 'TICK') as any)?.action;

it('resolves one register entry through each woken role chain, never the reader chain', async () => {
  await f.entry('tick.shared');
  await f.node(f.base.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const a = await f.worker('Alpha');
  const b = await f.worker('Beta', f.roleB.id);
  const t = await f.ticker('Shared');
  for (const w of [a, b]) await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  const out = await due();
  expect(out.wakes).toHaveLength(2);
  expect(action(out, a.id)).toEqual({ code: 'tick.shared', state: 'MAPPED', taskLoc: tickTaskLoc2733, taskUrn: 'hrn:node:' + f.roleA.memory.urn + ':' + tickTaskLoc2733 });
  expect(action(out, b.id)).toEqual({ code: 'tick.shared', state: 'MAPPED', taskLoc: tickTaskLoc2733, taskUrn: 'hrn:node:' + f.base.memory.urn + ':' + tickTaskLoc2733 });
});

it('stores the issued answer even when the next read has the same wake identity', async () => {
  const entry = await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha');
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  const first = await due();
  expect(action(first, w.id)?.taskLoc).toBe(tickTaskLoc2733);
  await db.node.update({ where: { id: entry.id }, data: { data: { registerEntry: { code: 'tick.shared', taskLoc: 'tasks:changed' } } } });
  const again = await due();
  expect(again.wakes[0].proof).toBe(first.wakes[0].proof);
  expect(action(again, w.id)).toEqual(action(first, w.id));
  const stored = await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: w.id } });
  expect((stored.wake as any).reasons.find((r: any) => r.kind === 'TICK').action.taskLoc).toBe(tickTaskLoc2733);
});

async function subscribed() {
  const w = await f.worker('Alpha');
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  return { w, t };
}

it.each(['absent', 'wrong-code', 'empty', 'long', 'deleted', 'zero-team', 'two-team'])('delivers UNMAPPED for %s without a loc or URN', async mode => {
  if (mode === 'wrong-code') await f.entry('tick.shared', tickTaskLoc2733, f.team.systemMemoryId, 'other');
  if (mode === 'empty') await f.entry('tick.shared', '');
  if (mode === 'long') await f.entry('tick.shared', 'x'.repeat(513));
  if (mode === 'deleted') { const e = await f.entry('tick.shared'); await db.node.update({ where: { id: e.id }, data: { deletedAt: new Date() } }); }
  if (mode === 'zero-team') await db.node.deleteMany({ where: { memoryId: f.team.systemMemoryId, loc: 'roles' } });
  if (mode === 'two-team') await f.node(f.roleB.systemMemoryId, 'roles');
  const { w } = await subscribed();
  const out = await due();
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'UNMAPPED' });
  expect(out.wakes[0].tickText).toBe('tick Shared: no task is mapped for tick.shared');
  expect(out.wakes[0].proof).toBeTruthy();
});

it.each(['absent', 'not-runnable', 'deleted'])('carries the loc for an unresolved %s task', async mode => {
  await f.entry('tick.shared');
  if (mode !== 'absent') await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: mode === 'deleted', ...(mode === 'deleted' ? { deletedAt: new Date() } : {}) });
  const { w } = await subscribed();
  const out = await due();
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'UNRESOLVED', taskLoc: tickTaskLoc2733 });
  expect(out.wakes[0].tickText).toBe('tick Shared: no task found at tasks:on-tick for tick.shared');
});

it('never falls through an unreadable nearest role task to a readable base', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await f.node(f.base.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.roleA.id } } });
  const { w } = await subscribed();
  const out = await due();
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'UNRESOLVED', taskLoc: tickTaskLoc2733 });
  expect(JSON.stringify(out)).not.toContain('hrn:node:' + f.base.memory.urn);
});

it('re-gates stored mapped answers for a manager who cannot read the task', async () => {
  // The holder keeps its independent org grant when the App install is removed; only the reader loses access.
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.member.id, role: 'ADMIN' } });
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  const { w } = await subscribed();
  const first = await due();
  expect(action(first, w.id)?.state).toBe('MAPPED');
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.roleA.id } } });
  const out = await computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(JSON.stringify(out)).not.toContain(tickTaskLoc2733);
  expect(JSON.stringify(out)).not.toContain(f.roleA.memory.urn);
});

it('R1=C hides whether an unreadable Team Agent base contains an entry', async () => {
  await db.agent.update({ where: { id: f.team.id }, data: { extendsAgentId: f.base.id } });
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.base.id } } });
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.member.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  const { w } = await subscribed();
  const read = () => computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  const absent = await read();
  expect(action(absent, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  await db.appWakeReservation.deleteMany({ where: { appId: f.app.id } });
  await f.entry('tick.shared', tickTaskLoc2733, f.base.systemMemoryId);
  const present = await read();
  const withoutProof = (o: typeof absent) => JSON.stringify(o.wakes.map(({ proof, ...rest }) => rest));
  expect(withoutProof(present)).toBe(withoutProof(absent));
});

it('treats pre-annotation reservations as WITHHELD and never resolves them on rehand', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  await due();
  const saved = await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: w.id } });
  const wake = saved.wake as any;
  wake.reasons.forEach((r: any) => { delete r.action; });
  await db.appWakeReservation.update({ where: { workerId: w.id }, data: { wake } });
  const spy = vi.spyOn(RegisterLookup.prototype, 'entry');
  expect(action(await due(), w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(spy).not.toHaveBeenCalled();
});

it('fails open to code-only guidance when register lookup throws', async () => {
  const { w } = await subscribed();
  vi.spyOn(RegisterLookup.prototype, 'entry').mockRejectedValue(new Error('injected lookup failure'));
  const out = await due();
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(out.wakes[0].proof).toBeTruthy();
  expect(out.wakes[0].tickText).toBe('tick Shared: resolve your task for tick.shared yourself');
});

it('formats in ticker-name order, deduplicates tasks and flattens control characters', () => {
  const taskUrn = 'hrn:node:example.org:role:tasks:on-tick';
  const wake = { reasons: [
    { kind: 'TICK' as const, tickerId: 'b', k: 1, action: { code: 'tick.b', state: 'MAPPED' as const, taskUrn } },
    { kind: 'TICK' as const, tickerId: 'a', k: 1, action: { code: 'tick.a', state: 'MAPPED' as const, taskUrn } },
  ], channels: [], unread: 0, unreadMentions: 0, exempt: false };
  expect(renderTickText(wake, new Map([['b', { name: 'b\ntick' }], ['a', { name: 'a-tick' }]]))).toBe('tick a-tick: run ' + taskUrn + ' · tick b tick: same task as above');
  expect(renderTickText({ ...wake, reasons: [{ kind: 'MENTION' }] }, new Map())).toBeNull();
});

it('refreshes all tick answers when a new tick joins without spending a second slot', async () => {
  const entry = await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await f.node(f.roleA.systemMemoryId, 'tasks:changed', { isRunnable: true });
  const { w } = await subscribed();
  const first = await due();
  await db.node.update({ where: { id: entry.id }, data: { data: { registerEntry: { code: 'tick.shared', taskLoc: 'tasks:changed' } } } });
  const next = await f.ticker('Next');
  await f.entry('tick.next', 'tasks:changed');
  await db.tickerSubscription.create({ data: { tickerId: next.id, workerId: w.id } });
  const second = await due();
  expect(action(second, w.id)?.taskLoc).toBe('tasks:changed');
  expect(second.wakes[0].proof).not.toBe(first.wakes[0].proof);
  expect(await db.appWakeReservation.count({ where: { appId: f.app.id } })).toBe(1);
  const ack = await acknowledgeWakes({ ctx: f.context(), requester: { userId: f.admin.id }, proofs: [first.wakes[0].proof], mayReadWorker: async () => true, now: tickNow2733 });
  expect(ack.acknowledged).toBe(1);
  expect((await db.workerDeliveryTick.findMany({ where: { workerId: w.id } })).map(r => r.tickerId)).not.toContain(next.id);
  const after = await computeDueWakes({ ctx: f.context(), app: f.app, reader: { manager: true, userId: f.admin.id }, requester: { userId: f.admin.id }, now: new Date(tickNow2733.getTime() + f.app.tickerMinCadenceSeconds * 1000) });
  expect(after.wakes[0].wake.reasons.filter(r => r.kind === 'TICK').map(r => r.tickerId)).toContain(next.id);
});

it('keeps proofs and due-worker sets identical across absent, mapped and repointed entries', async () => {
  const { w } = await subscribed();
  const absent = await due();
  await db.appWakeReservation.deleteMany({ where: { appId: f.app.id } });
  const e = await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const mapped = await due();
  await db.appWakeReservation.deleteMany({ where: { appId: f.app.id } });
  await db.node.update({ where: { id: e.id }, data: { data: { registerEntry: { code: 'tick.shared', taskLoc: 'tasks:missing' } } } });
  const changed = await due();
  expect(mapped.wakes.map(w => [w.workerId, w.proof])).toEqual(absent.wakes.map(w => [w.workerId, w.proof]));
  expect(changed.wakes.map(w => [w.workerId, w.proof])).toEqual(absent.wakes.map(w => [w.workerId, w.proof]));
  expect(action(mapped, w.id)?.state).toBe('MAPPED');
  const ack = await acknowledgeWakes({ ctx: f.context(), requester: { userId: f.admin.id }, proofs: [changed.wakes[0].proof], mayReadWorker: async () => true, now: tickNow2733 });
  expect(ack).toEqual({ acknowledged: 1, unchanged: 0 });
  expect(await db.workerDeliveryTick.count({ where: { workerId: w.id } })).toBe(1);
  expect(await db.channelReadState.count({ where: { workerId: w.id } })).toBe(0);
});

it('memoizes twenty same-role workers down to one entry traversal and one task lookup', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const t = await f.ticker('Shared');
  for (let i = 0; i < 20; i++) {
    const w = await f.worker('Worker' + i);
    await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  }
  const entry = vi.spyOn(RegisterLookup.prototype as any, 'readEntry');
  const task = vi.spyOn(effectiveMemory, 'findEffectiveNodeIdByLoc');
  const out = await due();
  expect(out.wakes).toHaveLength(20);
  expect(out.wakes.every(w => (w.wake.reasons.find(r => r.kind === 'TICK') as any).action.state === 'MAPPED')).toBe(true);
  // One effective-loc traversal is the task step; register traversal is memory-scoped in RegisterLookup.
  expect(task).toHaveBeenCalledTimes(1);
  expect(entry).toHaveBeenCalledTimes(1);
  entry.mockRestore();
});

it('does not disclose locs after the holder leaves the App', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  expect(action(await due(), w.id)?.state).toBe('MAPPED');
  await db.appMember.delete({ where: { appId_userId: { appId: f.app.id, userId: f.member.id } } });
  expect(action(await due(), w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
});

it('lets the reader alone decide an unheld worker, including a later reader on the stored answer', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.roleA.id } } });
  const w = await f.worker('Alpha', f.roleA.id, null);
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  const first = await computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  expect(action(first, w.id)?.state).toBe('WITHHELD');
  expect(action(await due(), w.id)?.state).toBe('MAPPED');
});

it('does not erase the issued answer when a later reader gate fails transiently', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  const first = await due();
  const failure = vi.spyOn(RegisterLookup.prototype, 'teamMemory').mockRejectedValueOnce(new Error('reader failure'));
  expect(action(await due(), w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  failure.mockRestore();
  expect(action(await due(), w.id)).toEqual(action(first, w.id));
});

it('bounds a slow lookup with the real PostgreSQL statement timeout and keeps the wake', async () => {
  const { w } = await subscribed();
  vi.spyOn(RegisterLookup.prototype, 'entry').mockImplementation(async function(this: RegisterLookup) {
    await this.tx.$queryRawUnsafe('SELECT 1 AS ok FROM pg_sleep(0.4)');
    return { state: 'UNMAPPED', checkedMemoryIds: [] };
  });
  const out = await due();
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(out.wakes[0].proof).toBeTruthy();
  const stored = await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: w.id } });
  expect((stored.wake as any).reasons[0].action.state).toBe('UNKNOWN');
});

it('never consults another tenant register or this App install memory', async () => {
  const otherOrg = await db.organization.create({ data: { name: 'Other tenant', urn: 'other-' + f.org.urn } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: f.admin.id, role: 'ADMIN' } });
  const otherTeam = await f.agent('Other Team', otherOrg.id);
  const otherApp = await db.app.create({ data: { organizationId: otherOrg.id, name: 'Other App', urn: otherOrg.urn + ':team' } });
  await db.appAgent.create({ data: { appId: otherApp.id, agentId: otherTeam.id } });
  await f.node(otherTeam.systemMemoryId, 'roles');
  await f.entry('tick.shared', 'tasks:other-tenant', otherTeam.systemMemoryId);
  const install = await db.memory.create({ data: { name: 'Install memory', urn: f.org.urn + ':install', organizationId: f.org.id, class: 'system', appId: f.app.id, isInstallMemory: true, installOfAgentId: f.team.id } });
  await f.entry('tick.shared', 'tasks:install-only', install.id);
  const { w } = await subscribed();
  const out = await due();
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'UNMAPPED' });
  expect(JSON.stringify(out)).not.toContain('tasks:other-tenant');
  expect(JSON.stringify(out)).not.toContain('tasks:install-only');
});

it('withholds an unresolved loc when the current reader cannot read the entry', async () => {
  await f.entry('tick.shared');
  const { w } = await subscribed();
  expect(action(await due(), w.id)).toEqual({ code: 'tick.shared', state: 'UNRESOLVED', taskLoc: tickTaskLoc2733 });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  const original = memoryGate.canReadMemory;
  vi.spyOn(memoryGate, 'canReadMemory').mockImplementation((client, auth, id, opts) => auth.userId === f.outside.id && id === f.team.systemMemoryId ? Promise.resolve(false) : original(client, auth, id, opts));
  const out = await computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(JSON.stringify(out)).not.toContain(tickTaskLoc2733);
});

it.each([['held', 'mapped'], ['unheld', 'mapped'], ['held', 'unresolved'], ['unheld', 'unresolved']])('full-chain pin12b withholds behind an empty unreadable nearer memory (%s %s)', async (held, state) => {
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.member.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  await f.entry('tick.shared');
  if (state === 'mapped') await f.node(f.base.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.roleA.id } } });
  const w = await f.worker('Alpha', f.roleA.id, held === 'held' ? f.member.id : null);
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  const out = await computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(JSON.stringify(out)).not.toContain(tickTaskLoc2733);
  expect(JSON.stringify(out)).not.toContain(f.base.memory.urn);
});

it.each(['team-tail', 'worker-tail', 'unresolved-nearer'])('full-chain disclosure gates %s even without a node in that memory', async mode => {
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.member.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  await f.entry('tick.shared');
  if (mode !== 'unresolved-nearer') await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  if (mode === 'team-tail') await db.agent.update({ where: { id: f.team.id }, data: { extendsAgentId: f.roleB.id } });
  const hidden = mode === 'team-tail' ? f.roleB : mode === 'unresolved-nearer' ? f.roleA : f.base;
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: hidden.id } } });
  const { w } = await subscribed();
  const out = await computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(JSON.stringify(out)).not.toContain(tickTaskLoc2733);
});

it('full-chain rehand checks stored empty chain memories without changing the issued answer or proof', async () => {
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.member.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  const read = () => computeDueWakes({ ctx: f.context(f.outside.id), app: f.app, reader: { manager: true, userId: f.outside.id }, requester: { userId: f.outside.id }, now: tickNow2733 });
  const first = await read();
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.base.id } } });
  const out = await read();
  expect(out.wakes[0].proof).toBe(first.wakes[0].proof);
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(action(await due(), w.id)).toEqual(action(first, w.id));
});

it.each(['entry', 'task'])('rehand withholds when only the holder loses %s access', async lost => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  const first = await due();
  expect(action(first, w.id)?.state).toBe('MAPPED');
  const agent = lost === 'entry' ? f.team : f.roleA;
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: agent.id } } });
  expect(await memoryGate.canReadMemory(db, f.context(), agent.systemMemoryId)).toBe(true);
  expect(await memoryGate.canReadMemory(db, f.context(f.member.id), agent.systemMemoryId)).toBe(false);
  const out = await due();
  expect(out.wakes[0].proof).toBe(first.wakes[0].proof);
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
  expect(action(await due(), w.id)).toEqual(action(first, w.id));
});

it('refuses a departed holder even when another App independently grants every memory read', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  expect(action(await due(), w.id)?.state).toBe('MAPPED');
  const other = await db.app.create({ data: { organizationId: f.org.id, name: 'Independent read', urn: f.org.urn + ':independent-read' } });
  await db.appMember.create({ data: { appId: other.id, userId: f.member.id, role: 'member' } });
  for (const agent of [f.team, f.base, f.roleA]) await db.appAgent.create({ data: { appId: other.id, agentId: agent.id } });
  await db.appMember.delete({ where: { appId_userId: { appId: f.app.id, userId: f.member.id } } });
  for (const agent of [f.team, f.base, f.roleA]) expect(await memoryGate.canReadMemory(db, f.context(f.member.id), agent.systemMemoryId)).toBe(true);
  expect(action(await due(), w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
});

it('does not revive an entry that was in a deleted memory when an unheld wake was issued', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha', f.roleA.id, null);
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  await db.memory.update({ where: { id: f.team.systemMemoryId }, data: { deletedAt: new Date() } });
  const first = await due();
  expect(action(first, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  await db.memory.update({ where: { id: f.team.systemMemoryId }, data: { deletedAt: null } });
  const out = await due();
  expect(out.wakes[0].proof).toBe(first.wakes[0].proof);
  expect(action(out, w.id)).toEqual({ code: 'tick.shared', state: 'UNMAPPED' });
});

it('keeps fresh same-identity wake metadata while carrying only issued tick answers', async () => {
  const entry = await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  const first = await due();
  const saved = await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: w.id } });
  await db.appWakeReservation.update({ where: { workerId: w.id }, data: { wake: { ...(saved.wake as any), unread: 99, unreadMentions: 98, exempt: true, anchorAtMs: 1 } } });
  await db.node.update({ where: { id: entry.id }, data: { data: { registerEntry: { code: 'tick.shared', taskLoc: 'tasks:changed' } } } });
  const again = await due();
  expect(again.wakes[0].proof).toBe(first.wakes[0].proof);
  expect(again.wakes[0].wake).toMatchObject({ unread: 0, unreadMentions: 0, exempt: false, anchorAtMs: first.wakes[0].wake.anchorAtMs });
  expect(action(again, w.id)).toEqual(action(first, w.id));
});

it('keeps the issued tick answer when only a task reason joins', async () => {
  const entry = await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await f.node(f.roleA.systemMemoryId, 'tasks:changed', { isRunnable: true });
  const { w } = await subscribed();
  const first = await due();
  await db.node.update({ where: { id: entry.id }, data: { data: { registerEntry: { code: 'tick.shared', taskLoc: 'tasks:changed' } } } });
  const owner = await f.worker('Owner');
  const at = new Date(tickNow2733.getTime() - 1000);
  const task = await db.agentTask.create({ data: { appId: f.app.id, title: 'Joined task', ownerWorkerId: owner.id, assigneeWorkerId: w.id, assignedAt: at } });
  await db.agentTeamEvent.create({ data: { appId: f.app.id, taskId: task.id, type: 'task.assigned', subjectWorkerId: w.id, actorUserId: f.admin.id, createdAt: at } });
  const joined = await due();
  expect(joined.wakes.find(x => x.workerId === w.id)!.wake.reasons.some(r => r.kind === 'TASK')).toBe(true);
  expect(action(joined, w.id)).toEqual(action(first, w.id));
});

it('does not fall through a malformed nearer entry to a valid farther mapping', async () => {
  await db.agent.update({ where: { id: f.team.id }, data: { extendsAgentId: f.base.id } });
  await f.entry('tick.shared', '', f.team.systemMemoryId);
  await f.entry('tick.shared', tickTaskLoc2733, f.base.systemMemoryId);
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { w } = await subscribed();
  expect(action(await due(), w.id)).toEqual({ code: 'tick.shared', state: 'UNMAPPED' });
});

it('projects only public actions in preview, and returns no action when the budget withholds a wake', async () => {
  const { w } = await subscribed();
  vi.spyOn(RegisterLookup.prototype, 'entry').mockRejectedValue(new Error('injected lookup failure'));
  const preview = await computeDueWakes({ ctx: f.context(), app: f.app, reader: { manager: true, userId: f.admin.id }, requester: { userId: f.admin.id }, now: tickNow2733, preview: true });
  expect(action(preview, w.id)).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  expect(JSON.stringify(preview)).not.toMatch(/UNKNOWN|entryMemoryIds|taskMemoryId|disclosureMemoryIds/);
  expect(await db.appWakeReservation.count({ where: { appId: f.app.id } })).toBe(0);
  await db.app.update({ where: { id: f.app.id }, data: { wakeDailyBudget: 0 } });
  const exhausted = await due();
  expect(exhausted.withheld).toBe(1);
  expect(exhausted.wakes).toEqual([]);
});

it('re-hands both issued tick actions, proof and reservation unchanged, when the fresh wake has a different identity (#2851)', async () => {
  // cor:agt:080:23: a re-handed wake carries what it carried when issued; cor:agt:080:12: acknowledgement covers what the issued form named.
  const sharedEntry = await f.entry('tick.shared');
  await f.entry('tick.next', 'tasks:second');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await f.node(f.roleA.systemMemoryId, 'tasks:second', { isRunnable: true });
  await f.node(f.roleA.systemMemoryId, 'tasks:changed', { isRunnable: true });
  const { w, t: shared } = await subscribed();
  const next = await f.ticker('Next');
  const nextSub = await db.tickerSubscription.create({ data: { tickerId: next.id, workerId: w.id } });
  const first = await due();
  const issued = first.wakes[0].wake.reasons.filter(r => r.kind === 'TICK') as any[];
  expect(issued.map(r => [r.tickerId, r.action.state, r.action.taskLoc]).sort()).toEqual([
    [shared.id, 'MAPPED', tickTaskLoc2733], [next.id, 'MAPPED', 'tasks:second'],
  ].sort());
  const stored = await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: w.id } });

  // The fresh wake now has one reason, so its identity differs from the stored one; the register entry also moves.
  await db.tickerSubscription.delete({ where: { id: nextSub.id } });
  await db.node.update({ where: { id: sharedEntry.id }, data: { data: { registerEntry: { code: 'tick.shared', taskLoc: 'tasks:changed' } } } });
  const again = await due();

  expect(again.wakes).toHaveLength(1);
  expect(again.wakes[0].proof).toBe(first.wakes[0].proof);
  expect(again.wakes[0].wake.reasons.filter(r => r.kind === 'TICK')).toEqual(issued);
  const after = await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: w.id } });
  expect(after.id).toBe(stored.id);
  expect(after.wake).toEqual(stored.wake);
  expect(await db.appWakeReservation.count({ where: { appId: f.app.id } })).toBe(1);

  const ack = await acknowledgeWakes({ ctx: f.context(), requester: { userId: f.admin.id }, proofs: [again.wakes[0].proof], mayReadWorker: async () => true, now: tickNow2733 });
  expect(ack.acknowledged).toBe(1);
  expect((await db.workerDeliveryTick.findMany({ where: { workerId: w.id } })).map(r => r.tickerId).sort()).toEqual([shared.id, next.id].sort());
});
