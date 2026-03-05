import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../test/helpers.js';
import { findGraph } from './findGraph.js';

beforeEach(async () => {
  await cleanDb(db);
});

describe('findGraph', () => {
  it('returns null for a non-existent namespace', async () => {
    const result = await findGraph('org/nonexistent');
    expect(result).toBeNull();
  });

  it('returns a graph with a single node', async () => {
    await createDbNode(db, {
      loc: 'org.graph.root',
      name: 'Root',
      namespace: 'org.graph',
      ownerRepo: 'org/repo',
    });

    const graph = await findGraph('org/graph');
    expect(graph).not.toBeNull();
    expect(graph!.name).toBe('org/graph');
    expect(graph!.namespace).toBe('org.graph');
    expect(graph!.nodes).toHaveLength(1);
    expect(graph!.nodes[0].loc).toBe('org.graph.root');
  });

  it('returns all nodes in the namespace, ordered by loc', async () => {
    await createDbNode(db, { loc: 'org.g.b', namespace: 'org.g', ownerRepo: 'org/repo' });
    await createDbNode(db, { loc: 'org.g.a', namespace: 'org.g', ownerRepo: 'org/repo' });
    await createDbNode(db, { loc: 'org.g.c', namespace: 'org.g', ownerRepo: 'org/repo' });

    const graph = await findGraph('org/g');
    expect(graph!.nodes).toHaveLength(3);
    expect(graph!.nodes.map((n) => n.loc)).toEqual(['org.g.a', 'org.g.b', 'org.g.c']);
  });

  it('does not include nodes from a namespace that only shares a prefix', async () => {
    // 'org.g' should not match 'org.graph' nodes
    await createDbNode(db, { loc: 'org.g.node', namespace: 'org.g', ownerRepo: 'org/r' });
    await createDbNode(db, { loc: 'org.graph.node', namespace: 'org.graph', ownerRepo: 'org/r2' });

    const graph = await findGraph('org/g');
    expect(graph!.nodes).toHaveLength(1);
    expect(graph!.nodes[0].loc).toBe('org.g.node');
  });

  it('includes edges in the result', async () => {
    const nodeA = await createDbNode(db, {
      loc: 'org.g.a',
      namespace: 'org.g',
      ownerRepo: 'org/repo',
    });
    const nodeB = await createDbNode(db, {
      loc: 'org.g.b',
      namespace: 'org.g',
      ownerRepo: 'org/repo',
    });

    await db.edge.create({
      data: { sourceId: nodeA.id, targetId: nodeB.id, label: 'links to' },
    });

    const graph = await findGraph('org/g');
    const a = graph!.nodes.find((n) => n.loc === 'org.g.a') as any;
    expect(a.outgoingEdges).toHaveLength(1);
    expect(a.outgoingEdges[0].label).toBe('links to');
  });

  it('returns ownerRepo from the first node', async () => {
    await createDbNode(db, {
      loc: 'myorg.mygraph.n',
      namespace: 'myorg.mygraph',
      ownerRepo: 'myorg/myrepo',
    });

    const graph = await findGraph('myorg/mygraph');
    expect(graph!.ownerRepo).toBe('myorg/myrepo');
  });
});
