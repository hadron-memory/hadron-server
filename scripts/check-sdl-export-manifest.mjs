#!/usr/bin/env node
// SDL export manifest guard (#4916).
//
// hadron-cli's `Schema drift` job exports this server's SDL from a SPARSE checkout of hadron-server. The files that
// checkout must contain are exactly the import closure of `scripts/export-graphql-sdl.mjs`, and until #4916 the CLI
// kept that list by hand. When #4881 made `typeDefs.ts` import a new module, nothing here noticed, and the CLI's job
// broke later with a module-not-found error on an unrelated run.
//
// `scripts/sdl-export-files.txt` is the server-owned list: one repo-relative path per line, sorted, `#` starts a
// comment line. This script computes the closure and fails when it is not exactly that list, so the server PR that
// adds the import is the one that fails, where its author can fix it with ONE command:
//
//     pnpm sdl:manifest --write
//
// ## The closure
//
// Computed with the TypeScript compiler API (a syntax tree, never a regex that can miss a form). These count as
// imports, in `.mjs`, `.ts` and every other script kind the compiler reads:
//   - `import … from '…'` and `import type … from '…'`
//   - a side-effect `import '…'`
//   - `export … from '…'` (also `export * from`)
//   - dynamic `import('…')` with a string literal (also a no-substitution template literal)
//   - a type-position `import('…')` (`typeof import('./x')`), counted because it names the file
//   - `import x = require('…')`, a literal `require('…')` call and a literal `import.meta.resolve('…')`
//     (this repository is ESM, but a file in the closure that loads another by these routes still needs it)
// A `node:` or bare Node builtin is EXCLUDED, and so is a package in ALLOWED_PACKAGES (`graphql`: the CLI job
// installs it and `tsx` itself). Any OTHER bare package is an error: the CLI job would not have it, and adding it
// to ALLOWED_PACKAGES is a decision to make together with the CLI job, not a silent pass. A `#alias` (package.json
// `imports`) or a specifier tsconfig `paths` could map is an error too: neither is followed, so neither may be
// guessed at; today the repository declares neither. A `.js` / `.mjs` / `.cjs` specifier resolves to the `.ts` / `.mts` / `.cts` file
// next to it first (what tsx does), then to the literal file; an extensionless one tries `.ts`, `.js` and `index.*`.
//
// Fail closed (exit 1), never silently skipped: a relative specifier that resolves to no file, a dynamic `import()`,
// `require()` or `import.meta.resolve()` whose argument is not a string literal, a source file with syntax errors
// (the parser would drop what it cannot read), an alias, and a bare package outside ALLOWED_PACKAGES.
//
// Usage: node scripts/check-sdl-export-manifest.mjs [--write] [--root <dir>] [--entry <path>] [--manifest <path>]
// Exit codes: 0 = manifest matches (or was written), 1 = drift or an import the guard cannot follow, 2 = usage error
// or an unreadable file.

import { builtinModules } from 'node:module';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const DEFAULT_ENTRY = 'scripts/export-graphql-sdl.mjs';
export const DEFAULT_MANIFEST = 'scripts/sdl-export-files.txt';
/** Bare packages the CLI's SDL export job installs itself (it also installs `tsx`, which no file imports). */
export const ALLOWED_PACKAGES = new Set(['graphql']);
export const REGENERATE_COMMAND = 'pnpm sdl:manifest --write';

export const MANIFEST_HEADER = [
  '# Files the GraphQL SDL export imports, transitively, from scripts/export-graphql-sdl.mjs (#4916).',
  "# hadron-cli's Schema drift job reads this list to build its sparse checkout of this repository.",
  '# Generated: do not edit by hand. Regenerate with `' + REGENERATE_COMMAND + '`.',
  '# One repo-relative path per line, sorted; a line starting with # is a comment.',
];

const FWD = (p) => p.split(sep).join('/');

const SCRIPT_KINDS = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
]);

function extOf(file) {
  const i = file.lastIndexOf('.');
  return i < 0 ? '' : file.slice(i);
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The import specifiers of one file: `{ specifier }` for a literal, `{ dynamic: true, line }` for a load whose
 * target we cannot read, and `{ syntax: true, line }` for each syntax error (the parser drops what it cannot read).
 */
export function importsOf(fileName, text) {
  const kind = SCRIPT_KINDS.get(extOf(fileName)) ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const d of sf.parseDiagnostics ?? []) {
    found.push({ syntax: true, line: sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 });
  }
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const take = (node, arg) => {
    const s = literal(arg);
    if (s !== undefined) found.push({ specifier: s });
    else found.push({ dynamic: true, line: lineOf(node) });
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const s = literal(node.moduleSpecifier);
      if (s !== undefined) found.push({ specifier: s });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      take(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) take(node, node.arguments[0]);
      else if (ts.isIdentifier(callee) && callee.text === 'require') take(node, node.arguments[0]);
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'resolve' &&
        ts.isMetaProperty(callee.expression) &&
        callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        take(node, node.arguments[0]);
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      const s = ts.isLiteralTypeNode(arg) ? literal(arg.literal) : undefined;
      if (s !== undefined) found.push({ specifier: s });
      else found.push({ dynamic: true, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** `@scope/name/sub` to `@scope/name`, `name/sub` to `name`. */
function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Resolve a relative specifier from `fromFile` to an existing file, or undefined. */
export function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [];
  const swap = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
  const ext = extOf(base);
  if (swap[ext]) for (const e of swap[ext]) candidates.push(base.slice(0, -ext.length) + e);
  candidates.push(base);
  if (!SCRIPT_KINDS.has(ext)) {
    for (const e of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']) candidates.push(base + e);
    for (const e of ['.ts', '.tsx', '.js', '.mjs']) candidates.push(join(base, 'index' + e));
  }
  return candidates.find(isFile);
}

/**
 * The import closure of `entry` (repo-relative, forward slashes, sorted by code unit), plus errors.
 * Only relative specifiers are followed. Files outside `root` are an error: the manifest names repo paths.
 */
export function computeClosure({ root, entry }) {
  const rootAbs = resolve(root);
  const errors = [];
  const seen = new Set();
  const queue = [resolve(rootAbs, entry)];
  const rel = (abs) => FWD(relative(rootAbs, abs));
  if (!isFile(queue[0])) {
    return { files: [], errors: [`entry point ${entry} does not exist under ${FWD(rootAbs)}`] };
  }
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const relPath = rel(file);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      errors.push(`${FWD(file)} is outside the repository root`);
      continue;
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      errors.push(`${relPath}: cannot read: ${err.code ?? err.message}`);
      continue;
    }
    for (const imp of importsOf(file, text)) {
      if (imp.syntax) {
        errors.push(`${relPath}:${imp.line}: syntax error; imports the parser dropped cannot be counted`);
        continue;
      }
      if (imp.dynamic) {
        errors.push(`${relPath}:${imp.line}: an import(), require() or import.meta.resolve() whose argument is not a string literal cannot be followed`);
        continue;
      }
      const s = imp.specifier;
      if (s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..') {
        const target = resolveSpecifier(file, s);
        if (!target) errors.push(`${relPath}: '${s}' does not resolve to a file`);
        else queue.push(target);
      } else if (s.startsWith('#')) {
        errors.push(`${relPath}: '${s}' is a package.json imports alias, which this guard does not follow`);
      } else if (s.startsWith('node:') || builtinModules.includes(s.split('/')[0])) {
        // a Node builtin: always present
      } else if (!ALLOWED_PACKAGES.has(packageName(s))) {
        errors.push(
          `${relPath}: '${s}' is a package the CLI's SDL export job does not install; install it there and add it to ALLOWED_PACKAGES in scripts/check-sdl-export-manifest.mjs, or drop the import`,
        );
      }
    }
  }
  const files = [...seen].map(rel).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, errors };
}

/** The canonical manifest text for a closure: header, one path per line, trailing newline. */
export function renderManifest(files) {
  return MANIFEST_HEADER.join('\n') + '\n' + files.join('\n') + '\n';
}

/** The paths a manifest lists: non-blank, non-`#` lines, trimmed. */
export function parseManifest(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Judge a manifest text against a closure. Returns problem lines (empty = clean). */
export function compare(files, manifestText) {
  const listed = parseManifest(manifestText);
  const problems = [];
  const have = new Set(listed);
  for (const f of files) if (!have.has(f)) problems.push(`missing from the manifest: ${f}`);
  const want = new Set(files);
  for (const f of listed) if (!want.has(f)) problems.push(`in the manifest but not imported by the export: ${f}`);
  if (problems.length === 0 && manifestText !== renderManifest(files)) {
    problems.push('the manifest lists the right files but is not in canonical form (header, sorted, one per line)');
  }
  return problems;
}

function main(argv) {
  const opts = { write: false, root: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
  let entry = DEFAULT_ENTRY;
  let manifest = DEFAULT_MANIFEST;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--root' && argv[i + 1] && !argv[i + 1].startsWith('--')) opts.root = resolve(argv[++i]);
    else if (a === '--entry' && argv[i + 1] && !argv[i + 1].startsWith('--')) entry = argv[++i];
    else if (a === '--manifest' && argv[i + 1] && !argv[i + 1].startsWith('--')) manifest = argv[++i];
    else {
      console.error(`usage: check-sdl-export-manifest.mjs [--write] [--root <dir>] [--entry <path>] [--manifest <path>]`);
      return 2;
    }
  }
  const { files, errors } = computeClosure({ root: opts.root, entry });
  if (errors.length > 0) {
    console.error('✗ the SDL export import closure cannot be computed:');
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }
  const manifestAbs = resolve(opts.root, manifest);
  if (opts.write) {
    writeFileSync(manifestAbs, renderManifest(files));
    console.log(`✓ wrote ${manifest} (${files.length} files)`);
    return 0;
  }
  let text;
  try {
    text = existsSync(manifestAbs) ? readFileSync(manifestAbs, 'utf8') : undefined;
  } catch (err) {
    console.error(`✗ cannot read ${manifest}: ${err.code ?? err.message}`);
    return 2;
  }
  const problems = text === undefined ? [`${manifest} does not exist`] : compare(files, text);
  if (problems.length > 0) {
    console.error(`✗ ${manifest} does not match the files ${entry} imports (#4916):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\nhadron-cli builds its SDL export checkout from this list. Fix it with:\n\n    ${REGENERATE_COMMAND}\n`);
    return 1;
  }
  console.log(`✓ ${manifest} matches the import closure of ${entry} (${files.length} files)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
