/**
 * SDL spec-citation gate (#1722).
 *
 * A GraphQL description is copied verbatim into hadron-portal's committed
 * schema snapshot, and the portal fails any newly added BARE spec citation
 * (`cor:agt:050:21` instead of `hrn:node:hadronmemory.com:specs:cor:agt:050:21`;
 * hadron-portal `scripts/check-bare-loc-citations.mjs`, #781). So a bare
 * citation written here does not fail here: it fails the NEXT portal slice that
 * refreshes its snapshot from server main, in someone else's PR. That is what
 * #1705's ~25 bare `cor:agt:050` citations did to hadron-portal#1054, and the
 * house rule (CLAUDE.md) is to cite fully qualified anyway, because a bare loc
 * loses its memory the moment it is pasted elsewhere.
 *
 * ## The rule
 *
 * The citation pattern, the "qualified" test and the whole-run test are the
 * portal gate's own, so the two agree on every token: `cor:<module>:<feature>[:<rule>…]`, judged by
 * the whole URN-ish token it sits in, which must start `hrn:node:` (or the
 * legacy `urn:node:`).
 *
 * ## Two checks
 *
 * 1. ADDED LINES (the portal's own rule). Every line of typeDefs.ts that this
 *    change adds or edits, relative to the merge base with the base ref
 *    (`origin/main` by default; CI passes the PR's base, or the commit main
 *    was at), must carry no bare citation. This is what the portal gate sees
 *    after a snapshot refresh: an edited description line is an added line
 *    there, even when it keeps a citation it already had, and so is a legacy
 *    citation moved to a new field. A total per citation cannot see either
 *    (Diego's P2 on #1724), so the added-line check is the gate; the baseline
 *    below never excuses an added line.
 *
 * 2. THE BASELINE (a ratchet on the untouched rest). 128 bare citations
 *    predate this gate; their cleanup is tracked by hadron-portal #781, and
 *    the portal only flags added lines, so they cost it nothing until someone
 *    edits them. `scripts/sdl-spec-citations-baseline.txt` records how many
 *    bare occurrences of each citation existed. A whole-file count above its
 *    baseline fails, and so does a citation with no entry, so the inventory
 *    cannot grow even if a base is ever misresolved. Qualifying an old one
 *    never fails; lower its count when you do (the gate says which). A
 *    malformed baseline FAILS rather than exempting anything: every entry is
 *    `<whole citation> <non-negative integer>`, once.
 *
 * A base that does not resolve is a failure, never a pass: an empty diff is
 * wrong in the passing direction (the portal workflow's note on the same).
 *
 * Run: pnpm check:sdl-spec-citations [base-ref]   (CI passes the base ref)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TYPEDEFS_PATH = 'src/api/graphql/schema/typeDefs.ts';
const TYPEDEFS = join(REPO, TYPEDEFS_PATH);
const BASELINE = join(HERE, 'sdl-spec-citations-baseline.txt');

/** hadron-portal scripts/check-bare-loc-citations.mjs `SPEC_CITATION`, verbatim. */
export const SPEC_CITATION = String.raw`cor:[a-z]{3}:\d{3}(?::\d{2})*`;
const CITATION = new RegExp(String.raw`\b${SPEC_CITATION}`, 'g');
const TOKEN_CHARS = /[A-Za-z0-9_.:-]/;

/** Is the citation at `index` inside a fully qualified token? (The portal gate's `isQualified`.) */
function isQualified(line, index) {
  let start = index;
  while (start > 0 && TOKEN_CHARS.test(line[start - 1])) start--;
  const token = line.slice(start);
  return token.startsWith('hrn:node:') || token.startsWith('urn:node:');
}

/**
 * Did the match take the WHOLE citation-shaped run? (The portal gate's
 * `isWholeSpecCitation`.) `cor:dmo:060:12abc` is an identifier, not a citation;
 * a trailing sentence colon (`per cor:api:090: the rule`) is still a citation.
 */
function isWholeSpecCitation(line, matchEnd) {
  const rest = line.slice(matchEnd);
  return !/^[\w-]/.test(rest) && !/^:\d/.test(rest);
}

/** Every bare spec citation in `source`: `{ line, citation }`, 1-based lines. */
export function findBareCitations(source) {
  const out = [];
  for (const [i, line] of source.split('\n').entries()) {
    for (const m of line.matchAll(CITATION)) {
      if (isQualified(line, m.index) || !isWholeSpecCitation(line, m.index + m[0].length)) continue;
      out.push({ line: i + 1, citation: m[0] });
    }
  }
  return out;
}

const WHOLE_CITATION = new RegExp(String.raw`^${SPEC_CITATION}$`);

/**
 * Baseline entries: `<citation> <count>`, one per citation; `#` comments and
 * blanks ignored. Anything else THROWS: a count that is missing, not a plain
 * non-negative integer (`NaN`, `Infinity`, `-1`, `1.5`, `1e3`), a key that is
 * not a whole citation, extra fields, or a duplicate key. Each would otherwise
 * exempt occurrences nobody chose to exempt (Diego's P3 on #1724).
 */
export function parseBaseline(raw) {
  const out = new Map();
  const problems = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const fields = t.split(/\s+/);
    const [citation, count] = fields;
    if (fields.length !== 2) problems.push(`line ${i + 1}: expected "<citation> <count>", got "${t}"`);
    else if (!WHOLE_CITATION.test(citation)) problems.push(`line ${i + 1}: "${citation}" is not a spec citation`);
    else if (!/^\d+$/.test(count)) problems.push(`line ${i + 1}: count "${count}" is not a non-negative integer`);
    else if (out.has(citation)) problems.push(`line ${i + 1}: ${citation} is listed twice`);
    else out.set(citation, Number(count));
  }
  if (problems.length) throw new Error(`malformed baseline:\n  ${problems.join('\n  ')}`);
  return out;
}

/**
 * The new-file line numbers a `git diff --unified=0` of ONE file adds (an
 * edited line is a removal plus an addition). The `+++` header is read only
 * before the first hunk, so a content line that itself starts with `++` is
 * still counted.
 */
export function addedLines(diff) {
  const out = new Set();
  let next = null;
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (next === null || !raw.startsWith('+')) continue;
    out.add(next++);
  }
  return out;
}

/** The bare citations on lines the change added. */
export function onAddedLines(found, added) {
  return found.filter((f) => added.has(f.line));
}

/** Compare found bare citations with the baseline: what exceeds it, and what it could be lowered to. */
export function compareWithBaseline(found, baseline) {
  const counts = new Map();
  for (const f of found) counts.set(f.citation, (counts.get(f.citation) ?? 0) + 1);
  const over = [];
  for (const [citation, n] of counts) {
    const allowed = baseline.get(citation) ?? 0;
    if (n > allowed) over.push({ citation, count: n, allowed, lines: found.filter((f) => f.citation === citation).map((f) => f.line) });
  }
  const lowerable = [...baseline].filter(([c, n]) => (counts.get(c) ?? 0) < n).map(([c, n]) => ({ citation: c, count: counts.get(c) ?? 0, allowed: n }));
  return { over, lowerable };
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main() {
  const base = process.argv[2] || 'origin/main';
  let diff;
  try {
    const mergeBase = git('merge-base', base, 'HEAD').trim();
    // Against the working tree, so an uncommitted edit is checked locally too.
    diff = git('diff', '--unified=0', '--no-color', '--no-ext-diff', mergeBase, '--', TYPEDEFS_PATH);
  } catch (e) {
    console.error(`::error::check-sdl-spec-citations: cannot diff against base "${base}" (${e.message.split('\n')[0]}). Fetch it, or pass a base ref.`);
    process.exit(2);
  }
  let baseline;
  try {
    baseline = parseBaseline(readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`::error file=scripts/sdl-spec-citations-baseline.txt::${e.message}`);
    process.exit(1);
  }

  const found = findBareCitations(readFileSync(TYPEDEFS, 'utf8'));
  const added = onAddedLines(found, addedLines(diff));
  const { over, lowerable } = compareWithBaseline(found, baseline);
  for (const a of added) {
    console.error(
      `::error file=${TYPEDEFS_PATH},line=${a.line}::bare spec citation ${a.citation} on a line this change adds or edits. ` +
        `Cite it as hrn:node:hadronmemory.com:specs:${a.citation}: the portal's schema-snapshot gate fails a bare one on an added line, ` +
        'even one it had before the edit.',
    );
  }
  for (const o of over) {
    console.error(
      `::error::typeDefs.ts:${o.lines.join(',')}: bare spec citation ${o.citation} (${o.count} bare, baseline ${o.allowed}). ` +
        `Cite it as hrn:node:hadronmemory.com:specs:${o.citation}.`,
    );
  }
  if (lowerable.length) {
    console.warn(
      `note: fewer bare citations than the baseline allows; lower these in scripts/sdl-spec-citations-baseline.txt: ` +
        lowerable.map((l) => `${l.citation} ${l.allowed}→${l.count}`).join(', '),
    );
  }
  if (added.length || over.length) {
    console.error(`\n✗ ${added.length} bare citation(s) on added lines, ${over.length} citation(s) above the baseline. SDL citations must be fully qualified.`);
    process.exit(1);
  }
  console.log(`✓ No bare spec citations on lines added since ${base}; ${found.length} pre-existing bare, within the baseline.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
