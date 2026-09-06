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

/**
 * How far either side of a write we look for alias evidence.
 *
 * Sized to the real cascades, which group their three alias INSERTs first and
 * their three UPDATEs after, putting ~37 lines between the last INSERT and the
 * last UPDATE. At 30 the gate flagged two correctly-aliased statements.
 *
 * The trade-off is explicit: a wider window means an unaliased write sitting
 * near an unrelated aliased one can slip through. That is the right direction
 * for a heuristic whose job is to make a human look — a gate that cries wolf on
 * correct code gets waived reflexively, and then it protects nothing. The
 * proof-it-fails tests are what keep the window honest.
 */
const PROXIMITY_LINES = 60;

const WAIVER = /urn-alias-exempt:/;

/**
 * Evidence that the write records an alias. TWO spellings, because the bulk
 * cascades cannot call the TypeScript helper: they insert into `urn_aliases`
 * directly in SQL, in the same transaction. Accepting only `recordUrnRename`
 * flagged the two correctly-aliased cascades — a false positive on exactly the
 * paths the gate exists to protect, which would have trained the next reader to
 * waive it rather than read it.
 */
const ALIAS_EVIDENCE = /recordUrnRename|INSERT\s+INTO\s+urn_aliases/i;

/**
 * An UPDATE call on one of the four models. Deliberately anchored on the call
 * rather than on the word `urn`, because `urn:` appears in type declarations,
 * SDL, zod schemas and read projections all over the tree — matching those
 * produced ~80 false positives and a check nobody would keep.
 */
const UPDATE_CALL = new RegExp(
  `\\b(?:tx|db|ctx\\.db)\\.(${MODELS.join('|')})\\.(update|updateMany)\\(`,
);
/**
 * Raw SQL, e.g. `UPDATE memories SET urn = …`.
 *
 * Matched against the WHOLE FILE, not line by line (PR #1080 fourth review,
 * Codex P2). The production cascades wrap their SQL across lines —
 * `UPDATE memories` on one, `SET urn = …` on the next — so a per-line test
 * matched neither, and the two BULK rename paths (the widest ones, an org
 * rename and a handle change) were the only paths this gate did not cover.
 * A gate blind to precisely the code it was built for is the phantom shape
 * again, one layer up: I wrote the check, proved it fails, and still shipped a
 * hole because I proved it against the idiom I had in mind rather than the
 * idiom in the tree.
 */
const SQL_URN_WRITE_GLOBAL = new RegExp(
  `UPDATE\\s+"?(${TABLES.join('|')})"?\\s+SET\\s+urn\\s*=`,
  'gis',
);
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
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  /** Shared verdict for a write at line index `i`. */
  const unaliased = (i) => {
    const before = lines.slice(Math.max(0, i - PROXIMITY_LINES), i).join('\n');
    const after = lines.slice(i, i + PROXIMITY_LINES).join('\n');
    if (WAIVER.test(before) || WAIVER.test(after)) return false;
    return !ALIAS_EVIDENCE.test(before) && !ALIAS_EVIDENCE.test(after);
  };

  // Prisma update calls — line-anchored, since the call opens on one line.
  lines.forEach((line, i) => {
    if (!UPDATE_CALL.test(line)) return;
    // An update that never assigns `urn` cannot orphan anything.
    if (!URN_FIELD.test(callBlock(lines, i))) return;
    if (unaliased(i)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });

  // Raw SQL — whole-file, because the statement spans lines.
  SQL_URN_WRITE_GLOBAL.lastIndex = 0;
  for (const m of text.matchAll(SQL_URN_WRITE_GLOBAL)) {
    const i = text.slice(0, m.index).split('\n').length - 1;
    if (unaliased(i)) {
      violations.push(`${file}:${i + 1}: ${m[0].replace(/\s+/g, ' ').trim()}`);
    }
  }
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
