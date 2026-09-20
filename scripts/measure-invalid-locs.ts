/**
 * Read-only diagnostic for #1224: how many LIVE nodes carry a `loc` that
 * `validateLoc` would reject, and in which memories?
 *
 * `syncGraphFromGithub` derives a node's loc from its FILE PATH
 * (`loadNodeFromFs`'s `deriveLoc`) and never calls `validateLoc`, while all
 * 11 API write paths do. So the charset (spec 021 FR-016/FR-017) is an
 * invariant the API enforces and the mirror does not. Before turning
 * validation on for that writer we have to know whether it would break a
 * memory that syncs fine today — a zero makes it a clean tightening, a
 * non-zero makes it a migration with an adoption gate (#1216's shape).
 *
 * This runs the REAL `validateLoc`, not a second implementation of its
 * charset in SQL: a re-derived regex that disagrees with the function would
 * measure the regex instead of the rule.
 *
 * Two modes, ONE predicate:
 *
 *   pnpm tsx scripts/measure-invalid-locs.ts                  # DATABASE_URL
 *   pnpm tsx scripts/measure-invalid-locs.ts --tsv locs.tsv   # exported rows
 *   … | pnpm tsx scripts/measure-invalid-locs.ts --tsv -      # or on stdin
 *
 * The `--tsv` mode exists for production, where the DB is only reachable
 * from the host and this checkout is not: export the rows there, judge them
 * here, with the same function either way. Expected columns, tab-separated,
 * `\N` for null, and `loc` LAST so a tab inside a path-derived loc cannot
 * shift the other fields:
 *
 *   memory_urn <TAB> memory_source <TAB> owner_repo <TAB> loc
 *
 * Exit code is 0 when the scan is trustworthy and found nothing, 1 when it
 * found offenders OR when a control failed. A failed control is NOT a clean
 * result: it means this run measured nothing, which is the failure mode the
 * controls exist to make impossible to read as success.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { InvalidLocError, validateLoc } from '../src/lib/validateLoc.js';

/** One row under judgement, from either source. */
type LocRow = {
  memoryUrn: string;
  /** `Memory.source` — set ⇒ the memory is git-backed, so the mirror writes it. */
  memorySource: string | null;
  /** `Node.ownerRepo` — set ⇒ THIS ROW was written by the sync path. */
  ownerRepo: string | null;
  loc: string;
};

/** A rejected row, with the reason the shared validator gave. */
type Offender = LocRow & { reason: string; segment: string | undefined };

/**
 * Locs the validator MUST reject, each naming the shape it stands for. The
 * first is #1224's own specimen: a file named `evil--> something.md`.
 */
const MUST_REJECT: Array<[string, string]> = [
  ['evil--> something', 'the #1224 specimen — closes an HTML comment'],
  ['a b', 'a space, which a filename may carry and a URN may not'],
  ['x>y', 'a raw > outside the comment case'],
  ['a::b', 'an empty atom from a doubled separator'],
  [':leading', 'an empty leading atom'],
  ['trailing:', 'an empty trailing atom'],
  ['-dash', 'an atom starting with a hyphen'],
  ['dot.', 'an atom ending with a dot'],
  [`${'x'.repeat(65)}`, 'an atom past the 64-char FR-017 cap'],
  ['', 'the empty loc'],
];

/** Locs the validator MUST accept — a control against a predicate that rejects everything. */
const MUST_ACCEPT: string[] = [
  'architecture',
  'review:sort-imports',
  'cor:acl:010:01',
  'a.b.c',
  'x',
  'findings:git-sync-move-aware-identity',
  'x'.repeat(64),
];

/**
 * Prove the predicate can return BOTH answers before trusting either.
 *
 * A scan whose predicate cannot reject reports an empty offender list over
 * any population, and a scan whose predicate cannot accept reports every
 * row. Both read exactly like a real result.
 */
function runPredicateControls(): boolean {
  let ok = true;
  for (const [loc, why] of MUST_REJECT) {
    if (judge(loc) === null) {
      console.error(`CONTROL FAILED: validateLoc accepted ${JSON.stringify(loc)} — ${why}`);
      ok = false;
    }
  }
  for (const loc of MUST_ACCEPT) {
    const verdict = judge(loc);
    if (verdict !== null) {
      console.error(
        `CONTROL FAILED: validateLoc rejected the valid loc ${JSON.stringify(loc)} (${verdict.reason})`,
      );
      ok = false;
    }
  }
  if (ok) {
    console.log(
      `control: predicate rejects ${MUST_REJECT.length} known-bad locs and accepts ${MUST_ACCEPT.length} known-good ones ✓`,
    );
  }
  return ok;
}

/** Judge one loc with the shared validator. `null` = valid. */
function judge(loc: string): { reason: string; segment: string | undefined } | null {
  try {
    validateLoc(loc);
    return null;
  } catch (err) {
    if (err instanceof InvalidLocError) {
      return { reason: err.reason, segment: err.segment };
    }
    // An unexpected throw is not a verdict about the loc — surface it rather
    // than recording the row as invalid for the wrong reason.
    throw err;
  }
}

/** Read every live node's loc from DATABASE_URL. */
async function rowsFromDb(): Promise<LocRow[]> {
  const db = new PrismaClient();
  try {
    const nodes = await db.node.findMany({
      where: { deletedAt: null, memory: { deletedAt: null } },
      select: {
        loc: true,
        ownerRepo: true,
        memory: { select: { urn: true, source: true } },
      },
    });
    return nodes.map((n) => ({
      memoryUrn: n.memory.urn,
      memorySource: n.memory.source,
      ownerRepo: n.ownerRepo,
      loc: n.loc,
    }));
  } finally {
    await db.$disconnect();
  }
}

/** Parse rows exported by psql. `loc` is last, so a tab inside it survives. */
function rowsFromTsv(path: string): LocRow[] {
  const raw = path === '-' ? readFileSync(0, 'utf-8') : readFileSync(path, 'utf-8');
  const rows: LocRow[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts.length < 4) {
      throw new Error(`Malformed TSV line (want 4 tab-separated columns, got ${parts.length}): ${line}`);
    }
    const [memoryUrn, memorySource, ownerRepo, ...locParts] = parts;
    rows.push({
      memoryUrn,
      memorySource: memorySource === '\\N' ? null : memorySource,
      ownerRepo: ownerRepo === '\\N' ? null : ownerRepo,
      // Rejoin: a loc containing a literal tab is exactly the kind of thing
      // this script exists to find, so it must not be silently truncated.
      loc: locParts.join('\t'),
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const tsvFlag = process.argv.indexOf('--tsv');
  const source = tsvFlag === -1 ? 'database' : `tsv:${process.argv[tsvFlag + 1] ?? '-'}`;

  if (!runPredicateControls()) {
    console.error('\nABORTING: the predicate did not pass its own controls, so this run measured nothing.');
    process.exit(1);
  }

  const rows =
    tsvFlag === -1 ? await rowsFromDb() : rowsFromTsv(process.argv[tsvFlag + 1] ?? '-');

  // Scan control: a zero-row scan reports an empty offender list and looks
  // identical to a clean corpus.
  if (rows.length === 0) {
    console.error(
      `\nABORTING: scanned 0 rows from ${source}. An empty scan cannot distinguish "no invalid locs" from "no data read".`,
    );
    process.exit(1);
  }

  const memories = new Set(rows.map((r) => r.memoryUrn));
  const gitBackedMemories = new Set(rows.filter((r) => r.memorySource).map((r) => r.memoryUrn));
  const mirrorWritten = rows.filter((r) => r.ownerRepo).length;

  const offenders: Offender[] = [];
  for (const row of rows) {
    const verdict = judge(row.loc);
    if (verdict) offenders.push({ ...row, ...verdict });
  }

  console.log(`source: ${source}`);
  console.log(`scanned: ${rows.length} live node(s) across ${memories.size} live memory/ies`);
  console.log(
    `population the unguarded writer can reach: ${gitBackedMemories.size} git-backed memory/ies (Memory.source set), ${mirrorWritten} node(s) carrying Node.ownerRepo`,
  );
  console.log(`invalid locs: ${offenders.length}`);

  if (offenders.length > 0) {
    // The crosstab, not the total, is what decides the fix: "how many rows
    // would validating the sync path refuse" is a question about
    // reason × writer, and a single number answers it wrongly. A charset
    // violation the mirror never produced is not evidence against validating
    // the mirror's charset.
    const crosstab = new Map<string, number>();
    for (const o of offenders) {
      const key = `${o.reason} × ${o.ownerRepo ? 'viaMirror' : 'viaApi'}`;
      crosstab.set(key, (crosstab.get(key) ?? 0) + 1);
    }
    console.log('\nby reason × writer:');
    for (const [key, n] of [...crosstab].sort()) console.log(`  ${key}: ${n}`);
    console.log('');
  }

  if (offenders.length > 0) {
    const byMemory = new Map<string, Offender[]>();
    for (const o of offenders) {
      const list = byMemory.get(o.memoryUrn) ?? [];
      list.push(o);
      byMemory.set(o.memoryUrn, list);
    }
    console.log('');
    for (const [memoryUrn, list] of [...byMemory].sort((a, b) => b[1].length - a[1].length)) {
      const src = list[0].memorySource ? `git-backed: ${list[0].memorySource}` : 'not git-backed';
      console.log(`${memoryUrn} (${src}) — ${list.length}`);
      for (const o of list) {
        const seg = o.segment !== undefined ? ` segment=${JSON.stringify(o.segment)}` : '';
        const via = o.ownerRepo ? ` viaMirror=${o.ownerRepo}` : ' viaApi(!)';
        console.log(`  ${o.reason}${seg}${via} loc=${JSON.stringify(o.loc)}`);
      }
    }
    console.log(
      '\nNon-zero ⇒ this is a migration with an adoption gate, not a clean tightening: validating the sync writer would refuse these files on the next sync.',
    );
    console.log(
      'A `viaApi(!)` row is a second finding — it means a row got past a guarded path, or predates the guard.',
    );
    process.exit(1);
  }

  console.log(
    '\nZero offenders, and the scan is trustworthy (controls passed, non-empty population above) ⇒ clean tightening.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
