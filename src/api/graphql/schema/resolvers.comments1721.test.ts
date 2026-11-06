/**
 * #1721 — Holger's 2026-10-08 comment rulings (cor:dmo:110:05, :11, :12): no
 * revision history, a deleted comment leaves a stub only while it has replies,
 * and the last-edited record moves only on a content edit (Marco, #7693).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

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


const live = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
const threadsOf = (targetRef: string, userId = admin.id) => Q.commentThreads(null, { targetRef }, as(userId));

describe('#1721 change 1 — a comment keeps no revisions (cor:dmo:110:12)', () => {
  it('an edit overwrites the comment, writes no revision, and still advances revSeq for expectedRevision', async () => {
    const target = await node('r:1');
    const c = await comment(target.id, 'first');
    const edited = await M.editComment(null, { commentRef: c.id, body: 'second', expectedRevision: c.revSeq }, as(writer.id));
    expect(edited.body).toBe('second');
    expect(edited.revSeq).toBe(c.revSeq + 1);
    expect(await db.nodeRevision.count({ where: { nodeId: c.id } })).toBe(0);
    // Nor does a later read: the #1323 drift reconcile must not see the edit
    // as an out-of-band change and snapshot it.
    await Q.node(null, { ref: c.id }, as(writer.id));
    await Q.nodeRevisions(null, { nodeRef: c.id }, { ...as(), roles: ['ADMIN'] });
    expect(await db.nodeRevision.count({ where: { nodeId: c.id } })).toBe(0);
    // The old number is stale: an edit against it is refused.
    expect(await codeOf(M.editComment(null, { commentRef: c.id, body: 'third', expectedRevision: c.revSeq }, as(writer.id))))
      .toBe('NODE_WRITE_CONFLICT');
  });

  it('no comment operation writes a revision', async () => {
    const target = await node('r:2');
    const c = await comment(target.id);
    let rev = c.revSeq;
    rev = (await M.resolveCommentThread(null, { commentRef: c.id, expectedRevision: rev }, as(admin.id))).revSeq;
    rev = (await M.reopenCommentThread(null, { commentRef: c.id, expectedRevision: rev }, as(admin.id))).revSeq;
    await M.replyToComment(null, { commentRef: c.id, body: 'reply' }, as(admin.id));
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: rev }, as(writer.id));
    expect(await db.nodeRevision.count({ where: { nodeId: c.id } })).toBe(0);
  });
});

describe('#1721 — the last-edited record moves only on a content edit (Marco, #7693)', () => {
  it('a fresh comment has no editedAt; an edit sets editedAt and editedBy', async () => {
    const target = await node('e:1');
    const c = await comment(target.id);
    expect(c.editedAt).toBeNull();
    expect(await C.editedBy(c, {}, as())).toBeNull();
    const edited = await M.editComment(null, { commentRef: c.id, body: 'changed', expectedRevision: c.revSeq }, as(writer.id));
    expect(edited.editedAt).toBeInstanceOf(Date);
    expect(await C.editedBy(edited, {}, as())).toMatchObject({ id: writer.id });
  });

  it('resolve and reopen by another writer leave updatedAt, updatedBy and editedAt unchanged', async () => {
    // Node.updatedAt is also the clock of operational writes (embedding
    // markers); with no vector index, only the operation itself could move it.
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: false } });
    const target = await node('e:2');
    const c = await comment(target.id);
    const before = await live(c.id);
    await new Promise((r) => setTimeout(r, 15));
    const resolved = await M.resolveCommentThread(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(admin.id));
    expect(resolved.state).toBe('RESOLVED');
    const reopened = await M.reopenCommentThread(null, { commentRef: c.id, expectedRevision: resolved.revSeq }, as(admin.id));
    const after = await live(c.id);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedBy).toEqual(before.updatedBy);
    expect(reopened.updatedAt).toEqual(c.updatedAt);
    expect(reopened.editedAt).toBeNull();
  });
});

describe('#1721 change 3 — a deleted comment leaves a stub only while it has replies (cor:dmo:110:05)', () => {
  it('S5: a comment deleted without replies is no longer shown, and frees the open-comment allowance', async () => {
    const target = await node('d:1');
    const c = await comment(target.id);
    const deleted = await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(writer.id));
    // The answer to the delete itself carries no text either.
    expect(deleted).toMatchObject({ deleted: true, body: null, quote: null });
    expect(await Q.comment(null, { ref: c.id }, as())).toBeNull();
    expect((await threadsOf(target.id)).total).toBe(0);
    expect((await live(c.id)).deletedAt).not.toBeNull();
    // cor:dmo:110:10 — deleting frees the allowance.
    await expect(comment(target.id, 'again')).resolves.toMatchObject({ state: 'OPEN' });
  });

  it('S4: a comment deleted with replies stays as a stub without its text, and the replies keep their context', async () => {
    const target = await node('d:2');
    const c = await comment(target.id, 'secret text', writer.id, { quote: 'q' });
    await M.replyToComment(null, { commentRef: c.id, body: 'r1' }, as(admin.id));
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(writer.id));
    const { items, total } = await threadsOf(target.id);
    expect(total).toBe(1);
    expect(items[0].root).toMatchObject({ id: c.id, deleted: true, body: null, quote: null });
    expect(items[0].replies.map((r: any) => r.body)).toEqual(['r1']);
    const row = await live(c.id);
    expect(row.content).toBeNull();
    expect(JSON.stringify(row.data)).not.toContain('secret text');
  });

  it('a reply deleted by its author vanishes without a stub', async () => {
    const target = await node('d:3');
    const c = await comment(target.id);
    const r1 = await M.replyToComment(null, { commentRef: c.id, body: 'r1' }, as(admin.id));
    const r2 = await M.replyToComment(null, { commentRef: c.id, body: 'r2' }, as(admin.id));
    await M.deleteComment(null, { commentRef: r1.id, expectedRevision: r1.revSeq }, as(admin.id));
    const { items } = await threadsOf(target.id);
    expect(items[0].replies.map((r: any) => r.id)).toEqual([r2.id]);
    expect(items[0].replyCount).toBe(1);
    expect(await Q.comment(null, { ref: r1.id }, as())).toBeNull();
  });

  it('a stub disappears once its last reply is deleted', async () => {
    const target = await node('d:4');
    const c = await comment(target.id);
    const r1 = await M.replyToComment(null, { commentRef: c.id, body: 'r1' }, as(admin.id));
    const r2 = await M.replyToComment(null, { commentRef: c.id, body: 'r2' }, as(admin.id));
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(writer.id));
    await M.deleteComment(null, { commentRef: r1.id, expectedRevision: r1.revSeq }, as(admin.id));
    expect((await threadsOf(target.id)).total).toBe(1);
    await M.deleteComment(null, { commentRef: r2.id, expectedRevision: r2.revSeq }, as(admin.id));
    expect((await threadsOf(target.id)).total).toBe(0);
    expect((await live(c.id)).deletedAt).not.toBeNull();
  });

  it('a live reply under a live root does not take the root with it', async () => {
    const target = await node('d:5');
    const c = await comment(target.id);
    const r1 = await M.replyToComment(null, { commentRef: c.id, body: 'r1' }, as(admin.id));
    await M.deleteComment(null, { commentRef: r1.id, expectedRevision: r1.revSeq }, as(admin.id));
    const { items, total } = await threadsOf(target.id);
    expect(total).toBe(1);
    expect(items[0].root).toMatchObject({ id: c.id, deleted: false, body: 'Looks off' });
  });
});

describe('#1721 change 4 — who manages a memory for deleting others\' comments (cor:dmo:110:11)', () => {
  it('a platform admin with no org role may delete a comment with its replies in an org memory', async () => {
    const target = await node('m:1');
    const c = await comment(target.id);
    await M.replyToComment(null, { commentRef: c.id, body: 'r1' }, as(admin.id));
    const platformAdmin = await db.user.create({ data: { githubId: 172101, githubUsername: 'cm-platform', roles: ['ADMIN'] } });
    await expect(M.deleteCommentThread(null, { commentRef: c.id, reason: 'spam' }, { db, userId: platformAdmin.id, roles: ['ADMIN'] }))
      .resolves.toBe(true);
    expect((await threadsOf(target.id)).total).toBe(0);
  });

  it('a writer who does not manage the memory may not', async () => {
    const target = await node('m:2');
    const c = await comment(target.id, 'x', admin.id);
    expect(await codeOf(M.deleteCommentThread(null, { commentRef: c.id, reason: 'no' }, as(writer.id)))).toBe('COMMENT_ADMIN_REQUIRED');
  });
});

// Holger's rulings on Q1–Q3 (hadron-server#1721, 2026-10-10): one deleteComment
// for the author or a manager, hideComment and retractComment removed, the
// hidden state dropped, and an accurate deletion cause.
describe('#1721 rulings Q2/Q3 — one deleteComment, no hide or retract, an accurate cause', () => {
  const metaOf = (id: string) => db.commentMeta.findUniqueOrThrow({ where: { nodeId: id } });

  it("a memory manager deletes someone else's comment; the cause records MANAGER, and the author's own delete AUTHOR", async () => {
    const target = await node('q:1');
    const byWriter = await comment(target.id);
    const deleted = await M.deleteComment(null, { commentRef: byWriter.id, expectedRevision: byWriter.revSeq }, as(admin.id));
    expect(deleted).toMatchObject({ deleted: true, body: null });
    expect(await C.deletedBy(deleted, {}, as())).toMatchObject({ id: admin.id });
    expect(await metaOf(byWriter.id)).toMatchObject({ threadDeletedCause: 'MANAGER', threadDeletedBy: `u:${admin.id}` });
    const own = await comment(target.id, 'mine again');
    await M.deleteComment(null, { commentRef: own.id, expectedRevision: own.revSeq }, as(writer.id));
    expect(await metaOf(own.id)).toMatchObject({ threadDeletedCause: 'AUTHOR', threadDeletedBy: `u:${writer.id}` });
  });

  it("a stub's removal with its last reply records whoever deleted the stub, not the reply's deleter", async () => {
    const target = await node('q:2');
    const c = await comment(target.id);
    const r = await M.replyToComment(null, { commentRef: c.id, body: 'r' }, as(writer.id));
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(admin.id));
    expect((await metaOf(c.id)).threadDeletedCause).toBeNull();
    await M.deleteComment(null, { commentRef: r.id, expectedRevision: r.revSeq }, as(writer.id));
    expect(await metaOf(r.id)).toMatchObject({ threadDeletedCause: 'AUTHOR', threadDeletedBy: `u:${writer.id}` });
    expect(await metaOf(c.id)).toMatchObject({ threadDeletedCause: 'MANAGER', threadDeletedBy: `u:${admin.id}` });
  });

  it('a platform admin with no org role may delete any comment in an org memory', async () => {
    const target = await node('q:3');
    const c = await comment(target.id);
    const platformAdmin = await db.user.create({ data: { githubId: 172102, githubUsername: 'cm-platform2', roles: ['ADMIN'] } });
    const ctx = { db, userId: platformAdmin.id, roles: ['ADMIN'] } as Context;
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, ctx);
    expect(await metaOf(c.id)).toMatchObject({ threadDeletedCause: 'MANAGER' });
  });

  it("a platform admin cannot reach a comment in someone's personal memory", async () => {
    const personal = await resolvers.Mutation.createMemory(null, { name: 'mine', memoryClass: 'personal' }, as(writer.id));
    const target = await db.node.create({ data: { id: generateId(), memoryId: personal.id, loc: 'p:1', name: 'P', content: 'x' } });
    const c = await comment(target.id);
    const platformAdmin = await db.user.create({ data: { githubId: 172103, githubUsername: 'cm-platform3', roles: ['ADMIN'] } });
    const ctx = { db, userId: platformAdmin.id, roles: ['ADMIN'] } as Context;
    expect(await codeOf(M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, ctx))).toBe('COMMENT_NOT_FOUND');
    expect((await live(c.id)).deletedAt).toBeNull();
  });

  it('hideComment and retractComment are gone from the API, and the hidden columns from the schema', async () => {
    const { typeDefs } = await import('./typeDefs.js');
    const sdl = String(typeDefs);
    for (const gone of ['hideComment(', 'retractComment(', 'retracted: Boolean']) expect(sdl).not.toContain(gone);
    // `hiddenAt` is legitimately back on UserApiKey (#2298), so only the Comment type must not carry it.
    const start = sdl.indexOf('type Comment {');
    expect(start).toBeGreaterThan(-1);
    expect(sdl.slice(start, sdl.indexOf('\n  }', start))).not.toContain('hiddenAt');
    expect(sdl).toContain('deleteComment(commentRef: ID!, expectedRevision: Int!): Comment!');
    expect(M.hideComment).toBeUndefined();
    expect(M.retractComment).toBeUndefined();
    const columns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'comment_meta' AND column_name LIKE 'hidden%'`;
    expect(columns).toEqual([]);
  });

  it('the database accepts the new causes and refuses any other', async () => {
    const target = await node('q:4');
    const c = await comment(target.id);
    const set = (cause: string) => db.$executeRaw`
      UPDATE comment_meta SET thread_deleted_at = now(), thread_deleted_cause = ${cause} WHERE node_id = ${c.id}`;
    for (const cause of ['ADMIN', 'AUTHOR', 'MANAGER', 'TARGET']) await expect(set(cause)).resolves.toBe(1);
    await expect(set('HIDDEN')).rejects.toThrow(/chk_comment_meta_state_top_level/);
  });
});

// #1727 review (Diego P2): every write that touches a thread locks its root
// first, the order deleteCommentThread uses, so the two cannot deadlock.
describe('#1721 — comment writes lock the thread root before a reply', () => {
  async function thread() {
    const target = await node(`l:${generateId()}`);
    const root = await comment(target.id);
    const r1 = await M.replyToComment(null, { commentRef: root.id, body: 'r1' }, as(writer.id));
    const r2 = await M.replyToComment(null, { commentRef: root.id, body: 'r2' }, as(writer.id));
    return { target, root, r1, r2 };
  }

  it.each([
    ['deleteComment', (t: any) => M.deleteComment(null, { commentRef: t.r1.id, expectedRevision: t.r1.revSeq }, as(writer.id))],
    ['replyToComment through a reply', (t: any) => M.replyToComment(null, { commentRef: t.r1.id, body: 'r3' }, as(writer.id))],
    ['deleteCommentThread through a reply', (t: any) => M.deleteCommentThread(null, { commentRef: t.r1.id, reason: 'x' }, as(admin.id))],
  ])('%s waits on the root before it holds the reply', async (_name, write) => {
    const t = await thread();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let replyFree: boolean | null = null;
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${t.root.id} FOR UPDATE`;
      await held;
      try {
        await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${t.r1.id} FOR UPDATE NOWAIT`;
        replyFree = true;
      } catch {
        replyFree = false;
      }
    }, { timeout: 20_000 });
    const pending = write(t);
    await waitForLockWaitersOfType(db, 'transactionid', 1);
    release();
    await holder;
    await pending;
    // Child-then-root would already hold the reply while waiting for the root.
    expect(replyFree).toBe(true);
  });

  it('a reply delete and a thread delete running together both settle, with no deadlock', async () => {
    for (let i = 0; i < 5; i += 1) {
      const t = await thread();
      const results = await Promise.allSettled([
        M.deleteComment(null, { commentRef: t.r1.id, expectedRevision: t.r1.revSeq }, as(writer.id)),
        M.deleteCommentThread(null, { commentRef: t.root.id, reason: 'x' }, as(admin.id)),
      ]);
      for (const r of results) if (r.status === 'rejected') expect(String((r.reason as Error).message)).not.toMatch(/deadlock/i);
      expect((await threadsOf(t.target.id)).total).toBe(0);
    }
  });

  it("deleting a stub's last two replies together removes the stub", async () => {
    const t = await thread();
    await M.deleteComment(null, { commentRef: t.root.id, expectedRevision: t.root.revSeq }, as(writer.id));
    await Promise.all([
      M.deleteComment(null, { commentRef: t.r1.id, expectedRevision: t.r1.revSeq }, as(writer.id)),
      M.deleteComment(null, { commentRef: t.r2.id, expectedRevision: t.r2.revSeq }, as(writer.id)),
    ]);
    expect((await threadsOf(t.target.id)).total).toBe(0);
    expect((await live(t.root.id)).deletedAt).not.toBeNull();
  });
});
