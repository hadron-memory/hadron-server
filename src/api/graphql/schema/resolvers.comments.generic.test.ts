/**
 * #1606 — generic paths never create, convert, edit, move or remove a comment
 * (cor:dmo:110:04), and a target's lifecycle carries its threads (110:02/05).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let orgId: string;
let memory: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
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

  it('restoreNodeRevision cannot restore a comment\'s history', async () => {
    const target = await node('g:5');
    const c = await comment(target.id, 'v1');
    await M.editComment(null, { commentRef: c.id, body: 'v2', expectedRevision: 1 }, as());
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

  it('a comment never moves on its own', async () => {
    const target = await node('mv:2');
    const c = await comment(target.id);
    expect((await errorOf(M.moveNode(null, { sourceRef: c.id, targetUrn: nodeUrn(memory, 'elsewhere') }, as()))).extensions)
      .toMatchObject(governed);
  });

  it('mergeNodes refuses a comment, and a source with live threads', async () => {
    const a = await node('mg:a');
    const b = await node('mg:b');
    const c = await comment(a.id);
    expect((await errorOf(M.mergeNodes(null, { input: { source: c.id, target: b.id, include: ['CONTENT'] } }, as()))).extensions)
      .toMatchObject(governed);
    expect((await errorOf(M.mergeNodes(null, { input: { source: a.id, target: b.id, include: ['EDGES'], deleteSource: true } }, as()))).extensions)
      .toMatchObject(governed);
  });
});
