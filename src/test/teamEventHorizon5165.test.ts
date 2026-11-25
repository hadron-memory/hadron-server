/** #5165: a horizon timeout names the transaction that held it; the passing path is unchanged. */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../integrations/db/client.js';
import { settleTeamEventHorizon } from './teamEventHorizon.js';

describe('#5165 settleTeamEventHorizon', () => {
  it('returns at once when nothing older is open', async () => {
    await expect(settleTeamEventHorizon(db, { budgetMs: 2000 })).resolves.toBeUndefined();
  });
  it('on timeout names the holder: pid, state and its last query', async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      await pg.query('BEGIN');
      const { rows } = await pg.query('SELECT pg_backend_pid() AS pid');
      await pg.query('SELECT pg_current_xact_id() /* horizon-holder-5165 */');
      const message = await settleTeamEventHorizon(db, { budgetMs: 300 }).then(() => '', (e: Error) => e.message);
      expect(message).toContain('an older transaction stayed open for');
      expect(message).toContain(`"pid":${rows[0].pid}`);
      expect(message).toContain('idle in transaction');
      expect(message).toContain('horizon-holder-5165');
      await pg.query('COMMIT');
      await expect(settleTeamEventHorizon(db, { budgetMs: 2000 })).resolves.toBeUndefined();
    } finally {
      await pg.query('ROLLBACK').catch(() => undefined);
      await pg.end();
    }
  }, 30000);
});
