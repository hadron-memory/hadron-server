/**
 * #1765 — a comment's author may always delete their own comment
 * (cor:dmo:110:16): even after losing all access to the memory, revealing
 * nothing else about it, with replies keeping their stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let writer: { id: string };
let orgId: string;
let memory: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const C = (resolvers as unknown as { Comment: Record<string, (c: any, a: unknown, ctx: Context) => unknown> }).Comment;

const node = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: `Body ${loc}` },
});
const comment = (targetRef: string, body = 'Looks off', userId = writer.id) =>
  M.createComment(null, { targetRef, body }, as(userId));
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};
/** The observable shape of a refusal: message plus extensions, nothing else. */
const shapeOf = (e: GraphQLError) => ({ message: e.message, extensions: e.extensions });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Comment Org 1765', urn: 'comment-1765.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 176501, githubUsername: 'cm-admin', handle: 'cm-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 176502, githubUsername: 'cm-writer', handle: 'cm-writer', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'discussion' }, as());
});

const live = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
const threadsOf = (targetRef: string, userId = admin.id) => Q.commentThreads(null, { targetRef }, as(userId));
/** Revoke a member's org membership (the soft delete the gates treat as gone). */
const revoke = (userId: string) =>
  db.orgMember.updateMany({ where: { organizationId: orgId, userId }, data: { deletedAt: new Date() } });
/** Demote a member to READER: read kept, write lost. */
const makeReader = (userId: string) =>
  db.orgMember.updateMany({ where: { organizationId: orgId, userId }, data: { role: 'READER' } });

describe('#1765 — the author may always delete their own (cor:dmo:110:16)', () => {
  it('an author whose org membership was revoked still deletes their own comment', async () => {
    const target = await node('a:1');
    const c = await comment(target.id, 'take this back');
    await revoke(writer.id);
    // The premise holds: the revoked author can no longer even read the memory.
    expect(await Q.comment(null, { ref: c.id }, as(writer.id))).toBeNull();
    expect(await codeOf(Q.commentThreads(null, { targetRef: target.id }, as(writer.id)))).toBe('COMMENT_TARGET_NOT_FOUND');
    const deleted = await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(writer.id));
    expect(deleted).toMatchObject({ deleted: true, body: null, quote: null });
    expect(await C.deletedBy(deleted, {}, as(writer.id))).toMatchObject({ id: writer.id });
    expect((await live(c.id)).deletedAt).not.toBeNull();
    expect(await db.commentMeta.findUniqueOrThrow({ where: { nodeId: c.id } }))
      .toMatchObject({ threadDeletedCause: 'AUTHOR', threadDeletedBy: `u:${writer.id}` });
  });

  it("a revoked author's top-level delete keeps the stub for its replies", async () => {
    const target = await node('a:2');
    const c = await comment(target.id, 'secret text');
    await M.replyToComment(null, { commentRef: c.id, body: 'r1' }, as(admin.id));
    await revoke(writer.id);
    await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(writer.id));
    // Members still read the thread: the stub carries no text, the reply survives.
    const { items, total } = await threadsOf(target.id);
    expect(total).toBe(1);
    expect(items[0].root).toMatchObject({ id: c.id, deleted: true, body: null, quote: null });
    expect(items[0].replies.map((r: any) => r.body)).toEqual(['r1']);
    const row = await live(c.id);
    expect(row.content).toBeNull();
    expect(JSON.stringify(row.data)).not.toContain('secret text');
  });

  it('an author kept as a reader (write revoked, read kept) still deletes their own', async () => {
    const target = await node('a:3');
    const c = await comment(target.id);
    await makeReader(writer.id);
    await expect(M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(writer.id)))
      .resolves.toMatchObject({ deleted: true, body: null });
  });

  it("a different ex-member's attempt on someone else's comment is concealed exactly like a missing one", async () => {
    const target = await node('a:4');
    const mine = await comment(target.id, 'not yours', admin.id);
    await revoke(writer.id);
    const onSomeoneElses = await errorOf(M.deleteComment(null, { commentRef: mine.id, expectedRevision: mine.revSeq }, as(writer.id)));
    const onMissing = await errorOf(M.deleteComment(null, { commentRef: generateId(), expectedRevision: 1 }, as(writer.id)));
    expect(shapeOf(onSomeoneElses)).toEqual(shapeOf(onMissing));
    expect(onSomeoneElses.extensions.code).toBe('COMMENT_NOT_FOUND');
    // A stale expectedRevision must not leak the live revision either: the
    // author check on the locked row comes before the revision check.
    const stale = await errorOf(M.deleteComment(null, { commentRef: mine.id, expectedRevision: mine.revSeq + 5 }, as(writer.id)));
    expect(shapeOf(stale)).toEqual(shapeOf(onMissing));
    expect((await live(mine.id)).deletedAt).toBeNull();
  });

  it("F1 pin: a platform admin still cannot reach a comment in someone's personal memory", async () => {
    const personal = await resolvers.Mutation.createMemory(null, { name: 'mine', memoryClass: 'personal' }, as(writer.id));
    const target = await db.node.create({ data: { id: generateId(), memoryId: personal.id, loc: 'f:1', name: 'P', content: 'x' } });
    const c = await comment(target.id);
    const platformAdmin = await db.user.create({ data: { githubId: 176503, githubUsername: 'cm-1765-platform', roles: ['ADMIN'] } });
    const ctx = { db, userId: platformAdmin.id, roles: ['ADMIN'] } as Context;
    expect(await codeOf(M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, ctx))).toBe('COMMENT_NOT_FOUND');
    expect((await live(c.id)).deletedAt).toBeNull();
  });
});
