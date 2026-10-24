import { withIncludeHistoryClientTransaction } from '../../../lib/includes/includeHistoryFence.js';
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
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { mirrorNodeMoveToGit } from '../../../integrations/github/mirrorNodeMove.js';
import { moveNodeSubtree } from '../../../lib/nodeSubtreeMove.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { AmbiguousLegacyUrnError } from '../../../lib/entityRef/errors.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
  writeNodeFile: vi.fn(),
  removeNodeFile: vi.fn(),
}));
// #1095 — moveNode fires the move-aware git mirror after the transaction. The
// mirror is a repo/filesystem side effect; the tests here assert the DB outcome,
// and the spy lets the git-backed cases check that it was ASKED to mirror.
vi.mock('../../../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
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
  vi.mocked(mirrorNodeMoveToGit).mockClear();
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
  it('locks subtree rows before the Memory encryption fence', async () => {
    const root = await createDbNode(db, { loc: 'parent', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'parent:child', memoryId: memA.id });
    let signalHeld!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const mayRelease = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${child.id} FOR UPDATE`;
      signalHeld();
      await mayRelease;
    }, { timeout: 20_000 });
    await held;
    const moving = withIncludeHistoryClientTransaction(db, async (tx) => moveNodeSubtree(tx, {
      source: root, destLoc: 'renamed', editor: { userId: user.id },
    }), { timeout: 20_000 });
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%nodes%' AND pid <> pg_backend_pid()
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
      // A concurrent merge fold needs FOR SHARE on this memory while holding
      // its Node locks. The move may wait on a Node, but cannot hold a
      // conflicting Memory lock during that wait.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM memories WHERE id = ${memA.id} FOR SHARE
        `;
        expect(rows).toHaveLength(1);
      });
    } finally {
      release();
      await holder;
    }
    await moving;
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('renamed:child');
  }, 20_000);

  it('holds the source encryption state before a same-memory move can snapshot history', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id, content: 'plain source' });
    let reached!: () => void;
    let release!: () => void;
    const atSubtreeRead = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let moved: Promise<unknown> | undefined;
    let flip: Promise<unknown> | undefined;
    try {
      moved = withIncludeHistoryClientTransaction(db, async (tx) => {
        const findNodes = tx.node.findMany.bind(tx.node);
        let held = false;
        vi.spyOn(tx.node, 'findMany').mockImplementation((async (args: Parameters<typeof findNodes>[0]) => {
          const rows = await findNodes(args);
          // The full subtree read follows the Node locks and Memory fence,
          // but still precedes the move's revision snapshot.
          if (!held && args?.where?.memoryId === memA.id && !args.select) {
            held = true;
            reached();
            await resume;
          }
          return rows;
        }) as unknown as typeof tx.node.findMany);
        await moveNodeSubtree(tx, {
          source: alpha, destLoc: 'alpha-renamed', editor: { userId: user.id },
        });
      }, { timeout: 15_000 });
      await atSubtreeRead;
      let flipped = false;
      flip = db.memory.update({ where: { id: memA.id }, data: { isEncrypted: true } })
        .then(() => { flipped = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(flipped).toBe(false);
    } finally {
      release?.();
      await Promise.allSettled([moved, flip]);
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: alpha.id } })).loc).toBe('alpha-renamed');
  });

  it('holds the destination encryption state until a cross-memory relocation commits', async () => {
    const alpha = await createDbNode(db, { loc: 'alpha', memoryId: memA.id, content: 'plain source' });
    const dest = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'mc-org:private-dest',
        name: 'private-dest', class: 'private', userId: user.id,
      },
    });
    let reached!: () => void;
    let release!: () => void;
    const atCheck = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let moved: Promise<unknown> | undefined;
    let flip: Promise<unknown> | undefined;
    try {
      moved = withIncludeHistoryClientTransaction(db, async (tx) => {
        const findMemory = tx.memory.findUnique.bind(tx.memory);
        let held = false;
        vi.spyOn(tx.memory, 'findUnique').mockImplementation((async (args: Parameters<typeof findMemory>[0]) => {
          const row = await findMemory(args);
          if (!held && args?.where?.id === dest.id && args.select?.isEncrypted === true) {
            held = true;
            reached();
            await resume;
          }
          return row;
        }) as unknown as typeof tx.memory.findUnique);
        await moveNodeSubtree(tx, {
          source: alpha, destLoc: 'alpha', destMemoryId: dest.id, editor: { userId: user.id },
        });
      }, { timeout: 15_000 });
      await atCheck;
      let flipped = false;
      flip = db.memory.update({ where: { id: dest.id }, data: { isEncrypted: true } })
        .then(() => { flipped = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(flipped).toBe(false);
    } finally {
      release?.();
      await Promise.allSettled([moved, flip]);
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: alpha.id } })).memoryId).toBe(dest.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: dest.id } })).isEncrypted).toBe(true);
  });

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

  it('reports relative links that a cross-memory move breaks or retargets (#1392)', async () => {
    const parent = await createDbNode(db, {
      loc: 'p', memoryId: memA.id,
      content: `Moved [[p:c|child]], left [[stay]], changed [[shadow]], already missing [[absent]], ` +
        `malformed [[bad#ref]], ` +
        `and stable [[hrn:node:${memA.urn}:p:c|full URN]].`,
    });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id, content: 'Child also links [[stay]].' });
    await createDbNode(db, { loc: 'stay', memoryId: memA.id });
    await createDbNode(db, { loc: 'shadow', memoryId: memA.id });
    await createDbNode(db, { loc: 'shadow', memoryId: memB.id });

    const moved = await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser());

    expect(moved.content).toContain('[[p:c|child]]'); // raw body is preserved
    expect(moved.moveLinkWarnings).toEqual([
      { nodeId: parent.id, nodeLoc: 'q', raw: '[[p:c|child]]', target: 'p:c', status: 'MISSING' },
      { nodeId: parent.id, nodeLoc: 'q', raw: '[[stay]]', target: 'stay', status: 'MISSING' },
      { nodeId: parent.id, nodeLoc: 'q', raw: '[[shadow]]', target: 'shadow', status: 'RETARGETED' },
      { nodeId: child.id, nodeLoc: 'q:c', raw: '[[stay]]', target: 'stay', status: 'MISSING' },
    ]);
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('q:c');
  });

  it('selects cross-memory link warnings through the GraphQL moveNode field (#1392)', async () => {
    const source = await createDbNode(db, { loc: 'source', memoryId: memA.id, content: '[[stay]]' });
    await createDbNode(db, { loc: 'stay', memoryId: memA.id });
    const response = await server.executeOperation(
      {
        query: `mutation ($source: ID!, $target: String) {
          moveNode(sourceRef: $source, targetUrn: $target) {
            id moveLinkWarnings { nodeId nodeLoc raw target status }
          }
        }`,
        variables: { source: source.id, target: urnB('moved') },
      },
      { contextValue: asUser() },
    );
    expect(response.body.kind).toBe('single');
    if (response.body.kind !== 'single') throw new Error('Expected a single GraphQL result');
    expect(response.body.singleResult.errors).toBeUndefined();
    expect(response.body.singleResult.data?.moveNode).toEqual({
      id: source.id,
      moveLinkWarnings: [
        { nodeId: source.id, nodeLoc: 'moved', raw: '[[stay]]', target: 'stay', status: 'MISSING' },
      ],
    });
  });

  it('classifies relative links through source and destination aliases (#1392)', async () => {
    // #1591: only a minted node's move records an alias (its address was published).
    const mintInDb = (id: string) => db.node.update({ where: { id }, data: { mintedAt: new Date(), mintedByInfo: 'test' } });
    const sourceAliasTarget = await createDbNode(db, { loc: 'old-source', memoryId: memA.id });
    await mintInDb(sourceAliasTarget.id);
    await M.moveNode(null, { sourceRef: sourceAliasTarget.id, targetUrn: urnA('new-source') }, asUser());
    const destinationAliasTarget = await createDbNode(db, { loc: 'old-dest', memoryId: memB.id });
    await mintInDb(destinationAliasTarget.id);
    await M.moveNode(null, { sourceRef: destinationAliasTarget.id, targetUrn: urnB('new-dest') }, asUser());
    await createDbNode(db, { loc: 'old-dest', memoryId: memA.id });
    const firstAmbiguous = await createDbNode(db, { loc: 'old-ambiguous', memoryId: memB.id });
    await mintInDb(firstAmbiguous.id);
    await M.moveNode(null, { sourceRef: firstAmbiguous.id, targetUrn: urnB('new-ambiguous-1') }, asUser());
    const secondAmbiguous = await createDbNode(db, { loc: 'old-ambiguous', memoryId: memB.id });
    await mintInDb(secondAmbiguous.id);
    await M.moveNode(null, { sourceRef: secondAmbiguous.id, targetUrn: urnB('new-ambiguous-2') }, asUser());
    await createDbNode(db, { loc: 'old-ambiguous', memoryId: memA.id });
    expect((await resolveNodeRef(db, 'old-source', memA.id)).id).toBe(sourceAliasTarget.id);
    expect((await resolveNodeRef(db, 'old-dest', memB.id)).id).toBe(destinationAliasTarget.id);
    await expect(resolveNodeRef(db, 'old-ambiguous', memB.id)).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);

    const parent = await createDbNode(db, {
      loc: 'parent', memoryId: memA.id, content: '[[old-source]] [[old-dest]] [[old-ambiguous]]',
    });
    const moved = await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('moved') }, asUser());
    expect(moved.moveLinkWarnings).toEqual([
      { nodeId: parent.id, nodeLoc: 'moved', raw: '[[old-source]]', target: 'old-source', status: 'MISSING' },
      { nodeId: parent.id, nodeLoc: 'moved', raw: '[[old-dest]]', target: 'old-dest', status: 'RETARGETED' },
      { nodeId: parent.id, nodeLoc: 'moved', raw: '[[old-ambiguous]]', target: 'old-ambiguous', status: 'AMBIGUOUS' },
    ]);
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

  // #1095 — a GIT-BACKED memory used to refuse this outright. Git is one
  // integration of a memory, not a lock on it: the move now proceeds and
  // `mirrorNodeMoveToGit` carries it into the repos (source loses the files,
  // destination gains them).
  it('ALLOWS a cross-memory move into a GIT-BACKED memory, and mirrors it (#1095)', async () => {
    const git = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'mc-org:mc/git', name: 'mc/git', class: 'knowledge', visibility: 'ORGANIZATION', source: 'https://github.com/acme/repo.git' },
    });
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'p:c', memoryId: memA.id });

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: `${git.urn}:q` }, asUser());

    expect(await locsIn(memA.id)).toEqual([]); // the whole subtree left
    expect(await locsIn(git.id)).toEqual(['q', 'q:c']);

    // The mirror is told BOTH memories and every relocated node's PRE-move loc —
    // without the old locs the source repo's stale files can't be removed.
    expect(mirrorNodeMoveToGit).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(mirrorNodeMoveToGit).mock.calls[0];
    expect(args.srcMemoryId).toBe(memA.id);
    expect(args.destMemoryId).toBe(git.id);
    expect([...args.moved].sort((a, b) => a.previousLoc.localeCompare(b.previousLoc))).toEqual([
      { id: parent.id, previousLoc: 'p', loc: 'q' },
      { id: child.id, previousLoc: 'p:c', loc: 'q:c' },
    ]);
  });

  it('ALLOWS a cross-memory move OUT of a GIT-BACKED memory (#1095)', async () => {
    await db.memory.update({
      where: { id: memA.id },
      data: { source: 'https://github.com/acme/repo.git' },
    });
    const parent = await createDbNode(db, { loc: 'p', memoryId: memA.id });

    await M.moveNode(null, { sourceRef: parent.id, targetUrn: urnB('q') }, asUser());

    expect(await locsIn(memA.id)).toEqual([]);
    expect(await locsIn(memB.id)).toEqual(['q']);
    expect(mirrorNodeMoveToGit).toHaveBeenCalledTimes(1);
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

  it('refuses moving a CHANNEL root across memories — which carries no data.scope (#1196)', async () => {
    // The sibling of the test above, and the reason the guard is a UNION. #1196
    // dropped `data.scope` from Channel roots, so the scope predicate alone no
    // longer sees them; the obvious replacement — swap it for
    // `nodeType === 'chat'` — would have passed THIS test and silently dropped
    // the one above, because `startChat` writes its chat root as
    // `nodeType: 'record'`. Both markers, both arms, both pinned.
    //
    // The refusal survives its original rationale (a scope tied to memory
    // class) going away, for a stronger reason `cor:api:190:02` anticipated:
    // `Channel.memoryId`/`loc` are the address reservation and the register
    // rows point at the root, so moving the node without the row leaves a
    // Channel reserving an address in a memory its root no longer lives in.
    const chatRoot = await db.node.create({
      data: { id: generateId(), memoryId: memA.id, loc: 'chats:release', name: 'release', nodeType: 'chat', tags: [], data: { messageCount: 0 } },
    });
    await createDbNode(db, { loc: 'chats:release:messages', memoryId: memA.id });
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
  it('conceals an unreadable source before checking malformed destination arguments', async () => {
    const other = await createDbOrgAndGraph(db, { orgName: 'hidden-source', graphName: 'source', visibility: 'ORGANIZATION' });
    const source = await createDbNode(db, { loc: 'hidden-source', memoryId: other.graph.id });
    const transactions = vi.spyOn(db, '$transaction');
    try {
      await expect(M.cloneNode(null, { sourceRef: source.id }, asUser()))
        .rejects.toMatchObject({ message: `Node not found: "${source.id}"`, extensions: { code: 'NODE_NOT_FOUND', ref: source.id } });
      expect(transactions).not.toHaveBeenCalled();
    } finally { transactions.mockRestore(); }
  });

  it.each(['read-only', 'malformed', 'hidden'] as const)('refuses a %s destination before opening any history transaction', async (kind) => {
    const source = await createDbNode(db, { loc: 'refusal-source', memoryId: memA.id });
    let targetMemoryRef: string | undefined = memB.id;
    if (kind === 'read-only') {
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } }, data: { role: 'READER' } });
    } else if (kind === 'hidden') {
      const other = await createDbOrgAndGraph(db, { orgName: 'hidden-destination', graphName: 'hidden', visibility: 'ORGANIZATION' });
      targetMemoryRef = other.graph.id;
    } else targetMemoryRef = undefined;
    const before = await db.node.findUniqueOrThrow({ where: { id: source.id } });
    const counts = [await db.node.count(), await db.nodeRevision.count()];
    const transactions = vi.spyOn(db, '$transaction');
    try {
      await expect(M.cloneNode(null, { sourceRef: source.id, targetMemoryRef }, asUser()))
        .rejects.toMatchObject(kind === 'read-only'
          ? { message: 'Forbidden: no write access to this memory', extensions: { code: 'FORBIDDEN' } }
          : kind === 'malformed' ? { extensions: { code: 'BAD_USER_INPUT' } }
          : { name: 'MemoryNotFoundError' });
      expect(transactions).not.toHaveBeenCalled();
    } finally { transactions.mockRestore(); }
    expect(await db.node.findUniqueOrThrow({ where: { id: source.id } })).toEqual(before);
    expect([await db.node.count(), await db.nodeRevision.count()]).toEqual(counts);
  });

  it.each([
    { role: null, isRunnable: null },
    { role: 'weather', isRunnable: false },
    { role: 'weather.widget', isRunnable: null },
  ])('preserves ungoverned signals in same- and cross-memory clones: %j', async ({ role, isRunnable }) => {
    const source = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    await db.node.update({ where: { id: source.id }, data: { role, isRunnable } });

    const same = await M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('alpha-copy') }, asUser());
    const cross = await M.cloneNode(null, { sourceRef: source.id, targetMemoryRef: memB.id }, asUser());
    for (const clone of [same, cross]) {
      expect({ role: clone.role, isRunnable: clone.isRunnable }).toEqual({ role, isRunnable });
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).role).toBe(role);
  });

  it.each([
    { role: 'spec', isRunnable: null },
    { role: 'spec.rule', isRunnable: null },
    { role: 'review', isRunnable: null },
    { role: null, isRunnable: true },
  ])('refuses a generic clone of governed signals without stripping them: %j', async ({ role, isRunnable }) => {
    const source = await createDbNode(db, { loc: 'alpha', memoryId: memA.id });
    await db.node.update({ where: { id: source.id }, data: { role, isRunnable } });

    await expect(M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('alpha-copy') }, asUser()))
      .rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });
    await expect(M.cloneNode(null, { sourceRef: source.id, targetMemoryRef: memB.id }, asUser()))
      .rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });
    expect(await db.node.findFirst({ where: { memoryId: memA.id, loc: 'alpha-copy' } })).toBeNull();
    expect(await db.node.findFirst({ where: { memoryId: memB.id, loc: 'alpha' } })).toBeNull();
    expect(await db.node.findUniqueOrThrow({ where: { id: source.id } }))
      .toMatchObject({ role, isRunnable });
  });

  it('clones only the named node, leaving a descendant at its original loc', async () => {
    const source = await createDbNode(db, { loc: 'parent', memoryId: memA.id });
    const child = await createDbNode(db, { loc: 'parent:child', memoryId: memA.id });
    await db.node.update({ where: { id: source.id }, data: { role: 'weather.widget' } });
    await db.node.update({ where: { id: child.id }, data: { role: 'spec.rule' } });

    const clone = await M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('copy') }, asUser());
    expect(clone.role).toBe('weather.widget');
    expect(await db.node.findFirst({ where: { memoryId: memA.id, loc: 'copy:child' } })).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).role).toBe('spec.rule');
  });

  it('refuses a clone into a loc holding a soft-deleted governed node (resurrection merge)', async () => {
    // The clone's carried signals are EXPLICIT (null-normalized by
    // carryGovernedSignals), not omitted — which is exactly the input shape
    // that could differ from an ordinary create in the #1203 resurrection
    // merge. An ungoverned source over a governed tombstone must refuse on
    // the tombstone's role, and the tombstone must stay a tombstone.
    // (Andi's non-blocking coverage suggestion from the #1382 comparison;
    // the generic-create route is pinned in governedRole1201.test.ts.)
    const source = await createDbNode(db, { loc: 'live', memoryId: memA.id });
    await db.node.update({ where: { id: source.id }, data: { role: 'weather', isRunnable: false } });
    const dead = await createDbNode(db, { loc: 'grave', memoryId: memA.id, content: 'gone' });
    await db.node.update({ where: { id: dead.id }, data: { role: 'review', deletedAt: new Date() } });

    await expect(
      M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('grave') }, asUser()),
    ).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });

    const row = await db.node.findUniqueOrThrow({ where: { id: dead.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.role).toBe('review');
    expect(row.content).toBe('gone');
  });

  it('carries already-stored task attribution without minting a new task claim (#1326)', async () => {
    const task = await createDbNode(db, { loc: 'author-task', memoryId: memA.id });
    const authoredAt = new Date('2026-09-26T20:00:00Z');
    const alpha = await db.node.create({
      data: {
        id: generateId(), memoryId: memA.id, loc: 'authored', name: 'Authored',
        authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 3, authoredAt,
      },
    });
    const clone = await M.cloneNode(null, { sourceRef: alpha.id, targetUrn: urnA('authored-copy') }, asUser());
    expect(clone).toMatchObject({
      authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 3, authoredAt,
    });
    expect(clone.id).not.toBe(alpha.id);
  });

  it('clears copied attribution when the clone resurrects a tombstone at the destination (#1326)', async () => {
    // The clone omits source-null fields, so a resurrected tombstone keeps its
    // own leftovers (here `data`): the row is no longer the source's authored
    // state, and must not carry the source's claim.
    const task = await createDbNode(db, { loc: 'tomb-task', memoryId: memA.id });
    const source = await db.node.create({
      data: {
        id: generateId(), memoryId: memA.id, loc: 'tomb-source', name: 'Source', content: 'source body',
        authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 2,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
      },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: memA.id, loc: 'tomb-dest', name: 'Old', content: 'old body',
        data: { leftover: true }, deletedAt: new Date('2026-09-25T00:00:00Z'),
      },
    });
    const resurrected = await M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('tomb-dest') }, asUser());
    const row = await db.node.findUniqueOrThrow({ where: { id: resurrected.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.data).toEqual({ leftover: true });
    expect(row).toMatchObject({
      authorshipKind: null, authoredByTask: null, authoredByRevision: null, authoredByHuman: null, authoredAt: null,
    });

    // Control: the same source cloned onto a FRESH loc still carries the claim.
    const fresh = await M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('tomb-fresh') }, asUser());
    expect(fresh).toMatchObject({ authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 2 });
  });

  it('copies the authored fields that are part of the task stamp', async () => {
    const task = await createDbNode(db, { loc: 'copy-task', memoryId: memA.id });
    const source = await db.node.create({
      data: {
        id: generateId(), memoryId: memA.id, loc: 'copy-fields', name: 'Fields',
        alias: 'shortcut', isLink: true, llmModel: 'model-x', aiAgent: 'agent-x',
        authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 1,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
      },
    });
    const clone = await M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('copy-fields-new') }, asUser());
    expect(clone).toMatchObject({
      alias: 'shortcut', isLink: true, llmModel: 'model-x', aiAgent: 'agent-x',
      authorshipKind: 'TASK', authoredByTask: task.id,
    });
  });

  it('carries attribution with an open role because the authored fields are copied', async () => {
    const source = await db.node.create({
      data: {
        id: generateId(), memoryId: memA.id, loc: 'copy-role', name: 'Role', role: 'weather',
        authorshipKind: 'TASK', authoredByTask: generateId(), authoredByRevision: 1,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
      },
    });
    const clone = await M.cloneNode(null, { sourceRef: source.id, targetUrn: urnA('copy-role-new') }, asUser());
    expect(clone).toMatchObject({ role: 'weather', authorshipKind: 'TASK', authoredByTask: source.authoredByTask });
  });

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
