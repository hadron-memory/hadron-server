/**
 * #5015: the inventory the node write-door guard (`src/lib/ownerLimits/writeDoorsGuard5016.test.ts`) compares with its
 * table. Every node insert (`.node.create|createMany|createManyAndReturn|upsert(`) and every `writeNodeCore(` call under
 * `src`, keyed by file and ENCLOSING FUNCTION (never by line, so drift does not fail the guard), parsed with the
 * TypeScript compiler so a comment or a string that names a writer is not a site. Fixtures are excluded by place:
 * `*.test.ts`, `src/test/**`, `src/lib/grants/*Fixtures*.ts`. Not seen: a raw SQL insert, a destructured `node` delegate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** Run from the repository root (vitest's and pnpm's working directory). */
const REPO_ROOT = process.cwd();
export const SRC_ROOT = join(REPO_ROOT, 'src');

export interface WriteSite {
  /** `src/...` path, `/`-separated. */
  file: string;
  /** The two nearest named enclosing functions, methods or properties, outer first (`<module>` at top level). */
  fn: string;
  kind: 'insert' | 'writeNodeCore';
  /** For `writeNodeCore`: the literal `ownerLimit` it states, or `?` when not a string literal. */
  ownerLimit?: string;
  /** #5019: the literal `sizeCeiling` it states, or `?`. */
  sizeCeiling?: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export const isFixturePath = (rel: string): boolean =>
  rel.startsWith('src/test/') || /^src\/lib\/grants\/[^/]*Fixtures[^/]*\.ts$/.test(rel);

function nameOf(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  // `export const hadronCreateNode: RunToolDef = { execute: async … }`: the object names its methods.
  if (ts.isObjectLiteralExpression(node) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isFunctionExpression(node) && node.name) return node.name.getText();
    const p = node.parent;
    if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText();
    // A handler passed to a registration call whose first argument names it: `server.tool('hadron_create_node', …, async () => …)`.
    if (ts.isCallExpression(p) && p.arguments[0] && ts.isStringLiteral(p.arguments[0])) {
      const callee = ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : p.expression.getText();
      return `${callee}(${p.arguments[0].text})`;
    }
  }
  return null;
}

/** The two nearest named enclosing functions, outer first (`hadronCreateNode.execute`), so a generic name is qualified. */
function enclosingFn(node: ts.Node): string {
  const names: string[] = [];
  for (let n: ts.Node | undefined = node.parent; n && names.length < 2; n = n.parent) {
    const name = nameOf(n);
    if (name) names.push(name);
  }
  return names.length ? names.reverse().join('.') : '<module>';
}

/** `x.node.create(` and friends, whatever `x` is (`db`, `tx`, `ctx.db`, `client`). */
const INSERT_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);
function isNodeInsert(call: ts.CallExpression): boolean {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e) || !INSERT_METHODS.has(e.name.text)) return false;
  const target = e.expression;
  return ts.isPropertyAccessExpression(target) && target.name.text === 'node';
}

function optionOf(call: ts.CallExpression, option: string): string {
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === option) {
        return ts.isStringLiteral(p.initializer) ? p.initializer.text : '?';
      }
    }
  }
  return '?';
}

export function scanWriteSites(): WriteSite[] {
  const out: WriteSite[] = [];
  for (const full of walk(SRC_ROOT)) {
    const file = relative(REPO_ROOT, full).replace(/\\/g, '/');
    if (isFixturePath(file)) continue;
    const text = readFileSync(full, 'utf8');
    if (!/\.node\.(create|createMany|createManyAndReturn|upsert)\s*\(|writeNodeCore\s*\(/.test(text)) continue;
    const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        if (isNodeInsert(n)) out.push({ file, fn: enclosingFn(n), kind: 'insert' });
        else if (ts.isIdentifier(n.expression) && n.expression.text === 'writeNodeCore') {
          out.push({ file, fn: enclosingFn(n), kind: 'writeNodeCore', ownerLimit: optionOf(n, 'ownerLimit'), sizeCeiling: optionOf(n, 'sizeCeiling') });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
