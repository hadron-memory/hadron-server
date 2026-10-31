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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** Collapse whitespace runs: a function body is kept as written, so indentation alone can differ. */
const squash = (d: string) => d.replace(/\s+/g, ' ').trim();

/**
 * Objects added, removed or redefined between two snapshots, one line each. A function whose body differs
 * ONLY in whitespace is `reformatted`, not `changed`: Postgres stores an SQL function's body as written
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
    await client?.end().catch(() => {});
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(scratch)} WITH (FORCE)`).catch(() => {});
    await admin?.end().catch(() => {});
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
