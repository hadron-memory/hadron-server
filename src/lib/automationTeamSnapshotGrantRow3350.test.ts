import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';

let appId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Grant invariant', urn: 'team-grant-invariant.example' } });
  appId = (await db.app.create({ data: { name: 'App', urn: 'team-grant-invariant.example:app', organizationId: org.id } })).id;
});
const row = (extra = {}) => db.appAutomationTeamSnapshotGrant.create({ data: { appId, triggerKind: 'SCHEDULE', triggerId: 't', grantedBy: 'person', ...extra } });
it('migration embeds the same terminal-row and append-only event protocol as post-push', () => {
  const invariant = readFileSync('prisma/app-automation-team-snapshot-grant-invariants.sql', 'utf8');
  expect(readFileSync('prisma/migrations/20261103210000_automation_team_snapshot_grants/migration.sql', 'utf8').endsWith(invariant)).toBe(true);
});
it('shape and one-live-row CHECKs, terminal revoke, append-only events, and App hard-delete cascade', async () => {
  for (const bad of [{ triggerKind: 'MANUAL' }, { triggerId: '' }, { grantedBy: '' }, { revokedAt: new Date() }, { revokedBy: 'p' }]) await expect(row(bad)).rejects.toThrow(/check constraint/);
  const grant = await row();
  await expect(row()).rejects.toThrow(/Unique constraint|unique/i);
  await expect(db.appAutomationTeamSnapshotGrant.update({ where: { id: grant.id }, data: { triggerId: 'other' } })).rejects.toThrow(/append-only/);
  await expect(db.appAutomationTeamSnapshotGrant.delete({ where: { id: grant.id } })).rejects.toThrow(/append-only/);
  await db.appAutomationTeamSnapshotGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), revokedBy: 'p' } });
  await expect(db.appAutomationTeamSnapshotGrant.update({ where: { id: grant.id }, data: { revokedAt: null, revokedBy: null } })).rejects.toThrow(/append-only/);
  await row();
  const event = await db.appAutomationTeamSnapshotGrantEvent.create({ data: { appId, triggerKind: 'SCHEDULE', triggerId: 't', grantId: grant.id, action: 'GRANT', actorUserId: 'p' } });
  await expect(db.appAutomationTeamSnapshotGrantEvent.update({ where: { id: event.id }, data: { actorUserId: 'other' } })).rejects.toThrow(/append-only/);
  await expect(db.appAutomationTeamSnapshotGrantEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
  await db.app.delete({ where: { id: appId } });
  expect(await db.appAutomationTeamSnapshotGrant.count()).toBe(0);
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(0);
});
it('migration of a populated legacy flag-on App drops the flag and infers no grant/event', async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    await pg.query('DROP TABLE app_automation_team_snapshot_grant_events, app_automation_team_snapshot_grants');
    await pg.query('ALTER TABLE apps ADD COLUMN run_team_snapshot_enabled boolean NOT NULL DEFAULT false');
    await pg.query('UPDATE apps SET run_team_snapshot_enabled=true WHERE id=$1', [appId]);
    expect((await pg.query('SELECT run_team_snapshot_enabled FROM apps WHERE id=$1', [appId])).rows[0].run_team_snapshot_enabled).toBe(true);
    await pg.query(readFileSync('prisma/migrations/20261103210000_automation_team_snapshot_grants/migration.sql', 'utf8'));
    expect((await pg.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='apps' AND column_name='run_team_snapshot_enabled'")).rows[0].n).toBe(0);
    expect(await db.appAutomationTeamSnapshotGrant.count()).toBe(0);
    expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(0);
    expect(await db.app.findUnique({ where: { id: appId } })).not.toBeNull();
  } finally { await pg.end(); }
});
