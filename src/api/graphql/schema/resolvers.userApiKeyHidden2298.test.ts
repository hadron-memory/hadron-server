/** #2298: hide a revoked own UserApiKey. Display state only; authority is revokeUserApiKey's. */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let user: { id: string };
let other: { id: string };

const userCtx = (userId: string, o: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...o });
const hide = (id: string, hidden: boolean, c: Context = userCtx(user.id)) => M.setUserApiKeyHidden(undefined, { id, hidden }, c);
const list = (args: object = {}, c: Context = userCtx(user.id)) => Q.myUserApiKeys(undefined, args, c) as Promise<{ id: string }[]>;
async function mint(owner = user.id, label = 'k') {
  return (await M.createUserApiKey(undefined, { label }, userCtx(owner))).userApiKey as { id: string };
}
const revoke = (id: string, owner = user.id) => M.revokeUserApiKey(undefined, { id }, userCtx(owner));

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { id: generateId(), handle: 'alice', githubId: 2298001, githubUsername: 'alice2298' } });
  other = await db.user.create({ data: { id: generateId(), handle: 'bob', githubId: 2298002, githubUsername: 'bob2298' } });
});

describe('setUserApiKeyHidden (#2298)', () => {
  it('hides a revoked key from the default list and shows it with includeHidden', async () => {
    const k = await mint(); const keep = await mint(user.id, 'keep');
    await revoke(k.id);
    const row = await hide(k.id, true);
    expect(row.hiddenAt).toBeInstanceOf(Date);
    expect((await list()).map((r) => r.id)).toEqual([keep.id]);
    expect((await list({ includeHidden: true })).map((r) => r.id).sort()).toEqual([k.id, keep.id].sort());
    expect((await list({ includeHidden: false })).map((r) => r.id)).toEqual([keep.id]);
  });

  it('refuses an active key with KEY_ACTIVE and changes nothing', async () => {
    const k = await mint();
    await expect(hide(k.id, true)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', reason: 'KEY_ACTIVE' } });
    expect((await db.userApiKey.findUniqueOrThrow({ where: { id: k.id } })).hiddenAt).toBeNull();
  });

  it('collapses unknown and foreign ids to NOT_FOUND, and a foreign hide changes nothing', async () => {
    const k = await mint(); await revoke(k.id);
    await expect(hide('nope', true)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(hide(k.id, true, userCtx(other.id))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(hide(k.id, false, userCtx(other.id))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect((await db.userApiKey.findUniqueOrThrow({ where: { id: k.id } })).hiddenAt).toBeNull();
  });

  it('is idempotent: repeated hide keeps the first hiddenAt; unhide restores the default list', async () => {
    const k = await mint(); await revoke(k.id);
    const first = await hide(k.id, true);
    const second = await hide(k.id, true);
    expect(second.hiddenAt.toISOString()).toBe(first.hiddenAt.toISOString());
    const visible = await hide(k.id, false);
    expect(visible.hiddenAt).toBeNull();
    expect((await hide(k.id, false)).hiddenAt).toBeNull();
    expect((await list()).map((r) => r.id)).toEqual([k.id]);
  });

  it('touches no validity, lineage or descendant', async () => {
    const parent = await mint();
    const child = await db.userApiKey.create({ data: { userId: user.id, keyHash: generateId(), keyPreview: 'abcd',
      oauthScopes: [], mintedByKeyId: parent.id, issuedVia: 'portal' } });
    await revoke(parent.id);
    const before = await db.userApiKey.findUniqueOrThrow({ where: { id: parent.id } });
    await hide(parent.id, true);
    const after = await db.userApiKey.findUniqueOrThrow({ where: { id: parent.id } });
    expect({ ...after, hiddenAt: null }).toEqual(before);
    const c = await db.userApiKey.findUniqueOrThrow({ where: { id: child.id } });
    expect(c.hiddenAt).toBeNull();
    expect(c.revokedAt).not.toBeNull();
    expect((await list()).map((r) => r.id)).toEqual([child.id]);
  });

  it('refuses App-key callers and impersonation; myUserApiKeys still refuses impersonation', async () => {
    const k = await mint(); await revoke(k.id);
    await expect(M.setUserApiKeyHidden(undefined, { id: k.id, hidden: true }, { db, appId: 'a', roles: [] }))
      .rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    const imp = userCtx(user.id, { impersonation: { orgId: 'o', sessionId: 's' } as any });
    await expect(hide(k.id, true, imp)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(list({ includeHidden: true }, imp)).rejects.toThrow();
    expect((await db.userApiKey.findUniqueOrThrow({ where: { id: k.id } })).hiddenAt).toBeNull();
  });

  it('never leaves a hidden active key when hide races revoke', async () => {
    for (let i = 0; i < 12; i++) {
      const k = await mint(user.id, `r${i}`);
      const [h] = await Promise.allSettled([hide(k.id, true), revoke(k.id)]);
      const row = await db.userApiKey.findUniqueOrThrow({ where: { id: k.id } });
      expect(row.revokedAt).not.toBeNull();
      if (h.status === 'rejected') {
        expect((h.reason as any).extensions.reason).toBe('KEY_ACTIVE');
        expect(row.hiddenAt).toBeNull();
      } else {
        expect(row.hiddenAt).not.toBeNull();
      }
    }
  });
});
