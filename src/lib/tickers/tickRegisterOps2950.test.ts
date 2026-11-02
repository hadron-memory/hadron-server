/**
 * #2950 (follow-up (a) of #2852): tick-register enrichment must stop multiplying
 * its database work by holders x codes x depth, without relaxing any disclosure
 * gate (hrn:node:hadronmemory.com:specs:cor:agt:080:23,
 * hrn:node:hadronmemory.com:specs:cor:agt:110:03).
 *
 * The op-count pins drive `enrichTickWakes` directly (as the #2852 benchmark
 * did) through a client that counts every Prisma model operation and raw query.
 * They compare the MARGINAL cost of extra codes: once enrichment shares its
 * principal-independent register reads, an extra code costs the same whether
 * one holder or several are woken, and whatever the chain depth. Every measured
 * call must come back fully MAPPED, so a deadline-truncated count can never
 * pass for a cheap one.
 *
 * The disclosure pins put two holders in ONE call: one may read the memory the
 * shared read came from, the other may not. Whichever is enriched first, the
 * second must still be refused (cor:agt:110:03: resolution never borrows
 * another principal's access).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { tickFixture2733, tickNow2733, tickTaskLoc2733 } from '../../test/tickRegister2733.js';
import { enrichTickWakes } from './tickActions.js';
import { inheritable, RegisterData, RegisterLookup } from '../actionRegister/lookup.js';
import { computeDueWakes } from './dueWakes.js';
import type { WorkerWake } from './wakeRule.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let f: Awaited<ReturnType<typeof tickFixture2733>>;
// Deterministic holder ids, distinct within this file and outside the fixture's 2733xx range.
let nextGithubId = 295_000;
beforeEach(async () => { f = await tickFixture2733(); });
afterEach(() => vi.restoreAllMocks());

// ---- op counting -----------------------------------------------------------

let ops = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const counted: any = (db as any).$extends({ query: {
  $allModels: { async $allOperations({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { ops += 1; return query(args); } },
  async $queryRaw({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { ops += 1; return query(args); },
  async $executeRawUnsafe({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { ops += 1; return query(args); },
} });

type Shape = { codes: number; holders: number; depth: number };

/**
 * One App, a Team Agent and a role Agent each extended to `depth` links; every
 * code has its entry in the FARTHEST team link and its task in the FARTHEST role
 * link (the worst case of #2852), and `holders` workers, each held by its own
 * App member, are subscribed to every code.
 */
async function build(shape: Shape, label: string) {
  const extra = [];
  for (let i = 1; i < shape.depth; i++) {
    const a = await f.agent('Ext ' + label + i);
    await db.appAgent.create({ data: { appId: f.app.id, agentId: a.id } });
    extra.push(a);
  }
  const relink = async (chain: Array<{ id: string }>) => {
    for (let i = 0; i < chain.length; i++) await db.agent.update({ where: { id: chain[i]!.id }, data: { extendsAgentId: chain[i + 1]?.id ?? null } });
  };
  await relink([f.team, ...extra]);
  await relink([f.roleA, ...extra]);
  const farTeam = [f.team, ...extra].at(-1)!.systemMemoryId;
  const farRole = [f.roleA, ...extra].at(-1)!.systemMemoryId;
  await db.app.update({ where: { id: f.app.id }, data: { tickerLiveCap: 100 } });
  const tickers: Array<{ id: string; name: string; tickCode: string }> = [];
  for (let i = 0; i < shape.codes; i++) {
    const t = await f.ticker('Ops ' + label + ' ' + i);
    tickers.push({ id: t.id, name: t.name, tickCode: (await db.ticker.findUniqueOrThrow({ where: { id: t.id } })).tickCode });
  }
  await db.node.createMany({ data: tickers.flatMap((t, i) => [
    { memoryId: farTeam, loc: 'register:' + t.tickCode, name: 'r' + i, content: '# e', data: { registerEntry: { code: t.tickCode, taskLoc: 'tasks:ops-' + label + '-' + i } } },
    { memoryId: farRole, loc: 'tasks:ops-' + label + '-' + i, name: 't' + i, content: '# task', isRunnable: true },
  ]) });
  const workers: string[] = [];
  for (let i = 0; i < shape.holders; i++) {
    const u = await db.user.create({ data: { githubId: nextGithubId++, githubUsername: 'ops-' + label + '-h' + i, roles: ['READER'] } });
    await db.appMember.create({ data: { appId: f.app.id, userId: u.id, role: 'member' } });
    workers.push((await f.worker('Ops' + label + 'w' + i, f.roleA.id, u.id)).id);
  }
  const items = workers.map(workerId => ({ workerId, wake: {
    reasons: tickers.map(t => ({ kind: 'TICK' as const, tickerId: t.id, k: 1 })), channels: [], unread: 0, unreadMentions: 0, exempt: false,
  } as unknown as WorkerWake }));
  return { items, known: new Map(tickers.map(t => [t.id, { name: t.name, tickCode: t.tickCode }])) };
}

/** Prisma operations for ONE enrichment call at `shape`; fails if any answer is not MAPPED. */
async function opsFor(shape: Shape): Promise<number> {
  f = await tickFixture2733();
  const { items, known } = await build(shape, `${shape.codes}-${shape.holders}-${shape.depth}`);
  ops = 0;
  const out = await enrichTickWakes({ ...f.context(), db: counted }, { id: f.app.id, organizationId: f.org.id, ownerUserId: null },
    items, new Set(items.map(i => i.workerId)), known);
  const states = [...out.values()].flatMap(r => r.stored.reasons.map(x => (x as { action?: { state?: string } }).action?.state));
  expect(states).toHaveLength(shape.codes * shape.holders);
  expect(new Set(states)).toEqual(new Set(['MAPPED']));
  return ops;
}

it('an extra code costs the same database work whatever the number of distinct holders', async () => {
  const one = (await opsFor({ codes: 12, holders: 1, depth: 1 })) - (await opsFor({ codes: 3, holders: 1, depth: 1 }));
  const three = (await opsFor({ codes: 12, holders: 3, depth: 1 })) - (await opsFor({ codes: 3, holders: 3, depth: 1 }));
  // On main each distinct holder repeats every code's entry and task reads, so
  // the marginal cost of 9 codes triples with three holders.
  expect(three).toBeLessThanOrEqual(one);
}, 120_000);

it('an extra code costs the same database work whatever the chain depth', async () => {
  const shallow = (await opsFor({ codes: 12, holders: 1, depth: 1 })) - (await opsFor({ codes: 3, holders: 1, depth: 1 }));
  const deep = (await opsFor({ codes: 12, holders: 1, depth: 3 })) - (await opsFor({ codes: 3, holders: 1, depth: 3 }));
  // On main the entry walk reads every chain link once per code.
  expect(deep).toBeLessThanOrEqual(shallow);
}, 120_000);

// ---- disclosure: one principal's shared read never authorizes another --------

const due = () => computeDueWakes({
  ctx: f.context(), app: f.app, reader: { manager: true, userId: f.admin.id },
  requester: { userId: f.admin.id }, now: tickNow2733,
});
type Out = Awaited<ReturnType<typeof due>>;
const tick = (out: Out, id: string) => out.wakes.find(w => w.workerId === id)!.wake.reasons.find(r => r.kind === 'TICK') as { action?: Record<string, unknown> };

/**
 * `member` (an org admin) may read every memory of the org; `outside` (App
 * owner only) may read only what the App installs. Due wakes are enriched in
 * worker-id order (dueWakes.ts, `orderBy: { id: 'asc' }`) and ids are UUIDv7,
 * so the worker created first is enriched first; the order is asserted.
 */
async function twoHolders(first: 'member' | 'outside') {
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.member.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
  const make = (who: 'member' | 'outside') => f.worker(who === 'member' ? 'Held by member' : 'Held by outside', f.roleA.id, who === 'member' ? f.member.id : f.outside.id);
  const earlier = await make(first);
  await new Promise(r => setTimeout(r, 5));
  const later = await make(first === 'member' ? 'outside' : 'member');
  expect(earlier.id < later.id).toBe(true);
  const [byMember, byOutside] = first === 'member' ? [earlier, later] : [later, earlier];
  const t = await f.ticker('Shared');
  for (const w of [byMember, byOutside]) await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  return { byMember, byOutside };
}

it.each(['member', 'outside'] as const)('an entry read for a holder who may read it is refused to one who may not (%s enriched first)', async first => {
  // The entry lives in the Team Agent's base, which the App does not install.
  await db.agent.update({ where: { id: f.team.id }, data: { extendsAgentId: f.base.id } });
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.base.id } } });
  await f.entry('tick.shared', tickTaskLoc2733, f.base.systemMemoryId);
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const { byMember, byOutside } = await twoHolders(first);
  const out = await due();
  expect(tick(out, byMember.id).action).toMatchObject({ code: 'tick.shared', state: 'MAPPED', taskLoc: tickTaskLoc2733 });
  expect(tick(out, byOutside.id).action).toEqual({ code: 'tick.shared', state: 'WITHHELD' });
  // The stored wakes, selected by their worker key: both must exist and carry the code, so the absence check below
  // inspects a real reservation (the member's carries the loc, proving the stored wake records it when allowed).
  const memberStored = JSON.stringify((await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: byMember.id } })).wake);
  const outsideStored = JSON.stringify((await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: byOutside.id } })).wake);
  expect(memberStored).toContain(tickTaskLoc2733);
  expect(outsideStored).toContain('tick.shared');
  expect(outsideStored).not.toContain(tickTaskLoc2733);
});

it.each(['member', 'outside'] as const)('a task read for a holder who may read it is refused to one who may not (%s enriched first)', async first => {
  // The entry is readable to both; the task lives in the role Agent, which the App does not install.
  await f.entry('tick.shared');
  const task = await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.roleA.id } } });
  const { byMember, byOutside } = await twoHolders(first);
  const out = await due();
  const urn = 'hrn:node:' + f.roleA.memory.urn + ':' + tickTaskLoc2733;
  expect(tick(out, byMember.id).action).toEqual({ code: 'tick.shared', state: 'MAPPED', taskLoc: tickTaskLoc2733, taskUrn: urn });
  // Worker-side unreadable nearest task: UNRESOLVED with the loc, never the URN, never a farther task.
  expect(tick(out, byOutside.id).action).toEqual({ code: 'tick.shared', state: 'UNRESOLVED', taskLoc: tickTaskLoc2733 });
  const memberStored = JSON.stringify((await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: byMember.id } })).wake);
  const outsideStored = JSON.stringify((await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: byOutside.id } })).wake);
  expect(memberStored).toContain(urn);
  expect(outsideStored).toContain(tickTaskLoc2733);
  expect(outsideStored).not.toContain(urn);
  expect(task.id).toBeTruthy();
});

// Rico's §10 pin: the task gate is on the memory the task was LOCATED in, not the one the walk started from. The task
// sits in the inherited Base (uninstalled); both holders can read roleA, only the member can read Base.
it.each(['member', 'outside'] as const)('a task located in an inherited base the holder cannot read is refused, though the start memory is readable (%s enriched first)', async first => {
  await f.entry('tick.shared');
  await f.node(f.base.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.base.id } } });
  const { byMember, byOutside } = await twoHolders(first);
  const out = await due();
  const urn = 'hrn:node:' + f.base.memory.urn + ':' + tickTaskLoc2733;
  expect(tick(out, byMember.id).action).toEqual({ code: 'tick.shared', state: 'MAPPED', taskLoc: tickTaskLoc2733, taskUrn: urn });
  expect(tick(out, byOutside.id).action).toEqual({ code: 'tick.shared', state: 'UNRESOLVED', taskLoc: tickTaskLoc2733 });
  const memberStored = JSON.stringify((await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: byMember.id } })).wake);
  const outsideStored = JSON.stringify((await db.appWakeReservation.findUniqueOrThrow({ where: { workerId: byOutside.id } })).wake);
  expect(memberStored).toContain(urn);
  expect(outsideStored).toContain(tickTaskLoc2733);
  expect(outsideStored).not.toContain(urn);
});

// ---- the inherited-link filter, now applied to the shared row -------------------

// A comment can't be a fixture here (the COMMENT_INVARIANT trigger: only the comment path creates one), so the
// comment half of the filter keeps the pre-#2950 SQL's behaviour without a pin of its own.
it.each([
  ['a boot prompt', { role: 'boot-prompt' }],
  ['a boot-prompt variant', { role: 'boot-prompt.lane' }],
] as const)('an inherited link never supplies %s as the register entry, while the Team Agent\'s own one counts', async (_label, shape) => {
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha');
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  const entry = (memoryId: string) => f.node(memoryId, 'register:tick.shared', { ...shape, data: { registerEntry: { code: 'tick.shared', taskLoc: tickTaskLoc2733 } } });
  // Inherited: the Team Agent extends Base, and only Base carries the entry.
  await db.agent.update({ where: { id: f.team.id }, data: { extendsAgentId: f.base.id } });
  const inherited = await entry(f.base.systemMemoryId);
  expect(tick(await due(), w.id).action).toEqual({ code: 'tick.shared', state: 'UNMAPPED' });
  // Own: the same row in the Team Agent's own memory is its entry.
  await db.node.delete({ where: { id: inherited.id } });
  await db.appWakeReservation.deleteMany({ where: { appId: f.app.id } });
  await entry(f.team.systemMemoryId);
  expect(tick(await due(), w.id).action).toMatchObject({ code: 'tick.shared', state: 'MAPPED', taskLoc: tickTaskLoc2733 });
});

// The comment half of the filter, on controlled rows (a comment can't be a fixture, above): only a non-comment row
// whose role is not a boot prompt is inherited through a chain link.
it.each([
  [{ nodeType: 'comment', role: null }, false],
  [{ nodeType: 'comment', role: 'boot-prompt' }, false],
  [{ nodeType: 'info', role: 'boot-prompt' }, false],
  [{ nodeType: 'info', role: 'boot-prompt.lane' }, false],
  [{ nodeType: 'info', role: null }, true],
  [{ nodeType: 'info', role: 'boot-prompter' }, true],
] as const)('inheritable(%o) is %s', (row, expected) => {
  expect(inheritable(row)).toBe(expected);
});

it('a lookup refuses shared rows that belong to another transaction', async () => {
  const data = new RegisterData(db as never);
  await db.$transaction(async tx => {
    expect(() => new RegisterLookup(tx, f.context(), f.app.id, Date.now() + 1000, false, undefined, data)).toThrow(/another transaction/);
    expect(new RegisterLookup(tx, f.context(), f.app.id, Date.now() + 1000, false, undefined, new RegisterData(tx)).data.tx).toBe(tx);
  });
});
