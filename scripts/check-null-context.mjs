/**
 * #3705: production Context casts must not hide a literal null userId.
 *
 * A syntactic tripwire, not dataflow. #3923 widened what counts as a `Context` type to the final name `Context`
 * (direct or qualified, as before), a renamed import of it (`import { Context as Ctx }`), a same-file type alias of
 * any of those (`type Ctx = Context`, `type A = H.Context`, `type B = A`) and an import type
 * (`import('./h.js').Context`). The match is still the exact final name: `RequestContext` and `SessionContext` never
 * match, and an alias of an unrelated type is not followed. Documented limits stay: an indirect value, `as any`,
 * Object.assign, and an alias declared in another file are not seen.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const USAGE = 'Usage: node scripts/check-null-context.mjs [--root <source-directory> | --root=<source-directory>]';
function usage() { console.error(USAGE); process.exit(2); }
function fail(message) { console.error(`check-null-context: ${message}`); process.exit(2); }

const args = process.argv.slice(2);
let rootArg = 'src';
if (args.length === 1 && args[0].startsWith('--root=')) rootArg = args[0].slice('--root='.length);
else if (args.length === 2 && args[0] === '--root') rootArg = args[1];
else if (args.length) usage();
if (rootArg === '') usage();
const root = resolve(rootArg);
try {
  if (!statSync(root).isDirectory()) fail(`root ${root} is not a directory`);
} catch (error) {
  if (error?.code === undefined) throw error;
  fail(`cannot read root ${root}: ${error.code}`);
}
function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}
function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['test', '__tests__', 'node_modules'].includes(entry.name)) yield* files(file);
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) yield file;
  }
}
const finalName = (name, source) => name.getText(source).split('.').at(-1);
/** The type names in this file that mean Context: a renamed import and every type alias that resolves to one. */
function contextNames(source) {
  const names = new Set(['Context']);
  const isContext = type => {
    if (ts.isTypeReferenceNode(type)) {
      return ts.isIdentifier(type.typeName) ? names.has(type.typeName.text) : finalName(type.typeName, source) === 'Context';
    }
    return ts.isImportTypeNode(type) && !type.isTypeOf && type.qualifier !== undefined && finalName(type.qualifier, source) === 'Context';
  };
  let grew = true;
  while (grew) {
    grew = false;
    const add = name => { if (!names.has(name)) { names.add(name); grew = true; } };
    (function walk(node) {
      if (ts.isImportSpecifier(node) && node.propertyName?.text === 'Context') add(node.name.text);
      else if (ts.isTypeAliasDeclaration(node) && isContext(node.type)) add(node.name.text);
      ts.forEachChild(node, walk);
    })(source);
  }
  return isContext;
}
const failures = [];
function scan() {
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    if (!/\bContext\b/.test(text) || !/\bnull\b/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const isContext = contextNames(source);
    function visit(node) {
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isContext(node.type)) {
        const value = unwrap(node.expression);
        if (ts.isObjectLiteralExpression(value) && value.properties.some(property => {
          if (!ts.isPropertyAssignment(property)) return false;
          const name = ts.isComputedPropertyName(property.name) ? property.name.expression : property.name;
          return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'userId' &&
            unwrap(property.initializer).kind === ts.SyntaxKind.NullKeyword;
        })) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          failures.push(`${relative(root, file)}:${line}: null userId cast to Context`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
try { scan(); } catch (error) {
  if (error?.code === undefined) throw error;
  fail(`cannot read ${error.path ?? root}: ${error.code}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('OK — no production object literal casts null userId to Context.');
