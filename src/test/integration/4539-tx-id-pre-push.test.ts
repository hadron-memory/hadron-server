/**
 * #4539: `prisma db push` cannot make `agent_team_events.tx_id` required over legacy NULL rows ("Made the column `tx_id`
 * on table `agent_team_events` required, but there are 2 existing NULL values", observed by the author), so the
 * non-wiping `pnpm db:dev-setup` aborted on a push-synced database from between #4084 and #4111. pre-push.sql must do the
 * migration's backfill itself, with the same #4111 contract A2 care (ACCESS EXCLUSIVE first, one trigger by name, row
 * images compared), and be a no-op everywhere else.
 *
 * Pinned from the real files: the migration's backfill body is carried byte for byte, pre-push.sql includes the new
 * file, the legacy shape is backfilled (NULL to '0', every other column and every trigger state unchanged), and the
 * block does nothing on a fresh schema, a migrated database, a nullable column with no NULL row, or a second run. A
 * trigger that is not enabled at the start stops the block and leaves the rows NULL.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const read = (path: string) => readFileSync(new URL(`../../../prisma/${path}`, import.meta.url), 'utf8');
const BLOCK_FILE = 'agent-team-event-tx-id-pre-push.sql';
const MIGRATION = read('migrations/20261113180000_agent_team_event_tx_id_not_null/migration.sql');

/** The migration's backfill from its writer-lock check to the end of its DO block: the part that must be carried verbatim. */
const carried = (sql: string) => sql.match(/^ {2}IF NOT EXISTS \(SELECT 1 FROM pg_locks[\s\S]*?^\$backfill\$;/m)?.[0];

async function withPg<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let appId: string;
const tableImage = async () => (await db.$queryRaw<{ r: string }[]>`SELECT e::text AS r FROM agent_team_events e ORDER BY id`).map((x) => x.r);
const triggerImage = async () =>
  (await db.$queryRaw<{ t: string }[]>`
    SELECT tgname::text || '=' || tgenabled::text AS t FROM pg_trigger WHERE tgrelid = 'agent_team_events'::regclass ORDER BY tgname`).map((x) => x.t);
/** Every column but tx_id, per row: what the backfill must leave byte-identical. */
const imageWithoutKey = async () =>
  (await db.$queryRaw<{ r: string }[]>`SELECT (to_jsonb(e) - 'tx_id')::text AS r FROM agent_team_events e ORDER BY id`).map((x) => x.r);
const nullable = async () =>
  (await db.$queryRaw<{ n: boolean }[]>`
    SELECT NOT attnotnull AS n FROM pg_attribute WHERE attrelid = 'agent_team_events'::regclass AND attname = 'tx_id'`)[0].n;

async function addEvent(txId: string | null): Promise<string> {
  const id = generateId();
  await db.$executeRaw`
    INSERT INTO agent_team_events (id, app_id, type, payload, tx_id)
    VALUES (${id}, ${appId}, 'task.assigned', '{"type":"task.assigned"}'::jsonb, ${txId}::xid8)`;
  return id;
}
const txOf = async (id: string) => (await db.$queryRaw<{ k: string | null }[]>`SELECT tx_id::text AS k FROM agent_team_events WHERE id = ${id}`)[0].k;

/** The legacy shape #4084 left: a nullable key column holding two NULL rows beside a keyed one. */
async function legacy() {
  await db.$executeRawUnsafe('ALTER TABLE agent_team_events ALTER COLUMN tx_id DROP NOT NULL');
  return { a: await addEvent(null), keyed: await addEvent('77'), b: await addEvent(null) };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'txp-org', urn: 'txp-org' } });
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'txp-app', urn: 'txp-org:txp-app' } })).id;
});

describe('#4539 the pre-push counterpart of the tx_id NOT NULL backfill', () => {
  it('carries the migration backfill byte for byte, and pre-push.sql includes the file', () => {
    const block = carried(read(BLOCK_FILE));
    expect(block).toBeTruthy();
    expect(block).toBe(carried(MIGRATION));
    expect(read('pre-push.sql')).toMatch(/^\\ir agent-team-event-tx-id-pre-push\.sql$/m);
  });

  it('backfills the legacy NULL keys to 0, changes nothing else, and leaves every trigger as it was', async () => {
    const ids = await legacy();
    const triggers = await triggerImage();
    const before = await imageWithoutKey();
    await withPg((c) => c.query(read(BLOCK_FILE)));
    expect([await txOf(ids.a), await txOf(ids.keyed), await txOf(ids.b)]).toEqual(['0', '77', '0']);
    expect(await triggerImage()).toEqual(triggers);
    expect(await imageWithoutKey()).toEqual(before); // every column but tx_id is unchanged
    expect(await nullable()).toBe(true); // making it required is `prisma db push`'s step, not this block's
  });

  it('is a no-op on a second run', async () => {
    await legacy();
    await withPg((c) => c.query(read(BLOCK_FILE)));
    const after = await tableImage();
    await withPg((c) => c.query(read(BLOCK_FILE)));
    expect(await tableImage()).toEqual(after);
  });

  it('is a no-op on a migrated database (column already NOT NULL, rows keyed)', async () => {
    await addEvent('5');
    const image = await tableImage();
    const triggers = await triggerImage();
    await withPg((c) => c.query(read(BLOCK_FILE)));
    expect(await tableImage()).toEqual(image);
    expect(await triggerImage()).toEqual(triggers);
  });

  it('is a no-op on a nullable column that holds no NULL row (it does not touch the trigger)', async () => {
    await db.$executeRawUnsafe('ALTER TABLE agent_team_events ALTER COLUMN tx_id DROP NOT NULL');
    await addEvent('9');
    const image = await tableImage();
    await withPg((c) => c.query(read(BLOCK_FILE)));
    expect(await tableImage()).toEqual(image);
  });

  it('returns before touching the trigger when no NULL row exists (even a disabled trigger raises nothing)', async () => {
    await db.$executeRawUnsafe('ALTER TABLE agent_team_events ALTER COLUMN tx_id DROP NOT NULL');
    await addEvent('9');
    await db.$executeRawUnsafe('ALTER TABLE agent_team_events DISABLE TRIGGER agent_team_event_append_only');
    const triggers = await triggerImage();
    await withPg((c) => c.query(read(BLOCK_FILE)));
    expect(await triggerImage()).toEqual(triggers);
  });

  it('is a no-op on a schema with no agent_team_events table (a fresh database)', async () => {
    const schema = `txp_empty_${generateId().replaceAll('-', '').toLowerCase()}`;
    await withPg(async (c) => {
      await c.query(`CREATE SCHEMA "${schema}"`);
      try {
        await c.query(`SET search_path TO "${schema}"`);
        await expect(c.query(read(BLOCK_FILE))).resolves.toBeDefined();
      } finally {
        await c.query('RESET search_path');
        await c.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    });
  });

  it('refuses when the append-only trigger is not enabled at the start: the rows stay NULL and the trigger stays as found', async () => {
    const ids = await legacy();
    await db.$executeRawUnsafe('ALTER TABLE agent_team_events DISABLE TRIGGER agent_team_event_append_only');
    const triggers = await triggerImage();
    await expect(withPg((c) => c.query(read(BLOCK_FILE)))).rejects.toThrow(/T3: agent_team_event_append_only is not enabled/);
    expect([await txOf(ids.a), await txOf(ids.b)]).toEqual([null, null]);
    expect(await triggerImage()).toEqual(triggers);
  });
});
