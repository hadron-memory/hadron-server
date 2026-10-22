import { withIncludeHistoryClientTransaction } from '../../../lib/includes/includeHistoryFence.js';
/**
 * #1606 — generic paths never create, convert, edit, move or remove a comment
 * (cor:dmo:110:04), and a target's lifecycle carries its threads (110:02/05).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, buildSchema, graphql } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import * as approvalHash from '../../../lib/approvalHash.js';
import { isCiphertext, parseDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { buildNodeRevisionSnapshot, createNodeRevision, editorFromAuth } from '../../../lib/nodeRevisionSnapshot.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let orgId: string;
let memory: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
/** A comment revision as the comment path wrote them before #1721 (it writes none now). */
const legacyRevision = async (id: string) => {
  const row = await db.node.findUniqueOrThrow({ where: { id } });
  await withIncludeHistoryClientTransaction(db, (tx) => createNodeRevision(tx, buildNodeRevisionSnapshot(row, editorFromAuth({ userId: admin.id }), { revLabel: 'edit', changes: ['content'] })));
};
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const nodeUrn = (m: { urn: string }, loc: string) => `hrn:node:${m.urn}:${loc}`;
const node = (loc: string, memoryId = memory.id) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: `Title ${loc}`, content: `Body ${loc}` },
});
const comment = (targetRef: string, body = 'feedback') => M.createComment(null, { targetRef, body }, as());
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};
const governed = { code: 'ROLE_GOVERNED', kind: 'comment' };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Generic Org', urn: 'generic.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 160611, githubUsername: 'gen-admin', handle: 'gen-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'generic' }, as());
});

describe('generic node writes refuse comments (cor:dmo:110:04)', () => {
  it('createNode / updateNode cannot make, edit or unmake a comment', async () => {
    const target = await node('g:1');
    const c = await comment(target.id);
    expect((await errorOf(M.createNode(null, { input: { memoryId: memory.id, loc: 'g:2', name: 'x', nodeType: 'comment' } }, as()))).extensions)
      .toMatchObject({ ...governed, refusal: 'produces' });
    expect((await errorOf(M.updateNode(null, { input: { id: target.id, nodeType: 'comment' } }, as()))).extensions)
      .toMatchObject({ ...governed, refusal: 'produces' });
    expect((await errorOf(M.updateNode(null, { input: { id: c.id, content: 'rewritten' } }, as()))).extensions)
      .toMatchObject({ ...governed, refusal: 'edits' });
    expect((await errorOf(M.updateNode(null, { input: { id: c.id, nodeType: 'info' } }, as()))).extensions)
      .toMatchObject({ ...governed, refusal: 'removes' });
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('feedback');
  });

  it('MCP hadron_update_node and hadron_create_node refuse too', async () => {
    const target = await node('g:3');
    const c = await comment(target.id);
    const mcp = createTestableMcpServer({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
    expect(await mcp.callToolText('hadron_update_node', { urn: nodeUrn(memory, c.loc), content: 'x' })).toMatch(/\[role_governed\]/);
    expect(await mcp.callToolText('hadron_create_node', { urn: nodeUrn(memory, 'g:4'), name: 'x', nodeType: 'comment' })).toMatch(/\[role_governed\]/);
    expect(await mcp.callToolText('hadron_delete_node', { urn: nodeUrn(memory, c.loc) })).toMatch(/\[role_governed\]/);
  });

  it('restoreNodeRevision cannot restore a comment\'s (pre-#1721) history', async () => {
    const target = await node('g:5');
    const c = await comment(target.id, 'v1');
    await legacyRevision(c.id);
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: c.id } });
    expect((await errorOf(M.restoreNodeRevision(null, { revisionId: rev.id }, as()))).extensions).toMatchObject(governed);
  });

  it('replace_text skips comments and reports them as governed', async () => {
    const target = await node('g:6');
    await comment(target.id, 'Body appears here too');
    const result = await M.searchReplaceInNodes(null, {
      input: { oldText: 'Body', newText: 'Text', memoryIds: [memory.id], fields: ['CONTENT'] },
    }, as());
    expect(result.skipCounts.governed).toBe(1);
    expect((await db.node.findFirstOrThrow({ where: { nodeType: 'comment' } })).content).toBe('Body appears here too');
  });

  it('generic edge writes cannot alter or remove a governed edge', async () => {
    const target = await node('g:7');
    const c = await comment(target.id);
    const edge = await db.edge.findFirstOrThrow({ where: { sourceId: c.id } });
    expect((await errorOf(M.updateEdge(null, { edgeRef: edge.id, name: 'renamed' }, as()))).extensions).toMatchObject(governed);
    expect((await errorOf(M.deleteEdge(null, { edgeRef: edge.id }, as()))).extensions).toMatchObject(governed);
  });

  it('cloneMemory leaves comments behind', async () => {
    const target = await node('g:8');
    await comment(target.id);
    const clone = await M.cloneMemory(null, { ref: memory.id, targetUrn: 'hrn:mem:generic.example:generic-clone' }, as());
    expect(await db.node.count({ where: { memoryId: clone.id, nodeType: 'comment' } })).toBe(0);
    expect(await db.node.count({ where: { memoryId: clone.id, loc: 'g:8' } })).toBe(1);
  });
});

describe('a target\'s lifecycle carries its threads (cor:dmo:110:02/05)', () => {
  it('deleteNode on a comment refuses; a soft delete of the target takes its threads, and recreating it restores them', async () => {
    const target = await node('l:1');
    const adminDeleted = await comment(target.id, 'gone');
    await M.deleteCommentThread(null, { commentRef: adminDeleted.id, reason: 'spam' }, as());
    const kept = await comment(target.id, 'kept');
    expect((await errorOf(M.deleteNode(null, { nodeRef: kept.id }, as()))).extensions).toMatchObject({ ...governed, refusal: 'removes' });

    await M.deleteNode(null, { nodeRef: target.id }, as());
    expect(await db.commentMeta.findUniqueOrThrow({ where: { nodeId: kept.id } })).toMatchObject({ threadDeletedCause: 'TARGET' });
    expect(await Q.comment(null, { ref: kept.id }, as())).toBeNull();

    await M.createNode(null, { input: { memoryId: memory.id, loc: 'l:1', name: 'Title l:1' } }, as());
    expect(await Q.comment(null, { ref: kept.id }, as())).toMatchObject({ body: 'kept' });
    // A thread an admin deleted stays deleted.
    expect(await Q.comment(null, { ref: adminDeleted.id }, as())).toBeNull();
  });

  it('a hard delete of the target hard-deletes its threads', async () => {
    const target = await node('l:2');
    const c = await comment(target.id);
    await M.replyToComment(null, { commentRef: c.id, body: 'r' }, as());
    await M.deleteNode(null, { nodeRef: target.id, hard: true }, as());
    expect(await db.commentMeta.count()).toBe(0);
    expect(await db.node.count({ where: { nodeType: 'comment' } })).toBe(0);
  });

  it('a cross-memory move carries the threads; a commentable-class check refuses private', async () => {
    const target = await node('mv:1');
    const c = await comment(target.id);
    const reply = await M.replyToComment(null, { commentRef: c.id, body: 'r' }, as());
    const dest = await resolvers.Mutation.createMemory(null, { orgId, name: 'dest' }, as());
    await M.moveNode(null, { sourceRef: target.id, targetUrn: nodeUrn(dest, 'mv:1') }, as());
    for (const id of [c.id, reply.id]) {
      expect((await db.node.findUniqueOrThrow({ where: { id } })).memoryId).toBe(dest.id);
      expect((await db.edge.findFirstOrThrow({ where: { sourceId: id } })).memoryId).toBe(dest.id);
    }
    const page = await Q.commentThreads(null, { targetRef: target.id }, as());
    expect(page.total).toBe(1);

    const priv = await resolvers.Mutation.createMemory(null, { orgId, name: 'priv' }, as());
    await db.memory.update({ where: { id: priv.id }, data: { class: 'private', userId: admin.id, visibility: null } });
    expect((await errorOf(M.moveNode(null, { sourceRef: target.id, targetUrn: nodeUrn(priv, 'mv:1') }, as()))).extensions)
      .toMatchObject({ code: 'COMMENT_MOVE_UNCOMMENTABLE', class: 'private', nodes: [{ nodeId: target.id, loc: 'mv:1', comments: 2 }] });
  });

  it('a move into a system memory carries the threads (#1935: only private refuses)', async () => {
    const target = await node('mv:sys');
    const c = await comment(target.id);
    const sys = await resolvers.Mutation.createMemory(null, { orgId, name: 'sys-dest' }, as());
    await db.memory.update({ where: { id: sys.id }, data: { class: 'system', visibility: null } });
    // #2206: a system memory is written as a live Agent's definition, by whoever manages that Agent.
    await db.agent.create({ data: { id: generateId(), name: 'Sys Agent', urn: `${sys.urn}-agent`, organizationId: orgId, systemMemoryId: sys.id } });
    await M.moveNode(null, { sourceRef: target.id, targetUrn: nodeUrn(sys, 'mv:sys') }, as());
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).memoryId).toBe(sys.id);
  });

  it('a comment never moves on its own', async () => {
    const target = await node('mv:2');
    const c = await comment(target.id);
    expect((await errorOf(M.moveNode(null, { sourceRef: c.id, targetUrn: nodeUrn(memory, 'elsewhere') }, as()))).extensions)
      .toMatchObject(governed);
  });

  it('mergeNodes refuses a comment, and deleting a source with live threads', async () => {
    const a = await node('mg:a');
    const b = await node('mg:b');
    const c = await comment(a.id);
    expect((await errorOf(M.mergeNodes(null, { input: { source: c.id, target: b.id, include: ['CONTENT'] } }, as()))).extensions)
      .toMatchObject(governed);
    // #1664 — a commented source can't be deleted by a merge (its anchor can't move).
    expect((await errorOf(M.mergeNodes(null, { input: { source: a.id, target: b.id, include: ['EDGES'], deleteSource: true } }, as()))).extensions)
      .toMatchObject({ code: 'COMMENT_MERGE_FOLDS_THREADS' });
  });
});

describe('#1663 review cycle', () => {
  const reader = async () => {
    const u = await db.user.create({ data: { githubId: 160699, githubUsername: 'gen-reader', roles: [] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role: 'READER' } });
    return u;
  };

  it('a delete that leaves a stub blanks the live row: generic node reads serve no text, and a stub\'s legacy history is for managers only', async () => {
    const r = await reader();
    const target = await node('st:1');
    const c = await comment(target.id, 'secret words');
    // #1721: an edit keeps no history; the snapshot below stands for a
    // revision written before #1721, which the concealment gate still guards.
    await legacyRevision(c.id);
    await M.editComment(null, { commentRef: c.id, body: 'secret words v2', quote: 'q', expectedRevision: 2 }, as());
    await M.replyToComment(null, { commentRef: c.id, body: 'keeps the stub' }, as());
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: 3 }, as());
    const raw = await db.node.findUniqueOrThrow({ where: { id: c.id } });
    expect(raw.content).toBeNull();
    expect((raw.data as { quote: string | null }).quote).toBeNull();
    expect(JSON.stringify(raw.data)).not.toContain('secret words v2');
    const generic = await Q.node(null, { ref: c.id }, as(r.id));
    expect(generic?.content ?? null).toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId: c.id } })).toBe(1);
    expect(await Q.nodeRevisions(null, { nodeRef: c.id }, { ...as(r.id), roles: ['READER'] })).toEqual([]);
    const adminHistory = await Q.nodeRevisions(null, { nodeRef: c.id }, { ...as(), roles: ['ADMIN'] });
    expect(adminHistory.map((h: { content: string | null }) => h.content)).toEqual(['secret words']);
    const revId = (await db.nodeRevision.findFirstOrThrow({ where: { nodeId: c.id } })).id;
    expect(await Q.nodeRevision(null, { revisionId: revId }, { ...as(r.id), roles: ['READER'] })).toBeNull();
    expect(await Q.nodeRevision(null, { revisionId: revId }, { ...as(), roles: ['ADMIN'] })).not.toBeNull();
  });

  it('deleting a thread frees its author\'s open-thread allowance, stub or not', async () => {
    const target = await node('st:2');
    const c = await comment(target.id);
    await M.replyToComment(null, { commentRef: c.id, body: 'r' }, as());
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: 1 }, as());
    await comment(target.id, 'a new thread');
  });

  it('an admin thread delete clears a node for a move into a private memory; deleted threads follow their target', async () => {
    const target = await node('st:3');
    const c = await comment(target.id);
    const priv = await resolvers.Mutation.createMemory(null, { orgId, name: 'priv-dest', memoryClass: 'private' }, as());
    expect((await errorOf(M.moveNode(null, { sourceRef: target.id, targetUrn: nodeUrn(priv, 'st:3') }, as()))).extensions)
      .toMatchObject({ code: 'COMMENT_MOVE_UNCOMMENTABLE' });
    await M.deleteCommentThread(null, { commentRef: c.id, reason: 'clearing for the move' }, as());
    await M.moveNode(null, { sourceRef: target.id, targetUrn: nodeUrn(priv, 'st:3') }, as());
    // The deleted thread's history moved with it (same memory, kept for audit).
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).memoryId).toBe(priv.id);
  });

  it('an old-revision anchor in another memory needs read access to that memory (Atilla P2-3)', async () => {
    const writer = await db.user.create({ data: { githubId: 160698, githubUsername: 'gen-writer', roles: [] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: writer.id, role: 'CONTRIBUTOR' } });
    const priv = await resolvers.Mutation.createMemory(null, { orgId, name: 'priv-src', memoryClass: 'private' }, as());
    const target = await node('an:1', priv.id);
    await M.updateNode(null, { input: { id: target.id, content: 'second' } }, as());
    await M.moveNode(null, { sourceRef: target.id, targetUrn: nodeUrn(memory, 'an:1') }, as());
    expect((await errorOf(M.createComment(null, { targetRef: target.id, body: 'x', anchorRevision: 1 }, as(writer.id)))).extensions)
      .toMatchObject({ code: 'COMMENT_ANCHOR_REVISION_UNAVAILABLE' });
    // The owner of the old memory may anchor there.
    const ok = await M.createComment(null, { targetRef: target.id, body: 'x', anchorRevision: 1 }, as());
    expect(ok.anchorRevision).toBe(1);
  });
});

describe('#1663 review — encrypted memories (local P2-2)', () => {
  const dataKey = Buffer.alloc(32, 9).toString('base64');

  it('encrypts body, quote and reasons at rest, reads them back with the key, and refuses SESSION_EXPIRED without it', async () => {
    // An org memory is encrypted by its org App, not a user (encryptMemory);
    // the state is set up directly, with the target's content encrypted.
    const enc = await resolvers.Mutation.createMemory(null, { orgId, name: 'enc-comments' }, as());
    const key = parseDataKey(dataKey);
    await db.memory.update({ where: { id: enc.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    const target = await db.node.create({
      data: { id: generateId(), memoryId: enc.id, loc: 'e:1', name: 'Title e:1', ...encryptNodeFieldsWithKey({ content: 'Body e:1' }, key) },
    });
    sessionKeyCache.set('comment-test', enc.id, key);
    try {
      const hashSpy = vi.spyOn(approvalHash, 'computeApprovalHash');
      const c = await M.createComment(null, { targetRef: target.id, body: 'private feedback', quote: 'quoted' }, as());
      expect(hashSpy).not.toHaveBeenCalled();
      hashSpy.mockRestore();
      expect(c).toMatchObject({ body: 'private feedback', quote: 'quoted' });
      // #1857: the revision anchors encrypted feedback without a fingerprint.
      expect(c.anchorApprovalHash).toBeNull();
      expect((await db.edge.findFirstOrThrow({ where: { sourceId: c.id, governedKind: 'COMMENT_ANCHOR' } })).anchorApprovalHash).toBeNull();
      const reply = await M.replyToComment(null, { commentRef: c.id, body: 'reply' }, as());
      expect(reply.anchorApprovalHash).toBeNull();
      expect((await Q.comment(null, { ref: c.id }, as())).anchorApprovalHash).toBeNull();
      const response = await graphql({ schema: buildSchema(typeDefs),
        source: '{ comment(ref: "ignored") { anchorRevision anchorApprovalHash } }',
        rootValue: { comment: () => c } });
      expect(response.errors).toBeUndefined();
      expect(response.data?.comment).toEqual({ anchorRevision: 1, anchorApprovalHash: null });
      const stored = await db.node.findUniqueOrThrow({ where: { id: c.id } });
      expect(isCiphertext(stored.content)).toBe(true);
      expect(JSON.stringify(stored.data)).not.toContain('quoted');
      const edited = await M.editComment(null, { commentRef: c.id, body: 'edited', expectedRevision: 1 }, as());
      expect(edited.body).toBe('edited');
      const page = await Q.commentThreads(null, { targetRef: target.id }, as());
      expect(page.items[0].root).toMatchObject({ body: 'edited', quote: 'quoted' });
      sessionKeyCache.clear();
      expect((await errorOf(M.createComment(null, { targetRef: target.id, body: 'x' }, as()))).extensions).toMatchObject({ code: 'SESSION_EXPIRED' });
      expect((await errorOf(Q.commentThreads(null, { targetRef: target.id }, as()))).extensions).toMatchObject({ code: 'SESSION_EXPIRED' });
    } finally {
      vi.restoreAllMocks();
      sessionKeyCache.clear();
    }
  });

  // Rook P3-1 (#1866): the retained snapshot arm must never compute a fingerprint.
  it('an older revision in the same encrypted memory anchors without computing or storing a hash', async () => {
    const enc = await resolvers.Mutation.createMemory(null, { orgId, name: 'enc-old-revision' }, as());
    const key = parseDataKey(dataKey);
    await db.memory.update({ where: { id: enc.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    const target = await db.node.create({ data: {
      id: generateId(), memoryId: enc.id, loc: 'e:old', name: 'Old revision target',
      ...encryptNodeFieldsWithKey({ content: 'first secret' }, key),
    } });
    sessionKeyCache.set('comment-old-revision', enc.id, key);
    try {
      await M.updateNode(null, { input: { id: target.id, content: 'second secret' } }, as());
      expect((await db.node.findUniqueOrThrow({ where: { id: target.id } })).revSeq).toBe(2);
      const snapshot = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: target.id, revNo: 1 } });
      expect(snapshot.memoryId).toBe(enc.id);
      expect(isCiphertext(snapshot.content)).toBe(true);
      const hashSpy = vi.spyOn(approvalHash, 'computeApprovalHash');
      const c = await M.createComment(null, { targetRef: target.id, body: 'older feedback', anchorRevision: 1 }, as());
      expect(hashSpy).not.toHaveBeenCalled();
      expect(c).toMatchObject({ anchorRevision: 1, anchorApprovalHash: null });
      expect((await db.edge.findFirstOrThrow({ where: { sourceId: c.id, governedKind: 'COMMENT_ANCHOR' } })))
        .toMatchObject({ anchorRevNo: 1, anchorApprovalHash: null });
    } finally {
      vi.restoreAllMocks();
      sessionKeyCache.clear();
    }
  });

  it('migration retains existing encrypted fingerprints and leaves their immutability guard intact', async () => {
    const target = await node('e:legacy');
    const c = await comment(target.id);
    const edge = await db.edge.findFirstOrThrow({ where: { sourceId: c.id, governedKind: 'COMMENT_ANCHOR' } });
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(readFileSync(new URL('../../../../prisma/migrations/20261013170000_encrypted_comment_anchor_nullable/migration.sql', import.meta.url), 'utf8'));
      // The replay installs that migration's invariants; restore the current
      // ones, as the later migrations do in prod, so no later test file on
      // this worker's database runs against a stale check (#1935).
      await client.query(readFileSync(new URL('../../../../prisma/comment-invariants.sql', import.meta.url), 'utf8'));
    } finally { await client.end(); }
    expect((await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).anchorApprovalHash).toBe(edge.anchorApprovalHash);
    await expect(db.$executeRaw`UPDATE edges SET anchor_approval_hash = NULL WHERE id = ${edge.id}`)
      .rejects.toThrow(/immutable/);
  });

  it('a plaintext target still hashes an old-revision snapshot in another, encrypted memory with its key, else UNAVAILABLE', async () => {
    const src = await resolvers.Mutation.createMemory(null, { orgId, name: 'enc-src' }, as());
    const target = await node('e:2', src.id);
    await M.updateNode(null, { input: { id: target.id, content: 'second' } }, as());
    await M.moveNode(null, { sourceRef: target.id, targetUrn: nodeUrn(memory, 'e:2') }, as());
    // Encrypt the source memory's retained snapshot, as encryptMemory would.
    const key = parseDataKey(dataKey);
    await db.memory.update({ where: { id: src.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    const snap = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: target.id, revNo: 1 } });
    expect(snap.memoryId).toBe(src.id);
    await db.nodeRevision.update({ where: { id: snap.id }, data: encryptNodeFieldsWithKey({ content: snap.content }, key) });
    sessionKeyCache.clear();
    expect((await errorOf(M.createComment(null, { targetRef: target.id, body: 'x', anchorRevision: 1 }, as()))).extensions)
      .toMatchObject({ code: 'COMMENT_ANCHOR_REVISION_UNAVAILABLE' });
    sessionKeyCache.set('comment-test-src', src.id, key);
    try {
      const c = await M.createComment(null, { targetRef: target.id, body: 'x', anchorRevision: 1 }, as());
      expect(c.anchorApprovalHash).toBe(computeApprovalHash({ title: 'Title e:2', abstract: null, content: 'Body e:2' }));
    } finally {
      sessionKeyCache.clear();
    }
  });
});
