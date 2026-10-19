/** Real two-connection ordering tests. Barriers identify the actual blocker backend. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';

let userId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { id: generateId(), githubId: 1253091 } })).id;
});
async function key() {
  return mintUserApiKey(db, { userId, createdBy: userId, label: null, issuedVia: 'portal' });
}
async function blockedBy(pid: number): Promise<number> {
  const deadline = Date.now() + 7000;
  do {
    const rows = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`;
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('Expected transaction did not wait behind the staged backend');
}
async function holdKey(id: string) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<number>((resolve) => { ready = resolve; });
  const done = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM user_api_keys WHERE id = ${id} FOR UPDATE`;
    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(backend.pid);
    await gate;
  }, { timeout: 20000 });
  return { pid: await locked, release, done };
}

describe('#1253 mint/revoke authority handoff', () => {
  it('a mint that wins the anchor is included in the later ancestor cascade', async () => {
    const root = await key();
    const parent = await resolvers.Mutation.createUserApiKey(undefined, {}, { ...ctx(), apiKeyId: root.userApiKey.id });
    const holder = await holdKey(parent.userApiKey.id);
    const mint = resolvers.Mutation.createUserApiKey(undefined, {}, { ...ctx(), apiKeyId: parent.userApiKey.id });
    let revoke: Promise<unknown> | undefined;
    try {
      const mintPid = await blockedBy(holder.pid);
      revoke = resolvers.Mutation.revokeUserApiKey(undefined, { id: root.userApiKey.id }, ctx());
      await blockedBy(mintPid);
      holder.release();
      await holder.done;
      const minted = await mint;
      await revoke;
      expect((await db.userApiKey.findUniqueOrThrow({ where: { id: minted.userApiKey.id } })).revokedAt)
        .not.toBeNull();
      expect(await db.userApiKey.count({ where: { revokedAt: null } })).toBe(0);
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, mint, ...(revoke ? [revoke] : [])]);
    }
  }, 15000);

  it('a mint queued behind ancestor revocation refuses its stale descendant credential', async () => {
    const root = await key();
    const parent = await resolvers.Mutation.createUserApiKey(undefined, {}, { ...ctx(), apiKeyId: root.userApiKey.id });
    const holder = await holdKey(root.userApiKey.id);
    const revoke = resolvers.Mutation.revokeUserApiKey(undefined, { id: root.userApiKey.id }, ctx());
    let mint: Promise<unknown> | undefined;
    try {
      const revokePid = await blockedBy(holder.pid);
      // Attach the rejection handler before releasing the revoker.
      mint = resolvers.Mutation.createUserApiKey(undefined, {}, { ...ctx(), apiKeyId: parent.userApiKey.id })
        .then(() => ({ admitted: true }), (error: unknown) => error);
      await blockedBy(revokePid);
      holder.release();
      await holder.done;
      await revoke;
      expect(await mint).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(await db.userApiKey.count()).toBe(2);
      expect(await db.userApiKey.count({ where: { revokedAt: null } })).toBe(0);
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, revoke, ...(mint ? [mint] : [])]);
    }
  }, 15000);

  it('account deletion covers the lineage and blocks subsequent minting', async () => {
    const root = await key();
    const descendant = await resolvers.Mutation.createUserApiKey(undefined, {}, { ...ctx(), apiKeyId: root.userApiKey.id });
    await deleteUserAccount(db, { targetUserId: userId, actorUserId: userId });
    expect(await db.userApiKey.count({ where: { revokedAt: null } })).toBe(0);
    await expect(resolvers.Mutation.createUserApiKey(undefined, {}, { ...ctx(), apiKeyId: descendant.userApiKey.id }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});
