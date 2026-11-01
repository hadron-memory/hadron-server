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
import { RegisterData, RegisterLookup } from '../actionRegister/lookup.js';
import { canReadMemory } from '../../mcp/access-control.js';
import type { WorkerWake } from './wakeRule.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const gate = vi.hoisted(() => ({ scope: null as AsyncLocalStorage<true> | null, calls: 0 }));
vi.mock('../../mcp/access-control.js', async importOriginal => {
  const { AsyncLocalStorage: Als } = await import('node:async_hooks');
  const real = await importOriginal<typeof import('../../mcp/access-control.js')>();
  const scope = new Als<true>();
  gate.scope = scope;
  return {
    ...real,
    canReadMemory: (...a: Parameters<typeof real.canReadMemory>) => (gate.calls += 1, scope.run(true, () => real.canReadMemory(...a))),
    filterReadableMemoryIds: (...a: Parameters<typeof real.filterReadableMemoryIds>) => (gate.calls += 1, scope.run(true, () => real.filterReadableMemoryIds(...a))),
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

it('a holder\'s readability costs at most 28 operations, at depth 1 and at depth 4', async () => {
  const shallow = await perHolder(1);
  const deep = await perHolder(4);
  // On main each holder pays one canReadMemory round (about 28 operations) per chain memory: 112 at depth 1, 252 at
  // depth 4. Batched: one access map (getMemoryAccess, 27) plus one row read per holder per call, whatever the
  // depth (the gate's ceiling, amended by Xan at #3048 issuecomment-6552556376).
  const measured = `per holder: depth 1 = ${shallow}, depth 4 = ${deep}`;
  expect(shallow, measured).toBeGreaterThan(0); // the scope counts something: a silent counter can't pass
  expect(shallow, measured).toBeLessThanOrEqual(28);
  expect(deep, measured).toBeLessThanOrEqual(28);
  expect(deep, measured).toBeLessThanOrEqual(shallow + 1);
}, 180_000);

// ---- the batched answer equals the per-memory gate, for every row class ---------

/**
 * One memory of each row class the gate (#3048 amendment 1, item 2) names, and
 * principals of every relevant shape. For each principal the batched answer
 * (RegisterLookup.readable over a covered set, so `filterReadableMemoryIds`
 * once) must equal `canReadMemory` asked memory by memory. Equality alone can't
 * catch a change to `canReadMemoryRow` (both sides use it), so the rows whose
 * answer the spec fixes are also asserted outright: FR-016 (cor:acl:010:01)
 * keeps a personal memory its owner's, even for a platform ADMIN or OWNER.
 */
async function rowClasses() {
  const mem = (name: string, data: Record<string, unknown>) => db.memory.create({ data: { organizationId: f.org.id, urn: f.org.urn + ':' + name, name, ...data } as never });
  const user = (handle: string, roles: string[] = ['READER']) => db.user.create({ data: { githubId: nextGithubId++, githubUsername: 'rc-' + handle, roles: roles as never } });
  const owner = await user('owner');
  const revoked = await user('revoked');
  await db.orgMember.create({ data: { organizationId: f.org.id, userId: revoked.id, role: 'READER', deletedAt: new Date() } });
  const appMember = await user('app-member');
  await db.appMember.create({ data: { appId: f.app.id, userId: appMember.id, role: 'member' } });
  const platformAdmin = await user('platform-admin', ['ADMIN']);
  const platformOwner = await user('platform-owner', ['OWNER']);
  const stranger = await user('stranger');
  const otherApp = await db.app.create({ data: { organizationId: f.org.id, name: 'Other', urn: f.org.urn + ':other' } });
  const memories = {
    orgKnowledge: await mem('org-knowledge', { class: 'knowledge', visibility: 'ORGANIZATION' }),
    appScoped: await mem('app-scoped', { class: 'app', appId: f.app.id }),
    publicKnowledge: await mem('public', { class: 'knowledge', visibility: 'PUBLIC' }),
    freePersonal: await mem('free-personal', { class: 'personal', userId: owner.id }),
    encrypted: await mem('encrypted', { class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true }),
    agentSystem: f.roleA.memory,
    appPersonal: await mem('app-personal', { class: 'personal', userId: appMember.id, appId: f.app.id, userMemoryOfAgentId: f.roleA.id }),
    otherAppScoped: await mem('other-app', { class: 'app', appId: otherApp.id }),
  };
  const principals = {
    orgAdmin: f.admin.id, orgMemberViaApp: f.member.id, revoked: revoked.id, appMember: appMember.id,
    owner: owner.id, platformAdmin: platformAdmin.id, platformOwner: platformOwner.id, stranger: stranger.id, outside: f.outside.id,
  };
  const roles: Record<string, string[]> = { [platformAdmin.id]: ['ADMIN'], [platformOwner.id]: ['OWNER'] };
  return { memories, principals, roles };
}

it('the batched answer equals canReadMemory for every row class and principal, and FR-016 holds', async () => {
  const { memories, principals, roles } = await rowClasses();
  const ids = Object.values(memories).map(m => m.id);
  const table: Record<string, Record<string, boolean>> = {};
  let differ = 0;
  for (const [who, userId] of Object.entries(principals)) {
    table[who] = {};
    await db.$transaction(async tx => {
      const ctx = { db: tx, userId, roles: roles[userId] ?? ['READER'] } as never;
      const data = new RegisterData(tx);
      data.readability.cover(ids);
      const lookup = new RegisterLookup(tx, ctx, f.app.id, Date.now() + 60_000, false, undefined, data);
      for (const [name, m] of Object.entries(memories)) {
        const batched = await lookup.readable(ctx, m.id, who);
        const single = await canReadMemory(tx as never, ctx, m.id);
        table[who]![name] = batched;
        if (batched !== single) differ += 1;
      }
    });
  }
  expect(differ, JSON.stringify(table)).toBe(0);
  // The spec-fixed rows: FR-016 for ADMIN and OWNER; the owner reads its own; a stranger reads only the PUBLIC row;
  // a revoked org member is not an org member; per-App isolation keeps the other App's memory from an App member.
  expect(table.platformAdmin!.freePersonal).toBe(false);
  expect(table.platformOwner!.freePersonal).toBe(false);
  expect(table.owner!.freePersonal).toBe(true);
  expect(table.stranger).toMatchObject({ publicKnowledge: true, orgKnowledge: false, appScoped: false, freePersonal: false, encrypted: false });
  expect(table.revoked!.orgKnowledge).toBe(false);
  expect(table.appMember!.otherAppScoped).toBe(false);
  // Both answers occur, so the table is not vacuous.
  expect(Object.values(table).flatMap(r => Object.values(r))).toEqual(expect.arrayContaining([true, false]));
}, 120_000);

it('an ungated worker\'s lookup answers readable without asking the gate, as before', async () => {
  await db.$transaction(async tx => {
    const data = new RegisterData(tx);
    data.readability.cover([f.roleA.systemMemoryId]);
    const lookup = new RegisterLookup(tx, f.context() as never, f.app.id, Date.now() + 60_000, true, undefined, data);
    // Count calls to the gate itself: this transaction is not the counted client, so an op count could not fail.
    gate.calls = 0;
    expect(await lookup.readable(f.context(f.outside.id), f.roleA.systemMemoryId, 'self')).toBe(true);
    expect(gate.calls).toBe(0);
  });
});

it('a memory outside the declared set is answered by canReadMemory alone', async () => {
  await db.$transaction(async tx => {
    const data = new RegisterData(tx);
    data.readability.cover([f.team.systemMemoryId]);
    const ctx = { db: tx, userId: f.member.id, roles: ['READER'] } as never;
    expect(data.readability.answer(ctx, f.roleA.systemMemoryId)).toBeNull();
    const lookup = new RegisterLookup(tx, ctx, f.app.id, Date.now() + 60_000, false, undefined, data);
    expect(await lookup.readable(ctx, f.roleA.systemMemoryId, 'self')).toBe(await canReadMemory(tx as never, ctx, f.roleA.systemMemoryId));
  });
});

it('a principal\'s batch never answers for another principal, even for the same user', async () => {
  // The reader and a holder are two principals with two context objects; each gets its own batch, in either order.
  await db.$transaction(async tx => {
    // member: an org ADMIN, reads the uninstalled roleA; outside: App owner only, reads only what the App installs.
    await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.member.id, role: 'ADMIN' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: f.outside.id, role: 'owner' } });
    await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.roleA.id } } });
    const asMember = { db: tx, userId: f.member.id, roles: ['READER'] } as never;
    const asOutside = { db: tx, userId: f.outside.id, roles: ['READER'] } as never;
    // The same user twice: as a platform ADMIN (no access map) and as a plain READER.
    const outsideAsAdmin = { db: tx, userId: f.outside.id, roles: ['ADMIN'] } as never;
    const pairs = [[asMember, true, asOutside, false], [outsideAsAdmin, true, asOutside, false]] as const;
    for (const [a, aReads, b, bReads] of pairs) {
      for (const order of [[a, b], [b, a]]) {
        const data = new RegisterData(tx);
        data.readability.cover([f.team.systemMemoryId, f.roleA.systemMemoryId]);
        const answers = new Map<unknown, boolean>();
        for (const ctx of order) answers.set(ctx, (await data.readability.answer(ctx, f.roleA.systemMemoryId))!);
        expect(answers.get(a)).toBe(aReads);
        expect(answers.get(b)).toBe(bReads);
      }
    }
  });
});

it('a memory declared after a principal\'s batch was read is answered by canReadMemory, not guessed from the batch', async () => {
  await db.$transaction(async tx => {
    const data = new RegisterData(tx);
    const ctx = { db: tx, userId: f.member.id, roles: ['READER'] } as never;
    data.readability.cover([f.team.systemMemoryId]);
    expect(await data.readability.answer(ctx, f.team.systemMemoryId)).toBe(true);
    data.readability.cover([f.roleA.systemMemoryId]);
    // roleA is readable to the member (installed), but it is not in the batch already read: no answer from it.
    expect(data.readability.answer(ctx, f.roleA.systemMemoryId)).toBeNull();
    const lookup = new RegisterLookup(tx, ctx, f.app.id, Date.now() + 60_000, false, undefined, data);
    expect(await lookup.readable(ctx, f.roleA.systemMemoryId, 'self')).toBe(true);
  });
});

// ---- fresh per call: a revocation between two calls is honoured on the next -------

it('the batch lives for one call: uninstalling the task\'s Agent between two calls is honoured on the second', async () => {
  const { items, known } = await build({ codes: 1, holders: 1, depth: 1 }, 'fresh');
  const app = { id: f.app.id, organizationId: f.org.id, ownerUserId: null };
  const state = async () => {
    const out = await enrichTickWakes(f.context(), app, items, new Set(items.map(i => i.workerId)), known);
    return (out.get(items[0]!.workerId)!.stored.reasons[0] as { action?: { state?: string } }).action?.state;
  };
  expect(await state()).toBe('MAPPED');
  await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.roleA.id } } });
  // The holder (an App member, no org role) no longer reads roleA, where the task lives: the nearest task is refused.
  expect(await state()).toBe('UNRESOLVED');
});
