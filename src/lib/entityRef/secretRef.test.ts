/**
 * resolveSecretRef / parseSecretUrn (#683, narrowed to org/user by #696) — the
 * secret URN is owner-scoped and computed (no `urn` column), so resolution
 * decomposes the URN into its root principal + name and looks the secret up by
 * the (ownerType, ownerId, name) unique. Owners are ORG/USER only; the
 * superseded app-/memory-owned marker shape is rejected.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { encryptToken } from '../tokenCrypto.js';
import { parseSecretUrn, resolveSecretRef } from './secretRef.js';
import { SecretNotFoundError } from './errors.js';

describe('parseSecretUrn', () => {
  it('decomposes the org/user root shapes (v2 flat + legacy spellings)', () => {
    // Bare org root — both the v2 single-colon and legacy `::` forms.
    expect(parseSecretUrn('hrn:secret:acme.com:k')).toEqual({ root: 'acme.com', name: 'k' });
    expect(parseSecretUrn('hrn:secret:acme.com::k')).toEqual({ root: 'acme.com', name: 'k' });
    // Bare user root (v2, resolved by pool lookup — no pinned rootType).
    expect(parseSecretUrn('hrn:secret:holger:k')).toEqual({ root: 'holger', name: 'k' });
    // Legacy `@`/`user:` sigils pin the user.
    expect(parseSecretUrn('hrn:secret:@holger::k')).toEqual({ rootType: 'user', root: 'holger', name: 'k' });
    expect(parseSecretUrn('hrn:secret:user:holger::k')).toEqual({ rootType: 'user', root: 'holger', name: 'k' });
    // Legacy urn: prefix + bare form both accepted.
    expect(parseSecretUrn('urn:secret:acme.com::k')).toEqual({ root: 'acme.com', name: 'k' });
    expect(parseSecretUrn('acme.com::k')).toEqual({ root: 'acme.com', name: 'k' });
  });

  it('rejects a structurally invalid or superseded (app/memory) secret URN', () => {
    expect(() => parseSecretUrn('hrn:secret:acme.com')).toThrow(SecretNotFoundError); // 1 segment
    expect(() => parseSecretUrn('hrn:secret:acme.com::app:ops::k')).toThrow(SecretNotFoundError); // app-owned superseded
    expect(() => parseSecretUrn('hrn:secret:acme.com::memory:kb::k')).toThrow(SecretNotFoundError); // memory-owned superseded
    expect(() => parseSecretUrn('hrn:secret:a::b::c::d')).toThrow(SecretNotFoundError); // too many segments
  });
});

describe('resolveSecretRef', () => {
  let org: { id: string; urn: string };
  let user: { id: string };
  const secretIds: Record<string, string> = {};

  beforeEach(async () => {
    process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
    await cleanDb(db);
    org = await db.organization.create({ data: { id: generateId(), name: 'secretref', urn: 'secretref.test' } });
    user = await db.user.create({ data: { id: generateId(), email: 'u@secretref.test', name: 'U', handle: 'holgerx' } });
    const enc = () => encryptToken(JSON.stringify('v'));
    for (const [key, owner] of [
      ['org', { ownerType: 'org', ownerId: org.id }],
      ['user', { ownerType: 'user', ownerId: user.id }],
    ] as const) {
      const row = await db.secret.create({
        data: { ...owner, name: 'k', kind: 'generic', metadata: {}, valueEncrypted: enc() },
      });
      secretIds[key] = row.id;
    }
  });

  it('resolves by cuid id', async () => {
    expect(await resolveSecretRef(db, secretIds.org)).toEqual({ id: secretIds.org });
  });

  it('resolves org + user roots by URN (v2 flat + legacy spellings)', async () => {
    // Bare org root (v2 single-colon and legacy `::`).
    expect(await resolveSecretRef(db, 'hrn:secret:secretref.test:k')).toEqual({ id: secretIds.org });
    expect(await resolveSecretRef(db, 'hrn:secret:secretref.test::k')).toEqual({ id: secretIds.org });
    // Bare user root resolves via the pool (org lookup misses, user hits).
    expect(await resolveSecretRef(db, 'hrn:secret:holgerx:k')).toEqual({ id: secretIds.user });
    // Legacy sigils pin the user.
    expect(await resolveSecretRef(db, 'hrn:secret:@holgerx::k')).toEqual({ id: secretIds.user });
    expect(await resolveSecretRef(db, 'hrn:secret:user:holgerx::k')).toEqual({ id: secretIds.user });
    // Legacy urn: prefix resolves identically.
    expect(await resolveSecretRef(db, 'urn:secret:secretref.test::k')).toEqual({ id: secretIds.org });
  });

  it('rejects a bare root that names BOTH an org and a user (ambiguous — no cross-tenant guess)', async () => {
    // A handle↔org collision on the same bare root: until #692 enforces the
    // unified pool, the URN doesn't name a single owner, so it must be rejected
    // rather than resolving to an arbitrary owner's secret.
    const enc = () => encryptToken(JSON.stringify('v'));
    await db.organization.create({ data: { id: generateId(), name: 'collide', urn: 'collideroot' } });
    const clashUser = await db.user.create({
      data: { id: generateId(), email: 'clash@secretref.test', name: 'Clash', handle: 'collideroot' },
    });
    await db.secret.create({
      data: { ownerType: 'user', ownerId: clashUser.id, name: 'k', kind: 'generic', metadata: {}, valueEncrypted: enc() },
    });
    await expect(resolveSecretRef(db, 'hrn:secret:collideroot:k')).rejects.toThrow(SecretNotFoundError);
    // A `@`-pinned user root disambiguates and still resolves.
    expect(await resolveSecretRef(db, 'hrn:secret:@collideroot:k')).toEqual({
      id: (await db.secret.findFirstOrThrow({ where: { ownerId: clashUser.id, name: 'k' } })).id,
    });
  });

  it('throws for absent, malformed, superseded, and unknown-owner refs', async () => {
    await expect(resolveSecretRef(db, 'hrn:secret:secretref.test::nope')).rejects.toThrow(SecretNotFoundError);
    await expect(resolveSecretRef(db, 'hrn:secret:no-such-root.test::k')).rejects.toThrow(SecretNotFoundError);
    // The superseded app-owned shape is rejected (masked as not-found).
    await expect(resolveSecretRef(db, 'hrn:secret:secretref.test::app:ops::k')).rejects.toThrow(SecretNotFoundError);
    await expect(resolveSecretRef(db, `c${'0'.repeat(24)}`)).rejects.toThrow(SecretNotFoundError);
    // Under-qualified (1 segment) is rejected at the qualification gate.
    await expect(resolveSecretRef(db, 'hrn:secret:secretref.test')).rejects.toThrow();
  });
});
