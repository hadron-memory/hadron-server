/** #3449: execute the widening against empty and legacy-populated table shapes. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';

const migration = () => readFileSync(new URL('../../../prisma/migrations/20261104180000_app_action_event_codes/migration.sql', import.meta.url), 'utf8');
const legacy = ['app.properties-changed', 'app.credential-act', 'app.manager-act', 'tick.worker', 'app.letters', 'app.' + 'x'.repeat(65)];

describe('App action event CHECK migration', () => {
  it.each([false, true])('applies with legacy rows = %s without tightening prior types', async populated => {
    await db.$transaction(async tx => {
      // Same columns/defaults, isolated on this connection; no FK, trigger or public table mutation.
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE agent_team_events (LIKE public.agent_team_events INCLUDING DEFAULTS ${populated ? 'INCLUDING CONSTRAINTS' : ''}) ON COMMIT DROP`);
      const insert = (type: string) => tx.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, payload) VALUES (${generateId()}, 'migration-only', ${type}, '{}'::jsonb)`;
      if (populated) for (const type of legacy) await insert(type);
      for (const statement of migration().replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
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
});
