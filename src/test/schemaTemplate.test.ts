/**
 * #1922 — a test template is built for one schema version, from empty, and
 * never reused for another. The failure this replaces was two-sided (Chip's
 * reproduction): an older branch's push dropped a newer branch's columns, and
 * left the newer branch's trigger functions behind. The second half is why
 * these pins plant a stale FUNCTION and TRIGGER, not just a column.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { Client } from 'pg';
import { cpSync, mkdtempSync, mkdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintenanceUrl, withDbName, quoteDbIdent, parseWorkerDbName } from './dbWorkers.js';
import {
  schemaFingerprint,
  schemaTemplateDbName,
  parseSchemaTemplateDbName,
  templateStamp,
  parseTemplateStamp,
  staleSchemaTemplates,
  ensureSchemaTemplate,
  assertBaseMatchesSchema,
  rebuildBaseTestDb,
  TEMPLATE_MAX_IDLE_MS,
} from './schemaTemplate.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Unique per run so concurrent suites never share these databases.
const BASE = `hadron_t1922_${process.pid}`;
const created: string[] = [];
const tmpDirs: string[] = [];

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: maintenanceUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function onDb<T>(name: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: withDbName(maintenanceUrl(), name) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function routineExists(db: string, name: string): Promise<boolean> {
  return onDb(db, async (c) => (await c.query('SELECT 1 FROM pg_proc WHERE proname = $1', [name])).rowCount === 1);
}

/** Plant what an older or newer branch's setup would leave behind. */
async function plantStaleObjects(db: string): Promise<void> {
  await onDb(db, (c) =>
    c.query(`
      CREATE TABLE IF NOT EXISTS zz_stale_rows (id int);
      CREATE OR REPLACE FUNCTION zz_stale_trigger_fn() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NEW; END $$;
      DROP TRIGGER IF EXISTS zz_stale_trigger ON zz_stale_rows;
      CREATE TRIGGER zz_stale_trigger BEFORE INSERT ON zz_stale_rows
        FOR EACH ROW EXECUTE FUNCTION zz_stale_trigger_fn();
    `),
  );
}

/** A copy of the inputs the fingerprint reads, to edit without touching the checkout. */
function copyInputs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hadron-1922-'));
  tmpDirs.push(dir);
  cpSync(join(ROOT, 'prisma'), join(dir, 'prisma'), {
    recursive: true,
    filter: (src) => !src.includes(`${join('prisma', 'migrations')}`),
  });
  mkdirSync(join(dir, 'node_modules/prisma'), { recursive: true });
  cpSync(join(ROOT, 'node_modules/prisma/package.json'), join(dir, 'node_modules/prisma/package.json'));
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(async () => {
  await admin(async (c) => {
    const { rows } = await c.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${BASE}%`],
    );
    for (const { datname } of [...rows, ...created.map((datname) => ({ datname }))]) {
      await c.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(datname)} WITH (FORCE)`);
    }
  });
});

describe('schemaFingerprint (#1922)', () => {
  it('is stable for unchanged inputs', () => {
    const dir = copyInputs();
    expect(schemaFingerprint(dir)).toBe(schemaFingerprint(dir));
    expect(schemaFingerprint(dir)).toBe(schemaFingerprint(ROOT));
  });

  it('changes when schema.prisma changes', () => {
    const dir = copyInputs();
    const before = schemaFingerprint(dir);
    appendFileSync(join(dir, 'prisma/schema.prisma'), '\n// edit\n');
    expect(schemaFingerprint(dir)).not.toBe(before);
  });

  it('changes when a trigger file post-push includes changes, not only on columns', () => {
    const dir = copyInputs();
    const before = schemaFingerprint(dir);
    appendFileSync(join(dir, 'prisma/host-operation-invariants.sql'), '\n-- edit\n');
    expect(schemaFingerprint(dir)).not.toBe(before);
  });

  it('changes when a new .sql file appears', () => {
    const dir = copyInputs();
    const before = schemaFingerprint(dir);
    writeFileSync(join(dir, 'prisma/zz-new-invariants.sql'), 'SELECT 1;\n');
    expect(schemaFingerprint(dir)).not.toBe(before);
  });

  it('changes with the Prisma CLI version', () => {
    const dir = copyInputs();
    const before = schemaFingerprint(dir);
    writeFileSync(join(dir, 'node_modules/prisma/package.json'), JSON.stringify({ version: '0.0.0-other' }));
    expect(schemaFingerprint(dir)).not.toBe(before);
  });
});

describe('schema template names and stamps (#1922)', () => {
  it('round-trips, and never parses as a worker or legacy clone', () => {
    // An all-digit fingerprint is the case a sloppy shape would misread.
    for (const fp of ['0123456789abcdef', '1234567890123456']) {
      const name = schemaTemplateDbName(fp, 'hadron_test');
      expect(parseSchemaTemplateDbName(name, 'hadron_test')).toBe(fp);
      expect(parseWorkerDbName(name, 'hadron_test')).toBeNull();
    }
    expect(parseSchemaTemplateDbName('hadron_test_r123_1', 'hadron_test')).toBeNull();
    expect(parseSchemaTemplateDbName('hadron_test_s0123456789abcdef_build', 'hadron_test')).toBeNull();
    expect(parseSchemaTemplateDbName('other_s0123456789abcdef', 'hadron_test')).toBeNull();
  });

  it('parses its own stamp and nothing else', () => {
    expect(parseTemplateStamp(templateStamp('abc123', 42))).toEqual({ fingerprint: 'abc123', usedAt: 42 });
    expect(parseTemplateStamp(null)).toBeNull();
    expect(parseTemplateStamp('some dba note')).toBeNull();
  });

  it('selects only other fingerprints idle past the limit, and unstamped leftovers', () => {
    const now = 10 * TEMPLATE_MAX_IDLE_MS;
    const fp = (c: string) => c.repeat(16);
    const dbs = [
      { datname: `b_s${fp('a')}`, comment: templateStamp(fp('a'), 0) }, // current: kept however old
      { datname: `b_s${fp('b')}`, comment: templateStamp(fp('b'), now - TEMPLATE_MAX_IDLE_MS - 1) }, // stale
      { datname: `b_s${fp('c')}`, comment: templateStamp(fp('c'), now - 1000) }, // recently used: kept
      { datname: `b_s${fp('d')}`, comment: null }, // unstamped: dropped
      { datname: 'b_r1_1', comment: null }, // a worker clone: not ours
      { datname: 'b', comment: null }, // the base: not ours
    ];
    expect(staleSchemaTemplates(dbs, 'b', fp('a'), now)).toEqual([`b_s${fp('b')}`, `b_s${fp('d')}`]);
  });
});

// Each case builds a whole schema (~5s idle, much longer under a full parallel
// suite), far past vitest's 5s default.
const BUILD_TIMEOUT = { timeout: 120_000 };

describe('ensureSchemaTemplate (#1922)', BUILD_TIMEOUT, () => {
  it('builds from EMPTY: the base database contents never reach the template', async () => {
    // The base is what other checkouts used to push over; plant a stale
    // trigger there, as an older or newer branch's setup would leave it.
    await admin((c) => c.query(`CREATE DATABASE ${quoteDbIdent(BASE)}`));
    await plantStaleObjects(BASE);

    const name = await admin((c) => ensureSchemaTemplate(c, BASE));
    expect(name).toBe(schemaTemplateDbName(schemaFingerprint(), BASE));
    expect(await routineExists(name, 'zz_stale_trigger_fn')).toBe(false);
    // ...and it does carry this checkout's raw-SQL objects (a host-operation trigger function).
    expect(await routineExists(name, 'host_operation_forward_only')).toBe(true);
    const comment = await onDb(name, async (c) =>
      (await c.query(`SELECT shobj_description(oid, 'pg_database') AS c FROM pg_database WHERE datname = current_database()`)).rows[0].c,
    );
    expect(parseTemplateStamp(comment)?.fingerprint).toBe(schemaFingerprint());
  });

  it('reuses its own fingerprint and builds a separate template for another', async () => {
    const current = schemaFingerprint();
    const existing = schemaTemplateDbName(current, BASE);
    // Mark the existing template so a rebuild would be visible.
    await plantStaleObjects(existing);

    const again = await admin((c) => ensureSchemaTemplate(c, BASE));
    expect(again).toBe(existing);
    expect(await routineExists(existing, 'zz_stale_trigger_fn')).toBe(true);

    const other = await admin((c) => ensureSchemaTemplate(c, BASE, { fingerprint: 'f'.repeat(16) }));
    expect(other).not.toBe(existing);
    expect(await routineExists(other, 'zz_stale_trigger_fn')).toBe(false);
    // Building another version's template leaves this one untouched.
    expect(await routineExists(existing, 'zz_stale_trigger_fn')).toBe(true);
  });

  it('discards a half-built leftover instead of finishing it', async () => {
    const fp = 'e'.repeat(16);
    const building = `${schemaTemplateDbName(fp, BASE)}_build`;
    await admin((c) => c.query(`CREATE DATABASE ${quoteDbIdent(building)}`));
    await plantStaleObjects(building);

    const name = await admin((c) => ensureSchemaTemplate(c, BASE, { fingerprint: fp }));
    expect(await routineExists(name, 'zz_stale_trigger_fn')).toBe(false);
    const leftover = await admin((c) => c.query('SELECT 1 FROM pg_database WHERE datname = $1', [building]));
    expect(leftover.rowCount).toBe(0);
  });
});

describe('serial mode base (#1922)', BUILD_TIMEOUT, () => {
  const serial = `${BASE}_serialtest`;

  it('refuses an unstamped base, rebuilds it from empty, then accepts it', async () => {
    await admin((c) => c.query(`CREATE DATABASE ${quoteDbIdent(serial)}`));
    await plantStaleObjects(serial);
    await expect(onDb(serial, (c) => assertBaseMatchesSchema(c))).rejects.toThrow(/db:test-setup/);

    const fp = await rebuildBaseTestDb(withDbName(maintenanceUrl(), serial));
    expect(fp).toBe(schemaFingerprint());
    expect(await routineExists(serial, 'zz_stale_trigger_fn')).toBe(false);
    expect(await routineExists(serial, 'host_operation_forward_only')).toBe(true);
    await expect(onDb(serial, (c) => assertBaseMatchesSchema(c))).resolves.toBeUndefined();
  });

  it('refuses a base stamped for another schema', async () => {
    await expect(onDb(serial, (c) => assertBaseMatchesSchema(c, '0'.repeat(16)))).rejects.toThrow(
      /built for schema/,
    );
  });

  it('refuses to wipe a database whose name is not a test database', async () => {
    await expect(rebuildBaseTestDb('postgresql://holger@localhost:5432/hadron')).rejects.toThrow(
      /Refusing to rebuild "hadron"/,
    );
  });
});
