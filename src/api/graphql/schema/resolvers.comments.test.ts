/** #1606 — the comment path (cor:dmo:110): create, reply, edit, retract, resolve, hide, delete, reads. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let writer: { id: string };
let reader: { id: string };
let outsider: { id: string };
let orgId: string;
let memory: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const C = (resolvers as unknown as { Comment: Record<string, (c: any, a: unknown, ctx: Context) => unknown> }).Comment;
const nodeSummary = (resolvers as unknown as { Node: { commentSummary: (n: unknown, a: unknown, c: Context) => Promise<any> } }).Node.commentSummary;

const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: `Body ${loc}`, ...extra },
});
const comment = (targetRef: string, body = 'Looks off', userId = writer.id, extra: Record<string, unknown> = {}) =>
  M.createComment(null, { targetRef, body, ...extra }, as(userId));
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};
const hashOf = (n: { name: string; abstract: string | null; content: string | null }) =>
  computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Comment Org', urn: 'comment.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 160601, githubUsername: 'cm-admin', handle: 'cm-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 160602, githubUsername: 'cm-writer', handle: 'cm-writer', roles: [] } });
  reader = await db.user.create({ data: { githubId: 160603, githubUsername: 'cm-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 160604, githubUsername: 'cm-outsider', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'discussion' }, as());
});

describe('createComment (cor:dmo:110:01–05)', () => {
  it('anchors to the target id + current revision and hash, in the target memory, without touching the target', async () => {
    const target = await node('spec:1');
    const before = await db.node.findUniqueOrThrow({ where: { id: target.id } });
    const c = await comment(target.id, 'Is this right?', writer.id, { quote: 'the passage' });

    expect(c).toMatchObject({
      memoryId: memory.id, isTopLevel: true, threadRootId: null, state: 'OPEN',
      body: 'Is this right?', quote: 'the passage', anchorRevision: 1, anchorApprovalHash: hashOf(target),
      retracted: false, hidden: false, authorKey: `u:${writer.id}`, revSeq: 1,
    });
    expect(c.loc).toBe(`comments:${c.id}`);
    expect(C.anchorIsCurrent(c, {}, as())).toBe(true);
    const edge = await db.edge.findFirstOrThrow({ where: { sourceId: c.id } });
    expect(edge).toMatchObject({
      targetId: target.id, governedKind: 'COMMENT_ANCHOR', anchorRevNo: 1, anchorApprovalHash: hashOf(target),
      name: 'comment-anchor', loc: `comments:${c.id}:anchor`, memoryId: memory.id,
    });
    // cor:dmo:110:06 — byte-identical target row.
    expect(await db.node.findUniqueOrThrow({ where: { id: target.id } })).toEqual(before);
  });

  it('anchors an older revision from its retained snapshot, and refuses impossible or pruned ones', async () => {
    const target = await node('spec:2');
    await resolvers.Mutation.updateNode(null, { input: { id: target.id, content: 'Edited body' } }, as());
    const live = await db.node.findUniqueOrThrow({ where: { id: target.id } });
    expect(live.revSeq).toBe(2);
    const old = await comment(target.id, 'about v1', writer.id, { anchorRevision: 1 });
    expect(old.anchorRevision).toBe(1);
    expect(old.anchorApprovalHash).toBe(hashOf(target));
    expect(C.anchorIsCurrent(old, {}, as())).toBe(false);

    const invalid = await errorOf(comment(target.id, 'x', admin.id, { anchorRevision: 3 }));
    expect(invalid.extensions).toMatchObject({ code: 'COMMENT_ANCHOR_REVISION_INVALID', currentRevision: 2 });
    await db.nodeRevision.deleteMany({ where: { nodeId: target.id } });
    const pruned = await errorOf(comment(target.id, 'x', admin.id, { anchorRevision: 1 }));
    expect(pruned.extensions).toMatchObject({ code: 'COMMENT_ANCHOR_REVISION_UNAVAILABLE', currentRevision: 2 });
  });

  it('refuses readers, conceals unreadable targets, and refuses a comment as target', async () => {
    const target = await node('spec:3');
    expect(await codeOf(comment(target.id, 'x', reader.id))).toBe('COMMENT_FORBIDDEN');
    expect(await codeOf(comment(target.id, 'x', outsider.id))).toBe('COMMENT_TARGET_NOT_FOUND');
    expect(await codeOf(comment(generateId(), 'x'))).toBe('COMMENT_TARGET_NOT_FOUND');
    const c = await comment(target.id);
    expect(await codeOf(comment(c.id, 'x', admin.id))).toBe('COMMENT_TARGET_IS_COMMENT');
  });

  it('validates the body and quote', async () => {
    const target = await node('spec:4');
    expect((await errorOf(comment(target.id, '   '))).extensions).toMatchObject({ code: 'COMMENT_BODY_INVALID', field: 'body' });
    expect((await errorOf(comment(target.id, 'x'.repeat(20_001)))).extensions).toMatchObject({ code: 'COMMENT_BODY_INVALID', max: 20_000 });
    expect((await errorOf(comment(target.id, 'ok', writer.id, { quote: 'q'.repeat(2_001) })))
      .extensions).toMatchObject({ code: 'COMMENT_BODY_INVALID', field: 'quote' });
  });

  it('refuses impersonation', async () => {
    const target = await node('spec:5');
    const ctx: Context = { ...as(writer.id), impersonation: { adminUserId: admin.id } as never };
    expect(await codeOf(M.createComment(null, { targetRef: target.id, body: 'x' }, ctx))).toBe('COMMENT_IMPERSONATION_REFUSED');
  });

  it('refuses a private memory (COMMENT_MEMORY_NOT_COMMENTABLE)', async () => {
    const target = await node('spec:6');
    await db.memory.update({ where: { id: memory.id }, data: { class: 'private', userId: admin.id, visibility: null } });
    expect((await errorOf(comment(target.id, 'x', admin.id))).extensions)
      .toMatchObject({ code: 'COMMENT_MEMORY_NOT_COMMENTABLE', class: 'private' });
  });
});

describe('one open thread per author (cor:dmo:110:05)', () => {
  it('refuses a second open thread, per author; resolving or retracting frees the allowance', async () => {
    const target = await node('t:1');
    const first = await comment(target.id);
    const refused = await errorOf(comment(target.id, 'again'));
    expect(refused.extensions).toMatchObject({ code: 'COMMENT_OPEN_THREAD_EXISTS', threadId: first.id });
    // Another author has their own allowance.
    await comment(target.id, 'mine', admin.id);
    // A worker bound by the same user has its own allowance too.
    const byWorker = await runAsActor({ workerId: 'worker-1', agentId: 'agent-1' }, () => comment(target.id, 'as worker'));
    expect(byWorker.authorKey).toBe('w:worker-1');
    // An unnamed agent acting for the user has its own allowance.
    const byAgent = await runAsActor({ workerId: null, agentId: 'agent-2' }, () => comment(target.id, 'as agent'));
    expect(byAgent.authorKey).toBe(`ua:${writer.id}:agent-2`);

    await M.resolveCommentThread(null, { commentRef: first.id, expectedRevision: 1 }, as(writer.id));
    const second = await comment(target.id, 'new text');
    await M.retractComment(null, { commentRef: second.id, expectedRevision: 1 }, as(writer.id));
    await comment(target.id, 'third');
  });

  it('reopening a thread while the author holds another open one refuses', async () => {
    const target = await node('t:2');
    const first = await comment(target.id);
    await M.resolveCommentThread(null, { commentRef: first.id, expectedRevision: 1 }, as(writer.id));
    const second = await comment(target.id, 'second');
    const refused = await errorOf(M.reopenCommentThread(null, { commentRef: first.id, expectedRevision: 2 }, as(admin.id)));
    expect(refused.extensions).toMatchObject({ code: 'COMMENT_OPEN_THREAD_EXISTS', threadId: second.id });
  });

  it('the database refuses a second open thread even past the application check', async () => {
    const target = await node('t:3');
    await comment(target.id);
    const id = generateId();
    await expect(db.$transaction(async (tx) => {
      await tx.node.create({ data: { id, memoryId: memory.id, loc: `comments:${id}`, name: 'c', nodeType: 'comment', content: 'x' } });
      await tx.commentMeta.create({ data: { nodeId: id, targetNodeId: target.id, threadState: 'OPEN', authorKey: `u:${writer.id}` } });
    })).rejects.toThrow(/comment_meta_one_open_thread|Unique constraint/);
  });
});

describe('threads, edits and moderation (cor:dmo:110:05)', () => {
  it('replies inherit the thread, are allowed on a resolved thread without reopening it (DAB), and refuse on a retracted root', async () => {
    const target = await node('r:1');
    const root = await comment(target.id);
    const reply = await M.replyToComment(null, { commentRef: root.id, body: 'agree' }, as(admin.id));
    expect(reply).toMatchObject({ threadRootId: root.id, isTopLevel: false, state: null, anchorRevision: 1 });
    // Replying through a reply lands in the same thread.
    const nested = await M.replyToComment(null, { commentRef: reply.id, body: 'me too' }, as(writer.id));
    expect(nested.threadRootId).toBe(root.id);
    expect(await db.edge.findFirstOrThrow({ where: { sourceId: nested.id } }))
      .toMatchObject({ governedKind: 'COMMENT_REPLY', targetId: root.id, anchorRevNo: null });

    const resolved = await M.resolveCommentThread(null, { commentRef: root.id, expectedRevision: 1 }, as(admin.id));
    expect(resolved).toMatchObject({ state: 'RESOLVED', resolvedByKey: `u:${admin.id}` });
    const late = await M.replyToComment(null, { commentRef: root.id, body: 'resolution note' }, as(admin.id));
    expect(late.threadRootId).toBe(root.id);
    expect((await Q.comment(null, { ref: root.id }, as())).state).toBe('RESOLVED');

    const other = await comment(target.id, 'second thread', admin.id);
    await M.retractComment(null, { commentRef: other.id, expectedRevision: 1 }, as(admin.id));
    expect(await codeOf(M.replyToComment(null, { commentRef: other.id, body: 'x' }, as(writer.id)))).toBe('COMMENT_RETRACTED');
  });

  it('only the author edits or retracts; edits are revisions with history; a stub hides the text', async () => {
    const target = await node('e:1');
    const c = await comment(target.id, 'v1', writer.id, { quote: 'q1' });
    expect(await codeOf(M.editComment(null, { commentRef: c.id, body: 'hijack', expectedRevision: 1 }, as(admin.id)))).toBe('COMMENT_NOT_AUTHOR');
    expect(await codeOf(M.editComment(null, { commentRef: c.id, body: 'v2', expectedRevision: 5 }, as(writer.id)))).toBe('NODE_WRITE_CONFLICT');
    const edited = await M.editComment(null, { commentRef: c.id, body: 'v2', expectedRevision: 1 }, as(writer.id));
    expect(edited).toMatchObject({ body: 'v2', quote: 'q1', revSeq: 2 });
    const cleared = await M.editComment(null, { commentRef: c.id, quote: null, expectedRevision: 2 }, as(writer.id));
    expect(cleared).toMatchObject({ body: 'v2', quote: null, revSeq: 3 });
    const history = await db.nodeRevision.findMany({ where: { nodeId: c.id }, orderBy: { revNo: 'asc' } });
    expect(history.map((h) => [h.revNo, h.content, h.revLabel, h.editedBy])).toEqual([
      [1, 'v1', 'edit', writer.id],
      [2, 'v2', 'edit', writer.id],
    ]);

    expect(await codeOf(M.retractComment(null, { commentRef: c.id, expectedRevision: 3 }, as(admin.id)))).toBe('COMMENT_NOT_AUTHOR');
    const retracted = await M.retractComment(null, { commentRef: c.id, expectedRevision: 3 }, as(writer.id));
    expect(retracted).toMatchObject({ retracted: true, body: null, quote: null, revSeq: 4 });
    expect(await codeOf(M.editComment(null, { commentRef: c.id, body: 'v3', expectedRevision: 4 }, as(writer.id)))).toBe('COMMENT_RETRACTED');
  });

  it('resolve/reopen: writers only, top-level only, state-checked', async () => {
    const target = await node('s:1');
    const root = await comment(target.id);
    const reply = await M.replyToComment(null, { commentRef: root.id, body: 'r' }, as(admin.id));
    expect(await codeOf(M.resolveCommentThread(null, { commentRef: root.id, expectedRevision: 1 }, as(reader.id)))).toBe('COMMENT_FORBIDDEN');
    expect((await errorOf(M.resolveCommentThread(null, { commentRef: reply.id, expectedRevision: 1 }, as(admin.id)))).extensions)
      .toMatchObject({ code: 'COMMENT_NOT_TOP_LEVEL', threadRootId: root.id });
    expect((await errorOf(M.reopenCommentThread(null, { commentRef: root.id, expectedRevision: 1 }, as(admin.id)))).extensions)
      .toMatchObject({ code: 'COMMENT_THREAD_STATE', state: 'OPEN' });
    await M.resolveCommentThread(null, { commentRef: root.id, expectedRevision: 1 }, as(admin.id));
    const reopened = await M.reopenCommentThread(null, { commentRef: root.id, expectedRevision: 2 }, as(writer.id));
    expect(reopened).toMatchObject({ state: 'OPEN', resolvedAt: null, resolvedByKey: null });
  });

  it('hide is admin-only and leaves a stub; thread delete is admin-only and removes the thread from every read', async () => {
    const target = await node('h:1');
    const root = await comment(target.id, 'abusive');
    const reply = await M.replyToComment(null, { commentRef: root.id, body: 'r' }, as(admin.id));
    expect(await codeOf(M.hideComment(null, { commentRef: root.id, reason: 'abuse', expectedRevision: 1 }, as(writer.id)))).toBe('COMMENT_ADMIN_REQUIRED');
    const hidden = await M.hideComment(null, { commentRef: root.id, reason: 'abuse', expectedRevision: 1 }, as(admin.id));
    expect(hidden).toMatchObject({ hidden: true, body: null });
    expect(await codeOf(M.replyToComment(null, { commentRef: root.id, body: 'x' }, as(writer.id)))).toBe('COMMENT_HIDDEN');

    expect(await codeOf(M.deleteCommentThread(null, { commentRef: reply.id, reason: 'cleanup' }, as(writer.id)))).toBe('COMMENT_ADMIN_REQUIRED');
    expect(await M.deleteCommentThread(null, { commentRef: reply.id, reason: 'cleanup' }, as(admin.id))).toBe(true);
    const page = await Q.commentThreads(null, { targetRef: target.id }, as());
    expect(page).toEqual({ items: [], total: 0 });
    expect(await Q.comment(null, { ref: reply.id }, as())).toBeNull();
    const meta = await db.commentMeta.findUniqueOrThrow({ where: { nodeId: reply.id } });
    expect(meta).toMatchObject({ threadDeletedCause: 'ADMIN', threadDeletedBy: `u:${admin.id}` });
    // History is kept.
    expect(await db.node.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ deletedBy: admin.id });
  });
});

describe('reads', () => {
  it('commentThreads pages threads newest first with replies oldest first; readers read, outsiders cannot', async () => {
    const target = await node('p:1');
    const t1 = await comment(target.id, 'first', writer.id);
    const t2 = await comment(target.id, 'second', admin.id);
    const r1 = await M.replyToComment(null, { commentRef: t1.id, body: 'a' }, as(admin.id));
    const r2 = await M.replyToComment(null, { commentRef: t1.id, body: 'b' }, as(writer.id));
    const page = await Q.commentThreads(null, { targetRef: target.id }, as(reader.id));
    expect(page.total).toBe(2);
    expect(page.items.map((t: any) => t.root.id)).toEqual([t2.id, t1.id]);
    expect(page.items[1].replies.map((r: any) => r.id)).toEqual([r1.id, r2.id]);
    expect(page.items[1].replyCount).toBe(2);
    expect(await codeOf(Q.commentThreads(null, { targetRef: target.id }, as(outsider.id)))).toBe('COMMENT_TARGET_NOT_FOUND');
    expect(await Q.comment(null, { ref: t1.id }, as(outsider.id))).toBeNull();
    const resolvedOnly = await Q.commentThreads(null, { targetRef: target.id, state: ['RESOLVED'] }, as());
    expect(resolvedOnly.total).toBe(0);
  });

  it('author, viewerIsAuthor and provenanceUser follow the author key (cor:dmo:110:03)', async () => {
    const target = await node('a:1');
    const byUser = await comment(target.id, 'u');
    expect(await C.author(byUser, {}, as())).toMatchObject({ kind: 'USER', user: { id: writer.id, handle: 'cm-writer' } });
    expect(C.viewerIsAuthor(byUser, {}, as(writer.id))).toBe(true);
    expect(C.viewerIsAuthor(byUser, {}, as(admin.id))).toBe(false);
    expect(await C.provenanceUser(byUser, {}, as())).toBeNull();

    const byWorker = await runAsActor({ workerId: 'worker-9', agentId: null }, () => comment(target.id, 'w'));
    expect(await C.author(byWorker, {}, as())).toMatchObject({ kind: 'WORKER', user: null });
    // The binding user is provenance — for memory writers only (DAB).
    expect(await C.provenanceUser(byWorker, {}, as(admin.id))).toMatchObject({ id: writer.id });
    expect(await C.provenanceUser(byWorker, {}, as(reader.id))).toBeNull();
    expect(C.viewerIsAuthor(byWorker, {}, as(writer.id))).toBe(false);
    expect(await runAsActor({ workerId: 'worker-9', agentId: null }, async () => C.viewerIsAuthor(byWorker, {}, as(writer.id)))).toBe(true);
  });

  it('Node.commentSummary counts live threads and names the viewer\'s open thread, batched', async () => {
    const a = await node('sum:a');
    const b = await node('sum:b');
    const open = await comment(a.id, 'open');
    const resolved = await comment(a.id, 'r', admin.id);
    await M.resolveCommentThread(null, { commentRef: resolved.id, expectedRevision: 1 }, as(admin.id));
    await M.replyToComment(null, { commentRef: open.id, body: 'reply' }, as(admin.id));
    const ctx = as(writer.id);
    const [sa, sb] = await Promise.all([nodeSummary(a, {}, ctx), nodeSummary(b, {}, ctx)]);
    expect(sa).toEqual({ openThreads: 1, resolvedThreads: 1, comments: 3, viewerOpenThreadId: open.id });
    expect(sb).toEqual({ openThreads: 0, resolvedThreads: 0, comments: 0, viewerOpenThreadId: null });
    expect((await nodeSummary(a, {}, as(admin.id))).viewerOpenThreadId).toBeNull();
    // The slim list node carries the same cue (portal#1014 Slice B).
    const graphNode = (resolvers as unknown as { GraphNode: { openThreads: (n: unknown, x: unknown, c: Context) => Promise<number> } }).GraphNode;
    expect(await Promise.all([graphNode.openThreads(a, {}, ctx), graphNode.openThreads(b, {}, ctx)])).toEqual([1, 0]);
  });
});

describe('database invariants (cor:dmo:110:01/04)', () => {
  it('governed edges are immutable and cannot be deleted while their comment exists', async () => {
    const target = await node('db:1');
    const other = await node('db:2');
    const c = await comment(target.id);
    const edge = await db.edge.findFirstOrThrow({ where: { sourceId: c.id } });
    await expect(db.edge.update({ where: { id: edge.id }, data: { targetId: other.id } })).rejects.toThrow(/immutable/);
    await expect(db.edge.update({ where: { id: edge.id }, data: { anchorRevNo: 2 } })).rejects.toThrow(/immutable/);
    await expect(db.edge.delete({ where: { id: edge.id } })).rejects.toThrow(/removed only with its comment/);
  });

  it('a generic node cannot become a comment, and a comment cannot change type', async () => {
    const target = await node('db:3');
    await expect(node('db:4', { nodeType: 'comment' })).rejects.toThrow(/COMMENT_INVARIANT/);
    const c = await comment(target.id);
    await expect(db.node.update({ where: { id: c.id }, data: { nodeType: 'info' } })).rejects.toThrow(/COMMENT_INVARIANT/);
  });

  it('a comment is never approved or minted', async () => {
    const target = await node('db:5');
    const c = await comment(target.id);
    await expect(db.node.update({
      where: { id: c.id },
      data: { approvedRevNo: 1, approvedAt: new Date(), approvalHash: 'a'.repeat(64), approvedBy: admin.id },
    })).rejects.toThrow(/chk_nodes_comment_unapproved/);
  });

  it('a comment cannot be moved away from its target\'s memory', async () => {
    const target = await node('db:6');
    const c = await comment(target.id);
    const elsewhere = await resolvers.Mutation.createMemory(null, { orgId, name: 'elsewhere' }, as());
    await expect(db.node.update({ where: { id: c.id }, data: { memoryId: elsewhere.id } })).rejects.toThrow(/COMMENT_INVARIANT/);
  });

  it('a hard delete of a commented target fails unless its threads go with it; a memory delete cascades', async () => {
    const target = await node('db:7');
    await comment(target.id);
    await expect(db.node.delete({ where: { id: target.id } })).rejects.toThrow();
    await db.memory.delete({ where: { id: memory.id } });
    expect(await db.commentMeta.count()).toBe(0);
  });
});

describe('#1607 — approval and mint leave comments out (cor:dmo:110:06/07, 120:06)', () => {
  it('approveNode refuses a comment; approve-all skips it and warns about open feedback', async () => {
    const target = await node('m:1');
    const c = await comment(target.id);
    expect(await codeOf(resolvers.Mutation.approveNode(null, { nodeRef: c.id }, as()))).toBe('COMMENT_NOT_APPROVABLE');
    const result = await resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memory.id }, as());
    // The memory root (loc `discussion`) and the target; never the comment.
    expect(result.approved.map((r: { loc: string }) => r.loc)).toEqual(['discussion', 'm:1']);
    expect(result.unresolvedFeedback).toEqual([{ nodeId: target.id, loc: 'm:1', memoryId: memory.id, openThreads: 1 }]);
    expect(await C.anchorIsCurrent(c, {}, as())).toBe(true);
    const fb = (resolvers as unknown as { UnresolvedFeedback: { urn: (r: unknown, a: unknown, ctx: Context) => Promise<string> } }).UnresolvedFeedback;
    expect(await fb.urn(result.unresolvedFeedback[0], {}, as())).toMatch(/m:1$/);
  });

  it('a mint dry run neither counts nor blocks on comments, warns on open feedback, and the mint leaves them unstamped', async () => {
    const target = await node('m:2');
    const c = await comment(target.id);
    await resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memory.id }, as());
    const dry = await M.mintMemoryNodes(null, { memoryRef: memory.id, dryRun: true }, as());
    expect(dry.blockers).toEqual([]);
    expect(dry.mintLocs).toEqual(['discussion', 'm:2']);
    expect(dry.unresolvedFeedback).toEqual([{ nodeId: target.id, loc: 'm:2', memoryId: memory.id, openThreads: 1 }]);
    const minted = await M.mintMemoryNodes(null, { memoryRef: memory.id }, as());
    expect(minted.mintedCount).toBe(2);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).mintedAt).toBeNull();
    // A comment posted after the mint never blocks the next one.
    await comment(target.id, 'later', admin.id);
    const again = await M.mintMemoryNodes(null, { memoryRef: memory.id, dryRun: true }, as());
    expect(again).toMatchObject({ blockers: [], mintLocs: [] });
  });

  it('verifyMemoryNodes does not report comments', async () => {
    const target = await node('m:3');
    await comment(target.id);
    const report = await resolvers.Query.verifyMemoryNodes(null, { memoryRef: memory.id }, as());
    expect(report.checked).toBe(2); // the root and the target
  });
});
