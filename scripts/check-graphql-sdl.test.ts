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
import { scanSdlDir, findBrokenSdlLiterals } from './check-graphql-sdl.mjs';

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

  it('reports the plain multi-line TS template literals it must ignore', () => {
    // Without the #graphql marker this check would fire on ordinary prose,
    // whose closing backtick legitimately sits at the end of a line.
    const offenders = findBrokenSdlLiterals(
      'x.ts',
      lines('const msg = ' + BACKTICK + 'hello', 'world' + BACKTICK + ';', ''),
    );
    expect(offenders).toEqual([]);
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
