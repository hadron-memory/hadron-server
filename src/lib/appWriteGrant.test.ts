/**
 * #2484 — the database half of the App write grant contract
 * (prisma/app-memory-write-grant-invariants.sql), tested at the database rather than through the doors: the shape
 * CHECK, the one-live-row index, the terminal-revoke trigger on app_memory_write_grants and the append-only trigger
 * on app_memory_write_grant_events. Plus the two pure predicates the gate is built from.
 */
import { readFileSync, readdirSync } from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { grantCoversLoc, isUserlessRunPrincipal, grantTargetRefusal } from './appWriteGrant.js';

let app: { id: string };
let memory: { id: string };
let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Inv', urn: 'grant-inv.test' } });
  orgId = org.id;
  app = await db.app.create({ data: { name: 'Inv', urn: 'grant-inv.test:app', organizationId: org.id }, select: { id: true } });
  memory = await db.memory.create({ data: { name: 'dest', urn: 'grant-inv.test:dest', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never, select: { id: true } });
});

const grantRow = (data: Record<string, unknown> = {}) =>
  db.appMemoryWriteGrant.create({ data: { appId: app.id, memoryId: memory.id, prefix: 'reports:team-progress', grantedBy: 'user-a', ...data } });
const violation = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

describe('app-memory-write-grant-invariants.sql', () => {
  it('the migration carries a byte-identical copy of the invariants file', () => {
    const sql = readFileSync(new URL('../../prisma/app-memory-write-grant-invariants.sql', import.meta.url), 'utf8');
    const dir = readdirSync(new URL('../../prisma/migrations', import.meta.url)).find((d) => d.endsWith('_app_memory_write_grants'));
    expect(dir).toBeTruthy();
    const migration = readFileSync(new URL(`../../prisma/migrations/${dir}/migration.sql`, import.meta.url), 'utf8');
    expect(migration.endsWith(sql)).toBe(true);
  });

  it('the prefix is a required loc: empty, edge colons, doubled colons and spaces are refused', async () => {
    for (const prefix of ['', ':a', 'a:', 'a::b', 'a b', '-a', 'a-', 'a:-b']) {
      await violation(grantRow({ prefix }), /chk_app_memory_write_grant_shape|violates check constraint/);
    }
    for (const prefix of ['a', 'reports:team-progress', 'a.b_c:d-e:2026-10-27', 'x1']) {
      await expect(grantRow({ prefix })).resolves.toBeTruthy();
    }
  });

  it('revokedAt and revokedBy go together; granted_by is never empty', async () => {
    await violation(grantRow({ revokedAt: new Date() }), /violates check constraint/);
    await violation(grantRow({ revokedBy: 'user-b' }), /violates check constraint/);
    await violation(grantRow({ grantedBy: '' }), /violates check constraint/);
  });

  it('at most one LIVE row per (App, memory, prefix); a revoked row never blocks a fresh one', async () => {
    const first = await grantRow();
    await violation(grantRow(), /Unique constraint|unique/i);
    await grantRow({ prefix: 'reports:other' });
    await db.appMemoryWriteGrant.update({ where: { id: first.id }, data: { revokedAt: new Date(), revokedBy: 'user-b' } });
    await expect(grantRow()).resolves.toBeTruthy();
  });

  it('a row ends once and is otherwise never edited or deleted', async () => {
    const row = await grantRow();
    await violation(db.appMemoryWriteGrant.update({ where: { id: row.id }, data: { prefix: 'reports:wider' } }), /append-only/);
    await violation(db.appMemoryWriteGrant.update({ where: { id: row.id }, data: { grantedBy: 'someone-else' } }), /append-only/);
    await violation(db.appMemoryWriteGrant.update({ where: { id: row.id }, data: { revokedAt: new Date() } }), /violates check constraint/);
    await db.appMemoryWriteGrant.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedBy: 'user-b' } });
    await violation(db.appMemoryWriteGrant.update({ where: { id: row.id }, data: { revokedAt: null, revokedBy: null } }), /append-only/);
    await violation(db.appMemoryWriteGrant.update({ where: { id: row.id }, data: { revokedBy: 'user-c' } }), /append-only/);
    await violation(db.appMemoryWriteGrant.delete({ where: { id: row.id } }), /append-only/);
  });

  it('a hard delete of the App or of the memory carries the rows away (the one allowed delete)', async () => {
    await grantRow();
    await db.memory.delete({ where: { id: memory.id } });
    expect(await db.appMemoryWriteGrant.count()).toBe(0);
    const m2 = await db.memory.create({ data: { name: 'd2', urn: 'grant-inv.test:d2', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId } as never, select: { id: true } });
    await db.appMemoryWriteGrant.create({ data: { appId: app.id, memoryId: m2.id, prefix: 'p', grantedBy: 'user-a' } });
    await db.appMemoryWriteGrantEvent.create({ data: { appId: app.id, memoryId: m2.id, grantId: 'g', prefix: 'p', action: 'GRANT', actorUserId: 'user-a' } });
    await db.app.delete({ where: { id: app.id } });
    expect(await db.appMemoryWriteGrant.count()).toBe(0);
    expect(await db.appMemoryWriteGrantEvent.count()).toBe(0);
  });

  it('events are append-only and shaped', async () => {
    const ev = await db.appMemoryWriteGrantEvent.create({ data: { appId: app.id, memoryId: memory.id, grantId: 'g', prefix: 'p', action: 'GRANT', actorUserId: 'user-a' } });
    await violation(db.appMemoryWriteGrantEvent.update({ where: { id: ev.id }, data: { prefix: 'q' } }), /append-only/);
    await violation(db.appMemoryWriteGrantEvent.delete({ where: { id: ev.id } }), /append-only/);
    for (const data of [{ action: 'EDIT' }, { prefix: '' }, { actorUserId: '' }, { grantId: '' }, { memoryId: '' }]) {
      await violation(db.appMemoryWriteGrantEvent.create({ data: { appId: app.id, memoryId: memory.id, grantId: 'g', prefix: 'p', action: 'GRANT', actorUserId: 'user-a', ...data } }), /violates check constraint/);
    }
  });
});

describe('grantCoversLoc', () => {
  it.each([
    ['reports:team-progress', 'reports:team-progress', true],
    ['reports:team-progress', 'reports:team-progress:2026', true],
    ['reports:team-progress', 'reports:team-progress:2026:deep', true],
    ['reports:team-progress', 'reports:team-progressX', false],
    ['reports:team-progress', 'reports:team-progressX:child', false],
    ['reports:team-progress', 'reports:team-progres', false],
    ['reports:team-progress', 'reports', false],
    ['reports:team-progress', 'x:reports:team-progress', false],
    ['a_b', 'axb', false],
    ['a_b', 'a_b:c', true],
  ])('prefix %s vs loc %s -> %s', (prefix, loc, covered) => {
    expect(grantCoversLoc(prefix, loc)).toBe(covered);
  });
});

describe('isUserlessRunPrincipal', () => {
  it.each([
    [{ clientId: 'run:r1', appId: 'a' }, true],
    [{ clientId: 'run:r1', appId: 'a', userId: 'u' }, false],
    [{ clientId: 'run:r1' }, false],
    [{ clientId: 'run:r1', appId: 'a', sessionId: 's' }, false],
    [{ clientId: 'run:r1', appId: 'a', impersonation: { adminUserId: 'x' } }, false],
    [{ clientId: 'appkey:k', appId: 'a' }, false],
    [{ clientId: 'user:u', appId: 'a', userId: 'u' }, false],
    [{ appId: 'a' }, false],
  ] as const)('%j -> %s', (auth, expected) => {
    expect(isUserlessRunPrincipal(auth as never)).toBe(expected);
  });
});

describe('grantTargetRefusal', () => {
  const app = { id: 'app1', organizationId: 'org1', ownerUserId: null };
  const mem = (over: Record<string, unknown> = {}) => ({
    id: 'm', class: 'knowledge', userId: null, organizationId: 'org1', appId: null, ownerUserId: null,
    isEncrypted: false, isInstallMemory: false, userMemoryOfAgentId: null, workerOf: [], ...over,
  }) as never;
  it('refuses encrypted and install memories for every class', () => {
    for (const c of ['knowledge', 'personal', 'private', 'app', 'system']) {
      expect(grantTargetRefusal(app, mem({ class: c, isEncrypted: true, userId: 'u', appId: 'app1' }))).toBe('encrypted');
    }
    expect(grantTargetRefusal(app, mem({ isInstallMemory: true }))).toBe('install-memory');
  });
  it('a shared memory must be held by the App\'s own org or be its team space', () => {
    expect(grantTargetRefusal(app, mem())).toBeNull();
    expect(grantTargetRefusal(app, mem({ organizationId: 'org2' }))).toBe('tenancy');
    expect(grantTargetRefusal(app, mem({ organizationId: null, ownerUserId: 'u' }))).toBe('tenancy');
    expect(grantTargetRefusal(app, mem({ class: 'app', appId: 'app1' }))).toBeNull();
    expect(grantTargetRefusal(app, mem({ class: 'app', appId: 'app2' }))).toBe('tenancy');
    expect(grantTargetRefusal(app, mem({ class: 'app', appId: 'app1', workerOf: [{ id: 'w' }] }))).toBe('tenancy');
    expect(grantTargetRefusal(app, mem({ class: 'app', appId: 'app1', userMemoryOfAgentId: 'ag' }))).toBe('tenancy');
    // another App's team space in the same org is not this App's
    expect(grantTargetRefusal(app, mem({ class: 'app', appId: 'app2', organizationId: 'org1' }))).toBe('tenancy');
    // a user-owned App has no org: only its own team space qualifies
    const userApp = { id: 'app1', organizationId: null, ownerUserId: 'u' };
    expect(grantTargetRefusal(userApp, mem({ organizationId: null }))).toBe('tenancy');
    expect(grantTargetRefusal(userApp, mem({ class: 'app', appId: 'app1', organizationId: null }))).toBeNull();
  });
  it('#2710: a class=system memory is never a target, even one the App\'s own org holds', () => {
    expect(grantTargetRefusal(app, mem({ class: 'system' }))).toBe('system');
    expect(grantTargetRefusal({ id: 'app1', organizationId: null, ownerUserId: 'u' }, mem({ class: 'system', organizationId: null }))).toBe('system');
  });
  it('a personal or private memory needs an owner', () => {
    expect(grantTargetRefusal(app, mem({ class: 'personal', userId: 'u', organizationId: null }))).toBeNull();
    expect(grantTargetRefusal(app, mem({ class: 'private', userId: 'u', organizationId: 'org2' }))).toBeNull();
    expect(grantTargetRefusal(app, mem({ class: 'private', userId: null }))).toBe('no-owner');
  });
});
