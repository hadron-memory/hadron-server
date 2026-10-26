/**
 * #1218 — a new bulk node-copy site must OPT OUT of carrying the governed
 * signals, not remember to opt in.
 *
 * `protectedLoc.ts` names the failure this prevents: *a gate a caller can omit*.
 * The bug this whole change fixes was exactly that — `role` missing from two
 * hand-written field lists while `isRunnable` was present, invisible because
 * nothing asserted the lists agreed. Adding `role` at both sites fixes today
 * and leaves the fourth operation, added next year, free to forget.
 *
 * So the classification is an **allow-list of the UNGOVERNED** (the shape
 * @Jonas's `unbound-ops.txt` uses in hadron-cli): a file that creates node rows
 * in bulk is expected to carry the signals, and a new one that does not FAILS
 * here rather than silently exempting itself. Exempting is a deliberate edit
 * with a reason attached.
 *
 * TWO CONTROLS, because a scanner that finds nothing passes every assertion
 * ever written — the exact way @Gil's tab-strip gate reported OK across 153
 * files while seeing one of five, and the way two of my own mutations on
 * PR #1215 "passed" while measuring nothing:
 *
 *   1. the scan must find at least the sites we know exist, BY NAME;
 *   2. every exemption must still name a real file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(import.meta.dirname, '..');

/**
 * Files that create node rows in bulk and deliberately do NOT carry the
 * governed signals. Empty today, and that is the point — an entry here is a
 * decision, and the test below proves the path still exists so a stale
 * exemption cannot quietly widen the allow-list.
 */
const UNGOVERNED_BULK_WRITERS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'api/graphql/schema/resolvers.mutation.session.ts',
    why: 'createRevision inserts the one fixed `revisions` system parent (skipDuplicates) — a literal row, not a copy of any node, so there is no governed role to carry.',
  },
];

/** The sites we know must be found — the positive control. */
const KNOWN_CARRIERS = [
  'controller/operations/cloneMemory.ts',
  'controller/operations/extractParentNode.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * KNOWN LIMIT, stated rather than denied (@copilot round 4, PR #1221): this is
 * per FILE, not per call site. A file with two `node.createMany` calls passes
 * if EITHER spreads the helper, so a second uncarried writer added to an
 * existing carrier's file goes undetected.
 *
 * Not closed here because closing it properly means parsing the file and
 * binding each `createMany` to the object literal it receives — an AST check,
 * which is a different tool than this one and wants its own PR rather than a
 * regex that approximates one. Both files in scope today hold exactly one such
 * call, so the limit is reachable only by a shape that does not exist yet.
 *
 * What makes that acceptable rather than a hole: the type-level requirement on
 * `NodeForGit` and the exhaustiveness check in `governedSignals.ts` are the
 * load-bearing guarantees, and neither can be evaded by where a call sits in a
 * file. This guard is the backstop for the one path they do not cover — a bulk
 * row literal built by hand.
 */

/** Files performing a BULK node-row create — the shape a subtree copy has. */
function bulkNodeWriters(): string[] {
  return walk(SRC)
    .filter((f) => /\bnode\.createMany\s*\(/.test(readFileSync(f, 'utf-8')))
    .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
    .sort();
}

describe('#1218 — bulk node writers carry the governed signals by default', () => {
  it('CONTROL: the scan finds the sites we know exist', () => {
    // Without this the whole file is vacuous: a regex that matches nothing
    // reports a clean bill of health for a codebase it never read.
    const found = bulkNodeWriters();
    for (const known of KNOWN_CARRIERS) expect(found).toContain(known);
  });

  it('CONTROL: a MENTION of the helper is not enough to pass', () => {
    // The guard's predicate, exercised directly on a file that imports and
    // names the helper without spreading it — the shape @copilot found the
    // first version accepting. Run against strings rather than a planted file
    // so the control cannot leave debris in src/.
    const spread = /\.\.\.carryGovernedSignals\s*\(/;
    expect(spread.test("import { carryGovernedSignals } from './governedSignals.js';")).toBe(false);
    expect(spread.test('// carryGovernedSignals is handled elsewhere')).toBe(false);
    expect(spread.test('const x = carryGovernedSignals(n);')).toBe(false);
    expect(spread.test('...carryGovernedSignals(n),')).toBe(true);
  });

  it('CONTROL: every exemption still names a real file', () => {
    const found = bulkNodeWriters();
    for (const { file } of UNGOVERNED_BULK_WRITERS) expect(found).toContain(file);
  });

  it('every bulk node writer carries the signals, or is explicitly exempt', () => {
    const exempt = new Set(UNGOVERNED_BULK_WRITERS.map((e) => e.file));
    const offenders = bulkNodeWriters().filter((rel) => {
      if (exempt.has(rel)) return false;
      // SPREAD INTO A ROW, not merely mentioned (@copilot, PR #1221). Checking
      // that the file CONTAINS the helper's name passes on an import left
      // behind by a deleted call, on an unrelated second use, and on the word
      // appearing in a comment — all while both columns are missing from the
      // payload. The guard's own failure mode is the one it exists to catch,
      // so it keys on the call being SPREAD (`...carryGovernedSignals(`),
      // which is the only form that reaches a row literal.
      return !/\.\.\.carryGovernedSignals\s*\(/.test(readFileSync(join(SRC, rel), 'utf-8'));
    });
    expect(
      offenders,
      `These files create node rows in bulk without carrying the governed signals ` +
        `(role, isRunnable). Copying a node must preserve what makes it governed, or a ` +
        `review/spec/task arrives ungoverned — #1218. Import carryGovernedSignals from ` +
        `lib/governedSignals.js and spread it into the row, or add the file to ` +
        `UNGOVERNED_BULK_WRITERS with a reason.`,
    ).toEqual([]);
  });
});
