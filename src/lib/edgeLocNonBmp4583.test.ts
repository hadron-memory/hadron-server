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
  compareMigratedSuffix,
  migratedLocSuffix,
  rekeyDerivedEdgeLoc,
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

describe("deriveEdgeLocAlternates / rekeyDerivedEdgeLoc", () => {
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

  it('rekeyDerivedEdgeLoc keeps the spelling the loc carries, and leaves an authored loc alone', () => {
    const rekey = (loc: string) => rekeyDerivedEdgeLoc(loc, 'old', 'a😀b', 'leaf', 'new', 'leaf');
    expect(rekey('old:a--b:leaf')).toBe('new:a--b:leaf'); // the runtime spelling stays the runtime spelling
    expect(rekey('old:a-b:leaf')).toBe('new:a-b:leaf'); // the migrated one stays the migrated one
    expect(rekey('old:authored:leaf')).toBeNull();
    expect(rekey('old:a---b:leaf')).toBeNull();
    // A name with one spelling: as before.
    expect(rekeyDerivedEdgeLoc('old:has-space:leaf', 'old', 'has space', 'leaf', 'new', 'leaf')).toBe('new:has-space:leaf');
    expect(rekeyDerivedEdgeLoc('old:other:leaf', 'old', 'has space', 'leaf', 'new', 'leaf')).toBeNull();
  });
});

describe('the backfill collision suffix, one rule for lookup, re-key and census (#4583)', () => {
  it('migratedLocSuffix accepts a canonical decimal >= 2 after the base, and nothing else', () => {
    const base = 'root:a-b:leaf';
    for (const n of ['2', '3', '9', '10', '99', '123456789012345678901234567890']) {
      expect(migratedLocSuffix(`${base}:${n}`, base), n).toBe(n);
    }
    for (const bad of ['', '0', '1', '02', '+2', '-2', '2.0', 'x', '2:deeper', ' 2', '2 ']) {
      expect(migratedLocSuffix(`${base}:${bad}`, base), JSON.stringify(bad)).toBeNull();
    }
    expect(migratedLocSuffix(base, base)).toBeNull();
    expect(migratedLocSuffix('other:a-b:leaf:2', base)).toBeNull();
  });

  it('compareMigratedSuffix orders as exact decimals: 9 < 10, and two values a double cannot tell apart still differ', () => {
    expect(compareMigratedSuffix('9', '10')).toBeLessThan(0);
    expect(compareMigratedSuffix('10', '9')).toBeGreaterThan(0);
    expect(compareMigratedSuffix('2', '2')).toBe(0);
    expect(compareMigratedSuffix('9007199254740992', '9007199254740993')).toBeLessThan(0);
    expect(compareMigratedSuffix('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
    expect(compareMigratedSuffix('', '2')).toBeLessThan(0); // the plain loc before any suffix
  });

  it('rekeyDerivedEdgeLoc carries the suffix to the new base (a moved endpoint keeps the same edge reachable)', () => {
    const rekey = (loc: string) => rekeyDerivedEdgeLoc(loc, 'old', 'a😀b', 'leaf', 'new', 'leaf2');
    expect(rekey('old:a-b:leaf:2')).toBe('new:a-b:leaf2:2');
    expect(rekey('old:a-b:leaf:17')).toBe('new:a-b:leaf2:17');
    expect(rekey('old:a-b:leaf:1')).toBeNull();
    expect(rekey('old:a-b:leaf:02')).toBeNull();
    expect(rekey('old:a-b:leaf:x')).toBeNull();
    // A name with one spelling has no suffix handling (as on main).
    expect(rekeyDerivedEdgeLoc('old:has-space:leaf:2', 'old', 'has space', 'leaf', 'new', 'leaf')).toBeNull();
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

  it('a migrated edge whose loc the backfill suffixed (`<base>:2`, two names sanitizing to one atom) is found', async () => {
    // Migration lines 70-89: when two edges between the same endpoints sanitize to the same atom, the second gets
    // `:2`. A literal `a-b` took `root:a-b:leaf`; the emoji edge, ranked after it, holds `root:a-b:leaf:2`.
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf', 'a-b');
    await edge('root:a-b:leaf:2', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a-b:leaf:2');
  });

  it('suffix collision: the unsuffixed migrated loc wins over a suffixed one; the lowest suffix over a higher one', async () => {
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf:3', 'a😀b');
    await edge('root:a-b:leaf:2', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a-b:leaf:2');
    await edge('root:a-b:leaf', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a-b:leaf');
  });

  it('a suffixed loc of a DIFFERENT edge is not taken: other name, or other target', async () => {
    const { graph, args, edge } = await fixture();
    const other = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'other', name: 'other' } });
    await edge('root:a-b:leaf:2', 'a-b'); // another name
    await edge('root:a-b:leaf:3', 'a😀b', other.id); // another target
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a--b:leaf');
  });

  it('suffixes order as decimals, not as strings or floats: `:9` before `:10`, and two huge ones stay distinct', async () => {
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf:10', 'a😀b');
    await edge('root:a-b:leaf:9', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, args('a😀b'))).toBe('root:a-b:leaf:9');
    await cleanDb(db);
    const f = await fixture();
    await f.edge('root:a-b:leaf:9007199254740993', 'a😀b'); // not representable as a double: rounds to ...992
    await f.edge('root:a-b:leaf:9007199254740992', 'a😀b');
    expect(await derivedEdgeLocForUpsert(db, f.args('a😀b'))).toBe('root:a-b:leaf:9007199254740992');
  });

  it('a non-numeric, deeper, or below-2 continuation of the migrated loc is not a suffix', async () => {
    const { args, edge } = await fixture();
    await edge('root:a-b:leaf:x', 'a😀b');
    await edge('root:a-b:leaf:2:deeper', 'a😀b');
    await edge('root:a-b:leaf:1', 'a😀b'); // the backfill numbers from 2: the first edge keeps the plain loc
    await edge('root:a-b:leaf:0', 'a😀b');
    await edge('root:a-b:leaf:02', 'a😀b'); // not the backfill's canonical form
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

  it('tombstone archive: BOTH twins of one relationship are re-keyed, each in its own spelling, so they do not collide', async () => {
    const { graph, source } = await pair();
    const old = await db.node.create({
      data: { id: generateId(), memoryId: graph.id, loc: 'old', name: 'old', deletedAt: new Date() },
    });
    const migrated = await db.edge.create({
      data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: old.id, loc: 'root:a-b:old', name: 'a😀b' },
    });
    const runtime = await db.edge.create({
      data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: old.id, loc: 'root:a--b:old', name: 'a😀b' },
    });
    const archived = archivedTombstoneLoc('old', old.id);
    const plan = await db.$transaction((tx) => discoverArchivePlan(tx, graph.id, 'old'));
    await db.$transaction((tx) => archiveTombstone(tx, { id: old.id, loc: 'old', memoryId: graph.id }, plan));
    expect((await db.edge.findUniqueOrThrow({ where: { id: migrated.id } })).loc).toBe(`root:a-b:${archived}`);
    expect((await db.edge.findUniqueOrThrow({ where: { id: runtime.id } })).loc).toBe(`root:a--b:${archived}`);
  });

  it('tombstone archive: a migrated edge whose loc carries the backfill suffix keeps it at the new address', async () => {
    const { graph, source } = await pair();
    const old = await db.node.create({
      data: { id: generateId(), memoryId: graph.id, loc: 'old', name: 'old', deletedAt: new Date() },
    });
    const edge = await db.edge.create({
      data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: old.id, loc: 'root:a-b:old:2', name: 'a😀b' },
    });
    const archived = archivedTombstoneLoc('old', old.id);
    const plan = await db.$transaction((tx) => discoverArchivePlan(tx, graph.id, 'old'));
    await db.$transaction((tx) => archiveTombstone(tx, { id: old.id, loc: 'old', memoryId: graph.id }, plan));
    expect((await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).loc).toBe(`root:a-b:${archived}:2`);
  });

  it('tombstone archive: an edge into an archived node is re-keyed whichever spelling its loc carries', async () => {
    // The migrated edge `root:a-b:old` (name `a😀b`) must follow its target to the archived address. Before #4583 the
    // "is this loc the derived one" test compared against the runtime spelling only, so the migrated loc was left
    // pointing at an address that no longer exists.
    for (const [spelling, edgeLoc, expected] of [
      ['migrated', 'root:a-b:old', 'a-b'], // stays in the migrated spelling at the new address
      ['runtime', 'root:a--b:old', 'a--b'],
    ] as const) {
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
      expect(after.loc, spelling).toBe(`root:${expected}:${archived}`);
    }
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
    // A soft-deleted divergent edge is counted like a live one: occupancy is what matters (the unique is unfiltered).
    await db.edge.create({ data: { id: generateId(), memoryId: graph.id, sourceId: s2.id, targetId: t1.id, loc: 's2:a-b:t1', name: 'a😀b', deletedAt: new Date() } });
    const [s6, t6] = await Promise.all(['s6', 't6'].map(node));
    await edge(s6, t6, 's6:a--b:t6', 'a😀b'); // runtime spelling whose migrated loc is taken by another edge ...
    await edge(s6, t6, 's6:a-b:t6', 'a-b'); // ... (named `a-b`, so not its twin)
    const [s7, t7] = await Promise.all(['s7', 't7'].map(node));
    await edge(s7, t7, 's7:a-b:t7', 'a-b');
    await edge(s7, t7, 's7:a-b:t7:2', 'a😀b'); // the backfill's collision suffix
    const [s8, t8, s9, t9] = await Promise.all(['s8', 't8', 's9', 't9'].map(node));
    await edge(s8, t8, 's8:a-b:t8:1', 'a😀b'); // `:1` is not a backfill suffix: neither
    await edge(s9, t9, 's9:a-b:t9:02', 'a😀b'); // nor is `:02`: neither
    await edge(s1, t2, 's1:plain:t2', 'plain'); // not divergent: ignored
    const before = await db.edge.count();
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(fn);
      return tx.$queryRawUnsafe<Record<string, bigint>[]>(query);
    });
    const r = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
    expect(r).toEqual({
      divergent_edges: 11,
      migrated_spelling: 4, // s1, s3 (migrated half), s5, and the soft-deleted s2 edge
      runtime_spelling: 3, // s2, s3 (runtime half), s6
      migrated_suffixed: 1, // s7
      neither: 3, // s4, and the rejected suffixes s8 (`:1`) and s9 (`:02`)
      twin_pairs: 1, // s3
      runtime_loc_taken_by_another: 1, // s5
      migrated_loc_taken_by_another: 1, // s6 (the positive case: a broken predicate that always answered 0 fails here)
    });
    expect(await db.edge.count()).toBe(before);
  });
});
