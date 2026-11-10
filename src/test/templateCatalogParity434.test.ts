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

/** Every definition a re-applied DDL copy could change, keyed by object identity. */
const SNAPSHOT = `
  SELECT 'col:' || c.relname || '.' || a.attname AS k,
         format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
           || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' generated=' || a.attgenerated::text AS d
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'con:' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid) || ' validated=' || k.convalidated
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'idx:' || i.relname, pg_get_indexdef(i.oid) || ' valid=' || x.indisvalid
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = p.oid AND e.deptype = 'e')
  UNION ALL
  SELECT 'seq:' || sequencename, data_type::text || ' start=' || start_value || ' inc=' || increment_by
           || ' min=' || min_value || ' max=' || max_value || ' cycle=' || cycle
    FROM pg_sequences WHERE schemaname = 'public'
  UNION ALL
  SELECT 'view:' || viewname, definition FROM pg_views WHERE schemaname = 'public'
  UNION ALL
  SELECT 'tg:' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ORDER BY 1`;

type Snapshot = Map<string, string>;

async function snapshot(client: Client): Promise<Snapshot> {
  const { rows } = await client.query<{ k: string; d: string }>(SNAPSHOT);
  return new Map(rows.map((r) => [r.k, r.d]));
}

/** Normalize only SQL whitespace, preserving literals, quoted identifiers and comments byte-for-byte.
 * pg_get_functiondef wraps the source in AS $tag$...$tag$: that outer wrapper holds SQL to scan,
 * while any dollar-quoted value INSIDE the source is literal text and must stay exact.
 * This is deliberately conservative (including backslash escapes and comment formatting).
 */
function squash(d: string, functionDefinition = true): string {
  let out = '';
  for (let i = 0; i < d.length;) {
    const start = i;
    if (/\s/.test(d[i])) {
      while (i < d.length && /\s/.test(d[i])) i++;
      out += ' ';
    } else if (d[i] === "'" || d[i] === '"') {
      const quote = d[i++];
      const escaped = quote === "'" && /(?:^|[^A-Za-z_0-9$])E$/i.test(d.slice(0, start));
      while (i < d.length) {
        // Ordinary strings depend on standard_conforming_strings: keep the entire source exact rather than guess.
        if (d[i] === '\\' && quote === "'" && !escaped) return d;
        if (d[i] === '\\' && escaped) { i = Math.min(i + 2, d.length); continue; }
        if (d[i++] === quote) {
          if (d[i] === quote) { i++; continue; }
          break;
        }
      }
      out += d.slice(start, i);
    } else if (d.startsWith('--', i)) {
      const end = d.indexOf('\n', i);
      i = end < 0 ? d.length : end + 1;
      out += d.slice(start, i);
    } else if (d.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < d.length && depth > 0) {
        if (d.startsWith('/*', i)) { depth++; i += 2; }
        else if (d.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      out += d.slice(start, i);
    } else {
      const tag = d.slice(i).match(/^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*)?\$/)?.[0];
      const end = tag ? d.indexOf(tag, i + tag.length) : -1;
      if (tag && end >= 0) {
        const body = d.slice(i + tag.length, end);
        // Only the function's AS wrapper contains SQL; nested dollar strings are opaque.
        out += tag + (functionDefinition && /\bAS\s*$/i.test(out) ? squash(body, false) : body) + tag;
        i = end + tag.length;
      } else {
        out += d[i++];
      }
    }
  }
  return out.trim();
}

/**
 * Objects added, removed or redefined between two snapshots, one line each. A function whose body differs
 * ONLY in whitespace outside literals/comments is `reformatted`, not `changed`: Postgres stores an SQL function's body as written
 * (constraints, indexes and triggers are deparsed canonically, so they cannot differ that way), and a
 * copy indented inside a JS template literal differs from post-push.sql in nothing else. It is still
 * reported, never dropped.
 */
function diff(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [k, d] of before) {
    const a = after.get(k);
    if (a === undefined) out.push(`removed ${k}`);
    else if (a !== d) {
      const kind = k.startsWith('fn:') && squash(a) === squash(d) ? 'reformatted' : 'changed';
      out.push(`${kind} ${k}\n  before: ${d}\n  after:  ${a}`);
    }
  }
  for (const k of after.keys()) if (!before.has(k)) out.push(`added ${k}`);
  return out;
}

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
      await expect(closeScratch(undefined, failingAdmin, scratch)).rejects.toMatchObject({ code: '25001' });
    } finally {
      await failingAdmin.end().catch(() => {});
    }
    // The refused DROP leaves the scratch intact; the suite's afterAll still cleans it normally.
    expect(await snapshot(client)).toEqual(fresh);
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
    [String.raw`SELECT "a\" || "b  c";`, String.raw`SELECT "a\" || "b c";`],
    [String.raw`SELECT 'a\' || 'b  c';`, String.raw`SELECT 'a\' || 'b c';`],
  ])('classes a quoted-content whitespace change as changed: %s', (before, after) => {
    const wrap = (body: string) => `CREATE OR REPLACE FUNCTION public.literal2964() RETURNS text LANGUAGE sql AS $function$\n${body}\n$function$;`;
    expect(diff(new Map([['fn:literal2964()', wrap(before)]]), new Map([['fn:literal2964()', wrap(after)]]))[0]).toMatch(/^changed fn:literal2964/);
  });

  it('re-indents SQL following a line comment without changing the comment terminator', () => {
    const body = "CREATE FUNCTION x() RETURNS int LANGUAGE sql AS $function$\n-- comment\nSELECT 1;\n$function$;";
    expect(diff(new Map([['fn:x()', body]]), new Map([['fn:x()', body.replace(/\n/g, '\n    ')]]))[0]).toMatch(/^reformatted fn:x/);
  });

  it('still classes ordinary re-indentation outside literals as reformatted', () => {
    const body = "CREATE FUNCTION x() RETURNS text LANGUAGE sql AS $function$\nSELECT 'a  b';\n$function$;";
    expect(diff(new Map([['fn:x()', body]]), new Map([['fn:x()', body.replace(/\n/g, '\n    ')]]))[0]).toMatch(/^reformatted fn:x/);
  });
});
