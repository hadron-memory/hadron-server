import { withIncludeHistoryTransaction } from '../../lib/includes/includeHistoryFence.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import type { Prisma } from '../../generated/prisma/index.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { createNode } from './createNode.js';

// Prevent actual filesystem writes during DB tests
vi.mock('../../integrations/localFs/saveNodeToFs.js', () => ({
  saveNodeToFs: vi.fn().mockResolvedValue({}),
}));

let memoryId: string;

beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db);
  memoryId = graph.id;
});

describe('createNode', () => {
  it('throws when loc is missing', async () => {
    await expect(
      createNode({ name: 'test', memoryId }),
    ).rejects.toThrow('Node requires loc, name, and memoryId');
  });

  it('throws when name is missing', async () => {
    await expect(
      createNode({ loc: 'org.graph.node', memoryId }),
    ).rejects.toThrow();
  });

  it('throws when memoryId is missing', async () => {
    await expect(
      createNode({ loc: 'org.graph.node', name: 'test', memoryId: '' }),
    ).rejects.toThrow();
  });

  it('creates a node in the database', async () => {
    const node = await createNode({
      loc: 'org.graph.node',
      name: 'My Node',
      memoryId,
      description: 'A test node',
    });

    expect(node.loc).toBe('org.graph.node');
    expect(node.name).toBe('My Node');
    expect(node.description).toBe('A test node');

    // Verify it was actually persisted
    const inDb = await db.node.findFirst({ where: { loc: 'org.graph.node', memoryId } });
    expect(inDb).not.toBeNull();
  });

  it('upserts: second call with same loc updates, id unchanged', async () => {
    const first = await createNode({
      loc: 'org.g.n',
      name: 'Original',
      content: 'before',
      memoryId,
    });

    const second = await createNode({
      loc: 'org.g.n',
      name: 'Updated',
      content: 'after',
      memoryId,
    });

    expect(second.name).toBe('Updated');
    expect(second.id).toBe(first.id);

    // Only one row in DB
    const count = await db.node.count({ where: { loc: 'org.g.n', memoryId } });
    expect(count).toBe(1);
    const live = await db.node.findUniqueOrThrow({ where: { id: first.id } });
    expect(live.revSeq).toBe(2);
    expect(live.revisionContentHash).toMatch(/^[0-9a-f]{32}$/);
    const revisions = await db.nodeRevision.findMany({ where: { nodeId: first.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revNo: 1, name: 'Original', content: 'before' });
  });

  it('persists tags correctly', async () => {
    const node = await createNode({
      loc: 'org.g.tagged',
      name: 'Tagged',
      memoryId,
      tags: ['alpha', 'beta'],
    });

    expect(Array.isArray(node.tags)).toBe(true);
    expect((node.tags as string[]).sort()).toEqual(['alpha', 'beta']);
  });
});


it('legacy controller waits on the prepared history fence before source rows', async () => {
  const source = await createNode({ memoryId, loc: 'source', name: 'Source', content: 'Before' });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const pending = createNode({ memoryId, loc: 'source', name: 'Source', content: 'After' });
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 750);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${source.id} FOR UPDATE NOWAIT`;
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe('Before');
    expect(await db.nodeRevision.count({ where: { nodeId: source.id } })).toBe(0);
  } finally { release(); await holder; await outcome; }
  expect(await pending).toMatchObject({ content: 'After' });
});

it('legacy controller retains the prepared fence through its actual commit', async () => {
  const source = await createNode({ memoryId, loc: 'source', name: 'Source', content: 'Before' });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transaction = db.$transaction.bind(db);
  let first = true;
  const hook = vi.spyOn(db, '$transaction').mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
    const held = first; first = false;
    return transaction(async (tx) => { const value = await work(tx); if (held) { entered(); await gate; } return value; }, options as never);
  }) as typeof db.$transaction);
  const pending = createNode({ memoryId, loc: 'source', name: 'Source', content: 'After' });
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  let counterpartyEntered = false;
  try {
    await Promise.race([ready, outcome.then((result) => { if ('error' in result) throw result.error; throw new Error('missing commit barrier'); })]);
    const counterparty = withIncludeHistoryTransaction(db, async () => { counterpartyEntered = true; });
    const otherOutcome = counterparty.then(() => undefined, (error: unknown) => error);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 750);
      expect(counterpartyEntered).toBe(false);
      expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe('Before');
    } finally { release(); await outcome; await otherOutcome; }
    expect(await pending).toMatchObject({ content: 'After' });
    expect(counterpartyEntered).toBe(true);
  } finally { release(); hook.mockRestore(); }
});

// Evidence-only: requires the held #2258 compile implementation.
import { compileBootPrompt } from '../../api/graphql/schema/compileBootPrompt.js';
it.each(['read', 'write', 'writer-first'] as const)('actual affected-source compile and legacy controller: %s', async (phase) => {
  const source = await createNode({ memoryId, loc: 'source', name: 'Source', content: 'Before' });
  const write = () => createNode({ memoryId, loc: 'source', name: 'Source', content: 'After' });
  const dbOrgId = (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId;
  const user = await db.user.create({ data: { handle: 'legacy-compile-admin', roles: ['ADMIN'] } });
  await db.memory.update({ where: { id: memoryId }, data: { class: 'system' } });
  const agent = await db.agent.create({ data: { organizationId: dbOrgId, systemMemoryId: memoryId, urn: 'test-org:compile-agent', name: 'Compile' } });
  await db.node.create({ data: { memoryId: memoryId, loc: 'boot:source', role: 'boot-prompt', name: 'Source', content: '{{> source}}' } });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transaction = db.$transaction.bind(db);
  const compileDb = new Proxy(db, {
    get(client, key, receiver) {
      if (key !== '$transaction') return Reflect.get(client, key, receiver);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
        const result = await work(tx);
        if (phase === 'write') { entered(); await gate; }
        return result;
      }, options as never);
    },
  });
  let restoreHook: (() => void) | undefined;
  if (phase === 'writer-first') {
    const hook = vi.spyOn(db, '$transaction').mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
      const result = await work(tx); entered(); await gate; return result;
    }, options as never)) as typeof db.$transaction);
    restoreHook = () => hook.mockRestore();
  }
  const compile = () => compileBootPrompt({ db: compileDb, userId: user.id, roles: ['ADMIN'] }, { kind: 'AGENT', agentId: agent.id }, phase === 'read' ? { seams: { beforeAssemble: async () => { entered(); await gate; } } } : {});
  const first: Promise<unknown> = phase === 'writer-first' ? write() : compile();
  const firstResult = first.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await Promise.race([ready, firstResult.then((result) => { if ('error' in result) throw result.error; throw new Error('missing combined legacy/compile barrier'); })]);
    const second: Promise<unknown> = phase === 'writer-first' ? compile() : write();
    const secondResult = second.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 1500);
      expect(await db.compiledPromptRevision.count()).toBe(0);
    } finally { release(); await firstResult; await secondResult; }
    expect(await firstResult).toHaveProperty('value');
    expect(await secondResult).toHaveProperty('value');
    const receipt = await db.compiledPromptRevision.findFirstOrThrow();
    const output = await db.node.findUniqueOrThrow({ where: { id: receipt.compiledNodeId } });
    expect(output.content).toBe(phase === 'writer-first' ? 'After' : 'Before');
    expect(receipt.provenance).toMatchObject({ occurrences: [{}, { nodeId: source.id, revNo: phase === 'writer-first' ? 2 : 1 }] });
    expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe('After');
  } finally { release(); restoreHook?.(); }
});
