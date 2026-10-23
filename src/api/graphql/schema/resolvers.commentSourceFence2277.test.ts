/**
 * #2277 red-first: comment writers and source-memory restoreNode must take the #2063 include-history fence F as the
 * transaction's FIRST statement when the memory is a boot-prompt source (an Agent system memory or an install memory,
 * cor:dmo:040:08; Vera FIT #31196). The witness (findings:comment-source-writer-outside-compile-fence): a compile holds F
 * while a licensed foreign author edits a comment in the source memory; the edit commits before F is released.
 *
 * Each case holds F in an outer transaction, starts the REAL resolver, and requires it to QUEUE on the advisory lock.
 * Red on main: the resolver never queues and commits while F is held. A comment in a non-source memory must NOT queue
 * (a global exclusive fence per comment would serialize every comment in the database): that control is green before and
 * after.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { includeHistoryClient, withIncludeHistoryTransaction } from '../../../lib/includes/includeHistoryFence.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let admin: { id: string };
let orgId: string;
const as = (): Context => ({ db, userId: admin.id, roles: [] });

async function holdF() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const done = withIncludeHistoryTransaction(db, async (f) => { includeHistoryClient(f); entered(); await held; });
  await inside;
  return { release, done };
}

/** Run `op` while F is held; true when it queued on the fence (and then completed after release). */
async function queuedOnFence(op: () => Promise<unknown>): Promise<boolean> {
  const f = await holdF();
  const running = op();
  running.catch(() => {});
  let queued = true;
  try { await waitForLockWaitersOfType(db, 'advisory', 1, 1_500); } catch { queued = false; }
  f.release();
  await f.done;
  await running;
  return queued;
}

type Fixture = { memoryId: string; targetId: string; targetUrn: string };
async function memoryFixture(cls: 'system' | 'knowledge'): Promise<Fixture> {
  const memory = await db.memory.create({ data: { id: generateId(), class: cls, name: `m-${cls}`, urn: `cs2277.example:${cls}-${generateId().slice(-6)}`, organizationId: orgId } });
  if (cls === 'system') {
    await db.agent.create({ data: { id: generateId(), name: 'Src', urn: `cs2277.example:agent-${generateId().slice(-6)}`, organizationId: orgId, visibility: 'ORGANIZATION', systemMemoryId: memory.id } });
  }
  const target = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'doc', name: 'Doc', content: 'body' } });
  return { memoryId: memory.id, targetId: target.id, targetUrn: `hrn:node:${memory.urn}:doc` };
}
const rev = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).revSeq;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'CS Org', urn: 'cs2277.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 227701, githubUsername: 'cs-admin', handle: 'cs-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});

describe('#2277 comment writers in a SOURCE memory queue on F', () => {
  const ops: Array<{ name: string; setup?: (f: Fixture, c: { id?: string; reply?: string }) => Promise<void>; run: (f: Fixture, c: { id?: string; reply?: string }) => Promise<unknown> }> = [
    { name: 'createComment', run: (f) => M.createComment(null, { targetRef: f.targetUrn, body: 'feedback' }, as()) },
    {
      name: 'replyToComment',
      setup: async (f, c) => { c.id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id; },
      run: (_f, c) => M.replyToComment(null, { commentRef: c.id, body: 'reply' }, as()),
    },
    {
      name: 'editComment',
      setup: async (f, c) => { c.id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id; },
      run: async (_f, c) => M.editComment(null, { commentRef: c.id, body: 'edited', expectedRevision: await rev(c.id!) }, as()),
    },
    {
      name: 'deleteComment (vanish)',
      setup: async (f, c) => { c.id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id; },
      run: async (_f, c) => M.deleteComment(null, { commentRef: c.id, expectedRevision: await rev(c.id!) }, as()),
    },
    {
      name: 'deleteComment (stub: live replies remain)',
      setup: async (f, c) => {
        c.id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id;
        await M.replyToComment(null, { commentRef: c.id, body: 'reply' }, as());
      },
      run: async (_f, c) => M.deleteComment(null, { commentRef: c.id, expectedRevision: await rev(c.id!) }, as()),
    },
    {
      name: 'resolveCommentThread (thread state only; uniform root, see analysis)',
      setup: async (f, c) => { c.id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id; },
      run: async (_f, c) => M.resolveCommentThread(null, { commentRef: c.id, expectedRevision: await rev(c.id!) }, as()),
    },
    {
      name: 'reopenCommentThread (a resolved thread)',
      setup: async (f, c) => {
        c.id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id;
        await M.resolveCommentThread(null, { commentRef: c.id, expectedRevision: await rev(c.id) }, as());
      },
      run: async (_f, c) => M.reopenCommentThread(null, { commentRef: c.id, expectedRevision: await rev(c.id!) }, as()),
    },
    {
      name: 'deleteCommentThread',
      setup: async (f, c) => { c.id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id; },
      run: (_f, c) => M.deleteCommentThread(null, { commentRef: c.id, reason: 'cleanup' }, as()),
    },
    {
      name: 'restoreNode (source memory)',
      setup: async (f, c) => {
        const n = await db.node.create({ data: { id: generateId(), memoryId: f.memoryId, loc: 'gone', name: 'Gone', content: 'x', deletedAt: new Date() } });
        c.id = n.id;
      },
      run: (_f, c) => M.restoreNode(null, { nodeRef: c.id }, as()),
    },
  ];

  it.each(ops)('$name queues behind a held F and completes after release', async (op) => {
    const f = await memoryFixture('system');
    const c: { id?: string; reply?: string } = {};
    await op.setup?.(f, c);
    expect(await queuedOnFence(() => op.run(f, c))).toBe(true);
  });
});

describe('#2277 scope control: a NON-source memory is not serialized on F', () => {
  it('editComment in a knowledge memory completes while F is held', async () => {
    const f = await memoryFixture('knowledge');
    const id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id;
    const fence = await holdF();
    const edited = await M.editComment(null, { commentRef: id, body: 'edited', expectedRevision: await rev(id) }, as());
    expect(edited.body).toBe('edited');
    fence.release();
    await fence.done;
  });

  it('restoreNode in a knowledge memory completes while F is held', async () => {
    const f = await memoryFixture('knowledge');
    const n = await db.node.create({ data: { id: generateId(), memoryId: f.memoryId, loc: 'gone', name: 'Gone', content: 'x', deletedAt: new Date() } });
    const fence = await holdF();
    const restored = await M.restoreNode(null, { nodeRef: n.id }, as());
    expect(restored.deletedAt).toBeNull();
    fence.release();
    await fence.done;
  });
});

describe('#2277 the writer HOLDS F for its whole transaction (reverse order)', () => {
  it('a compile-like F holder queued behind an in-flight source comment edit waits for its commit', async () => {
    const f = await memoryFixture('system');
    const id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id;
    const expectedRevision = await rev(id);
    // Park the writer inside its transaction (after F) on the comment row lock.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
      entered();
      await held;
    });
    await inside;
    const edit = M.editComment(null, { commentRef: id, body: 'edited', expectedRevision }, as());
    edit.catch(() => {});
    await waitForLockWaitersOfType(db, 'transactionid', 1, 5_000);
    let holderDone = false;
    const holder = withIncludeHistoryTransaction(db, async () => { holderDone = true; });
    holder.catch(() => {});
    await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
    expect(holderDone).toBe(false);
    release();
    await blocker;
    await edit;
    await holder;
    expect(holderDone).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id } })).content).toBe('edited');
  });
});

describe('#2277 locked drift refusal: a class change between the decision and the memory lock re-decides', () => {
  it('a knowledge memory turned system while the writer waits is retried WITH the fence and still commits', async () => {
    const f = await memoryFixture('knowledge');
    const id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'root' }, as())).id;
    const expectedRevision = await rev(id);
    // The agent that will own the memory as its system memory, so the caller keeps write access after the flip.
    await db.agent.create({ data: { id: generateId(), name: 'Src', urn: `cs2277.example:agent-${generateId().slice(-6)}`, organizationId: orgId, visibility: 'ORGANIZATION', systemMemoryId: f.memoryId } });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    // The class flip commits only after the writer has decided (not fenced) and is waiting for the memory lock.
    const flip = db.$transaction(async (tx) => {
      await tx.$queryRaw`UPDATE memories SET class = 'system' WHERE id = ${f.memoryId}`;
      entered();
      await held;
    });
    await inside;
    const edit = M.editComment(null, { commentRef: id, body: 'edited', expectedRevision }, as());
    edit.catch(() => {});
    await waitForLockWaitersOfType(db, 'transactionid', 1, 5_000);
    // Hold F too: the retried attempt must now queue on it, which proves it re-decided to fence.
    const fence = await holdF();
    release();
    await flip;
    await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
    fence.release();
    await fence.done;
    expect((await edit).body).toBe('edited');
  });
});

describe('#2277 the author who has LOST read access deletes their own comment (deleteOwnCommentWithoutAccess)', () => {
  it('queues behind a held F in a source memory, and the delete still commits after release', async () => {
    const f = await memoryFixture('system');
    const author = await db.user.create({ data: { githubId: 227702, githubUsername: 'cs-author', handle: 'cs-author', roles: [] } });
    const member = await db.orgMember.create({ data: { organizationId: orgId, userId: author.id, role: 'ADMIN' } });
    const asAuthor = (): Context => ({ db, userId: author.id, roles: [] });
    const id = (await M.createComment(null, { targetRef: f.targetUrn, body: 'mine' }, asAuthor())).id;
    // The author leaves the org: no read access remains, so the no-access delete path runs.
    await db.orgMember.delete({ where: { organizationId_userId: { organizationId: member.organizationId, userId: author.id } } });
    const expectedRevision = await rev(id);
    expect(await queuedOnFence(() => M.deleteComment(null, { commentRef: id, expectedRevision }, asAuthor()))).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  });
});
