/** Dependent #2063 cut: standalone plan reads must not reconcile outside the outer fence. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { withIncludeHistoryTransaction } from './includeHistoryFence.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let memoryId: string;
let userId: string;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { handle: 'standalone-plan-admin', roles: ['ADMIN'] } })).id;
  const org = await db.organization.create({ data: { name: 'Plan fence', urn: 'plan-fence.example' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { organizationId: org.id, urn: 'plan-fence.example:mem', name: 'Plan fence', class: 'knowledge' } })).id;
});

it.each(['skillPlan', 'selectedSkillFilePlan'] as const)('%s waits before row locks and reconciliation', async (surface) => {
  const node = await db.node.create({ data: {
    memoryId, loc: 'tasks:declared', name: 'Declared', isRunnable: true, content: '# Body\n\nSteps.',
    properties: { exports: { claudeSkill: { name: 'my-skill', description: 'Does a thing. Use when needed.', enable: true } } },
  } });
  await db.node.update({ where: { id: node.id }, data: { content: '# Changed by raw writer\n\nSteps.' } });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const pending = surface === 'skillPlan'
    ? resolvers.Query.skillPlan(null, { input: { intent: 'EXPORT' } }, ctx())
    : resolvers.Query.selectedSkillFilePlan(null, { input: { nodes: [node.id] } }, ctx());
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 750);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(1);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${node.id} FOR UPDATE NOWAIT`;
    });
  } finally {
    release();
    await holder;
    await outcome;
  }
  await pending;
  expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(2);
});

it('holds the selected row across the properties byte check and metadata fetch at READ COMMITTED', async () => {
  // No declaration for claudeSkill: this takes the metadata-only SKIP path,
  // which returns before reconciliation's own later row lock.
  const node = await db.node.create({ data: {
    memoryId, loc: 'tasks:metadata', name: 'Metadata', isRunnable: true, content: '# Body',
    properties: { exports: { codexSkill: { name: 'codex-only', description: 'Codex only', enable: true } } },
  } });
  const transaction = db.$transaction.bind(db);
  let attempted = false;
  let blocked = false;
  const hookedDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (work: (tx: unknown) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
        const hooked = new Proxy(tx, {
          get(inner, key, r) {
            if (key !== '$queryRaw') return Reflect.get(inner, key, r);
            return async (...args: unknown[]) => {
              const value = await Reflect.apply(inner.$queryRaw, inner, args);
              const sql = JSON.stringify(args[0]);
              if (!attempted && sql.includes('COALESCE(octet_length(properties::text), 0)')) {
                attempted = true;
                try {
                  await db.$transaction(async (writer) => {
                    await writer.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
                    await writer.node.update({ where: { id: node.id }, data: { properties: { enlarged: true } } });
                  });
                } catch (error) {
                  expect(String(error)).toMatch(/lock timeout|55P03/);
                  blocked = true;
                }
              }
              return value;
            };
          },
        });
        return work(hooked);
      }, options as never);
    },
  });
  const result = await resolvers.Query.selectedSkillFilePlan(null, { input: { nodes: [node.id], host: 'claudeSkill' } }, { ...ctx(), db: hookedDb });
  expect(attempted).toBe(true);
  expect(blocked).toBe(true);
  expect(result.selectionResults).toMatchObject([{ action: 'SKIP', reason: { code: 'host-not-declared' } }]);
});

it.each(['skillPlan', 'selectedSkillFilePlan'] as const)('%s rechecks authority after waiting before reconciling', async (surface) => {
  const node = await db.node.create({ data: {
    memoryId, loc: 'tasks:revoked', name: 'Revoked', isRunnable: true, content: '# Body',
    properties: { exports: { claudeSkill: { name: 'my-skill', description: 'Does a thing. Use when needed.', enable: true } } },
  } });
  await db.node.update({ where: { id: node.id }, data: { content: '# Raw drift' } });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const pending = surface === 'skillPlan'
    ? resolvers.Query.skillPlan(null, { input: { intent: 'EXPORT' } }, ctx())
    : resolvers.Query.selectedSkillFilePlan(null, { input: { nodes: [node.id] } }, ctx());
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 750);
    await db.user.update({ where: { id: userId }, data: { roles: [] } });
    await db.orgMember.deleteMany({ where: { userId } });
  } finally {
    release();
    await holder;
    await outcome;
  }
  const result = await pending;
  expect(result.entries).toEqual([]);
  expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(1);
  expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
});
