/**
 * #4154 (S2c): `resolveSecretRef` resolves the App-shape secret URN
 * `hrn:secret:<root>:app:<app-slug>:<name>` (cor:urn:010:01) with the uniform not-found mask
 * (cor:sec:020:02). The five FIT conditions (Victor, #4154) are pinned below.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { encryptToken } from '../tokenCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { parseSecretUrn, resolveSecretRef } from './secretRef.js';
import { AppNotFoundError, SecretNotFoundError } from './errors.js';

const ROOT = 's2c.test';
let ownerId: string;
let memberId: string;
let outsiderId: string;
let appId: string;
let appSecretId: string;
let orgSecretId: string;
let userSecretId: string;
const context = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);

const mkApp = (slug: string, extra: Record<string, unknown> = {}) =>
  db.app.create({ data: { name: `app ${slug}`, ownerUserId: ownerId, urn: `${ROOT}:${slug}`, ...extra } });
const mkAppSecret = (app: string, name: string) =>
  db.secret.create({ data: { ownerType: 'app', ownerId: app, name, kind: 'generic', metadata: {}, valueEncrypted: null } });

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s2c.test`, handle: 'handle-s2c' } })).id;
  memberId = (await db.user.create({ data: { email: `${generateId()}@s2c.test` } })).id;
  outsiderId = (await db.user.create({ data: { email: `${generateId()}@s2c.test` } })).id;
  const org = await db.organization.create({ data: { id: generateId(), name: 's2c', urn: ROOT } });
  appId = (await mkApp('ops')).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'reader' } });
  appSecretId = (await mkAppSecret(appId, 'key')).id;
  const enc = encryptToken(JSON.stringify('v'));
  orgSecretId = (await db.secret.create({ data: { ownerType: 'org', ownerId: org.id, name: 'key', kind: 'generic', metadata: {}, valueEncrypted: enc } })).id;
  userSecretId = (await db.secret.create({ data: { ownerType: 'user', ownerId: ownerId, name: 'key', kind: 'generic', metadata: {}, valueEncrypted: enc } })).id;
});

describe('App-shape secret URN (#4154)', () => {
  it('resolves hrn:secret:<root>:app:<slug>:<name> to the App secret, also under the legacy urn: prefix', async () => {
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:ops:key`)).toEqual({ id: appSecretId });
    expect(await resolveSecretRef(db, `urn:secret:${ROOT}:app:ops:key`)).toEqual({ id: appSecretId });
  });

  it('differential: an App URN and an org/user URN with the same name never resolve to each other (cor:urn:010:02)', async () => {
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:key`)).toEqual({ id: orgSecretId });
    expect(await resolveSecretRef(db, 'hrn:secret:handle-s2c:key')).toEqual({ id: userSecretId });
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:ops:key`)).toEqual({ id: appSecretId });
    // An App with no secret of that name does not fall through to the org or user secret of that name.
    await mkApp('empty');
    await expect(resolveSecretRef(db, `hrn:secret:${ROOT}:app:empty:key`)).rejects.toThrow(SecretNotFoundError);
    // An org/user URN never reaches an App secret.
    await mkAppSecret(appId, 'only-app');
    await expect(resolveSecretRef(db, `hrn:secret:${ROOT}:only-app`)).rejects.toThrow(SecretNotFoundError);
  });

  it('condition 1: a renamed App slug still resolves, through the stored alias map', async () => {
    await db.urnAlias.create({ data: { id: generateId(), urn: `${ROOT}:ops`, entityType: 'APP', entityId: appId, reason: 'RENAME' } });
    await db.app.update({ where: { id: appId }, data: { urn: `${ROOT}:operations` } });
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:operations:key`)).toEqual({ id: appSecretId });
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:ops:key`)).toEqual({ id: appSecretId });
    // A live slug beats an alias: a new App now living at the old slug owns it.
    const taker = await mkApp('ops');
    const takerSecret = await mkAppSecret(taker.id, 'key');
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:ops:key`)).toEqual({ id: takerSecret.id });
  });

  it('condition 2: the legacy :: App/memory spelling and the bare three-segment form are refused as not-found', async () => {
    for (const ref of [
      `hrn:secret:${ROOT}::app:ops::key`,
      `hrn:secret:${ROOT}::memory:ops::key`,
      `urn:secret:${ROOT}::app:ops::key`,
      `hrn:secret:${ROOT}:ops:key`, // three segments, no literal `app`
      `hrn:secret:${ROOT}:app:ops::key`, // mixed separators
      `hrn:secret:${ROOT}::app:ops:key`,
    ]) {
      await expect(resolveSecretRef(db, ref), ref).rejects.toThrow(SecretNotFoundError);
    }
  });

  it('condition 3: unknown, uninstalled, deleted, ambiguous-alias App and a missing secret all answer the same SecretNotFoundError', async () => {
    const uninstalled = await mkApp('gone', { uninstalledAt: new Date() });
    await mkAppSecret(uninstalled.id, 'key');
    const deleted = await mkApp('deleted', { deletedAt: new Date() });
    await mkAppSecret(deleted.id, 'key');
    // Two live Apps behind one aliased slug: ambiguity must not escape as AmbiguousLegacyUrnError.
    const a = await mkApp('amb-a');
    const b = await mkApp('amb-b');
    for (const id of [a.id, b.id]) {
      await db.urnAlias.create({ data: { id: generateId(), urn: `${ROOT}:amb`, entityType: 'APP', entityId: id, reason: 'RENAME' } });
      await mkAppSecret(id, 'key');
    }
    const refs = [
      `hrn:secret:${ROOT}:app:no-such-app:key`,
      `hrn:secret:no-such-root.test:app:ops:key`,
      `hrn:secret:${ROOT}:app:gone:key`,
      `hrn:secret:${ROOT}:app:deleted:key`,
      `hrn:secret:${ROOT}:app:amb:key`,
      `hrn:secret:${ROOT}:app:ops:missing`,
    ];
    for (const ref of refs) {
      const err = await resolveSecretRef(db, ref).then(() => null, (e: unknown) => e);
      expect(err, ref).toBeInstanceOf(SecretNotFoundError);
      expect(err, ref).not.toBeInstanceOf(AppNotFoundError);
    }
  });

  it('condition 4: parity with the URN libraries — the same accept/refuse set for the secret shapes (cor:urn:010:01)', () => {
    // Accepted: org/user `<root>:<name>` and App `<root>:app:<slug>:<name>`.
    expect(parseSecretUrn(`hrn:secret:${ROOT}:app:ops:key`)).toEqual({ root: ROOT, appSlug: 'ops', name: 'key' });
    expect(parseSecretUrn('hrn:secret:acme.com:app:eng-team:openai-key')).toEqual({ root: 'acme.com', appSlug: 'eng-team', name: 'openai-key' });
    expect(parseSecretUrn('hrn:secret:acme.com:stripe-key')).toEqual({ root: 'acme.com', name: 'stripe-key' });
    // Refused: wrong shape, empty atoms, a leaf that is not a name atom, a root that is not a bare principal.
    for (const ref of [
      'hrn:secret:acme.com:app:eng-team', // no name
      'hrn:secret:acme.com:app::key', // empty slug
      'hrn:secret:acme.com:app:eng-team:', // empty name
      'hrn:secret:acme.com:apps:eng-team:key', // not the literal `app`
      'hrn:secret:acme.com:App:eng-team:key', // the literal is lowercase
      'hrn:secret:acme.com:app:eng-team:Key', // leaf is [a-z0-9][a-z0-9-]{0,63}
      'hrn:secret:acme.com:app:eng-team:-key',
      `hrn:secret:acme.com:app:eng-team:${'a'.repeat(65)}`,
      'hrn:secret:acme.com:app:eng-team:key:extra', // five atoms
      'hrn:secret:@holger:app:eng-team:key', // an App root is a bare principal, never a sigil
      'hrn:secret:user:holger:app:eng-team:key',
      'hrn:secret:acme.com:app:eng team:key', // whitespace inside an atom
      'hrn:secret:acme.com::app:eng-team::key', // legacy spelling
    ]) {
      expect(() => parseSecretUrn(ref), ref).toThrow(SecretNotFoundError);
    }
    expect(parseSecretUrn(`hrn:secret:${ROOT}:app:ops:${'a'.repeat(64)}`).name).toHaveLength(64);
  });

  it('condition 5: resolveSecretRef is ungated, and each surface gates after it (member sees; outsider gets the missing answer)', async () => {
    // Ungated: no caller needed to resolve.
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:ops:key`)).toEqual({ id: appSecretId });
    const asMember: any = await resolvers.Query.secret({}, { ref: `hrn:secret:${ROOT}:app:ops:key` }, context(memberId));
    expect(asMember?.id).toBe(appSecretId);
    const viaId: any = await resolvers.Query.secret({}, { ref: appSecretId }, context(memberId));
    expect(viaId?.id).toBe(appSecretId);
    for (const ref of [`hrn:secret:${ROOT}:app:ops:key`, `hrn:secret:${ROOT}:app:ops:missing`, `hrn:secret:${ROOT}:app:no-such-app:key`]) {
      expect(await resolvers.Query.secret({}, { ref }, context(outsiderId)), ref).toBeNull();
    }
    // Not an existence oracle on the mutation side either.
    const code = await resolvers.Mutation.deleteSecret({}, { ref: `hrn:secret:${ROOT}:app:ops:key` }, context(outsiderId)).then(
      () => 'DELETED', (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code);
    const missing = await resolvers.Mutation.deleteSecret({}, { ref: `hrn:secret:${ROOT}:app:ops:missing` }, context(outsiderId)).then(
      () => 'DELETED', (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code);
    expect(code).toBe(missing);
    expect(await db.secret.count({ where: { id: appSecretId } })).toBe(1);
  });

  it('no run path reaches the resolver: no runner tool imports resolveSecretRef or parseSecretUrn', () => {
    const dir = new URL('../runner/', import.meta.url);
    const walk = (u: URL): string[] => readdirSync(u, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [new URL(e.name, u).pathname] : []);
    const offenders = walk(dir).filter((f) => /resolveSecretRef|parseSecretUrn/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
