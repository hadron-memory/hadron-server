/** #1253: authenticated mint lineage and the ruled subtree revocation boundary. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey, resolveAuthContext } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';

let userId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const authenticate = (rawKey: string) => resolveAuthContext({
  headers: { authorization: `Bearer ${rawKey}` },
} as Request, db);
async function root(issuedVia = 'portal') {
  return mintUserApiKey(db, {
    userId, createdBy: userId, label: 'synthetic root', issuedVia,
    oauthScopes: issuedVia.startsWith('oauth:') ? ['account'] : [],
  });
}
async function child(rawKey: string) {
  const auth = await authenticate(rawKey);
  expect(auth.userId).toBe(userId);
  return resolvers.Mutation.createUserApiKey(undefined, { label: 'synthetic child' }, {
    db, ...auth,
  } as Context);
}
async function revoke(id: string) {
  return resolvers.Mutation.revokeUserApiKey(undefined, { id }, ctx());
}

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: {
    id: generateId(), githubId: 1253001, githubUsername: 'lineage1253',
  } });
  userId = user.id;
});

describe('#1253 live authenticated parent and cascade', () => {
  it('records the actual authenticated key as the persisted parent', async () => {
    const parent = await root();
    const minted = await child(parent.rawKey);
    const stored = await db.userApiKey.findUniqueOrThrow({ where: { id: minted.userApiKey.id } });
    expect(stored.mintedByKeyId).toBe(parent.userApiKey.id);
  });

  it('records the OAuth minting credential issuance identity, rather than portal', async () => {
    const parent = await root('oauth:synthetic-client-a');
    const minted = await child(parent.rawKey);
    const stored = await db.userApiKey.findUniqueOrThrow({ where: { id: minted.userApiKey.id } });
    expect(stored.issuedVia).toBe('oauth:synthetic-client-a');
    expect(stored.createdBy).toBe(userId);
    expect(stored.oauthScopes).toEqual([]);
  });

  it('revokes descendants through multiple generations while preserving an independent root', async () => {
    const parent = await root();
    const independent = await root();
    const first = await child(parent.rawKey);
    const second = await child(first.rawKey);
    await revoke(parent.userApiKey.id);
    expect((await authenticate(parent.rawKey)).userId).toBeUndefined();
    expect((await authenticate(first.rawKey)).userId).toBeUndefined();
    expect((await authenticate(second.rawKey)).userId).toBeUndefined();
    expect((await authenticate(independent.rawKey)).userId).toBe(userId);
  });

  it('revokes only an intermediate subtree, keeping its parent and sibling live', async () => {
    const parent = await root();
    const first = await child(parent.rawKey);
    const sibling = await child(parent.rawKey);
    const grandchild = await child(first.rawKey);
    await revoke(first.userApiKey.id);
    expect((await authenticate(first.rawKey)).userId).toBeUndefined();
    expect((await authenticate(grandchild.rawKey)).userId).toBeUndefined();
    expect((await authenticate(parent.rawKey)).userId).toBe(userId);
    expect((await authenticate(sibling.rawKey)).userId).toBe(userId);
  });

  it('keeps direct issuance portal-labelled and hashed without a fabricated parent', async () => {
    const minted = await resolvers.Mutation.createUserApiKey(undefined, {}, ctx());
    const stored = await db.userApiKey.findUniqueOrThrow({ where: { id: minted.userApiKey.id } });
    expect(stored.issuedVia).toBe('portal');
    expect(stored.keyHash).not.toBe(minted.rawKey);
    expect(JSON.stringify(stored)).not.toContain(minted.rawKey);
    expect(stored.mintedByKeyId).toBeNull();
  });

  it('retains the narrower-scope mint refusal with a real authenticated key', async () => {
    const narrow = await mintUserApiKey(db, {
      userId, createdBy: userId, label: null, issuedVia: 'oauth:synthetic-narrow', oauthScopes: ['mcp'],
    });
    const auth = await authenticate(narrow.rawKey);
    await expect(resolvers.Mutation.createUserApiKey(undefined, {}, { db, ...auth } as Context))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.userApiKey.count()).toBe(1);
  });
});

describe('#1253 lifecycle and principal controls', () => {
  it('keeps OAuth clients distinct and preserves unknown legacy issuance identity', async () => {
    for (const issuedVia of ['oauth:synthetic-client-b', null]) {
      const parent = await mintUserApiKey(db, { userId, createdBy: userId, label: null, issuedVia });
      const minted = await child(parent.rawKey);
      const stored = await db.userApiKey.findUniqueOrThrow({ where: { id: minted.userApiKey.id } });
      expect(stored.issuedVia).toBe(issuedVia);
      expect(stored.mintedByKeyId).toBe(parent.userApiKey.id);
    }
  });

  it('revokes a deep branching tree idempotently without touching a legacy root', async () => {
    const parent = await root();
    const independent = await root('oauth:synthetic-client-a');
    const keys = [parent];
    let cursor = parent;
    for (let n = 0; n < 24; n++) {
      const branch = await child(cursor.rawKey);
      keys.push(branch);
      if (n % 4 === 0) keys.push(await child(cursor.rawKey));
      cursor = branch;
    }
    await revoke(parent.userApiKey.id);
    const before = await db.userApiKey.findMany({ orderBy: { id: 'asc' } });
    await revoke(parent.userApiKey.id);
    const after = await db.userApiKey.findMany({ orderBy: { id: 'asc' } });
    expect(after.map((key) => [key.id, key.revokedAt])).toEqual(before.map((key) => [key.id, key.revokedAt]));
    for (const key of keys) expect((await authenticate(key.rawKey)).userId).toBeUndefined();
    expect((await authenticate(independent.rawKey)).userId).toBe(userId);
    expect((await db.userApiKey.findUniqueOrThrow({ where: { id: independent.userApiKey.id } })).mintedByKeyId)
      .toBeNull();
  });

  it('refuses stale revoked, missing, or foreign parent identities before inserting', async () => {
    const parent = await root();
    await revoke(parent.userApiKey.id);
    const foreign = await db.user.create({ data: { id: generateId(), githubId: 1253002 } });
    const foreignKey = await mintUserApiKey(db, {
      userId: foreign.id, createdBy: foreign.id, label: null, issuedVia: 'portal',
    });
    for (const apiKeyId of [parent.userApiKey.id, 'missing-key', foreignKey.userApiKey.id]) {
      await expect(resolvers.Mutation.createUserApiKey(undefined, {}, { ...ctx(), apiKeyId }))
        .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
    expect(await db.userApiKey.count()).toBe(2);
    await expect(resolvers.Mutation.revokeUserApiKey(undefined, { id: foreignKey.userApiKey.id }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect((await authenticate(foreignKey.rawKey)).userId).toBe(foreign.id);
  });

  it('rechecks persisted narrow or unsupported scopes even with an incomplete request projection', async () => {
    for (const oauthScopes of [['mcp'], ['account', 'unsupported']]) {
      const raw = await root();
      await db.userApiKey.update({ where: { id: raw.userApiKey.id }, data: { oauthScopes } });
      await expect(resolvers.Mutation.createUserApiKey(undefined, {}, {
        ...ctx(), apiKeyId: raw.userApiKey.id,
      })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
    expect(await db.userApiKey.count()).toBe(2);
  });
});
