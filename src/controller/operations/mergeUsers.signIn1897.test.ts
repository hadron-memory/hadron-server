/**
 * #1897 (Bindi P2-1, #2116): an account merge must not abort for a user who owns
 * a sign-in lineage. The same-owner composite FKs forbid retargeting a key or code
 * away from its root's user, so the merge ends the source's sign-ins and leaves
 * what descends from them on the (soft-deleted) source, dead.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { generateId } from '../../lib/id.js';
import { createSignIn } from '../../auth/signIn.js';
import { mintUserApiKey } from '../../middleware/auth.js';

describe('mergeUsers with a sign-in lineage (#1897)', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  it('ends the source sign-ins, revokes lineage keys, drops lineage codes, and still moves legacy rows', async () => {
    const [source, target] = await Promise.all([
      db.user.create({ data: { handle: 'lineage-merge-source' } }),
      db.user.create({ data: { handle: 'lineage-merge-target' } }),
    ]);
    await db.oAuthClient.create({ data: { clientId: 'lineage-merge', clientName: 'L', redirectUris: ['http://localhost/cb'] } });
    const si = await db.$transaction((tx) => createSignIn(tx, { userId: source.id, method: 'email', passkeyId: null }));
    const lineageKey = await mintUserApiKey(db, { userId: source.id, label: 'lineage', createdBy: source.id, issuedVia: 'oauth:c', originSignInId: si.id });
    const legacyKey = await mintUserApiKey(db, { userId: source.id, label: 'legacy', createdBy: source.id, issuedVia: 'oauth:c' });
    const lineageHandoff = await db.authHandoffCode.create({ data: { codeHash: generateId(), kind: 'login', userId: source.id, signInId: si.id, expiresAt: new Date(Date.now() + 60_000) } });
    const legacyHandoff = await db.authHandoffCode.create({ data: { codeHash: generateId(), kind: 'login', userId: source.id, expiresAt: new Date(Date.now() + 60_000) } });
    const lineageCode = await db.authCode.create({ data: {
      codeHash: generateId(), clientId: 'lineage-merge', userId: source.id, redirectUri: 'http://localhost/cb', codeChallenge: 'x',
      resource: ['r'], oauthScopes: ['mcp'], expiresAt: new Date(Date.now() + 60_000), createdBy: source.id, signInId: si.id } });

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    const ended = await db.signIn.findUniqueOrThrow({ where: { id: si.id } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endReason).toBe('user-merged');
    expect(ended.userId).toBe(source.id);

    const lk = await db.userApiKey.findUniqueOrThrow({ where: { id: lineageKey.userApiKey.id } });
    expect(lk.userId).toBe(source.id);
    expect(lk.revokedAt).not.toBeNull();
    expect((await db.userApiKey.findUniqueOrThrow({ where: { id: legacyKey.userApiKey.id } })).userId).toBe(target.id);

    expect(await db.authHandoffCode.findUnique({ where: { id: lineageHandoff.id } })).toBeNull();
    expect((await db.authHandoffCode.findUniqueOrThrow({ where: { id: legacyHandoff.id } })).userId).toBe(target.id);
    expect(await db.authCode.findUnique({ where: { id: lineageCode.id } })).toBeNull();
  });
});
