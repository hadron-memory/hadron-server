/**
 * Graph-view fetch (issue #466) — the slim, paginated memoryNodes / memoryEdges
 * queries that let the portal render a memory's graph incrementally: load nodes
 * to completion, render, then load edges.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const ctx = (o: Partial<Context> = {}): Context => ({ db, ...o });
const admin = () => ctx({ roles: ['ADMIN'], userId: 'admin-gv' });

const memoryNodes = (args: any, c: Context = admin()) => (resolvers.Query as any).memoryNodes(null, args, c);
const memoryEdges = (args: any, c: Context = admin()) => (resolvers.Query as any).memoryEdges(null, args, c);

let mem: { id: string; urn: string };

async function mkNode(loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId: mem.id, loc, name: loc, tags: [], ...extra } as any });
}
async function mkEdge(loc: string, sourceId: string, targetId: string, extra: Record<string, unknown> = {}) {
  return db.edge.create({ data: { id: generateId(), memoryId: mem.id, loc, sourceId, targetId, ...extra } as any });
}

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'gv-org', graphName: 'gv/graph' });
  mem = { id: made.graph.id, urn: made.graph.urn };
});

describe('memoryNodes (#466)', () => {
  it('returns slim node fields, total, loc-ordered, paginated; excludes deleted', async () => {
    const a = await mkNode('n.a', {
      nodeType: 'info', tags: ['x', 'y'], content: 'BIG BODY that must not ship',
      // #513: small scalars the portal tree/graph render.
      seq: 3, isRunnable: true, description: 'a short desc',
    });
    await mkNode('n.b');
    await mkNode('n.c');
    await mkNode('n.gone', { deletedAt: new Date() });

    const page = await memoryNodes({ memoryRef: mem.id });
    expect(page.total).toBe(3); // soft-deleted excluded
    expect(page.nodes.map((n: any) => n.loc)).toEqual(['n.a', 'n.b', 'n.c']); // loc-ordered

    // Slim projection: exactly the graph fields (incl. #513 scalars), no content/abstract/data.
    expect(page.nodes[0]).toEqual({
      id: a.id, loc: 'n.a', name: 'n.a', nodeType: 'info', tags: ['x', 'y'],
      seq: 3, isRunnable: true, description: 'a short desc',
    });
    expect('content' in page.nodes[0]).toBe(false);
    // #513 nullable pass-through: a node with none of them set → null.
    expect(page.nodes[1]).toMatchObject({ loc: 'n.b', seq: null, isRunnable: null, description: null });

    // Stable offset paging over the loc-ordered list.
    const p1 = await memoryNodes({ memoryRef: mem.id, limit: 2, offset: 0 });
    const p2 = await memoryNodes({ memoryRef: mem.id, limit: 2, offset: 2 });
    expect(p1.nodes.map((n: any) => n.loc)).toEqual(['n.a', 'n.b']);
    expect(p2.nodes.map((n: any) => n.loc)).toEqual(['n.c']);
    expect([p1.total, p2.total]).toEqual([3, 3]);
  });

  it('accepts a memory URN', async () => {
    await mkNode('u.a');
    expect((await memoryNodes({ memoryRef: mem.urn })).total).toBe(1);
  });

  it('limit: 0 returns an empty page with just the total (cheap node count)', async () => {
    await mkNode('c.a');
    await mkNode('c.b');
    const page = await memoryNodes({ memoryRef: mem.id, limit: 0 });
    expect(page.nodes).toEqual([]);
    expect(page.total).toBe(2); // count still returned — the limit-0 count pattern
  });

  it('returns an empty page for a memory the caller cannot read (no disclosure)', async () => {
    await mkNode('secret.a');
    const other = await createDbOrgAndGraph(db, { orgName: 'gv-other', graphName: 'gvo/graph' });
    const stranger = await db.user.create({ data: { githubId: 6200, githubUsername: 'gv-stranger', roles: [] } });
    await db.orgMember.create({ data: { organizationId: other.org.id, userId: stranger.id, role: 'READER' } });
    const page = await memoryNodes({ memoryRef: mem.id }, ctx({ userId: stranger.id, roles: [] }));
    expect(page).toEqual({ nodes: [], total: 0 });
  });

  it('a personal memory is graphable by its owner only — a platform admin still gets an empty page (034 carve-out)', async () => {
    const orgP = await db.organization.create({
      data: { id: generateId(), name: 'gv-personal-org', urn: `gv-p-${generateId()}` },
    });
    const owner = await db.user.create({ data: { githubId: 6300, githubUsername: 'gv-owner', roles: [] } });
    const personal = await db.memory.create({
      data: { id: generateId(), organizationId: orgP.id, urn: `gv-personal-${generateId()}`, name: 'Personal', class: 'personal', userId: owner.id },
    });
    await db.node.create({ data: { id: generateId(), memoryId: personal.id, loc: 'p.a', name: 'p.a', tags: [] } });

    // Owner → sees the node.
    expect((await memoryNodes({ memoryRef: personal.id }, ctx({ userId: owner.id }))).total).toBe(1);
    // Another user → empty (owner-only).
    const otherUser = await db.user.create({ data: { githubId: 6301, githubUsername: 'gv-otheru', roles: [] } });
    expect(await memoryNodes({ memoryRef: personal.id }, ctx({ userId: otherUser.id }))).toEqual({ nodes: [], total: 0 });
    // Platform admin → ALSO empty (admins don't see other users' personal/private).
    const adminU = await db.user.create({ data: { githubId: 6302, githubUsername: 'gv-adminu', roles: ['ADMIN'] } });
    expect(await memoryNodes({ memoryRef: personal.id }, ctx({ userId: adminU.id, roles: ['ADMIN'] }))).toEqual({ nodes: [], total: 0 });
  });
});

describe('memoryEdges (#466)', () => {
  it('returns slim edges (endpoint ids), total, loc-ordered, paginated; excludes deleted', async () => {
    const a = await mkNode('e.a');
    const b = await mkNode('e.b');
    const c = await mkNode('e.c');
    await mkEdge('edge.1', a.id, b.id, { name: 'rel1' });
    await mkEdge('edge.2', b.id, c.id, { name: 'rel2' });
    await mkEdge('edge.gone', a.id, c.id, { deletedAt: new Date() });

    const page = await memoryEdges({ memoryRef: mem.id });
    expect(page.total).toBe(2); // soft-deleted excluded
    expect(page.edges.map((e: any) => e.loc)).toEqual(['edge.1', 'edge.2']);
    expect(page.edges[0]).toEqual({ id: expect.any(String), loc: 'edge.1', name: 'rel1', sourceId: a.id, targetId: b.id, governedKind: null });

    const p2 = await memoryEdges({ memoryRef: mem.id, limit: 1, offset: 1 });
    expect(p2.edges.map((e: any) => e.loc)).toEqual(['edge.2']);
    expect(p2.total).toBe(2);

    // limit: 0 → empty page, total still returned (cheap edge count).
    const countOnly = await memoryEdges({ memoryRef: mem.id, limit: 0 });
    expect(countOnly.edges).toEqual([]);
    expect(countOnly.total).toBe(2);
  });

  it('excludes edges dangling off a soft-deleted endpoint node', async () => {
    // deleteNode soft-deletes only the node row; its edges stay live. memoryNodes
    // omits the deleted node, so memoryEdges must drop edges touching it too, or
    // the client draws a link to a node not in the set (and total is inflated).
    const a = await mkNode('s.a');
    const b = await mkNode('s.b');
    const gone = await mkNode('s.gone');
    await mkEdge('edge.live', a.id, b.id); // both endpoints live → kept
    await mkEdge('edge.dead-target', a.id, gone.id); // target soft-deleted → dropped
    await mkEdge('edge.dead-source', gone.id, b.id); // source soft-deleted → dropped
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const page = await memoryEdges({ memoryRef: mem.id });
    expect(page.edges.map((e: any) => e.loc)).toEqual(['edge.live']);
    expect(page.total).toBe(1); // count matches the returned (live-endpoint) set
  });

  it('returns an empty page for a memory the caller cannot read', async () => {
    const a = await mkNode('x.a');
    const b = await mkNode('x.b');
    await mkEdge('edge.x', a.id, b.id);
    const stranger = await db.user.create({ data: { githubId: 6201, githubUsername: 'gv-stranger2', roles: [] } });
    const page = await memoryEdges({ memoryRef: mem.id }, ctx({ userId: stranger.id, roles: [] }));
    expect(page).toEqual({ edges: [], total: 0 });
  });
});
