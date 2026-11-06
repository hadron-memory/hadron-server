import { readFileSync, existsSync, statSync } from 'node:fs';
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
      && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      imports.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

// A closed witness, not an invented sequence of every declared root.
function cycleWitness(graph: Map<string, string[]>, roots: string[]): string[] | null {
  const finished = new Set<string>();
  const stack: string[] = [];
  const active = new Map<string, number>();
  function visit(node: string): string[] | null {
    const start = active.get(node);
    if (start !== undefined) return [...stack.slice(start), node];
    if (finished.has(node)) return null;
    active.set(node, stack.length);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    active.delete(node);
    finished.add(node);
    return null;
  }
  for (const root of roots) {
    const found = visit(root);
    if (found) return found;
  }
  return null;
}

function hasCycle(graph: Map<string, string[]>, roots: string[]): boolean {
  return cycleWitness(graph, roots) !== null;
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
    expect(runtimeImports('import(`worker`); import("chat", { with: { type: "json" } });')).toEqual(['worker', 'chat']);
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
        .flatMap(name => {
          const base = resolve(dirname(file), name);
          const target = [base, base.replace(/\.js$/, '.ts'), base + '.ts', resolve(base, 'index.ts')]
            .find(candidate => roots.includes(candidate));
          return target ? [target] : [];
        });
      graph.set(file, deps);
    }
    const witness = cycleWitness(graph, roots);
    expect(witness, 'runtime dependency cycle: ' + witness?.map(file => relative(src, file)).join(' -> ')).toBeNull();
  });
});

// #3560: fixtures model source edges only; no project module is imported/evaluated.
describe('#3560 discovered cycle diagnostics (synthetic)', () => {
  it('reports actual edges of a two-node cycle, never an isolated third root', () => {
    const graph = new Map([['worker', ['instruction']], ['instruction', ['worker']], ['teamChat', []]]);
    const witness = cycleWitness(graph, [...graph.keys()]);
    expect(witness).not.toBeNull();
    expect(witness![0]).toBe(witness!.at(-1));
    expect(witness).not.toContain('teamChat');
    for (let i = 1; i < witness!.length; i++) expect(graph.get(witness![i - 1]!)).toContain(witness![i]);
  });
  it('handles acyclic and self-cycle graphs', () => {
    expect(cycleWitness(new Map([['a', ['b']], ['b', []]]), ['a', 'b'])).toBeNull();
    expect(cycleWitness(new Map([['a', ['a']]]), ['a'])).toEqual(['a', 'a']);
  });
});

// #3560 engineering policy, not corpus law or runtime/global acyclicity proof.
// Parse handwritten relative TS only. External packages, generated clients and
// nonliteral dynamic imports are outside this model; no module is evaluated.
type SourceReader = { read: (file: string) => string; has: (file: string) => boolean };
const disk: SourceReader = {
  read: file => readFileSync(file, 'utf8'),
  has: file => existsSync(file) && statSync(file).isFile(),
};

function leafGraph(root: string, io: SourceReader): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending: string[][] = [[root]];
  while (pending.length) {
    const path = pending.pop()!;
    const file = path.at(-1)!;
    if (graph.has(file)) continue;
    // A forbidden target is terminal: report the path, never inspect a resolver closure.
    if (file.includes('/api/graphql/schema/')) {
      graph.set(file, []);
      continue;
    }
    const deps: string[] = [];
    for (const name of runtimeImports(io.read(file))) {
      if (!name.startsWith('.')) continue;
      const base = resolve(dirname(file), name);
      if (base.includes('/generated/')) continue; // generated, not handwritten TS
      const target = [base.replace(/\.js$/, '.ts'), base + '.ts', resolve(base, 'index.ts')]
        .find(candidate => candidate.endsWith('.ts') && io.has(candidate));
      if (!target) throw new Error('unresolved handwritten runtime edge: ' + [...path, name].join(' -> '));
      deps.push(target);
      pending.push([...path, target]);
    }
    graph.set(file, deps);
  }
  return graph;
}

function schemaPath(root: string, graph: Map<string, string[]>): string[] | null {
  const pending: string[][] = [[root]];
  const seen = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    const file = path.at(-1)!;
    if (file.includes('/api/graphql/schema/')) return path;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of graph.get(file) ?? []) pending.push([...path, dep]);
  }
  return null;
}

const leaves = ['workerRead', 'appParticipantRead'];

describe('#3560 bounded leaf guards (actual source, AST reads only)', () => {
  it.each(leaves)('%s has no relative runtime path into GraphQL resolver sources', name => {
    const root = fileURLToPath(new URL(name + '.ts', import.meta.url));
    const graph = leafGraph(root, disk);
    const witness = schemaPath(root, graph);
    expect(witness, 'runtime leaf back-edge: ' + witness?.join(' -> ') +
      '; Context imports are type-only, erased at compile').toBeNull();
  });
});

function fixtureReader(sources: Map<string, string>): SourceReader {
  return { read: file => {
    const source = sources.get(file);
    if (source === undefined) throw new Error('missing fixture ' + file);
    return source;
  }, has: file => sources.has(file) };
}

describe('#3560 bounded leaf guard controls (synthetic source, not runtime imports)', () => {
  for (const name of leaves) {
    const root = '/fixture/lib/auth/' + name + '.ts';
    const target = '/fixture/api/graphql/schema/resolvers.worker.ts';
    const via = '/fixture/lib/auth/via.ts';
    const forms = [
      'import { gate } from "../../api/graphql/schema/resolvers.worker.js";',
      'export { gate } from "../../api/graphql/schema/resolvers.worker.js";',
      'import("../../api/graphql/schema/resolvers.worker.js");',
      'import(`../../api/graphql/schema/resolvers.worker.js`);',
    ];
    it.each(forms)(name + ' diagnoses direct and intermediate edge: %s', form => {
      for (const indirect of [false, true]) {
        const sources = new Map([[root, indirect ? 'import "./via.js";' : form], [via, form], [target, 'export const gate = 1;']]);
        const graph = leafGraph(root, fixtureReader(sources));
        const witness = schemaPath(root, graph);
        expect(witness).toEqual(indirect ? [root, via, target] : [root, target]);
        for (let i = 1; i < witness!.length; i++) expect(graph.get(witness![i - 1]!)).toContain(witness![i]);
      }
    });
    it.each([
      'import type { Context } from "../../api/graphql/schema/resolvers.worker.js";',
      'import { type Context } from "../../api/graphql/schema/resolvers.worker.js";',
      'export type { Context } from "../../api/graphql/schema/resolvers.worker.js";',
      'export { type Context } from "../../api/graphql/schema/resolvers.worker.js";',
    ])(name + ' ignores type-only, erased at compile: %s', form => {
      const graph = leafGraph(root, fixtureReader(new Map([[root, form]])));
      expect(graph.get(root)).toEqual([]);
      expect(schemaPath(root, graph)).toBeNull();
    });
    it('stops at the first resolver target without reading its closure from ' + name, () => {
      const sources = new Map([[root, 'import "./via.js";'], [via, 'import "../../api/graphql/schema/resolvers.worker.js";'], [target, 'unreadable resolver body']]);
      const io = fixtureReader(sources);
      const read = (file: string) => {
        if (file === target) throw new Error('must not read the resolver body');
        return io.read(file);
      };
      expect(schemaPath(root, leafGraph(root, { ...io, read }))).toEqual([root, via, target]);
    });
    it('diagnoses unresolved handwritten relative dependencies from ' + name, () => {
      const sources = new Map([[root, 'import "./via.js";'], [via, 'export { gate } from "./missing.js";']]);
      expect(() => leafGraph(root, fixtureReader(sources))).toThrow([root, via, './missing.js'].join(' -> '));
    });
    it('does not evaluate/resolve external, generated or nonliteral targets from ' + name, () => {
      const source = 'import "some-package"; import "../../generated/prisma/index.js"; import(name);';
      expect(leafGraph(root, fixtureReader(new Map([[root, source]]))).get(root)).toEqual([]);
    });
  }
});
