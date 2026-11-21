/**
 * #4716 — revokeAgentSubscription's FR-029 empty-check + hard-delete is ONE
 * guarded operation.
 *
 * On main the resolver ran `findFirst` with `_count.nodes` and then a separate
 * `memory.delete` outside any transaction: a node committed between the count
 * and the delete cascaded away with the memory (Node.memory is
 * onDelete: Cascade) — the write had succeeded and the node was silently lost.
 * cor:dmo:050:08 retains the user's memory at revocation, hard-deleting only
 * an EMPTY one; a memory that gained a node in that window is not empty.
 *
 * The interleaving pin stages the race deterministically with two connections:
 * a writer parks on the memory row `FOR UPDATE`, the resolver is fired and
 * parks behind it (on main its `memory.delete` parks — the count already ran;
 * with the guard the row lock itself parks), the writer commits a node, and
 * only then is the resolver released. Red on main (node lost), green with the
 * guard (fresh count after the lock wait sees the node; memory retained).
 *
 * The behavior pins freeze the rest of FR-029 against the guard: a still-empty
 * memory IS hard-deleted (personal and private), a live node retains it, a
 * SOFT-DELETED node retains it (the predicate is "no node rows", never
 * narrowed to live ones — the #4716 FIT), and out-of-scope memories are never
 * touched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import {
  cleanDb,
  createDbAgentSubscription,
  createDbAppAgent,
  createDbAppWithKey,
} from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as {
  revokeAgentSubscription: (
    _: unknown,
    args: { userRef: string; agentRef: string },
    ctx: Context,
  ) => Promise<unknown>;
};

interface Fixture {
  org: { id: string };
  agent: { id: string };
  app: { id: string };
  admin: { id: string };
  alice: { id: string };
  memory: { id: string };
}

async function buildFixture(memoryClass: 'personal' | 'private' = 'personal'): Promise<Fixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'rev4716', urn: `rev4716-${generateId()}` },
  });
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'agent' },
  });
  const { app } = await createDbAppWithKey(db, 'rev4716-app', org.id);
  await createDbAppAgent(db, app.id, agent.id);
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 4716001, githubUsername: 'rev4716-admin' },
  });
  const alice = await db.user.create({
    data: { id: generateId(), githubId: 4716002, githubUsername: 'rev4716-alice' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  await createDbAgentSubscription(db, alice.id, agent.id);
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:${memoryClass}-alice`,
      name: `${memoryClass}-alice`,
      userId: alice.id,
      userMemoryOfAgentId: agent.id,
      appId: app.id,
      class: memoryClass,
      visibility: null,
    },
    select: { id: true },
  });
  return { org, agent, app, admin, alice, memory };
}

const ctx = (f: Fixture): Context => ({ db, roles: ['ADMIN'], userId: f.admin.id }) as Context;

const revoke = (f: Fixture) =>
  M.revokeAgentSubscription(null, { userRef: f.alice.id, agentRef: f.agent.id }, ctx(f));

beforeEach(async () => {
  await cleanDb(db);
});

describe('#4716 — the interleaving: a node committed between the empty-check and the hard delete', () => {
  it.each(['personal', 'private'] as const)(
    '%s-class memory: the node survives and the memory is retained',
    async (memoryClass) => {
      const f = await buildFixture(memoryClass);
      const memoryId = f.memory.id;

      // The competing writer parks ON the memory row and lands its node while
      // the resolver is blocked behind it. On main the parked statement is the
      // hard delete (the count already returned 0); with the guard it is the
      // row lock the guard takes before counting. Either way the node commits
      // strictly between the empty-check and the delete.
      let bHeld!: () => void;
      const held = new Promise<void>((resolve) => { bHeld = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const writer = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
        bHeld();
        await gate;
        await tx.node.create({
          data: {
            id: generateId(),
            memoryId,
            loc: 'data:raced-write',
            name: 'raced write',
            content: 'committed between the empty-check and the hard delete',
          },
        });
      }, { timeout: 20_000 });
      await held;

      const call = revoke(f).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
      // Deterministic park: the resolver's memory-row statement is the only
      // backend in this per-worker database waiting on a lock.
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      release();
      await writer;
      const result = await call;
      expect(result).toEqual({ ok: true });

      // cor:dmo:050:08 — the memory gained a node, so it was not empty at
      // delete time: both the write and the memory survive.
      expect(await db.node.count({ where: { memoryId } })).toBe(1);
      expect(await db.memory.findUnique({ where: { id: memoryId } })).not.toBeNull();
      const sub = await db.agentSubscription.findUniqueOrThrow({
        where: { userId_agentId: { userId: f.alice.id, agentId: f.agent.id } },
      });
      expect(sub.revokedAt).not.toBeNull();
    },
  );
});

describe('#4716 — FR-029 behavior pins around the guard', () => {
  it.each(['personal', 'private'] as const)(
    'a still-empty %s-class memory is hard-deleted on revocation',
    async (memoryClass) => {
      const f = await buildFixture(memoryClass);
      await expect(revoke(f)).resolves.toBeTruthy();
      expect(await db.memory.findUnique({ where: { id: f.memory.id } })).toBeNull();
    },
  );

  it('retains the memory when a live node exists', async () => {
    const f = await buildFixture();
    await db.node.create({
      data: { id: generateId(), memoryId: f.memory.id, loc: 'data:kept', name: 'kept', content: 'kept' },
    });
    await revoke(f);
    expect(await db.node.count({ where: { memoryId: f.memory.id } })).toBe(1);
    expect(await db.memory.findUnique({ where: { id: f.memory.id } })).not.toBeNull();
  });

  it('retains the memory when ONLY a soft-deleted node exists (emptiness is "no node rows", not "no live nodes")', async () => {
    const f = await buildFixture();
    const node = await db.node.create({
      data: { id: generateId(), memoryId: f.memory.id, loc: 'data:soft', name: 'soft', content: 'soft-deleted' },
      select: { id: true },
    });
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
    await revoke(f);
    expect(await db.node.count({ where: { memoryId: f.memory.id } })).toBe(1);
    expect(await db.memory.findUnique({ where: { id: f.memory.id } })).not.toBeNull();
  });

  it('never touches out-of-scope memories (free-standing, or of another agent)', async () => {
    const f = await buildFixture();
    const otherAgent = await db.agent.create({
      data: { id: generateId(), organizationId: f.org.id, urn: `other-${generateId()}`, name: 'other-agent' },
    });
    const freeStanding = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: f.org.id,
        urn: `${f.org.urn}:free-standing`,
        name: 'free-standing',
        userId: f.alice.id,
        userMemoryOfAgentId: null,
        appId: null,
        class: 'personal',
        visibility: null,
      },
      select: { id: true },
    });
    const otherAgentMemory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: f.org.id,
        urn: `${f.org.urn}:personal-other-agent`,
        name: 'personal-other-agent',
        userId: f.alice.id,
        userMemoryOfAgentId: otherAgent.id,
        appId: f.app.id,
        class: 'personal',
        visibility: null,
      },
      select: { id: true },
    });

    await revoke(f); // revokes alice's subscription on f.agent, which is empty → deleted

    expect(await db.memory.findUnique({ where: { id: f.memory.id } })).toBeNull();
    expect(await db.memory.findUnique({ where: { id: freeStanding.id } })).not.toBeNull();
    expect(await db.memory.findUnique({ where: { id: otherAgentMemory.id } })).not.toBeNull();
  });
});
