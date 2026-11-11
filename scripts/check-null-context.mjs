/**
 * #3705: production Context casts must not hide a literal null userId.
 *
 * A syntactic tripwire, not dataflow. #3923 widened what counts as a `Context` type to the final name `Context`
 * (direct or qualified, as before), a renamed import of it (`import { Context as Ctx }`), a type alias of any of
 * those visible from the cast through its lexical scopes (`type Ctx = Context`, `type A = H.Context`, `type B = A`,
 * parentheses ignored) and an import type (`import('./h.js').Context`). The match is still the exact final name:
 * `RequestContext` and `SessionContext` never match, and an alias of an unrelated type is not followed. Documented limits stay: an indirect value, `as any`,
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
/**
 * Does this type node mean Context? `Context` itself (any qualification) always does. A bare name is looked up in the
 * lexical scopes that enclose it, innermost first: the first declaration of that name decides, so an alias in a
 * sibling scope never applies and an inner unrelated declaration shadows an outer alias. A qualified reference to an
 * alias (`ns.Ctx`) is not followed.
 */
function contextResolver(source) {
  const resolving = new Set();
  function isContext(type) {
    while (ts.isParenthesizedTypeNode(type)) type = type.type;
    if (ts.isTypeReferenceNode(type)) {
      if (!ts.isIdentifier(type.typeName)) return finalName(type.typeName, source) === 'Context';
      return type.typeName.text === 'Context' || nameIsContext(type.typeName.text, type);
    }
    return ts.isImportTypeNode(type) && !type.isTypeOf && type.qualifier !== undefined && finalName(type.qualifier, source) === 'Context';
  }
  function declaredIn(statements, name) {
    for (const statement of statements) {
      if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) return statement;
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) return false;
      if (ts.isClassDeclaration(statement) && statement.name?.text === name) return false;
      if (ts.isEnumDeclaration(statement) && statement.name.text === name) return false;
      if (ts.isImportDeclaration(statement)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.name.text === name) return element.propertyName?.text === 'Context';
          }
        }
        if (statement.importClause?.name?.text === name) return false;
      }
    }
    return undefined;
  }
  function nameIsContext(name, from) {
    for (let scope = from.parent; scope; scope = scope.parent) {
      if (!scope.statements) continue;
      const found = declaredIn(scope.statements, name);
      if (found === undefined) continue;
      if (typeof found === 'boolean') return found;
      if (resolving.has(found)) return false;
      resolving.add(found);
      try { return isContext(found.type); } finally { resolving.delete(found); }
    }
    return false;
  }
  return isContext;
}
const failures = [];
function scan() {
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    if (!/\bContext\b/.test(text) || !/\bnull\b/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const isContext = contextResolver(source);
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
