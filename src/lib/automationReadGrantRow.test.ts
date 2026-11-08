/**
 * #2883 — the database half of the automation read grant (prisma/app-automation-read-grant-invariants.sql), tested at
 * the database rather than through the doors: the shape CHECK, the one-live-row index (NULL prefix is one value), the
 * terminal-revoke trigger and the append-only trigger on the events.
 */
import { readFileSync, readdirSync } from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';

let app: { id: string };
let memory: { id: string };
let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Inv', urn: 'rgrant-inv.test' } });
  orgId = org.id;
  app = await db.app.create({ data: { name: 'Inv', urn: 'rgrant-inv.test:app', organizationId: org.id }, select: { id: true } });
  memory = await db.memory.create({ data: { name: 'dest', urn: 'rgrant-inv.test:dest', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never, select: { id: true } });
});

const row = (data: Record<string, unknown> = {}) =>
  db.appAutomationReadGrant.create({ data: { appId: app.id, triggerKind: 'SCHEDULE', triggerId: 't1', memoryId: memory.id, prefix: 'tasks', grantedBy: 'user-a', ...data } });
const violation = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

describe('app-automation-read-grant-invariants.sql', () => {
  it('the migration carries a byte-identical copy of the invariants file', () => {
    const sql = readFileSync(new URL('../../prisma/app-automation-read-grant-invariants.sql', import.meta.url), 'utf8');
    const dir = readdirSync(new URL('../../prisma/migrations', import.meta.url)).find((d) => d.endsWith('_app_automation_read_grants'));
    expect(dir).toBeTruthy();
    expect(readFileSync(new URL(`../../prisma/migrations/${dir}/migration.sql`, import.meta.url), 'utf8').endsWith(sql)).toBe(true);
  });

  it('the prefix is NULL (whole memory) or a loc: empty, edge colons, doubled colons and spaces are refused', async () => {
    for (const prefix of ['', ':a', 'a:', 'a::b', 'a b', '-a', 'a-']) await violation(row({ prefix }), /violates check constraint/);
    for (const prefix of ['a', 'tasks:report', 'a.b_c:d-e:2026-10-27', null]) await expect(row({ prefix, triggerId: `t-${prefix}` })).resolves.toBeTruthy();
  });

  it('the trigger kind is SCHEDULE or WEBHOOK; ids and actors are never empty; revoke fields go together', async () => {
    await violation(row({ triggerKind: 'MANUAL' }), /violates check constraint/);
    await violation(row({ triggerId: '' }), /violates check constraint/);
    await violation(row({ grantedBy: '' }), /violates check constraint/);
    await violation(row({ revokedAt: new Date() }), /violates check constraint/);
    await violation(row({ revokedBy: 'u' }), /violates check constraint/);
  });

  it('at most one LIVE row per (App, trigger, memory, prefix), a NULL prefix counting as one value; a revoked row never blocks a fresh one', async () => {
    const first = await row();
    await violation(row(), /Unique constraint|unique/i);
    await row({ triggerId: 't2' });
    await row({ prefix: 'other' });
    await row({ triggerKind: 'WEBHOOK' });
    await row({ prefix: null });
    await violation(row({ prefix: null }), /Unique constraint|unique/i);
    await db.appAutomationReadGrant.update({ where: { id: first.id }, data: { revokedAt: new Date(), revokedBy: 'user-b' } });
    await expect(row()).resolves.toBeTruthy();
  });

  it('a row ends once and is otherwise never edited or deleted', async () => {
    const r = await row();
    await violation(db.appAutomationReadGrant.update({ where: { id: r.id }, data: { prefix: 'wider' } }), /append-only/);
    await violation(db.appAutomationReadGrant.update({ where: { id: r.id }, data: { prefix: null } }), /append-only/);
    await violation(db.appAutomationReadGrant.update({ where: { id: r.id }, data: { triggerId: 't9' } }), /append-only/);
    await violation(db.appAutomationReadGrant.update({ where: { id: r.id }, data: { grantedBy: 'someone' } }), /append-only/);
    await violation(db.appAutomationReadGrant.update({ where: { id: r.id }, data: { revokedAt: new Date() } }), /violates check constraint/);
    await db.appAutomationReadGrant.update({ where: { id: r.id }, data: { revokedAt: new Date(), revokedBy: 'user-b' } });
    await violation(db.appAutomationReadGrant.update({ where: { id: r.id }, data: { revokedAt: null, revokedBy: null } }), /append-only/);
    await violation(db.appAutomationReadGrant.update({ where: { id: r.id }, data: { revokedBy: 'user-c' } }), /append-only/);
    await violation(db.appAutomationReadGrant.delete({ where: { id: r.id } }), /append-only/);
  });

  it('a hard delete of the memory or the App carries the rows away (the one allowed delete)', async () => {
    await row();
    await db.memory.delete({ where: { id: memory.id } });
    expect(await db.appAutomationReadGrant.count()).toBe(0);
    const m2 = await db.memory.create({ data: { name: 'd2', urn: 'rgrant-inv.test:d2', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId } as never, select: { id: true } });
    await row({ memoryId: m2.id });
    await db.appAutomationReadGrantEvent.create({ data: { appId: app.id, triggerKind: 'SCHEDULE', triggerId: 't1', memoryId: m2.id, grantId: 'g', prefix: 'p', action: 'GRANT', actorUserId: 'user-a' } });
    await db.app.delete({ where: { id: app.id } });
    expect(await db.appAutomationReadGrant.count()).toBe(0);
    expect(await db.appAutomationReadGrantEvent.count()).toBe(0);
  });

  it('events are append-only and shaped (a NULL prefix is allowed, an empty one is not)', async () => {
    const base = { appId: app.id, triggerKind: 'SCHEDULE', triggerId: 't1', memoryId: memory.id, grantId: 'g', prefix: 'p', action: 'GRANT', actorUserId: 'user-a' };
    const ev = await db.appAutomationReadGrantEvent.create({ data: base });
    await db.appAutomationReadGrantEvent.create({ data: { ...base, prefix: null } });
    await violation(db.appAutomationReadGrantEvent.update({ where: { id: ev.id }, data: { prefix: 'q' } }), /append-only/);
    await violation(db.appAutomationReadGrantEvent.delete({ where: { id: ev.id } }), /append-only/);
    for (const data of [{ action: 'EDIT' }, { triggerKind: 'MANUAL' }, { triggerId: '' }, { prefix: '' }, { actorUserId: '' }, { grantId: '' }, { memoryId: '' }]) {
      await violation(db.appAutomationReadGrantEvent.create({ data: { ...base, ...data } }), /violates check constraint/);
    }
  });
});
