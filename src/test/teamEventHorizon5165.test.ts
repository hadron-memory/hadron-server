/**
 * #5165: a horizon timeout names the transaction that held it; the passing path is unchanged. The horizon is
 * instance-wide, so nothing here may depend on the cluster being quiet: the wait's shape is pinned with a stub
 * client, and the one real-database test holds its own transaction open and asserts only what that guarantees.
 */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../integrations/db/client.js';
import { settleTeamEventHorizon } from './teamEventHorizon.js';

/** A stub client answering the helper's queries by their SQL text; `seen` records them. */
function client(script: { done: boolean; holders?: Array<Record<string, unknown>> | Error }) {
  const seen: string[] = [];
  const $queryRaw = (async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    seen.push(sql);
    if (sql.includes('pg_current_xact_id')) return [{ x: '100' }];
    if (sql.includes('pg_snapshot_xmin')) return [{ done: script.done }];
    if (script.holders instanceof Error) throw script.holders;
    return script.holders ?? [];
  }) as never;
  return { db: { $queryRaw } as Pick<typeof db, '$queryRaw'>, seen };
}

describe('#5165 settleTeamEventHorizon', () => {
  it('returns as soon as the horizon has passed, without listing holders', async () => {
    const c = client({ done: true });
    await expect(settleTeamEventHorizon(c.db, { budgetMs: 1000 })).resolves.toBeUndefined();
    expect(c.seen.some(s => s.includes('pg_stat_activity'))).toBe(false);
  });
  it('on timeout throws the same one-line shape plus the listed holders', async () => {
    const c = client({ done: false, holders: [{ pid: 4242, state: 'idle in transaction', query: 'SELECT 1 /* holder */' }] });
    const message = await settleTeamEventHorizon(c.db, { budgetMs: 120 }).then(() => '', (e: Error) => e.message);
    expect(message).toMatch(/^team event horizon: an older transaction stayed open for \d+ seconds; holders: /);
    expect(message).toContain('"pid":4242');
    expect(message).toContain('idle in transaction');
    expect(message).toContain('holder');
  });
  it('says so when no holder is visible, and when the lookup itself fails (the wait error still surfaces)', async () => {
    expect(await settleTeamEventHorizon(client({ done: false }).db, { budgetMs: 60 }).then(() => '', (e: Error) => e.message))
      .toContain('holders: none visible in pg_stat_activity');
    expect(await settleTeamEventHorizon(client({ done: false, holders: new Error('denied') }).db, { budgetMs: 60 }).then(() => '', (e: Error) => e.message))
      .toContain('holders: holder lookup failed: denied');
  });
  it('real database: with our own transaction held open and no budget left, it throws and the holder query itself runs', async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      await pg.query('BEGIN');
      await pg.query('SELECT pg_current_xact_id()');
      // The holder began before the helper takes its xact id, so the horizon cannot have passed it, on any cluster.
      const message = await settleTeamEventHorizon(db, { budgetMs: 0 }).then(() => '', (e: Error) => e.message);
      expect(message).toContain('an older transaction stayed open for');
      expect(message).toContain('holders: ');
      expect(message).not.toContain('holder lookup failed');
    } finally {
      await pg.query('ROLLBACK').catch(() => undefined);
      await pg.end();
    }
  }, 30000);
});
