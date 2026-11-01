/**
 * #3048 (follow-up to #2950/#3024): tick-register enrichment answers each
 * principal's memory readability in ONE batched read per enrichment call,
 * instead of one `canReadMemory` round per chain memory, without sharing any
 * answer across principals (hrn:node:hadronmemory.com:specs:cor:agt:110:03,
 * hrn:node:hadronmemory.com:specs:cor:agt:080:23).
 *
 * Readability ops are counted with the same `$extends` counter as
 * tickRegisterOps2950.test.ts, scoped to the shared gate: an operation counts
 * when it runs inside `canReadMemory` or `filterReadableMemoryIds` of
 * src/mcp/access-control.ts (an AsyncLocalStorage scope set by the wrappers
 * below). The cost of ONE holder is the difference between the same call with
 * two holders and with one. Every measured call must come back fully MAPPED,
 * so a deadline-truncated count fails instead of passing as cheap.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { tickFixture2733 } from '../../test/tickRegister2733.js';
import { enrichTickWakes } from './tickActions.js';
import type { WorkerWake } from './wakeRule.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const gate = vi.hoisted(() => ({ scope: null as AsyncLocalStorage<true> | null }));
vi.mock('../../mcp/access-control.js', async importOriginal => {
  const { AsyncLocalStorage: Als } = await import('node:async_hooks');
  const real = await importOriginal<typeof import('../../mcp/access-control.js')>();
  const scope = new Als<true>();
  gate.scope = scope;
  return {
    ...real,
    canReadMemory: (...a: Parameters<typeof real.canReadMemory>) => scope.run(true, () => real.canReadMemory(...a)),
    filterReadableMemoryIds: (...a: Parameters<typeof real.filterReadableMemoryIds>) => scope.run(true, () => real.filterReadableMemoryIds(...a)),
  };
});

let f: Awaited<ReturnType<typeof tickFixture2733>>;
let nextGithubId = 304_800;
beforeEach(async () => { f = await tickFixture2733(); });
afterEach(() => vi.restoreAllMocks());

let gateOps = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const counted: any = (db as any).$extends({ query: {
  $allModels: { async $allOperations({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { if (gate.scope?.getStore()) gateOps += 1; return query(args); } },
  async $queryRaw({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { if (gate.scope?.getStore()) gateOps += 1; return query(args); },
  async $executeRawUnsafe({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { if (gate.scope?.getStore()) gateOps += 1; return query(args); },
} });

type Shape = { codes: number; holders: number; depth: number };

/**
 * The #3024 op-count fixture: a Team Agent and a role Agent each extended to
 * `depth` links, every code's entry in the FARTHEST team link and its task in
 * the FARTHEST role link, `holders` workers each held by its own App member.
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
    const t = await f.ticker('Rd ' + label + ' ' + i);
    tickers.push({ id: t.id, name: t.name, tickCode: (await db.ticker.findUniqueOrThrow({ where: { id: t.id } })).tickCode });
  }
  await db.node.createMany({ data: tickers.flatMap((t, i) => [
    { memoryId: farTeam, loc: 'register:' + t.tickCode, name: 'r' + i, content: '# e', data: { registerEntry: { code: t.tickCode, taskLoc: 'tasks:rd-' + label + '-' + i } } },
    { memoryId: farRole, loc: 'tasks:rd-' + label + '-' + i, name: 't' + i, content: '# task', isRunnable: true },
  ]) });
  const workers: string[] = [];
  for (let i = 0; i < shape.holders; i++) {
    const u = await db.user.create({ data: { githubId: nextGithubId++, githubUsername: 'rd-' + label + '-h' + i, roles: ['READER'] } });
    await db.appMember.create({ data: { appId: f.app.id, userId: u.id, role: 'member' } });
    workers.push((await f.worker('Rd' + label + 'w' + i, f.roleA.id, u.id)).id);
  }
  const items = workers.map(workerId => ({ workerId, wake: {
    reasons: tickers.map(t => ({ kind: 'TICK' as const, tickerId: t.id, k: 1 })), channels: [], unread: 0, unreadMentions: 0, exempt: false,
  } as unknown as WorkerWake }));
  return { items, known: new Map(tickers.map(t => [t.id, { name: t.name, tickCode: t.tickCode }])) };
}

/** Readability (gate) operations for ONE enrichment call at `shape`; fails if any answer is not MAPPED. */
async function gateOpsFor(shape: Shape): Promise<number> {
  f = await tickFixture2733();
  const { items, known } = await build(shape, `${shape.codes}-${shape.holders}-${shape.depth}`);
  gateOps = 0;
  const out = await enrichTickWakes({ ...f.context(), db: counted }, { id: f.app.id, organizationId: f.org.id, ownerUserId: null },
    items, new Set(items.map(i => i.workerId)), known);
  const states = [...out.values()].flatMap(r => r.stored.reasons.map(x => (x as { action?: { state?: string } }).action?.state));
  expect(states).toHaveLength(shape.codes * shape.holders);
  expect(new Set(states)).toEqual(new Set(['MAPPED']));
  return gateOps;
}

/** Readability operations ONE extra holder adds at `depth` (codes fixed: readability does not depend on them). */
async function perHolder(depth: number): Promise<number> {
  return (await gateOpsFor({ codes: 3, holders: 2, depth })) - (await gateOpsFor({ codes: 3, holders: 1, depth }));
}

it('a holder\'s readability costs at most 12 operations, at depth 1 and at depth 4', async () => {
  const shallow = await perHolder(1);
  const deep = await perHolder(4);
  // On main each holder pays one canReadMemory round (about 25 operations) per chain memory, so the cost grows
  // with depth. Batched: one read per holder per call, whatever the depth (the gate's ceiling, #3048 amendment 1).
  const measured = `per holder: depth 1 = ${shallow}, depth 4 = ${deep}`;
  expect(shallow, measured).toBeGreaterThan(0); // the scope counts something: a silent counter can't pass
  expect(shallow, measured).toBeLessThanOrEqual(12);
  expect(deep, measured).toBeLessThanOrEqual(12);
  expect(deep, measured).toBeLessThanOrEqual(shallow + 1);
}, 180_000);
