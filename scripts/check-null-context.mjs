/** #3705: production Context casts must not hide a literal null userId. */
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--root')) {
  console.error('Usage: node scripts/check-null-context.mjs [--root <source-directory>]');
  process.exit(2);
}
const root = resolve(args[1] ?? 'src');
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
const failures = [];
for (const file of files(root)) {
  const text = readFileSync(file, 'utf8');
  if (!/\bContext\b/.test(text) || !/\bnull\b/.test(text)) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(source).split('.').at(-1) === 'Context') {
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
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('OK — no production object literal casts null userId to Context.');
