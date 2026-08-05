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

  it('relocates a whole subtree ACROSS memories; re-indexes embeddings under the dest policy (#781)', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    const grandchild = await createDbNode(db, { loc: 'p:c:d', memoryId: memA.id });
    // A denormalized source embedding on the child (vector column nullable — omit).
    await db.nodeEmbedding.create({
      data: { nodeId: child.id, memoryId: memA.id, kind: 'abstract', provider: 'local', model: 'test', dim: 768 },
    });

    const moved = await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser());
    expect(moved.id).toBe(parent.id); // stable id
    expect(moved.memoryId).toBe(memB.id);
    expect(moved.loc).toBe('q');
    // Descendants followed, rebased, into memB.
    for (const [id, loc] of [[child.id, 'q:c'], [grandchild.id, 'q:c:d']] as const) {
      const n = await db.node.findUniqueOrThrow({ where: { id } });
      expect(n.memoryId).toBe(memB.id);
      expect(n.loc).toBe(loc);
    }
    expect(await locsIn(memA.id)).toEqual([]); // nothing stranded in the source
    // The source-policy embedding is DELETED (not blindly relabeled). memB isn't
    // vector-indexed, so nothing is re-queued; the row is simply gone.
    expect(await db.nodeEmbedding.findFirst({ where: { nodeId: child.id } })).toBeNull();
  });

  it('cross-memory into a VECTOR-INDEXED memory deletes source vectors + queues a re-index, resetting retry state (#781)', async () => {
    const indexed = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'mc-org:mc/idx', name: 'mc/idx', class: 'knowledge', visibility: 'ORGANIZATION', vectorIndexEnabled: true },
    });
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    await db.nodeEmbedding.create({
      data: { nodeId: child.id, memoryId: memA.id, kind: 'abstract', provider: 'local', model: 'test', dim: 768 },
    });
    // The child previously accumulated failed embedding retries — a bare
    // pending stamp would inherit the stale failure state (and, pre-#882,
    // would have been excluded by the drain's max-attempts filter).
    await db.node.update({
      where: { id: child.id },
      data: { embeddingAttempts: 9, embeddingFailedAt: new Date(), embeddingError: 'boom' },
    });

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: `${indexed.urn}:q` }, asUser());
    expect(await db.nodeEmbedding.findFirst({ where: { nodeId: child.id } })).toBeNull(); // source vector gone
    const c = await db.node.findUniqueOrThrow({ where: { id: child.id } });
    expect(c.memoryId).toBe(indexed.id);
    expect(c.embeddingPendingAt).not.toBeNull(); // queued for the worker
    expect(c.embeddingAttempts).toBe(0); // retry state reset so it actually schedules
    expect(c.embeddingFailedAt).toBeNull();
    expect(c.embeddingError).toBeNull();
  });

  it('cross-memory into a NON-indexed memory clears the embedding marker (invalidates in-flight jobs) (#781)', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    // Simulate an in-flight embed job's pending marker on the child.
    await db.node.update({ where: { id: child.id }, data: { embeddingPendingAt: new Date() } });

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser()); // memB not indexed
    const c = await db.node.findUniqueOrThrow({ where: { id: child.id } });
    expect(c.memoryId).toBe(memB.id);
    // Marker cleared → any in-flight source-side job is invalidated (latest-wins).
    expect(c.embeddingPendingAt).toBeNull();
  });

  it('cross-memory transfers Memory.pendingEdgeCount credit for moved nodes (#781)', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    await db.pendingEdge.create({ data: { id: generateId(), sourceId: child.id, targetId: 'unresolved:ref', name: 'rel' } });
    await db.memory.update({ where: { id: memA.id }, data: { pendingEdgeCount: 1 } });

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser());
    expect((await db.memory.findUniqueOrThrow({ where: { id: memA.id } })).pendingEdgeCount).toBe(0);
    expect((await db.memory.findUniqueOrThrow({ where: { id: memB.id } })).pendingEdgeCount).toBe(1);
  });

  it('refuses a cross-memory move when the destination is ENCRYPTED (#781 v1)', async () => {
    const enc = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'mc-org:mc/enc', name: 'mc/enc', class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
    });
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    await expect(
      M.moveNode(null, { sourceRef: parent.id, targetUrn: `${enc.urn}:q` }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    // Refused before any write — the subtree stayed in memA.
    expect(await locsIn(memA.id)).toEqual(['p', 'p:c']);
  });

  it('refuses a cross-memory move when either memory is GIT-BACKED (#781 v1)', async () => {
    const git = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'mc-org:mc/git', name: 'mc/git', class: 'knowledge', visibility: 'ORGANIZATION', source: 'https://github.com/acme/repo.git' },
    });
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    await expect(
      M.moveNode(null, { sourceRef: parent.id, targetUrn: `${git.urn}:q` }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await locsIn(memA.id)).toEqual(['p', 'p:c']); // nothing moved
  });

  it('refuses moving a CHAT subtree across memories (#781 v1)', async () => {
    const chatRoot = await db.node.create({
      data: { id: generateId(), memoryId: memA.id, loc: 'chat1', name: 'Chat', nodeType: 'info', tags: [], data: { scope: 'private' } },
    });
    await createDbNode(db, { loc: 'chat1:msg', memoryId: memA.id });
    await expect(
      M.moveNode(null, { sourceRef: chatRoot.id, targetUrn: urnB('q') }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: chatRoot.id } })).memoryId).toBe(memA.id);
  });

  it('refuses a cross-memory move that violates the destination SCHEMA (#781)', async () => {
    // A schema-governed dest: objectType "widget" must have a required "size" field.
    const schema = { objectTypes: { widget: { fields: { size: { type: 'text', required: true } } } } };
    const governed = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'mc-org:mc/gov', name: 'mc/gov', class: 'knowledge', visibility: 'ORGANIZATION', schema },
    });
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    // A descendant with the governed objectType but missing the required prop.
    await db.node.create({
      data: { id: generateId(), memoryId: memA.id, loc: 'p:bad', name: 'bad', nodeType: 'info', tags: [], objectType: 'widget', properties: {} },
    });
    await expect(
      M.moveNode(null, { sourceRef: parent.id, targetUrn: `${governed.urn}:q` }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await locsIn(memA.id)).toEqual(['p', 'p:bad']); // nothing moved
  });

  it('cross-memory: an intra-subtree edge follows (memoryId + re-derived loc)', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    const e = await edge(parent.id, child.id, memA.id, 'p:rel:p:c');

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser());
    const moved = await db.edge.findUniqueOrThrow({ where: { id: e.id } });
    expect(moved.memoryId).toBe(memB.id); // follows the subtree into the dest memory
    expect(moved.loc).toBe('q:rel:q:c'); // re-derived from the rebased endpoints
    expect(moved.sourceId).toBe(parent.id); // endpoints unchanged (stable ids)
    expect(moved.targetId).toBe(child.id);
  });

  it('cross-memory: an OUTGOING boundary edge follows the moved source, INCOMING stays', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const outside = await createDbNode(db, { loc: 'outside', memoryId: memA.id }); // stays in memA
    const out = await edge(parent.id, outside.id, memA.id, 'p:rel:outside'); // source moves
    const inc = await edge(outside.id, parent.id, memA.id, 'outside:rel:p'); // target moves

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser());
    // Outgoing edge (source moved) → memoryId=memB, loc re-derived (target loc unchanged).
    const outEdge = await db.edge.findUniqueOrThrow({ where: { id: out.id } });
    expect(outEdge.memoryId).toBe(memB.id);
    expect(outEdge.loc).toBe('q:rel:outside');
    // Incoming edge (source stayed in memA) → memoryId unchanged; it's now a
    // legitimate cross-memory edge (memA → memB), gated at read time.
    const incEdge = await db.edge.findUniqueOrThrow({ where: { id: inc.id } });
    expect(incEdge.memoryId).toBe(memA.id);
    expect(incEdge.targetId).toBe(parent.id);
  });

  it('cross-memory: disambiguates a moved edge loc past pre-existing suffixed variants (#784 review)', async () => {
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });
    const e = await edge(parent.id, child.id, memA.id, 'p:rel:p:c'); // → base q:rel:q:c after move
    // Pre-stage memB edges occupying BOTH the base loc AND its :2 variant.
    const x = await createDbNode(db, { loc: 'x', memoryId: memB.id });
    const y = await createDbNode(db, { loc: 'y', memoryId: memB.id });
    await edge(x.id, y.id, memB.id, 'q:rel:q:c');
    await edge(x.id, y.id, memB.id, 'q:rel:q:c:2');

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser());
    const moved = await db.edge.findUniqueOrThrow({ where: { id: e.id } });
    expect(moved.memoryId).toBe(memB.id);
    expect(moved.loc).toBe('q:rel:q:c:3'); // base and :2 both taken → :3 (no P2002)
  });

  it('still allows a CROSS-memory move of a LEAF node', async () => {
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

  it('moves a node UP into a virtual-ancestor slot with an overlapping descendant loc', async () => {
    // `a:b` → `a` (no real node at `a`) with a grandchild `a:b:b`: the rebased
    // grandchild loc `a:b` overlaps the source's OWN old loc, so a naive per-row
    // update would trip the (loc, memoryId) unique. The two-phase move handles it.
    const parent = await createDbNode(db, { loc: 'a:b', memoryId: memA.id });
    const grandchild = await createDbNode(db, { loc: 'a:b:b', memoryId: memA.id });

    const moved = await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnA('a') }, asUser());
    expect(moved.loc).toBe('a');
    expect((await db.node.findUniqueOrThrow({ where: { id: grandchild.id } })).loc).toBe('a:b');
    expect(await locsIn(memA.id)).toEqual(['a', 'a:b']);
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
