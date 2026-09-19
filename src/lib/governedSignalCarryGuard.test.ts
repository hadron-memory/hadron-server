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
const UNGOVERNED_BULK_WRITERS: ReadonlyArray<{ file: string; why: string }> = [];

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

  it('CONTROL: every exemption still names a real file', () => {
    const found = bulkNodeWriters();
    for (const { file } of UNGOVERNED_BULK_WRITERS) expect(found).toContain(file);
  });

  it('every bulk node writer carries the signals, or is explicitly exempt', () => {
    const exempt = new Set(UNGOVERNED_BULK_WRITERS.map((e) => e.file));
    const offenders = bulkNodeWriters().filter((rel) => {
      if (exempt.has(rel)) return false;
      return !readFileSync(join(SRC, rel), 'utf-8').includes('carryGovernedSignals');
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
