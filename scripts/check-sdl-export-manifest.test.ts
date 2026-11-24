/**
 * The SDL export manifest guard (#4916), proved against fixture trees and against the real repository.
 * The CLI the CI workflow runs and the functions these tests call are the same code.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeClosure,
  compare,
  importsOf,
  renderManifest,
  REGENERATE_COMMAND,
} from './check-sdl-export-manifest.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'check-sdl-export-manifest.mjs');
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A fixture repo: the entry plus the given files. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sdl-manifest-4916-'));
  roots.push(root);
  const all: Record<string, string> = { 'scripts/export-graphql-sdl.mjs': "import './../src/a.js';\n", ...files };
  for (const [p, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}
const closure = (root: string) => computeClosure({ root, entry: 'scripts/export-graphql-sdl.mjs' });
const run = (root: string, ...args: string[]) =>
  spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });

describe('import forms (each pulls src/b.ts into the closure)', () => {
  const forms: Record<string, string> = {
    'import … from': "import { x } from './b.js';\nexport const y = x;\n",
    'import type … from': "import type { X } from './b.js';\nexport type Y = X;\n",
    'side-effect import': "import './b.js';\n",
    'export … from': "export { x } from './b.js';\n",
    'export * from': "export * from './b.js';\n",
    'dynamic import() with a literal': "export const f = () => import('./b.js');\n",
    'dynamic import() with a template literal': 'export const f = () => import(`./b.js`);\n',
    'type-position import()': "export type T = typeof import('./b.js');\n",
    'import x = require()': "import b = require('./b.js');\nexport default b;\n",
    'literal require()': "declare const require: any;\nexport const b = require('./b.js');\n",
    'literal import.meta.resolve()': "export const u = import.meta.resolve('./b.js');\n",
  };
  for (const [name, body] of Object.entries(forms)) {
    it(name, () => {
      const root = fixture({ 'src/a.ts': body, 'src/b.ts': 'export const x = 1;\nexport type X = number;\n' });
      expect(closure(root)).toEqual({
        files: ['scripts/export-graphql-sdl.mjs', 'src/a.ts', 'src/b.ts'],
        errors: [],
      });
    });
  }

  it('excludes node: builtins, bare builtins and the allowed package (graphql, with a subpath too)', () => {
    const root = fixture({
      'src/a.ts': "import { buildSchema } from 'graphql';\nimport { x } from 'graphql/language';\nimport fs from 'node:fs';\nimport p from 'path';\nimport f from 'fs/promises';\n",
    });
    expect(closure(root)).toEqual({ files: ['scripts/export-graphql-sdl.mjs', 'src/a.ts'], errors: [] });
  });

  it('fails closed on a package the CLI job does not install, a scoped one too (#4916 blind P2-4)', () => {
    const root = fixture({ 'src/a.ts': "import _ from 'lodash';\nimport p from '@scope/pkg/sub';\n" });
    const { errors } = closure(root);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("'lodash' is a package the CLI's SDL export job does not install");
    expect(errors[1]).toContain("'@scope/pkg/sub'");
    expect(run(root).status).toBe(1);
  });

  it('fails closed on a #alias (blind P2-1)', () => {
    const root = fixture({ 'src/a.ts': "import z from '#alias';\n" });
    expect(closure(root).errors[0]).toContain("'#alias' is a package.json imports alias");
  });

  it('fails closed on a syntax error instead of counting only what the parser kept (blind P2-3)', () => {
    const root = fixture({ 'src/a.ts': "import './b.js';\nexport const = ;\n", 'src/b.ts': '' });
    const { errors } = closure(root);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('src/a.ts:2: syntax error');
    // --write must refuse, so a partial closure is never baked into the manifest.
    expect(run(root, '--write').status).toBe(1);
    expect(existsSync(join(root, 'scripts/sdl-export-files.txt'))).toBe(false);
  });

  it('fails closed on a non-literal require() and import.meta.resolve()', () => {
    const root = fixture({ 'src/a.ts': 'declare const require: any;\ndeclare const n: string;\nrequire(n);\nimport.meta.resolve(n);\n' });
    expect(closure(root).errors).toHaveLength(2);
  });

  it('usage: an option that swallows another option, and an unknown one, exit 2', () => {
    const root = fixture({ 'src/a.ts': '' });
    expect(run(root, '--entry', '--write').status).toBe(2);
    expect(run(root, '--bogus').status).toBe(2);
  });

  it('resolves .js to the .ts next to it, and extensionless and index specifiers', () => {
    const root = fixture({
      'src/a.ts': "import './b.js';\nimport './c';\nimport './d';\n",
      'src/b.ts': '',
      'src/c.ts': '',
      'src/d/index.ts': '',
    });
    expect(closure(root).files).toEqual([
      'scripts/export-graphql-sdl.mjs',
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d/index.ts',
    ]);
  });

  it('prefers the .ts file but falls back to a literal .js file', () => {
    const root = fixture({ 'src/a.ts': "import './b.js';\n", 'src/b.js': '' });
    expect(closure(root).files).toContain('src/b.js');
  });

  it('follows transitively and survives a cycle', () => {
    const root = fixture({ 'src/a.ts': "import './b.js';\n", 'src/b.ts': "import './a.js';\nimport './c.js';\n", 'src/c.ts': '' });
    expect(closure(root).files).toEqual(['scripts/export-graphql-sdl.mjs', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('does not count import-looking text in a comment or a string', () => {
    const root = fixture({ 'src/a.ts': "// import './nope.js'\nconst s = \"import './nope2.js'\";\n/* export * from './nope3.js' */\n" });
    expect(closure(root)).toEqual({ files: ['scripts/export-graphql-sdl.mjs', 'src/a.ts'], errors: [] });
  });

  it('fails closed on an unresolvable relative import and on a non-literal import()', () => {
    const root = fixture({ 'src/a.ts': "import './missing.js';\nexport const f = (n: string) => import(n);\n" });
    const { errors } = closure(root);
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain("'./missing.js' does not resolve");
    expect(errors.join('\n')).toContain('not a string literal');
    expect(run(root).status).toBe(1);
  });

  it('reports a missing entry point', () => {
    const root = fixture({});
    expect(computeClosure({ root, entry: 'nope.mjs' }).errors[0]).toContain('does not exist');
  });

  it('importsOf reads .mjs as JavaScript', () => {
    expect(importsOf('x.mjs', "import a from './a.js';\n")).toEqual([{ specifier: './a.js' }]);
  });
});

describe('the guard CLI on a fixture tree', () => {
  const files = { 'src/a.ts': "import './b.js';\n", 'src/b.ts': '' };

  it('passes when the manifest is the closure, and --write is idempotent', () => {
    const root = fixture(files);
    expect(run(root, '--write').status).toBe(0);
    const first = readFileSync(join(root, 'scripts/sdl-export-files.txt'), 'utf8');
    expect(first).toBe(renderManifest(closure(root).files));
    expect(run(root).status).toBe(0);
    expect(run(root, '--write').status).toBe(0);
    expect(readFileSync(join(root, 'scripts/sdl-export-files.txt'), 'utf8')).toBe(first);
  });

  it('DRIFT (mutant): a path dropped from the manifest fails and names the regenerate command', () => {
    const root = fixture(files);
    run(root, '--write');
    const p = join(root, 'scripts/sdl-export-files.txt');
    writeFileSync(p, readFileSync(p, 'utf8').replace('src/b.ts\n', ''));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing from the manifest: src/b.ts');
    expect(r.stderr).toContain(REGENERATE_COMMAND);
  });

  it('DRIFT (mutant): an import added without updating the manifest fails and names the regenerate command', () => {
    const root = fixture(files);
    run(root, '--write');
    writeFileSync(join(root, 'src/b.ts'), "import './c.js';\n");
    writeFileSync(join(root, 'src/c.ts'), '');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing from the manifest: src/c.ts');
    expect(r.stderr).toContain(REGENERATE_COMMAND);
    expect(run(root, '--write').status).toBe(0);
    expect(run(root).status).toBe(0);
  });

  it('an extra manifest line, an absent manifest and a non-canonical one all fail', () => {
    const root = fixture(files);
    expect(run(root).status).toBe(1); // absent
    run(root, '--write');
    const p = join(root, 'scripts/sdl-export-files.txt');
    const good = readFileSync(p, 'utf8');
    writeFileSync(p, good + 'src/gone.ts\n');
    expect(run(root).stderr).toContain('not imported by the export: src/gone.ts');
    const lines = good.trimEnd().split('\n');
    writeFileSync(p, [...lines.slice(0, 4), ...lines.slice(4).reverse()].join('\n') + '\n');
    expect(run(root).stderr).toContain('not in canonical form');
  });

  it('compare ignores comments and blank lines when judging the set', () => {
    expect(compare(['a.ts'], '# c\n\na.ts\n')).toEqual(['the manifest lists the right files but is not in canonical form (header, sorted, one per line)']);
  });
});

describe('the real repository', () => {
  it('the committed manifest matches the closure byte-for-byte, and today it is the three known files', () => {
    const { files, errors } = computeClosure({ root: REPO, entry: 'scripts/export-graphql-sdl.mjs' });
    expect(errors).toEqual([]);
    // Pinned on purpose, the one assertion not derived from the code under test: when the export legitimately
    // gains an import, update this list together with `pnpm sdl:manifest --write`.
    expect(files).toEqual([
      'scripts/export-graphql-sdl.mjs',
      'src/api/graphql/schema/typeDefs.ts',
      'src/lib/agentTasks/teamMetricsCaps.ts',
    ]);
    expect(readFileSync(join(REPO, 'scripts/sdl-export-files.txt'), 'utf8')).toBe(renderManifest(files));
    expect(spawnSync('node', [SCRIPT], { encoding: 'utf8' }).status).toBe(0);
  });
});
