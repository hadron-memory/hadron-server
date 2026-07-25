/**
 * Issue #564 — moveNode / cloneNode on the <object>Ref convention.
 *
 *   moveNode(sourceRef, targetUrn? | targetMemoryRef?): Node!
 *   cloneNode(sourceRef, targetUrn? | targetMemoryRef?): Node!
 *
 * targetUrn = the destination's full node URN (new memory + loc);
 * targetMemoryRef = same loc, new memory. Exactly one is required. Conflicts
 * fail loudly. moveNode keeps the id (edges stay valid); cloneNode makes a new
 * node and copies only the outgoing edges that naturally resolve at the
 * destination.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const ctx = (o: Partial<Context> = {}): Context => ({ db, ...o });

let org: { id: string };
let memA: { id: string; urn: string };
let memB: { id: string; urn: string };
let user: { id: string };

const urnA = (loc: string) => `${memA.urn}:${loc}`;
const urnB = (loc: string) => `${memB.urn}:${loc}`;
const asUser = () => ctx({ userId: user.id, roles: ['READER'] });

const edge = (sourceId: string, targetId: string, memoryId: string, loc: string) =>
  db.edge.create({ data: { id: generateId(), memoryId, sourceId, targetId, loc, name: 'rel' } });

beforeEach(async () => {
  await cleanDb(db);
  const a = await createDbOrgAndGraph(db, { orgName: 'mc-org', graphName: 'mc/a', visibility: 'ORGANIZATION' });
  org = a.org;
  memA = a.graph as any;
  memB = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'mc-org:mc/b', name: 'mc/b', class: 'knowledge', visibility: 'ORGANIZATION' },
  })) as any;
  user = await db.user.create({ data: { githubId: 9100, githubUsername: 'mc-user', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
});

describe('moveNode (#564)', () => {
  it('moves within the same memory to a new loc, keeping id + edges', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id, content: 'A' });
    const beta = await createDbNode(db, { loc: 'beta', memoryId: memA.id });
    await edge(alpha.id, beta.id, memA.id, 'alpha:rel:beta');

    const moved = await M.moveNode(null, { sourceRef: alpha.id, targetUrn: urnA('alpha-moved') }, asUser());
    expect(moved.id).toBe(alpha.id); // stable id across the move
    expect(moved.loc).toBe('alpha-moved');
    expect(moved.memoryId).toBe(memA.id);
    const e = await db.edge.findFirstOrThrow({ where: { sourceId: alpha.id } });
    expect(e.targetId).toBe(beta.id); // edge reference survives
  });

  it('moves to another memory keeping the loc (targetMemoryRef)', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    const moved = await M.moveNode(null, { sourceRef: alpha.id, targetMemoryRef: memB.id }, asUser());
    expect(moved.memoryId).toBe(memB.id);
    expect(moved.loc).toBe('alpha');
  });

  it('moves to another memory AND loc (targetUrn)', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    const moved = await M.moveNode(null, { sourceRef: alpha.id, targetUrn: urnB('alpha-in-b') }, asUser());
    expect(moved.memoryId).toBe(memB.id);
    expect(moved.loc).toBe('alpha-in-b');
  });

  it('fails loudly (NODE_ALREADY_EXISTS) when the destination loc is occupied', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    await createDbNode(db, { loc: 'occupied', memoryId: memA.id });
    await expect(
      M.moveNode(null, { sourceRef: alpha.id, targetUrn: urnA('occupied') }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'NODE_ALREADY_EXISTS' } });
  });

  it('requires exactly one of targetUrn / targetMemoryRef', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    await expect(M.moveNode(null, { sourceRef: alpha.id }, asUser()))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(M.moveNode(null, { sourceRef: alpha.id, targetUrn: urnA('x'), targetMemoryRef: memB.id }, asUser()))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('is a no-op when the destination is the current slot', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    const moved = await M.moveNode(null, { sourceRef: alpha.id, targetUrn: urnA('alpha') }, asUser());
    expect(moved.id).toBe(alpha.id);
    expect(moved.loc).toBe('alpha');
  });

  it('throws NODE_NOT_FOUND for a missing source', async () => {
    await expect(M.moveNode(null, { sourceRef: urnA('ghost'), targetMemoryRef: memB.id }, asUser()))
      .rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
  });
});

// #768 — a SAME-MEMORY move rebases the node's loc-subtree (descendants + the
// locs of edges whose source moved) with it, so children's computed URNs follow
// the renamed parent. A cross-memory move of a node with descendants is refused.
describe('moveNode subtree cascade (#768)', () => {
  const locsIn = async (memoryId: string) =>
    (await db.node.findMany({ where: { memoryId, deletedAt: null }, select: { loc: true } }))
      .map((n) => n.loc)
      .sort();

  it('rebases descendant locs on a same-memory rename', async () => {
    const parent = await createDbNode(db, { loc: 'findings:auth', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'findings:auth:oauth', memoryId: memA.id });
    const grandchild = await createDbNode(db, { loc: 'findings:auth:oauth:pkce', memoryId: memA.id });

    const moved = await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnA('findings:security') }, asUser());
    expect(moved.loc).toBe('findings:security');
    // Descendants keep their ids but are rebased under the new parent loc.
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('findings:security:oauth');
    expect((await db.node.findUniqueOrThrow({ where: { id: grandchild.id } })).loc).toBe(
      'findings:security:oauth:pkce',
    );
  });

  it('does NOT sweep in a sibling that merely shares a loc prefix (: boundary)', async () => {
    const parent = await createDbNode(db, { loc: 'findings:auth', memoryId: memA.id });
    await createDbNode(db, { loc: 'findings:auth:oauth', memoryId: memA.id });
    const sibling = await createDbNode(db, { loc: 'findings:auth-v2', memoryId: memA.id });

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnA('findings:security') }, asUser());
    // `findings:auth-v2` is a sibling, not a descendant — untouched.
    expect((await db.node.findUniqueOrThrow({ where: { id: sibling.id } })).loc).toBe('findings:auth-v2');
    expect(await locsIn(memA.id)).toEqual(['findings:auth-v2', 'findings:security', 'findings:security:oauth']);
  });

  it('keeps edge references intact across a same-memory subtree rename', async () => {
    // Edge locs are a derived denormalization left untouched by a move (#781);
    // the reference (source/target ids) must stay valid so the graph is intact.
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    const e = await edge(parent.id, child.id, memA.id, 'p:rel:p:c');

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnA('q') }, asUser());
    const stillThere = await db.edge.findUniqueOrThrow({ where: { id: e.id } });
    expect(stillThere.sourceId).toBe(parent.id);
    expect(stillThere.targetId).toBe(child.id);
    // Endpoints were rebased; the edge still connects them by id.
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('q:c');
  });

  it('refuses a CROSS-memory move of a node that has descendants (#768 scope)', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    await expect(
      M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    // Nothing moved — the whole thing is refused up front.
    expect(await locsIn(memA.id)).toEqual(['p', 'p:c']);
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).memoryId).toBe(memA.id);
  });

  it('still allows a CROSS-memory move of a LEAF node (single-node path)', async () => {
    const leaf = await createDbNode(db, { loc: 'lonely', memoryId: memA.id });
    const moved = await M.moveNode(null, { sourceRef: leaf.id, targetUrn: urnB('lonely-in-b') }, asUser());
    expect(moved.memoryId).toBe(memB.id);
    expect(moved.loc).toBe('lonely-in-b');
  });

  it('rejects moving a node into its own subtree', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    await expect(
      M.moveNode(null, { sourceRef: parent.id, targetUrn: urnA('p:c:under-self') }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('fails loudly when a DESCENDANT would collide at the destination', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    // A live node already sits where the rebased child would land.
    await createDbNode(db, { loc: 'q:c', memoryId: memA.id });
    await expect(
      M.moveNode(null, { sourceRef: parent.id, targetUrn: urnA('q') }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'NODE_ALREADY_EXISTS' } });
    // The subtree stayed put — the whole move is one transaction.
    expect(await locsIn(memA.id)).toEqual(['p', 'p:c', 'q:c']);
  });

  it('records a NodeRevision for each moved descendant (audit)', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnA('p2') }, asUser());
    expect(await db.nodeRevision.count({ where: { nodeId: child.id } })).toBeGreaterThan(0);
  });
});

describe('cloneNode (#564)', () => {
  it('clones fields to a NEW node (fresh id), leaving the source intact', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id, content: 'hello' });
    const clone = await M.cloneNode(null, { sourceRef: alpha.id, targetUrn: urnA('alpha-copy') }, asUser());
    expect(clone.id).not.toBe(alpha.id);
    expect(clone.loc).toBe('alpha-copy');
    expect(clone.content).toBe('hello');
    const src = await db.node.findUnique({ where: { id: alpha.id } });
    expect(src?.deletedAt).toBeNull(); // source survives
  });

  it('copies outgoing edges that naturally resolve (same-memory clone)', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    const beta = await createDbNode(db, { loc: 'beta', memoryId: memA.id });
    await edge(alpha.id, beta.id, memA.id, 'alpha:rel:beta');
    const clone = await M.cloneNode(null, { sourceRef: alpha.id, targetUrn: urnA('alpha-copy') }, asUser());
    const edges = await db.edge.findMany({ where: { sourceId: clone.id, deletedAt: null } });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(beta.id);
  });

  it('drops edges that do not resolve in the destination memory (cross-memory clone)', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    const beta = await createDbNode(db, { loc: 'beta', memoryId: memA.id });
    await edge(alpha.id, beta.id, memA.id, 'alpha:rel:beta');
    // memB has no 'beta' → the outgoing edge naturally resolves to nothing → dropped.
    const clone = await M.cloneNode(null, { sourceRef: alpha.id, targetMemoryRef: memB.id }, asUser());
    const edges = await db.edge.findMany({ where: { sourceId: clone.id, deletedAt: null } });
    expect(edges).toHaveLength(0);
  });

  it('re-points a naturally-resolving edge to the destination-memory target (cross-memory clone)', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    const beta = await createDbNode(db, { loc: 'beta', memoryId: memA.id });
    const betaInB = await createDbNode(db, { loc: 'beta', memoryId: memB.id });
    await edge(alpha.id, beta.id, memA.id, 'alpha:rel:beta');
    const clone = await M.cloneNode(null, { sourceRef: alpha.id, targetMemoryRef: memB.id }, asUser());
    const edges = await db.edge.findMany({ where: { sourceId: clone.id, deletedAt: null } });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(betaInB.id); // dest-memory 'beta', not memA's
  });

  it('fails loudly when the destination loc is already occupied', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    await createDbNode(db, { loc: 'taken', memoryId: memA.id });
    await expect(M.cloneNode(null, { sourceRef: alpha.id, targetUrn: urnA('taken') }, asUser()))
      .rejects.toMatchObject({ extensions: { code: expect.stringMatching(/conflict/i) } });
  });

  it('requires exactly one of targetUrn / targetMemoryRef', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    await expect(M.cloneNode(null, { sourceRef: alpha.id }, asUser()))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});
