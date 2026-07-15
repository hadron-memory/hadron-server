/**
 * resolveSecretRef / parseSecretUrn (#683) — the secret URN is owner-scoped
 * and computed (no `urn` column), so resolution decomposes the URN into its
 * polymorphic owner + name and looks the secret up by the (ownerType,
 * ownerId, name) unique.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { encryptToken } from '../tokenCrypto.js';
import { parseSecretUrn, resolveSecretRef } from './secretRef.js';
import { SecretNotFoundError } from './errors.js';

describe('parseSecretUrn', () => {
  it('decomposes every owner shape (and the user:/@ equivalence)', () => {
    expect(parseSecretUrn('hrn:secret:acme.com::k')).toEqual({ ownerType: 'org', ownerRef: 'acme.com', name: 'k' });
    expect(parseSecretUrn('hrn:secret:@holger::k')).toEqual({ ownerType: 'user', ownerRef: 'hrn:user:holger', name: 'k' });
    expect(parseSecretUrn('hrn:secret:user:holger::k')).toEqual({ ownerType: 'user', ownerRef: 'hrn:user:holger', name: 'k' });
    expect(parseSecretUrn('hrn:secret:acme.com::app:ops::k')).toEqual({ ownerType: 'app', ownerRef: 'hrn:app:acme.com::ops', name: 'k' });
    expect(parseSecretUrn('hrn:secret:@holger::app:gm::k')).toEqual({ ownerType: 'app', ownerRef: 'hrn:app:@holger::gm', name: 'k' });
    expect(parseSecretUrn('hrn:secret:acme.com::memory:kb::k')).toEqual({ ownerType: 'memory', ownerRef: 'hrn:memory:acme.com::kb', name: 'k' });
    // Legacy urn: prefix + bare form both accepted.
    expect(parseSecretUrn('urn:secret:acme.com::k')).toMatchObject({ ownerType: 'org', name: 'k' });
    expect(parseSecretUrn('acme.com::k')).toMatchObject({ ownerType: 'org', name: 'k' });
  });

  it('rejects a structurally invalid secret URN', () => {
    expect(() => parseSecretUrn('hrn:secret:acme.com')).toThrow(SecretNotFoundError); // 1 segment
    expect(() => parseSecretUrn('hrn:secret:acme.com::agent:x::k')).toThrow(SecretNotFoundError); // marker not app/memory
    expect(() => parseSecretUrn('hrn:secret:a::b::c::d')).toThrow(SecretNotFoundError); // too many segments
    expect(() => parseSecretUrn('hrn:secret:acme.com::app:x:y::k')).toThrow(SecretNotFoundError); // marker has 3 atoms
  });
});

describe('resolveSecretRef', () => {
  let org: { id: string; urn: string };
  let user: { id: string };
  let app: { id: string };
  let memory: { id: string };
  const secretIds: Record<string, string> = {};

  beforeEach(async () => {
    process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
    await cleanDb(db);
    org = await db.organization.create({ data: { id: generateId(), name: 'secretref', urn: 'secretref.test' } });
    user = await db.user.create({ data: { id: generateId(), email: 'u@secretref.test', name: 'U', handle: 'holgerx' } });
    // Real app/memory URNs compose as `<org-domain>:<slug>` (single-colon bare form).
    app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:ops`, name: 'Ops' } });
    memory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:kb`, name: 'kb', class: 'knowledge' },
    });
    const enc = () => encryptToken(JSON.stringify('v'));
    for (const [key, owner] of [
      ['org', { ownerType: 'org', ownerId: org.id }],
      ['user', { ownerType: 'user', ownerId: user.id }],
      ['app', { ownerType: 'app', ownerId: app.id }],
      ['memory', { ownerType: 'memory', ownerId: memory.id }],
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

  it('resolves each owner scope by URN', async () => {
    expect(await resolveSecretRef(db, 'hrn:secret:secretref.test::k')).toEqual({ id: secretIds.org });
    expect(await resolveSecretRef(db, 'hrn:secret:@holgerx::k')).toEqual({ id: secretIds.user });
    expect(await resolveSecretRef(db, 'hrn:secret:user:holgerx::k')).toEqual({ id: secretIds.user });
    expect(await resolveSecretRef(db, 'hrn:secret:secretref.test::app:ops::k')).toEqual({ id: secretIds.app });
    expect(await resolveSecretRef(db, 'hrn:secret:secretref.test::memory:kb::k')).toEqual({ id: secretIds.memory });
    // Legacy urn: prefix resolves identically.
    expect(await resolveSecretRef(db, 'urn:secret:secretref.test::app:ops::k')).toEqual({ id: secretIds.app });
  });

  it('throws for absent, malformed, under-qualified, and unknown-owner refs', async () => {
    await expect(resolveSecretRef(db, 'hrn:secret:secretref.test::nope')).rejects.toThrow(SecretNotFoundError);
    await expect(resolveSecretRef(db, 'hrn:secret:no-such-org.test::k')).rejects.toThrow(SecretNotFoundError);
    await expect(resolveSecretRef(db, `c${'0'.repeat(24)}`)).rejects.toThrow(SecretNotFoundError);
    // Under-qualified (1 segment) is rejected at the qualification gate.
    await expect(resolveSecretRef(db, 'hrn:secret:secretref.test')).rejects.toThrow();
  });
});
