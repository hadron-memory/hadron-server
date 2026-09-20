/**
 * SDL hash-comment gate (#1232).
 *
 * `graphql-markdown` renders `"""…"""` descriptions and **discards `#`
 * comments**. A contract written with `#` is therefore invisible in the
 * published GraphQL reference — while looking, in this file, exactly like
 * documentation. The author has every reason to believe the surface is
 * documented.
 *
 * The instance that motivated this gate: `saveChatSummary` carried a prominent
 * "#1115 — READ THIS BEFORE CALLING" warning (that calling it makes the
 * transcript LONGER) written as `#`. It reached nobody. `chatHistory` and
 * `summarizationNeeded` were empty in the reference the same way.
 *
 * ## The rule
 *
 * A `#` block sitting immediately above a declaration that has **no
 * description of its own** is a finding — because that declaration renders
 * EMPTY in the published reference.
 *
 * That is the whole predicate, and it deliberately makes no judgement about
 * the TEXT. The issue proposed failing on comments whose wording "looks
 * caller-facing", which no script can decide and every author would argue
 * with. This asks a question with an answer: does the symbol a reader looks up
 * have a description, or does it not? A `#` block above a declaration that
 * ALREADY carries `"""…"""` is fine and is not reported — the published doc
 * exists, and the `#` is a note to a reader of this file, which is what `#`
 * is FOR.
 *
 * ## The allow-list
 *
 * `scripts/sdl-hash-descriptions-allowed.txt` holds the deliberate exceptions,
 * keyed by SYMBOL (`Mutation.updateMyProfile`, `ChatStartResult`) rather than
 * by line, so the list survives edits above it.
 *
 * Nearly every entry is one shape: a **section label** sitting above the first
 * declaration of a group — "User management", "── Chat types ──". Those are
 * the case the triage did not expect and the reason this gate cannot simply
 * auto-convert: the text is perfectly good prose, it is caller-facing in tone,
 * and it is NOT about the declaration underneath it. Converting "User
 * management" into `updateMyProfile`'s description would publish a section
 * heading as one mutation's documentation — worse than the empty string,
 * because it reads as deliberate.
 *
 * Adding an entry is the cost of keeping such a note. That is the point: a NEW
 * `#` block above an undocumented symbol must be declared, so the judgement is
 * recorded where the next person will see it instead of being re-made silently.
 *
 * ## What it deliberately does NOT catch
 *
 * A declaration with NO comment at all. This gate is about prose that exists
 * and does not reach the reader, not about coverage — "every field must be
 * documented" is a different rule with a much larger bill, and folding it in
 * here would make this check impossible to land.
 *
 * It also cannot tell whether a `"""` description is any GOOD. `check:sdl-enums`
 * (#1103) covers one slice of that (descriptions that enumerate a set must
 * enumerate all of it); the rest is review.
 *
 * Run: pnpm check:sdl-hash-docs   (CI runs this exact command)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPEDEFS = join(HERE, '../src/api/graphql/schema/typeDefs.ts');
const ALLOWLIST = join(HERE, 'sdl-hash-descriptions-allowed.txt');

const TYPE_DECL = /^\s*(?:extend\s+)?(type|input|enum|interface|union|scalar)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const FIELD_DECL = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(.*)?:\s*\[?[A-Za-z_]/;
/** A field whose argument list opens on this line and closes on a later one. */
const FIELD_MULTILINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/;
/**
 * An enum VALUE — a bare name with no colon, so it matches neither of the
 * above. Without this the block resolves to no symbol and is dropped SILENTLY,
 * which lets the gate pass exactly the invisible documentation it exists to
 * reject (@codex, PR #1244). Zero such sites exist today, which is the only
 * reason this was not already a live miss — the gate's job is the next one.
 *
 * The optional trailing group accepts a DIRECTIVE, so a documented
 * `OLD @deprecated(reason: "Use NEW")` is still recognized (@codex, second
 * round). An end-anchored name would have reopened the identical hole for
 * precisely the enum values most likely to carry a note.
 */
const ENUM_VALUE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:@\w[^\n]*)?$/;

/**
 * Classify every line of the SDL template literal, tracking `"""` state.
 *
 * Load-bearing: a `#` inside a `"""` block is TEXT, not a comment. A scanner
 * that misses this reports description prose as an undocumented comment — the
 * first version of this one did, and it inflated the population by ~30 sites
 * before the triage caught it.
 */
function classify(lines, end) {
  const kind = new Array(end).fill('code');
  let inBlock = false;
  for (let i = 1; i < end; i++) {
    const t = lines[i].trim();
    if (inBlock) {
      kind[i] = 'desc';
      if (t.endsWith('"""')) inBlock = false;
      continue;
    }
    if (t.startsWith('"""')) {
      kind[i] = 'desc';
      // A one-line """x""" both opens and closes; a bare """ opens only.
      if (!(t.length >= 6 && t.endsWith('"""'))) inBlock = true;
      continue;
    }
    // Single-line "x" descriptions are descriptions too.
    if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) {
      kind[i] = 'desc';
      continue;
    }
    if (t.startsWith('#')) kind[i] = 'hash';
    else if (t === '') kind[i] = 'blank';
  }
  return kind;
}

/** Every `#` block that sits above a declaration, with the symbol it precedes. */
export function findHashBlocks(source) {
  const lines = source.split('\n');
  const end = lines.findIndex((l, i) => i > 0 && l === '`;');
  if (end < 0) throw new Error('typeDefs.ts: could not find the end of the SDL template literal.');
  const kind = classify(lines, end);

  // Track the enclosing type so a field's symbol is `Parent.field`, which is
  // what a reader looks up and what an allow-list entry can be keyed on.
  //
  // Also track an OPEN argument list. A declaration inside one is an ARGUMENT,
  // not a field — `castWorker(… name: String)` is not `Mutation.name` — and
  // arguments carry `"""` descriptions of their own, which the generator
  // renders. Without this the symbol is wrong in the error message and, worse,
  // an allow-list entry keyed on it would be a key for a thing that is not there.
  const enclosing = new Array(end).fill(null);
  const enclosingKind = new Array(end).fill(null);
  const inArgsOf = new Array(end).fill(null);
  let current = null;
  let currentKind = null;
  let depth = 0;
  let argField = null;
  let parens = 0;
  for (let i = 1; i < end; i++) {
    if (kind[i] !== 'code') {
      enclosing[i] = current; enclosingKind[i] = currentKind; inArgsOf[i] = argField; continue;
    }
    const m = TYPE_DECL.exec(lines[i]);
    if (m && lines[i].includes('{')) {
      current = m[2]; currentKind = m[1]; depth = 1; enclosing[i] = null; continue;
    }
    enclosing[i] = current;
    enclosingKind[i] = currentKind;
    inArgsOf[i] = argField;
    if (parens === 0) {
      const opener = FIELD_MULTILINE.exec(lines[i]);
      if (opener) { argField = opener[1]; }
    }
    for (const ch of lines[i]) {
      if (ch === '(') parens++;
      else if (ch === ')') { parens = Math.max(0, parens - 1); if (parens === 0) argField = null; }
    }
    if (parens === 0 && !FIELD_MULTILINE.test(lines[i])) argField = null;
    if (depth > 0) {
      for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
      if (depth <= 0) { current = null; currentKind = null; depth = 0; }
    }
  }

  const blocks = [];
  let i = 1;
  while (i < end) {
    if (kind[i] !== 'hash') { i++; continue; }
    const from = i;
    const text = [];
    // Blank lines INSIDE a comment block keep it one block — two `#` runs
    // separated by a blank are one note, and splitting them reports it twice.
    while (
      i < end &&
      (kind[i] === 'hash' ||
        (kind[i] === 'blank' &&
          (() => { let k = i; while (k < end && kind[k] === 'blank') k++; return kind[k] === 'hash'; })()))
    ) {
      if (kind[i] === 'hash') text.push(lines[i].trim().replace(/^#+ ?/, ''));
      i++;
    }
    let j = i;
    while (j < end && kind[j] === 'blank') j++;
    const next = lines[j] ?? '';

    // A description can sit on EITHER side of the comment, and both attach to
    // the same declaration — GraphQL treats comments as ignored tokens, so
    // `"""doc""" # note \n field` documents `field` exactly as the other order
    // does. Only looking forward reports such a field as undocumented, and
    // "fixing" it emits a SECOND description block next to the first, which is
    // a syntax error. Found by check-graphql-sdl on the first conversion run;
    // exactly ONE site in this file has that order today (`Mutation.startChat`),
    // which is precisely why the forward-only check survived being written.
    let back = from - 1;
    while (back > 0 && kind[back] === 'blank') back--;
    const precededByDescription = back > 0 && kind[back] === 'desc';

    let symbol = null;
    let documented = false;
    if (kind[j] === 'desc' || precededByDescription) {
      documented = true;
    } else {
      const t = TYPE_DECL.exec(next);
      const f = FIELD_DECL.exec(next) ?? FIELD_MULTILINE.exec(next);
      if (t) symbol = t[2];
      else if (f && inArgsOf[j]) {
        // An argument: `Mutation.castWorker(name:)`.
        symbol = `${enclosing[j] ?? '?'}.${inArgsOf[j]}(${f[1]}:)`;
      } else if (f) symbol = enclosing[j] ? `${enclosing[j]}.${f[1]}` : f[1];
      else if (enclosingKind[j] === 'enum') {
        const v = ENUM_VALUE.exec(next);
        if (v) symbol = `${enclosing[j]}.${v[1]}`;
      }
    }
    if (symbol || documented) {
      blocks.push({ line: from + 1, symbol, documented, text: text.join('\n') });
    }
  }
  return blocks;
}

/** Allow-list entries — one symbol per line; `#` comments and blanks ignored. */
function readAllowList() {
  const raw = readFileSync(ALLOWLIST, 'utf8');
  const entries = new Map();
  for (const [n, line] of raw.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [symbol, ...why] = t.split(/\s+—\s+|\s+--\s+/);
    entries.set(symbol.trim(), { reason: why.join(' ').trim(), line: n + 1 });
  }
  return entries;
}

function main() {
  const blocks = findHashBlocks(readFileSync(TYPEDEFS, 'utf8'));
  const allowed = readAllowList();

  const undocumented = blocks.filter((b) => !b.documented && b.symbol);
  const findings = undocumented.filter((b) => !allowed.has(b.symbol));
  const used = new Set(undocumented.map((b) => b.symbol));
  // A stale allow-list entry is its own small defect: it records a judgement
  // about a site that no longer exists, so the next reader trusts a note about
  // nothing. Report it, but do not fail on it — removing prose should never
  // require editing an allow-list in the same commit.
  const stale = [...allowed.keys()].filter((s) => !used.has(s));

  for (const f of findings) {
    const first = f.text.split('\n')[0].slice(0, 100);
    console.error(
      `::error::typeDefs.ts:${f.line}: \`#\` comment above ${f.symbol}, which has no """description""" — ` +
        `this text is DISCARDED by the docs generator and ${f.symbol} renders empty in the published reference.\n` +
        `  ${first}\n` +
        `  Fix: make it a """…""" description. If it is a section label or an internal note that must stay a ` +
        `comment, add "${f.symbol}" to scripts/sdl-hash-descriptions-allowed.txt with a reason.`,
    );
  }
  if (stale.length) {
    console.warn(
      `note: ${stale.length} allow-list entr${stale.length === 1 ? 'y' : 'ies'} no longer match a site ` +
        `(remove from sdl-hash-descriptions-allowed.txt): ${stale.join(', ')}`,
    );
  }

  if (findings.length) {
    console.error(
      `\n✗ ${findings.length} \`#\` comment(s) above an undocumented symbol — each renders EMPTY in the published GraphQL reference.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ No \`#\` comments above undocumented symbols ` +
      `(${blocks.length} comment block(s) scanned, ${allowed.size} allowed exception(s)).`,
  );
}

// argv[1] is undefined under `node -e` / some import paths, and an unguarded
// pathToFileURL throws there — which would make merely IMPORTING this module
// (as its test does) fail before a single assertion ran.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
