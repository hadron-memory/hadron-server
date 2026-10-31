/**
 * updateNodeProperties / updateObject own their transaction, so they must take the write authority first, like the
 * core's own-transaction path (`lockInstallAuthorityFirst`, #2206 / #2064): the authority anchors BEFORE the per-node
 * advisory lock, the memory row and the write. Two pins per entry point:
 *  - race: a demotion holding the actor's anchor wins; the write waits, is refused on the live role, and writes nothing;
 *  - order: while the node's advisory lock is held elsewhere, the queued writer already holds the actor's anchor
 *    (an exclusive anchor attempt cannot get in). Install memories: installMemory.lifecycle.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

type User = { id: string; roles: string[] };
let platform: User;
let agentOwner: User;
let systemNodeId: string;

const ctxOf = (user: User) => ({ db, userId: user.id, roles: user.roles, clientId: `user:${user.id}` }) as unknown as Context;

async function user(name: string, roles: string[] = ['READER']): Promise<User> {
  const row = await db.user.create({ data: { id: generateId(), name, handle: `${name}-${generateId().slice(-6).toLowerCase()}`, roles: roles as any } });
  return { id: row.id, roles };
}

type Writer = (ctx: Context, nodeId: string, patch: Record<string, unknown>) => Promise<unknown>;
const writers: Array<[string, Writer]> = [
  ['updateNodeProperties', (ctx, nodeId, properties) => M.updateNodeProperties(null, { nodeRef: nodeId, properties }, ctx)],
  ['updateObject', (ctx, nodeId, fields) => M.updateObject(null, { ref: nodeId, fields }, ctx)],
];

beforeEach(async () => {
  await cleanDb(db);
  platform = await user('platform', ['ADMIN']);
  agentOwner = await user('agent-owner');
  const userAgent = await M.createAgent({}, { name: 'LO Personal Agent' }, ctxOf(agentOwner));
  systemNodeId = (await db.node.create({ data: { id: generateId(), memoryId: userAgent.systemMemoryId, loc: 'def', name: 'Def', content: 'c' } })).id;
});

describe.each(writers)('%s takes the write authority before its own locks', (_name, write) => {
  it('a demotion racing the write wins: the write waits on the actor anchor, then is refused; nothing written', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const demotion = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: platform.id }], 'exclusive');
      await tx.user.update({ where: { id: platform.id }, data: { roles: ['READER'] } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const writing = write(ctxOf(platform), systemNodeId, { raced: true }).then(() => 'wrote', (e: any) => e);
    let outcome: unknown = 'pending';
    void writing.then((o) => { outcome = o; });
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 3_000);
      // Still queued behind the demotion: it has not committed.
      expect(outcome).toBe('pending');
    } finally {
      release();
      await demotion;
    }
    const refusal = await writing;
    expect(refusal).not.toBe('wrote');
    expect(refusal).toMatchObject({ message: expect.stringContaining('no write access to this memory'), extensions: { code: 'FORBIDDEN' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: systemNodeId } })).properties).toBeNull();
    // Control: the owner's write is unaffected by the platform actor's demotion.
    await write(ctxOf(agentOwner), systemNodeId, { ok: true });
    expect((await db.node.findUniqueOrThrow({ where: { id: systemNodeId } })).properties).toMatchObject({ ok: true });
  });

  it('lock order, user-owned Agent system memory: the queued writer already holds the actor anchor', async () => {
    const nodeId = systemNodeId;
    const actor = platform;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    // Another writer of the same node: holds its advisory lock (the one the write queues on).
    const blocker = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${nodeId}))`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const writing = write(ctxOf(actor), nodeId, { ordered: true }).then(() => 'wrote', (e: any) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      // An exclusive anchor attempt cannot get in: the writer holds the anchor (shared) while it waits on the node.
      const probe = db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '400ms'`;
        await lockAuthorityAnchors(tx, [{ kind: 'user', id: actor.id }], 'exclusive');
      }, { timeout: 10_000 });
      await expect(probe).rejects.toMatchObject({ meta: { code: '55P03' } });
    } finally {
      release();
      await blocker;
    }
    expect(await writing).toBe('wrote');
  });
});
