/** #3449: execute the widening against empty and legacy-populated table shapes. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';
import { requireAppActionCode } from '../../lib/actionRegister/appCode.js';

const migration = () => readFileSync(new URL('../../../prisma/migrations/20261104180000_app_action_event_codes/migration.sql', import.meta.url), 'utf8');
const previous = readFileSync(new URL('../../../prisma/migrations/20261012020000_agent_task_backlog_status/migration.sql', import.meta.url), 'utf8');
const start = previous.indexOf('ALTER TABLE agent_team_events DROP CONSTRAINT');
const end = previous.indexOf('-- Append-only', start);
const statements = (sql: string) => sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
const legacy = ['app.properties-changed', 'app.credential-act', 'app.manager-act', 'tick.worker', 'app.letters', 'app.' + 'x'.repeat(65)];

describe('App action event CHECK migration', () => {
  it.each([false, true])('applies with legacy rows = %s without tightening prior types', async populated => {
    await db.$transaction(async tx => {
      // Same columns/defaults, isolated on this connection; no FK, trigger or public table mutation.
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE agent_team_events (LIKE public.agent_team_events INCLUDING DEFAULTS ) ON COMMIT DROP`);
      const insert = (type: string) => tx.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, payload) VALUES (${generateId()}, 'migration-only', ${type}, '{}'::jsonb)`;
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      // Install the ACTUAL previous CHECK, never the widened live-table constraint.
      for (const statement of statements(previous.slice(start, end))) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe('SAVEPOINT old_grammar');
      await expect(insert('app.team.v2')).rejects.toThrow(/chk_agent_team_events_shape/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT old_grammar');
      if (populated) for (const type of legacy) await insert(type);
      for (const statement of statements(migration())) await tx.$executeRawUnsafe(statement);
      if (populated) {
        const rows = await tx.$queryRaw<Array<{ type: string }>>`SELECT type FROM agent_team_events ORDER BY type`;
        expect(rows.map(r => r.type)).toEqual([...legacy].sort());
      }
      for (const type of [...legacy, 'app.team.2x', 'app.team.a--b', 'app.app2--team.v2']) await insert(type);
      for (const type of ['app.team.bad_name', 'app.team.-bad', 'app.team.x-', 'app.team.v2' + 'x'.repeat(54)]) {
        await tx.$executeRawUnsafe('SAVEPOINT bad_event_type');
        await expect(insert(type)).rejects.toThrow(/chk_agent_team_events_shape/);
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bad_event_type');
      }
    });
  });
  it('compares current-App resolver boundaries with the DB union, keeping legacy and foreign-slug exceptions explicit', async () => {
    const cases: [string, boolean, boolean][] = [
      ['app.team.v2', true, true], ['app.team.2x', true, true], ['app.team.a--b', true, true],
      ['app.team.a.b2', true, true], ['app.team.' + 'x'.repeat(55), true, true],
      // Letters-only old grammar deliberately has no 64-character cap.
      ['app.team.' + 'x'.repeat(56), false, true],
      ['app.team.' + '2'.repeat(56), false, false],
      ['app.team.bad_name', false, false], ['app.team.UPPER', false, false],
      ['app.team..x', false, false], ['app.team.-x', false, false],
      ['app.team.x-', false, false], ['app.team.', false, false],
      ['app.other.v2', false, true], ['app.properties-changed', false, true],
    ];
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE agent_team_events (LIKE public.agent_team_events INCLUDING DEFAULTS) ON COMMIT DROP');
      for (const statement of statements(migration())) await tx.$executeRawUnsafe(statement);
      for (const [code, resolverAdmits, dbAdmits] of cases) {
        if (resolverAdmits) expect(() => requireAppActionCode('example:team', code)).not.toThrow();
        else expect(() => requireAppActionCode('example:team', code)).toThrow();
        await tx.$executeRawUnsafe('SAVEPOINT candidate');
        const write = tx.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, payload) VALUES (${generateId()}, 'migration-only', ${code}, '{}'::jsonb)`;
        if (dbAdmits) await expect(write).resolves.toBe(1);
        else await expect(write).rejects.toThrow(/chk_agent_team_events_shape/);
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT candidate');
      }
    });
  });

});
