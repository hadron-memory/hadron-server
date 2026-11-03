/**
 * #2659 (hrn:node:hadronmemory.com:specs:cor:dmo:070:03; rulings 0004 A, 0005 B, 0006 A, 0007 A): a user deletes one of
 * their own API keys.
 *  - Any own key, live or revoked. A live key is revoked first, with every key it minted (cor:aut:010:02 rule 9), in
 *    the same step, so a delete never leaves a working credential behind.
 *  - Deleting deletes nothing else. The keys it minted stay, revoked, with no parent; the break is recorded once, in
 *    the deletion's record.
 *  - Only the key's own user, as themselves: never under impersonation, with an App key, from a worker session (any
 *    shape) or as a run principal. Unknown and foreign ids are NOT_FOUND, as revokeUserApiKey answers.
 *  - One append-only record survives: who, which key (id and masked preview), when. Never the secret or its hash.
 *  - Delete serializes with revoke, hide and mint on the user's authority anchor: no half state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { requestActorStorage, runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { hashUserApiKey, resolveAuthContext } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let user: { id: string };
let other: { id: string };

const userCtx = (userId: string, o: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...o }) as Context;
const del = (id: string, c: Context = userCtx(user.id)) => M.deleteUserApiKey(undefined, { id }, c);
const revoke = (id: string, c: Context = userCtx(user.id)) => M.revokeUserApiKey(undefined, { id }, c);
const hide = (id: string, c: Context = userCtx(user.id)) => M.setUserApiKeyHidden(undefined, { id, hidden: true }, c);
async function mint(owner = user.id, label = 'k', c: Context = userCtx(owner)) {
  return (await M.createUserApiKey(undefined, { label }, c)) as { userApiKey: { id: string; keyPreview: string }; rawKey: string };
}
/** A key minted BY a key: the caller authenticates with `parentId`, so the new key records it (rule 9). */
const mintFrom = (parentId: string, label = 'child') => mint(user.id, label, userCtx(user.id, { apiKeyId: parentId }));
const listIds = async (includeHidden: boolean) =>
  ((await Q.myUserApiKeys(undefined, { includeHidden }, userCtx(user.id))) as { id: string }[]).map((r) => r.id).sort();
const authenticates = async (rawKey: string) =>
  Boolean((await resolveAuthContext({ headers: { authorization: `Bearer ${rawKey}` } } as unknown as Request, db)).userId);
const records = () => db.userApiKeyDeletion.findMany({ orderBy: { deletedAt: 'asc' } });
const keyRow = (id: string) => db.userApiKey.findUnique({ where: { id } });

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { id: generateId(), handle: 'kd-alice', githubId: 2659001, githubUsername: 'alice2659' } });
  other = await db.user.create({ data: { id: generateId(), handle: 'kd-bob', githubId: 2659002, githubUsername: 'bob2659' } });
});

describe('deleteUserApiKey: which keys and what remains (cor:dmo:070:03)', () => {
  it('deletes an own revoked key: gone from every list (any includeHidden), its token never authenticates', async () => {
    const k = await mint(); const keep = await mint(user.id, 'keep');
    await revoke(k.userApiKey.id);
    await hide(k.userApiKey.id);
    const out = await del(k.userApiKey.id);
    expect(out).toMatchObject({ keyId: k.userApiKey.id, keyPreview: k.userApiKey.keyPreview, revokedKeyIds: [], mintedKeyIds: [] });
    expect(await keyRow(k.userApiKey.id)).toBeNull();
    expect(await listIds(false)).toEqual([keep.userApiKey.id]);
    expect(await listIds(true)).toEqual([keep.userApiKey.id]);
    const page = await Q.myUserApiKeysPage(undefined, { includeHidden: true }, userCtx(user.id));
    expect(page.items.map((r: { id: string }) => r.id)).toEqual([keep.userApiKey.id]);
    expect(await authenticates(k.rawKey)).toBe(false);
    expect(await authenticates(keep.rawKey)).toBe(true);
  });

  it('deletes an own LIVE key: revoked in the same step, so its token no longer authenticates', async () => {
    const k = await mint();
    expect(await authenticates(k.rawKey)).toBe(true);
    const out = await del(k.userApiKey.id);
    expect(out.revokedKeyIds).toEqual([k.userApiKey.id]);
    expect(await keyRow(k.userApiKey.id)).toBeNull();
    expect(await authenticates(k.rawKey)).toBe(false);
  });

  it('a live key with minted keys: the whole subtree is revoked; the keys it minted stay, revoked, with no parent', async () => {
    const parent = await mint(user.id, 'parent');
    const child = await mintFrom(parent.userApiKey.id, 'child');
    const grandchild = await mintFrom(child.userApiKey.id, 'grandchild');
    const sibling = await mint(user.id, 'unrelated');
    const out = await del(parent.userApiKey.id);
    expect([...out.revokedKeyIds].sort()).toEqual([parent.userApiKey.id, child.userApiKey.id, grandchild.userApiKey.id].sort());
    expect(out.mintedKeyIds).toEqual([child.userApiKey.id]);
    const c = await keyRow(child.userApiKey.id);
    expect(c).toMatchObject({ mintedByKeyId: null });
    expect(c!.revokedAt).not.toBeNull();
    // Only the direct link to the deleted key breaks: the grandchild still records its own minting key.
    expect(await keyRow(grandchild.userApiKey.id)).toMatchObject({ mintedByKeyId: child.userApiKey.id });
    expect((await keyRow(grandchild.userApiKey.id))!.revokedAt).not.toBeNull();
    for (const k of [parent, child, grandchild]) expect(await authenticates(k.rawKey)).toBe(false);
    expect(await authenticates(sibling.rawKey)).toBe(true);
    expect(await listIds(true)).toEqual([child.userApiKey.id, grandchild.userApiKey.id, sibling.userApiKey.id].sort());
  });

  it('a revoked key with minted keys is not refused: they stay (already revoked by rule 9), now with no parent', async () => {
    const parent = await mint(user.id, 'parent');
    const child = await mintFrom(parent.userApiKey.id);
    await revoke(parent.userApiKey.id);
    const revokedAt = (await keyRow(child.userApiKey.id))!.revokedAt;
    const out = await del(parent.userApiKey.id);
    expect(out).toMatchObject({ revokedKeyIds: [], mintedKeyIds: [child.userApiKey.id] });
    expect(await keyRow(child.userApiKey.id)).toMatchObject({ mintedByKeyId: null, revokedAt });
    // The child, now parentless, is deletable on its own.
    await del(child.userApiKey.id);
    expect(await listIds(true)).toEqual([]);
  });

  it('a second delete of the same key is NOT_FOUND and records nothing more', async () => {
    const k = await mint();
    await del(k.userApiKey.id);
    await expect(del(k.userApiKey.id)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await records()).toHaveLength(1);
  });
});

describe('deleteUserApiKey: the record of the deletion (ruling 0007)', () => {
  it('keeps exactly one record: who, which key (id and masked preview), when, and the broken link; no secret, no hash', async () => {
    const parent = await mint(user.id, 'parent');
    const child = await mintFrom(parent.userApiKey.id);
    const hash = (await keyRow(parent.userApiKey.id))!.keyHash;
    const before = new Date();
    const out = await del(parent.userApiKey.id);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: out.id, userId: user.id, keyId: parent.userApiKey.id, keyPreview: parent.userApiKey.keyPreview,
      mintedKeyIds: [child.userApiKey.id],
    });
    expect([...rows[0].revokedKeyIds].sort()).toEqual([parent.userApiKey.id, child.userApiKey.id].sort());
    expect(rows[0].deletedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    const text = JSON.stringify(rows[0]) + JSON.stringify(out);
    expect(text).not.toContain(hash);
    expect(text).not.toContain(parent.rawKey);
    expect(text).not.toContain(hashUserApiKey(parent.rawKey));
    expect(Object.keys(rows[0]).sort()).toEqual(['deletedAt', 'id', 'keyId', 'keyPreview', 'mintedKeyIds', 'revokedKeyIds', 'userId']);
  });

  it('the record is append-only: never updated, and never deleted while its user exists', async () => {
    const k = await mint();
    const { id } = await del(k.userApiKey.id);
    await expect(db.userApiKeyDeletion.update({ where: { id }, data: { keyPreview: 'zzzz' } })).rejects.toThrow(/append-only/);
    await expect(db.userApiKeyDeletion.delete({ where: { id } })).rejects.toThrow(/append-only/);
    expect(await records()).toHaveLength(1);
  });
});

describe('deleteUserApiKey: who may delete (ruling 0006)', () => {
  it('unknown and foreign ids are NOT_FOUND, byte-identical, and nothing changes', async () => {
    const mine = await mint(); const theirs = await mint(other.id, 'theirs');
    const snapshot = async () => ({ keys: await db.userApiKey.findMany({ orderBy: { id: 'asc' } }), recs: await records() });
    const before = await snapshot();
    const unknown = await del('nope').catch((e) => ({ code: e.extensions?.code, message: e.message }));
    const foreign = await del(theirs.userApiKey.id).catch((e) => ({ code: e.extensions?.code, message: e.message }));
    expect(unknown).toEqual({ code: 'NOT_FOUND', message: 'UserApiKey nope not found.' });
    expect(foreign).toEqual({ code: 'NOT_FOUND', message: `UserApiKey ${theirs.userApiKey.id} not found.` });
    expect(await snapshot()).toEqual(before);
    expect(await authenticates(theirs.rawKey)).toBe(true);
    expect(await authenticates(mine.rawKey)).toBe(true);
  });

  it('refuses every non-person shape with the same FORBIDDEN, writing nothing; an App key is UNAUTHENTICATED', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'KD Org', urn: 'kd2659.test' } });
    const app = await db.app.create({ data: { organizationId: org.id, name: 'KD App', urn: 'kd2659.test:app' } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 'KD Agent', urn: 'kd2659.test:agent' } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'KD Worker', slug: 'kd-worker', heldByUserId: user.id } });
    const workerSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: user.id, tool: 'vitest' } });
    const appKey = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'hdr_app_x...0000' } });
    const k = await mint();
    const call = (c: Context) => del(k.userApiKey.id, c).then(
      () => ({ admitted: true }),
      (e: any) => ({ code: e?.extensions?.code ?? null, message: String(e?.message) }),
    );
    const FORBIDDEN = { code: 'FORBIDDEN', message: 'Forbidden' };
    const shapes: Record<string, () => Promise<unknown>> = {
      boundWorker: () => runAsActor({ workerId: worker.id, agentId: agent.id }, () => call(userCtx(user.id))),
      sessionRowWorker: () => call(userCtx(user.id, { sessionId: workerSession.id })),
      ambiguousActor: () => requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['s1', 's2'] } as never, () => call(userCtx(user.id))),
      refusedBinding: () => call(userCtx(user.id, { sessionBindingRefused: true } as never)),
      impersonation: () => call(userCtx(user.id, { impersonation: { sessionId: generateId(), actorUserId: other.id, orgId: org.id, expiresAt: new Date('2099-01-01') } } as never)),
      runPrincipal: () => call(userCtx(user.id, { clientId: `${RUN_CLIENT_PREFIX}${generateId()}`, appId: app.id, organizationId: org.id } as never)),
      userWithAppKey: () => call(userCtx(user.id, { appId: app.id, appKeyId: appKey.id } as never)),
    };
    for (const [name, shape] of Object.entries(shapes)) expect([name, await shape()]).toEqual([name, FORBIDDEN]);
    expect(await call({ db, appId: app.id, appKeyId: appKey.id, organizationId: org.id, roles: [] } as unknown as Context))
      .toEqual({ code: 'UNAUTHENTICATED', message: 'deleteUserApiKey requires a user-scoped credential; AppKey callers cannot delete user keys.' });
    expect(await keyRow(k.userApiKey.id)).toMatchObject({ revokedAt: null });
    expect(await records()).toEqual([]);
    expect(await authenticates(k.rawKey)).toBe(true);
  });

  it('the key\'s own user, authenticated with that very key, may delete it', async () => {
    const k = await mint();
    await del(k.userApiKey.id, userCtx(user.id, { apiKeyId: k.userApiKey.id }));
    expect(await keyRow(k.userApiKey.id)).toBeNull();
  });
});

describe('deleteUserApiKey: serializes with revoke, hide and mint on the user anchor (no half state)', () => {
  it('delete racing revoke, hide or a second delete: the key is gone, exactly one record, the loser answers cleanly', async () => {
    for (let i = 0; i < 8; i++) {
      for (const rival of ['revoke', 'hide', 'delete'] as const) {
        const k = await mint(user.id, `${rival}${i}`);
        if (rival === 'hide') await revoke(k.userApiKey.id);
        const rivalCall = rival === 'revoke' ? revoke(k.userApiKey.id) : rival === 'hide' ? hide(k.userApiKey.id) : del(k.userApiKey.id);
        const [d, r] = await Promise.allSettled([del(k.userApiKey.id), rivalCall]);
        expect(await keyRow(k.userApiKey.id)).toBeNull();
        const recs = (await records()).filter((x) => x.keyId === k.userApiKey.id);
        expect(recs).toHaveLength(1);
        // Whoever ran second on the anchor saw no key: NOT_FOUND, never a half state or a lock error.
        for (const s of [d, r]) if (s.status === 'rejected') expect((s.reason as any).extensions?.code).toBe('NOT_FOUND');
        expect([d, r].filter((s) => s.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('delete racing a mint BY that key: no live key is left under a deleted parent, and no link dangles', async () => {
    for (let i = 0; i < 8; i++) {
      const parent = await mint(user.id, `p${i}`);
      const [d, m] = await Promise.allSettled([del(parent.userApiKey.id), mintFrom(parent.userApiKey.id, `c${i}`)]);
      expect(d.status).toBe('fulfilled');
      expect(await keyRow(parent.userApiKey.id)).toBeNull();
      if (m.status === 'fulfilled') {
        // The mint won the anchor: its key was then revoked and unparented by the delete.
        const c = await keyRow(m.value.userApiKey.id);
        expect(c).toMatchObject({ mintedByKeyId: null });
        expect(c!.revokedAt).not.toBeNull();
        expect(await authenticates(m.value.rawKey)).toBe(false);
      } else {
        expect((m.reason as any).extensions?.code).toBe('FORBIDDEN');
      }
      expect(await db.userApiKey.count({ where: { mintedByKeyId: parent.userApiKey.id } })).toBe(0);
      expect(await db.userApiKey.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    }
  });
});
