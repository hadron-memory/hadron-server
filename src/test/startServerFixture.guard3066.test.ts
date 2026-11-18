/**
 * #3066 source-shape guard. A worker's database clone keeps the previous file's rows, and the
 * app refuses to start over a retained rate-limit manifest its keyring cannot account for.
 * A test file that starts the app from `beforeAll` must clean the database first: through
 * `createServerOnCleanDb()` or its own `cleanDb(` earlier in the same hook. A raw
 * `createServer()` in `beforeAll` with no cleanup before it fails here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Blank comments and string/template bodies so a lookalike in prose cannot count. */
export function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** Raw `createServer(` calls made directly inside a `beforeAll(` hook, with no `cleanDb(` before them. */
export function uncleanedStarts(source: string): number[] {
  const src = stripNoise(source);
  if (!/import[^;]*\bcreateServer\b[^;]*from\s+['"][^'"]*\/server\.js['"]|const\s*\{[^}]*\bcreateServer\b[^}]*\}\s*=\s*await import\(\s*['"][^'"]*\/server\.js['"]/.test(src)) return [];
  const hits: number[] = [];
  const hook = /\bbeforeAll\(/g;
  for (let m = hook.exec(src); m; m = hook.exec(src)) {
    let depth = 0, end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    const body = src.slice(m.index, end);
    const call = /(?<![\w.])createServer\(/.exec(body);
    if (!call) continue;
    if (/\bcleanDb\(/.test(body.slice(0, call.index))) continue;
    hits.push(src.slice(0, m.index + call.index).split('\n').length);
  }
  return hits;
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('startServerFixture guard (#3066)', () => {
  it('flags a raw createServer in beforeAll and accepts a cleaned start (self-check)', () => {
    const head = "import { createServer } from '../server.js';\n";
    expect(uncleanedStarts(`${head}beforeAll(async () => {\n  app = await createServer();\n});`)).toEqual([3]);
    expect(uncleanedStarts(`${head}beforeAll(async () => {\n  await cleanDb(db);\n  app = await createServer();\n});`)).toEqual([]);
    expect(uncleanedStarts(`${head}beforeAll(async () => { app = await createServerOnCleanDb(); });`)).toEqual([]);
    expect(uncleanedStarts(`${head}// beforeAll(() => createServer())\nit('x', async () => { await createServer(); });`)).toEqual([]);
    expect(uncleanedStarts("beforeAll(async () => { await createServer(); });")).toEqual([]); // not the app's createServer
  });

  it('no test file starts createServer() from beforeAll before cleaning the database', () => {
    const offenders = testFiles('src')
      .filter((file) => !file.endsWith('startServerFixture.guard3066.test.ts')) // its self-check holds sample source in strings
      .map((file) => ({ file, lines: uncleanedStarts(readFileSync(file, 'utf8')) }))
      .filter((o) => o.lines.length > 0)
      .map((o) => `${o.file}:${o.lines.join(',')}`);
    expect(offenders).toEqual([]);
  });
});
