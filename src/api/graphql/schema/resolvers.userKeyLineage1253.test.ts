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
    // Cast keeps the red test runnable before the additive schema exists.
    expect((stored as unknown as { mintedByKeyId: string | null }).mintedByKeyId)
      .toBe(parent.userApiKey.id);
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
    expect((stored as unknown as { mintedByKeyId?: string | null }).mintedByKeyId ?? null)
      .toBeNull();
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
