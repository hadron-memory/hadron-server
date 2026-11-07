/** #3695: the four retired S7a columns are physically gone, and nothing else is. */
import { existsSync, readFileSync } from 'node:fs';
import { Prisma } from '../../generated/prisma/index.js';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';

const MIGRATION = '20261107170000_drop_retired_s7_columns';
const migrationPath = new URL(`../../../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url);
const historical = (name: string) => readFileSync(new URL(`../../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
const statements = (sql: string) => sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);

const DROPPED = {
  apps: ['delivery_standby_enabled'],
  worker_wake_settings: ['isolated_until', 'isolated_at', 'isolated_by_user_id'],
} as const;
const KEPT_WAKE = ['worker_id', 'mentions', 'paused_until', 'exempt_ended_at', 'updated_at', 'updated_by'];

const columnsOf = async (table: string) =>
  (await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`)
    .map(r => r.column_name);

describe('#3695 retired S7a columns', () => {
  it('P1: a database built from empty has none of the four columns and keeps every other one', async () => {
    const apps = await columnsOf('apps');
    const wake = await columnsOf('worker_wake_settings');
    for (const c of DROPPED.apps) expect(apps, `apps.${c} must be dropped`).not.toContain(c);
    for (const c of DROPPED.worker_wake_settings) expect(wake, `worker_wake_settings.${c} must be dropped`).not.toContain(c);
    expect(wake.sort()).toEqual([...KEPT_WAKE].sort());
    // Neighbours of the dropped apps column stay.
    expect(apps).toEqual(expect.arrayContaining(['delivery_stuck_window_seconds', 'delivery_busy_delay_seconds']));
  });

  it('P2: the generated Prisma client no longer selects them (a stale scalar is a P2022 on every unselected read)', () => {
    const fields = (model: string) =>
      Prisma.dmmf.datamodel.models.find(m => m.name === model)!.fields.map(f => f.name);
    expect(fields('App')).not.toContain('deliveryStandbyEnabled');
    expect(fields('App')).toContain('deliveryStuckWindowSeconds');
    const wake = fields('WorkerWakeSettings');
    for (const f of ['isolatedUntil', 'isolatedAt', 'isolatedByUserId']) expect(wake).not.toContain(f);
    expect(wake).toContain('exemptEndedAt');
  });

  it('P3: the migration drops exactly the four columns from a populated phase-1 shape and changes no other value', async () => {
    // The historical statements that created the columns must really name them (guards the fixture below).
    expect(historical('20261018010000_delivery_settings')).toContain('delivery_standby_enabled');
    const isolation = historical('20261019060000_worker_isolation');
    for (const c of DROPPED.worker_wake_settings) expect(isolation).toContain(c);
    expect(existsSync(migrationPath), `${MIGRATION}/migration.sql must exist`).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');

    await db.$transaction(async tx => {
      const publicApps = Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM public.apps`)[0]!.n);
      for (const table of ['apps', 'worker_wake_settings']) {
        // Same columns and defaults, private to this connection; every NOT NULL relaxed so a sparse row can be inserted.
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`DO $$ DECLARE c text; BEGIN FOR c IN SELECT attname FROM pg_attribute
          WHERE attrelid = 'pg_temp.${table}'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> '${table === 'apps' ? 'id' : 'worker_id'}'
          LOOP EXECUTE format('ALTER TABLE pg_temp.${table} ALTER COLUMN %I DROP NOT NULL', c); END LOOP; END $$`);
      }
      // Rebuild the phase-1 shape whatever the live table looks like (idempotent on main, adds them back after).
      await tx.$executeRawUnsafe('ALTER TABLE pg_temp.apps ADD COLUMN IF NOT EXISTS delivery_standby_enabled BOOLEAN NOT NULL DEFAULT false');
      await tx.$executeRawUnsafe('ALTER TABLE pg_temp.worker_wake_settings ADD COLUMN IF NOT EXISTS isolated_until TIMESTAMP(3), ADD COLUMN IF NOT EXISTS isolated_at TIMESTAMP(3), ADD COLUMN IF NOT EXISTS isolated_by_user_id TEXT');

      const [a1, a2, w1, w2, w3] = [generateId(), generateId(), 'w-live', 'w-expired', 'w-null'];
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp.apps (id, name, delivery_standby_enabled, delivery_busy_delay_seconds, delivery_stuck_window_seconds)
        VALUES ('${a1}', 'standby-on', true, 111, 2222), ('${a2}', 'plain', false, 600, 900)`);
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp.worker_wake_settings (worker_id, mentions, paused_until, exempt_ended_at, updated_by, isolated_until, isolated_at, isolated_by_user_id) VALUES
        ('${w1}', 'OFF', '2099-01-01', '2020-02-02', 'u1', '2099-01-01', '2020-01-01', 'user-x'),
        ('${w2}', 'IMMEDIATE', NULL, '2021-03-03', 'u2', '2001-01-01', '2000-01-01', 'user-y'),
        ('${w3}', 'IMMEDIATE', NULL, NULL, NULL, NULL, NULL, NULL)`);

      const snap = async () => ({
        apps: await tx.$queryRawUnsafe<unknown[]>(`SELECT to_jsonb(t) - 'delivery_standby_enabled' AS r FROM pg_temp.apps t ORDER BY id`),
        wake: await tx.$queryRawUnsafe<unknown[]>(`SELECT to_jsonb(t) - 'isolated_until' - 'isolated_at' - 'isolated_by_user_id' AS r FROM pg_temp.worker_wake_settings t ORDER BY worker_id`),
      });
      const before = await snap();
      expect(before.apps).toHaveLength(2);
      expect(before.wake).toHaveLength(3);
      for (const statement of statements(sql)) await tx.$executeRawUnsafe(statement);
      expect(await snap()).toEqual(before);

      const gone = await tx.$queryRaw<Array<{ attname: string }>>`
        SELECT attname FROM pg_attribute WHERE attnum > 0 AND NOT attisdropped
          AND attrelid IN ('pg_temp.apps'::regclass, 'pg_temp.worker_wake_settings'::regclass)
          AND attname IN ('delivery_standby_enabled', 'isolated_until', 'isolated_at', 'isolated_by_user_id')`;
      expect(gone).toEqual([]);
      const kept = await tx.$queryRaw<Array<{ attname: string }>>`
        SELECT attname FROM pg_attribute WHERE attnum > 0 AND NOT attisdropped
          AND attrelid = 'pg_temp.worker_wake_settings'::regclass AND attname = 'exempt_ended_at'`;
      expect(kept).toHaveLength(1);
      // The statements hit the temp tables, never the real ones.
      expect(Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM public.apps`)[0]!.n)).toBe(publicApps);
    });
  });
});
