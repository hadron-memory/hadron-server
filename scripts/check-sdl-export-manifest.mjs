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
// A specifier that is not relative (a bare package, `node:` builtin, `#alias`) is EXCLUDED: the CLI job installs
// `graphql` and `tsx` itself. A `.js` / `.mjs` / `.cjs` specifier resolves to the `.ts` / `.mts` / `.cts` file
// next to it first (what tsx does), then to the literal file; an extensionless one tries `.ts`, `.js` and `index.*`.
//
// Fail closed: a relative specifier that resolves to no file, and a dynamic `import()` whose argument is not a string
// literal, are errors (exit 1), never silently skipped, so the closure is never reported complete when it is not.
//
// Usage: node scripts/check-sdl-export-manifest.mjs [--write] [--root <dir>] [--entry <path>] [--manifest <path>]
// Exit codes: 0 = manifest matches (or was written), 1 = drift or unresolvable import, 2 = usage/read error.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const DEFAULT_ENTRY = 'scripts/export-graphql-sdl.mjs';
export const DEFAULT_MANIFEST = 'scripts/sdl-export-files.txt';
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

/** The import specifiers of one file: `{ specifier }` for a literal, `{ dynamic: true, line }` for one we cannot read. */
export function importsOf(fileName, text) {
  const kind = SCRIPT_KINDS.get(extOf(fileName)) ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const s = literal(node.moduleSpecifier);
      if (s !== undefined) found.push({ specifier: s });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const s = literal(node.arguments[0]);
      if (s !== undefined) found.push({ specifier: s });
      else found.push({ dynamic: true, line: lineOf(node) });
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
    for (const imp of importsOf(file, readFileSync(file, 'utf8'))) {
      if (imp.dynamic) {
        errors.push(`${relPath}:${imp.line}: an import() whose argument is not a string literal cannot be followed`);
        continue;
      }
      const s = imp.specifier;
      if (!(s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..')) continue; // package, node:, #alias
      const target = resolveSpecifier(file, s);
      if (!target) errors.push(`${relPath}: '${s}' does not resolve to a file`);
      else queue.push(target);
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
    else if (a === '--root' && argv[i + 1]) opts.root = resolve(argv[++i]);
    else if (a === '--entry' && argv[i + 1]) entry = argv[++i];
    else if (a === '--manifest' && argv[i + 1]) manifest = argv[++i];
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
  if (existsSync(manifestAbs)) text = readFileSync(manifestAbs, 'utf8');
  else text = undefined;
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
