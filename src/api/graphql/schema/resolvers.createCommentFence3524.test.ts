/**
 * #3524 (A2 only) — createComment builds its view INSIDE the fenced transaction, from the in-fence key
 * and the inserted id only. Nothing after the commit can turn a committed write into a refusal, and the
 * response describes the comment as of the commit.
 *
 * The post-commit phase is faulted at its real seam: a db wrapper whose `$transaction` runs the fault right
 * after the comment transaction resolves (not on the Nth call to a reader).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { parseDataKey, isCiphertext } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import * as nodeCrypto from '../../../lib/nodeCrypto.js';
import * as enqueue from '../../../services/embedding/enqueue.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let other: { id: string };
let orgId: string;
const dataKey = parseDataKey(Buffer.alloc(32, 7).toString('base64'));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const ctxOf = (userId: string, wrapped: Context['db'] = db): Context => ({ db: wrapped, userId, roles: [] });

/** A db whose comment-creating transaction is observed: `before` runs before it opens, `after` once it has committed. */
function seamDb(hooks: { before?: () => Promise<void>; after?: () => Promise<void>; wrapTx?: (tx: any) => any }): Context['db'] {
  let afterFired = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return async (cb: (tx: any) => Promise<unknown>, ...rest: unknown[]) => {
        await hooks.before?.();
        const result = await (target as any).$transaction((tx: any) => cb(hooks.wrapTx ? hooks.wrapTx(tx) : tx), ...rest);
        // Fire once, after the transaction that wrote the comment.
        if (!afterFired && (await db.commentMeta.count()) > 0) {
          afterFired = true;
          await hooks.after?.();
        }
        return result;
      };
    },
  }) as Context['db'];
}

async function memoryWithTarget(opts: { encrypted: boolean; name: string }) {
  const memory = await resolvers.Mutation.createMemory(null, { orgId, name: opts.name }, ctxOf(admin.id));
  if (opts.encrypted) await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
  const target = await db.node.create({
    data: {
      id: generateId(), memoryId: memory.id, loc: 't:1', name: 'Title',
      ...(opts.encrypted ? encryptNodeFieldsWithKey({ content: 'Body' }, dataKey) : { content: 'Body' }),
    },
  });
  if (opts.encrypted) sessionKeyCache.set('fence-3524', memory.id, dataKey);
  return { memory, target };
}

const counts = async () => ({
  nodes: await db.node.count({ where: { nodeType: 'comment' } }),
  metas: await db.commentMeta.count(),
  anchors: await db.edge.count({ where: { governedKind: 'COMMENT_ANCHOR' } }),
  revisions: await db.nodeRevision.count({ where: { node: { nodeType: 'comment' } } }),
});

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'Fence Org', urn: 'fence3524.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 352401, githubUsername: 'fence-admin', handle: 'fence-admin', roles: [] } });
  other = await db.user.create({ data: { githubId: 352402, githubUsername: 'fence-other', handle: 'fence-other', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'ADMIN' } });
});
afterEach(() => { vi.restoreAllMocks(); sessionKeyCache.clear(); });

describe('#3524 A2: the view is the committed comment, whatever happens after the commit', () => {
  it('encrypted memory: the key evicted AFTER the commit does not turn the committed write into SESSION_EXPIRED', async () => {
    const { target } = await memoryWithTarget({ encrypted: true, name: 'enc-evict' });
    const seam = seamDb({ after: async () => { sessionKeyCache.clear(); } });
    const view = await M.createComment(null, { targetRef: target.id, body: 'private feedback', quote: 'quoted' }, ctxOf(admin.id, seam));
    expect(view).toMatchObject({ body: 'private feedback', quote: 'quoted' });
    const stored = await db.node.findUniqueOrThrow({ where: { id: view.id } });
    expect(isCiphertext(stored.content)).toBe(true);
    expect(await counts()).toEqual({ nodes: 1, metas: 1, anchors: 1, revisions: 0 });
  });

  it('a hard delete after the commit returns the commit-time view; the row is gone', async () => {
    const { target } = await memoryWithTarget({ encrypted: false, name: 'hard-del' });
    const seam = seamDb({ after: async () => {
      // The DB invariant removes the anchor and meta only together with the comment node.
      await db.node.deleteMany({ where: { nodeType: 'comment' } });
    } });
    const view = await M.createComment(null, { targetRef: target.id, body: 'first words' }, ctxOf(admin.id, seam));
    expect(view).toMatchObject({ body: 'first words', deleted: false, state: 'OPEN' });
    expect((await counts()).nodes).toBe(0);
  });

  it('a soft delete after the commit returns the original view; an independent read shows the deleted state', async () => {
    const { target } = await memoryWithTarget({ encrypted: false, name: 'soft-del' });
    const seam = seamDb({ after: async () => {
      await db.node.updateMany({ where: { nodeType: 'comment' }, data: { deletedAt: new Date() } });
    } });
    const view = await M.createComment(null, { targetRef: target.id, body: 'soft words' }, ctxOf(admin.id, seam));
    expect(view).toMatchObject({ body: 'soft words', deleted: false });
    const row = await db.node.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('G3: a post-commit encryption flip cannot change the built view or the queued embedding plaintext', async () => {
    const { memory, target } = await memoryWithTarget({ encrypted: false, name: 'flip-after' });
    const enq = vi.spyOn(enqueue, 'enqueueNodeEmbedding').mockResolvedValue(undefined as never);
    const seam = seamDb({ after: async () => {
      await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
      sessionKeyCache.set('fence-3524', memory.id, dataKey);
    } });
    const view = await M.createComment(null, { targetRef: target.id, body: 'plain at commit' }, ctxOf(admin.id, seam));
    expect(view.body).toBe('plain at commit');
    await vi.waitFor(() => expect(enq).toHaveBeenCalledTimes(1));
    expect((enq.mock.calls[0]![1] as { plaintext: { content: string } }).plaintext.content).toBe('plain at commit');
  });
});

describe('#3524 A2: the in-fence key is the writer\'s key (G2) and the view reads the inserted id only (G1)', () => {
  it('G2: a memory that turns encrypted between prepare and the fence stores ciphertext and answers plaintext', async () => {
    const { memory, target } = await memoryWithTarget({ encrypted: false, name: 'flip-before' });
    const seam = seamDb({ before: async () => {
      await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
      sessionKeyCache.set('fence-3524', memory.id, dataKey);
    } });
    const view = await M.createComment(null, { targetRef: target.id, body: 'secret at fence' }, ctxOf(admin.id, seam));
    expect(view.body).toBe('secret at fence');
    expect(isCiphertext((await db.node.findUniqueOrThrow({ where: { id: view.id } })).content)).toBe(true);
  });

  it('G1: only the inserted row is decrypted, with another author\'s encrypted comment in the same memory', async () => {
    const { target } = await memoryWithTarget({ encrypted: true, name: 'enc-g1' });
    await M.createComment(null, { targetRef: target.id, body: 'other author secret' }, ctxOf(other.id));
    await M.replyToComment(null, { commentRef: (await db.node.findFirstOrThrow({ where: { nodeType: 'comment' } })).id, body: 'other reply' }, ctxOf(other.id));
    const spy = vi.spyOn(nodeCrypto, 'decryptNodeFieldsWithKey');
    const view = await M.createComment(null, { targetRef: target.id, body: 'mine' }, ctxOf(admin.id));
    expect(view.body).toBe('mine');
    // One decrypt for the single inserted row: a widened id list or a thread read would add more.
    const commentDecrypts = spy.mock.calls.filter(([fields]) => (fields as { data?: unknown }).data !== undefined && 'content' in (fields as object));
    expect(commentDecrypts.length).toBe(1);
  });
});

describe('#3524 A2: contract that stays', () => {
  it('a projection that finds nothing inside the transaction refuses and rolls the write back', async () => {
    const { target } = await memoryWithTarget({ encrypted: false, name: 'proj-empty' });
    const seam = seamDb({ wrapTx: (tx) => new Proxy(tx, {
      get(t, prop, r) {
        const v = Reflect.get(t, prop, r);
        if (prop !== 'node') return v;
        return new Proxy(v, { get(nt, np, nr) {
          if (np === 'findMany') return async (args: { where?: { nodeType?: string } }) =>
            args?.where?.nodeType === 'comment' ? [] : (nt as any).findMany(args);
          return Reflect.get(nt, np, nr);
        } });
      },
    }) });
    await expect(M.createComment(null, { targetRef: target.id, body: 'nothing' }, ctxOf(admin.id, seam)))
      .rejects.toMatchObject({ extensions: { code: 'COMMENT_NOT_FOUND' } });
    expect(await counts()).toEqual({ nodes: 0, metas: 0, anchors: 0, revisions: 0 });
  });

  it('ordinary creation leaves 1 node, 1 meta, 1 anchor, 0 revisions; a second open root is refused', async () => {
    const { target } = await memoryWithTarget({ encrypted: false, name: 'plain-ok' });
    const view = await M.createComment(null, { targetRef: target.id, body: 'one' }, ctxOf(admin.id));
    expect(view).toMatchObject({ body: 'one', state: 'OPEN', isTopLevel: true });
    expect(await counts()).toEqual({ nodes: 1, metas: 1, anchors: 1, revisions: 0 });
    await expect(M.createComment(null, { targetRef: target.id, body: 'two' }, ctxOf(admin.id)))
      .rejects.toMatchObject({ extensions: { code: 'COMMENT_OPEN_THREAD_EXISTS' } });
    expect((await counts()).nodes).toBe(1);
  });

  it('a projection failure inside the transaction rolls the whole comment back', async () => {
    const { target } = await memoryWithTarget({ encrypted: false, name: 'proj-fail' });
    const seam = seamDb({ wrapTx: (tx) => new Proxy(tx, {
      get(t, prop, r) {
        const v = Reflect.get(t, prop, r);
        if (prop !== 'node') return v;
        return new Proxy(v, { get(nt, np, nr) {
          if (np === 'findMany') return async (args: { where?: { nodeType?: string } }) => {
            if (args?.where?.nodeType === 'comment') throw new Error('projection fault');
            return (nt as any).findMany(args);
          };
          return Reflect.get(nt, np, nr);
        } });
      },
    }) });
    await expect(M.createComment(null, { targetRef: target.id, body: 'never lands' }, ctxOf(admin.id, seam))).rejects.toThrow('projection fault');
    expect(await counts()).toEqual({ nodes: 0, metas: 0, anchors: 0, revisions: 0 });
  });
});
