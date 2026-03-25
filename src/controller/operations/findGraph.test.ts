import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { findGraph } from './findGraph.js';

beforeEach(async () => {
  await cleanDb(db);
});

describe('findGraph', () => {
  it('returns null for a non-existent graph name', async () => {
    const result = await findGraph('org/nonexistent');
    expect(result).toBeNull();
  });

  it('returns a graph with a single node', async () => {
    const { graph } = await createDbOrgAndGraph(db, { graphName: 'org/graph' });
    await createDbNode(db, {
      loc: 'org.graph.root',
      name: 'Root',

      memoryId: graph.id,
    });

    const result = await findGraph('org/graph');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('org/graph');
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].loc).toBe('org.graph.root');
  });

  it('returns all nodes in the graph, ordered by loc', async () => {
    const { graph } = await createDbOrgAndGraph(db, { graphName: 'org/g' });
    await createDbNode(db, { loc: 'org.g.b', memoryId: graph.id });
    await createDbNode(db, { loc: 'org.g.a', memoryId: graph.id });
    await createDbNode(db, { loc: 'org.g.c', memoryId: graph.id });

    const result = await findGraph('org/g');
    expect(result!.nodes).toHaveLength(3);
    expect(result!.nodes.map((n) => n.loc)).toEqual(['org.g.a', 'org.g.b', 'org.g.c']);
  });

  it('does not include nodes from a different graph', async () => {
    const { graph: graph1 } = await createDbOrgAndGraph(db, { orgName: 'org1', graphName: 'org/g' });
    const { graph: graph2 } = await createDbOrgAndGraph(db, { orgName: 'org2', graphName: 'org/graph' });
    await createDbNode(db, { loc: 'org.g.node', memoryId: graph1.id });
    await createDbNode(db, { loc: 'org.graph.node', memoryId: graph2.id });

    const result = await findGraph('org/g');
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].loc).toBe('org.g.node');
  });

  it('includes edges in the result', async () => {
    const { graph } = await createDbOrgAndGraph(db, { graphName: 'org/g' });
    const nodeA = await createDbNode(db, {
      loc: 'org.g.a',
      memoryId: graph.id,
    });
    const nodeB = await createDbNode(db, {
      loc: 'org.g.b',
      memoryId: graph.id,
    });

    await db.edge.create({
      data: { sourceId: nodeA.id, targetId: nodeB.id, label: 'links to' },
    });

    const result = await findGraph('org/g');
    const a = result!.nodes.find((n) => n.loc === 'org.g.a') as any;
    expect(a.outgoingEdges).toHaveLength(1);
    expect(a.outgoingEdges[0].label).toBe('links to');
  });
});
