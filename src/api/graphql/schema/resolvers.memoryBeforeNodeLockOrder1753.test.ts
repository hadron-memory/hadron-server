/**
 * #1753 — memory row first, node rows second, on every node writer.
 *
 * Anonymous-memory promotion (#1745) takes `memories … FOR UPDATE` and then
 * node row locks. The bulk node writers (updateNode, searchReplaceInNodes,
 * mergeNodes) took node `FOR UPDATE` first and then `memories … FOR SHARE`, so
 * a writer holding a node and waiting for the memory cycled with a promotion
 * holding the memory and waiting for that node. Postgres aborts one side (40P01).
 *
 * Deterministic shape, same for each writer: a "promoter" transaction holds the
 * memory FOR UPDATE; the writer starts and parks behind it; THEN the promoter
 * asks for the node row lock. With node-first writers the writer already holds
 * the node, so that request is the second edge of a cycle and one side dies.
 * With memory-first writers the writer holds nothing yet, the promoter's node
 * lock is granted at once, and the writer finishes after the promoter commits.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { isDeadlockVictim } from '../../../lib/memoryLockConflict.js';
import { Prisma } from '../../../generated/prisma/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let admin: { id: string };
let memoryId: string;
let a: { id: string };
let b: { id: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'lo', urn: 'lo-1753' } });
  admin = await db.user.create({ data: { githubId: 17530, githubUsername: 'lo-1753', handle: 'lo-1753', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'lo-1753:m', name: 'm', class: 'knowledge' },
    select: { id: true },
  });
  memoryId = mem.id;
  a = await db.node.create({ data: { id: generateId(), memoryId, loc: 'a', name: 'a', content: 'cat one' }, select: { id: true } });
  b = await db.node.create({ data: { id: generateId(), memoryId, loc: 'b', name: 'b', content: 'cat two' }, select: { id: true } });
});

const writers: Array<[string, () => Promise<unknown>]> = [
  ['updateNode', () => resolvers.Mutation.updateNode(null, { input: { id: a.id, content: 'dog one' } }, ctx())],
  ['searchReplaceInNodes', () => resolvers.Mutation.searchReplaceInNodes({}, {
    input: { oldText: 'cat', newText: 'dog', nodeIds: [a.id, b.id], fields: ['content'] },
  } as never, ctx())],
  ['mergeNodes', () => resolvers.Mutation.mergeNodes({}, {
    input: { source: a.id, target: b.id, include: ['CONTENT'] },
  } as never, ctx())],
];

describe('#1753 — a promotion-style memory lock never cycles with a node writer', () => {
  it.each(writers)('%s takes the memory before any node row', async (_name, run) => {
    let promoterHoldsMemory!: () => void;
    const held = new Promise<void>((r) => { promoterHoldsMemory = r; });
    let writerParked!: () => void;
    const parked = new Promise<void>((r) => { writerParked = r; });
    let writer!: Promise<unknown>;

    const promoter = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
      promoterHoldsMemory();
      await parked;
      // Promotion's live-node rewrite: the second lock in the would-be cycle.
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${a.id} FOR UPDATE`;
    }, { timeout: 20_000 });

    await held;
    writer = run();
    // Settle the writer's outcome without letting a rejection go unhandled.
    const writerResult = writer.then(() => null, (e: unknown) => e);

    await vi.waitFor(async () => {
      const waiting = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%FROM memories WHERE id%'
      `;
      expect(waiting.length).toBeGreaterThan(0);
    }, { timeout: 5_000, interval: 25 });
    writerParked();

    // Neither side may be a deadlock victim.
    await expect(promoter).resolves.toBeUndefined();
    expect(await writerResult).toBeNull();
  });
});

describe('#1753 — a deadlock victim reaches the caller as MEMORY_WRITE_CONFLICT', () => {
  it('maps SQLSTATE 40P01 (raw statement) and P2034 to the retryable code', () => {
    const raw = new Prisma.PrismaClientKnownRequestError('deadlock detected', {
      code: 'P2010', clientVersion: 'x', meta: { code: '40P01' },
    });
    const model = new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'x' });
    const other = new Prisma.PrismaClientKnownRequestError('nope', { code: 'P2010', clientVersion: 'x', meta: { code: '23505' } });
    expect(isDeadlockVictim(raw)).toBe(true);
    expect(isDeadlockVictim(model)).toBe(true);
    expect(isDeadlockVictim(other)).toBe(false);
    expect(isDeadlockVictim(new Error('deadlock'))).toBe(false);
  });

  it('a real memory/node cycle forced against updateNode never surfaces a raw 40P01 from the writer', async () => {
    // The OLD order, held by a legacy-style transaction: node first, then a
    // memory UPDATE. updateNode (memory SHARE, then the node) completes the cycle.
    let holdsNode!: () => void;
    const held = new Promise<void>((r) => { holdsNode = r; });
    let writerParked!: () => void;
    const parked = new Promise<void>((r) => { writerParked = r; });
    const legacy = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${a.id} FOR UPDATE`;
      holdsNode();
      await parked;
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
    }, { timeout: 20_000 }).then(() => null, (e: unknown) => e);
    await held;
    const writer = resolvers.Mutation.updateNode(null, { input: { id: a.id, content: 'dog one' } }, ctx())
      .then(() => null, (e: unknown) => e);
    await vi.waitFor(async () => {
      const waiting = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%nodes%FOR UPDATE%'
      `;
      expect(waiting.length).toBeGreaterThan(0);
    }, { timeout: 5_000, interval: 25 });
    writerParked();

    const [legacyErr, writerErr] = await Promise.all([legacy, writer]);
    // Postgres aborts exactly one participant.
    expect([legacyErr, writerErr].filter(Boolean)).toHaveLength(1);
    if (writerErr) {
      expect(writerErr).toMatchObject({ extensions: { code: 'MEMORY_WRITE_CONFLICT', memoryId } });
    } else {
      expect(String(legacyErr)).toMatch(/40P01|deadlock/i);
    }
  }, 20_000);
});

describe('#1753 — every wrapped writer pins the deadlock mapping', () => {
  // A forced victim: the transaction itself fails as Postgres reports a
  // deadlock victim. Deleting `mapDeadlockToWriteConflict` at a site lets the
  // raw error through and turns that site's case red.
  it.each(writers)('%s reports a deadlock victim as MEMORY_WRITE_CONFLICT', async (_name, run) => {
    const victim = new Prisma.PrismaClientKnownRequestError('deadlock detected', {
      code: 'P2010', clientVersion: 'x', meta: { code: '40P01' },
    });
    const spy = vi.spyOn(db, '$transaction').mockRejectedValue(victim);
    try {
      await expect(run()).rejects.toMatchObject({
        extensions: { code: 'MEMORY_WRITE_CONFLICT', memoryId },
      });
    } finally {
      spy.mockRestore();
    }
  });
});
