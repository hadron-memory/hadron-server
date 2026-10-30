import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { tickFixture2733, tickNow2733, tickTaskLoc2733 } from '../../test/tickRegister2733.js';
import { computeDueWakes } from './dueWakes.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
let f: Awaited<ReturnType<typeof tickFixture2733>>;
beforeEach(async () => { f = await tickFixture2733(); });
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
