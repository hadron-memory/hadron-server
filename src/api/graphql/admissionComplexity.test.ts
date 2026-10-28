/**
 * hadron-internal#3 L4: depth and estimated cost of the SELECTED operation, proved through the REAL Express + Apollo stack
 * (`createServer`) with spies on the real resolvers, plus plugin-level cases for the branches the stack cannot reach
 * (a throwing estimator, the log bounds, a foreign graphql copy).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSchema, parse, print } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { createServer } from '../../server.js';
import { resolvers } from './schema/resolvers.js';
import { typeDefs } from './schema/typeDefs.js';
import { readGraphqlAdmissionConfig, GRAPHQL_ADMISSION_DEFAULTS, type GraphqlAdmissionConfig } from './admission.js';
import {
  DEFAULT_OMITTED_PAGE_SIZE, OMITTED_PAGE_SIZE, QUERY_TOO_COMPLEX, QueryTooComplexError, complexityAdmissionPlugin,
  hadronListEstimator, selectedOperationDepth,
} from './admissionComplexity.js';

const REVIEWED_PAGED_FIELDS = [
  "Agent.extendedBy",
  "AppKey.hostUses",
  "Chat.servedPrompts",
  "Mutation.collectHostOperations",
  "Node.lintWarnings",
  "Node.signingRequests",
  "NodeApprovalReceipt.lintWarnings",
  "Query.actionTickets",
  "Query.agentAssets",
  "Query.agentSchedules",
  "Query.agentTaskList", // #2421: limit applies only when symptom is present; default 3, cap 3.
  "Query.agentTasks",
  "Query.agentTeamEvents",
  "Query.agentWebhooks",
  "Query.agents",
  "Query.aiModelPrices",
  "Query.aiServiceConfigs",
  "Query.appNodes",
  "Query.appRuns",
  "Query.apps",
  "Query.assets",
  "Query.automationApprovals",
  "Query.calendarEvents",
  "Query.channelMessages",
  "Query.channels",
  "Query.chatHistory",
  "Query.commentThreads",
  "Query.connectionGrants",
  "Query.creditLedgerEntries",
  "Query.dashboardWidgetPresetsPage",
  "Query.decisions",
  "Query.deliveryBatches",
  "Query.driveFiles",
  "Query.dueWakes",
  "Query.edges",
  "Query.exchangeConnectionsPage",
  "Query.exchangeMessages",
  "Query.findNodes",
  "Query.findObjects",
  "Query.globalSearch",
  "Query.heldWorkers",
  "Query.homeAssistantInstances",
  "Query.hostOperations",
  "Query.impersonationSessions",
  "Query.marketplaceAgents",
  "Query.marketplaceMemories",
  "Query.marketplaceOrganizations",
  "Query.mcpServers",
  "Query.memories",
  "Query.memoryAssets",
  "Query.memoryConfigTemplates",
  "Query.memoryEdges",
  "Query.memoryNodes",
  "Query.myChats",
  "Query.nodeEdgeRemovals",
  "Query.nodeRevisions",
  "Query.nodeRevisionsPage",
  "Query.nodeUsage",
  "Query.organizations",
  "Query.principalGrants",
  "Query.publicAgents",
  "Query.recoveryEdges",
  "Query.recoveryNodes",
  "Query.registerEntries",
  "Query.resendSenders",
  "Query.scopes",
  "Query.secrets",
  "Query.sessions",
  "Query.sessionsPage",
  "Query.slackConnections",
  "Query.teamAttentionPage",
  "Query.teamAttentionPreviewPage",
  "Query.teamChatMessages",
  "Query.teamRoles",
  "Query.teamStopSignals",
  "Query.teamWorkItems",
  "Query.tickersPage",
  "Query.usageEvents",
  "Query.usageEventsPage",
  "Query.users",
  "Query.validateMemory",
  "Query.workers",
  "ServedPrompt.provenance",
  "Session.servedPrompts",
  "Ticker.subscribers",
  "User.sharedOrganizations",
  "Worker.signatureLint"
];
const servers: Server[] = [];
type Reply = Omit<Response, 'json'> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function boot(env: Record<string, string> = {}): Promise<string> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    const server = createHttpServer(await createServer());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const post = (base: string, body: unknown): Promise<Reply> =>
  fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const Query = resolvers.Query as Record<string, (...a: unknown[]) => unknown>;
let nodeSpy: ReturnType<typeof vi.spyOn>;
let edgesSpy: ReturnType<typeof vi.spyOn>;
let usageSpy: ReturnType<typeof vi.spyOn>;
let serverInfoSpy: ReturnType<typeof vi.spyOn>;
let logSpy: { mock: { calls: unknown[][] }; mockRestore(): void };

const l4Lines = (): Array<Record<string, unknown>> =>
  logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('graphql.admission.l4')).map((l) => JSON.parse(l));
const noResolverCalls = () => {
  expect(nodeSpy).not.toHaveBeenCalled();
  expect(edgesSpy).not.toHaveBeenCalled();
  expect(usageSpy).not.toHaveBeenCalled();
  expect(serverInfoSpy).not.toHaveBeenCalled();
};

beforeAll(() => {
  nodeSpy = vi.spyOn(Query, 'node').mockResolvedValue(null as never);
  edgesSpy = vi.spyOn(Query, 'edges').mockResolvedValue({ items: [], total: 0 } as never);
  usageSpy = vi.spyOn(Query, 'usageEvents').mockResolvedValue([] as never);
  serverInfoSpy = vi.spyOn(Query, 'serverInfo').mockResolvedValue({ version: 'test' } as never);
});
beforeEach(() => {
  nodeSpy.mockClear(); edgesSpy.mockClear(); usageSpy.mockClear(); serverInfoSpy.mockClear();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined) as unknown as typeof logSpy;
});
afterEach(() => { logSpy.mockRestore(); });
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  vi.restoreAllMocks();
});

/** `{ node(ref: "x") { outgoingEdges { target { outgoingEdges { target { id } } } } } }`, `levels` of edge-then-target. */
const edgeChain = (levels: number): string => {
  let inner = 'id';
  for (let i = 0; i < levels; i++) inner = `outgoingEdges { ${i === 0 ? 'id' : `target { ${inner} }`} }`;
  return `{ node(ref: "x") { ${inner} } }`;
};
/** A document whose selected operation nests fields exactly `depth` deep (cost is irrelevant: raise GRAPHQL_MAX_COST). */
const depthQuery = (depth: number): string => {
  // node (1) + outgoingEdges (2) + target (3) + outgoingEdges (4) + target (5) ...; leaf `id` last.
  let s = 'id';
  let d = depth;
  const names = ['node(ref: "x")', 'outgoingEdges', 'target'];
  const chain: string[] = [names[0]!];
  for (let i = 1; i < depth - 1; i++) chain.push(i % 2 === 1 ? 'outgoingEdges' : 'target');
  s = chain.reduceRight((acc, f) => `${f} { ${acc} }`, 'id');
  void d;
  return `{ ${s} }`;
};
const WIDE = { GRAPHQL_MAX_COST: '1000000000000' };

describe('depth (hand-written), enforce', () => {
  let base: string;
  beforeAll(async () => { base = await boot({ ...WIDE }); });

  it('depth 12 passes and depth 13 is refused, inline, with no resolver call for the refusal', async () => {
    expect(selectedOperationDepth(parse(depthQuery(12)).definitions[0] as never, new Map())).toBe(12);
    const ok = await post(base, { query: depthQuery(12) });
    expect((await ok.json()).errors).toBeUndefined();
    expect(nodeSpy).toHaveBeenCalledTimes(1);
    nodeSpy.mockClear();
    const over = await post(base, { query: depthQuery(13) });
    expect(over.status).toBe(400);
    const body = await over.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].extensions).toMatchObject({ code: QUERY_TOO_COMPLEX, limit: 'depth', max: 12 });
    expect(body.errors[0].message).toBe('The GraphQL query is too complex.');
    const { http: _http, ...shape } = body.errors[0].extensions;
    expect(shape).toEqual({ code: QUERY_TOO_COMPLEX, limit: 'depth', max: 12 });
    noResolverCalls();
  });

  it('counts through fragments and inline fragments the same way', async () => {
    const doc = parse(`{ node(ref: "x") { ...A } } fragment A on Node { ... on Node { outgoingEdges { target { ...B } } } } fragment B on Node { id }`);
    const fragments = new Map(doc.definitions.filter((d) => d.kind === 'FragmentDefinition').map((d) => [(d as any).name.value, d as any]));
    expect(selectedOperationDepth(doc.definitions[0] as never, fragments)).toBe(4);
  });

  it('a fragment cycle or an unknown fragment fails closed (depth Infinity)', () => {
    const cyc = parse(`{ node(ref: "x") { ...A } } fragment A on Node { ...B } fragment B on Node { ...A }`);
    const frags = new Map(cyc.definitions.filter((d) => d.kind === 'FragmentDefinition').map((d) => [(d as any).name.value, d as any]));
    expect(selectedOperationDepth(cyc.definitions[0] as never, frags)).toBe(Infinity);
    expect(selectedOperationDepth(parse('{ node(ref: "x") { ...Gone } }').definitions[0] as never, new Map())).toBe(Infinity);
  });

  it('configuration moves the bound, and the refusal does not echo the query or variables', async () => {
    const small = await boot({ ...WIDE, GRAPHQL_MAX_DEPTH: '3' });
    const marker = 'SENTINEL_DO_NOT_ECHO';
    const res = await post(small, { query: depthQuery(4).replace('"x"', `"${marker}"`), variables: { v: marker } });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('"max":3');
    expect(text).not.toContain(marker);
    expect(l4Lines().some((l) => JSON.stringify(l).includes(marker))).toBe(false);
  });
});

describe('cost (graphql-query-complexity), enforce', () => {
  const schema = buildSchema(typeDefs);
  const est = hadronListEstimator({ maxCost: 25_000, listFactor: 10 });
  const cost = (query: string, variables: Record<string, unknown> = {}, e = est) =>
    getComplexity({ schema, query: parse(query), variables, estimators: [e, simpleEstimator({ defaultComplexity: 1 })] });

  it('the model: leaf 1, unpaged list 1 + L x children, an object field 1 + children', () => {
    expect(cost('{ node(ref: "x") { outgoingEdges { id } } }')).toBe(12);
    expect(cost('{ serverInfo { version } }')).toBe(2);
    expect(cost('{ __typename }')).toBe(0);
  });

  it('a list that states its page size multiplies by it; a wrapper around a list does too (the dominant shape)', () => {
    expect(cost('{ usageEvents(limit: 200) { id } }')).toBe(1 + 200 * 1);
    // edges is EdgesPage { items [Edge] total }: items costs 1 + 10 x 1 = 11, total 1, wrapper = 1 + (200 / 10) x 12
    expect(cost('{ edges(limit: 200) { items { id } total } }')).toBe(1 + 20 * 12);
    // below the factor the wrapper never goes under its children
    expect(cost('{ edges(limit: 3) { items { id } total } }')).toBe(1 + 1 * 12);
  });

  it('a literal and a variable page size count the same', () => {
    const lit = cost('{ edges(limit: 5000) { items { id } } }');
    const variable = cost('query($n: Int) { edges(limit: $n) { items { id } } }', { n: 5000 });
    expect(variable).toBe(lit);
    expect(lit).toBeGreaterThan(5000);
  });

  it('zero is not free, a negative size is its magnitude, and omitted/null falls back to the largest common default', () => {
    expect(cost('{ usageEvents(limit: 0) { id } }')).toBe(1 + 1);
    expect(cost('{ usageEvents(limit: -300) { id } }')).toBe(1 + 300);
    expect(cost('{ usageEvents { id } }')).toBe(1 + 100);
    expect(cost('{ usageEvents(limit: null) { id } }')).toBe(1 + 100);
    expect(cost('{ memoryNodes(memoryRef: "m") { nodes { id } } }')).toBe(1 + 100 * (1 + 10));
  });

  it('every field whose resolver default exceeds the common one is costed at THAT default when the size is omitted or null', () => {
    const pagedList = (name: string) => `{ ${name} }`;
    expect(OMITTED_PAGE_SIZE['Query.appNodes']).toBe(500); // take: limit ?? 500
    expect(cost('{ appNodes(appRef: "a") { id } }')).toBe(1 + 500);
    expect(cost('{ appNodes(appRef: "a", limit: null) { id } }')).toBe(1 + 500);
    expect(cost('{ appNodes(appRef: "a", limit: 500) { id } }')).toBe(1 + 500);
    expect(cost('{ memoryEdges(memoryRef: "m") { edges { id } } }')).toBe(1 + 100 * (1 + 10));
    expect(cost('{ validateMemory(memoryRef: "m") { total } }')).toBeGreaterThan(0);
    void pagedList;
    for (const [field, size] of Object.entries(OMITTED_PAGE_SIZE)) expect(size).toBeGreaterThan(DEFAULT_OMITTED_PAGE_SIZE - 1);
    expect(DEFAULT_OMITTED_PAGE_SIZE).toBe(100);
  });

  it('#2421 keeps legacy task-list costing without symptom and uses limit only for ranked calls', () => {
    expect(cost('{ agentTaskList(ref: "a") { node { id } } }')).toBe(21);
    expect(cost('{ agentTaskList(ref: "a", limit: 1) { node { id } } }')).toBe(21);
    expect(cost('{ agentTaskList(ref: "a", symptom: null, limit: 1) { node { id } } }')).toBe(21);
    expect(cost('{ agentTaskList(ref: "a", symptom: "failure", limit: 1) { node { id } } }')).toBe(3);
    // Admission intentionally ignores resolver caps: conservative overestimates.
    expect(cost('{ agentTaskList(ref: "a", symptom: "failure") { node { id } } }')).toBe(201);
    expect(cost('{ agentTaskList(ref: "a", symptom: "failure", limit: 99) { node { id } } }')).toBe(199);
  });

  it('inventory: the schema\'s paged fields are exactly the reviewed set (a new one must be checked against its resolver default and listed here)', async () => {
    const { isObjectType } = await import('graphql');
    const found: string[] = [];
    for (const t of Object.values(schema.getTypeMap())) {
      if (!isObjectType(t) || t.name.startsWith('__')) continue;
      for (const f of Object.values(t.getFields())) if (f.args.some((a) => /^(first|last|limit|top|take|pageSize|count)$/.test(a.name))) found.push(`${t.name}.${f.name}`);
    }
    expect(found.sort()).toEqual(REVIEWED_PAGED_FIELDS);
    for (const key of Object.keys(OMITTED_PAGE_SIZE)) expect(REVIEWED_PAGED_FIELDS).toContain(key);
  });

  it('saturates: a huge page size cannot wrap around or go non-finite', () => {
    expect(cost('{ usageEvents(limit: 2147483647) { id } }')).toBe(25_001);
    expect(cost('{ edges(limit: 2147483647) { items { id } } }')).toBe(25_001);
  });

  it('mutant control: the simple estimator alone undercounts both pins (so they bite)', () => {
    const simple = (q: string) => getComplexity({ schema, query: parse(q), variables: {}, estimators: [simpleEstimator({ defaultComplexity: 1 })] });
    expect(simple('{ usageEvents(limit: 2147483647) { id } }')).toBe(2);
    expect(simple('{ edges(limit: 5000) { items { id } } }')).toBeLessThan(10);
  });

  describe('over HTTP', () => {
    let base: string;
    beforeAll(async () => { base = await boot({ GRAPHQL_MAX_COST: '12', GRAPHQL_MAX_DEPTH: '100' }); });

    it('exactly the limit passes and one over is refused with the same data (cost 12 vs 11)', async () => {
      const q = '{ node(ref: "x") { outgoingEdges { id } } }';
      const ok = await post(base, { query: q });
      expect((await ok.json()).errors).toBeUndefined();
      expect(nodeSpy).toHaveBeenCalledTimes(1);
      nodeSpy.mockClear();
      const tight = await boot({ GRAPHQL_MAX_COST: '11', GRAPHQL_MAX_DEPTH: '100' });
      const over = await post(tight, { query: q });
      expect(over.status).toBe(400);
      expect((await over.json()).errors[0].extensions).toMatchObject({ code: QUERY_TOO_COMPLEX, limit: 'cost', max: 11 });
      noResolverCalls();
    });
  });

  describe('at the shipped limits', () => {
    let base: string;
    beforeAll(async () => { base = await boot(); });

    it('nested unpaged lists are costed at L: one 5-level branch passes, two are refused, with no resolver call', async () => {
      expect((await (await post(base, { query: edgeChain(5) })).json()).errors).toBeUndefined();
      nodeSpy.mockClear();
      // A sixth level hits depth first; duplicate the five-level branch to isolate cost.
      const branch = edgeChain(5).slice(1, -1);
      const over = await post(base, { query: `{ a: ${branch} b: ${branch} }` });
      expect(over.status).toBe(400);
      expect((await over.json()).errors[0].extensions).toMatchObject({ code: QUERY_TOO_COMPLEX, limit: 'cost' });
      noResolverCalls();
    });

    it('limit 2147483647 on a list is refused, as a literal and as a variable', async () => {
      for (const body of [
        { query: '{ usageEvents(limit: 2147483647) { id } }' },
        { query: 'query($n: Int) { usageEvents(limit: $n) { id } }', variables: { n: 2147483647 } },
        { query: 'query($n: Int) { edges(limit: $n) { items { id } } }', variables: { n: 2147483647 } },
      ]) {
        const res = await post(base, body);
        expect(res.status).toBe(400);
        expect((await res.json()).errors[0].extensions.code).toBe(QUERY_TOO_COMPLEX);
      }
      noResolverCalls();
    });

    it('a wide, cheap query passes', async () => {
      const fields = Array.from({ length: 400 }, (_, i) => `a${i}: __typename`).join(' ');
      const res = await post(base, { query: `{ serverInfo { version } ${fields} }` });
      expect((await res.json()).errors).toBeUndefined();
    });

    it('the unselected operation is never costed: an over-limit A does not stop B', async () => {
      const doc = `query A { ${'usageEvents(limit: 2147483647) { id } '} } query B { serverInfo { version } }`;
      const b = await post(base, { query: doc, operationName: 'B' });
      expect((await b.json()).errors).toBeUndefined();
      expect(serverInfoSpy).toHaveBeenCalledTimes(1);
      expect(usageSpy).not.toHaveBeenCalled();
      expect(l4Lines().filter((l) => l.outcome !== 'near_limit')).toEqual([]);
      const a = await post(base, { query: doc, operationName: 'A' });
      expect(a.status).toBe(400);
    });

    it('a bad variable gets the ordinary variable error, not this refusal, and no resolver call or L4 line', async () => {
      const res = await post(base, { query: 'query($n: Int) { usageEvents(limit: $n) { id } }', variables: { n: 'x' } });
      const body = await res.json();
      expect(body.errors[0].extensions.code).not.toBe(QUERY_TOO_COMPLEX);
      expect(body.errors[0].message).toBe('Invalid GraphQL variable input.');
      noResolverCalls();
      expect(l4Lines()).toEqual([]);
    });
  });

  it('the node cap maps to this refusal (not a 500) when L3 allows a document that large', async () => {
    const base = await boot({ GRAPHQL_MAX_SELECTIONS: '1000000', GRAPHQL_MAX_TOKENS: '1000000', GRAPHQL_MAX_QUERY_BYTES: '5000000' });
    const fields = Array.from({ length: 10_100 }, (_, i) => `a${i}: __typename`).join(' ');
    const res = await post(base, { query: `{ ${fields} }` });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].extensions).toMatchObject({ code: QUERY_TOO_COMPLEX, limit: 'cost' });
    // recognised as the node cap (an over-limit refusal), not as an estimator failure
    expect(l4Lines().map((l) => l.outcome)).toEqual(['refused']);
  });
});

describe('modes', () => {
  const over = { query: '{ usageEvents(limit: 2147483647) { id } }' };

  it('observe: the same over-limit request executes and returns its data; exactly one would_refuse line, with no source or values in it', async () => {
    const base = await boot({ GRAPHQL_COMPLEXITY_MODE: 'observe' });
    const marker = 'MARKER_ARG_VALUE_123';
    const res = await post(base, { query: 'query Probe($m: String) { MARKER_ALIAS_QQ: usageEvents(limit: 2147483647, loc: $m) { id } }', variables: { m: marker } });
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(usageSpy).toHaveBeenCalledTimes(1);
    const lines = l4Lines().filter((l) => l.outcome === 'would_refuse');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mode: 'observe', outcome: 'would_refuse', limit: 'cost', max: 200_000, operationType: 'query', operationName: 'Probe', principal: 'anonymous' });
    expect(typeof lines[0]!.queryHash).toBe('string');
    expect(JSON.stringify(lines)).not.toContain(marker);
    expect(JSON.stringify(lines)).not.toContain('usageEvents');
    expect(JSON.stringify(lines)).not.toContain('MARKER_ALIAS_QQ');
  });

  it('the same request is refused under enforce and admitted under observe: only the environment differs', async () => {
    const enforce = await post(await boot({ GRAPHQL_COMPLEXITY_MODE: 'enforce' }), over);
    expect(enforce.status).toBe(400);
    expect(usageSpy).not.toHaveBeenCalled();
    const observe = await post(await boot({ GRAPHQL_COMPLEXITY_MODE: 'observe' }), over);
    expect((await observe.json()).errors).toBeUndefined();
    expect(usageSpy).toHaveBeenCalledTimes(1);
  });

  it('an unset mode is enforce, and off, Observe, an empty value or a number refuse boot without echoing it', async () => {
    expect(readGraphqlAdmissionConfig({}).complexityMode).toBe('enforce');
    for (const bad of ['off', 'Observe', '', 'false', '0', 'OBSERVE ']) {
      let message = '';
      try { readGraphqlAdmissionConfig({ GRAPHQL_COMPLEXITY_MODE: bad }); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/GRAPHQL_COMPLEXITY_MODE must be exactly "observe" or "enforce"/);
      if (bad) expect(message).not.toContain(bad);
    }
    process.env.GRAPHQL_COMPLEXITY_MODE = 'off';
    try { await expect(createServer()).rejects.toThrow(/refusing to boot/); } finally { delete process.env.GRAPHQL_COMPLEXITY_MODE; }
  });

  it('observe still measures every request (near_limit is reported) and logs the boot configuration line', async () => {
    await boot({ GRAPHQL_COMPLEXITY_MODE: 'observe' });
    const cfg = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('graphql.admission.config'));
    expect(JSON.parse(cfg!)).toMatchObject({ mode: 'observe', maxDepth: 12, maxCost: 200_000, listFactor: 10 });
  });
});

/** Plugin-level: drive the hook directly with a real parsed operation. */
describe('plugin branches the stack cannot reach', () => {
  const schema = buildSchema(typeDefs);
  const cfg = (mode: 'observe' | 'enforce'): Pick<GraphqlAdmissionConfig, 'maxDepth' | 'maxCost' | 'listFactor' | 'complexityMode'> =>
    ({ ...GRAPHQL_ADMISSION_DEFAULTS, complexityMode: mode });
  const run = async (plugin: ReturnType<typeof complexityAdmissionPlugin>, query: string, extra: Record<string, unknown> = {}) => {
    const document = parse(query);
    const hooks = await (plugin.requestDidStart as (c: unknown) => Promise<any>)({});
    return hooks.didResolveOperation({
      schema, document, operation: document.definitions.find((d) => d.kind === 'OperationDefinition'),
      request: { variables: {} }, queryHash: 'h1', contextValue: {}, ...extra,
    });
  };
  const small = '{ serverInfo { version } }';

  it('fail closed: a throwing estimator refuses in enforce and is logged as error in observe, which admits', async () => {
    const boom = [() => { throw new Error('estimator exploded'); }];
    const lines: string[] = [];
    await expect(run(complexityAdmissionPlugin(cfg('enforce'), { log: (l) => lines.push(l), estimators: boom as never }), small))
      .rejects.toBeInstanceOf(QueryTooComplexError);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'error', mode: 'enforce' });
    const lines2: string[] = [];
    await expect(run(complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines2.push(l), estimators: boom as never }), small)).resolves.toBeUndefined();
    expect(JSON.parse(lines2[0]!)).toMatchObject({ outcome: 'error', mode: 'observe' });
    expect(lines.join('') + lines2.join('')).not.toContain('estimator exploded');
  });

  it('a schema from a second copy of graphql is an error, never a silent "no lists"', async () => {
    const other = (await import('graphql/index.mjs' as string)) as typeof import('graphql');
    const foreign = other.buildSchema(typeDefs);
    const lines: string[] = [];
    await expect(run(complexityAdmissionPlugin(cfg('enforce'), { log: (l) => lines.push(l) }), small, { schema: foreign })).rejects.toBeInstanceOf(QueryTooComplexError);
    expect(JSON.parse(lines[0]!).outcome).toBe('error');
  });

  it('under NODE_ENV=production a schema from a second graphql copy is still an error (graphql only throws in development)', () => {
    const script = `
      import { createRequire } from 'node:module';
      import { complexityAdmissionPlugin } from './src/api/graphql/admissionComplexity.ts';
      import { typeDefs } from './src/api/graphql/schema/typeDefs.ts';
      const require = createRequire(import.meta.url);
      const esm = await import('graphql/index.mjs');
      const foreign = esm.buildSchema(typeDefs);
      const cjs = require('graphql');
      const document = cjs.parse('{ usageEvents(limit: 2147483647) { id } }');
      const lines = [];
      const plugin = complexityAdmissionPlugin({ maxDepth: 12, maxCost: 25000, listFactor: 10, complexityMode: 'observe' }, { log: (l) => lines.push(l) });
      const hooks = await plugin.requestDidStart({});
      await hooks.didResolveOperation({ schema: foreign, document, operation: document.definitions[0], request: { variables: {} }, queryHash: 'h', contextValue: {} });
      console.log('RESULT ' + JSON.stringify(lines.map((l) => JSON.parse(l).outcome)));
    `;
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8',
    });
    expect(out).toContain('RESULT ["error"]');
  }, 60_000);

  it('operation names are untrusted labels: only a plain identifier is logged, cut to 100 characters', async () => {
    const lines: string[] = [];
    const p = complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines.push(l) });
    await run(p, 'query Ok { usageEvents(limit: 2147483647) { id } }', { request: { variables: {}, operationName: 'x"; DROP' } });
    await run(p, 'query Ok { usageEvents(limit: 2147483646) { id } }', { queryHash: 'h2', request: { variables: {}, operationName: 'A'.repeat(300) } });
    expect(JSON.parse(lines[0]!).operationName).toBeNull();
    expect(JSON.parse(lines[1]!).operationName).toBeNull(); // 300 chars exceeds the identifier bound
  });

  describe('log bounds', () => {
    const overQuery = 'query { usageEvents(limit: 2147483647) { id } }';
    it('100 identical over-limit requests log one line; the count rides on the next permitted line, never as an extra line', async () => {
      let t = 1_000_000;
      const lines: string[] = [];
      const p = complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines.push(l), now: () => t });
      for (let i = 0; i < 100; i++) await run(p, overQuery);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).suppressed).toBeUndefined();
      t += 60_001;
      await run(p, overQuery);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!).suppressed).toBe(99);
    });

    it('a caller that varies the query is bounded by the global per-window budget, and the remainder is counted', async () => {
      let t = 5_000_000;
      const lines: string[] = [];
      const p = complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines.push(l), now: () => t });
      for (let i = 0; i < 200; i++) await run(p, overQuery, { queryHash: `h${i}` });
      expect(lines.length).toBeLessThanOrEqual(30);
      t += 60_001;
      await run(p, overQuery, { queryHash: 'fresh' });
      expect(JSON.parse(lines.at(-1)!).suppressedOther).toBe(200 - 30);
    });

    it('the per-key map is bounded: far more distinct hashes than its capacity never grow it without limit', async () => {
      let t = 9_000_000;
      const lines: string[] = [];
      const p = complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines.push(l), now: () => t });
      for (let w = 0; w < 50; w++) {
        for (let i = 0; i < 30; i++) await run(p, overQuery, { queryHash: `w${w}-${i}` });
        t += 60_001;
      }
      // 1,500 distinct keys passed through; an evicted key logs again immediately rather than being remembered forever.
      await run(p, overQuery, { queryHash: 'w0-0' });
      expect(lines.length).toBeGreaterThan(1000);
    });

    it('the per-key map is capped: past its capacity the oldest key is forgotten (and logs again), a recent one is still deduped', async () => {
      const t = 3_000_000;
      const lines: string[] = [];
      const p = complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines.push(l), now: () => t, maxKeys: 5, decisionBudget: 1000 });
      for (let i = 0; i < 10; i++) await run(p, overQuery, { queryHash: `k${i}` });
      expect(lines).toHaveLength(10);
      await run(p, overQuery, { queryHash: 'k9' }); // still remembered: deduped
      expect(lines).toHaveLength(10);
      await run(p, overQuery, { queryHash: 'k0' }); // evicted by the cap: logs again within the same window
      expect(lines).toHaveLength(11);
    });

    it('margin readings cannot starve decisions: near_limit has its own budget', async () => {
      const t = 4_000_000;
      const lines: string[] = [];
      const p = complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines.push(l), now: () => t, marginBudget: 3 });
      const near = 'query { node(ref: "x") { outgoingEdges { target { outgoingEdges { target { outgoingEdges { target { outgoingEdges { target { id } } } } } } } } } }';
      for (let i = 0; i < 20; i++) await run(p, near, { queryHash: `n${i}` });
      const margin = lines.map((l) => JSON.parse(l).outcome);
      expect(margin.filter((o) => o === 'near_limit').length).toBe(3);
      await run(p, overQuery, { queryHash: 'decision' });
      expect(JSON.parse(lines.at(-1)!).outcome).toBe('would_refuse');
    });

    it('the printed query never reaches the log', async () => {
      const lines: string[] = [];
      const p = complexityAdmissionPlugin(cfg('observe'), { log: (l) => lines.push(l) });
      await run(p, 'query Probe { usageEvents(limit: 2147483647, loc: "SECRET_LITERAL") { id } }');
      expect(lines.join('')).not.toContain('SECRET_LITERAL');
      expect(print(parse(small))).toBeTruthy();
    });
  });
});
