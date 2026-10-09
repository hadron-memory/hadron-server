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
 * ## The baseline (a ratchet)
 *
 * 128 bare citations predate this gate, and their cleanup is tracked by
 * hadron-portal #781 — the portal only flags ADDED lines, so they cost it
 * nothing until someone edits them. `scripts/sdl-spec-citations-baseline.txt`
 * records how many bare occurrences of each citation existed. A count above its
 * baseline fails, and so does any citation with no baseline entry. Qualifying
 * an old one never fails; lower its count in the baseline when you do (the gate
 * says which), so the ratchet tightens.
 *
 * Counting per citation rather than keying on line numbers keeps the baseline
 * stable under edits elsewhere in the 11k-line file.
 *
 * Run: pnpm check:sdl-spec-citations   (CI runs this exact command)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPEDEFS = join(HERE, '../src/api/graphql/schema/typeDefs.ts');
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

/** Baseline entries: `<citation> <count>`; `#` comments and blanks ignored. */
export function parseBaseline(raw) {
  const out = new Map();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [citation, count] = t.split(/\s+/);
    out.set(citation, Number(count));
  }
  return out;
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

function main() {
  const found = findBareCitations(readFileSync(TYPEDEFS, 'utf8'));
  const { over, lowerable } = compareWithBaseline(found, parseBaseline(readFileSync(BASELINE, 'utf8')));
  for (const o of over) {
    console.error(
      `::error::typeDefs.ts:${o.lines.join(',')}: bare spec citation ${o.citation} (${o.count} bare, baseline ${o.allowed}). ` +
        `Cite it as hrn:node:hadronmemory.com:specs:${o.citation} — the portal's schema-snapshot gate fails a bare one.`,
    );
  }
  if (lowerable.length) {
    console.warn(
      `note: fewer bare citations than the baseline allows; lower these in scripts/sdl-spec-citations-baseline.txt: ` +
        lowerable.map((l) => `${l.citation} ${l.allowed}→${l.count}`).join(', '),
    );
  }
  if (over.length) {
    console.error(`\n✗ ${over.length} citation(s) above the baseline. New SDL citations must be fully qualified.`);
    process.exit(1);
  }
  console.log(`✓ No new bare spec citations in the SDL (${found.length} pre-existing bare, within the baseline).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
