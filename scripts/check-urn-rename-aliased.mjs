#!/usr/bin/env node
/**
 * #1079 / `cor:urn:030:01` — every writer of a stored `urn` column must record
 * an alias.
 *
 * ## Why this is a build gate and not a review note
 *
 * A URN is published into commit trailers, PR descriptions, issue signatures
 * and chat archives, so a rename that records no alias silently 404s references
 * the platform cannot reach back and rewrite. That makes "did you alias it?" a
 * question every future `urn:` write has to answer.
 *
 * It is mechanical because diligence demonstrably does not cover it. The
 * original issue named ONE rename path. Writing the fix found five. Three
 * rounds of review then found three more — `mergeOwnerNamespacedUrns`, the
 * agent's derived system memory, `linkMemoryToUser`, and
 * `repairAgentSystemMemoryOwner` — each by a reader noticing a path nobody had
 * enumerated. The failure is not that anyone was careless; it is that the set of
 * writers is open, spread across eight files, and invisible from inside any one
 * diff. That is precisely the shape a grep can hold and a person cannot.
 *
 * ## What it checks
 *
 * Any source line that assigns the `urn` field of one of the four entities
 * whose URN is a stored, renameable column — in Prisma `data:` payloads or in
 * raw `UPDATE <table> SET urn =` SQL — must sit within `PROXIMITY_LINES` of a
 * `recordUrnRename` call or an explicit waiver comment.
 *
 * Proximity rather than real analysis is deliberate: the check must be cheap
 * and obvious, and its job is to make a human look, not to prove correctness.
 * A false positive is answered by a waiver that states WHY, which is exactly
 * the sentence a reviewer would otherwise have to ask for.
 *
 * ## Waiving
 *
 * Put this on or directly above the line, with a reason:
 *
 *   // urn-alias-exempt: <why this write cannot orphan a published URN>
 *
 * Legitimate reasons: the row is being CREATED (no prior URN existed), or the
 * write is inside a helper the caller already aliased. "It is covered
 * elsewhere" without naming where is not a reason.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Entities whose `urn` is a stored, renameable column (cor:urn:030). */
const TABLES = ['memories', 'agents', 'apps', 'organizations'];
/** The Prisma model names for those same four entities. */
const MODELS = ['memory', 'agent', 'app', 'organization'];

/** How far past an update call we look for the alias call. */
const PROXIMITY_LINES = 30;

const WAIVER = /urn-alias-exempt:/;

/**
 * An UPDATE call on one of the four models. Deliberately anchored on the call
 * rather than on the word `urn`, because `urn:` appears in type declarations,
 * SDL, zod schemas and read projections all over the tree — matching those
 * produced ~80 false positives and a check nobody would keep.
 */
const UPDATE_CALL = new RegExp(
  `\\b(?:tx|db|ctx\\.db)\\.(${MODELS.join('|')})\\.(update|updateMany)\\(`,
);
/** Raw SQL, e.g. `UPDATE memories SET urn = …`. */
const SQL_URN_WRITE = new RegExp(`UPDATE\\s+"?(${TABLES.join('|')})"?\\s+SET\\s+urn\\s*=`, 'i');
/**
 * A `urn:` assignment anywhere inside the captured payload — NOT anchored to the
 * start of a line.
 *
 * The anchored version (`/^\s*urn:/m`) was a PHANTOM GATE: this codebase's
 * dominant update idiom is the conditional spread
 * `...(newUrn !== undefined ? { urn: newUrn } : {})`, which puts the assignment
 * mid-line, so the check matched nothing and passed on every file including the
 * ones with the defect. Deleting a real `recordUrnRename` call left it green.
 *
 * Caught by planting the actual defect and asserting the EXIT CODE, per
 * `review:guard-must-be-proven-to-fail` — a gate that reports success on broken
 * input is worse than no gate, because it is trusted.
 *
 * Unanchored also matches a `where: { urn: … }` selector, which over-flags
 * rather than under-flags. That is the correct direction for this check: a
 * false positive costs one waiver line stating why, a false negative costs a
 * silently orphaned published URN.
 */
const URN_FIELD = /\burn:\s*\S/;

function sourceFiles() {
  // `git ls-files -- src` plus JS filtering, rather than a shell pipeline: the
  // `src/**/*.ts` pathspec does not match a top-level `src/x.ts` without glob
  // magic, and a trailing `grep -v` EXITS 1 when it filters everything out —
  // so the pipeline threw instead of reporting "nothing to check". Both bugs
  // were invisible against this repo (deep tree, always matches) and only
  // surfaced against a one-file fixture.
  const out = execSync('git ls-files -- src', { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/** The call's argument text, from `(` to the balancing `)`. */
function callBlock(lines, startIdx) {
  let depth = 0, started = false, out = [];
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 60); i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')') depth--;
    }
    if (started && depth <= 0) break;
  }
  return out.join('\n');
}

const violations = [];
for (const file of sourceFiles()) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const isSql = SQL_URN_WRITE.test(line);
    const isUpdate = UPDATE_CALL.test(line);
    if (!isSql && !isUpdate) return;
    // An update that never assigns `urn` cannot orphan anything.
    if (isUpdate && !URN_FIELD.test(callBlock(lines, i))) return;
    const before = lines.slice(Math.max(0, i - PROXIMITY_LINES), i).join('\n');
    const after = lines.slice(i, i + PROXIMITY_LINES).join('\n');
    if (WAIVER.test(before) || WAIVER.test(after)) return;
    if (/recordUrnRename/.test(before) || /recordUrnRename/.test(after)) return;
    violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(
    '::error::A stored `urn` is written here without a nearby recordUrnRename ' +
      '(#1079, cor:urn:030:01). A rename with no alias silently 404s every ' +
      'published reference to the old URN — including every node and edge URN ' +
      'derived from it.\n' +
      'Record the alias in the SAME transaction as the write, or waive with ' +
      '`// urn-alias-exempt: <reason>` stating why this write cannot orphan a ' +
      'published URN.\n',
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`OK — every stored-urn update is aliased or waived (${MODELS.length} models checked).`);
