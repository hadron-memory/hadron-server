/**
 * #4161 (hardening follow-up to #4154 / #4159): the four items, red first.
 *  1. `ParsedSecretUrn` is a discriminated union on `kind`.
 *  2. The App slug gets the lenient read-side atom check (`validateAtomShape`, C1), before any database read.
 *  3. An alias naming two live Apps logs exactly one warn line, then answers the uniform not-found.
 *  4. Org-owned App, org READER: not-found on read, update and delete; a seeded event makes the secretEvents pin differential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as urn from '../urn.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { parseSecretUrn, resolveSecretRef, type ParsedSecretUrn } from './secretRef.js';
import { SecretNotFoundError } from './errors.js';

// Passthrough wrapper so one test can make the library's atom check fault; every other test sees the real function.
vi.mock('../urn.js', async (orig) => {
  const actual = await orig<typeof import('../urn.js')>();
  return { ...actual, validateAtomShape: vi.fn(actual.validateAtomShape) };
});

const ROOT = 's4161.test';
let ownerId: string;
let orgId: string;
let appId: string;
let appSecretId: string;
const context = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const mkApp = (slug: string, extra: Record<string, unknown> = {}) =>
  db.app.create({ data: { name: `app ${slug}`, ownerUserId: ownerId, urn: `${ROOT}:${slug}`, ...extra } });
const mkAppSecret = (app: string, name: string) =>
  db.secret.create({ data: { ownerType: 'app', ownerId: app, name, kind: 'generic', metadata: {}, valueEncrypted: null } });
const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code);

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s4161.test`, handle: 'handle-s4161' } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 's4161', urn: ROOT } })).id;
  appId = (await mkApp('ops')).id;
  appSecretId = (await mkAppSecret(appId, 'key')).id;
});
const savedKey = process.env.HADRON_ENCRYPTION_KEY;
afterEach(() => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.HADRON_ENCRYPTION_KEY; else process.env.HADRON_ENCRYPTION_KEY = savedKey;
});

describe('item 1: ParsedSecretUrn is a discriminated union', () => {
  it('each arm carries its own kind and none of the other arm\'s fields', () => {
    expect(parseSecretUrn(`hrn:secret:${ROOT}:app:ops:key`)).toEqual({ kind: 'app', root: ROOT, appSlug: 'ops', name: 'key' });
    expect(parseSecretUrn(`hrn:secret:${ROOT}:key`)).toEqual({ kind: 'principal', root: ROOT, name: 'key' });
    expect(parseSecretUrn('hrn:secret:@holger:key')).toEqual({ kind: 'principal', rootType: 'user', root: 'holger', name: 'key' });
  });

  it('cannot be half-set (type level: tsc fails if these stop being errors)', () => {
    // @ts-expect-error a principal-arm value cannot carry an appSlug
    const a: ParsedSecretUrn = { kind: 'principal', root: 'r', name: 'n', appSlug: 's' };
    // @ts-expect-error an app-arm value must carry its appSlug
    const b: ParsedSecretUrn = { kind: 'app', root: 'r', name: 'n' };
    // @ts-expect-error an app-arm value cannot carry a rootType
    const c: ParsedSecretUrn = { kind: 'app', root: 'r', name: 'n', appSlug: 's', rootType: 'user' };
    void [a, b, c]; // compile-time only: `tsc --noEmit` (CI) fails if any @ts-expect-error above stops being an error
  });
});

describe('item 2: the App slug is atom-checked at parse (C1: lenient, never strict)', () => {
  it('only the library\'s validation refusal is masked: any other error from the atom check propagates', () => {
    vi.mocked(urn.validateAtomShape).mockImplementationOnce(() => { throw new TypeError('library fault'); });
    expect(() => parseSecretUrn(`hrn:secret:${ROOT}:app:ops:key`)).toThrow(TypeError);
    // and the real refusal is still the masked one
    expect(() => parseSecretUrn(`hrn:secret:${ROOT}:app:-lead:key`)).toThrow(SecretNotFoundError);
  });

  it('a slug that fails atom shape is refused at parse with SecretNotFoundError, before any database read', async () => {
    const spy = vi.spyOn(db.app, 'findMany');
    const spyFirst = vi.spyOn(db.app, 'findFirst');
    for (const slug of ['-lead', 'trail.', 'a'.repeat(65), '.dot', 'bad$char', 'a b']) {
      const ref = `hrn:secret:${ROOT}:app:${slug}:key`;
      expect(() => parseSecretUrn(ref), ref).toThrow(SecretNotFoundError);
      await expect(resolveSecretRef(db, ref), ref).rejects.toThrow(SecretNotFoundError);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(spyFirst).not.toHaveBeenCalled();
  });

  it('answers byte-identically to a missing App (same class, same message shape)', async () => {
    const bad = await resolveSecretRef(db, `hrn:secret:${ROOT}:app:-lead:key`).then(() => null, (e: Error) => e);
    const missing = await resolveSecretRef(db, `hrn:secret:${ROOT}:app:no-such:key`).then(() => null, (e: Error) => e);
    expect(bad).toBeInstanceOf(SecretNotFoundError);
    expect(missing).toBeInstanceOf(SecretNotFoundError);
    expect((bad as Error).message.replace(/hrn:secret:\S+/, 'REF')).toBe((missing as Error).message.replace(/hrn:secret:\S+/, 'REF'));
  });

  it('control (C1): an uppercase slug and a renamed-alias slug still resolve', async () => {
    const up = await mkApp('Legacy-Up');
    const upSecret = await mkAppSecret(up.id, 'key');
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:Legacy-Up:key`)).toEqual({ id: upSecret.id });
    await db.urnAlias.create({ data: { id: generateId(), urn: `${ROOT}:old_name.v2`, entityType: 'APP', entityId: appId, reason: 'RENAME' } });
    expect(await resolveSecretRef(db, `hrn:secret:${ROOT}:app:old_name.v2:key`)).toEqual({ id: appSecretId });
  });

  it('a secret name outside SECRET_NAME_RE is not addressable by App URN', () => {
    for (const name of ['Key', '-key', 'a_b', 'k'.repeat(65)]) {
      expect(() => parseSecretUrn(`hrn:secret:${ROOT}:app:ops:${name}`), name).toThrow(SecretNotFoundError);
    }
  });
});

describe('item 3: an ambiguous alias is logged once, then masked', () => {
  const mkAmbiguous = async () => {
    for (const s of ['amb-a', 'amb-b']) {
      const a = await mkApp(s);
      await db.urnAlias.create({ data: { id: generateId(), urn: `${ROOT}:amb`, entityType: 'APP', entityId: a.id, reason: 'RENAME' } });
      await mkAppSecret(a.id, 'key');
    }
  };

  it('emits exactly one warn line, then SecretNotFoundError; the line never carries the secret name', async () => {
    await mkAmbiguous();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveSecretRef(db, `hrn:secret:${ROOT}:app:amb:topsecret-name`)).rejects.toThrow(SecretNotFoundError);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('secret_urn_ambiguous_app_alias');
    expect(line).toContain(`${ROOT}:app:amb`);
    expect(line).not.toContain('topsecret-name');
  });

  it('emits none for a missing App, a missing secret, a malformed slug, or a plain hit', async () => {
    await mkAmbiguous();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const ref of [`hrn:secret:${ROOT}:app:no-such:key`, `hrn:secret:${ROOT}:app:ops:missing`, `hrn:secret:${ROOT}:app:-bad:key`]) {
      await expect(resolveSecretRef(db, ref), ref).rejects.toThrow(SecretNotFoundError);
    }
    await resolveSecretRef(db, `hrn:secret:${ROOT}:app:ops:key`);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('item 4: org-owned App, org READER; secretEvents positive control', () => {
  it('an org READER of the owning org gets NOT_FOUND on read, update and delete', async () => {
    const orgApp = await db.app.create({ data: { name: 'org app', ownerUserId: null, organizationId: orgId, urn: `${ROOT}:orgapp` } });
    const sec = await mkAppSecret(orgApp.id, 'key');
    const reader = (await db.user.create({ data: { email: `${generateId()}@s4161.test` } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: reader, role: 'READER' } });
    const ref = `hrn:secret:${ROOT}:app:orgapp:key`;
    expect(await resolveSecretRef(db, ref)).toEqual({ id: sec.id });
    expect(await resolvers.Query.secret({}, { ref }, context(reader))).toBeNull();
    expect(await codeOf(resolvers.Mutation.updateSecret({}, { ref, metadata: { n: 1 } } as never, context(reader)))).toBe('NOT_FOUND');
    expect(await codeOf(resolvers.Mutation.deleteSecret({}, { ref }, context(reader)))).toBe('NOT_FOUND');
    expect(await db.secret.count({ where: { id: sec.id } })).toBe(1);
  });

  it('secretEvents: the App member sees a seeded event; an org-only ADMIN gets the empty page', async () => {
    const member = (await db.user.create({ data: { email: `${generateId()}@s4161.test` } })).id;
    await db.appMember.create({ data: { appId, userId: member, role: 'reader' } });
    const orgOnly = (await db.user.create({ data: { email: `${generateId()}@s4161.test` } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: orgOnly, role: 'ADMIN' } });
    await db.secretEvent.create({ data: { ownerType: 'app', ownerId: appId, secretId: appSecretId, secretName: 'key', kind: 'read', outcome: 'ok' } });
    const ref = `hrn:secret:${ROOT}:app:ops:key`;
    const asMember: any = await resolvers.Query.secretEvents({}, { ref }, context(member));
    expect(asMember.total).toBe(1);
    expect(asMember.items).toHaveLength(1);
    expect(await resolvers.Query.secretEvents({}, { ref }, context(orgOnly))).toEqual({ items: [], total: 0 });
  });
});
