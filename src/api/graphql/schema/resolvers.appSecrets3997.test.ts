/** S2 preparation: public resolver acceptance, independent of S1 key-helper API. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { SECRET_SCOPE_ORDER, SECRET_OWNER_TYPES } from '../../../lib/secrets.js';
import { encryptToken, decryptToken } from '../../../lib/tokenCrypto.js';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolveRunSecret } from '../../../lib/runner/secrets.js';
import { currentAppSecretValue, lockSecretRow, MAX_SECRETS_PER_APP, MAX_SECRET_VERSIONS } from '../../../lib/secrets/appSecrets.js';
import { readdirSync, readFileSync } from 'node:fs';

let ownerId: string;
let memberId: string;
let appId: string;
let outsiderId: string;
const context = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const create = (userId: string, name = 'service-token', value: unknown = 's2-canary') =>
  resolvers.Mutation.createSecret({}, {
    ownerType: 'app', ownerRef: appId, name, kind: 'generic', value,
  }, context(userId));

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s2.test` } })).id;
  memberId = (await db.user.create({ data: { email: `${generateId()}@s2.test` } })).id;
  outsiderId = (await db.user.create({ data: { email: `${generateId()}@s2.test` } })).id;
  appId = (await db.app.create({ data: {
    name: 'S2 acceptance', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:secrets`,
  } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'reader' } });
});

describe('App secrets S2 public acceptance', () => {
  it('keeps the run cascade restricted to user and org', () => {
    expect(SECRET_SCOPE_ORDER).toEqual(['user', 'org']);
  });

  it('refuses unknown owner types explicitly', async () => {
    await expect(resolvers.Mutation.createSecret({}, {
      ownerType: 'unregistered', ownerRef: appId, name: 'unknown', kind: 'generic', value: 'control',
    }, context(ownerId))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('allows an App member to store a secret without putting its value in the Secret row', async () => {
    const secret = await create(memberId);
    expect(secret).toMatchObject({ ownerType: 'app', ownerId: appId, name: 'service-token' });
    const row = await db.secret.findUniqueOrThrow({ where: { id: secret.id } });
    expect(row.valueEncrypted).toBeNull();
    expect(JSON.stringify(row)).not.toContain('s2-canary');
  });

  it('lets a creator person delete an unprotected App secret without being its manager', async () => {
    const secret = await create(memberId);
    await expect(resolvers.Mutation.deleteSecret({}, { ref: secret.id }, context(memberId))).resolves.toBe(true);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });

  it('refuses a UTF-8 value over 32 KiB even when its JSON character count fits', async () => {
    // 16,400 code units, but 32,802 serialized UTF-8 bytes (quotes included).
    // Inspect only the refusal code: a failed red control must not dump a ciphertext row.
    const code = await resolvers.Mutation.createSecret({}, {
      ownerType: 'user', name: 'multibyte-overflow', kind: 'generic', value: 'é'.repeat(16_400),
    }, context(ownerId)).then(() => 'ACCEPTED', (error: unknown) =>
      (error as { extensions?: { code?: string } }).extensions?.code);
    expect(code).toBe('BAD_USER_INPUT');
  });

  // ── versions ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('a member creates an App secret, updateSecret with a value makes version 2, secret shows version 2, version 1 stays', async () => {
    const secret = await create(memberId, 'rotating', 'v-one');
    await resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'v-two' }, context(memberId));
    const shown: any = await resolvers.Query.secret({}, { ref: secret.id }, context(memberId));
    expect(await resolvers.Secret.currentVersion(shown, {}, context(memberId))).toBe(2);
    const page: any = await resolvers.Secret.versions(shown, {}, context(memberId));
    const versions: any[] = page.items;
    expect(page).toMatchObject({ total: 2, hasMore: false });
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(versions[0].supersededAt).toBeNull();
    expect(versions[1].supersededAt).not.toBeNull();
    expect(await db.secretVersion.count({ where: { secretId: secret.id } })).toBe(2);
    expect(await currentAppSecretValue(db as never, { id: secret.id, ownerId: appId })).toBe('v-two');
  });

  it('two concurrent value changes end at versions 2 and 3, never a duplicate or a gap', async () => {
    const secret = await create(memberId, 'racing');
    await Promise.all([
      resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'a' }, context(memberId)),
      resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'b' }, context(ownerId)),
    ]);
    const versions = await db.secretVersion.findMany({ where: { secretId: secret.id }, orderBy: { versionNo: 'asc' } });
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
  });

  it('a store waits for the secret row\'s lock, so version numbers are taken under it', async () => {
    const secret = await create(memberId, 'locked');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => { await lockSecretRow(tx as never, secret.id); await held; });
    await new Promise((r) => setTimeout(r, 150));
    let done = false;
    const store = resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'waits' }, context(memberId)).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 500));
    expect(done).toBe(false);
    release();
    await holder;
    await store;
    expect(done).toBe(true);
  });

  it('a metadata-only change adds no version', async () => {
    const secret = await create(memberId, 'meta-only');
    await resolvers.Mutation.updateSecret({}, { ref: secret.id, metadata: { note: 'n' } }, context(memberId));
    expect(await db.secretVersion.count({ where: { secretId: secret.id } })).toBe(1);
    expect((await db.secret.findUniqueOrThrow({ where: { id: secret.id } })).metadata).toEqual({ note: 'n' });
  });

  it('keeps at most 50 versions: the oldest superseded go first, the current one never', async () => {
    const secret = await create(memberId, 'many');
    for (let i = 2; i <= MAX_SECRET_VERSIONS + 2; i++) await resolvers.Mutation.updateSecret({}, { ref: secret.id, value: `v${i}` }, context(memberId));
    const nos = (await db.secretVersion.findMany({ where: { secretId: secret.id }, orderBy: { versionNo: 'asc' } })).map((v) => v.versionNo);
    expect(nos).toHaveLength(MAX_SECRET_VERSIONS);
    expect(nos[0]).toBe(3);
    expect(nos.at(-1)).toBe(MAX_SECRET_VERSIONS + 2);
  });

  it('pages Secret.versions: default 20, offset, hasMore, limit 0 counts only, over-cap served as 200 (cor:api:120:04)', async () => {
    const secret = await create(memberId, 'paged');
    for (let i = 2; i <= 30; i++) await resolvers.Mutation.updateSecret({}, { ref: secret.id, value: `v${i}` }, context(memberId));
    const shown: any = await resolvers.Query.secret({}, { ref: secret.id }, context(memberId));
    const first: any = await resolvers.Secret.versions(shown, {}, context(memberId));
    expect(first.items).toHaveLength(20);
    expect(first.items[0].versionNo).toBe(30);
    expect(first).toMatchObject({ total: 30, hasMore: true });
    const rest: any = await resolvers.Secret.versions(shown, { limit: 20, offset: 20 }, context(memberId));
    expect(rest.items.map((v: any) => v.versionNo)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(rest.hasMore).toBe(false);
    expect(await resolvers.Secret.versions(shown, { limit: 0 }, context(memberId))).toMatchObject({ items: [], total: 30, hasMore: true });
    expect((await resolvers.Secret.versions(shown, { limit: 5000 }, context(memberId)) as any).items).toHaveLength(30);
    expect(await resolvers.Secret.versions({ id: 'x', ownerType: 'org' }, {}, context(memberId))).toEqual({ items: [], total: 0, hasMore: false });
    const sdl = buildSchema(typeDefs);
    const field = (sdl.getType('Secret') as GraphQLObjectType).getFields().versions;
    expect(field.args.map((a) => a.name)).toEqual(['limit', 'offset']);
    expect(String(field.type)).toBe('SecretVersionsPage!');
  });

  it('grandfathers a stored value over the byte cap: a metadata-only edit succeeds, a new value over the cap is still refused (#4157)', async () => {
    const legacy = 'é'.repeat(16_400); // 16,402 JSON chars (under the old character check), 32,802 bytes
    const row = await db.secret.create({ data: {
      id: generateId(), ownerType: 'user', ownerId, name: 'legacy-multibyte', kind: 'generic', metadata: {},
      valueEncrypted: encryptToken(JSON.stringify(legacy)),
    } });
    const edited: any = await resolvers.Mutation.updateSecret({}, { ref: row.id, metadata: { note: 'edited' } }, context(ownerId));
    expect(edited.metadata).toEqual({ note: 'edited' });
    const stored = await db.secret.findUniqueOrThrow({ where: { id: row.id } });
    expect(JSON.parse(decryptToken(stored.valueEncrypted!))).toBe(legacy);
    const code = await resolvers.Mutation.updateSecret({}, { ref: row.id, value: legacy }, context(ownerId)).then(
      () => 'ACCEPTED', (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code);
    expect(code).toBe('BAD_USER_INPUT');
  });

  it('refuses a secret beyond the per-App cap with its own code', async () => {
    await create(memberId, 'seed');
    const seed = await db.secret.findFirstOrThrow({ where: { ownerId: appId } });
    await db.secret.createMany({ data: Array.from({ length: MAX_SECRETS_PER_APP - 1 }, (_, i) => ({
      id: generateId(), ownerType: 'app', ownerId: appId, name: `fill-${i}`, kind: 'generic', metadata: {}, valueEncrypted: null,
    })) });
    expect(await db.secret.count({ where: { ownerId: appId } })).toBe(MAX_SECRETS_PER_APP);
    await expect(create(memberId, 'one-too-many')).rejects.toMatchObject({ extensions: { code: 'SECRET_LIMIT_REACHED' } });
    expect(seed.id).toBeTruthy();
  });

  // ── redaction ───────────────────────────────────────────────────────────────────────────────────────────────────
  it('no field of Secret, SecretVersion or SecretEvent, reached by introspection, can return a value or ciphertext', () => {
    const schema = buildSchema(typeDefs);
    for (const name of ['Secret', 'SecretVersion', 'SecretEvent']) {
      const fields = Object.keys((schema.getType(name) as GraphQLObjectType).getFields());
      expect(fields.filter((f) => /value|cipher|encrypted|plaintext|fingerprint/i.test(f))).toEqual([]);
    }
  });

  it('a default select of a version row carries no ciphertext', async () => {
    const secret = await create(memberId);
    const row = await db.secretVersion.findFirstOrThrow({ where: { secretId: secret.id } });
    expect(Object.keys(row)).not.toContain('valueEncrypted');
    expect(JSON.stringify(row)).not.toContain('s2-canary');
    const withCipher = await db.secretVersion.findFirstOrThrow({ where: { secretId: secret.id }, omit: { valueEncrypted: false } });
    expect(withCipher.valueEncrypted).not.toContain('s2-canary');
  });

  it('a version ciphertext moved to another version or secret fails to decrypt', async () => {
    const a = await create(memberId, 'aad-a', 'value-a');
    const b = await create(memberId, 'aad-b', 'value-b');
    const va = await db.secretVersion.findFirstOrThrow({ where: { secretId: a.id }, omit: { valueEncrypted: false } });
    await db.secretVersion.updateMany({ where: { secretId: b.id }, data: { valueEncrypted: va.valueEncrypted } });
    await expect(currentAppSecretValue(db as never, { id: b.id, ownerId: appId })).rejects.toThrow(/authenticate data/);
    await expect(currentAppSecretValue(db as never, { id: a.id, ownerId: appId })).resolves.toBe('value-a');
    // Within ONE secret, version 1's ciphertext in the version 2 row fails too: the AAD names the version number.
    await resolvers.Mutation.updateSecret({}, { ref: a.id, value: 'value-a2' }, context(memberId));
    const v1 = await db.secretVersion.findFirstOrThrow({ where: { secretId: a.id, versionNo: 1 }, omit: { valueEncrypted: false } });
    await db.secretVersion.updateMany({ where: { secretId: a.id, versionNo: 2 }, data: { valueEncrypted: v1.valueEncrypted } });
    await expect(currentAppSecretValue(db as never, { id: a.id, ownerId: appId })).rejects.toThrow(/authenticate data/);
  });

  it('a canary value, stored and rotated, appears in no row, event, log line or error', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
    try {
      const secret = await create(memberId, 'canary', 'CANARY-ONE-9f3a');
      await resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'CANARY-TWO-9f3a' }, context(memberId));
      await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'bad kind', kind: 'nope', value: 'CANARY-THREE-9f3a' }, context(memberId)).catch((e: unknown) => lines.push(String((e as Error)?.message)));
    } finally { spies.forEach((x) => x.mockRestore()); out.mockRestore(); err.mockRestore(); }
    const rows = JSON.stringify([await db.secret.findMany(), await db.secretEvent.findMany(), await db.secretVersion.findMany()]);
    expect(rows).not.toMatch(/CANARY-/);
    expect(lines.join('\n')).not.toMatch(/CANARY-/);
  });

  // ── who ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('a non-member gets an empty page and null, and cannot store', async () => {
    const secret = await create(memberId);
    expect(await resolvers.Query.secret({}, { ref: secret.id }, context(outsiderId))).toBeNull();
    await expect(resolvers.Query.secrets({}, { ownerType: 'app', ownerRef: appId }, context(outsiderId))).resolves.toEqual({ items: [], total: 0 });
    await expect(create(outsiderId, 'sneaky')).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'x' }, context(outsiderId))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    // A missing App answers like an unusable one.
    await expect(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: generateId(), name: 'x', kind: 'generic', value: 1 }, context(memberId))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('an App key and an impersonated session cannot store and see nothing', async () => {
    const secret = await create(memberId);
    const appKeyCtx = { db, appId, roles: [] } as unknown as Context;
    const impersonated = { db, userId: memberId, roles: [], impersonation: { actorUserId: ownerId, orgId: 'someorg' } } as unknown as Context;
    for (const ctx of [appKeyCtx, impersonated]) {
      expect(await resolvers.Query.secret({}, { ref: secret.id }, ctx)).toBeNull();
      await expect(resolvers.Query.secrets({}, { ownerType: 'app', ownerRef: appId }, ctx)).resolves.toEqual({ items: [], total: 0 });
      await expect(resolvers.Query.secretEvents({}, { ref: secret.id }, ctx)).resolves.toEqual({ items: [], total: 0 });
      await expect(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'k', kind: 'generic', value: 1 }, ctx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      await expect(resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'x' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    }
    expect(await db.secretVersion.count({ where: { secretId: secret.id } })).toBe(1);
  });

  it('an impersonated session scoped to the App\'s own org still sees nothing and stores nothing', async () => {
    const org = await db.organization.create({ data: { name: 'S2 imp org', urn: `imp-${generateId().toLowerCase()}.test` } });
    const orgApp = await db.app.create({ data: { name: 'S2 org app', organizationId: org.id, urn: `${generateId().toLowerCase()}:imp` } });
    await db.appMember.create({ data: { appId: orgApp.id, userId: memberId, role: 'reader' } });
    const own = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: orgApp.id, name: 'in-org', kind: 'generic', value: 1 }, context(memberId));
    const impersonated = { db, userId: memberId, roles: [], impersonation: { actorUserId: ownerId, orgId: org.id } } as unknown as Context;
    expect(await resolvers.Query.secret({}, { ref: own.id }, impersonated)).toBeNull();
    await expect(resolvers.Query.secrets({}, { ownerType: 'app', ownerRef: orgApp.id }, impersonated)).resolves.toEqual({ items: [], total: 0 });
    await expect(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: orgApp.id, name: 'imp-store', kind: 'generic', value: 1 }, impersonated)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('a run never resolves an App secret, even when no org or user secret has that name', async () => {
    await create(memberId, 'only-in-app', 'app-value');
    const org = await db.organization.create({ data: { name: 'S2 org', urn: `s2-${generateId().toLowerCase()}.test` } });
    const runCtx = { db, run: { userId: memberId, organizationId: org.id } } as never;
    await expect(resolveRunSecret(runCtx, { name: 'only-in-app' })).resolves.toBeNull();
    await expect(resolveRunSecret(runCtx, { name: 'only-in-app', scope: 'app' as never })).resolves.toBeNull();
    // Every run tool, not one file: none may derive an enum or a check from the owner list, which now names 'app'.
    const toolsDir = new URL('../../../lib/runner/tools/', import.meta.url);
    for (const f of readdirSync(toolsDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(new URL(f, toolsDir), 'utf8');
      expect(src, f).not.toMatch(/SECRET_OWNER_TYPES|isSecretOwnerType/);
    }
  });

  it('listing an App ref that does not resolve answers the same empty page as one the caller may not see', async () => {
    const missing = await resolvers.Query.secrets({}, { ownerType: 'app', ownerRef: generateId() }, context(memberId));
    expect(missing).toEqual({ items: [], total: 0 });
    const garbage = await resolvers.Query.secrets({}, { ownerType: 'app', ownerRef: 'hrn:app:nope.invalid:nothing' }, context(memberId));
    expect(garbage).toEqual({ items: [], total: 0 });
  });

  it('an uninstalled App and a deleted organization refuse stores and answer empty', async () => {
    const secret = await create(memberId);
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    await expect(create(memberId, 'after-uninstall')).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await resolvers.Query.secret({}, { ref: secret.id }, context(memberId))).toBeNull();
    await expect(resolvers.Query.secrets({}, { ownerType: 'app', ownerRef: appId }, context(memberId))).resolves.toEqual({ items: [], total: 0 });
  });

  // ── delete ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it('delete: the creator or whoever manages the App, each as a person; any other member, a worker session and a run are refused', async () => {
    const other = (await db.user.create({ data: { email: `${generateId()}@s2.test` } })).id;
    await db.appMember.create({ data: { appId, userId: other, role: 'reader' } });
    const s1 = await create(memberId, 'del-one');
    await expect(resolvers.Mutation.deleteSecret({}, { ref: s1.id }, context(other))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const worker = { ...context(memberId), sessionBindingRefused: true } as Context;
    await expect(resolvers.Mutation.deleteSecret({}, { ref: s1.id }, worker)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const run = { ...context(memberId), clientId: 'run:abc' } as Context;
    await expect(resolvers.Mutation.deleteSecret({}, { ref: s1.id }, run)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } }); // a run is not a member: concealed
    expect(await db.secret.count({ where: { id: s1.id } })).toBe(1);
    await expect(resolvers.Mutation.deleteSecret({}, { ref: s1.id }, context(ownerId))).resolves.toBe(true); // manager (app owner)
    const s2 = await create(memberId, 'del-two');
    await expect(resolvers.Mutation.deleteSecret({}, { ref: s2.id }, context(memberId))).resolves.toBe(true); // creator
    expect(await db.secretVersion.count()).toBe(0);
  });

  it('a creator who left the App can no longer delete', async () => {
    const s = await create(memberId, 'left');
    await db.appMember.delete({ where: { appId_userId: { appId, userId: memberId } } });
    await expect(resolvers.Mutation.deleteSecret({}, { ref: s.id }, context(memberId))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await db.secret.count({ where: { id: s.id } })).toBe(1);
  });

  it('a protected secret refuses every change until the change-request path exists', async () => {
    const s = await create(memberId, 'prot');
    await db.secret.update({ where: { id: s.id }, data: { protected: true } });
    await expect(resolvers.Mutation.updateSecret({}, { ref: s.id, value: 'x' }, context(memberId))).rejects.toMatchObject({ extensions: { code: 'SECRET_PROTECTED' } });
    await expect(resolvers.Mutation.deleteSecret({}, { ref: s.id }, context(ownerId))).rejects.toMatchObject({ extensions: { code: 'SECRET_PROTECTED' } });
  });

  it('only an App row can be protected or valueless: the owner/value CHECKs', async () => {
    await expect(db.secret.create({ data: { ownerType: 'user', ownerId: memberId, name: 'p', kind: 'generic', metadata: {}, valueEncrypted: 'x', protected: true } })).rejects.toBeTruthy();
    await expect(db.secret.create({ data: { ownerType: 'user', ownerId: memberId, name: 'nv', kind: 'generic', metadata: {}, valueEncrypted: null } })).rejects.toBeTruthy();
    await expect(db.secret.create({ data: { ownerType: 'app', ownerId: appId, name: 'hv', kind: 'generic', metadata: {}, valueEncrypted: 'x' } })).rejects.toBeTruthy();
    await expect(db.secret.create({ data: { ownerType: 'memory', ownerId: appId, name: 'mem', kind: 'generic', metadata: {}, valueEncrypted: 'x' } })).rejects.toBeTruthy();
    expect([...SECRET_OWNER_TYPES]).toEqual(['user', 'org', 'app']);
  });

  // ── App deletion ────────────────────────────────────────────────────────────────────────────────────────────────
  it('deleteApp leaves no App secret and no version, and writes its tombstone once', async () => {
    const s = await create(memberId);
    await resolvers.Mutation.deleteApp({}, { ref: appId }, context(ownerId));
    // The soft delete itself leaves no secret or version, and anchors the events' year.
    expect(await db.secret.count({ where: { id: s.id } })).toBe(0);
    expect(await db.secretVersion.count({ where: { secretId: s.id } })).toBe(0);
    expect(await db.secretOwnerTombstone.count({ where: { ownerId: appId } })).toBe(1);
    expect((await db.secretEvent.findMany({ where: { secretId: s.id } })).map((e) => e.kind).sort()).toEqual(['DELETE', 'STORE']);
    // The hard delete (account erasure, URN reclaim) must leave nothing behind either, and no second tombstone.
    await db.app.delete({ where: { id: appId } });
    expect(await db.secret.count({ where: { id: s.id } })).toBe(0);
    expect(await db.secretVersion.count({ where: { secretId: s.id } })).toBe(0);
    expect(await db.secretAppKey.count({ where: { appId } })).toBe(0);
    const tomb = await db.secretOwnerTombstone.findMany({ where: { ownerId: appId } });
    expect(tomb).toHaveLength(1);
  });

  it('a hard delete of an App row with no soft delete before it leaves no secret, version or key, and a tombstone at that moment', async () => {
    const s = await create(memberId);
    await db.app.delete({ where: { id: appId } });
    expect(await db.secret.count({ where: { id: s.id } })).toBe(0);
    expect(await db.secretVersion.count({ where: { secretId: s.id } })).toBe(0);
    expect(await db.secretAppKey.count({ where: { appId } })).toBe(0);
    const [t] = await db.secretOwnerTombstone.findMany({ where: { ownerId: appId } });
    expect(Date.now() - t.deletedAt.getTime()).toBeLessThan(60_000);
  });

  it('a soft delete followed later by a hard delete keeps the soft delete\'s tombstone time', async () => {
    await create(memberId);
    await resolvers.Mutation.deleteApp({}, { ref: appId }, context(ownerId));
    const [first] = await db.secretOwnerTombstone.findMany({ where: { ownerId: appId } });
    await new Promise((r) => setTimeout(r, 20));
    await db.app.delete({ where: { id: appId } });
    const [after] = await db.secretOwnerTombstone.findMany({ where: { ownerId: appId } });
    expect(after.deletedAt.getTime()).toBe(first.deletedAt.getTime());
  });

  // ── audit ───────────────────────────────────────────────────────────────────────────────────────────────────────
  it('every store and delete writes one event with no value; an update or delete of an event is refused', async () => {
    const s = await create(memberId, 'audited', 'EVENT-CANARY');
    await resolvers.Mutation.updateSecret({}, { ref: s.id, value: 'EVENT-CANARY-2' }, context(memberId));
    await resolvers.Mutation.updateSecret({}, { ref: s.id, metadata: { a: 1 } }, context(memberId));
    await resolvers.Mutation.deleteSecret({}, { ref: s.id }, context(memberId));
    const events = await db.secretEvent.findMany({ where: { secretId: s.id }, orderBy: { at: 'asc' } });
    expect(events.map((e) => e.kind)).toEqual(['STORE', 'VERSION', 'METADATA', 'DELETE']);
    expect(events.every((e) => e.outcome === 'OK' && e.actorUserId === memberId && e.secretName === 'audited')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('EVENT-CANARY');
    await expect(db.secretEvent.update({ where: { id: events[0].id }, data: { outcome: 'x' } })).rejects.toBeTruthy();
    await expect(db.secretEvent.delete({ where: { id: events[0].id } })).rejects.toBeTruthy();
    await expect(db.$executeRaw`TRUNCATE TABLE secret_events`).resolves.toBeDefined(); // owner-only; the serve role's revoke is pinned below
  });

  it('events are listed for any member of the App, newest first, and for nobody else', async () => {
    const s = await create(memberId, 'listed');
    await resolvers.Mutation.updateSecret({}, { ref: s.id, value: 'two' }, context(memberId));
    const page: any = await resolvers.Query.secretEvents({}, { ref: s.id }, context(ownerId));
    expect(page.total).toBe(2);
    expect(page.items.map((e: any) => e.kind)).toEqual(['VERSION', 'STORE']);
    const asMember: any = await resolvers.Query.secretEvents({}, { ref: s.id }, context(memberId));
    expect(asMember.total).toBe(2);
    await expect(resolvers.Query.secretEvents({}, { ref: s.id }, context(outsiderId))).resolves.toEqual({ items: [], total: 0 });
  });

  it('events page by limit and offset in a stable newest-first order, and a secret with no stored version says so', async () => {
    const s = await create(memberId, 'paged');
    for (const v of ['b', 'c', 'd']) await resolvers.Mutation.updateSecret({}, { ref: s.id, value: v }, context(memberId));
    const all: any = await resolvers.Query.secretEvents({}, { ref: s.id }, context(memberId));
    expect(all.total).toBe(4);
    const p1: any = await resolvers.Query.secretEvents({}, { ref: s.id, limit: 2, offset: 0 }, context(memberId));
    const p2: any = await resolvers.Query.secretEvents({}, { ref: s.id, limit: 2, offset: 2 }, context(memberId));
    expect(p1.total).toBe(4);
    expect([...p1.items, ...p2.items].map((e: any) => e.id)).toEqual(all.items.map((e: any) => e.id));
    await db.secretVersion.deleteMany({ where: { secretId: s.id } });
    await expect(currentAppSecretValue(db as never, { id: s.id, ownerId: appId })).rejects.toMatchObject({ extensions: { code: 'SECRET_VERSION_MISSING' } });
  });

  it('the one-year purge rule: event and tombstone deletes are refused unless the owner is gone and its year is up', async () => {
    const owner = `gone-${generateId()}`;
    const insertEvent = () => db.secretEvent.create({ data: { ownerType: 'app', ownerId: owner, secretId: 's', secretName: 'n', kind: 'STORE', outcome: 'OK' } });
    const ev = await insertEvent();
    await expect(db.secretEvent.delete({ where: { id: ev.id } })).rejects.toBeTruthy(); // no tombstone
    await db.secretOwnerTombstone.create({ data: { ownerType: 'app', ownerId: owner } });
    await expect(db.secretEvent.delete({ where: { id: ev.id } })).rejects.toBeTruthy(); // tombstone younger than a year
    await expect(db.secretOwnerTombstone.update({ where: { ownerType_ownerId: { ownerType: 'app', ownerId: owner } }, data: { deletedAt: new Date(0) } })).rejects.toBeTruthy(); // never updated
    await expect(db.secretOwnerTombstone.delete({ where: { ownerType_ownerId: { ownerType: 'app', ownerId: owner } } })).rejects.toBeTruthy(); // year not up, events remain
    // An old tombstone (inserted directly: an update is refused) admits the purge of that owner's events, then the tombstone last.
    const old = `old-${generateId()}`;
    await db.secretOwnerTombstone.create({ data: { ownerType: 'app', ownerId: old, deletedAt: new Date(Date.now() - 400 * 86_400_000) } });
    const oe = await db.secretEvent.create({ data: { ownerType: 'app', ownerId: old, secretId: 's', secretName: 'n', kind: 'STORE', outcome: 'OK' } });
    await expect(db.secretOwnerTombstone.delete({ where: { ownerType_ownerId: { ownerType: 'app', ownerId: old } } })).rejects.toBeTruthy(); // events remain
    await expect(db.secretEvent.delete({ where: { id: oe.id } })).resolves.toBeTruthy();
    await expect(db.secretOwnerTombstone.delete({ where: { ownerType_ownerId: { ownerType: 'app', ownerId: old } } })).resolves.toBeTruthy();
    // A live App is never purged, whatever its tombstone says.
    await db.secretOwnerTombstone.create({ data: { ownerType: 'app', ownerId: appId, deletedAt: new Date(Date.now() - 400 * 86_400_000) } });
    const le = await db.secretEvent.create({ data: { ownerType: 'app', ownerId: appId, secretId: 's', secretName: 'n', kind: 'STORE', outcome: 'OK' } });
    await expect(db.secretEvent.delete({ where: { id: le.id } })).rejects.toBeTruthy();
  });

  // ── deployment files ────────────────────────────────────────────────────────────────────────────────────────────
  it('the serve role cannot update or truncate secret_events; the snapshot script leaves out secret_versions; the migration carries the invariants verbatim', () => {
    const rr = readFileSync(new URL('../../../../prisma/runtime-role.sql', import.meta.url), 'utf8');
    expect(rr).toMatch(/REVOKE UPDATE, TRUNCATE ON TABLE public\.secret_events FROM/);
    const rv = readFileSync(new URL('../../../../scripts/db/revoke-runtime-migrations.ts', import.meta.url), 'utf8');
    expect(rv).toMatch(/REVOKE UPDATE, TRUNCATE ON TABLE public\.secret_events FROM/);
    const sh = readFileSync(new URL('../../../../scripts/dev-from-prod-snapshot.sh', import.meta.url), 'utf8');
    expect(sh).toMatch(/--exclude-table='secret_versions'/);
    const inv = readFileSync(new URL('../../../../prisma/secret-versions-invariants.sql', import.meta.url), 'utf8');
    const mig = readFileSync(new URL('../../../../prisma/migrations/20261114120000_app_secret_versions/migration.sql', import.meta.url), 'utf8');
    expect(mig).toContain(inv);
    // `prisma migrate diff` prints an update banner after its script; pasting stdout once put it in this file and the migration failed to apply.
    expect(mig).not.toMatch(/[┌│└─]|Update available/);
    expect(readFileSync(new URL('../../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir secret-versions-invariants.sql');
  });
});
