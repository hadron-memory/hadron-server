/**
 * Unscoped-loc-lookup gate.
 *
 * `Node.loc` (and `Edge.loc`) is unique **within a memory** —
 * `@@unique([loc, memoryId])` — never globally. So a lookup keyed on `loc`
 * alone silently resolves to an arbitrary tenant's row. This is not
 * hypothetical: short conventional locs (`preflight`, `instructions`,
 * `start-here`) exist in several memories at once, and the unauthenticated
 * `POST /usage` path attributed a UsageEvent to a stranger's memory because of
 * it (#825).
 *
 * The GraphQL surface already handles this correctly — `node(ref:)` takes a
 * self-scoping PK or URN, and its bare-loc convenience path fails loud with
 * `AMBIGUOUS_NODE_LOC` (#335). This gate covers the code that bypasses that
 * surface and talks to Prisma directly.
 *
 * ## What counts as a violation
 *
 * A `where: { … }` object whose TOP-LEVEL keys include `loc` but not
 * `memoryId`. Both halves of that sentence are load-bearing:
 *
 *   - **Top-level keys only.** `where: { memoryId: m, data: { loc: 1 } }` is
 *     scoped; the nested `loc` is unrelated. Depth tracking, not a line regex.
 *   - **Inside the where object only.** `findFirst({ where: { loc: v },
 *     select: { memoryId: true } })` is a VIOLATION — selecting `memoryId`
 *     does not constrain the lookup. Scanning the whole line would wrongly
 *     exempt it (PR #826 review, Codex P2).
 *   - **Shorthand counts.** `where: { loc }` is the same query as
 *     `where: { loc: loc }`, so a key with no colon is still a `loc` key
 *     (PR #826 review, Codex P2).
 *
 * Safe shapes it deliberately does NOT flag: `loc_memoryId` (a different key —
 * the composite unique), and any where-object that also constrains `memoryId`.
 *
 * Brace matching runs over the whole file, so a `where` clause spanning several
 * lines is checked like any other.
 *
 * Scope: all of `src/`, TESTS INCLUDED (#828). Tests were exempt at first, on
 * the reasoning that a test DB holds one memory with unique locs so the
 * ambiguity is invisible there. That exemption was the problem: invisible is
 * exactly why the habit forms in tests and then walks into production code and
 * throwaway verification scripts. Two of the bugs behind #825 were written by
 * someone fluent in the unscoped shape from test code.
 *
 * ESCAPE HATCH: put `loc-scope-ok:` with a reason in a comment on the line the
 * `where` starts on, or anywhere in the contiguous comment block directly above
 * it (so a wrapped, multi-line justification still counts). Use it for a deliberately
 * cross-memory query (and say why), or for tracked debt (cite the issue).
 *
 * Run: node scripts/check-loc-scope.mjs   (or `pnpm check:loc-scope`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'src';
const MARKER = 'loc-scope-ok:';

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (/\.tsx?$/.test(path)) {
      yield path;
    }
  }
}

/**
 * Blank out comments and string/template literals, preserving length and line
 * breaks so offsets and line numbers still line up. Without this the scanner
 * reads prose — a doc comment quoting `where: { loc, … }` is not a query
 * (PR #826 review).
 */
function blankNonCode(src) {
  const out = src.split('');
  let i = 0;
  const blankTo = (start, end) => {
    for (let k = start; k < end && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let j = src.indexOf('\n', i);
      if (j === -1) j = src.length;
      blankTo(i, j);
      i = j;
    } else if (two === '/*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? src.length : j + 2;
      blankTo(i, j);
      i = j;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      blankTo(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Given the source and the index of the `{` opening a `where` object, return
 * the object's body text (exclusive of the outer braces), or null if unbalanced.
 */
function readObject(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Top-level keys of an object body. Tracks nesting depth so keys of nested
 * objects/arrays don't count, and accepts shorthand (`loc`) as well as
 * `loc:`.
 */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let token = '';
  // A property is `key: value` or bare `key`. Once a `:` is seen at depth 0 we
  // are reading a VALUE until the next depth-0 comma — otherwise `{ targetId:
  // loc }` would read its value as a shorthand `loc` key (PR #826 review).
  let inValue = false;
  const flushKey = () => {
    const t = token.trim();
    if (!inValue && /^[A-Za-z_$][\w$]*$/.test(t)) keys.push(t);
    token = '';
  };
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      token = '';
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      token = '';
    } else if (depth === 0 && ch === ':') {
      flushKey(); // `key:` — an explicit key; the value follows
      inValue = true;
    } else if (depth === 0 && ch === ',') {
      flushKey(); // bare `key,` — property shorthand
      inValue = false;
    } else if (depth === 0) {
      token += ch;
    }
  }
  flushKey(); // trailing shorthand before the closing brace
  return keys;
}

const WHERE = /\bwhere:\s*\{/g;

/**
 * Is the `where` starting on 1-indexed `lineNo` exempted by a marker?
 *
 * Looks on that line, then walks UP through the contiguous comment block
 * directly above it. Requiring the marker on exactly one line was too strict:
 * an exemption is supposed to carry a real reason, and real reasons wrap onto a
 * second line — which silently voided the exemption.
 *
 * Comment-ness is decided by the BLANKED source, not by a `//` / `*` prefix. A
 * prefix test would call a line-broken multiplication (`x = a`, then `  * b`) a
 * comment and let a stale marker reach past real code — weakening the gate by
 * formatting alone (PR #827 review, Copilot). A line that is whitespace-only
 * after blanking, but not empty in the original, is exactly a pure comment
 * line; the marker itself is matched against the RAW text, since blanking
 * erased it.
 */
function isExempt(rawLines, blankLines, lineNo) {
  if ((rawLines[lineNo - 1] ?? '').includes(MARKER)) return true;
  for (let i = lineNo - 2; i >= 0; i--) {
    const raw = rawLines[i] ?? '';
    const blanked = blankLines[i] ?? '';
    const isPureComment = raw.trim() !== '' && blanked.trim() === '';
    if (!isPureComment) break;
    if (raw.includes(MARKER)) return true;
  }
  return false;
}

/**
 * Scan one file's text. Exported so the gate's own behavior is pinned by
 * `check-loc-scope.test.ts` — an unverified gate rots silently, which is the
 * very failure mode it exists to prevent.
 *
 * @returns {Array<{line: number, text: string}>}
 */
export function scanSource(raw) {
  const found = [];
  const src = blankNonCode(raw);
  const lines = raw.split('\n');
  const blankLines = src.split('\n');
  for (const m of src.matchAll(WHERE)) {
    const openIdx = src.indexOf('{', m.index);
    const body = readObject(src, openIdx);
    if (body === null) continue;

    // `loc` must be a top-level KEY of the where object (not a value, not a
    // nested key). `memoryId` anywhere inside that object counts as scoping —
    // it may arrive via a conditional spread (`...(x ? { memoryId } : {})`) or
    // a relation filter, both of which do constrain the lookup. This stays
    // precise because only the WHERE object is inspected: a `select: {
    // memoryId }` sibling is outside it and cannot grant a false exemption.
    const keys = topLevelKeys(body);
    if (!keys.includes('loc') || /\bmemoryId\b/.test(body)) continue;

    const lineNo = src.slice(0, m.index).split('\n').length;
    if (isExempt(lines, blankLines, lineNo)) continue;

    found.push({ line: lineNo, text: (lines[lineNo - 1] ?? '').trim() });
  }
  return found;
}

/** Walk `src/` and report. Only runs when executed directly, not on import. */
function main() {
  const violations = [];
  for (const file of walk(ROOT)) {
    for (const v of scanSource(readFileSync(file, 'utf8'))) {
      violations.push({ file, ...v });
    }
  }

  if (violations.length > 0) {
    console.error(
      '✗ Unscoped loc lookup — `loc` is unique per MEMORY, not globally, so these\n' +
        "  resolve to an arbitrary tenant's row (see #825, and the\n" +
        '  findings:unscoped-loc-lookup-crosses-memories node in Hadron):\n',
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}\n    ${v.text}`);
    }
    console.error(
      '\n  Fix: scope on the composite unique —\n' +
        '    findUnique({ where: { loc_memoryId: { loc, memoryId } } })\n' +
        '  or resolve a PK / fully-qualified URN via resolveNodeRef.\n' +
        `\n  Deliberately cross-memory? Add a "${MARKER} <reason>" comment on the line\n` +
        '  the `where` starts on, or the line above.',
    );
    process.exit(1);
  }

  console.log('✓ No unscoped loc lookups in src/.');
}

// Executed directly (CI / pnpm check:loc-scope) — not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
