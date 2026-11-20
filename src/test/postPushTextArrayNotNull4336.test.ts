/**
 * #4336 (#434 Slice C): the eleven text[] columns the migrations declare NOT NULL are NOT NULL on the push-built
 * schema too. `db push` renders a Prisma list field nullable, so prisma/post-push.sql restores the guarantee.
 * Two of them, user_api_keys.oauth_scopes and auth_codes.oauth_scopes, are spec-governed (cor:aut:010:02 rule 3: an
 * empty set means unscoped, only a set has meaning), so a NULL there must be refused, never read as "unscoped".
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const COLUMNS: Array<[string, string]> = [
  ['agent_tasks', 'unresolved_finding_ids'], ['agents', 'surfaces'], ['app_wake_reservations', 'absorbed_keys'],
  ['apps', 'surfaces'], ['auth_codes', 'oauth_scopes'], ['home_assistant_instances', 'op_allowlist'],
  ['host_registration_workers', 'worktrees'], ['mcp_servers', 'tool_allowlist'], ['rate_limit_manifests', 'key_ids'],
  ['tickers', 'reasons'], ['user_api_keys', 'oauth_scopes'],
];

describe('#4336 text[] columns are NOT NULL on the push-built schema', () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => { await client.end(); });

  it.each(COLUMNS)('%s.%s is NOT NULL', async (table, column) => {
    const { rows } = await client.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    expect(rows).toEqual([{ is_nullable: 'NO' }]);
  });

  it.each(['user_api_keys', 'auth_codes'])('a NULL oauth_scopes insert is refused on %s (cor:aut:010:02)', async (table) => {
    await client.query('BEGIN');
    try {
      // Relax every OTHER NOT NULL column (the id key aside, which the insert supplies) inside this rolled-back transaction, so the only constraint that can refuse the
      // row is the one under test (a missing sibling column would otherwise raise first and prove nothing).
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO' AND column_name NOT IN ('oauth_scopes', 'id')`,
        [table],
      );
      for (const { column_name } of rows) await client.query(`ALTER TABLE ${table} ALTER COLUMN "${column_name}" DROP NOT NULL`);
      await client.query('SAVEPOINT attempt');
      await expect(client.query(`INSERT INTO ${table} (id, oauth_scopes) VALUES ('pin4336', NULL)`)).rejects.toMatchObject({
        code: '23502', column: 'oauth_scopes',
      });
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      // The empty array stays a valid, distinct value: the one way to say "unscoped".
      await client.query(`INSERT INTO ${table} (id, oauth_scopes) VALUES ('pin4336', '{}')`);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
