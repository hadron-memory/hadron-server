import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { createNode } from './createNode.js';

// Prevent actual filesystem writes during DB tests
vi.mock('../../integrations/localFs/saveNodeToFs.js', () => ({
  saveNodeToFs: vi.fn().mockResolvedValue({}),
}));

let graphId: string;

beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db);
  graphId = graph.id;
});

describe('createNode', () => {
  it('throws when loc is missing', async () => {
    await expect(
      createNode({ name: 'test', graphId }),
    ).rejects.toThrow('Node requires loc, name, and graphId');
  });

  it('throws when name is missing', async () => {
    await expect(
      createNode({ loc: 'org.graph.node', graphId }),
    ).rejects.toThrow();
  });

  it('throws when graphId is missing', async () => {
    await expect(
      createNode({ loc: 'org.graph.node', name: 'test', graphId: '' }),
    ).rejects.toThrow();
  });

  it('creates a node in the database', async () => {
    const node = await createNode({
      loc: 'org.graph.node',
      name: 'My Node',
      graphId,
      description: 'A test node',
    });

    expect(node.loc).toBe('org.graph.node');
    expect(node.name).toBe('My Node');
    expect(node.description).toBe('A test node');

    // Verify it was actually persisted
    const inDb = await db.node.findFirst({ where: { loc: 'org.graph.node' } });
    expect(inDb).not.toBeNull();
  });

  it('derives namespace from loc (first 2 segments)', async () => {
    const node = await createNode({
      loc: 'my-org.my-graph.sub.deep',
      name: 'Deep Node',
      graphId,
    });

    expect(node.namespace).toBe('my-org.my-graph');
  });

  it('upserts: second call with same loc updates, id unchanged', async () => {
    const first = await createNode({
      loc: 'org.g.n',
      name: 'Original',
      graphId,
    });

    const second = await createNode({
      loc: 'org.g.n',
      name: 'Updated',
      graphId,
    });

    expect(second.name).toBe('Updated');
    expect(second.id).toBe(first.id);

    // Only one row in DB
    const count = await db.node.count({ where: { loc: 'org.g.n' } });
    expect(count).toBe(1);
  });

  it('persists tags correctly', async () => {
    const node = await createNode({
      loc: 'org.g.tagged',
      name: 'Tagged',
      graphId,
      tags: ['alpha', 'beta'],
    });

    expect(Array.isArray(node.tags)).toBe(true);
    expect((node.tags as string[]).sort()).toEqual(['alpha', 'beta']);
  });
});
