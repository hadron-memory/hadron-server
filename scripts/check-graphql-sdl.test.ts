/**
 * The #1076 half of the SDL gate — proven to FAIL, not merely to pass.
 *
 * Two things this file is careful about, both inherited from @Gil's port in
 * hadron-portal (#751, PR #757):
 *
 * 1. **The fixtures cannot be template literals.** His first draft wrote `` \` ``
 *    in the fixture source — an ESCAPED backtick, which terminates nothing — so
 *    the fixtures could not reproduce the defect and the tests passed while
 *    proving nothing. A bare backtick cannot appear inside a template literal,
 *    which is precisely why it ends one. Here every fixture is built by joining
 *    single-quoted lines, where a bare backtick is just a character.
 * 2. **The escaped form must NOT fire.** It is this repo's actual idiom (71 of
 *    them in typeDefs.ts today), so a check that rejected it would be reverted
 *    the same day. Pinned explicitly, below.
 *
 * The exit code is asserted separately from the output: a check that reports an
 * offender and exits 0 is a phantom gate.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSdlDir, findBrokenSdlLiterals, scanTaggedLiterals } from './check-graphql-sdl.mjs';

const BACKTICK = '`';
const SCRIPT = join(process.cwd(), 'scripts', 'check-graphql-sdl.mjs');

/** Assemble a fixture file from lines, so a bare backtick can be written. */
const lines = (...l: string[]) => l.join('\n');

/** A well-formed SDL module: opens with the marker, closes first-on-its-line. */
function sdl(...body: string[]) {
  return lines('export const typeDefs = ' + BACKTICK + '#graphql', ...body, BACKTICK + ';', '');
}

/** Run the real CLI against a throwaway directory holding one .ts file. */
function runOn(source: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sdl-gate-'));
  try {
    writeFileSync(join(dir, 'typeDefs.ts'), source);
    try {
      const out = execFileSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stderr: string; stdout: string };
      return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-graphql-sdl — the literal is intact', () => {
  it('FAILS on a bare backtick in a # comment, naming that line', () => {
    const r = runOn(
      sdl(
        '  type Worker {',
        '    # the ' + BACKTICK + 'name' + BACKTICK + ' argument (#1050)',
        '    name: String!',
        '  }',
      ),
    );
    expect(r.code).toBe(1);
    // 1 = the const, 2 = "type Worker {", 3 = the comment with the backtick.
    expect(r.out).toContain('typeDefs.ts:3');
    expect(r.out).toContain('# comment');
  });

  it('FAILS on a bare backtick in a description, outside any comment', () => {
    const r = runOn(
      sdl(
        '  """',
        '  Computed from ' + BACKTICK + 'handle' + BACKTICK + ', never stored.',
        '  """',
        '  type User { id: ID! }',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('typeDefs.ts:3');
    // The message must not claim a comment it did not find.
    expect(r.out).not.toContain('# comment');
  });

  it('FAILS on a comment backtick that is NOT at the start of the line', () => {
    // A GraphQL comment runs to end-of-line, so a trailing one truncates the
    // document just as early — and what is left can still be valid SDL, which
    // is how a parse-only gate reports success on a file that will not build.
    const r = runOn(sdl('  type Q { id: ID! } # see ' + BACKTICK + 'id' + BACKTICK));
    expect(r.code).toBe(1);
    expect(r.out).toContain('typeDefs.ts:2');
  });

  it('FAILS on a literal with no terminator anywhere below it', () => {
    // The odd-backtick case does NOT reach here: the stray one IS a terminator,
    // and the check above names it. This branch is the file whose closing
    // `` `; `` was deleted, where there is no line to name at all.
    const r = runOn(
      lines('export const typeDefs = ' + BACKTICK + '#graphql', '  type Q { id: ID! }', ''),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('never terminated');
    expect(r.out).toContain('typeDefs.ts:1');
  });

  it('does NOT fire on the ESCAPED backtick this repo actually uses', () => {
    const r = runOn(
      sdl('  # Omit \\`fields\\` to let the server sniff.', '  type Q { id: ID! }'),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 SDL template literal(s) intact');
  });

  it('does NOT fire on a single-line SDL document', () => {
    const r = runOn(
      'export const typeDefs = ' + BACKTICK + '#graphql type Q { id: ID! }' + BACKTICK + ';\n',
    );
    expect(r.code).toBe(0);
  });

  it('FAILS when there is no SDL document to check at all', () => {
    // The anti-phantom case: if the SDL moves or drops its marker, a gate that
    // scanned nothing must not report a clean run.
    const r = runOn('export const typeDefs = "type Q { id: ID! }";\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('gate was checking nothing');
  });

  it('FAILS on a description line that STARTS with a backtick', () => {
    // Codex P2 on PR #1085, and a hole in the hadron-portal check this was
    // ported from: a position-only rule reads a leading backtick as the
    // document's own terminator, reports the literal intact, and hands back the
    // very cascade the gate translates. A markdown code span reaches it.
    const r = runOn(
      sdl(
        '  """',
        '  Example:',
        '  ' + BACKTICK + 'query { me { id } }' + BACKTICK + ' is the shape.',
        '  """',
        '  type Q { id: ID! }',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('typeDefs.ts:4');
    expect(r.out).toContain('starts the line like a terminator');
  });

  it('FAILS on a fenced block opening a line inside a description', () => {
    const r = runOn(
      sdl('  """', '  ' + BACKTICK.repeat(3) + 'graphql', '  """', '  type Q { id: ID! }'),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('typeDefs.ts:3');
  });

  it('FAILS on a code span that opens a line AND begins with a semicolon', () => {
    // Codex's second pass on PR #1085: `` `;` ends a statement. `` satisfies
    // both "starts the line" and "followed by a semicolon", so a PREFIX-shaped
    // shape check waved it through. Being told narrower twice means the shape
    // is wrong, not the width — the whole line is the unit now.
    const r = runOn(
      sdl(
        '  """',
        '  ' + BACKTICK + ';' + BACKTICK + ' ends a statement.',
        '  """',
        '  type Q { id: ID! }',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('typeDefs.ts:3');
  });

  it('refuses a TypeScript continuation, and says so instead of saying "escape it"', () => {
    // Declined finding, pinned: a real `.trim()` / `as const` continuation is
    // refused on purpose (see the rationale in check-graphql-sdl.mjs). What
    // must NOT happen is sending that author to the wrong fix, so the message
    // names the alternative reading. The rule is the strictness; this is the
    // honesty about it.
    const r = runOn(
      lines(
        'export const typeDefs = ' + BACKTICK + '#graphql',
        '  type Q { id: ID! }',
        BACKTICK + '.trim();',
        '',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('widen closesAnExpression');
  });

  it('does NOT fire on a terminator carrying a trailing line comment', () => {
    const r = runOn(
      lines(
        'export const typeDefs = ' + BACKTICK + '#graphql',
        '  type Q { id: ID! }',
        BACKTICK + '; // the single SDL source',
        '',
      ),
    );
    expect(r.code).toBe(0);
  });

  it('does NOT fire when a legitimate terminator is followed by a comma', () => {
    // The SDL is a `;` today, but a literal passed inline closes on `,` or `)`.
    const r = runOn(
      lines(
        'export const schemas = [',
        '  ' + BACKTICK + '#graphql',
        '  type Q { id: ID! }',
        '  ' + BACKTICK + ',',
        '];',
        '',
      ),
    );
    expect(r.code).toBe(0);
  });

  it('reports the plain multi-line TS template literals it must ignore', () => {
    // Without the #graphql marker this check would fire on ordinary prose,
    // whose closing backtick legitimately sits at the end of a line.
    const found = findBrokenSdlLiterals(
      'x.ts',
      lines('const msg = ' + BACKTICK + 'hello', 'world' + BACKTICK + ';', ''),
    );
    expect(found.offenders).toEqual([]);
    expect(found.documents).toBe(0);
  });
});

describe('check-graphql-sdl — against the real SDL', () => {
  it('FAILS on the real typeDefs.ts with ONE of its escaped backticks unescaped', () => {
    // Planted from the TREE, not from my model of the tree: the last gate I
    // shipped passed everywhere because its fixtures used an idiom the real
    // file does not. So this takes the actual 7400-line SDL, unescapes the
    // FIRST `\`` it already contains, and requires the check to name that line.
    const real = readFileSync(join(process.cwd(), 'src/api/graphql/schema/typeDefs.ts'), 'utf8');
    const at = real.indexOf('\\' + BACKTICK);
    expect(at).toBeGreaterThan(0);
    const broken = real.slice(0, at) + real.slice(at + 1);
    const expectedLine = broken.slice(0, at).split('\n').length;

    const r = runOn(broken);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`typeDefs.ts:${expectedLine}`);
  });

  it('finds exactly one document in src/api/graphql/schema, and it is intact', () => {
    // Runs the check against the real corpus rather than a fixture: proving a
    // check fails on a planted defect does not prove it is pointed at anything
    // (hadron-docs:review:proving-a-check-fails-does-not-prove-it-runs).
    const scan = scanSdlDir();
    expect(scan.documents).toBe(1);
    expect(scan.offenders).toEqual([]);
  });
});

/**
 * #1087 — the same hazard in TAGGED literals ($queryRaw / $executeRaw /
 * Prisma.sql), which is where it actually bit an hour after #1076 shipped.
 *
 * The three PASS cases are not padding: each is a false positive the first
 * draft of this widening actually produced against the real repo. The issue
 * claimed the detection rule "ports without change"; it does not, and these
 * pin the two ways it had to change.
 */
describe('check-graphql-sdl — tagged raw-SQL literals (#1087)', () => {
  /** Write files into a throwaway src-like tree and scan it. */
  function scanFiles(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'sql-gate-'));
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
      return scanTaggedLiterals(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('FAILS on the incident: a backtick in a SQL comment (#1087)', () => {
    const src = lines(
      'const rows = await ctx.db.$queryRaw<Row[]>' + BACKTICK,
      '  SELECT id,',
      '    -- ' + BACKTICK + 'auto_expired_at' + BACKTICK + ' is set on precisely those rows',
      '    CASE WHEN s.auto_expired_at IS NULL THEN s.updated_at END',
      '  FROM sessions' + BACKTICK + ';',
      '',
    );
    const { offenders, documents } = scanFiles({ 'q.ts': src });
    expect(documents).toBe(1);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].line).toBe(3);
    expect(offenders[0].errors.join(' ')).toMatch(/ends the raw-SQL template literal early/);
    // The message names the literal's OPENING line, which is the context a bare
    // TS1005 omits and the reason this gate is not redundant with tsc.
    expect(offenders[0].errors.join(' ')).toMatch(/the literal opens on line 1/);
  });

  it('does NOT fire on a terminator at the END of a content line', () => {
    // The POSITION half of the SDL rule does not port. SQL closes on its last
    // content line far more often than on a line of its own, and requiring
    // first-on-line reported 41 offenders across a repo that compiles cleanly.
    const src = lines(
      'const rows = await db.$queryRaw<{ cname: string }[]>' + BACKTICK,
      '    SELECT c.name AS cname',
      '    FROM unnest(${names}::text[]) AS c(name)' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it('does NOT fire on PROSE that mentions a tag inside a code span', () => {
    // Eight of the first reports were comments talking ABOUT raw SQL: the code
    // span's closing backtick in ``$executeRawUnsafe`` looked exactly like a
    // literal's opening one. A tag preceded by a backtick is a mention.
    const src = lines(
      '// The identifier loops cannot use this form and stay ' +
        BACKTICK + '$executeRawUnsafe' + BACKTICK + ' with a',
      '// documented safety argument (#665).',
      'const x = await tx.$executeRaw' + BACKTICK + 'UPDATE t SET a = ${b}' + BACKTICK + ';',
      '',
    );
    const { offenders, documents } = scanFiles({ 'm.ts': src });
    expect(documents).toBe(1); // the mention is not counted as a document either
    expect(offenders).toEqual([]);
  });

  it('scans .test.ts too — a broken literal there breaks tsc repo-wide', () => {
    const src = lines(
      'const r = await db.$queryRaw' + BACKTICK,
      '  -- see ' + BACKTICK + 'workers' + BACKTICK,
      '  SELECT 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.test.ts': src }).offenders).toHaveLength(1);
  });

  it('FAILS on a backtick that ENDS a -- comment line (@codex P2, #1109)', () => {
    // The false negative that dropping the POSITION rule created: with position
    // relaxed, an EMPTY remainder satisfies the shape check, so this backtick
    // was accepted as the literal's terminator and the real closer below was
    // never examined. A silent pass, which is the failure this gate exists to
    // prevent.
    const src = lines(
      'const r = await db.$queryRaw' + BACKTICK,
      '  SELECT 1',
      '  -- accidental backtick at end of comment ' + BACKTICK,
      '  FROM t' + BACKTICK + ';',
      '',
    );
    const { offenders } = scanFiles({ 'a.ts': src });
    expect(offenders).toHaveLength(1);
    // Line 4, not 3: the parser reports where IT stopped, which is at or just
    // past the stray backtick rather than exactly on it. That is the one
    // precision the tokeniser costs against the old text scanner, and it buys
    // correctness on six edges the scanner got wrong — the message names the
    // literal's opening line so the reader has both ends of the range.
    expect(offenders[0].line).toBe(4);
  });

  it('scans a literal whose GENERIC spans lines (@codex P2, #1109)', () => {
    // `<[^`\n]*>` skipped four real literals outright — and a skipped literal
    // is invisible: no offender, while the anti-phantom count stays healthy on
    // the other hundred. Bounded by "no backtick" instead of "no newline".
    const src = lines(
      'const rows = await ctx.db.$queryRaw<',
      '  { workerId: string; live: boolean }[]',
      '>' + BACKTICK,
      '  SELECT s.worker_id',
      '  -- ' + BACKTICK + 'worker_id' + BACKTICK + ' is the column',
      '  FROM sessions' + BACKTICK + ';',
      '',
    );
    const { offenders, documents } = scanFiles({ 'b.ts': src });
    expect(documents).toBe(1);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].line).toBe(5);
  });

  it('does NOT fire when the closer sits on the NEXT line', () => {
    // The three legitimate shapes that a "require a non-empty closer" rule
    // rejected — the second wrong proxy on the way to keying on comment
    // context. A ternary branch and a query closing on its own line both leave
    // the terminator's line empty after the backtick.
    const src = lines(
      'const p = cond',
      '  ? Prisma.sql' + BACKTICK + 'e.memory_id IN (${ids})' + BACKTICK,
      '  : Prisma.sql' + BACKTICK + 'e.user_id = ${uid}' + BACKTICK + ';',
      'const q = await db.$queryRaw<{ xmin: string }[]>' + BACKTICK,
      '  SELECT xmin::text FROM memories WHERE id = ${id}',
      BACKTICK,
      ';',
      '',
    );
    expect(scanFiles({ 'c.ts': src }).offenders).toEqual([]);
  });

  it('FAILS on a comment that starts on the OPENING line (@codex P2, #1109)', () => {
    // The hole my first fix for the single-line-SDL regression opened:
    // suppressing the comment test on the opening line hid a SQL comment that
    // begins immediately after the tag. Keying on the literal's BODY rather
    // than on the line handles both without a special case.
    const src = lines(
      'const a = await db.$queryRaw' + BACKTICK + '-- accidental ' + BACKTICK,
      '  SELECT 1' + BACKTICK + ';',
      '',
    );
    const { offenders } = scanFiles({ 'a.ts': src });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].line).toBe(2);
  });

  it('does NOT fire on a valid query ENDING in a line comment (@codex P2, #1109)', () => {
    // The false POSITIVE that finally showed the heuristic approach was wrong:
    // here the backtick IS the terminator and the SQL comment simply runs to
    // the end of the literal. Ordinary code, flagged as broken.
    const src = lines(
      'const a = await db.$queryRaw' + BACKTICK + 'SELECT 1 -- explanation' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'a.ts': src }).offenders).toEqual([]);
  });

  it('FAILS on a backtick inside a /* block */ comment (@codex P2, #1109)', () => {
    // The text scanner only ever learned `--`; the parser needs no SQL lexicon
    // at all, so block comments come for free rather than as a sixth clause.
    const src = lines(
      'const b = await db.$queryRaw' + BACKTICK,
      '  SELECT 1',
      '  /* explanation ' + BACKTICK,
      '  */ FROM t' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'b.ts': src }).offenders).toHaveLength(1);
  });

  it('does NOT fire on -- inside a SQL STRING literal (@codex P2, #1109)', () => {
    // `.includes('--')` called a legitimate query broken. Quote parity tells a
    // comment marker from the same characters inside a string.
    const src = lines(
      "const b = await db.$queryRaw" + BACKTICK + "SELECT '--' AS x" + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'b.ts': src }).offenders).toEqual([]);
  });

  it('FAILS when the stray backticks RE-PAIR into valid TypeScript (@codex P1, #1109)', () => {
    // The parser's own blind spot, and the reason the AST check exists beside
    // the diagnostic one: quoting a JS operator in a SQL comment leaves
    // `taggedTemplate && templateExpression` — two literals and an operator,
    // all valid — so TypeScript has NO complaint and half the query is gone.
    const src = lines(
      'const x = await db.$executeRaw' +
        BACKTICK + 'UPDATE u SET a = false -- use ' + BACKTICK + '&&' + BACKTICK + ' for overlap',
      'WHERE id = ${id}' + BACKTICK + ';',
      '',
    );
    const { offenders } = scanFiles({ 'r.ts': src });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].errors.join(' ')).toMatch(/RE-PAIRED into a valid expression/);
  });

  it('FAILS on a CONDITIONAL re-pair too, not just a binary one (@codex P1, #1109)', () => {
    // The first version of the re-pair check enumerated expression kinds and
    // handled `&&` only. Enumerating kinds is the same too-narrow mistake as
    // enumerating SQL comment syntaxes, one level up — so the check now asks a
    // structural question (is there an UNOWNED template literal in this
    // statement?) and this case needed no new clause.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE u SET a=false -- choose ' +
        BACKTICK + ' ? ' + BACKTICK + ' or ' + BACKTICK + ' : ' + BACKTICK + ' for fallback',
      'WHERE id=${id}' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'c.ts': src }).offenders).toHaveLength(1);
  });

  it('FAILS when the re-paired tail is OWNED by a tag named in the comment (@codex P1, #1109)', () => {
    // The unowned-literal rule cannot settle this one: `-- use `&& Prisma.sql``
    // leaves a perfectly OWNED Prisma.sql literal as the tail. What gives it
    // away is the EXECUTOR's own position — you do not `&&` two queries
    // together, so `$executeRaw` in operand position is broken whatever the
    // tail turned out to be. Fragments may compose; executors may not.
    const src = lines(
      'const a = await db.$executeRaw' + BACKTICK + 'UPDATE u SET x=false -- use ' +
        BACKTICK + '&& Prisma.sql' + BACKTICK + ' for overlap',
      'WHERE id=${id}' + BACKTICK + ';',
      '',
    );
    const { offenders } = scanFiles({ 'o.ts': src });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].errors.join(' ')).toMatch(/operand of/);
  });

  it('does NOT fire on a composed Prisma.sql fragment in a ternary', () => {
    // The narrowing control for the rule above: `Prisma.sql`…`` literals in a
    // conditional are OWNED by their tag, which is what separates a legitimate
    // composed fragment from the orphaned tail of a broken query. Real shape,
    // from usageActivity.ts.
    const src = lines(
      'const p = c',
      '  ? Prisma.sql' + BACKTICK + 'a = ${x}' + BACKTICK,
      '  : Prisma.sql' + BACKTICK + 'b = ${y}' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'ok.ts': src }).offenders).toEqual([]);
  });

  it('finds the real repo tagged literals, and they are all intact', () => {
    // Anti-phantom, the same property the SDL half asserts: a scan that found
    // nothing to check must not read as a clean one.
    const { offenders, documents } = scanTaggedLiterals();
    expect(documents).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
