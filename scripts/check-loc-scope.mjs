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
 * Flags a `where: { loc: … }` with no `memoryId` in the same clause. Safe
 * shapes it deliberately does NOT flag:
 *   - `findUnique({ where: { loc_memoryId: { loc, memoryId } } })` — the
 *     composite unique (contains `memoryId`).
 *   - any `where` that also constrains `memoryId`.
 *
 * Scope: `src/`, excluding tests. A test DB holds one memory with unique locs,
 * so the ambiguity is invisible there — which is exactly why the habit forms in
 * tests and then leaks into production code and verification scripts. Tightening
 * to tests too is a reasonable follow-up; it would need ~30 existing call sites
 * updated first.
 *
 * KNOWN LIMIT: single-line matching. A `where` clause split across lines slips
 * through. Every occurrence in the codebase today is single-line; this is a
 * cheap gate against the common shape, not a type system.
 *
 * ESCAPE HATCH: put `loc-scope-ok:` with a reason in a comment on the offending
 * line or the line directly above. Use it for a deliberately cross-memory query
 * (and say why), or for tracked debt (cite the issue).
 *
 * Run: pnpm tsx scripts/check-loc-scope.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src';
const MARKER = 'loc-scope-ok:';

/** `where: { loc:` / `where: {loc:` — the Prisma filter shape we care about. */
const WHERE_LOC = /where:\s*\{[^}]*\bloc:/;
/** Any mention of memoryId in the same line means the query is scoped. */
const SCOPED = /memoryId|loc_memoryId/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) {
      yield path;
    }
  }
}

const violations = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!WHERE_LOC.test(line) || SCOPED.test(line)) return;
    // Exempt via a marker on this line or the one above.
    if (line.includes(MARKER) || (i > 0 && lines[i - 1].includes(MARKER))) return;
    violations.push({ file, line: i + 1, text: line.trim() });
  });
}

if (violations.length > 0) {
  console.error(
    '✗ Unscoped loc lookup — `loc` is unique per MEMORY, not globally, so these\n' +
      '  resolve to an arbitrary tenant\'s row (see #825, and the\n' +
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
      '  or the line above.',
  );
  process.exit(1);
}

console.log('✓ No unscoped loc lookups in src/.');
