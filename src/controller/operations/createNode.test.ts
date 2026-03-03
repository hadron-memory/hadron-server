import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { createNode } from './createNode.js';

// Prevent actual filesystem writes during DB tests
vi.mock('../../integrations/localFs/saveNodeToFs.js', () => ({
  saveNodeToFs: vi.fn().mockResolvedValue({}),
}));

beforeEach(async () => {
  await cleanDb(db);
});

describe('createNode', () => {
  it('throws when loc is missing', async () => {
    await expect(
      createNode({ name: 'test', ownerRepo: 'org/repo' }),
    ).rejects.toThrow('Node requires loc, name, and ownerRepo');
  });

  it('throws when name is missing', async () => {
    await expect(
      createNode({ loc: 'org.graph.node', ownerRepo: 'org/repo' }),
    ).rejects.toThrow();
  });

  it('throws when ownerRepo is missing', async () => {
    await expect(
      createNode({ loc: 'org.graph.node', name: 'test' }),
    ).rejects.toThrow();
  });

  it('creates a node in the database', async () => {
    const node = await createNode({
      loc: 'org.graph.node',
      name: 'My Node',
      ownerRepo: 'org/repo',
      description: 'A test node',
    });

    expect(node.loc).toBe('org.graph.node');
    expect(node.name).toBe('My Node');
    expect(node.ownerRepo).toBe('org/repo');
    expect(node.description).toBe('A test node');

    // Verify it was actually persisted
    const inDb = await db.node.findUnique({ where: { loc: 'org.graph.node' } });
    expect(inDb).not.toBeNull();
  });

  it('derives namespace from loc (first 2 segments)', async () => {
    const node = await createNode({
      loc: 'my-org.my-graph.sub.deep',
      name: 'Deep Node',
      ownerRepo: 'my-org/my-graph',
    });

    expect(node.namespace).toBe('my-org.my-graph');
  });

  it('upserts: second call with same loc updates, id unchanged', async () => {
    const first = await createNode({
      loc: 'org.g.n',
      name: 'Original',
      ownerRepo: 'org/repo',
    });

    const second = await createNode({
      loc: 'org.g.n',
      name: 'Updated',
      ownerRepo: 'org/repo',
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
      ownerRepo: 'org/repo',
      tags: ['alpha', 'beta'],
    });

    expect(Array.isArray(node.tags)).toBe(true);
    expect((node.tags as string[]).sort()).toEqual(['alpha', 'beta']);
  });
});
