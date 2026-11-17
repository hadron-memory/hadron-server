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
      'check-constraint:fixture_multi_a', // multi-action ALTER: first object …
      'check-constraint:fixture_qualified_chk', // schema-qualified ALTER TABLE public.x
      'check-constraint:fixture_readd_chk', // idempotent DROP IF EXISTS + ADD in one statement
      'extension:vector',
      'foreign-key-constraint:fixture_fk',
      'function:fixture_fn', // public. prefix normalized away (default search_path)
      'generated-column:fixture_books.lower_id',
      'index:fixture_include_rel_idx', // via \include_relative with a trailing comment
      'index:fixture_included_idx', // via \ir include.sql — includes are followed
      'index:fixture_plain_idx',
      'sequence:fixture_seq',
      'table:fixture_books',
      'trigger:fixture_books.fixture_ctrig', // CREATE CONSTRAINT TRIGGER, identity is table.name
      'trigger:fixture_books.fixture_trig',
      'unique-constraint:fixture_multi_b', // … and the second object of that same statement
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
    // is cwd-relative — the fixture's path is repo-root-relative because that
    // is where vitest runs. Pinned so the two resolution rules cannot merge.
    const inv = postPushInventory(I_ENTRY);
    expect(inv.unrecognized).toEqual([]);
    expect(inv.objects.map(identity)).toEqual(['index:fixture_i_included_idx']);
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
    const wf = readFileSync(WORKFLOW, 'utf8');
    const block = (key: string) => wf.match(new RegExp(`^([ \\t]*)${key}:[^\\n]*(?:\\n\\1[ \\t]+.*)*`, 'm'))?.[0] ?? '';
    for (const key of ['pull_request', 'push']) {
      const b = block(key);
      expect(b, `${key}: block exists`).toMatch(/\S/);
      expect(b, `${key}: manifest edits trigger the lane`).toContain('prisma/post-push-manifest.json');
      // The lane runs the filter and its manifest module: their own regressions
      // must re-run it (the BLIND review's P2-4, already true at the reviewed
      // head — pinned here so a paths-list trim cannot quietly lose it).
      expect(b, `${key}: filter-code edits trigger the lane`).toContain('scripts/db/**');
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
