/**
 * #4003 (S8 of #3991) — the parts of S8 that need S2's tables (`secret_versions`, `secret_events`,
 * `secret_owner_tombstones`):
 *
 * - The retention purge (open question 10, ruled R5): a version superseded longer than `SECRET_VERSION_RETENTION_DAYS`
 *   is hard-deleted; the current one never is. The kept-versions cap (R24) purges the oldest superseded version early,
 *   in the same pass. Every purged version writes one `PURGE` event (decision 13's new kind), the inline cap trim at a
 *   store included.
 * - Rotation at version level: after a rotation new versions use key n+1 and old ones still decrypt; a key a version
 *   still uses cannot be deleted; the optional re-encrypt moves every version to the active key under its own AAD.
 * - The one-year event purge (R25): an App's events are kept while it exists and for a year after its deletion, then
 *   purged, and the tombstone goes last. Tested for a soft delete, a hard delete with no soft delete before it, and a
 *   soft delete followed by a hard delete.
 *
 * The pinned-read-client row (a client pinned to a purged version refuses SUPERSEDED, never NOT_FOUND) needs S3's
 * `secret_read_clients` and is a follow-up under the epic (Bill, chat #104737).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { decryptBytesAad } from '../tokenCrypto.js';
import { appKeyCache, secretVersionAad, unwrapAppKey } from './appKeys.js';
import { MAX_SECRET_VERSIONS } from './appSecrets.js';
import { reencryptAppSecretVersions, rotateAppKey } from './rotation.js';
import { purgeExpiredSecretEvents, purgeSupersededVersions } from './purge.js';
import { resetSecretRetentionWarningsForTests } from './retention.js';

const DAY = 86_400_000;
let ownerId: string;
let memberId: string;
let appId: string;

const context = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const create = (name: string, value: unknown = 'v1') =>
  resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name, kind: 'generic', value }, context(memberId));
const update = (id: string, value: unknown) => resolvers.Mutation.updateSecret({}, { ref: id, value }, context(memberId));
const versionsOf = async (secretId: string) =>
  (await db.secretVersion.findMany({ where: { secretId }, orderBy: { versionNo: 'asc' } })).map((v) => v.versionNo);
const purgeEvents = (secretId: string) =>
  db.secretEvent.findMany({ where: { secretId, kind: 'PURGE' }, orderBy: { versionNo: 'asc' } });
/** Back-date a version's supersession (no guard on that column). */
const supersededDaysAgo = (secretId: string, versionNo: number, days: number) =>
  db.$executeRaw`UPDATE secret_versions SET superseded_at = (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${days})
    WHERE secret_id = ${secretId} AND version_no = ${versionNo}`;
/** Decrypt one stored version under its own App key version and AAD. */
const decryptVersion = async (secretId: string, versionNo: number): Promise<unknown> => {
  const row = await db.secretVersion.findFirstOrThrow({ where: { secretId, versionNo }, omit: { valueEncrypted: false } });
  const key = await db.$transaction((tx) => unwrapAppKey(tx, row.appId, row.keyVersion));
  return JSON.parse(decryptBytesAad(row.valueEncrypted, secretVersionAad(secretId, versionNo), key.encryptionKey).toString('utf8'));
};
/**
 * Back-date an owner's tombstone. Its guard refuses every update, so the test (as the table's owner) switches the
 * guard off for one statement inside a transaction; the purge itself runs with every guard on.
 */
const tombstoneDaysAgo = (ownerIdArg: string, days: number) =>
  db.$transaction([
    db.$executeRawUnsafe('ALTER TABLE secret_owner_tombstones DISABLE TRIGGER secret_owner_tombstone_guard'),
    db.$executeRaw`UPDATE secret_owner_tombstones SET deleted_at = (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${days})
      WHERE owner_type = 'app' AND owner_id = ${ownerIdArg}`,
    db.$executeRawUnsafe('ALTER TABLE secret_owner_tombstones ENABLE TRIGGER secret_owner_tombstone_guard'),
  ]);

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  delete process.env.SECRET_VERSION_RETENTION_DAYS;
  resetSecretRetentionWarningsForTests();
  appKeyCache.clear();
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s8.test` } })).id;
  memberId = (await db.user.create({ data: { email: `${generateId()}@s8.test` } })).id;
  appId = (await db.app.create({ data: { name: 'S8 purge', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:s8` } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'reader' } });
});
afterEach(() => {
  delete process.env.SECRET_VERSION_RETENTION_DAYS;
  appKeyCache.clear();
});

describe('purgeSupersededVersions: retention', () => {
  it('deletes a version superseded past the window, keeps one inside it, and never the current one', async () => {
    const s = await create('ret', 'a');
    await update(s.id, 'b');
    await update(s.id, 'c');
    await supersededDaysAgo(s.id, 1, 31);
    await supersededDaysAgo(s.id, 2, 29);
    const out = await purgeSupersededVersions(db);
    expect(out.purged).toBe(1);
    expect(await versionsOf(s.id)).toEqual([2, 3]);
  });

  it('never deletes the current version, however old it is', async () => {
    const s = await create('old-current', 'a');
    await db.$executeRaw`UPDATE secret_versions SET written_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '10 years' WHERE secret_id = ${s.id}`;
    expect((await purgeSupersededVersions(db)).purged).toBe(0);
    expect(await versionsOf(s.id)).toEqual([1]);
  });

  it('follows SECRET_VERSION_RETENTION_DAYS, and an invalid value falls back to 30', async () => {
    const s = await create('env', 'a');
    await update(s.id, 'b');
    await update(s.id, 'c');
    await supersededDaysAgo(s.id, 1, 8);
    await supersededDaysAgo(s.id, 2, 6);
    process.env.SECRET_VERSION_RETENTION_DAYS = '7';
    await purgeSupersededVersions(db);
    expect(await versionsOf(s.id)).toEqual([2, 3]);
    process.env.SECRET_VERSION_RETENTION_DAYS = '0';
    await supersededDaysAgo(s.id, 2, 29);
    await purgeSupersededVersions(db);
    expect(await versionsOf(s.id)).toEqual([2, 3]);
  });

  it('writes one PURGE event per purged version, with no value and no actor', async () => {
    const s = await create('evented', 'PURGE-CANARY-1');
    await update(s.id, 'PURGE-CANARY-2');
    await update(s.id, 'PURGE-CANARY-3');
    await supersededDaysAgo(s.id, 1, 40);
    await supersededDaysAgo(s.id, 2, 40);
    await purgeSupersededVersions(db);
    const events = await purgeEvents(s.id);
    expect(events.map((e) => e.versionNo)).toEqual([1, 2]);
    expect(events.every((e) => e.outcome === 'OK' && e.ownerType === 'app' && e.ownerId === appId && e.secretName === 'evented')).toBe(true);
    expect(events.every((e) => e.actorUserId === null && e.workerId === null && e.sessionId === null)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PURGE-CANARY');
  });

  it('touches only expired superseded rows of any App, and a second pass purges nothing', async () => {
    const s = await create('one', 'a');
    await update(s.id, 'b');
    const t = await create('two', 'a');
    await update(t.id, 'b');
    await supersededDaysAgo(s.id, 1, 31);
    expect((await purgeSupersededVersions(db)).purged).toBe(1);
    expect(await versionsOf(t.id)).toEqual([1, 2]);
    expect((await purgeSupersededVersions(db)).purged).toBe(0);
    expect(await purgeEvents(s.id)).toHaveLength(1);
  });

  it('drains in bounded batches and says when rows remain', async () => {
    const s = await create('batched', 'a');
    for (const v of ['b', 'c', 'd', 'e']) await update(s.id, v);
    for (const n of [1, 2, 3, 4]) await supersededDaysAgo(s.id, n, 31);
    const first = await purgeSupersededVersions(db, { batchSize: 2, maxBatches: 1 });
    expect(first).toEqual({ purged: 2, more: true });
    const second = await purgeSupersededVersions(db, { batchSize: 2, maxBatches: 5 });
    expect(second).toEqual({ purged: 2, more: false });
    expect(await versionsOf(s.id)).toEqual([5]);
    expect(await purgeEvents(s.id)).toHaveLength(4);
  });
});

describe('purgeSupersededVersions: the kept-versions cap', () => {
  it('purges the oldest superseded versions beyond the cap in the same pass, inside the retention window', async () => {
    const s = await create('capped', 'a');
    // Rows written straight to the table (the store trims at the cap itself; the pass is the backstop).
    for (let n = 2; n <= MAX_SECRET_VERSIONS + 5; n++) {
      const v1 = await db.secretVersion.findFirstOrThrow({ where: { secretId: s.id, versionNo: 1 }, omit: { valueEncrypted: false } });
      await db.secretVersion.create({ data: { secretId: s.id, versionNo: n, valueEncrypted: v1.valueEncrypted, appId, keyVersion: v1.keyVersion, sizeBytes: 3 } });
    }
    await db.$executeRaw`UPDATE secret_versions SET superseded_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE secret_id = ${s.id} AND version_no < ${MAX_SECRET_VERSIONS + 5}`;
    const out = await purgeSupersededVersions(db);
    expect(out.purged).toBe(5);
    const nos = await versionsOf(s.id);
    expect(nos).toHaveLength(MAX_SECRET_VERSIONS);
    expect(nos[0]).toBe(6);
    expect((await purgeEvents(s.id)).map((e) => e.versionNo)).toEqual([1, 2, 3, 4, 5]);
  });

  it('the store\'s own trim at the cap writes a PURGE event for each version it drops', async () => {
    const s = await create('store-trim', 'a');
    for (let i = 2; i <= MAX_SECRET_VERSIONS + 2; i++) await update(s.id, `v${i}`);
    expect((await versionsOf(s.id))[0]).toBe(3);
    const events = await purgeEvents(s.id);
    expect(events.map((e) => e.versionNo)).toEqual([1, 2]);
    expect(events.every((e) => e.actorUserId === memberId)).toBe(true);
  });
});

describe('rotation at version level', () => {
  it('after rotation new versions use key n+1 and old ones still decrypt', async () => {
    const s = await create('rotated', 'before');
    await db.$transaction((tx) => rotateAppKey(tx, appId));
    await update(s.id, 'after');
    const rows = await db.secretVersion.findMany({ where: { secretId: s.id }, orderBy: { versionNo: 'asc' } });
    expect(rows.map((r) => [r.versionNo, r.keyVersion])).toEqual([[1, 1], [2, 2]]);
    appKeyCache.clear();
    expect(await decryptVersion(s.id, 1)).toBe('before');
    expect(await decryptVersion(s.id, 2)).toBe('after');
  });

  it('a key still used by a version cannot be deleted', async () => {
    await create('pinned-key', 'x');
    await db.$transaction((tx) => rotateAppKey(tx, appId));
    await expect(db.secretAppKey.delete({ where: { appId_keyVersion: { appId, keyVersion: 1 } } })).rejects.toBeTruthy();
    expect(await db.secretAppKey.count({ where: { appId, keyVersion: 1 } })).toBe(1);
  });

  it('re-encrypt moves every version to the active key under its own AAD; the values are unchanged; a re-run moves nothing', async () => {
    const s = await create('reenc', 'one');
    await update(s.id, 'two');
    await db.$transaction((tx) => rotateAppKey(tx, appId));
    await update(s.id, 'three');
    expect(await db.$transaction((tx) => reencryptAppSecretVersions(tx, appId))).toBe(2);
    const rows = await db.secretVersion.findMany({ where: { secretId: s.id }, orderBy: { versionNo: 'asc' } });
    expect(rows.map((r) => r.keyVersion)).toEqual([2, 2, 2]);
    appKeyCache.clear();
    expect([await decryptVersion(s.id, 1), await decryptVersion(s.id, 2), await decryptVersion(s.id, 3)]).toEqual(['one', 'two', 'three']);
    expect(await db.$transaction((tx) => reencryptAppSecretVersions(tx, appId))).toBe(0);
    // Nothing uses key 1 any more, so the restriction no longer holds it.
    await expect(db.secretAppKey.delete({ where: { appId_keyVersion: { appId, keyVersion: 1 } } })).resolves.toBeTruthy();
  });

  it('re-encrypt touches only the named App', async () => {
    const otherApp = (await db.app.create({ data: { name: 'other', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:s8o` } })).id;
    await db.appMember.create({ data: { appId: otherApp, userId: memberId, role: 'reader' } });
    const o = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: otherApp, name: 'o', kind: 'generic', value: 'o' }, context(memberId));
    await create('mine', 'm');
    await db.$transaction((tx) => rotateAppKey(tx, appId));
    await db.$transaction((tx) => rotateAppKey(tx, otherApp));
    expect(await db.$transaction((tx) => reencryptAppSecretVersions(tx, appId))).toBe(1);
    expect((await db.secretVersion.findFirstOrThrow({ where: { secretId: o.id } })).keyVersion).toBe(1);
  });

  it('re-encrypt under a root other than the recorded one refuses and moves nothing', async () => {
    const s = await create('wrong-root', 'x');
    await db.$transaction((tx) => rotateAppKey(tx, appId));
    process.env.SECRET_ROOT_KEY = '33'.repeat(32);
    appKeyCache.clear();
    await expect(db.$transaction((tx) => reencryptAppSecretVersions(tx, appId))).rejects.toMatchObject({ extensions: { code: 'SECRET_KEY_UNAVAILABLE' } });
    expect((await db.secretVersion.findFirstOrThrow({ where: { secretId: s.id } })).keyVersion).toBe(1);
  });
});

describe('purgeExpiredSecretEvents: one year after the App is gone (R25)', () => {
  const eventsOf = (owner: string) => db.secretEvent.count({ where: { ownerType: 'app', ownerId: owner } });
  const tombOf = (owner: string) => db.secretOwnerTombstone.count({ where: { ownerType: 'app', ownerId: owner } });

  /** Day 364 keeps everything; after day 365 the events go and the tombstone last. */
  async function expectYearRule(owner: string) {
    const before = await eventsOf(owner);
    expect(before).toBeGreaterThan(0);
    await tombstoneDaysAgo(owner, 364);
    expect(await purgeExpiredSecretEvents(db)).toEqual({ events: 0, tombstones: 0 });
    expect(await eventsOf(owner)).toBe(before);
    expect(await tombOf(owner)).toBe(1);
    await tombstoneDaysAgo(owner, 366);
    expect(await purgeExpiredSecretEvents(db)).toEqual({ events: before, tombstones: 1 });
    expect(await eventsOf(owner)).toBe(0);
    expect(await tombOf(owner)).toBe(0);
  }

  it('a soft delete: events kept on day 364, purged after day 365, tombstone last', async () => {
    const s = await create('soft', 'a');
    await update(s.id, 'b');
    await resolvers.Mutation.deleteApp({}, { ref: appId }, context(ownerId));
    await expectYearRule(appId);
  });

  it('a hard delete with no soft delete before it: the same rule', async () => {
    await create('hard', 'a');
    await db.app.delete({ where: { id: appId } });
    await expectYearRule(appId);
  });

  it('a soft delete followed by a hard delete: the same rule, counted from the first', async () => {
    await create('both', 'a');
    await resolvers.Mutation.deleteApp({}, { ref: appId }, context(ownerId));
    await tombstoneDaysAgo(appId, 200);
    await db.app.delete({ where: { id: appId } });
    expect(await tombOf(appId)).toBe(1);
    await expectYearRule(appId);
  });

  it('never purges a live App\'s events, whatever its tombstone says, and leaves other owners alone', async () => {
    await create('live', 'a');
    await db.secretOwnerTombstone.create({ data: { ownerType: 'app', ownerId: appId, deletedAt: new Date(Date.now() - 400 * DAY) } });
    const gone = `gone-${generateId()}`;
    await db.secretEvent.create({ data: { ownerType: 'app', ownerId: gone, secretId: 's', secretName: 'n', kind: 'STORE', outcome: 'OK' } });
    await db.secretOwnerTombstone.create({ data: { ownerType: 'app', ownerId: gone, deletedAt: new Date(Date.now() - 30 * DAY) } });
    expect(await purgeExpiredSecretEvents(db)).toEqual({ events: 0, tombstones: 0 });
    expect(await eventsOf(appId)).toBe(1);
    expect(await eventsOf(gone)).toBe(1);
  });

  it('the tombstone goes last: a pass cut short by its batch bound leaves it for the next pass', async () => {
    const s = await create('many-events', 'a');
    for (const v of ['b', 'c', 'd']) await update(s.id, v);
    await db.app.delete({ where: { id: appId } });
    await tombstoneDaysAgo(appId, 366);
    const first = await purgeExpiredSecretEvents(db, { batchSize: 2, maxBatches: 1 });
    expect(first).toEqual({ events: 2, tombstones: 0 });
    expect(await tombOf(appId)).toBe(1);
    expect(await purgeExpiredSecretEvents(db)).toEqual({ events: 2, tombstones: 1 });
    expect(await tombOf(appId)).toBe(0);
  });
});
