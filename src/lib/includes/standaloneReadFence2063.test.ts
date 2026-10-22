import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { withIncludeHistoryTransaction } from './includeHistoryFence.js';

/** Dependent #2063: unchanged snapshots stay lock-free; drift reconciles under the outer fence. */
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

it.each([false, true])('keeps selected metadata sizing/fetch coherent (drift=%s)', async (drift) => {
  // No declaration for claudeSkill: this takes the metadata-only SKIP path,
  // which returns before reconciliation's own later row lock.
  const node = await db.node.create({ data: {
    memoryId, loc: 'tasks:metadata', name: 'Metadata', isRunnable: true, content: '# Body',
    properties: { exports: { codexSkill: { name: 'codex-only', description: 'Codex only', enable: true } } },
  } });
  if (drift) await db.node.update({ where: { id: node.id }, data: { content: '# Raw drift' } });
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
                    await writer.node.update({ where: { id: node.id }, data: { properties: { exports: { claudeSkill: { name: 'changed', description: 'Changed declaration.', enable: true } } } } });
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
  expect(blocked).toBe(drift);
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

it.each(['skillPlan', 'selectedSkillFilePlan', 'selectedMetadataSkip'] as const)(
  '%s unchanged read progresses while an unrelated history fence is held', async (surface) => {
    const node = await db.node.create({ data: {
      memoryId, loc: 'tasks:unchanged', name: 'Unchanged', isRunnable: true, content: '# Unchanged body',
      properties: { exports: { [surface === 'selectedMetadataSkip' ? 'codexSkill' : 'claudeSkill']: {
        name: 'unchanged-skill', description: 'An unchanged task.', enable: true,
      } } },
    } });
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
    await ready;
    const pending = surface === 'skillPlan'
      ? resolvers.Query.skillPlan(null, { input: { intent: 'EXPORT' } }, ctx())
      : resolvers.Query.selectedSkillFilePlan(null, { input: { nodes: [node.id], host: 'claudeSkill' } }, ctx());
    const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      const result = await Promise.race([pending, new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('unchanged read waited for unrelated fence')), 750);
      })]);
      if (surface === 'selectedMetadataSkip') {
        expect(result.selectionResults).toMatchObject([{ action: 'SKIP', reason: { code: 'host-not-declared' } }]);
      } else {
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].renderedBody).toContain('# Unchanged body');
      }
    } finally {
      release();
      await holder;
      await outcome;
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(1);
  },
);

it.each(['skillPlan', 'selectedSkillFilePlan'] as const)(
  '%s unchanged read progresses while a drift reader waits on an unrelated Node row', async (surface) => {
    const unchanged = await db.node.create({ data: {
      memoryId, loc: 'tasks:steady', name: 'Steady', isRunnable: true, content: '# Steady body',
      properties: { exports: { claudeSkill: { name: 'steady', description: 'Steady task.', enable: true } } },
    } });
    const drift = await db.node.create({ data: { memoryId, loc: 'drift', name: 'Drift', content: 'before' } });
    await db.node.update({ where: { id: drift.id }, data: { content: 'after' } });
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${drift.id} FOR UPDATE`;
      entered();
      await gate;
    });
    await ready;
    const reader = resolvers.Query.node(null, { ref: drift.id, raw: true }, ctx());
    const driftOutcome = reader.then((value) => ({ value }), (error: unknown) => ({ error }));
    let pending: Promise<unknown> | undefined;
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1, 750);
      const plan = surface === 'skillPlan'
        ? resolvers.Query.skillPlan(null, { input: { intent: 'EXPORT' } }, ctx())
        : resolvers.Query.selectedSkillFilePlan(null, { input: { nodes: [unchanged.id] } }, ctx());
      pending = plan.then((value) => ({ value }), (error: unknown) => ({ error }));
      const result = await Promise.race([plan, new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('unchanged read waited for drift-reader row wait')), 750);
      })]);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].renderedBody).toContain('# Steady body');
    } finally {
      release();
      await holder;
      await driftOutcome;
      await pending;
    }
    expect((await reader)?.content).toBe('after');
  },
);

it.each(['skillPlan', 'selectedSkillFilePlan'] as const)(
  '%s checks fingerprint and returns content from one unchanged snapshot', async (surface) => {
    const node = await db.node.create({ data: {
      memoryId, loc: 'tasks:snapshot', name: 'Snapshot', isRunnable: true, content: '# Original snapshot',
      properties: { exports: { claudeSkill: { name: 'snapshot', description: 'Snapshot task.', enable: true } } },
    } });
    const transaction = db.$transaction.bind(db);
    let interleaved = false;
    const hookedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
        return (work: (tx: unknown) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
          const hooked = new Proxy(tx, {
            get(inner, key, r) {
              if (key !== '$queryRaw') return Reflect.get(inner, key, r);
              return async (...args: unknown[]) => {
                const value = await Reflect.apply(inner.$queryRaw, inner, args);
                if (!interleaved && JSON.stringify(args[0]).includes('hadron_node_revision_state_hash')) {
                  interleaved = true;
                  await db.node.update({ where: { id: node.id }, data: { content: '# Later unchecked body' } });
                }
                return value;
              };
            },
          });
          return work(hooked);
        }, options as never);
      },
    });
    const context = { ...ctx(), db: hookedDb };
    const result = surface === 'skillPlan'
      ? await resolvers.Query.skillPlan(null, { input: { intent: 'EXPORT' } }, context)
      : await resolvers.Query.selectedSkillFilePlan(null, { input: { nodes: [node.id] } }, context);
    expect(interleaved).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].renderedBody).toContain('# Original snapshot');
    expect(result.entries[0].renderedBody).not.toContain('# Later unchecked body');
    expect(result.entries[0].revision).toBe(1);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('# Later unchecked body');
  },
);

it.each(['skillPlan', 'selectedSkillFilePlan'] as const)(
  '%s unchanged snapshot refreshes stale request authority', async (surface) => {
    const node = await db.node.create({ data: {
      memoryId, loc: 'tasks:authority', name: 'Authority', isRunnable: true, content: '# Private body',
      properties: { exports: { claudeSkill: { name: 'authority', description: 'Authority task.', enable: true } } },
    } });
    await db.user.update({ where: { id: userId }, data: { roles: [] } });
    await db.orgMember.deleteMany({ where: { userId } });
    const result = surface === 'skillPlan'
      ? await resolvers.Query.skillPlan(null, { input: { intent: 'EXPORT' } }, ctx())
      : await resolvers.Query.selectedSkillFilePlan(null, { input: { nodes: [node.id] } }, ctx());
    expect(result.entries).toEqual([]);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  },
);
