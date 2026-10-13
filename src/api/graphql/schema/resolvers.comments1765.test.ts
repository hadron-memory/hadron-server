/**
 * #1765 — a comment's author may always delete their own comment
 * (cor:dmo:110:16): even after losing all access to the memory, revealing
 * nothing else about it, with replies keeping their stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';

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
/** SQLSTATE 55P03 (lock_not_available) on a NOWAIT probe — matched by code, not message text (#1853). */
const isLockNotAvailable = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.meta as { code?: string } | undefined)?.code === '55P03';

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

  // Cycle 1 (Anne blind P2-1 / Xylon local P2-2): the no-access acknowledgment
  // must carry no live memory data.
  it("the no-access acknowledgment reflects no post-revocation rename, resolve or revision", async () => {
    const target = await node('b:1');
    const c = await comment(target.id, 'mine');
    await M.replyToComment(null, { commentRef: c.id, body: 'r1' }, as(admin.id));
    await revoke(writer.id);
    // Memory activity after the revocation, none of which the response may reflect.
    await db.node.update({ where: { id: target.id }, data: { name: 'Renamed after revocation', revSeq: { increment: 1 } } });
    await M.resolveCommentThread(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(admin.id));
    const deleted = await M.deleteComment(null, { commentRef: c.id, expectedRevision: c.revSeq }, as(writer.id));
    expect(deleted).toMatchObject({ deleted: true, body: null, quote: null, state: null, resolvedAt: null });
    expect(deleted.target.id).toBe(target.id);
    expect(deleted.target.name).not.toBe('Renamed after revocation');
    // The author-known anchor revision, not the live row's.
    expect(deleted.target.revSeq).toBe(c.anchorRevision);
  });

  // Cycle 1 (Anne blind P2-2): the author may always delete — session or not.
  it('an author deletes in an encrypted memory with no session key, stub and vanish both', async () => {
    const gone = await comment((await node('b:2')).id, 'vanishes');
    const kept = await comment((await node('b:3')).id, 'stubbed');
    await M.replyToComment(null, { commentRef: kept.id, body: 'r1' }, as(admin.id));
    // The memory turns encrypted with no active session key cached (a vector
    // index would need its encryption ack; this memory carries none).
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect(sessionKeyCache.getByMemoryId(memory.id)).toBeNull();
    await expect(M.deleteComment(null, { commentRef: gone.id, expectedRevision: gone.revSeq }, as(writer.id)))
      .resolves.toMatchObject({ deleted: true, body: null });
    await expect(M.deleteComment(null, { commentRef: kept.id, expectedRevision: kept.revSeq }, as(writer.id)))
      .resolves.toMatchObject({ deleted: true, body: null, quote: null });
    // The stub's row is blanked: no text survives for the generic surfaces.
    expect((await live(kept.id)).content).toBeNull();
  });

  // The §10 claim behind the authorKey peek: the database keeps it immutable.
  it("a comment's author_key is immutable in the database", async () => {
    const target = await node('b:4');
    const c = await comment(target.id);
    await expect(db.$executeRaw`UPDATE comment_meta SET author_key = ${`u:${admin.id}`} WHERE node_id = ${c.id}`)
      .rejects.toThrow(/immutable/);
  });

  // Cycle 1 (Rook §10 P2-1): a non-author never enters the authority bracket —
  // the unlocked peek conceals them before any lock is taken.
  it("a non-author's concealed refusal takes no locks on the comment (Rook P2-1)", async () => {
    const target = await node('c:1');
    const mine = await comment(target.id, 'not yours', admin.id);
    await revoke(writer.id);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${mine.id} FOR UPDATE`;
      await held;
    }, { timeout: 20_000 });
    // Barrier (#1846): prove the holder has ACQUIRED the lock before the
    // delete races it, so the race cannot pass vacuously by outrunning the
    // acquisition. A NOWAIT probe succeeds (and, in its own implicit
    // transaction, releases instantly) while the row is free; its failure is
    // the holder holding it — matched by SQLSTATE, not message text (#1853;
    // the fenceCorpusForMint precedent).
    let lockHeld = false;
    for (let i = 0; i < 200 && !lockHeld; i += 1) {
      try {
        await db.$queryRaw`SELECT id FROM nodes WHERE id = ${mine.id} FOR UPDATE NOWAIT`;
        await new Promise((r) => setTimeout(r, 20));
      } catch (error) {
        if (isLockNotAvailable(error)) lockHeld = true;
        else throw error;
      }
    }
    expect(lockHeld).toBe(true);
    // While the row is locked: the refusal must answer without waiting on it.
    // The finally releases the holder however this concludes (#1853): a
    // failed barrier or race must not leave the 20s transaction open with
    // the raced delete still pending behind it.
    try {
      const outcome = await Promise.race([
        errorOf(M.deleteComment(null, { commentRef: mine.id, expectedRevision: mine.revSeq }, as(writer.id))),
        new Promise((resolve) => setTimeout(() => resolve('STILL WAITING ON THE LOCK'), 2_000)),
      ]);
      expect(outcome).toBeInstanceOf(GraphQLError);
      expect((outcome as GraphQLError).extensions.code).toBe('COMMENT_NOT_FOUND');
    } finally {
      release();
      await holder;
    }
    expect((await live(mine.id)).deletedAt).toBeNull();
  });

  // Rook P2-1: the unlocked peek only routes; the locked row still decides.
  it('the locked row re-checks authorship inside the transaction (text pin)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./resolvers.comments.ts', import.meta.url), 'utf8');
    expect(source).toContain("if (row.commentMeta!.authorKey !== authorKey) throw commentMissing();");
  });
});
