/**
 * #5015 (Billing A7b, cor:acl:150:04) race pins, staged at the guarded write and not at the resolver (finding
 * `resolver-race-pin-can-miss-the-consume-guard`):
 * - two `createNode` calls at one below the cap, both parked on the owner's advisory key behind a holder: exactly one
 *   commits, the other is refused, and the owner ends exactly at its limit;
 * - a `createNode` parked inside its transaction (on its loc key, before it takes the memory row) while
 *   `transferMemoryOwnership` moves the memory to a person at their cap is judged against the NEW owner (finding
 *   `node-write-owner-transfer-race`: the owner is read under the memory row lock, never before it).
 *
 * RED on main: no door took the owner key, so both creates committed (one over the limit) and the post-transfer create
 * wrote into a capped person's memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersBlockedBy } from '../../test/lockWait.js';
import { generateId } from '../id.js';
import { acquireLockSet } from '../nodeSubtreeLock.js';
import { reloadOwnerDefaultLimitsForTests } from './defaults.js';
import { lockOwnerLimitKeys } from './gate.js';
import { OWNER_LIMIT_KEYS } from './keys.js';
import type { OwnerRef } from '../owner.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] } as Context);
let u: string, orgId: string, mO: string, mO2: string;
const limitRow = (owner: OwnerRef, limitValue: number) => db.ownerLimit.create({
  data: { id: generateId(), ...('userId' in owner ? { ownerUserId: owner.userId } : { organizationId: owner.organizationId }),
    key: 'nodes', limitValue, sourceType: 'manual', sourceId: 't', note: 't' },
});
/** An explicit `seq`, so a root-level create takes no root-sibling seq key and two creates meet first at the owner key. */
const create = (memoryId: string, loc: string, seq: number) =>
  resolvers.Mutation.createNode(null, { input: { memoryId, loc, name: loc, seq } } as never, ctx(u));

/** Run `hold` in a transaction that keeps its locks until `release()`; resolves with that backend's pid once it holds them. */
async function holder(hold: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready!: (pid: number) => void;
  const held = new Promise<number>((resolve) => { ready = resolve; });
  const done = db.$transaction(async (tx) => {
    await hold(tx);
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(pid);
    await gate;
  }, { timeout: 30_000 });
  return { pid: await held, release, done };
}

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  u = (await db.user.create({ data: { id: generateId(), handle: 'race5015-u', email: 'race5015-u@example.test', roles: ['READER'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'race5015', urn: 'race5015-org' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'OWNER' } });
  mO = (await db.memory.create({ data: { id: generateId(), name: 'o', urn: 'race5015-org:o', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  mO2 = (await db.memory.create({ data: { id: generateId(), name: 'o2', urn: 'race5015-org:o2', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  await db.node.create({ data: { id: generateId(), memoryId: mO, loc: 'a', name: 'a' } });
});
afterEach(() => { reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

// The lock barrier waits up to 10s; the test timeout sits above it so a mutant fails on the barrier, not mid-cleanup.
describe('#5015 owner-limit races at the node write', { timeout: 20_000 }, () => {
  // Two memories of one owner: creates in ONE memory already serialize on its channel-host key (channels.ts), before the
  // owner key, so only creates in different memories meet first at the owner key.
  it('two creates in two memories of one owner at one below the cap, parked on the owner key: exactly one commits', async () => {
    const owner = { organizationId: orgId };
    const limit = Number(await OWNER_LIMIT_KEYS.nodes.count(db, owner)) + 1;
    await limitRow(owner, limit);
    const h = await holder((tx) => lockOwnerLimitKeys(tx, owner, ['nodes']));
    const racers = [create(mO, 'x', 10), create(mO2, 'y', 11)].map((p) => p.then(() => 'ok', (e: { extensions?: { code?: string } }) => e?.extensions?.code ?? String(e)));
    try {
      await waitForLockWaitersBlockedBy(db, h.pid, 2);
    } finally {
      h.release();
      await h.done;
    }
    expect((await Promise.all(racers)).sort()).toEqual(['OWNER_LIMIT_REACHED', 'ok']);
    expect(Number(await OWNER_LIMIT_KEYS.nodes.count(db, owner))).toBe(limit);
    expect(await db.node.count({ where: { memoryId: { in: [mO, mO2] }, loc: { in: ['x', 'y'] } } })).toBe(1);
  });

  it('a create parked inside its transaction while the memory is transferred to a capped person is judged against that person', async () => {
    const person = { userId: u };
    // Room for exactly the transferred memory's live nodes (the transfer asks `nodes` too, #5016), so the person is at the cap after it.
    await limitRow(person, Number(await OWNER_LIMIT_KEYS.nodes.count(db, person)) + await db.node.count({ where: { memoryId: mO, deletedAt: null } }));
    // The org has room: judged against the owner read before the transfer, the create would commit.
    await limitRow({ organizationId: orgId }, 1_000);
    const h = await holder((tx) => acquireLockSet(tx, [{ memoryId: mO, loc: 'x' }]));
    const parked = create(mO, 'x', 10).then(() => 'ok', (e: { extensions?: { code?: string } }) => e?.extensions?.code ?? String(e));
    try {
      await waitForLockWaitersBlockedBy(db, h.pid, 1);
      await resolvers.Mutation.transferMemoryOwnership(null, { memoryRef: mO, userRef: u, targetClass: 'private' } as never, ctx(u));
      expect(await db.memory.findUniqueOrThrow({ where: { id: mO } })).toMatchObject({ ownerUserId: u, organizationId: null });
    } finally {
      h.release();
      await h.done;
    }
    expect(await parked).toBe('OWNER_LIMIT_REACHED');
    expect(await db.node.count({ where: { memoryId: mO, loc: 'x' } })).toBe(0);
  });

  it('a transfer that starts after a create read its owner waits for that create to commit', async () => {
    const owner = { organizationId: orgId };
    await limitRow(owner, 1_000);
    const h = await holder((tx) => lockOwnerLimitKeys(tx, owner, ['nodes']));
    const parked = create(mO, 'x', 10).then(() => 'ok', (e: unknown) => String(e));
    let transfer: Promise<unknown> | undefined;
    let transferred = false;
    try {
      await waitForLockWaitersBlockedBy(db, h.pid, 1);
      const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity WHERE ${h.pid}::int = ANY(pg_blocking_pids(pid))`;
      transfer = resolvers.Mutation.transferMemoryOwnership(null, { memoryRef: mO, userRef: u, targetClass: 'private' } as never, ctx(u))
        .then(() => { transferred = true; });
      // The transfer waits on the create (its memory row), not on the holder.
      await waitForLockWaitersBlockedBy(db, pid, 1);
      expect(transferred).toBe(false);
    } finally {
      h.release();
      await h.done;
    }
    expect(await parked).toBe('ok');
    await transfer;
    expect(await db.memory.findUniqueOrThrow({ where: { id: mO } })).toMatchObject({ ownerUserId: u });
  });

  it('a createRevision that meets an uncommitted change of its system memory\'s owner is judged against the NEW owner', async () => {
    const agent = await resolvers.Mutation.createAgent({}, { orgRef: orgId, name: 'race5015-agent', visibility: 'PERSONAL' } as never, ctx(u)) as { id: string };
    const sys = (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).systemMemoryId!;
    const capped = (await db.organization.create({ data: { id: generateId(), name: 'race5015-b', urn: 'race5015-b' } })).id;
    await limitRow({ organizationId: capped }, 0);
    // The owner column is not a key, so this update leaves the node insert's FK lock free: only the door's FOR SHARE waits on it.
    const h = await holder(async (tx) => { await tx.$executeRaw`UPDATE memories SET organization_id = ${capped} WHERE id = ${sys}`; });
    const parked = resolvers.Mutation.createRevision({}, { agentRef: agent.id } as never, ctx(u))
      .then(() => 'ok', (e: { extensions?: { code?: string } }) => e?.extensions?.code ?? String(e));
    try {
      await waitForLockWaitersBlockedBy(db, h.pid, 1);
    } finally {
      h.release();
      await h.done;
    }
    expect(await parked).toBe('OWNER_LIMIT_REACHED');
    expect(await db.node.count({ where: { memoryId: sys, loc: { startsWith: 'revisions' } } })).toBe(0);
  });
});
