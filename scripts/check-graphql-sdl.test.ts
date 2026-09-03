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
    // The message points at the nearest literal — the context a bare TS1005
    // omits, and the reason this gate is not redundant with tsc — WITHOUT
    // claiming it is the cause, which a parse diagnostic cannot establish
    // (PR #1109 review, @copilot then @codex).
    expect(offenders[0].errors.join(' ')).toMatch(/nearest opening on line 1/);
    expect(offenders[0].errors.join(' ')).toMatch(/cannot tell it from an ordinary syntax error/);
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

  it('DOES fire on a valid query ending in a line comment — the shape is banned (#1110)', () => {
    // EXPECTATION INVERTED, and deliberately: @Holger's ruling (2026-09-03).
    //
    // This was @codex's P2 on #1109 and it is genuinely valid code — the
    // backtick IS the terminator and the SQL comment simply runs to the end of
    // the literal. It is refused anyway, because separating this from the
    // identical-looking broken shape is what six attempts could not do: the
    // version that tried (a second "the query continues past the close"
    // condition) was broken from BOTH sides in one review — an end-of-line
    // backtick passed silently, and `…-- explanation`.then(…)` was flagged.
    //
    // So the shape is banned rather than diagnosed. It costs this idiom; the
    // fix is one line (move the comment up, or close on the next line), and it
    // occurs 0 times in the 105 raw-SQL literals here.
    const src = lines(
      'const a = await db.$queryRaw' + BACKTICK + 'SELECT 1 -- explanation' + BACKTICK + ';',
      '',
    );
    const { offenders } = scanFiles({ 'a.ts': src });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].errors.join(' ')).toMatch(/CLOSES on a line carrying a -- comment/);
  });

  it('#1110: catches a stray backtick at END of its comment line (@codex P2, #1131)', () => {
    // The false NEGATIVE that killed the "query continues past the close"
    // condition: with the backtick last on its line the tail is EMPTY, which
    // that condition read as a clean close while the re-paired continuation sat
    // on the next line. No tail is consulted now.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE u SET a = false -- use ' + BACKTICK,
      '&& ' + BACKTICK + 'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: an interpolated apostrophe cannot hide the comment (@codex P2, #1131)', () => {
    // Reading the RAW source dragged each `${…}`'s TypeScript through a scanner
    // that tracks `'` to tell a SQL string from a comment, so `${"'"}` toggled
    // the quote state and hid the `--` behind it. The cooked segments are read
    // instead, with spans replaced by `?` — which is what the database receives.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE u SET n = ${"\'"} -- x ' +
        BACKTICK + '&&' + BACKTICK + ' y',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: a SQL string spanning LINES cannot hide the comment (@codex P2, #1131)', () => {
    // Scanning only the closing line met the string's CLOSING quote first, read
    // it as an opening one, and treated the real `--` as quoted — hiding a
    // truncated UPDATE. Quote state is only meaningful from where the string
    // began, so the scan carries it across newlines.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + "UPDATE t SET a = 'hello",
      "world' -- use " + BACKTICK + '&&' + BACKTICK + ' z',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: silent on a multi-line SQL string with no comment', () => {
    // The control for the above: carrying quote state must not invent a comment.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + "UPDATE t SET a = 'hello",
      "world'",
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toEqual([]);
  });

  it('#1110: silent when a comment is followed by a STRING on a later line', () => {
    // A comment ends at the newline, so it must not swallow the rest of the
    // query — the reset half of the same walk.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT 1 -- note',
      "WHERE a = 'x'" + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it('#1110: an apostrophe in a "quoted identifier" cannot hide the comment (@codex P2, #1131)', () => {
    // Toggling on `'` alone treated every apostrophe as string syntax, so one
    // inside a double-quoted IDENTIFIER flipped the state and hid the real
    // comment behind it — a truncated UPDATE, passed silently. 11 of this
    // repo's 105 literals contain `"`. Quoted contexts are now skipped whole.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE t SET "owner\'s" = 1 -- use ' +
        BACKTICK + '&&' + BACKTICK + ' z',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: silent on a quoted identifier containing an apostrophe', () => {
    // The control: skipping quoted contexts must not INVENT a comment either.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT "owner\'s" FROM t' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it("#1110: silent on SQL's doubled '' escape", () => {
    // `''` escapes a quote inside a string, so the `--` here is text, not a
    // comment — and the literal closes legitimately.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + "SELECT 'it''s -- not a comment'" + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it('#1110: an apostrophe in a /* block comment */ cannot hide the -- (@codex P2, #1131)', () => {
    // Round five of the same shape: a context whose contents were being lexed
    // as SQL. Every Postgres context that can carry a quote or a dash is now
    // skipped whole, rather than adding them one review round at a time.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK +
        "UPDATE t /* owner's note */ SET a = 1 -- use " + BACKTICK + '&&' + BACKTICK + ' z',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: block comments NEST, unlike C', () => {
    // Postgres nests `/* */`, so scanning to the first `*/` would leave the
    // walk inside the comment and mis-read everything after it.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK +
        "UPDATE t /* a /* b */ owner's */ SET a = 1 -- use " + BACKTICK + '&&' + BACKTICK + ' z',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: an apostrophe in a $$ dollar-quoted body cannot hide the --', () => {
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK +
        "DO $$ BEGIN owner's END $$ -- use " + BACKTICK + '&&' + BACKTICK + ' z',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: silent on a block comment / dollar body with no line comment', () => {
    // The controls: skipping a context must not INVENT a line comment, and a
    // `--` INSIDE a block comment is not one either.
    const a = lines(
      'const q = await db.$queryRaw' + BACKTICK + "SELECT 1 /* owner's note */ FROM t" + BACKTICK + ';',
      '',
    );
    const b = lines('const q = await db.$queryRaw' + BACKTICK + "DO $$ owner's $$" + BACKTICK + ';', '');
    const c = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT 1 /* -- not a line comment */ FROM t' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'a.ts': a }).offenders).toEqual([]);
    expect(scanFiles({ 'b.ts': b }).offenders).toEqual([]);
    expect(scanFiles({ 'c.ts': c }).offenders).toEqual([]);
  });

  it('#1110: a dollar-quote TAG may contain digits (@copilot, #1131)', () => {
    // `$fn1$` is a legal delimiter. Excluding digits left its body unskipped,
    // so the `--` inside was read as a real comment that then ran to the close.
    //
    // The fixture is deliberately free of apostrophes: my first version used
    // `owner's` inside the body, and an UNTERMINATED string swallowed the rest
    // either way — so the test passed with the digit support removed. It proved
    // nothing until the mutation said so.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'DO $fn1$ x -- y $fn1$' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it('#1110: `owner$tag$` is an IDENTIFIER, not a dollar-quote (@codex P2, #1131)', () => {
    // Postgres allows `$` inside unquoted identifiers, so a legal column name
    // can contain a perfect `$tag$` that opens nothing. Treating it as a
    // delimiter entered a body with no close, ran to the end of the literal,
    // and swallowed the real `--` — a silent pass on a truncated query. A real
    // dollar-quote cannot directly follow an identifier character.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE t SET owner$tag$ = 1 -- use ' +
        BACKTICK + '&&' + BACKTICK + ' z',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'x.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: silent on an interpolation with no comment at all', () => {
    // The control for the `?` substitution: replacing spans must not invent a
    // comment where the SQL has none.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT ${id} FROM t' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
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

  it('does not blame a backtick for an UNRELATED syntax error (@copilot, #1109)', () => {
    // This branch fires on ANY parse diagnostic in a file that happens to
    // contain raw-SQL tags. Asserting "a backtick ended the literal early"
    // would send the reader hunting for a backtick that is not there — the
    // same over-assertion this session kept producing in refusal messages.
    // What the diagnostic establishes is only that the file does not parse.
    const src = lines(
      'function f( {',
      '  return 1;',
      '}',
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT 1' + BACKTICK + ';',
      '',
    );
    const { offenders } = scanFiles({ 'u.ts': src });
    expect(offenders).toHaveLength(1);
    const message = offenders[0].errors.join(' ');
    expect(message).toMatch(/probably an ordinary syntax error/);
    expect(message).not.toMatch(/opens on line/);
  });

  it('does NOT fire on two legitimate executors in one statement (@codex P2, #1109)', () => {
    // The false positive that ended the re-pair heuristic. Two ordinary
    // queries grouped in a Promise.all were flagged twice, because each
    // executor saw the other's literal as a severed tail. A gate that blocks
    // valid code gets switched off, so the arm was removed rather than
    // tightened a sixth time — re-pair detection is #1110.
    const src = lines(
      'const [a, b] = await Promise.all([',
      '  db.$queryRaw' + BACKTICK + 'SELECT 1' + BACKTICK + ',',
      '  db.$queryRaw' + BACKTICK + 'SELECT 2' + BACKTICK + ',',
      ']);',
      '',
    );
    expect(scanFiles({ 't.ts': src }).offenders).toEqual([]);
  });

  it('CLOSED (#1110): a break that re-pairs into valid TypeScript IS caught', () => {
    // Was pinned as a KNOWN GAP asserting silence, so #1110 would have a red to
    // turn green. This is that red turning green.
    //
    // The parser has no complaint — `taggedTemplate && templateExpression` is
    // valid TypeScript — so the diagnostic arm still cannot see it. What catches
    // it is the literal's OWN property: it closes after a `--` on its line, and
    // a SQL comment runs to end-of-line, so no legitimate close can sit there.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE u SET a = false -- use ' +
        BACKTICK + '&&' + BACKTICK + ' for overlap',
      'WHERE id = ${id}' + BACKTICK + ';',
      '',
    );
    const { offenders } = scanFiles({ 'g.ts': src });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].line).toBe(1);
    // The message has to name the RE-PAIR, because that is the part a reader
    // will not believe: the file compiles, so "broken literal" sounds wrong
    // until you are told the truncated query still runs.
    expect(offenders[0].errors.join(' ')).toMatch(/re-pair into valid\s+TypeScript/);
    expect(offenders[0].errors.join(' ')).toMatch(/TRUNCATED/);
  });

  it('#1110: catches a tail owned by a tag the comment NAMED', () => {
    // Defeated the third earlier attempt (the "unowned tail" rule): naming a tag
    // inside the comment gave the severed tail an owner, so an ownership test
    // read it as legitimate. Ownership is not consulted here.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE u -- use ' + BACKTICK +
        '&& Prisma.sql' + BACKTICK + ' now',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'g.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: catches an array element inside Promise.all', () => {
    // Defeated the fourth attempt, which walked binary/conditional parents and
    // never reached an array element.
    const src = lines(
      'await Promise.all([',
      '  db.$executeRaw' + BACKTICK + 'UPDATE u -- ' + BACKTICK + '&&' + BACKTICK + ' z',
      'WHERE id = 1' + BACKTICK + ',',
      ']);',
      '',
    );
    expect(scanFiles({ 'g.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: catches a backtick pair enclosing a SEMICOLON', () => {
    // The construction #1110 listed that NO earlier version reached: the pair
    // splits the remainder into a separate STATEMENT, so a statement-scoped walk
    // never visits it. This arm never walks outward, so the split is irrelevant.
    const src = lines(
      'const x = await db.$executeRaw' + BACKTICK + 'UPDATE u -- a ' + BACKTICK +
        '; const y = 1; ' + BACKTICK + ' b',
      'WHERE id = 1' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'g.ts': src }).offenders).toHaveLength(1);
  });

  it('#1110: silent on a legitimate SQL comment the literal does not close on', () => {
    // The control that separates "closes inside a comment" from "contains one".
    // A comment is ordinary in raw SQL; only closing INSIDE it is the bug.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT 1 -- explain why',
      'FROM t' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it('#1110: silent on an ESCAPED backtick inside a SQL comment', () => {
    // The repo's actual idiom for naming a column in a comment. An escaped
    // backtick terminates nothing, so the literal closes where it should.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT 1 -- see \\' + BACKTICK +
        'col\\' + BACKTICK + ' here',
      'FROM t' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it('#1110: silent when -- sits inside a SQL STRING on the closing line', () => {
    // hasLineComment is quote-aware, and that is what makes this arm safe rather
    // than merely narrow: `SELECT '--'` closes legitimately on a line containing
    // two dashes.
    const src = lines('const q = await db.$queryRaw' + BACKTICK + "SELECT '--'" + BACKTICK + ';', '');
    expect(scanFiles({ 'q.ts': src }).offenders).toEqual([]);
  });

  it('does NOT fire on a Prisma.sql fragment NESTED in a query slot', () => {
    // The control the positional rule turns on: a composed fragment inside a
    // `${}` slot lies WITHIN the executor's own literal, which is exactly what
    // separates legitimate composition from a severed tail.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT ${Prisma.sql' + BACKTICK +
        'a = 1' + BACKTICK + '} FROM t' + BACKTICK + ';',
      '',
    );
    expect(scanFiles({ 'n.ts': src }).offenders).toEqual([]);
  });

  it('stays cause-neutral when a VALID query precedes an unrelated error (@codex P2, #1109)', () => {
    // My first cause-neutral fix only handled the error-BEFORE-any-tag ordering
    // — the ordering I happened to write a test for. A literal opening before
    // the diagnostic does not establish that the diagnostic belongs to it.
    const src = lines(
      'const q = await db.$queryRaw' + BACKTICK + 'SELECT 1' + BACKTICK + ';',
      'function f( {',
      '  return 1;',
      '}',
      '',
    );
    const { offenders } = scanFiles({ 'v.ts': src });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].errors.join(' ')).toMatch(/cannot tell it from an ordinary syntax error/);
  });

  it('finds the real repo tagged literals, and they are all intact', () => {
    // Anti-phantom, the same property the SDL half asserts: a scan that found
    // nothing to check must not read as a clean one.
    const { offenders, documents } = scanTaggedLiterals();
    expect(documents).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
