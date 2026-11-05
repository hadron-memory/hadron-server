import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Parse runtime edges rather than grepping names: type-only back-edges are erased by TypeScript.
function runtimeImports(source: string): string[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly = clause?.isTypeOnly || (clause && !clause.name && bindings
        && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
      if (!typesOnly) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typesOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
      if (!typesOnly) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      imports.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

function reaches(graph: Map<string, string[]>, from: string, target: string): boolean {
  const seen = new Set<string>();
  const pending = [...(graph.get(from) ?? [])];
  while (pending.length) {
    const next = pending.pop()!;
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(graph.get(next) ?? []));
  }
  return false;
}

function hasCycle(graph: Map<string, string[]>, roots: string[]): boolean {
  return roots.some(root => reaches(graph, root, root));
}

describe('#3332 instructed-act runtime import graph', () => {
  it('distinguishes value cycles from type-only back-edges, including mixed imports and re-exports', () => {
    const graph = (back: string) => new Map([
      ['worker', ['instruction']], ['instruction', ['chat']], ['chat', runtimeImports(back)],
    ]);
    const roots = ['worker', 'instruction', 'chat'];
    expect(hasCycle(graph('import { gate } from "worker";'), roots)).toBe(true);
    expect(hasCycle(graph('import type { Context } from "worker";'), roots)).toBe(false);
    expect(runtimeImports('import { type Context } from "worker";')).toEqual([]);
    expect(runtimeImports('import { type Context, gate } from "worker";')).toEqual(['worker']);
    expect(runtimeImports('export { type Context } from "worker";')).toEqual([]);
    expect(runtimeImports('export { type Context, gate } from "worker";')).toEqual(['worker']);
    expect(runtimeImports('import "worker"; import("chat");')).toEqual(['worker', 'chat']);
    expect(hasCycle(graph('import("worker");'), roots)).toBe(true);
    expect(hasCycle(graph('export { gate } from "worker";'), roots)).toBe(true);
    expect(hasCycle(new Map([['worker', ['instruction']], ['instruction', ['worker']], ['chat', []]]), roots)).toBe(true);
  });

  it('has no direct runtime cycle among worker, instruction and teamChat', () => {
    const src = fileURLToPath(new URL('../../', import.meta.url));
    const roots = ['worker', 'instruction', 'teamChat'].map(name => resolve(src, 'api/graphql/schema/resolvers.' + name + '.ts'));
    const graph = new Map<string, string[]>();
    // Gate scope (6670200398): the induced graph of these three modules, not arbitrary
    // transitive cycles in the server. Literal dynamic imports still count as direct edges.
    for (const file of roots) {
      const deps = runtimeImports(readFileSync(file, 'utf8')).filter(name => name.startsWith('.'))
        .map(name => resolve(dirname(file), name).replace(/\.js$/, '.ts'))
        .filter(target => roots.includes(target));
      graph.set(file, deps);
    }
    const witness = roots.map(file => relative(src, file)).concat(relative(src, roots[0]!)).join(' -> ');
    expect(hasCycle(graph, roots), 'runtime dependency cycle: ' + witness).toBe(false);
  });
});
