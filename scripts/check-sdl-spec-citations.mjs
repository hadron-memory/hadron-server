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
 * 3. EXISTENCE (#4508). Every QUALIFIED citation in typeDefs.ts
 *    (`hrn:node:hadronmemory.com:specs:cor:…`, or the legacy `urn:node:` scheme)
 *    must name a WRITTEN spec in `scripts/sdl-spec-citations-snapshot.txt`, a
 *    committed inventory of the corpus's written nodes. A citation to a node
 *    that does not exist (#4442's `cor:agt:130:06`, which the corpus never
 *    had) or is only a placeholder fails, wherever in the file it sits: the
 *    snapshot is judged for the whole file, not only for added lines. CI has
 *    no corpus access, hence a snapshot rather than a lookup. The cost is a
 *    drift window equal to the snapshot's age: a citation to a rule written
 *    after the last refresh fails until an author refreshes it
 *    (`node scripts/refresh-sdl-spec-citation-snapshot.mjs`, which needs the
 *    `hadron` CLI and a token; CI only reads the file). A missing, empty or
 *    malformed snapshot FAILS. Qualified citations into any other memory are
 *    not judged here: this snapshot says nothing about them.
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
const SNAPSHOT_PATH = 'scripts/sdl-spec-citations-snapshot.txt';
const SNAPSHOT = join(REPO, SNAPSHOT_PATH);
/**
 * The corpus the snapshot describes (the refresh script imports this, so the id is spelled once).
 * Qualified citations are judged only against it.
 */
export const SPECS_MEMORY = 'hadronmemory.com:specs';
/**
 * The whole token before a citation must be exactly `<scheme>:node:<SPECS_MEMORY>:`, from the token's
 * own start, so a URN nested inside another token never counts. Case-sensitive, like the portal gate's
 * `isQualified` (`startsWith('hrn:node:')`): an upper-case scheme is not qualified at all.
 */
const SPECS_TOKEN_PREFIX = new RegExp(String.raw`^(?:hrn|urn):node:${SPECS_MEMORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:$`);

/** hadron-portal scripts/check-bare-loc-citations.mjs `SPEC_CITATION`, verbatim. */
export const SPEC_CITATION = String.raw`cor:[a-z]{3}:\d{3}(?::\d{2})*`;
const CITATION = new RegExp(String.raw`\b${SPEC_CITATION}`, 'g');
const TOKEN_CHARS = /[A-Za-z0-9_.:-]/;

/** Where the URN-ish token that contains `index` starts. */
function tokenStart(line, index) {
  let start = index;
  while (start > 0 && TOKEN_CHARS.test(line[start - 1])) start--;
  return start;
}

/** Is the citation at `index` inside a fully qualified token? (The portal gate's `isQualified`.) */
function isQualified(line, index) {
  const token = line.slice(tokenStart(line, index));
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

/**
 * Annotation DATA escaping (GitHub's workflow-command rules): `%`, CR and LF, so a multi-line message
 * cannot end the annotation at its first newline or smuggle a second command.
 */
export function escapeAnnotationData(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** A range tail: a dash (hyphen, en or em), optional spaces, then `:` and a rule number. */
const DASH = '[–—−-]';
/** A dash then `:`, or a dash then a digit with no space (`…:14-17`): either way it is a range, never prose. */
const TAIL_START = new RegExp(String.raw`^(?:\s*${DASH}\s*:|${DASH}\d)`);
/** The tail must end at a token boundary: `:17:02` and `:17abc` are NOT a read of `:17`. */
const TAIL = new RegExp(String.raw`^\s*${DASH}\s*:(\d{2})(?![\w]|:\d)`);

/**
 * One scan for both exports (`main()` calls this once). `citations` is every fully qualified citation into the specs corpus
 * (without its URN prefix); `problems` is every range tail that could not be read.
 * A range (`…:14–:17`, spaced or em-dashed, chained `…:14–:17–:19`) returns its head AND each tail, so a
 * range that ends on a rule that is not written fails; the rules between are not checked (a gap there is
 * not an error). A tail that is not `:` plus exactly two digits, or that hangs off a head with no rule
 * number, is a PROBLEM and is never skipped silently. A citation repeated on one line is returned once.
 */
export function scanQualified(source) {
  const citations = [];
  const problems = [];
  for (const [i, line] of source.split('\n').entries()) {
    const seen = new Set();
    const add = (citation) => {
      if (seen.has(citation)) return;
      seen.add(citation);
      citations.push({ line: i + 1, citation });
    };
    for (const m of line.matchAll(CITATION)) {
      const afterHead = line.slice(m.index + m[0].length);
      // The portal's whole-run test rejects a hyphen straight after the head; a hyphen that opens a range
      // tail (`:14-:17`) is a range, not an identifier, so it is not skipped here (it would go unchecked).
      if (!isQualified(line, m.index) || !(isWholeSpecCitation(line, m.index + m[0].length) || TAIL_START.test(afterHead))) continue;
      if (!SPECS_TOKEN_PREFIX.test(line.slice(tokenStart(line, m.index), m.index))) continue;
      add(m[0]);
      let rest = afterHead;
      const hasRule = /:\d{2}$/.test(m[0]);
      while (TAIL_START.test(rest)) {
        const t = TAIL.exec(rest);
        if (!t || !hasRule) {
          problems.push({ line: i + 1, text: `${m[0]}${rest.slice(0, 24).trimEnd()}` });
          break;
        }
        add(m[0].replace(/:\d{2}$/, `:${t[1]}`));
        rest = rest.slice(t[0].length);
      }
    }
  }
  return { citations, problems };
}

export function findQualifiedCitations(source) {
  return scanQualified(source).citations;
}

/** Range tails the gate could not read: `{ line, text }`. The gate fails on any. */
export function findRangeTailProblems(source) {
  return scanQualified(source).problems;
}

/**
 * The snapshot: one written citation per line; `#` comments and blanks ignored.
 * THROWS on anything else (a key that is not a whole citation, extra fields, a
 * duplicate) and on an EMPTY inventory, which would otherwise fail every
 * citation for the wrong reason, or, worse, be mistaken for "nothing to check".
 */
export function parseSnapshot(raw) {
  const out = new Set();
  const problems = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (!WHOLE_CITATION.test(t)) problems.push(`line ${i + 1}: "${t}" is not one whole spec citation`);
    else if (out.has(t)) problems.push(`line ${i + 1}: ${t} is listed twice`);
    else out.add(t);
  }
  if (!problems.length && out.size === 0) problems.push('the snapshot lists no citation');
  if (problems.length) throw new Error(`malformed snapshot:\n  ${problems.join('\n  ')}`);
  return out;
}

/** The qualified citations that name no written spec in `snapshot`. */
export function missingFromSnapshot(qualified, snapshot) {
  return qualified.filter((q) => !snapshot.has(q.citation));
}

export const WHOLE_CITATION = new RegExp(String.raw`^${SPEC_CITATION}$`);

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
    console.error(`::error::${escapeAnnotationData(`check-sdl-spec-citations: cannot diff against base "${base}" (${e.message.split('\n')[0]}). Fetch it, or pass a base ref.`)}`);
    process.exit(2);
  }
  let baseline;
  try {
    baseline = parseBaseline(readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`::error file=scripts/sdl-spec-citations-baseline.txt::${escapeAnnotationData(e.message)}`);
    process.exit(1);
  }

  let snapshot;
  try {
    snapshot = parseSnapshot(readFileSync(SNAPSHOT, 'utf8'));
  } catch (e) {
    console.error(`::error file=${SNAPSHOT_PATH}::${escapeAnnotationData(e.message)}`);
    process.exit(1);
  }

  const source = readFileSync(TYPEDEFS, 'utf8');
  const scanned = scanQualified(source);
  const missing = missingFromSnapshot(scanned.citations, snapshot);
  const badTails = scanned.problems;
  const found = findBareCitations(source);
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
  for (const b of badTails) {
    console.error(
      `::error file=${TYPEDEFS_PATH},line=${b.line}::${escapeAnnotationData(
        `range tail not readable after "${b.text}": a range tail is a dash then ':' and exactly two digits (…:14–:17), ` +
          'and it must hang off a citation that ends in a rule number. Write the tail that way, or cite each rule on its own.',
      )}`,
    );
  }
  for (const m of missing) {
    console.error(
      `::error file=${TYPEDEFS_PATH},line=${m.line}::` +
        escapeAnnotationData(
          `spec citation ${m.citation} names no written spec in ${SNAPSHOT_PATH}. ` +
            'Check the citation against the corpus (`hadron spec get <citation> -m hadronmemory.com:specs`). If the rule was written after the ' +
            'snapshot, refresh it: node scripts/refresh-sdl-spec-citation-snapshot.mjs. A placeholder does not count as written.',
        ),
    );
  }
  if (added.length || over.length || missing.length || badTails.length) {
    console.error(
      `\n✗ ${added.length} bare citation(s) on added lines, ${over.length} citation(s) above the baseline, ` +
        `${missing.length} qualified citation(s) naming no written spec, ${badTails.length} unreadable range tail(s). SDL citations must be fully qualified and must exist.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ No bare spec citations on lines added since ${base}; ${found.length} pre-existing bare, within the baseline; ` +
      `every qualified citation names a written spec in the snapshot (${snapshot.size}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
