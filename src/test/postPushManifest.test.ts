/**
 * #434 slice B — the post-push manifest contract.
 *
 * Four fences, one per failure mode the slice exists to close:
 *
 * 1. The parser pin (fixture): every object kind the inventory claims to
 *    extract IS extracted, and decoys (dollar-quoted payloads, comment text,
 *    strings, guard drops, \ir'd files) are not. This is the mutant control:
 *    a parser change that silently skips a kind fails here.
 * 2. Completeness, both directions (real corpus): every durable object the
 *    prisma/post-push.sql closure creates has a post-push-owned manifest row,
 *    and every manifest row names something the closure actually creates. A
 *    new object without a row is red; a stale row is red. The parser also
 *    refuses to leave any statement unrecognized — a new object KIND (say,
 *    CREATE POLICY) is red until the parser is taught it and the object gets
 *    its row.
 * 3. The workflow parity: the drift filter is wired into the migration-smoke
 *    lane, the lane runs on manifest edits, and no whitelisted object name
 *    survives as a hand-written grep in the workflow (the manifest is the
 *    only home for the whitelist).
 * 4. The executed filter (spawn): the script is RUN, not just text-checked —
 *    it drops a whitelisted line exactly (CRLF-stripped first), keeps a
 *    superstring of a whitelisted line (same line, changed definition) as
 *    drift, and exits 1 on an invalid manifest. These pin the two
 *    load-bearing behaviors no text check can: a substring-match mutant and
 *    an exit-0 mutant both survived 13/13 at 5b2c6fee (the LOCAL review's
 *    P2 — both mutants are killed by the spawn cases below).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync, rmSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// eslint-disable-next-line import/no-relative-packages -- scripts/ is outside src/ by design; plain node ESM
import { postPushInventory, classify } from '../../scripts/db/postPushInventory.mjs';
// eslint-disable-next-line import/no-relative-packages
import { loadManifest, whitelistedLines, ManifestError } from '../../scripts/db/postPushManifest.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST_PATH = join(repoRoot, 'prisma/post-push-manifest.json');
const ENTRY = join(repoRoot, 'prisma/post-push.sql');
const WORKFLOW = join(repoRoot, '.github/workflows/migration-smoke-test.yml');
const FIXTURE = join(repoRoot, 'src/test/testdata/post-push-fixture/main.sql');
const I_ENTRY = join(repoRoot, 'src/test/testdata/post-push-fixture/i-entry.sql');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const identity = (o: { kind: string; name: string }) => `${o.kind}:${o.name}`;

describe('#434 slice B: the manifest exists and validates', () => {
  it('prisma/post-push-manifest.json loads and passes contract validation', () => {
    expect(existsSync(MANIFEST_PATH), 'manifest committed next to post-push.sql').toBe(true);
    const m = loadManifest(MANIFEST_PATH);
    expect(m.diffWhitelist.length).toBeGreaterThan(0);
    expect(m.postPushOwned.length).toBeGreaterThan(0);
    for (const row of [...m.diffWhitelist, ...m.postPushOwned]) {
      expect(row.why, `${row.kind}:${row.name} carries a why`).toMatch(/\S/);
    }
  });

  it('validation refuses unknown keys, unknown kinds, duplicate lines and missing whys', () => {
    const base = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const bad = (mutate: (m: any) => void) => {
      const m = JSON.parse(JSON.stringify(base));
      mutate(m);
      // mkdtemp, never a fixed path inside the repo: parallel workers must not
      // collide and a crashed run must leave nothing behind.
      const dir = mkdtempSync(join(tmpdir(), 'post-push-manifest-invalid-'));
      try {
        const tmp = join(dir, 'manifest.json');
        writeFileSync(tmp, JSON.stringify(m));
        expect(() => loadManifest(tmp)).toThrow(ManifestError);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    bad((m) => { m['unknown-key'] = true; });
    bad((m) => { m['diff-whitelist'][0].kind = 'not-a-kind'; });
    bad((m) => { m['diff-whitelist'][1].line = m['diff-whitelist'][0].line; });
    bad((m) => { delete m['post-push-owned'][0].why; });
    bad((m) => { delete m['diff-whitelist'][0].line; });
  });
});

describe('#434 slice B: the parser pin (mutant control)', () => {
  it('extracts exactly the fixture inventory — every kind, no decoys', () => {
    const inv = postPushInventory(FIXTURE);
    expect(inv.unrecognized, 'every fixture statement is classified').toEqual([]);
    const got = inv.objects.map(identity).sort();
    expect(got).toEqual([
      'check-constraint:fixture_chk',
      'check-constraint:fixture_do_chk', // DO block, plain-string EXECUTE ('' unescaped)
      'check-constraint:fixture_escape_chk', // E-string with \' and , inside — action split survives
      'check-constraint:fixture_multi_a', // multi-action ALTER: first object …
      'check-constraint:fixture_qualified_chk', // schema-qualified ALTER TABLE public.x
      'check-constraint:fixture_readd_chk', // idempotent DROP IF EXISTS + ADD in one statement
      'extension:vector',
      'foreign-key-constraint:fixture_fk',
      'function:fixture_fn', // public. prefix normalized away (default search_path)
      'generated-column:fixture_books.lower_id',
      'index:fixture_comment_sep_idx', // a block comment between keywords does not join tokens
      'index:fixture_include_rel_idx', // via \include_relative with a trailing comment
      'index:fixture_included_idx', // via \ir include.sql — includes are followed
      'index:fixture_nested_comment_idx', // inside a nested /* /* */ */ comment: one comment
      'index:fixture_plain_idx',
      'sequence:fixture_seq',
      'table:fixture_books',
      'trigger:fixture_books.fixture_ctrig', // CREATE CONSTRAINT TRIGGER, identity is table.name
      'trigger:fixture_books.fixture_trig',
      'unique-constraint:fixture_escape_uq', // … and the E-string statement's second object
      'unique-constraint:fixture_multi_b',
      'unique-constraint:fixture_uq',
      'unique-index:fixture_do_idx', // DO block, dollar-quoted EXECUTE (the chat-seq idiom)
      'unique-index:fixture_uniq_idx',
    ]);
    // The decoys must not appear under any identity.
    const flat = got.join('\n');
    expect(flat).not.toContain('decoy');
  });

  it('\\i resolves against the working directory and is followed (psql semantics)', () => {
    // Unlike \ir/\include_relative (resolved against the including file), \i
    // is cwd-relative — the fixture's path is repo-root-relative. chdir to the
    // repo root around the call so the test holds under any vitest --root.
    const cwd = process.cwd();
    process.chdir(repoRoot);
    try {
      const inv = postPushInventory(I_ENTRY);
      expect(inv.unrecognized).toEqual([]);
      expect(inv.objects.map(identity)).toEqual(['index:fixture_i_included_idx']);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('#434 slice B: the parser refuses what it cannot name (classify probes)', () => {
  // Direct classify() calls pin the REFUSALS: shapes that must surface as
  // unrecognized, never silently vanish. (The old vacuous ALTER fallback —
  // the BLIND review's P2-1 — made exactly that class of shape a silent
  // non-object.)
  const refusals = (sql: string, payloads?: string) =>
    classify({ sql, ...(payloads === undefined ? {} : { payloads }) }).filter((c) => 'unrecognized' in c);

  it('a trigger without an ON table is unrecognized, not silently dropped', () => {
    expect(refusals('CREATE TRIGGER orphan_trig AFTER INSERT EXECUTE FUNCTION fixture_fn()')).toHaveLength(1);
  });

  it('an unguarded plain ADD COLUMN is unrecognized (it cannot re-run)', () => {
    expect(refusals('ALTER TABLE fixture_books ADD COLUMN plain_col text')).toHaveLength(1);
  });

  it('an ALTER action the parser cannot name is unrecognized', () => {
    // EXCLUDE constraints: teach the parser here before whitelisting one.
    expect(refusals('ALTER TABLE fixture_books ADD CONSTRAINT fixture_ex EXCLUDE USING gist (id WITH =)')).toHaveLength(1);
    expect(refusals('ALTER TABLE fixture_books INHERIT parent_tbl')).toHaveLength(1);
  });

  it('bare DDL inside a DO body (not EXECUTE-extracted) refuses the whole block', () => {
    const body = "BEGIN ALTER TABLE fixture_books ADD CONSTRAINT bare_chk CHECK (id <> ''); END";
    expect(refusals('DO $do$ BEGIN … END $do$;', body)).toHaveLength(1);
  });

  it('an unfollowed, un-allowlisted psql meta-command surfaces as unrecognized', () => {
    expect(refusals('\\copy fixture_books TO stdout')).toHaveLength(1);
  });

  it('an odd-shaped include meta the scanner could not follow is unrecognized (N1)', () => {
    // The scanner pushes these as statements precisely so they cannot vanish;
    // classify must not swallow them back (an unfollowed include means the
    // file's objects are missing from the inventory — always red).
    expect(refusals('\\ir my file.sql')).toHaveLength(1); // unquoted path with a space
    expect(refusals('\\i a.sql extra')).toHaveLength(1); // trailing junk
    expect(refusals('\\ir "unterminated')).toHaveLength(1); // unterminated quote
  });

  it('a guarded ADD COLUMN with an inline constraint or identity refuses (N2)', () => {
    // The skew-repair carve-out is for PLAIN columns only: an inline
    // CHECK/REFERENCES/UNIQUE/identity creates objects Prisma does not
    // introspect, invisible to both fences if silently skipped.
    expect(refusals('ALTER TABLE fixture_books ADD COLUMN IF NOT EXISTS c int CHECK (c > 0)')).toHaveLength(1);
    expect(refusals('ALTER TABLE fixture_books ADD COLUMN IF NOT EXISTS o int REFERENCES other (id)')).toHaveLength(1);
    expect(refusals('ALTER TABLE fixture_books ADD COLUMN IF NOT EXISTS c bigint GENERATED BY DEFAULT AS IDENTITY')).toHaveLength(1);
  });

  it('GENERATED ALWAYS AS IDENTITY is not a STORED generated column', () => {
    // The generated-column branch requires `GENERATED ALWAYS AS (`; the
    // identity spelling has no paren and must refuse, never label.
    const out = classify({ sql: 'ALTER TABLE fixture_books ADD COLUMN IF NOT EXISTS c bigint GENERATED ALWAYS AS IDENTITY' });
    expect(out.filter((c) => 'unrecognized' in c)).toHaveLength(1);
  });

  it('renames and identity-adding actions refuse (they change inventoried identity)', () => {
    // RENAME CONSTRAINT/COLUMN leaves the manifest naming the old identity;
    // RENAME TO moves the table itself; ALTER COLUMN ADD GENERATED attaches
    // an identity sequence. None may pass as benign maintenance.
    expect(refusals('ALTER TABLE fixture_books RENAME COLUMN id TO id2')).toHaveLength(1);
    expect(refusals('ALTER TABLE fixture_books RENAME CONSTRAINT fixture_chk TO fixture_chk2')).toHaveLength(1);
    expect(refusals('ALTER TABLE fixture_books RENAME TO fixture_books2')).toHaveLength(1);
    // #4337: the identity is now an inventoried object, but ONLY in its plain spelling. Syntax trailing the identity
    // action itself (sequence options) still refuses, since the row would not describe it.
    expect(refusals('ALTER TABLE fixture_books ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 5)')).toHaveLength(1);
    // A separate, comma-delimited action is classified on its own: both objects are named, neither is dropped
    // (#4691 BLIND F3).
    expect(classify({ sql: 'ALTER TABLE fixture_books ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY, ADD CONSTRAINT x CHECK (id > 0)' }))
      .toEqual([{ kind: 'identity-column', name: 'fixture_books.id' }, { kind: 'check-constraint', name: 'x' }]);
  });

  it('#4337: a plain ADD GENERATED ... AS IDENTITY is an identity-column object named table.column', () => {
    expect(classify({ sql: 'ALTER TABLE fixture_books ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY' }))
      .toMatchObject([{ kind: 'identity-column', name: 'fixture_books.id' }]);
    expect(classify({ sql: 'ALTER TABLE fixture_books ALTER id ADD GENERATED ALWAYS AS IDENTITY' }))
      .toMatchObject([{ kind: 'identity-column', name: 'fixture_books.id' }]);
  });

  it('function signatures normalize: balanced arg lists whole, param names and DEFAULTs stripped', () => {
    // (Brooks P3-4) `numeric(10,2)` must survive intact — the old
    // `\(([^)]*)\` capture truncated at the first `)` — and a parameter NAME
    // must not turn `fn(a text)` into a different signature from `fn(text)`.
    const f = (sql: string) => {
      const out = classify({ sql });
      expect(out, sql).toHaveLength(1);
      const entry = out[0];
      if (!('args' in entry) || entry.kind !== 'function') throw new Error('not a function classification');
      return entry.args;
    };
    expect(f('CREATE FUNCTION sig_fn(p_a numeric(10,2), p_b text DEFAULT \'x\') RETURNS void LANGUAGE sql AS $$ SELECT 1 $$')).toBe('numeric(10, 2), text');
    // The same signature with a space inside the parens: ONE identity, never
    // a false overload (structural whitespace is canonicalized away).
    expect(f('CREATE FUNCTION sig_fn(numeric(10, 2), text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$')).toBe('numeric(10, 2), text');
    expect(f('CREATE OR REPLACE FUNCTION public.sig_fn(IN a integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$')).toBe('integer');
  });

  it('a true overload (same name, two arg lists) throws instead of merging', () => {
    // The inventory cannot tell two same-named functions apart by name: it
    // must refuse loudly, never silently merge them into one row.
    const dir = mkdtempSync(join(tmpdir(), 'post-push-overload-'));
    try {
      const sql = join(dir, 'overload.sql');
      writeFileSync(sql, [
        "CREATE FUNCTION ol_fn(a text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;",
        "CREATE FUNCTION ol_fn(a numeric) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;",
      ].join('\n'));
      expect(() => postPushInventory(sql)).toThrow(/two argument lists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#434 slice B: the delta2 folds — the last silently-vanishes paths (Brooks A1–A7)', () => {
  const refusals = (sql: string, payloads?: string) =>
    classify({ sql, ...(payloads === undefined ? {} : { payloads }) }).filter((c) => 'unrecognized' in c);

  it('an odd-shaped \\ir is not FOLLOWED as a bare path, and surfaces unrecognized (A1)', () => {
    // `(?<bare>\\S+)` once matched the unterminated quote itself, so the
    // scanner tried to read a file literally named `"unterminated` (an
    // ENOENT, or worse a lucky hit) instead of refusing the line. The bare
    // alternative may not start with a quote.
    const dir = mkdtempSync(join(tmpdir(), 'post-push-a1-'));
    try {
      const main = join(dir, 'main.sql');
      writeFileSync(main, '\\ir "unterminated\nCREATE INDEX a1_idx ON fixture_books (id);\n');
      const inv = postPushInventory(main);
      expect(inv.unrecognized).toHaveLength(1);
      expect(inv.unrecognized[0].sql).toContain('\\ir "unterminated');
      expect(inv.objects.map((o) => o.name)).toContain('a1_idx'); // the rest of the file still parses
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a DO whose payload was never captured (a plain-string body) refuses (A3)', () => {
    // The scanner carries plain-string and E-string DO bodies in the
    // statement text, not in `payloads`: whatever DDL hides in that string is
    // invisible to the EXECUTE extraction, so the block must not pass as a
    // recognized non-object.
    expect(refusals("DO 'BEGIN EXECUTE ''CREATE INDEX i ON t (c)''; END'")).toHaveLength(1);
    expect(refusals("DO E'BEGIN PERFORM 1; END'")).toHaveLength(1);
  });

  it('a nested DO anywhere in an EXECUTE payload refuses, not only when it leads (A3)', () => {
    // `SET …; DO $$…$$` inside one EXECUTE string: the nested block's own
    // payload cannot be captured here, wherever in the string it sits.
    expect(refusals('DO $do$ … $do$;', 'EXECUTE $x$SET LOCAL foo = 1; DO $y$ BEGIN PERFORM 1; END $y$$x$')).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "EXECUTE 'SET LOCAL foo = 1; DO $$ BEGIN PERFORM 1; END $$'")).toHaveLength(1);
  });

  it('DO-remainder DDL refuses across object kinds the old noun list never named (A4)', () => {
    // CREATE EVENT TRIGGER / ALTER COLLATION / DROP PUBLICATION are none of
    // TABLE|INDEX|CONSTRAINT|…: the old bigram list was allow-by-default
    // inside DO bodies. Any verb+word left after extraction now refuses.
    expect(refusals('DO $do$ … $do$;', 'BEGIN CREATE EVENT TRIGGER guard ON DDL_COMMAND_START EXECUTE FUNCTION f(); END')).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', 'BEGIN ALTER COLLATION c REFRESH VERSION; END')).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', 'BEGIN DROP PUBLICATION pub; END')).toHaveLength(1);
  });

  it('DDL-shaped prose inside strings does not false-positive the remainder rule (A4)', () => {
    // "refusing to create the index twice" is RAISE prose: strings are
    // blanked before the remainder test, so it stays a recognized non-object.
    expect(classify({ sql: 'DO $do$ … $do$;', payloads: "BEGIN RAISE NOTICE 'refusing to create the index twice'; END" })).toEqual([]);
  });

  it("an apostrophe inside a dollar-quoted message cannot stick the comment stripper open (A4)", () => {
    // $m$can't$m$ once left the lexer 'inside a string', so a LATER comment
    // survived stripping and its commented-out EXECUTE came back as a
    // phantom inventory row — a drift name whitelisted for an object that
    // does not exist.
    const payloads = "BEGIN RAISE NOTICE $m$can't$m$; -- EXECUTE 'CREATE INDEX old_idx ON fixture_books (id)'\nEND";
    const out = classify({ sql: 'DO $do$ … $do$;', payloads });
    expect(out).toEqual([]);
  });

  it("an E-string's backslash-escaped quote keeps the stripper's pairing (A4)", () => {
    // The escaped quote once CLOSED the string early, so the real closer
    // re-opened it and the next line's commented-out EXECUTE survived as a
    // phantom row.
    const payloads = "BEGIN PERFORM notice(E'can\\'t');\n-- EXECUTE 'CREATE INDEX old_e_idx ON fixture_books (id)'\nEND";
    expect(classify({ sql: 'DO $do$ … $do$;', payloads })).toEqual([]);
  });

  it('ALTER … ADD GENERATED without the COLUMN keyword is never benign (A5)', () => {
    // #4337: the plain spelling is now the identity-column object; with sequence options it still refuses.
    expect(classify({ sql: 'ALTER TABLE fixture_books ALTER id ADD GENERATED BY DEFAULT AS IDENTITY' }))
      .toMatchObject([{ kind: 'identity-column', name: 'fixture_books.id' }]);
    expect(refusals('ALTER TABLE fixture_books ALTER id ADD GENERATED BY DEFAULT AS IDENTITY (INCREMENT BY 2)')).toHaveLength(1);
  });

  it('SET SCHEMA refuses (the RENAME-TO class); other SETs stay benign (A5)', () => {
    expect(refusals('ALTER TABLE fixture_books SET SCHEMA archived')).toHaveLength(1);
    expect(refusals('ALTER TABLE fixture_books SET (autovacuum_enabled = false)')).toHaveLength(0);
  });

  it('a generated column with an inline clause after the expression refuses; AS( without a space parses (A6)', () => {
    expect(refusals("ALTER TABLE fixture_books ADD COLUMN c text GENERATED ALWAYS AS (lower(id)) STORED CHECK (c <> '')")).toHaveLength(1);
    const ok = classify({ sql: 'ALTER TABLE fixture_books ADD COLUMN c text GENERATED ALWAYS AS(lower(id)) STORED' });
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ kind: 'generated-column', name: 'fixture_books.c' });
  });
});

describe('#434 slice B: the delta3 folds — DDL in strings must not vanish (Brooks B1–B7)', () => {
  const refusals = (sql: string, payloads?: string) =>
    classify({ sql, ...(payloads === undefined ? {} : { payloads }) }).filter((c) => 'unrecognized' in c);

  it('DDL inside string shapes the EXECUTE extractor misses refuses (B1)', () => {
    // String-blanking the remainder alone made every dynamic-SQL shape the
    // extractor cannot capture — format(), assign-then-EXECUTE, E'…' — pass
    // as []: the DDL was in a string, and the new rule made strings
    // invisible. The old verb+noun bigram on the RAW remainder is the second
    // disjunct that sees it again.
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON t (c)', n); END")).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "BEGIN v := 'CREATE UNIQUE INDEX i ON t (c)'; EXECUTE v; END")).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE E'CREATE INDEX i ON t (c)'; END")).toHaveLength(1);
  });

  it('ON CONFLICT DO NOTHING inside an EXECUTEd statement is not a nested DO (B3)', () => {
    // The old \\bDO\\b test refused this common payload; only a
    // statement-leading DO is payload-in-payload.
    expect(classify({ sql: 'DO $do$ … $do$;', payloads: "BEGIN EXECUTE 'INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING'; END" })).toEqual([]);
  });

  it('ALTER COLUMN with a quoted name containing spaces is never benign for ADD GENERATED (B2)', () => {
    // \\S+ stopped at the space inside "my col" and the action fell through
    // to benign ALTER; the verb pair is the anchor now.
    // #4337: the plain spelling is now the identity-column object, named with the whole quoted column; with sequence
    // options it still refuses.
    expect(classify({ sql: 'ALTER TABLE fixture_books ALTER COLUMN "my col" ADD GENERATED BY DEFAULT AS IDENTITY' }))
      .toMatchObject([{ kind: 'identity-column', name: 'fixture_books.my col' }]);
    expect(refusals('ALTER TABLE fixture_books ALTER COLUMN "my col" ADD GENERATED BY DEFAULT AS IDENTITY (CACHE 10)')).toHaveLength(1);
  });

  it('a column constraint BEFORE the generation expression refuses too (B4)', () => {
    // Postgres accepts column constraints in any order; the lazy capture
    // absorbed the CHECK and the row named the column, losing the constraint.
    // The positive case pins BOTH directions in one assertion (delta5 D2):
    // exactly one row, and it IS the generated column — a regression to []
    // (row lost) or to a refusal (over-refusal) both fail it.
    expect(refusals("ALTER TABLE fixture_books ADD COLUMN c text CHECK (c <> '') GENERATED ALWAYS AS (lower(id)) STORED")).toHaveLength(1);
    expect(classify({ sql: 'ALTER TABLE fixture_books ADD COLUMN c text GENERATED ALWAYS AS (lower(id)) STORED' })).toMatchObject([{ kind: 'generated-column', name: 'fixture_books.c' }]);
  });

  it('block comments in DO payloads are stripped — no token-joining hole, no prose hit (B5)', () => {
    expect(refusals('DO $do$ … $do$;', 'BEGIN CREATE/**/INDEX b5_idx ON t (c); END')).toHaveLength(1);
    expect(classify({ sql: 'DO $do$ … $do$;', payloads: 'BEGIN /* we create a fresh one */ PERFORM 1; END' })).toEqual([]);
  });

  it('a double-quoted identifier containing an apostrophe is not a string opener (B6)', () => {
    // Without identifier tracking, the apostrophe in "o'brien" opened a
    // phantom string that could keep a later comment alive (phantom row) or
    // blank real DDL out of the code-only remainder. The refuse-side probe
    // uses CREATE STATISTICS — DDL only the code-only rule catches, so the
    // bigram cannot mask a stripPayloadStrings mutant (delta4 C3).
    const payloads = 'BEGIN PERFORM notice("o\'brien");\n-- EXECUTE \'CREATE INDEX b6_idx ON fixture_books (id)\'\nEND';
    expect(classify({ sql: 'DO $do$ … $do$;', payloads })).toEqual([]);
    expect(refusals('DO $do$ … $do$;', "BEGIN PERFORM notice(\"o'brien\"); CREATE STATISTICS b6_st ON a, b FROM fixture_books; END")).toHaveLength(1);
  });

  it('comments inside a dollar-quoted EXECUTE reach classify stripped (B7)', () => {
    // Dollar spans copy verbatim through the stripper, so the EXECUTE'd
    // SQL's own comment would sit in front of classify's ^-anchored heads.
    const out = classify({ sql: 'DO $do$ … $do$;', payloads: 'EXECUTE $x$-- why\nCREATE INDEX b7_idx ON fixture_books (id)$x$' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'index', name: 'b7_idx' });
  });
});

describe('#434 slice B: the delta4 folds — a leftover EXECUTE is unanalyzable (Brooks C1–C5)', () => {
  const refusals = (sql: string, payloads?: string) =>
    classify({ sql, ...(payloads === undefined ? {} : { payloads }) }).filter((c) => 'unrecognized' in c);

  it('DDL the bigram noun list never named still refuses inside uncaptured EXECUTE shapes (C1)', () => {
    // The two refusal layers disagreed on scope: CREATE STATISTICS (or
    // EVENT TRIGGER, PUBLICATION, …) in code-only text was caught by the
    // broad rule, but the same DDL inside a format() string was invisible —
    // the bigram reads strings but only knows its nouns. Any EXECUTE left
    // after both extraction loops is a shape the extractor cannot capture:
    // refuse it outright.
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE format('CREATE STATISTICS c1_st ON a, b FROM t'); END")).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE format('CREATE %s ON t (c)', 'INDEX'); END")).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE format('CREATE/**/INDEX c1c_idx ON t (c)'); END")).toHaveLength(1);
  });

  it('a concatenated EXECUTE literal is loud via the extracted fragment (C1 note)', () => {
    // The extractor consumes `EXECUTE 'CREATE '`; the bare fragment
    // classifies to a refusal — loud, never silent — and the leftover
    // concatenation carries no DDL of its own.
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE 'CREATE ' || 'INDEX c1d_idx ON t (c)'; END")).toHaveLength(1);
  });

  it('RAISE prose with an article stays clean; verb+noun prose is the accepted loud hit (C5)', () => {
    expect(classify({ sql: 'DO $do$ … $do$;', payloads: "BEGIN RAISE NOTICE 'refusing to create the index twice'; END" })).toEqual([]);
    expect(refusals('DO $do$ … $do$;', "BEGIN RAISE NOTICE 'will create index on %'; END")).toHaveLength(1);
  });

  it('a plain-string EXECUTE with its own comments strips them, like the dollar path (C4)', () => {
    // The outer stripper sees a plain-string payload as string CONTENT, so
    // the payload's own comments survived into classify — a comment-led
    // CREATE INDEX was a loud refusal instead of an inventory row, and a
    // /*c*/-led DO escaped the nested-DO guard.
    const out = classify({ sql: 'DO $do$ … $do$;', payloads: "BEGIN EXECUTE '-- why\nCREATE INDEX c4_idx ON fixture_books (id)'; END" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'index', name: 'c4_idx' });
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE '/*c*/ DO $$ BEGIN PERFORM 1; END $$'; END")).toHaveLength(1);
  });
});

describe('#434 slice B: the delta5 folds — a partially captured EXECUTE is unanalyzable (Brooks D1–D4)', () => {
  const refusals = (sql: string, payloads?: string) =>
    classify({ sql, ...(payloads === undefined ? {} : { payloads }) }).filter((c) => 'unrecognized' in c);

  it('an EXECUTE literal glued to || refuses — the tail escapes every other layer (D1)', () => {
    // The plain loop consumed `EXECUTE 'SELECT 1; '`, classified the fragment
    // clean, and the replace hid the verb: the concatenated DDL was then
    // blanked from the code-only text and the bigram does not know
    // STATISTICS. Silent, in both the plain and dollar spellings.
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE 'SELECT 1; ' || 'CREATE STATISTICS d1_st ON a, b FROM t'; END")).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "EXECUTE $x$SELECT 1;$x$ || 'CREATE STATISTICS d1b_st ON a, b FROM t'")).toHaveLength(1);
  });

  it('a bare fragment classifies to a refusal, never a malformed row (D1 note, #4381 E2)', () => {
    // E2: the glued shape never reaches classify — the D1 guard refuses the
    // block first — so the old body was a third copy of the D1 probe and
    // pinned nothing its name claimed. Assert the bare fragment directly:
    // a head with no name must fall through to unrecognized (loud), not emit
    // a malformed row.
    expect(refusals('CREATE INDEX ')).toEqual([{ unrecognized: 'CREATE INDEX' }]);
    // The glued-variable shape stays pinned here (refused via the D1 guard,
    // which is what this copy actually exercises).
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE 'CREATE INDEX ' || n; END")).toHaveLength(1);
  });

  it('GRANT EXECUTE ON in a DO body is a privilege, not dynamic SQL (D3)', () => {
    // The conditional grant is a common migration idiom; the privilege
    // spelling is always `EXECUTE ON` and never carries DDL, so it must
    // keep passing as a recognized non-object.
    expect(classify({ sql: 'DO $do$ … $do$;', payloads: 'BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $$reader$$) THEN GRANT EXECUTE ON FUNCTION fixture_fn TO reader; END IF; END' })).toEqual([]);
  });
});

describe('#4381: the plain-loop guard reads the match\'s own string; implicit literal continuation (E1, E3)', () => {
  const refusals = (sql: string, payloads?: string) =>
    classify({ sql, ...(payloads === undefined ? {} : { payloads }) }).filter((c) => 'unrecognized' in c);

  it('a consumed plain EXECUTE before the glued one still refuses (E1)', () => {
    // The plain loop rewrites `remainder` after every extraction, but the
    // matchAll snapshot keeps the original indices: from the second match on,
    // the glued check sliced the MUTATED string at the ORIGINAL index, missed
    // the ||, and consumed the glued EXECUTE — the block classified clean.
    // Silent on main (0 refusals, probed); the guard must read m.input.
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE 'SELECT 1;'; EXECUTE 'SELECT 2; ' || 'CREATE STATISTICS e1_st ON a, b FROM t'; END")).toHaveLength(1);
  });

  it('an implicit literal continuation across a newline refuses (E3)', () => {
    // Postgres concatenates adjacent QUOTED literals across whitespace
    // holding a newline: the same partial capture with no || at all. The
    // forward guard must treat a following quote as glued. The dollar-spelled
    // second assertion is NOT valid concatenation in Postgres (dollar-quoted
    // strings do not take implicit continuation) — it is refused
    // conservatively, and the pin locks that in. CRLF included.
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE 'SELECT 1; '\n'CREATE STATISTICS e3_st ON a, b FROM t'; END")).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "EXECUTE $x$SELECT 1;$x$\n'CREATE STATISTICS e3b_st ON a, b FROM t'")).toHaveLength(1);
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE 'SELECT 1; '\r\n'CREATE STATISTICS e3c_st ON a, b FROM t'; END")).toHaveLength(1);
  });

  it('a statement-separator follower is not a continuation (E3 boundary)', () => {
    // `;` after the literal ends the statement — the next quote starts a new
    // one (a plain EXECUTE the loop must still consume and classify, not a
    // glued tail). Guards against the forward test over-matching.
    expect(refusals('DO $do$ … $do$;', "BEGIN EXECUTE 'SELECT 1;'; EXECUTE 'SELECT 2'; END")).toHaveLength(0);
  });
});

describe('#4382: comments cannot separate a continuation; dollar-path, position and duplicate edges', () => {
  const refusals = (sql: string, payloads?: string) =>
    classify({ sql, ...(payloads === undefined ? {} : { payloads }) }).filter((c) => 'unrecognized' in c);
  const W = 'DO $do$ … $do$;';

  it('a comment between the literals still refuses, as the whole DO statement', () => {
    // The DO body is comment-stripped before either EXECUTE loop runs, so a
    // `-- note`⏎ or `/* x */` between the literals becomes whitespace by the
    // time the guard reads the gap: the adjacent literal is an implicit
    // continuation and the block refuses. The assertion names the refusal's
    // source — the whole DO statement, exactly one — so a bypass of the
    // stripper (the comment surviving into the gap) fails here instead of
    // being refused by whichever later layer trips first.
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1; ' -- note\n'CREATE STATISTICS c1_st ON a, b FROM t'; END")).toEqual([{ unrecognized: W }]);
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1; ' /* x */ 'CREATE STATISTICS c2_st ON a, b FROM t'; END")).toEqual([{ unrecognized: W }]);
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1; ' /* x */\n'CREATE STATISTICS c3_st ON a, b FROM t'; END")).toEqual([{ unrecognized: W }]);
    expect(refusals(W, "EXECUTE $x$SELECT 1;$x$ -- note\n'CREATE STATISTICS c4_st ON a, b FROM t'")).toEqual([{ unrecognized: W }]);
  });

  it('a plain-string DO body refuses as the whole statement before any EXECUTE loop — comment text in it changes nothing', () => {
    // The plain-string DO route: the scanner carries the body in the
    // statement text, `payloads` stays empty, and the block refuses before
    // any EXECUTE loop runs — comment text inside it (which the outer
    // stripper would treat as string content anyway) changes nothing. The
    // refusal text is the statement with classify's whitespace flattening
    // (every run, newlines included, becomes one space).
    const stmt = "DO 'BEGIN EXECUTE ''SELECT 1; '' -- note\n''CREATE STATISTICS c5_st ON a, b FROM t''; END'";
    expect(refusals(stmt)).toEqual([
      { unrecognized: "DO 'BEGIN EXECUTE ''SELECT 1; '' -- note ''CREATE STATISTICS c5_st ON a, b FROM t''; END'" },
    ]);
  });

  it('a consumed dollar EXECUTE before a glued one still refuses (dollar path)', () => {
    // The dollar loop's matchAll runs over `body`, which is never reassigned,
    // so m.input === body there: reading m.input instead of `body` is a
    // no-op on that path and E1 cannot exist in the dollar spelling — locked
    // by pinning the shape anyway. Mixed orderings included.
    expect(refusals(W, "BEGIN EXECUTE $a$SELECT 1;$a$; EXECUTE $b$SELECT 2;$b$ || 'CREATE STATISTICS p1_st ON a, b FROM t'; END")).toEqual([{ unrecognized: W }]);
    expect(refusals(W, "BEGIN EXECUTE $a$SELECT 1;$a$; EXECUTE 'SELECT 2; ' || 'CREATE STATISTICS p2_st ON a, b FROM t'; END")).toEqual([{ unrecognized: W }]);
  });

  it('the glued EXECUTE refuses from any position (third place)', () => {
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1'; EXECUTE 'SELECT 2'; EXECUTE 'SELECT 3; ' || 'CREATE STATISTICS p3_st ON a, b FROM t'; END")).toEqual([{ unrecognized: W }]);
  });

  it('identical EXECUTE texts: replace-by-text stays correct', () => {
    // `remainder.replace(m[0], ' ')` blanks the first REMAINING occurrence,
    // which is always this iteration's match while earlier identical matches
    // are already blanked — so duplicates cannot double-refuse or go silent.
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1'; EXECUTE 'SELECT 1'; END")).toHaveLength(0);
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1'; EXECUTE 'SELECT 1' || 'CREATE STATISTICS p4_st ON a, b FROM t'; END")).toEqual([{ unrecognized: W }]);
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1' || 'CREATE STATISTICS p5_st ON a, b FROM t'; EXECUTE 'SELECT 1'; END")).toEqual([{ unrecognized: W }]);
    // The one shape where text-replace blanks the WRONG copy: an earlier
    // `\b`-shadowed spelling (`vfooEXECUTE` — no word boundary, never a
    // match) contains this match's text, so the replace blanks inside it and
    // the real EXECUTE stays standing in the code-only text. The catch-all
    // then refuses the block — the mis-blank can only over-refuse, never go
    // silent, which is why replace-by-text needs no index arithmetic.
    expect(refusals(W, "BEGIN vfooEXECUTE 'SELECT 1'; EXECUTE 'SELECT 1'; END")).toEqual([{ unrecognized: W }]);
  });

  it('USING and format() followers are not continuations (boundary)', () => {
    // `USING` between the literal and the next quote is the bind list, not a
    // concatenation — clean. format(...) is never captured by the literal
    // loop, so the C1 leftover rule refuses it (intended, not over-match).
    expect(refusals(W, "BEGIN EXECUTE 'SELECT 1' USING 'y'; END")).toHaveLength(0);
    expect(refusals(W, "BEGIN PERFORM 1; EXECUTE format('SELECT %s', 1); END")).toHaveLength(1);
  });

  it('a || glued BEFORE the literal refuses — the backward half of isGlued', () => {
    // The guard's contract is both sides (delta5 D1); this half had no pin.
    // The shape is contrived as SQL — a concatenation cannot really precede
    // the EXECUTE verb in plpgsql — but the analyzer's contract is textual,
    // and dropping the backward half of isGlued must turn this pin red.
    expect(refusals(W, "BEGIN v := 'SELECT 1; ' || EXECUTE 'SELECT 2'; END")).toHaveLength(1);
  });
});

describe('#434 slice B: completeness, both directions, against the real closure', () => {
  it('the closure parses with zero unrecognized statements', () => {
    const inv = postPushInventory(ENTRY);
    expect(inv.unrecognized).toEqual([]);
    expect(inv.objects.length).toBeGreaterThan(300);
  });

  it('every object the closure creates has a post-push-owned row', () => {
    const inv = postPushInventory(ENTRY);
    const m = loadManifest(MANIFEST_PATH);
    const rows = new Set(m.postPushOwned.map(identity));
    const missing = inv.objects.map(identity).filter((id) => !rows.has(id));
    expect(missing, 'objects post-push.sql creates with no manifest row — regenerate scripts/db/gen-post-push-manifest.mjs and review').toEqual([]);
  });

  it('every post-push-owned row names something the closure creates', () => {
    const inv = postPushInventory(ENTRY);
    const real = new Set(inv.objects.map(identity));
    const stale = loadManifest(MANIFEST_PATH).postPushOwned.map(identity).filter((id) => !real.has(id));
    expect(stale, 'manifest rows naming nothing — regenerate and review').toEqual([]);
  });
});

describe('#434 slice B: diff-whitelist rows are anchored to the SQL corpus', () => {
  const corpus = (): string => {
    // prisma/*.sql (the post-push closure lives there) + every migration.
    const chunks: string[] = [];
    const prismaDir = join(repoRoot, 'prisma');
    for (const f of readdirSync(prismaDir)) if (f.endsWith('.sql')) chunks.push(readFileSync(join(prismaDir, f), 'utf8'));
    const migDir = join(prismaDir, 'migrations');
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.sql')) chunks.push(readFileSync(p, 'utf8'));
      }
    };
    walk(migDir);
    return chunks.join('\n');
  };

  it('every whitelisted drift line is a prisma-diff statement shape (anchored, not free text)', () => {
    for (const row of loadManifest(MANIFEST_PATH).diffWhitelist) {
      expect(row.line, `${row.name}: statement-shaped`).toMatch(/^(CREATE (UNIQUE )?INDEX|ALTER TABLE|DROP INDEX|ALTER COLUMN) /);
      expect(row.line.endsWith(';') || row.line.endsWith(','), `${row.name}: line ends like a diff script line`).toBe(true);
    }
  });

  it('every whitelisted object name exists somewhere in the SQL corpus (no typo\'d names)', () => {
    const sql = corpus();
    for (const row of loadManifest(MANIFEST_PATH).diffWhitelist) {
      const bare = row.name.includes('.') ? row.name.split('.').pop()! : row.name;
      // Word-boundary match: a bare substring check is trivially true for
      // short names (`tsv` sits inside to_tsvector, `handle` inside handles).
      expect(sql, `${row.name}: appears in prisma/*.sql or migrations`).toMatch(new RegExp(`\\b${escapeRe(bare)}\\b`));
    }
  });

  it('no two rows claim the same line (validated) and the line set is non-empty', () => {
    const lines = whitelistedLines(loadManifest(MANIFEST_PATH));
    expect(lines.size).toBe(loadManifest(MANIFEST_PATH).diffWhitelist.length);
  });
});

describe('#434 slice B: the workflow is wired to the manifest', () => {
  it('the drift step pipes through migrateDiffFilter.mjs with the manifest', () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    expect(wf).toContain('node scripts/db/migrateDiffFilter.mjs prisma/post-push-manifest.json');
  });

  it('the manifest path AND the filter\'s own code trigger the lane (both pull_request and push paths)', () => {
    // Order-independent block extraction: match the key at ITS indent, then
    // its body as the following lines indented DEEPER (a `push:` at the same
    // depth ends the block) — rather than slicing between first occurrences,
    // which a `push:` inside a comment or a reordered file would shrink.
    // The entry assertions target the `paths:` sub-block specifically, so a
    // `paths-ignore:` listing can never satisfy them.
    const wf = readFileSync(WORKFLOW, 'utf8');
    const block = (key: string) => wf.match(new RegExp(`^([ \\t]*)${key}:[^\\n]*(?:\\n\\1[ \\t]+.*)*`, 'm'))?.[0] ?? '';
    for (const key of ['pull_request', 'push']) {
      const b = block(key);
      expect(b, `${key}: block exists`).toMatch(/\S/);
      const paths = b.match(/^[ \t]*paths:\n((?:[ \t]+- .*(?:\n|$))*)/m)?.[1] ?? '';
      expect(paths, `${key}: paths: sub-block exists`).toMatch(/\S/);
      expect(paths, `${key}: manifest edits trigger the lane`).toContain('prisma/post-push-manifest.json');
      // The lane runs the filter and its manifest module: their own regressions
      // must re-run it (the BLIND review's P2-4, already true at the reviewed
      // head — pinned here so a paths trim cannot quietly lose it).
      expect(paths, `${key}: filter-code edits trigger the lane`).toContain('scripts/db/**');
    }
  });

  it('no whitelisted object name survives as hand-written SQL in the workflow', () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    for (const row of loadManifest(MANIFEST_PATH).diffWhitelist) {
      const bare = row.name.includes('.') ? row.name.split('.').pop()! : row.name;
      // The QUOTED form is how a name would appear in hand-written SQL or a
      // grep pattern. Bare prose (`handle`, `tsv`) must NOT trip this fence —
      // that brittleness was the BLIND review's P3.
      expect(wf, `"${bare}" must live only in the manifest, not the workflow`).not.toContain(`"${bare}"`);
    }
  });
});

describe('#434 slice B: the drift filter executes its contract (spawn)', () => {
  // Fence 4 — the script RUNS. The wiring tests above prove the lane calls it;
  // these prove it does what its header and the workflow comment claim. The
  // fixtures come from the manifest itself, so this cannot drift from the
  // whitelist it pins.
  const FILTER = join(repoRoot, 'scripts/db/migrateDiffFilter.mjs');
  const aWhitelisted = loadManifest(MANIFEST_PATH).diffWhitelist[0].line;
  // A superstring of a whitelisted line: the same statement with a CHANGED
  // definition. Exact matching keeps it (it is drift); a substring-match
  // mutant (`candidate.includes(l)`) would drop it — this case kills it.
  const superstring = `${aWhitelisted} WHERE changed = 1;`;

  const run = (args: string[], input: string) =>
    spawnSync(process.execPath, [FILTER, ...args], { input, encoding: 'utf8' });

  it('drops a whitelisted line exactly, strips CRLF before matching, and keeps a changed definition (superstring) as drift', () => {
    const res = run([MANIFEST_PATH], `${aWhitelisted}\n${superstring}\r\n${aWhitelisted}\r\nUNRELATED DRIFT;\n`);
    expect(res.status).toBe(0);
    // Exact stdout: only the superstring (its \r preserved as passthrough) and
    // the unrelated line survive; both whitelisted forms are dropped.
    expect(res.stdout.split('\n')).toEqual([`${superstring}\r`, 'UNRELATED DRIFT;', '']);
    // The run reports WHICH whitelist rows it consumed: matched telemetry,
    // not a gate (unmatched rows are normal in any single diff — a row that
    // can never match again surfaces as kept-line drift above). 1 DISTINCT
    // row: the same line dropped twice still consumes one whitelist row.
    expect(res.stderr).toMatch(/dropped 2 whitelisted line\(s\) per \S+ \(1\/\d+ whitelist rows matched, \d+ unmatched this run\)/);
  });

  it('an all-whitelisted input exits 0 with empty stdout (empty diff is success)', () => {
    const res = run([MANIFEST_PATH], `${aWhitelisted}\n`);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(''); // the only surviving "line" is the trailing empty one
    expect(res.stderr).toContain('dropped 1 whitelisted line(s)');
  });

  it('an invalid manifest exits 1 (a broken whitelist must never read as "no drift")', () => {
    // Kills the exit-0 mutant: every process.exit(1) -> process.exit(0) in the
    // filter fails exactly here.
    const dir = mkdtempSync(join(tmpdir(), 'migrate-diff-filter-'));
    try {
      const bad = join(dir, 'bad-manifest.json');
      writeFileSync(bad, JSON.stringify({ 'diff-whitelist': [], 'post-push-owned': [], 'unknown-key': true }));
      const res = run([bad], '');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('unknown key');
      expect(res.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('usage: no manifest argument exits 2', () => {
    const res = run([], '');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('usage:');
  });
});

describe('#434 slice B: the generator enforces full-row freshness (spawn)', () => {
  // gen --check compares name, kind, file AND why — a hand-edited row that
  // still names a real object must be drift too (the delta review asked for
  // the test the --manifest flag was built for).
  const GEN = join(repoRoot, 'scripts/db/gen-post-push-manifest.mjs');

  it('a tampered why on an otherwise-real row is stale: exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'post-push-gen-check-'));
    try {
      const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      m['post-push-owned'][0].why = 'hand-edited why that regeneration would not produce';
      const copy = join(dir, 'manifest.json');
      writeFileSync(copy, JSON.stringify(m));
      const res = spawnSync(process.execPath, [GEN, '--check', '--manifest', copy], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('stale');
      expect(res.stderr).toContain('why drift');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered file on an otherwise-real row is stale too: exit 1 (delta2 A7)', () => {
    // --check compares FULL rows; a hand-edited `file` is the same drift class
    // as a hand-edited why, and must fail independently of it.
    const dir = mkdtempSync(join(tmpdir(), 'post-push-gen-check-'));
    try {
      const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      m['post-push-owned'][0].file = 'hand-edited-file.sql';
      const copy = join(dir, 'manifest.json');
      writeFileSync(copy, JSON.stringify(m));
      const res = spawnSync(process.execPath, [GEN, '--check', '--manifest', copy], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('stale');
      expect(res.stderr).toContain('file "');
      expect(res.stderr).toContain('" -> "');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an untouched copy passes: exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'post-push-gen-check-'));
    try {
      const copy = join(dir, 'manifest.json');
      writeFileSync(copy, readFileSync(MANIFEST_PATH, 'utf8'));
      const res = spawnSync(process.execPath, [GEN, '--check', '--manifest', copy], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('full rows');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#4704: a catalog-resolved DROP creates no object; every CREATE-shaped dynamic string still refuses', () => {
  const run = (payloads: string) => classify({ sql: 'DO $do$ … $do$;', payloads });
  const refuses = (payloads: string) => run(payloads).filter((c) => 'unrecognized' in c);
  const wrap = (stmt: string) => `BEGIN ${stmt} END`;

  it('classifies the accepted DROP shapes as non-objects', () => {
    for (const stmt of [
      "EXECUTE format('DROP SEQUENCE %s', owned_seq::regclass);",
      "EXECUTE format('DROP SEQUENCE IF EXISTS %s', owned_seq::regclass);",
      "EXECUTE format('DROP INDEX %s', idx::regclass);",
      "EXECUTE format('DROP INDEX IF EXISTS %s', pg_get_serial_sequence('t', 'id')::regclass);",
      "EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rel::regclass, cname);",
      "EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', rel::regclass, cname);",
      "EXECUTE\n  format('DROP SEQUENCE %s',\n    owned_seq::regclass)\n;",
    ]) {
      expect(run(wrap(stmt)), stmt).toEqual([]);
    }
  });

  it('still refuses every CREATE-shaped dynamic string', () => {
    for (const stmt of [
      "EXECUTE format('CREATE INDEX %I ON t (c)', n);",
      "EXECUTE format('CREATE SEQUENCE %s', s::regclass);",
      "EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (c > 0)', rel::regclass, n);",
      "EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I; CREATE INDEX i ON t (c)', rel::regclass, n);",
      "EXECUTE format('DROP SEQUENCE %s; CREATE INDEX i ON t (c)', s::regclass);",
    ]) {
      expect(refuses(wrap(stmt)).length, stmt).toBeGreaterThan(0);
    }
  });

  it('refuses a %s that is not a regclass value, since %s pastes its argument unquoted', () => {
    for (const stmt of [
      "EXECUTE format('DROP SEQUENCE %s', 'x; CREATE INDEX i ON t (c)');",
      "EXECUTE format('DROP SEQUENCE %s', seq_name);",
      "EXECUTE format('DROP SEQUENCE %s', a || b::regclass);",
      "EXECUTE format('DROP SEQUENCE %s', f(a) || g(b)::regclass);",
      "EXECUTE format('DROP SEQUENCE %s', (SELECT n FROM t)::regclass);",
      "EXECUTE format('DROP SEQUENCE %s', 'public.s'::regclass);", // a literal cast is safe but stays outside the narrow shape: teach it if needed
      "EXECUTE format('DROP SEQUENCE %s', s::regclass::text || ';');",
      "EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rel_text, cname);",
    ]) {
      expect(refuses(wrap(stmt)).length, stmt).toBeGreaterThan(0);
    }
  });

  it('refuses a shape outside the closed list, or one with anything around the call', () => {
    for (const stmt of [
      "EXECUTE format('DROP TABLE %s', t::regclass);",
      "EXECUTE format('DROP FUNCTION %s', f::regclass);",
      "EXECUTE format('DROP SEQUENCE %s CASCADE', s::regclass);",
      "EXECUTE format('DROP SEQUENCE %s', s::regclass, extra);",
      "EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rel::regclass);",
      "EXECUTE format('DROP SEQUENCE %s', s::regclass) USING 1;",
      "EXECUTE format('DROP SEQUENCE %s', s::regclass) || ' ; CREATE INDEX i ON t (c)';",
      "EXECUTE 'x ' || format('DROP SEQUENCE %s', s::regclass);",
      "EXECUTE format(E'DROP SEQUENCE %s', s::regclass);",
      "EXECUTE format('DROP SEQUENCE ' || '%s', s::regclass);",
    ]) {
      expect(refuses(wrap(stmt)).length, stmt).toBeGreaterThan(0);
    }
  });

  it('one refused call refuses the block even beside an accepted one', () => {
    expect(refuses(wrap("EXECUTE format('DROP SEQUENCE %s', s::regclass); EXECUTE format('CREATE INDEX %I ON t (c)', n);"))).toHaveLength(1);
  });

  it('does not count a commented-out DROP or let one mask a live CREATE', () => {
    expect(run(wrap("-- EXECUTE format('DROP SEQUENCE %s', s::regclass);\n PERFORM 1;"))).toEqual([]);
    expect(refuses(wrap("/* EXECUTE format('DROP SEQUENCE %s', s::regclass); */ EXECUTE format('CREATE INDEX %I ON t (c)', n);"))).toHaveLength(1);
  });
});
