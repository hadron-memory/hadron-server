/**
 * extractParentNodeToMemory — extract a parent node + its loc-subtree into a
 * brand-new memory, rebasing the parent to root.
 *
 *   extractParentNodeToMemory(parentRef, targetUrn, move = false): Memory!
 *
 * copy (default) leaves the source intact; move soft-deletes the source
 * subtree. Locs rebase (parent → slug, parentLoc:x → slug:x). Only edges wholly
 * inside the subtree carry over (loc re-derived); boundary-crossing edges drop.
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
let user: { id: string };

const asAdmin = () => ctx({ userId: user.id, roles: ['ADMIN'] });
const edge = (sourceId: string, targetId: string, loc: string) =>
  db.edge.create({ data: { id: generateId(), memoryId: memA.id, sourceId, targetId, loc, name: 'rel' } });

/** A parent subtree: findings:auth (+ 2 descendants), a sibling, an outsider. */
async function seedSubtree() {
  const parent = await createDbNode(db, { loc: 'findings:auth', memoryId: memA.id, content: 'auth root' });
  const oauth = await createDbNode(db, { loc: 'findings:auth:oauth', memoryId: memA.id, content: 'oauth' });
  const saml = await createDbNode(db, { loc: 'findings:auth:saml:deep', memoryId: memA.id, content: 'saml' });
  const sibling = await createDbNode(db, { loc: 'findings:authz', memoryId: memA.id }); // NOT swept
  const outsider = await createDbNode(db, { loc: 'other', memoryId: memA.id });
  return { parent, oauth, saml, sibling, outsider };
}

beforeEach(async () => {
  await cleanDb(db);
  const a = await createDbOrgAndGraph(db, { orgName: 'ex-org', graphName: 'src', visibility: 'ORGANIZATION' });
  org = a.org;
  memA = a.graph as any;
  user = await db.user.create({ data: { githubId: 9200, githubUsername: 'ex-user', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
});

describe('extractParentNodeToMemory — copy (default)', () => {
  it('reconciles a raw-edited stamped source before carrying attribution', async () => {
    const { parent, oauth } = await seedSubtree();
    await db.node.update({
      where: { id: oauth.id },
      data: {
        authorshipKind: 'TASK', authoredByTask: generateId(), authoredByRevision: 1,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
        revisionContentHash: 'refresh',
      },
    });
    await db.node.update({ where: { id: oauth.id }, data: { content: 'raw edited oauth' } });
    const mem = await M.extractParentNodeToMemory(
      null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin(),
    );
    expect(await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'extracted:oauth' } }))
      .toMatchObject({ content: 'raw edited oauth', authorshipKind: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: oauth.id } }))
      .toMatchObject({ authorshipKind: null, revSeq: 2 });
  });

  it('extracts the subtree into a new memory, rebasing the parent to root', async () => {
    const { parent } = await seedSubtree();
    const mem = await M.extractParentNodeToMemory(
      null,
      { parentRef: parent.id, targetUrn: 'ex-org::extracted' },
      asAdmin(),
    );
    expect(mem.urn).toBe('ex-org:extracted');
    expect(mem.class).toBe('knowledge');

    const locs = (await db.node.findMany({ where: { memoryId: mem.id }, select: { loc: true } }))
      .map((n) => n.loc)
      .sort();
    expect(locs).toEqual(['extracted', 'extracted:oauth', 'extracted:saml:deep']);
  });

  it('leaves the source subtree intact (copy)', async () => {
    const { parent, oauth } = await seedSubtree();
    await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin());
    const src = await db.node.findMany({ where: { memoryId: memA.id, deletedAt: null } });
    expect(src.map((n) => n.loc).sort()).toContain('findings:auth');
    expect(await db.node.findUnique({ where: { id: oauth.id } })).toMatchObject({ deletedAt: null });
  });

  it('does NOT sweep in a sibling that merely shares a loc prefix', async () => {
    const { parent } = await seedSubtree();
    const mem = await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin());
    const locs = (await db.node.findMany({ where: { memoryId: mem.id }, select: { loc: true } })).map((n) => n.loc);
    expect(locs).not.toContain('extracted:authz'); // findings:authz was a sibling, not a child
  });

  it('carries intra-subtree edges with a re-derived loc, dropping boundary-crossing ones', async () => {
    const { parent, oauth, outsider } = await seedSubtree();
    await edge(parent.id, oauth.id, 'findings:auth:rel:findings:auth:oauth'); // inside → carried
    await edge(oauth.id, outsider.id, 'findings:auth:oauth:rel:other'); // crosses → dropped
    const mem = await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin());
    const edges = await db.edge.findMany({ where: { memoryId: mem.id, deletedAt: null } });
    expect(edges).toHaveLength(1);
    expect(edges[0].loc).toBe('extracted:rel:extracted:oauth');
  });

  it('enables the contentChunks vector index on the knowledge extract', async () => {
    const { parent } = await seedSubtree();
    const mem = await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin());
    expect(mem.vectorIndexEnabled).toBe(true);
    expect(mem.embeddingSource).toBe('contentChunks');
    const pending = await db.node.count({ where: { memoryId: mem.id, embeddingPendingAt: { not: null } } });
    expect(pending).toBe(3); // every extracted node stamped for the sweep
  });
});

describe('extractParentNodeToMemory — move', () => {
  it('soft-deletes the source subtree, leaving unrelated nodes alone', async () => {
    const { parent, oauth, saml, sibling, outsider } = await seedSubtree();
    const mem = await M.extractParentNodeToMemory(
      null,
      { parentRef: parent.id, targetUrn: 'ex-org::extracted', move: true },
      asAdmin(),
    );
    // Subtree gone from source
    for (const n of [parent, oauth, saml]) {
      expect(await db.node.findUnique({ where: { id: n.id } })).toMatchObject({ deletedAt: expect.any(Date) });
    }
    // Sibling + outsider untouched
    for (const n of [sibling, outsider]) {
      expect(await db.node.findUnique({ where: { id: n.id } })).toMatchObject({ deletedAt: null });
    }
    // New memory has the full subtree
    expect(await db.node.count({ where: { memoryId: mem.id, deletedAt: null } })).toBe(3);
  });

  it('soft-deletes a boundary-crossing edge touching the moved subtree', async () => {
    const { parent, oauth, outsider } = await seedSubtree();
    const crossing = await edge(oauth.id, outsider.id, 'findings:auth:oauth:rel:other');
    await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted', move: true }, asAdmin());
    expect(await db.edge.findUnique({ where: { id: crossing.id } })).toMatchObject({ deletedAt: expect.any(Date) });
  });
});

describe('extractParentNodeToMemory — class + governance preservation', () => {
  it('keeps a group source member-restricted (GROUP visibility + owner member), not org-wide', async () => {
    const group = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'ex-org:grp', name: 'grp', class: 'group', visibility: 'GROUP' },
    });
    const parent = await createDbNode(db, { loc: 'topic', memoryId: group.id, content: 'topic root' });
    await createDbNode(db, { loc: 'topic:sub', memoryId: group.id });

    const mem = await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::grp-out' }, asAdmin());
    expect(mem.class).toBe('group'); // NOT widened to knowledge/ORGANIZATION
    expect(mem.visibility).toBe('GROUP');
    const owner = await db.memoryMember.findFirst({ where: { memoryId: mem.id, userId: user.id, role: 'owner' } });
    expect(owner).not.toBeNull(); // never persisted zero-owner
  });

  it('carries requiresLicense over from the source (no license leak)', async () => {
    await db.memory.update({ where: { id: memA.id }, data: { requiresLicense: true } });
    const { parent } = await seedSubtree();
    const mem = await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin());
    expect(mem.requiresLicense).toBe(true);
  });
});

describe('extractParentNodeToMemory — move edge cases', () => {
  it('does NOT soft-delete an incoming edge that lives in another memory', async () => {
    const { parent, oauth } = await seedSubtree();
    const memB = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'ex-org:other', name: 'other', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    const bNode = await createDbNode(db, { loc: 'b-root', memoryId: memB.id });
    // Edge lives in memB (its source node's memory), pointing INTO the moved subtree.
    const incoming = await db.edge.create({
      data: { id: generateId(), memoryId: memB.id, sourceId: bNode.id, targetId: oauth.id, loc: 'b-root:rel:findings:auth:oauth', name: 'rel' },
    });
    await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted', move: true }, asAdmin());
    // memB is not writable via this call — its edge must survive (even if now dangling).
    expect(await db.edge.findUnique({ where: { id: incoming.id } })).toMatchObject({ deletedAt: null });
  });

  it('soft-deletes the moved nodes\' pending edges and decrements pendingEdgeCount', async () => {
    const { parent, oauth } = await seedSubtree();
    const pending = await db.pendingEdge.create({
      data: { id: generateId(), sourceId: oauth.id, targetId: 'ex-org::src::ghost', name: 'rel' },
    });
    await db.memory.update({ where: { id: memA.id }, data: { pendingEdgeCount: 1 } });
    await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted', move: true }, asAdmin());
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memA.id } })).toMatchObject({ pendingEdgeCount: 0 });
  });

  it('rejects a move that would empty the source memory', async () => {
    const root = await createDbNode(db, { loc: 'src', memoryId: memA.id });
    await createDbNode(db, { loc: 'src:child', memoryId: memA.id }); // whole live set is the subtree
    await expect(
      M.extractParentNodeToMemory(null, { parentRef: root.id, targetUrn: 'ex-org::extracted', move: true }, asAdmin()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('the empty-source guard is rename-proof (does not rely on Memory.name)', async () => {
    const root = await createDbNode(db, { loc: 'orig', memoryId: memA.id });
    await createDbNode(db, { loc: 'orig:child', memoryId: memA.id });
    // Rename the memory — the root node loc stays 'orig', name no longer matches.
    await db.memory.update({ where: { id: memA.id }, data: { name: 'renamed' } });
    await expect(
      M.extractParentNodeToMemory(null, { parentRef: root.id, targetUrn: 'ex-org::extracted', move: true }, asAdmin()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('allows a move that leaves at least one node outside the subtree', async () => {
    const { parent } = await seedSubtree(); // sibling + outsider remain
    const mem = await M.extractParentNodeToMemory(
      null,
      { parentRef: parent.id, targetUrn: 'ex-org::extracted', move: true },
      asAdmin(),
    );
    expect(mem.id).toBeTruthy();
  });

  it('treats an extract from a soft-deleted source memory as NODE_NOT_FOUND', async () => {
    const { parent } = await seedSubtree();
    await db.memory.update({ where: { id: memA.id }, data: { deletedAt: new Date() } });
    await expect(
      M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin()),
    ).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
  });
});

describe('extractParentNodeToMemory — edge-loc collisions', () => {
  it('keeps both parallel edges when their derived locs would collide', async () => {
    const { parent, oauth } = await seedSubtree();
    // Two edges parent→oauth whose names sanitize to the same atom ('rel').
    await edge(parent.id, oauth.id, 'findings:auth:rel:findings:auth:oauth');
    await db.edge.create({
      data: { id: generateId(), memoryId: memA.id, sourceId: parent.id, targetId: oauth.id, loc: 'findings:auth:rel-two:findings:auth:oauth', name: 'rel!' },
    });
    const mem = await M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin());
    const edges = await db.edge.findMany({ where: { memoryId: mem.id, deletedAt: null }, orderBy: { loc: 'asc' } });
    expect(edges).toHaveLength(2); // neither silently dropped
    expect(edges.map((e) => e.loc)).toEqual(['extracted:rel:extracted:oauth', 'extracted:rel:extracted:oauth:2']);
  });
});

describe('extractParentNodeToMemory — personal source stays owner-owned', () => {
  it('extracts a personal subtree into a new personal memory owned by the caller', async () => {
    const personal = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'ex-org:notes', name: 'notes',
        class: 'personal', visibility: null, userId: user.id,
      },
    });
    const parent = await createDbNode(db, { loc: 'ideas', memoryId: personal.id, content: 'idea root' });
    await createDbNode(db, { loc: 'ideas:one', memoryId: personal.id });

    const mem = await M.extractParentNodeToMemory(
      null,
      { parentRef: parent.id, targetUrn: 'ex-org::ideas-out' },
      ctx({ userId: user.id, roles: ['READER'] }), // owner, no platform-admin bypass
    );
    expect(mem.class).toBe('personal');
    expect(mem.userId).toBe(user.id);
    expect(mem.visibility).toBeNull();
    expect(mem.vectorIndexEnabled).toBe(false); // personal keeps the column default
    const locs = (await db.node.findMany({ where: { memoryId: mem.id }, select: { loc: true } })).map((n) => n.loc).sort();
    expect(locs).toEqual(['ideas-out', 'ideas-out:one']);
  });
});

describe('extractParentNodeToMemory — guards', () => {
  it('throws NODE_NOT_FOUND for a missing parent', async () => {
    await expect(
      M.extractParentNodeToMemory(null, { parentRef: `${memA.urn}:ghost`, targetUrn: 'ex-org::extracted' }, asAdmin()),
    ).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
  });

  it('rejects an encrypted source', async () => {
    await db.memory.update({ where: { id: memA.id }, data: { isEncrypted: true } });
    const parent = await createDbNode(db, { loc: 'findings:auth', memoryId: memA.id });
    await expect(
      M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin()),
    ).rejects.toMatchObject({ extensions: { code: 'ENCRYPTED_MEMORY_EXTRACT_UNSUPPORTED' } });
  });

  it('rejects a system-class source', async () => {
    const sys = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'ex-org:sys', name: 'sys', class: 'system', visibility: null },
    });
    const parent = await createDbNode(db, { loc: 'root', memoryId: sys.id });
    await expect(
      M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin()),
    ).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } });
  });

  it('rejects a collision with an existing live memory URN', async () => {
    const { parent } = await seedSubtree();
    await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'ex-org:extracted', name: 'extracted', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    await expect(
      M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: 'ex-org::extracted' }, asAdmin()),
    ).rejects.toThrow(/already exists/);
  });
});
