/**
 * #4583 — the historical `edge_first_class` backfill and the runtime derivation disagree for NON-BMP name characters.
 *
 * Postgres `regexp_replace('[^A-Za-z0-9._-]', '-', 'g')` replaces one UNICODE CODE POINT, so `a😀b` backfilled as
 * `a-b`. `sanitizeLocAtom`'s flagless JS regex replaces each UTF-16 UNIT, so the runtime derives `a--b`. An edge
 * migrated with the first spelling is therefore not found by a runtime derivation that yields the second
 * (cor:dmo:060:03: a derived loc is deterministic "so re-running a source sync is idempotent").
 *
 * The remedy never rewrites a loc (the FIT, AT0.8919.1): the runtime spelling stays what it has produced since the
 * migration, and the places that look an existing derived edge up also accept the migrated spelling. This file pins
 * (1) the SQL side against a JS twin of the migration's spelling, run against the migration's OWN function text,
 * (2) the pure helpers, (3) the lookup seam, including the collision cases.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from './id.js';
import {
  deriveEdgeLoc,
  deriveEdgeLocAlternates,
  isDerivedEdgeLoc,
  sanitizeLocAtom,
  sanitizeLocAtomCodePoint,
} from './edgeLoc.js';
import { derivedEdgeLocForUpsert } from './edgeLocLookup.js';
import { archiveTombstone, archivedTombstoneLoc, discoverArchivePlan } from './tombstoneArchive.js';
import { promotePendingEdgeForTarget } from './pendingEdgePromotion.js';

const MIGRATION = readFileSync(
  new URL('../../prisma/migrations/20260620120000_edge_first_class/migration.sql', import.meta.url),
  'utf8',
);
const fnStart = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION pg_temp.edge_sanitize_loc_atom');
const fnEnd = MIGRATION.indexOf('LANGUAGE plpgsql IMMUTABLE;', fnStart);
const FUNCTION_SQL = MIGRATION.slice(fnStart, fnEnd + 'LANGUAGE plpgsql IMMUTABLE;'.length);

/** Names with no astral code point: the two spellings are one. */
const BMP_VECTORS = ['depends-on', 'has space', 'foo:bar', '!!foo!!', '', '___', 'x'.repeat(70), 'ünï', 'a\u0301b', '日本語', '\uFFFF'];
/** An astral code point BETWEEN alphanumerics: the SQL writes one `-` per code point, the runtime two per code point. */
const DIVERGENT_VECTORS = ['a😀b', 'a😀😀b', 'a👨‍👩‍👧b', 'a\u{10FFFF}b', 'a\u{10000}b', '1😀2'];
/** An astral code point the trimming and the cap remove again, so the two spellings still agree. */
const ASTRAL_BUT_EQUAL_VECTORS = ['😀', '😀a', 'a😀', 'x'.repeat(63) + '😀', 'x'.repeat(63) + '😀b', '😀'.repeat(40)];

describe('the migration function text is extracted (a renamed marker must not make the parity vacuous)', () => {
  it('finds the whole pg_temp function', () => {
    expect(fnStart).toBeGreaterThanOrEqual(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
    expect(FUNCTION_SQL).toContain("regexp_replace(COALESCE(input, ''), '[^A-Za-z0-9._-]', '-', 'g')");
  });
});

describe('SQL parity: the migration function against sanitizeLocAtomCodePoint (#4583)', () => {
  /** Run the migration's own function over `inputs` inside one transaction (pg_temp is per session). */
  async function sqlSanitize(inputs: string[]): Promise<string[]> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(FUNCTION_SQL);
      const out: string[] = [];
      for (const v of inputs) {
        const [row] = await tx.$queryRaw<{ s: string }[]>`SELECT pg_temp.edge_sanitize_loc_atom(${v}) AS s`;
        out.push(row.s);
      }
      return out;
    });
  }

  it('agrees on every vector, BMP and astral', async () => {
    const all = [...BMP_VECTORS, ...DIVERGENT_VECTORS, ...ASTRAL_BUT_EQUAL_VECTORS];
    const sql = await sqlSanitize(all);
    all.forEach((v, i) => {
      expect(sql[i], JSON.stringify(v)).toBe(sanitizeLocAtomCodePoint(v));
    });
  });

  it('the runtime spelling DISAGREES with the SQL exactly on the divergent vectors (the documented divergence)', async () => {
    const vectors = [...BMP_VECTORS, ...DIVERGENT_VECTORS, ...ASTRAL_BUT_EQUAL_VECTORS];
    const sql = await sqlSanitize(vectors);
    vectors.forEach((v, i) => {
      if (DIVERGENT_VECTORS.includes(v)) expect(sanitizeLocAtom(v), JSON.stringify(v)).not.toBe(sql[i]);
      else expect(sanitizeLocAtom(v), JSON.stringify(v)).toBe(sql[i]);
    });
  });

  it('the issue example: `a😀b` backfills as `a-b`, the runtime derives `a--b`', async () => {
    const [sql] = await sqlSanitize(['a😀b']);
    expect(sql).toBe('a-b');
    expect(sanitizeLocAtom('a😀b')).toBe('a--b');
    expect(deriveEdgeLoc('root', 'a😀b', 'leaf')).toBe('root:a--b:leaf');
  });
});

describe('deriveEdgeLocAlternates / isDerivedEdgeLoc', () => {
  it('a name whose two spellings agree has NO alternate, so nothing changes for it', () => {
    for (const name of [...BMP_VECTORS, ...ASTRAL_BUT_EQUAL_VECTORS, null, undefined]) {
      expect(deriveEdgeLocAlternates('s', name, 't'), JSON.stringify(name)).toEqual([]);
    }
  });

  it('every divergent name has the migrated spelling as its alternate, and it differs from the runtime spelling', () => {
    for (const name of DIVERGENT_VECTORS) {
      const [alt, ...rest] = deriveEdgeLocAlternates('root', name, 'leaf');
      expect(rest, name).toEqual([]);
      expect(alt, name).toBe(`root:${sanitizeLocAtomCodePoint(name)}:leaf`);
      expect(alt, name).not.toBe(deriveEdgeLoc('root', name, 'leaf'));
    }
    expect(deriveEdgeLocAlternates('root', 'a😀b', 'leaf')).toEqual(['root:a-b:leaf']);
    expect(deriveEdgeLocAlternates('root', 'a😀😀b', 'leaf')).toEqual(['root:a--b:leaf']); // one `-` per code point
    expect(deriveEdgeLocAlternates('root', 'a😀b', 'leaf')[0]).not.toBe(deriveEdgeLoc('root', 'a😀b', 'leaf'));
  });

  it('isDerivedEdgeLoc accepts the runtime spelling and the migrated one, and nothing else', () => {
    expect(isDerivedEdgeLoc('root:a--b:leaf', 'root', 'a😀b', 'leaf')).toBe(true);
    expect(isDerivedEdgeLoc('root:a-b:leaf', 'root', 'a😀b', 'leaf')).toBe(true);
    expect(isDerivedEdgeLoc('root:a---b:leaf', 'root', 'a😀b', 'leaf')).toBe(false);
    expect(isDerivedEdgeLoc('root:a-b:leaf', 'root', 'a-b', 'leaf')).toBe(true);
    expect(isDerivedEdgeLoc('root:a-b:leaf', 'root', 'xyz', 'leaf')).toBe(false);
    // A BMP name has one spelling only.
    expect(isDerivedEdgeLoc('root:has-space:leaf', 'root', 'has space', 'leaf')).toBe(true);
  });
});

describe('derivedEdgeLocForUpsert — the lookup seam (#4583)', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  async function fixture() {
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'edge-loc-org', graphName: 'edge/loc4583' });
    const source = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'root', name: 'root' } });
    const target = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'leaf', name: 'leaf' } });
    const args = (name: string | null) => ({
      memoryId: graph.id, sourceId: source.id, targetId: target.id, sourceLoc: 'root', targetLoc: 'leaf', name,
    });
    const edge = (loc: string, name: string | null, targetId = target.id, deletedAt: Date | null = null) =>
      db.edge.create({ data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId, loc, name, deletedAt } });
    return { graph, source, target, args, edge };
  }

  it('a name with no alternate never reads the database', async () => {
    const findMany = vi.fn();
    const loc = await derivedEdgeLocForUpsert({ edge: { findMany } } as never, {
      memoryId: 'm', sourceId: 's', targetId: 't', sourceLoc: 'root', targetLoc: 'leaf', name: 'depends-on',
    });
    expect(loc).toBe('root:depends-on:leaf');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('an astral name with nothing stored derives the runtime spelling', async () => {
    const { args } = await fixture();
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a--b:leaf');
  });

  it('a MIGRATED edge (code-point spelling, same name and endpoints) is found: the upsert goes to its loc, not a new one', async () => {
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a-b:leaf');
  });

  it('a RUNTIME-created edge (the `--` spelling since the migration) still wins and is found as before', async () => {
    const { args, edge } = await fixture();
    await edge('root:a--b:leaf', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a--b:leaf');
  });

  it('both spellings present: the runtime spelling wins (what main already did)', async () => {
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf', 'a😀b');
    await edge('root:a--b:leaf', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a--b:leaf');
  });

  it('COLLISION: the migrated spelling of `a😀b` is the loc of an edge literally named `a-b`; it is NOT taken for the emoji edge', async () => {
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf', 'a-b'); // a different edge: its NAME is `a-b`
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a--b:leaf');
  });

  it('a same-named edge on a DIFFERENT target is not taken either', async () => {
    const { graph, source, args, edge } = await fixture();
    const other = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'other', name: 'other' } });
    await edge('root:a-b:leaf', 'a😀b', other.id);
    expect(source.id).toBeTruthy();
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a--b:leaf');
  });

  it('a soft-deleted migrated edge is still found (the (loc, memory) unique is unfiltered, so the upsert must reach it)', async () => {
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf', 'a😀b', undefined, new Date());
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a-b:leaf');
  });
});

describe('the wired sites reach the migrated edge (#4583)', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  async function pair() {
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'edge-loc-sites-org', graphName: 'edge/sites4583' });
    const source = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'root', name: 'root' } });
    const target = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'leaf', name: 'leaf' } });
    return { graph, source, target };
  }

  it('promotePendingEdgeForTarget: a parked edge whose relationship the migration already wrote is consumed against it, no twin', async () => {
    const { graph, source, target } = await pair();
    const migrated = await db.edge.create({
      data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: target.id, loc: 'root:a-b:leaf', name: 'a😀b' },
    });
    const pending = await db.pendingEdge.create({
      data: { id: generateId(), sourceId: source.id, targetId: target.id, name: 'a😀b', description: '' },
    });
    await promotePendingEdgeForTarget(pending.id, target.id, { db, scheduleFastRetry: false });
    const edges = await db.edge.findMany({ where: { memoryId: graph.id, sourceId: source.id, targetId: target.id } });
    expect(edges.map((e) => e.loc)).toEqual([migrated.loc]);
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
  });

  it('tombstone archive: an edge into an archived node is re-keyed whichever spelling its loc carries', async () => {
    // The migrated edge `root:a-b:old` (name `a😀b`) must follow its target to the archived address. Before #4583 the
    // "is this loc the derived one" test compared against the runtime spelling only, so the migrated loc was left
    // pointing at an address that no longer exists.
    for (const [spelling, edgeLoc] of [['migrated', 'root:a-b:old'], ['runtime', 'root:a--b:old']] as const) {
      await cleanDb(db);
      const { graph, source } = await pair();
      const old = await db.node.create({
        data: { id: generateId(), memoryId: graph.id, loc: 'old', name: 'old', deletedAt: new Date() },
      });
      const edge = await db.edge.create({
        data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: old.id, loc: edgeLoc, name: 'a😀b' },
      });
      const archived = archivedTombstoneLoc('old', old.id);
      const plan = await db.$transaction((tx) => discoverArchivePlan(tx, graph.id, 'old'));
      await db.$transaction((tx) => archiveTombstone(tx, { id: old.id, loc: 'old', memoryId: graph.id }, plan));
      const after = await db.edge.findUniqueOrThrow({ where: { id: edge.id } });
      expect(after.loc, spelling).toBe(`root:a--b:${archived}`);
    }
  });
});

describe('source pins for the sites a behavior test does not drive (#4583)', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('the Git sync edge upsert addresses the edge through the seam, not a bare deriveEdgeLoc', () => {
    // The sync's direct edge write needs a whole mocked checkout to drive; the pending-promotion leg of the same file
    // is driven for real in syncGraphFromGithub.test.ts. Pin that the direct write goes through the same seam.
    const sync = read('src/integrations/github/syncGraphFromGithub.ts');
    expect(sync).toMatch(/const edgeLoc = await derivedEdgeLocForUpsert\(tx, \{/);
    expect(sync).not.toMatch(/const edgeLoc = deriveEdgeLoc\(/);
    expect(sync).not.toMatch(/=== deriveEdgeLoc\(/);
    expect(read('src/lib/tombstoneArchive.ts')).not.toMatch(/=== deriveEdgeLoc\(/);
  });
});

describe('the census script (#4583, read only)', () => {
  const sql = readFileSync(join(process.cwd(), 'scripts/db/edge-loc-non-bmp-census-4583.sql'), 'utf8');
  const fnEndMarker = 'LANGUAGE plpgsql IMMUTABLE;';
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf(fnEndMarker) + fnEndMarker.length);
  const query = sql.slice(sql.indexOf(fnEndMarker) + fnEndMarker.length).trim().replace(/;\s*$/, '');

  beforeEach(async () => {
    await cleanDb(db);
  });

  it('counts each population, the twins and the loc collisions, and writes nothing', async () => {
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'census-org', graphName: 'edge/census4583' });
    const node = (loc: string) => db.node.create({ data: { id: generateId(), memoryId: graph.id, loc, name: loc } });
    const [s1, t1, s2, t2, s3, t3, s4, t4, s5, t5] = await Promise.all(
      ['s1', 't1', 's2', 't2', 's3', 't3', 's4', 't4', 's5', 't5'].map(node),
    );
    const edge = (s: { id: string }, t: { id: string }, loc: string, name: string) =>
      db.edge.create({ data: { id: generateId(), memoryId: graph.id, sourceId: s.id, targetId: t.id, loc, name } });
    await edge(s1, t1, 's1:a-b:t1', 'a😀b'); // migrated spelling
    await edge(s2, t2, 's2:a--b:t2', 'a😀b'); // runtime spelling
    await edge(s3, t3, 's3:a-b:t3', 'a😀b'); // a twin pair: migrated ...
    await edge(s3, t3, 's3:a--b:t3', 'a😀b'); // ... and runtime, same name and endpoints
    await edge(s4, t4, 's4:authored:t4', 'a😀b'); // neither: an authored loc
    await edge(s5, t5, 's5:a-b:t5', 'a😀b'); // migrated spelling whose runtime loc is taken by another edge ...
    await edge(s5, t5, 's5:a--b:t5', 'a-then--b'); // ... (a different edge, name with no astral char)
    await edge(s1, t2, 's1:plain:t2', 'plain'); // not divergent: ignored
    const before = await db.edge.count();
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(fn);
      return tx.$queryRawUnsafe<Record<string, bigint>[]>(query);
    });
    const r = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
    expect(r).toEqual({
      divergent_edges: 6,
      migrated_spelling: 3, // s1, s3 (migrated half), s5
      runtime_spelling: 2, // s2, s3 (runtime half)
      neither: 1, // s4
      twin_pairs: 1, // s3
      runtime_loc_taken_by_another: 1, // s5
      migrated_loc_taken_by_another: 0,
    });
    expect(await db.edge.count()).toBe(before);
  });
});
