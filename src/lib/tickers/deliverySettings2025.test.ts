/** #2025 migration execution, SQL parity and independent DB defense. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';
const migrationUrl = new URL('../../../prisma/migrations/20261018010000_delivery_settings/migration.sql', import.meta.url);
const prePushUrl = new URL('../../../prisma/delivery-settings-pre-push.sql', import.meta.url);
const sourceUrl = new URL('../../../prisma/delivery-settings-invariants.sql', import.meta.url);

describe('delivery settings migration #2025', () => {
  it('pins post-push and byte-identical migration constraint source', () => {
    const source = readFileSync(sourceUrl, 'utf8');
    expect(readFileSync(migrationUrl, 'utf8')).toBe(readFileSync(prePushUrl, 'utf8') + '\n' + source);
    expect(readFileSync(new URL('../../../prisma/pre-push.sql', import.meta.url), 'utf8')).toContain('\\ir delivery-settings-pre-push.sql');
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir delivery-settings-invariants.sql');
  });
  it('executes on the old App shape and preserves customized high floors', async () => {
    const pre = readFileSync(prePushUrl, 'utf8');
    const sql = readFileSync(sourceUrl, 'utf8');
    const statements = sql.split('\n').filter((s) => !s.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE SCHEMA migration_2025');
      await tx.$executeRawUnsafe('SET LOCAL search_path TO migration_2025');
      await tx.$executeRawUnsafe('CREATE TABLE apps (id TEXT PRIMARY KEY, ticker_min_cadence_seconds INTEGER NOT NULL DEFAULT 120)');
      await tx.$executeRawUnsafe("INSERT INTO apps VALUES ('ordinary',120),('custom',600),('ceiling',86400)");
      // The migration is exactly this guarded transition plus the constraints (byte-pinned above).
      // Trusted checked-in SQL only, no interpolated caller input.
      await tx.$executeRawUnsafe(pre);
      const first = await tx.$queryRawUnsafe<Array<{ stuck: number }>>("SELECT delivery_stuck_window_seconds AS stuck FROM apps WHERE id='custom'");
      expect(first).toEqual([{ stuck: 1201 }]);
      await tx.$executeRawUnsafe("UPDATE apps SET delivery_busy_delay_seconds=500, delivery_stuck_window_seconds=1400 WHERE id='custom'");
      await tx.$executeRawUnsafe(pre); // reapplication must not overwrite later manager-chosen settings.
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe("INSERT INTO apps(id) VALUES ('new')");
      const rows = await tx.$queryRawUnsafe('SELECT id, ticker_min_cadence_seconds AS floor, delivery_busy_delay_seconds AS busy, delivery_stuck_window_seconds AS stuck, delivery_standby_enabled AS standby FROM apps ORDER BY id');
      throw Object.assign(new Error('rollback scratch schema'), { rows });
    }).catch((e) => e);
    expect(result.message).toBe('rollback scratch schema');
    expect(result.rows).toEqual([
      { id: 'ceiling', floor: 86400, busy: 600, stuck: 87001, standby: false },
      { id: 'custom', floor: 600, busy: 500, stuck: 1400, standby: false },
      { id: 'new', floor: 120, busy: 600, stuck: 900, standby: false },
      { id: 'ordinary', floor: 120, busy: 600, stuck: 900, standby: false },
    ]);
  });
  it('the database refuses scalar and relation bypasses, including the existing floor column', async () => {
    const u = await db.user.create({ data: { handle: `db2025-${generateId()}` } });
    const app = await db.app.create({ data: { ownerUserId: u.id, name: 'DB defense', urn: `db2025-${generateId()}:app` } });
    try {
      for (const data of [
        { deliveryBusyDelaySeconds: 0 }, { deliveryBusyDelaySeconds: 86401 },
        { deliveryStuckWindowSeconds: 604801 }, { deliveryStuckWindowSeconds: 720 },
        { tickerMinCadenceSeconds: 300 },
      ]) {
        await expect(db.app.update({ where: { id: app.id }, data: data as never })).rejects.toThrow(/chk_apps_delivery_settings/);
      }
    } finally {
      await db.app.delete({ where: { id: app.id } });
      await db.user.delete({ where: { id: u.id } });
    }
  });
});
