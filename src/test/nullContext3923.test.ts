/**
 * #3923: hardening of the #3705 null-Context scanner. Still a syntactic tripwire (no dataflow): indirect values,
 * `as any` and Object.assign stay out of scope, and the alias search is per file.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, never from the cwd, so the suite runs from any directory.
const script = fileURLToPath(new URL('../../scripts/check-null-context.mjs', import.meta.url));
const productionRoot = fileURLToPath(new URL('../', import.meta.url));

function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd });
}
function scan(files: Record<string, string>, extra: string[] = ['--root']) {
  const root = mkdtempSync(join(tmpdir(), 'null-context3923-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    return run(extra[extra.length - 1] === '--root' ? [...extra, root] : [`${extra[0]}${root}`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('#3923 alias and import-type references to Context', () => {
  it.each([
    ['renamed import', `import { Context as Ctx } from './h.js';\nconst c = ({ userId: null }) as Ctx;`, 2],
    ['renamed type import', `import type { Context as Ctx } from './h.js';\nconst c = ({ userId: null }) as unknown as Ctx;`, 2],
    ['local alias', `type Ctx = Context;\nconst c = ({ userId: null }) as Ctx;`, 2],
    ['exported local alias', `export type Ctx = Context;\nconst c = ({ userId: null }) as Ctx;`, 2],
    ['alias of an alias', `type A = Context;\ntype B = A;\nconst c = ({ userId: null }) as B;`, 3],
    ['alias declared after its use as a base', `type B = A;\ntype A = Context;\nconst c = ({ userId: null }) as B;`, 3],
    ['alias of a qualified name', `type A = H.Context;\nconst c = ({ userId: null }) as A;`, 2],
    ['import type', `const c = ({ userId: null }) as import('./h.js').Context;`, 1],
    ['import type alias', `type A = import('./h.js').Context;\nconst c = ({ userId: null }) as A;`, 2],
    ['angle-bracket cast on an alias', `type Ctx = Context;\nconst c = <Ctx>({ userId: null });`, 2],
  ])('rejects %s', (_name, text, line) => {
    const result = scan({ 'production.ts': text });
    expect(result.stderr).toContain(`production.ts:${line}: null userId cast to Context`);
    expect(result.status).toBe(1);
  });

  it('keeps the direct and qualified controls', () => {
    const result = scan({ 'a.ts': `const c = ({ userId: null }) as Context;`, 'b.ts': `const c = ({ userId: null }) as H.Context;` });
    expect(result.stderr).toContain('a.ts:1:');
    expect(result.stderr).toContain('b.ts:1:');
    expect(result.status).toBe(1);
  });

  it('does not flag unrelated types, unrelated aliases, or an honest userId', () => {
    const result = scan({
      'production.ts': [
        `import { RequestContext as Rc, Row as Ctx2 } from './h.js';`,
        `type Other = RequestContext;`,
        `type Mine = Row;`,
        `const a = ({ userId: null }) as Rc;`,
        `const b = ({ userId: null }) as Other;`,
        `const c = ({ userId: null }) as Mine;`,
        `const d = ({ userId: null }) as Ctx2;`,
        `const e = ({ userId: null }) as import('./h.js').SessionContext;`,
        `type Ctx = Context;`,
        `const f = ({ userId: undefined }) as Ctx;`,
        `const g = ({ userId: 'u' }) as Ctx;`,
      ].join('\n'),
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('keeps the documented limits: indirect values and as-any are not claimed', () => {
    const result = scan({ 'production.ts': `type Ctx = Context;\nconst v = null;\nconst c = ({ userId: v }) as Ctx;\nconst d = ({ userId: null }) as any;` });
    expect(result.status).toBe(0);
  });

  it('still skips test files for an alias cast', () => {
    const result = scan({ 'x.test.ts': `type Ctx = Context;\nconst c = ({ userId: null }) as Ctx;` });
    expect(result.status).toBe(0);
  });
});

describe('#3923 CLI handling of --root', () => {
  it('refuses a missing value, an empty value and extra arguments with usage and exit 2', () => {
    for (const args of [['--root'], ['--root', ''], ['--root=', ], ['--root', 'a', 'b'], ['--bogus']]) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('Usage: node scripts/check-null-context.mjs');
      expect(result.stdout).toBe('');
    }
  });

  it('names a root that does not exist, without a stack trace', () => {
    const result = run(['--root', join(tmpdir(), 'null-context3923-no-such-dir')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/check-null-context: cannot read root .*no-such-dir.*ENOENT/);
    expect(result.stderr).not.toContain('at ');
  });

  it('names a root that is a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'null-context3923-'));
    try {
      writeFileSync(join(root, 'f.ts'), '');
      const result = run(['--root', join(root, 'f.ts')]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/check-null-context: .*not a directory/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.getuid?.() === 0)('names an unreadable subdirectory instead of passing silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'null-context3923-'));
    try {
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'a.ts'), 'const c = ({ userId: null }) as Context;');
      chmodSync(join(root, 'sub'), 0o000);
      const result = run(['--root', root]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/check-null-context: cannot read .*sub.*EACCES/);
    } finally { chmodSync(join(root, 'sub'), 0o700); rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts --root=<dir> as the same flag', () => {
    const bad = scan({ 'p.ts': 'const c = ({ userId: null }) as Context;' }, ['--root=']);
    expect(bad.status).toBe(1);
    const ok = scan({ 'p.ts': 'const c = 1;' }, ['--root=']);
    expect(ok.status).toBe(0);
  });

  it('gives the same answer from another working directory, on a fixture with an absolute root', () => {
    const root = mkdtempSync(join(tmpdir(), 'null-context3923-'));
    try {
      writeFileSync(join(root, 'bad.ts'), 'const c = ({ userId: null }) as Context;');
      const bad = run(['--root', root], tmpdir());
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('bad.ts:1:');
      rmSync(join(root, 'bad.ts'));
      writeFileSync(join(root, 'ok.ts'), 'const c = 1;');
      expect(run(['--root', root], tmpdir()).status).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('scans the production tree from another working directory (separate from the fixture check above)', () => {
    const result = run(['--root', productionRoot], tmpdir());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('#3923 BLIND P2s: parenthesized types and lexical scope', () => {
  it.each([
    ['parenthesized alias', `type Ctx = (Context);\nconst c = ({ userId: null }) as Ctx;`, 2],
    ['doubly parenthesized alias', `type Ctx = ((Context));\nconst c = ({ userId: null }) as Ctx;`, 2],
    ['parenthesized direct cast type', `const c = ({ userId: null }) as (Context);`, 1],
    ['parenthesized import type', `const c = ({ userId: null }) as (import('./h.js').Context);`, 1],
    ['alias declared in a block', `function f() {\n  type Ctx = Context;\n  return ({ userId: null }) as Ctx;\n}`, 3],
    ['alias declared in a namespace, cast inside it', `namespace A {\n  type Ctx = Context;\n  export const c = ({ userId: null }) as Ctx;\n}`, 3],
    ['top-level alias seen from a nested function', `type Ctx = Context;\nfunction f() {\n  return ({ userId: null }) as Ctx;\n}`, 3],
    ['renamed import seen from a nested block', `import { Context as Ctx } from './h.js';\nfunction f() {\n  return ({ userId: null }) as Ctx;\n}`, 3],
  ])('rejects %s', (_name, text, line) => {
    const result = scan({ 'production.ts': text });
    expect(result.stderr).toContain(`production.ts:${line}: null userId cast to Context`);
    expect(result.status).toBe(1);
  });

  it('terminates on an alias cycle and flags nothing for it', () => {
    const result = scan({ 'production.ts': `type Z = Context;\ntype A = B;\ntype B = A;\nconst c = ({ userId: null }) as A;` });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    ['sibling namespaces', `namespace A { export type Ctx = Context; }\nnamespace B {\n  type Ctx = Row;\n  export const c = ({ userId: null }) as Ctx;\n}`],
    ['an alias in a sibling function', `function a() { type Ctx = Context; return 1; }\nfunction b() {\n  type Ctx = Row;\n  return ({ userId: null }) as Ctx;\n}`],
    ['an alias in another scope entirely', `function a() { type Ctx = Context; return 1; }\nconst c = ({ userId: null }) as Ctx;`],
    ['an inner type shadowing an outer Context alias', `type Ctx = Context;\nfunction f() {\n  type Ctx = Row;\n  return ({ userId: null }) as Ctx;\n}`],
    ['an inner interface shadowing an outer Context alias', `type Ctx = Context;\nfunction f() {\n  interface Ctx { a: 1 }\n  return ({ userId: null }) as Ctx;\n}`],
    ['an inner parenthesized unrelated alias shadowing an outer one', `type Ctx = Context;\nfunction f() {\n  type Ctx = (Row);\n  return ({ userId: null }) as Ctx;\n}`],
  ])('does not flag %s', (_name, text) => {
    const result = scan({ 'production.ts': text });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
