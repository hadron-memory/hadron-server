/**
 * #855: `app_runs.duration_ms` is a STORED GENERATED column that schema.prisma models as a plain nullable BigInt.
 *
 * What this file pins, on a scratch database built from empty the way `pnpm db:dev-setup` builds it:
 *   - push + post-push leave the column GENERATED (not the plain one Prisma makes) with its organization index;
 *   - a SECOND sync (pre-push, push, post-push: the dev-setup sequence) succeeds and leaves exactly that shape, which is
 *     what the pre-push file exists for: a bare `prisma db push` on the generated column fails, because Prisma reads the
 *     generation expression as a default and Postgres refuses to drop it;
 *   - the migration and post-push.sql carry the same generation expression (they are two copies of one definition).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseTestDbUrl, maintenanceUrl, quoteDbIdent, withDbName } from '../dbWorkers.js';
import { buildTestSchema } from '../schemaTemplate.js';

const execFileAsync = promisify(execFile);
const root = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(new URL(`../../../prisma/${p}`, import.meta.url), 'utf8');

const scratch = `hadron_test_dur855_${process.pid}_${randomBytes(4).toString('hex')}`;
let admin: Client;
let client: Client;
let url: string;

const shape = async () => {
  const col = await client.query<{ attgenerated: string; typ: string; expr: string | null }>(
    `SELECT a.attgenerated, format_type(a.atttypid, a.atttypmod) AS typ, pg_get_expr(d.adbin, d.adrelid) AS expr
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'app_runs'::regclass AND a.attname = 'duration_ms' AND NOT a.attisdropped`,
  );
  const idx = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'app_runs' AND indexname = 'app_runs_organization_id_duration_ms_idx'`,
  );
  return { col: col.rows, idx: idx.rows.map((r) => r.indexdef) };
};

describe('#855 app_runs.duration_ms survives the dev-setup sequence', () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteDbIdent(scratch)} TEMPLATE template0`);
    url = withDbName(baseTestDbUrl(), scratch);
    await buildTestSchema(url);
    client = new Client({ connectionString: url });
    await client.connect();
  }, 300_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    try {
      await admin?.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(scratch)} WITH (FORCE)`);
    } finally {
      await admin?.end().catch(() => {});
    }
  });

  it('a fresh build leaves a STORED GENERATED bigint with the (organization_id, duration_ms) index', async () => {
    const s = await shape();
    expect(s.col).toHaveLength(1);
    expect(s.col[0].attgenerated).toBe('s');
    expect(s.col[0].typ).toBe('bigint');
    expect(s.idx).toHaveLength(1);
    expect(s.idx[0]).toMatch(/\(organization_id, duration_ms\)/);
  });

  it('a bare `prisma db push` on the generated column fails (why pre-push.sql drops it first)', async () => {
    await expect(
      execFileAsync(`${root}node_modules/.bin/prisma`, ['db', 'push', '--skip-generate', '--accept-data-loss'], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
        maxBuffer: 64 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/duration_ms.*generated column/s) });
  }, 120_000);

  it('a second pre-push, push, post-push sequence succeeds and leaves the same shape', async () => {
    const before = await shape();
    await buildTestSchema(url);
    expect(await shape()).toEqual(before);
  }, 180_000);

  it('the migration and post-push.sql carry the same generation expression', () => {
    const expr = /GENERATED ALWAYS AS \(\((round\(EXTRACT\(EPOCH FROM \(\s*"?finished_at"?\s*-\s*"?started_at"?\s*\)\) \* 1000\))\)::bigint\) STORED/i;
    const norm = (m: RegExpMatchArray | null) => m?.[1].replace(/"/g, '').replace(/\s+/g, ' ');
    const mig = norm(read('migrations/20261124020000_app_runs_duration_ms/migration.sql').match(expr));
    const post = norm(read('post-push.sql').match(expr));
    expect(mig).toBe('round(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)');
    expect(post).toBe(mig);
  });
});
