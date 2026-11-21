/**
 * #3539 — the alarm helpers' two verbatim leaves, and the bounded graph oracle that keeps `postLimit` out of the
 * GraphQL resolver closure (gate: CHECKED T2 + scoped §10; FIT AT0.5051.2 COMPLIANT).
 *
 * Scope is source graph structure only: handwritten relative TS, value imports/re-exports and literal dynamic imports
 * (explicit type-only edges are erased), external packages and the generated client excluded, nonliteral dynamic imports
 * listed rather than judged. NOT a whole-server or runtime-acyclicity claim: darkWorker -> dueWakes -> resolvers.agentTask
 * -> darkWorker is a different cycle and stays out of scope. The #3332 induced-graph test is unchanged.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { darkAlarmChain as viaDarkWorker } from './darkWorker.js';
import { isSerializationFailure as viaStall } from './stall.js';

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const POST_LIMIT = here('postLimit.ts');
const ALARM_CHAIN = here('alarmChain.ts');
const SERIALIZATION_FAILURE = here('serializationFailure.ts');

type Edges = { runtime: string[]; nonliteral: number };

/** Runtime edges by AST: type-only imports/exports are erased; literal dynamic imports count; nonliteral ones are counted. */
function edgesOf(source: string): Edges {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const out: Edges = { runtime: [], nonliteral: 0 };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly = clause?.isTypeOnly || (clause && !clause.name && bindings
        && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
      if (!typesOnly) out.runtime.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typesOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
      if (!typesOnly) out.runtime.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
      const arg = node.arguments[0]!;
      if (ts.isStringLiteralLike(arg)) out.runtime.push(arg.text);
      else out.nonliteral += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

type Reader = { read: (file: string) => string; has: (file: string) => boolean };
const disk: Reader = { read: file => readFileSync(file, 'utf8'), has: file => existsSync(file) && statSync(file).isFile() };
/** Disk plus synthetic files or replaced sources, so a reintroduced edge is judged against the REAL closure behind it. */
const overlay = (files: Record<string, string>): Reader => ({
  read: file => files[file] ?? disk.read(file),
  has: file => file in files || disk.has(file),
});

const inResolvers = (file: string) => file.includes('/api/graphql/schema/');

/**
 * The handwritten runtime closure of `roots`. A GraphQL resolver source is TERMINAL (reported, never walked): the claim is
 * that no root reaches one. An unresolved handwritten relative target throws (never an empty edge); generated and external
 * targets are outside the model; nonliteral dynamic imports are counted per file, never judged.
 */
function closure(roots: string[], io: Reader) {
  const graph = new Map<string, string[]>();
  const nonliteral = new Map<string, number>();
  const pending: string[][] = roots.map(root => [root]);
  while (pending.length) {
    const path = pending.pop()!;
    const file = path.at(-1)!;
    if (graph.has(file)) continue;
    if (inResolvers(file)) { graph.set(file, []); continue; }
    const edges = edgesOf(io.read(file));
    if (edges.nonliteral) nonliteral.set(file, edges.nonliteral);
    const deps: string[] = [];
    for (const name of edges.runtime) {
      if (!name.startsWith('.')) continue;
      const base = resolve(dirname(file), name);
      if (base.includes('/generated/')) continue;
      const target = [base.replace(/\.js$/, '.ts'), base + '.ts', resolve(base, 'index.ts')].find(c => c.endsWith('.ts') && io.has(c));
      if (!target) throw new Error('unresolved handwritten runtime edge: ' + [...path, name].join(' -> '));
      deps.push(target);
      pending.push([...path, target]);
    }
    graph.set(file, deps);
  }
  return { graph, nonliteral };
}

/** A real computed path from `root` to any resolver source, or null. */
function resolverPath(root: string, graph: Map<string, string[]>): string[] | null {
  const pending: string[][] = [[root]];
  const seen = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    const file = path.at(-1)!;
    if (inResolvers(file)) return path;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of graph.get(file) ?? []) pending.push([...path, dep]);
  }
  return null;
}

const show = (path: string[] | null) => path?.map(file => relative(SRC, file)).join(' -> ');
const ROOTS = [POST_LIMIT, ALARM_CHAIN, SERIALIZATION_FAILURE];

describe('#3539 postLimit and the two leaves reach no GraphQL resolver (actual source, AST reads only)', () => {
  it('the two ruled leaf modules exist', () => {
    expect(existsSync(ALARM_CHAIN), 'alarmChain.ts').toBe(true);
    expect(existsSync(SERIALIZATION_FAILURE), 'serializationFailure.ts').toBe(true);
  });

  // Roots that exist today: on main this reports the REAL postLimit -> darkWorker/stall -> resolver path, not a missing module.
  it.each(ROOTS.filter(existsSync).map(root => [relative(SRC, root), root] as const))(
    '%s has no relative runtime path into a resolver source',
    (_name, root) => {
      const { graph } = closure([root], disk);
      const path = resolverPath(root, graph);
      expect(path, 'runtime back-edge into the resolver closure: ' + show(path)).toBeNull();
    },
  );

  it('lists the nonliteral dynamic imports in the walked closure instead of judging them', () => {
    const { nonliteral } = closure(ROOTS.filter(existsSync), disk);
    expect([...nonliteral.entries()].map(([file, n]) => relative(SRC, file) + ':' + n)).toEqual([]);
  });
});

describe('#3539 oracle controls (the real closure behind a reintroduced edge; no module is evaluated)', () => {
  const postLimit = readFileSync(POST_LIMIT, 'utf8');
  const withLine = (line: string) => overlay({ [POST_LIMIT]: line + '\n' + postLimit });
  const pathFrom = (io: Reader) => resolverPath(POST_LIMIT, closure([POST_LIMIT], io).graph);

  it('re-adding the darkAlarmChain import from darkWorker fails the oracle with a real path', () => {
    const path = pathFrom(withLine("import { darkAlarmChain as reAdded } from './darkWorker.js'; void reAdded;"));
    expect(show(path)).toMatch(/^lib\/agentTasks\/postLimit\.ts -> lib\/agentTasks\/darkWorker\.ts -> .*api\/graphql\/schema\/resolvers\./);
  });

  it('re-adding the serialization predicate import from stall fails the oracle with a real path', () => {
    const path = pathFrom(withLine("import { isSerializationFailure as reAdded } from './stall.js'; void reAdded;"));
    expect(show(path)).toMatch(/^lib\/agentTasks\/postLimit\.ts -> lib\/agentTasks\/stall\.ts -> .*api\/graphql\/schema\/resolvers\./);
  });

  const via = here('launderVia3539.ts');
  it.each([
    ['an intermediate module', "import './launderVia3539.js';"],
    ['a value re-export', "export { x } from './launderVia3539.js';"],
    ['a literal dynamic import', "void import('./launderVia3539.js');"],
  ])('laundering the helper through %s still fails', (_label, line) => {
    const io = overlay({
      [POST_LIMIT]: line + '\n' + postLimit,
      [via]: "import { darkAlarmChain } from './darkWorker.js'; export const x = darkAlarmChain;",
    });
    expect(show(pathFrom(io))).toContain('launderVia3539.ts -> lib/agentTasks/darkWorker.ts');
  });

  it.each([
    "import type { darkAlarmChain } from './darkWorker.js';",
    "import { type darkAlarmChain } from './darkWorker.js';",
    "export type { darkAlarmChain } from './darkWorker.js';",
  ])('a type-only edge is the negative control: %s', line => {
    expect(pathFrom(withLine(line))).toBeNull();
  });

  it('stripping dynamic-import handling would fail the oracle itself (a dynamic-only edge is still an edge)', () => {
    expect(edgesOf("void import('./darkWorker.js');").runtime).toEqual(['./darkWorker.js']);
    expect(edgesOf('void import(name);')).toEqual({ runtime: [], nonliteral: 1 });
  });

  it('an unresolved handwritten relative target throws rather than reading as an empty edge', () => {
    expect(() => closure([POST_LIMIT], overlay({ [POST_LIMIT]: "import './missing3539.js';\n" + postLimit })))
      .toThrow(/unresolved handwritten runtime edge: .*postLimit\.ts -> \.\/missing3539\.js/);
  });
});

/** The declaration of `name` as written (JSDoc excluded), so a move is judged on the function and not its location. */
function declarationHash(file: string, name: string): string {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let hash = '';
  source.forEachChild(node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) hash = createHash('sha256').update(node.getText(source)).digest('hex');
  });
  return hash;
}

describe('#3539 the moved bodies are token-identical to main (sha256 of the declaration text taken at main 69e90a22)', () => {
  it('darkAlarmChain', () => {
    expect(declarationHash(ALARM_CHAIN, 'darkAlarmChain')).toBe('f9641b7d6da5fc2e3bfcbb646ba8d3059748519b55fefaf80d73f1a33d67b630');
  });
  it('isSerializationFailure', () => {
    expect(declarationHash(SERIALIZATION_FAILURE, 'isSerializationFailure')).toBe('87fae7d549f4079a4c6fbd9dcc762ffe2c979be0c06ab1805a1c40928cd6ae9b');
  });
  it('the old homes keep the names as compatibility re-exports of the very same functions', async () => {
    const chain = await import('./alarmChain.js');
    const failure = await import('./serializationFailure.js');
    expect(viaDarkWorker).toBe(chain.darkAlarmChain);
    expect(viaStall).toBe(failure.isSerializationFailure);
  });
});

describe('#3539 the serialization predicate keeps its exact truth table', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', meta });
  it.each([
    ['P2034', known('P2034'), true],
    ['P2010 with SQLSTATE 40001', known('P2010', { code: '40001' }), true],
    ['P2010 with another database code', known('P2010', { code: '23505' }), false],
    ['P2010 with no meta code', known('P2010'), false],
    ['P2002 (unique race)', known('P2002'), false],
    ['a duck-typed P2034', Object.assign(new Error('x'), { code: 'P2034' }), false],
    ['a duck-typed P2010/40001', Object.assign(new Error('x'), { code: 'P2010', meta: { code: '40001' } }), false],
    ['a plain Error', new Error('x'), false],
    ['null', null, false],
  ])('%s -> %s', async (_label, error, expected) => {
    const { isSerializationFailure } = await import('./serializationFailure.js');
    expect(isSerializationFailure(error)).toBe(expected);
    expect(viaStall(error)).toBe(expected);
  });
});

describe('#3539 darkAlarmChain still runs on the exact client it is given', () => {
  const app = { id: 'app', organizationId: null, ownerUserId: 'owner-user' };
  const stub = (rows: { id: string }[]) => {
    const calls: string[] = [];
    const client = {
      $queryRaw: async () => { calls.push('line'); return rows; },
      appMember: { findMany: async () => { calls.push('owners'); return [{ userId: 'member-owner' }]; } },
      orgMember: { findMany: async () => { calls.push('admins'); return []; } },
    };
    return { client, calls };
  };

  it('an empty live line reads the line AND the managers through the passed client, managers via manager', async () => {
    const { darkAlarmChain } = await import('./alarmChain.js');
    const { client, calls } = stub([]);
    expect(await darkAlarmChain(client as never, app, 'w')).toEqual([
      { userId: 'owner-user', via: 'manager' }, { userId: 'member-owner', via: 'manager' },
    ]);
    expect(calls).toEqual(['line', 'owners']);
  });

  it('a non-empty line is returned nearest first, drops the worker itself and duplicates, and adds NO manager', async () => {
    const { darkAlarmChain } = await import('./alarmChain.js');
    const { client, calls } = stub([{ id: 'head' }, { id: 'w' }, { id: 'head' }, { id: 'top' }]);
    expect(await darkAlarmChain(client as never, app, 'w')).toEqual([{ workerId: 'head' }, { workerId: 'top' }]);
    expect(calls).toEqual(['line']);
  });
});
