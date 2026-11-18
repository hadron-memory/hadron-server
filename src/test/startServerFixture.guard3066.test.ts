/**
 * #3066 source-shape guard. A worker's database clone keeps the previous file's rows, and the
 * app refuses to start over a retained rate-limit manifest its keyring cannot account for.
 * A test file that starts the app must clean the database first: through `createServerOnCleanDb()`
 * or its own `cleanDb(` ahead of the start (earlier in the same hook for `beforeAll`, anywhere in the
 * file otherwise: the per-test cleanup hook). Aliased imports, dynamic imports and starts inside `it` bodies or boot helpers are
 * checked too. A textual guard: it cannot prove execution order, it makes the unsafe shapes loud.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Blank comments (and the bodies of string literals) so a lookalike in prose or data cannot count. */
export function stripNoise(src: string, strings = true): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  // One pass, so a `//` inside a string or a quote inside a comment cannot be misread; templates are blanked too.
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    (m) => (m[0] === '/' ? blank(m) : strings || m[0] === '`' ? m[0] + blank(m.slice(1, -1)) + m[0] : m),
  );
}

/** Names this file binds the app's `createServer` to (the plain name, an alias, or a dynamic import). */
function appStarters(src: string): string[] {
  const names: string[] = [];
  const fromImport = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/server\.js['"]/g;
  const fromDynamic = /const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"][^'"]*\/server\.js['"]\s*\)/g;
  for (const re of [fromImport, fromDynamic]) {
    for (let m = re.exec(src); m; m = re.exec(src)) {
      for (const part of m[1]!.split(',')) {
        const [from, to] = part.trim().split(/\s+as\s+|\s*:\s*/);
        const local = to ?? from;
        if (from === 'createServer' && local && /^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
      }
    }
  }
  return names;
}

/**
 * Line numbers of raw app starts with no cleanup ahead of them: a start inside a `beforeAll(` hook needs
 * `cleanDb(` earlier in that hook; a start anywhere else (an `it` body, a boot helper called from a hook)
 * needs `cleanDb(` somewhere in the file (its per-test cleanup hook), and a file that has none is flagged.
 */
export function uncleanedStarts(source: string): number[] {
  const src = stripNoise(source);
  const hits: number[] = [];
  const hooks: Array<[number, number]> = [];
  const hook = /\bbeforeAll\(/g;
  for (let m = hook.exec(src); m; m = hook.exec(src)) {
    let depth = 0, end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    hooks.push([m.index, end]);
  }
  for (const name of appStarters(stripNoise(source, false))) {
    const call = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g');
    for (let m = call.exec(src); m; m = call.exec(src)) {
      const at = m.index;
      if (/\bimport\s*\{[^}]*$/.test(src.slice(Math.max(0, at - 200), at))) continue;
      const inHook = hooks.find(([from, to]) => at > from && at < to);
      // A hook start needs the cleanup ahead of it in that hook; a start run per test (an `it` body or a boot
      // helper) follows the file's own cleanup hook, so any cleanup in the file counts.
      // `createServerOnCleanDb(` is a start, not a cleanup: it blesses a raw start only earlier in the same hook.
      const cleaned = inHook ? /\b(?:cleanDb|createServerOnCleanDb)\(/.test(src.slice(inHook[0], at)) : /\bcleanDb\(/.test(src);
      if (!cleaned) hits.push(src.slice(0, at).split('\n').length);
    }
  }
  return hits;
}

/** Files exempt from the scan, each with its reason. */
const EXEMPT = [
  // Deliberately exercises the raw, rejecting start (the negative control); the fixture is what it is tested against.
  'startServerFixture.test.ts',
  'startServerFixture.guard3066.test.ts',
];

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('startServerFixture guard (#3066)', () => {
  it('flags unsafe starts and accepts cleaned ones (self-check)', () => {
    const head = "import { createServer } from '../server.js';\n";
    expect(uncleanedStarts(`${head}beforeAll(async () => {\n  app = await createServer();\n});`)).toEqual([3]);
    expect(uncleanedStarts(`${head}beforeAll(async () => {\n  await cleanDb(db);\n  app = await createServer();\n});`)).toEqual([]);
    expect(uncleanedStarts(`${head}beforeAll(async () => { app = await createServerOnCleanDb(); });`)).toEqual([]);
    // Blind spots a hook-only scan had: an `it` body, a boot helper, an aliased and a dynamic import.
    expect(uncleanedStarts(`${head}it('x', async () => { await createServer(); });`)).toEqual([2]);
    expect(uncleanedStarts(`${head}async function boot() { return createServer (); }`)).toEqual([2]);
    expect(uncleanedStarts("import { createServer as makeApp } from '../server.js';\nconst a = await makeApp();")).toEqual([2]);
    expect(uncleanedStarts("beforeAll(async () => {\n  const { createServer } = await import('../server.js');\n  await createServer();\n});")).toEqual([3]);
    // A fixture start elsewhere in the file does not bless a raw start in an `it` body.
    expect(uncleanedStarts(`${head}it('a', async () => { await createServerOnCleanDb(); });\nit('b', async () => { await createServer(); });`)).toEqual([3]);
    // A `//` inside a string, and a template literal, cannot hide or fabricate a start.
    expect(uncleanedStarts(`${head}const u = '/a//b'; await createServer();`)).toEqual([2]);
    expect(uncleanedStarts(`${head}const t = \`beforeAll(\`;\nit('x', async () => { await createServer(); });`)).toEqual([3]);
    // Cleaned by the file's own hook, comment and string lookalikes, and another module's createServer.
    expect(uncleanedStarts(`${head}beforeEach(async () => { await cleanDb(db); });\nit('x', async () => { await createServer(); });`)).toEqual([]);
    expect(uncleanedStarts(`${head}// beforeAll(() => createServer())\nconst s = "createServer(";`)).toEqual([]);
    expect(uncleanedStarts("import { createServer } from 'node:http';\nbeforeAll(async () => { createServer(); });")).toEqual([]);
  });

  it('no test file starts the app before cleaning the database', () => {
    const offenders = testFiles(join(import.meta.dirname, '..'))
      .filter((file) => !EXEMPT.some((e) => file.endsWith(e)))
      .map((file) => ({ file, lines: uncleanedStarts(readFileSync(file, 'utf8')) }))
      .filter((o) => o.lines.length > 0)
      .map((o) => `${o.file}:${o.lines.join(',')}`);
    expect(offenders).toEqual([]);
  });
});
