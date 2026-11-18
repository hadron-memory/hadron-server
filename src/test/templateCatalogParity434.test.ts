/**
 * #434 Slice A: the test template needs no DDL beyond post-push.sql.
 *
 * Since #1922 every test template is built from EMPTY by `buildTestSchema` (pre-push.sql, `prisma db
 * push`, post-push.sql through psql). globalSetup used to re-issue its own partial copy of post-push.sql
 * on each run's template, so any definition in that copy that differed from post-push.sql silently
 * overrode the truth on every test run. Before deleting it, this file measured it (commit 0a1c95d6): on
 * a freshly built template the copy changed no column, constraint, index, sequence, view, function or
 * trigger, except that its `hadron_nodes_tsv` body was post-push.sql's text indented six spaces
 * (reported on the issue). The copy is gone; what stays is the catalog comparator with its controls,
 * and a guard that the global setup carries no DDL again.
 *
 * The comparator's controls run on a fresh scratch template, each in a rolled-back transaction:
 * re-issuing a post-push CHECK with its own definition changes nothing, re-issuing it with an altered
 * definition is reported by name, and a re-indented function body is reported as reformatted.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { baseTestDbUrl, maintenanceUrl, quoteDbIdent, withDbName } from './dbWorkers.js';
import { buildTestSchema } from './schemaTemplate.js';
import { diff, snapshot, type Snapshot } from './catalogSnapshot.js';

/** Run `fn` on `client` inside a transaction that is always rolled back; return the catalog diff it made. */
async function diffInRolledBackTx(client: Client, base: Snapshot, fn: () => Promise<void>): Promise<string[]> {
  await client.query('BEGIN');
  try {
    await fn();
    return diff(base, await snapshot(client));
  } finally {
    await client.query('ROLLBACK');
  }
}

async function closeScratch(client: Client | undefined, admin: Client | undefined, database: string): Promise<void> {
  await client?.end().catch(() => {});
  try {
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(database)} WITH (FORCE)`);
  } finally {
    await admin?.end().catch(() => {});
  }
}

const scratch = `hadron_test_parity434_${process.pid}_${randomBytes(4).toString('hex')}`;
let admin: Client;
let client: Client;
let fresh: Snapshot;

describe('#434 the template catalog comparator (fresh template, rolled-back controls)', () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteDbIdent(scratch)} TEMPLATE template0`);
    const url = withDbName(baseTestDbUrl(), scratch);
    await buildTestSchema(url);
    client = new Client({ connectionString: url });
    await client.connect();
    fresh = await snapshot(client);
  }, 300_000);

  afterAll(async () => {
    await closeScratch(client, admin, scratch);
    // DROP DATABASE of a full schema can take well past the 10s default hook
    // timeout when the whole suite is loading the server (seen at 8c8b3149).
  }, 120_000);

  it('snapshots a non-trivial catalog', () => {
    for (const kind of ['col:', 'con:', 'idx:', 'fn:', 'tg:']) {
      expect([...fresh.keys()].filter((k) => k.startsWith(kind)).length, kind).toBeGreaterThan(10);
    }
    expect(fresh.has('seq:git_mirror_attempt_seq')).toBe(true);
  });

  it('control: re-issuing a post-push CHECK with its own definition changes nothing', async () => {
    const def = fresh.get('con:memories.chk_memory_chunk_tokens_positive')!.replace(/ validated=true$/, '');
    expect(def).toMatch(/^CHECK /);
    const changes = await diffInRolledBackTx(client, fresh, async () => {
      await client.query(`ALTER TABLE memories DROP CONSTRAINT chk_memory_chunk_tokens_positive`);
      await client.query(`ALTER TABLE memories ADD CONSTRAINT chk_memory_chunk_tokens_positive ${def}`);
    });
    expect(changes).toEqual([]);
  });

  it('control: a drifted CHECK is reported by name', async () => {
    const changes = await diffInRolledBackTx(client, fresh, async () => {
      await client.query(`ALTER TABLE memories DROP CONSTRAINT chk_memory_chunk_tokens_positive`);
      await client.query(`ALTER TABLE memories ADD CONSTRAINT chk_memory_chunk_tokens_positive CHECK (chunk_tokens IS NULL OR chunk_tokens > 1)`);
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^changed con:memories\.chk_memory_chunk_tokens_positive\n/);
  });

  it('#2964 control: a real failed DROP is surfaced (DROP inside a transaction)', async () => {
    const failingAdmin = new Client({ connectionString: maintenanceUrl() });
    await failingAdmin.connect();
    try {
      await failingAdmin.query('BEGIN');
    } catch (error) {
      await failingAdmin.end().catch(() => {});
      throw error;
    }
    // Never target the live suite database, even if BEGIN were accidentally removed.
    // PostgreSQL checks active_sql_transaction (25001) before looking up this nonexistent database.
    // closeScratch owns failingAdmin from here and ends it exactly once, including on the refused DROP.
    await expect(closeScratch(undefined, failingAdmin, `${scratch}_never_created`)).rejects.toMatchObject({ code: '25001' });
  });

  it('#2964 control: a real SQL literal whitespace change is changed', async () => {
    await client.query('BEGIN');
    try {
      await client.query("CREATE FUNCTION public.literal2964() RETURNS text LANGUAGE sql AS $$ SELECT 'a  b'::text $$");
      const before = await snapshot(client);
      await client.query("CREATE OR REPLACE FUNCTION public.literal2964() RETURNS text LANGUAGE sql AS $$ SELECT 'a b'::text $$");
      const changes = diff(before, await snapshot(client));
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatch(/^changed fn:literal2964/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('control: a function body that differs only in whitespace is reported as reformatted, not changed', async () => {
    const body = fresh.get('fn:hadron_nodes_tsv(p_name text, p_alias text, p_loc text, p_tags text[], p_description text, p_abstract text, p_content text, p_properties text, p_data text)')!;
    const changes = await diffInRolledBackTx(client, fresh, async () => {
      await client.query(body.replace(/\n/g, '\n    '));
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^reformatted fn:hadron_nodes_tsv\(/);
  });
});

/**
 * The template's DDL has one source, post-push.sql, applied by `buildTestSchema`. A second copy in the
 * vitest global setup is what this issue removed: it ran after the template and overrode post-push.sql
 * wherever the two differed, on every test run.
 */
describe('#434 the vitest global setup applies no DDL of its own', () => {
  const source = readFileSync(new URL('./globalSetup.ts', import.meta.url), 'utf8');

  it('issues no schema DDL', () => {
    const ddl = source.match(/\b(ALTER TABLE|CREATE (OR REPLACE |UNIQUE )?(INDEX|FUNCTION|TRIGGER|SEQUENCE)|DROP (CONSTRAINT|INDEX|TRIGGER|FUNCTION))\b/g) ?? [];
    expect(ddl).toEqual([]);
  });

  it('reads no prisma/*.sql file (a string literal naming one; prose may still cite post-push.sql)', () => {
    expect(source.match(/prisma\/[\w.-]+\.sql['"`]/g) ?? []).toEqual([]);
  });
});

/** #2964: the comparator must distinguish literal changes and surface a failed scratch drop. */
describe('#2964 comparator safety controls', () => {
  it('surfaces a failed scratch drop while still ending both clients', async () => {
    const failure = new Error('forced scratch DROP failure');
    const endClient = vi.fn().mockRejectedValue(new Error('client already closed'));
    const endAdmin = vi.fn().mockRejectedValue(new Error('admin already closed'));
    const query = vi.fn().mockRejectedValue(failure);
    await expect(closeScratch({ end: endClient } as unknown as Client, { query, end: endAdmin } as unknown as Client, 'hadron_test_parity434_forced')).rejects.toBe(failure);
    expect(query).toHaveBeenCalledWith('DROP DATABASE IF EXISTS "hadron_test_parity434_forced" WITH (FORCE)');
    expect(endClient).toHaveBeenCalledOnce();
    expect(endAdmin).toHaveBeenCalledOnce();
  });

  it.each([
    ["SELECT 'a  b';", "SELECT 'a b';"],
    ["SELECT 'a\n  b';", "SELECT 'a\n b';"],
    ['SELECT $text$a  b$text$;', 'SELECT $text$a b$text$;'],
    ['SELECT $é$a  b$é$;', 'SELECT $é$a b$é$;'],
    ["SELECT 'a''  b';", "SELECT 'a'' b';"],
    ['SELECT "a  b";', 'SELECT "a b";'],
    [String.raw`SELECT E'a\'  b';`, String.raw`SELECT E'a\' b';`],
    [String.raw`SELECT 'a\'  b';`, String.raw`SELECT 'a\' b';`], // valid escapes with standard_conforming_strings=off
    ["SELECT E'a''  b';", "SELECT E'a'' b';"],
    [String.raw`SELECT U&'a\0020  b';`, String.raw`SELECT U&'a\0020 b';`],
    ['AS $nested$a  b$nested$;', 'AS $nested$a b$nested$;'],
    ["EXECUTE $query$SELECT 'a  b'$query$;", "EXECUTE $query$SELECT 'a b'$query$;"],
    [String.raw`SELECT "a\" || "b  c";`, String.raw`SELECT "a\" || "b c";`],
    [String.raw`SELECT 'a\' || 'b  c';`, String.raw`SELECT 'a\' || 'b c';`],
  ])('classifies a quoted-content whitespace change as changed: %s', (before, after) => {
    const wrap = (body: string) => `CREATE OR REPLACE FUNCTION public.literal2964() RETURNS text LANGUAGE sql AS $function$\n${body}\n$function$;`;
    expect(diff(new Map([['fn:literal2964()', wrap(before)]]), new Map([['fn:literal2964()', wrap(after)]]))[0]).toMatch(/^changed fn:literal2964/);
  });

  it.each([
    ['-- comment  text\nSELECT 1;', '-- comment text\nSELECT 1;'],
    ['/* outer /* inner  text */ end */ SELECT 1;', '/* outer /* inner text */ end */ SELECT 1;'],
  ])('keeps comment contents exact, including nested block comments: %s', (before, after) => {
    const wrap = (body: string) => `CREATE FUNCTION x() RETURNS int LANGUAGE sql AS $function$\n${body}\n$function$;`;
    expect(diff(new Map([['fn:x()', wrap(before)]]), new Map([['fn:x()', wrap(after)]]))[0]).toMatch(/^changed fn:x/);
  });

  it('re-indents SQL following a line comment without changing the comment terminator', () => {
    const body = "CREATE FUNCTION x() RETURNS int LANGUAGE sql AS $function$\n-- comment\nSELECT 1;\n$function$;";
    expect(diff(new Map([['fn:x()', body]]), new Map([['fn:x()', body.replace(/\n/g, '\n    ')]]))[0]).toMatch(/^reformatted fn:x/);
  });

  it('still classifies ordinary re-indentation outside literals as reformatted', () => {
    const body = "CREATE FUNCTION x() RETURNS text LANGUAGE sql AS $function$\nSELECT 'a  b';\n$function$;";
    expect(diff(new Map([['fn:x()', body]]), new Map([['fn:x()', body.replace(/\n/g, '\n    ')]]))[0]).toMatch(/^reformatted fn:x/);
  });
});
