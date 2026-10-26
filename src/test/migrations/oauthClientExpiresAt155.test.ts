/**
 * #155: the expires_at backfill. Replays the migration's UPDATE verbatim (read
 * from the migration file) over a pre-migration state, then runs the GC at
 * deploy + 1 day and deploy + 40 days. The backfill counts from DEPLOY time:
 * a created_at-based one would collect every old client on the first run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { gcOauthClients } from '../../jobs/gcOauthClients.js';

const DAY = 24 * 60 * 60 * 1000;
const MIGRATION = new URL('../../../prisma/migrations/20261026040000_oauth_client_expires_at/migration.sql', import.meta.url);
const backfill = (() => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('UPDATE "oauth_clients"');
  if (start < 0) throw new Error('backfill UPDATE not found in the migration');
  return sql.slice(start, sql.indexOf(';', start) + 1);
})();

let pg: Client;
beforeEach(async () => {
  await cleanDb(db);
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
});
afterEach(async () => {
  await pg.end();
});

async function insert(clientId: string, createdDaysAgo: number, deleted = false): Promise<void> {
  // Pre-migration state: no expiry yet.
  await pg.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, updated_at, deleted_at, deleted_by, expires_at)
     VALUES ($1, $1, ARRAY['https://client.example/cb'], $2, $2, $3, $4, NULL)`,
    [clientId, new Date(Date.now() - createdDaysAgo * DAY), deleted ? new Date() : null, deleted ? 'admin' : null],
  );
}

const expiresAt = async (clientId: string) =>
  (await db.oAuthClient.findUniqueOrThrow({ where: { clientId } })).expiresAt;

describe('#155 expires_at backfill', () => {
  it('gives live DCR clients a full window from deploy and leaves the rest NULL', async () => {
    const old = `dcr_${'0'.repeat(31)}1`;
    const gone = `dcr_${'0'.repeat(31)}2`;
    await insert(old, 400);
    await insert(gone, 400, true);
    await insert('test', 400);
    await insert('dcrlookalike', 400); // no underscore after "dcr": not a DCR id

    const deployedAt = Date.now();
    await pg.query(backfill);

    const e = (await expiresAt(old))!;
    expect(Math.abs(e.getTime() - (deployedAt + 30 * DAY))).toBeLessThan(60_000);
    expect(await expiresAt(gone)).toBeNull();
    expect(await expiresAt('test')).toBeNull();
    expect(await expiresAt('dcrlookalike')).toBeNull();

    // The first GC runs cannot collect the 400-day-old client...
    const at1d = await gcOauthClients(db, { now: new Date(deployedAt + DAY), apply: true });
    expect(at1d.collected).toBe(0);
    // ...until its window and grace have passed with no redemption.
    const at40d = await gcOauthClients(db, { now: new Date(deployedAt + 40 * DAY), apply: true });
    expect(at40d.collected).toBe(1);
    expect((await db.oAuthClient.findUniqueOrThrow({ where: { clientId: old } })).deletedBy).toBe('system:gc');
    expect((await db.oAuthClient.findUniqueOrThrow({ where: { clientId: 'test' } })).deletedAt).toBeNull();
  });
});
