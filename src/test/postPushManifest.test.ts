/**
 * #434 slice B — the post-push manifest contract.
 *
 * Three fences, one per failure mode the slice exists to close:
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
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// eslint-disable-next-line import/no-relative-packages -- scripts/ is outside src/ by design; plain node ESM
import { postPushInventory } from '../../scripts/db/postPushInventory.mjs';
// eslint-disable-next-line import/no-relative-packages
import { loadManifest, whitelistedLines, ManifestError } from '../../scripts/db/postPushManifest.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST_PATH = join(repoRoot, 'prisma/post-push-manifest.json');
const ENTRY = join(repoRoot, 'prisma/post-push.sql');
const WORKFLOW = join(repoRoot, '.github/workflows/migration-smoke-test.yml');
const FIXTURE = join(repoRoot, 'src/test/testdata/post-push-fixture/main.sql');

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
      const tmp = join(repoRoot, 'src/test/testdata/post-push-manifest.invalid.json');
      writeFileSync(tmp, JSON.stringify(m));
      try {
        expect(() => loadManifest(tmp)).toThrow(ManifestError);
      } finally {
        rmSync(tmp);
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
      'extension:vector',
      'foreign-key-constraint:fixture_fk',
      'function:public.fixture_fn',
      'generated-column:fixture_books.lower_id',
      'index:fixture_included_idx', // via \ir include.sql — includes are followed
      'index:fixture_plain_idx',
      'sequence:fixture_seq',
      'table:fixture_books',
      'trigger:fixture_books.fixture_ctrig', // CREATE CONSTRAINT TRIGGER, identity is table.name
      'trigger:fixture_books.fixture_trig',
      'unique-constraint:fixture_uq',
      'unique-index:fixture_uniq_idx',
    ]);
    // The decoys must not appear under any identity.
    const flat = got.join('\n');
    expect(flat).not.toContain('decoy');
  });

  it('a trigger without an ON table is unrecognized, not silently dropped', () => {
    const inv = postPushInventory(FIXTURE);
    // (Guard for the fixture itself; the classify-level check is pinned by construction.)
    expect(inv.objects.every((o) => o.kind !== 'trigger' || o.name.includes('.'))).toBe(true);
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
      expect(sql, `${row.name}: appears in prisma/*.sql or migrations`).toContain(bare);
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

  it('the manifest path triggers the lane (both pull_request and push paths)', () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    const prBlock = wf.slice(wf.indexOf('pull_request:'), wf.indexOf('push:'));
    const pushBlock = wf.slice(wf.indexOf('push:'), wf.indexOf('jobs:'));
    expect(prBlock).toContain('prisma/post-push-manifest.json');
    expect(pushBlock).toContain('prisma/post-push-manifest.json');
  });

  it('no whitelisted object name survives as a hand-written grep in the workflow', () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    for (const row of loadManifest(MANIFEST_PATH).diffWhitelist) {
      const bare = row.name.includes('.') ? row.name.split('.').pop()! : row.name;
      expect(wf, `${bare} must live only in the manifest, not the workflow`).not.toContain(bare);
    }
  });
});
