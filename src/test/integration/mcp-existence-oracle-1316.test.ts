/**
 * #1316 — the MCP tools must not tell an unreadable memory (or a node inside
 * one) from a missing one.
 *
 * #1350 closed six GraphQL surfaces. The #1316 checkpoint-2 audit found 16 MCP
 * tools with the same defect: each resolved the memory (only a MISSING memory
 * refuses there) and then ran its own write/read gate with its own denial text,
 * so "exists but you can't read it" answered differently from "no such memory".
 * Memory URNs are guessable, which made each one a cross-tenant name oracle —
 * and for the node-addressed tools, a node-existence oracle too, because an
 * existing node and a missing loc in the same unreadable memory also differed.
 *
 * Every assertion is PAIRED over real `/mcp` (the SDK's own Streamable HTTP
 * client, a real UserApiKey): the same call against an existing target and a
 * missing one, compared as the complete tool result after substituting only the
 * caller-supplied memory slug / loc. Controls pin what must NOT change: a reader
 * who may read but not write keeps the actionable denial, a permitted writer
 * still succeeds, and a denied call leaves no side effect.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey, type OAuthScope } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

const PROBE = 'probe';
const TASK = 'probe-task';
const REVIEW = 'probe-review';

let server: Server;
let baseUrl: string;
let suffix: string;
let orgUrn: string;
/** The existing victim memory's slug, and the missing one's, in the same org. */
let victimSlug: string;
let absentSlug: string;
const ABSENT_LOC = 'no-such-loc';
let victimId: string;
let outsiderTargetUrn: string;
const key: Record<string, string> = {};
const clients: Client[] = [];

async function connect(k: string): Promise<Client> {
  const client = new Client({ name: 'oracle-1316', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${k}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const session: Record<string, Client> = {};

async function call(principal: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await session[principal].callTool({ name, arguments: args })) as ToolResult;
  // A probe the SDK refuses on input shape never reaches a gate, so both sides
  // of a pair would match trivially and the pair would pass while proving
  // nothing. That masked the first draft of the replace_text probes.
  expect(text(result)).not.toMatch(/Input validation error/);
  return result;
}

const text = (r: ToolResult) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

type Gql = { status: number; data: unknown; errors: Array<{ message: string; extensions?: Record<string, unknown> }> | undefined };

/** The same resolvers over GraphQL, where the typed `extensions` are part of the wire. */
async function gql(principal: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key[principal]}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as Omit<Gql, 'status'>;
  return { status: response.status, data: body.data, errors: body.errors };
}

const gqlCode = (r: Gql) => r.errors?.[0]?.extensions?.code;

/**
 * The complete tool result with the caller's own memory slug / loc replaced by
 * placeholders — the ONLY difference a paired call is allowed to show. Any
 * other difference (an internal id, a different sentence, a different isError)
 * is the oracle.
 */
function wire(r: ToolResult | Gql): string {
  return JSON.stringify(r)
    .split(victimSlug).join('<M>')
    .split(absentSlug).join('<M>')
    .split(ABSENT_LOC).join('<L>')
    .split(`:${PROBE}`).join(':<L>')
    .split(`:${TASK}`).join(':<L>')
    .split(`:${REVIEW}`).join(':<L>');
}

const memUrn = (slug: string) => `hrn:mem:${orgUrn}:${slug}`;
const nodeUrn = (slug: string, loc: string) => `hrn:node:${orgUrn}:${slug}:${loc}`;

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgUrn = `oracle-mcp-${suffix}`;
  victimSlug = `victim-${suffix}`;
  absentSlug = `absent-${suffix}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'victim org', urn: orgUrn } });
  const otherOrg = await db.organization.create({
    data: { id: generateId(), name: 'outsider org', urn: `oracle-mcp-other-${suffix}` },
  });
  const mkUser = (label: string, roles: Array<'ADMIN'> = []) =>
    db.user.create({
      data: { id: generateId(), handle: `${label}-${suffix}`, githubUsername: `${label}-${suffix}`, roles },
    });
  const writer = await mkUser('writer', ['ADMIN']);
  const reader = await mkUser('reader');
  const outsider = await mkUser('outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: writer.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const mint = async (userId: string, label: string, oauthScopes: OAuthScope[]) =>
    (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes })).rawKey;
  key.writer = await mint(writer.id, 'writer', ['account']);
  key.reader = await mint(reader.id, 'reader', ['account']);
  key.outsider = await mint(outsider.id, 'outsider', ['account']);

  // The victim: an org knowledge memory. The reader may read it (org
  // membership confers READ_ONLY) but not write it; the outsider may do neither.
  const victim = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${orgUrn}:${victimSlug}`,
      name: 'victim knowledge',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
  victimId = victim.id;
  await db.node.create({
    data: { id: generateId(), memoryId: victim.id, loc: PROBE, name: 'probe', content: 'needle', data: { k: 1 } },
  });
  await db.node.create({
    data: { id: generateId(), memoryId: victim.id, loc: TASK, name: 'task', isRunnable: true },
  });
  await db.node.create({
    data: { id: generateId(), memoryId: victim.id, loc: REVIEW, name: 'review', role: 'review' },
  });

  // The outsider's OWN writable memory — a legitimate edge/move target, so the
  // source side is the only thing the paired call varies.
  const own = await db.memory.create({
    data: {
      id: generateId(),
      urn: `${otherOrg.urn}:own-${suffix}`,
      name: 'outsider own',
      class: 'knowledge',
      ownerUserId: outsider.id,
    },
  });
  await db.node.create({ data: { id: generateId(), memoryId: own.id, loc: 'target', name: 'target' } });
  outsiderTargetUrn = `hrn:node:${own.urn}:target`;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of ['writer', 'reader', 'outsider']) session[p] = await connect(key[p]);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

/** Everything a denied call must leave untouched. */
async function sideEffects() {
  const nodes = await db.node.findMany({
    where: { memoryId: victimId },
    select: { loc: true, name: true, content: true, data: true, revSeq: true, deletedAt: true, memoryId: true },
    orderBy: { loc: 'asc' },
  });
  const [edges, channels, memories] = await Promise.all([db.edge.count(), db.channel.count(), db.memory.count()]);
  return { nodes, edges, channels, memories };
}

/**
 * A tool call parameterised by the target memory slug and (for node-addressed
 * tools) the loc. `loc` is the EXISTING node for a paired call against the
 * victim; the missing-loc and missing-memory controls substitute their own.
 */
type Probe = {
  name: string;
  tool: string;
  args: (slug: string, loc: string) => Record<string, unknown>;
  /** The loc of the existing node this tool addresses; absent for memory-ref tools. */
  loc?: string;
};

const MEMORY_REF: Probe[] = [
  { name: 'hadron_set_active_memory', tool: 'hadron_set_active_memory', args: (m) => ({ memoryUrn: memUrn(m) }) },
  { name: 'hadron_validate', tool: 'hadron_validate', args: (m) => ({ memoryUrn: memUrn(m) }) },
  { name: 'hadron_sync_graph', tool: 'hadron_sync_graph', args: (m) => ({ memoryUrn: memUrn(m) }) },
  // #3082: hadron_create_channel is off over MCP; its probe (unreadable ≡ missing, reader keeps the denial, no side
  // effect) runs on the GraphQL createChannel entry of GQL_PROBES below, unchanged.
  {
    name: 'hadron_replace_text(memoryUrns)',
    tool: 'hadron_replace_text',
    args: (m) => ({ oldText: 'needle', newText: 'pin', fields: ['content'], memoryUrns: [memUrn(m)] }),
  },
];

const NODE_URN_DOORS: Probe[] = [
  { name: 'hadron_create_node', tool: 'hadron_create_node', args: (m) => ({ urn: nodeUrn(m, 'fresh'), name: 'x' }) },
  { name: 'hadron_create_parent_node', tool: 'hadron_create_parent_node', args: (m) => ({ urn: nodeUrn(m, 'fresh-parent') }) },
  { name: 'hadron_update_node', tool: 'hadron_update_node', loc: PROBE, args: (m, l) => ({ urn: nodeUrn(m, l), name: 'renamed' }) },
  { name: 'hadron_create_task', tool: 'hadron_create_task', args: (m) => ({ urn: nodeUrn(m, 'fresh-task'), name: 'x' }) },
  { name: 'hadron_update_task', tool: 'hadron_update_task', loc: TASK, args: (m, l) => ({ urn: nodeUrn(m, l), name: 'renamed' }) },
  { name: 'hadron_create_review', tool: 'hadron_create_review', args: (m) => ({ urn: nodeUrn(m, 'fresh-review'), name: 'x' }) },
  { name: 'hadron_update_review', tool: 'hadron_update_review', loc: REVIEW, args: (m, l) => ({ urn: nodeUrn(m, l), name: 'renamed' }) },
];

const NODE_ORACLE: Probe[] = [
  { name: 'hadron_update_node_data', tool: 'hadron_update_node_data', loc: PROBE, args: (m, l) => ({ nodeUrn: nodeUrn(m, l), data: { k: 2 } }) },
  { name: 'hadron_update_object', tool: 'hadron_update_object', loc: PROBE, args: (m, l) => ({ ref: nodeUrn(m, l), fields: { k: 2 } }) },
  { name: 'hadron_delete_object', tool: 'hadron_delete_object', loc: PROBE, args: (m, l) => ({ ref: nodeUrn(m, l) }) },
  {
    name: 'hadron_replace_text(nodeUrns)',
    tool: 'hadron_replace_text',
    loc: PROBE,
    args: (m, l) => ({ oldText: 'needle', newText: 'pin', fields: ['content'], nodeUrns: [nodeUrn(m, l)] }),
  },
  {
    name: 'hadron_create_edge(source)',
    tool: 'hadron_create_edge',
    loc: PROBE,
    args: (m, l) => ({ sourceUrn: nodeUrn(m, l), targetUrn: outsiderTargetUrn, name: 'links' }),
  },
  {
    name: 'hadron_move_node',
    tool: 'hadron_move_node',
    loc: PROBE,
    args: (m, l) => ({ urn: nodeUrn(m, l), targetUrn: `${outsiderTargetUrn}-moved` }),
  },
];

const ALL = [...MEMORY_REF, ...NODE_URN_DOORS, ...NODE_ORACLE];

describe('#1316 MCP: an unreadable memory answers exactly as a missing one', () => {
  it.each(ALL.map((p) => [p.name, p] as const))('%s', async (_n, p) => {
    const before = await sideEffects();
    const existing = await call('outsider', p.tool, p.args(victimSlug, p.loc ?? PROBE));
    const missing = await call('outsider', p.tool, p.args(absentSlug, p.loc ?? PROBE));
    expect(wire(existing)).toBe(wire(missing));
    // The #1319 regression leaked the victim's INTERNAL id in the refusal.
    expect(JSON.stringify(existing)).not.toContain(victimId);
    expect(await sideEffects()).toEqual(before);
  });
});

describe('#1316 MCP: an existing node and a missing loc in an unreadable memory answer alike', () => {
  it.each([...NODE_URN_DOORS, ...NODE_ORACLE].filter((p) => p.loc).map((p) => [p.name, p] as const))(
    '%s',
    async (_n, p) => {
      const before = await sideEffects();
      const existing = await call('outsider', p.tool, p.args(victimSlug, p.loc!));
      const missingLoc = await call('outsider', p.tool, p.args(victimSlug, ABSENT_LOC));
      expect(wire(existing)).toBe(wire(missingLoc));
      expect(await sideEffects()).toEqual(before);
    },
  );
});

describe('#1316 MCP controls', () => {
  // A reader already knows the memory exists (they can read it), so concealing
  // would only take away the actionable answer. Their refusal must stay a
  // refusal and must NOT be the missing branch's text.
  it.each(
    ALL.filter((p) => !['hadron_set_active_memory', 'hadron_validate'].includes(p.name)).map(
      (p) => [p.name, p] as const,
    ),
  )('%s: a reader who may read but not write keeps an actionable denial', async (_n, p) => {
    const before = await sideEffects();
    const denied = await call('reader', p.tool, p.args(victimSlug, p.loc ?? PROBE));
    const missing = await call('reader', p.tool, p.args(absentSlug, p.loc ?? PROBE));
    expect(wire(denied)).not.toBe(wire(missing));
    expect(await sideEffects()).toEqual(before);
  });

  it.each(['hadron_set_active_memory', 'hadron_validate'])('%s: a reader still reads', async (tool) => {
    const r = await call('reader', tool, { memoryUrn: memUrn(victimSlug) });
    expect(text(r)).not.toMatch(/not found|denied/i);
  });
});


describe('#1316 MCP: the other ends of an address', () => {
  // Checkpoint 2 recorded only the move's SOURCE; the destination leaked the
  // same way ("Write access denied for target memory" vs "Target memory not
  // found"), measured on unmodified main.
  it('hadron_move_node: an unreadable TARGET memory answers as a missing one', async () => {
    const before = await sideEffects();
    const into = (slug: string) =>
      call('outsider', 'hadron_move_node', { urn: outsiderTargetUrn, targetUrn: nodeUrn(slug, 'moved-in') });
    const existing = await into(victimSlug);
    const missing = await into(absentSlug);
    expect(text(missing)).toMatch(/^Target memory not found/);
    expect(wire(existing)).toBe(wire(missing));
    expect(await sideEffects()).toEqual(before);
  });

  // The PK form of the source: ids are not guessable the way URNs are, but an
  // id learned anywhere must not be confirmable by someone who cannot read it.
  it('hadron_create_edge: a source node id in an unreadable memory answers as a missing id', async () => {
    const before = await sideEffects();
    const victimNode = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: PROBE, memoryId: victimId } },
      select: { id: true },
    });
    const absentId = generateId();
    const byId = (id: string) => call('outsider', 'hadron_create_edge', { sourceUrn: id, targetUrn: outsiderTargetUrn });
    const existing = text(await byId(victimNode.id)).split(victimNode.id).join('<ID>');
    const missing = text(await byId(absentId)).split(absentId).join('<ID>');
    expect(missing).toMatch(/^Source node not found/);
    expect(existing).toBe(missing);
    expect(await sideEffects()).toEqual(before);
  });
});

/**
 * The GraphQL resolvers these tools delegate to. Fixing them at the resolver is
 * what closes the MCP tool, so the GraphQL wire — typed `extensions` included,
 * which the MCP text does not carry — is pinned here too.
 */
type GqlProbe = { name: string; query: string; vars: (slug: string, loc: string) => Record<string, unknown>; node: boolean };
const GQL_PROBES: GqlProbe[] = [
  { name: 'updateNodeData', node: true, query: `mutation($r: ID!) { updateNodeData(nodeRef: $r, data: {k: 2}) { id } }`, vars: (m, l) => ({ r: nodeUrn(m, l) }) },
  { name: 'updateNodeProperties', node: true, query: `mutation($r: ID!) { updateNodeProperties(nodeRef: $r, properties: {k: 2}) { id } }`, vars: (m, l) => ({ r: nodeUrn(m, l) }) },
  { name: 'updateObject', node: true, query: `mutation($r: ID!) { updateObject(ref: $r, fields: {k: 2}) }`, vars: (m, l) => ({ r: nodeUrn(m, l) }) },
  { name: 'deleteObject', node: true, query: `mutation($r: ID!) { deleteObject(ref: $r) }`, vars: (m, l) => ({ r: nodeUrn(m, l) }) },
  { name: 'deleteNode', node: true, query: `mutation($r: ID!) { deleteNode(nodeRef: $r) }`, vars: (m, l) => ({ r: nodeUrn(m, l) }) },
  {
    name: 'searchReplaceInNodes(nodeIds)',
    node: true,
    query: `mutation($r: ID!) { searchReplaceInNodes(input: {oldText: "needle", newText: "pin", fields: [content], nodeIds: [$r]}) { nodesScanned } }`,
    vars: (m, l) => ({ r: nodeUrn(m, l) }),
  },
  {
    name: 'searchReplaceInNodes(memoryIds)',
    node: false,
    query: `mutation($r: ID!) { searchReplaceInNodes(input: {oldText: "needle", newText: "pin", fields: [content], memoryIds: [$r]}) { nodesScanned } }`,
    vars: (m) => ({ r: memUrn(m) }),
  },
  {
    name: 'createChannel',
    node: false,
    query: `mutation($r: ID!) { createChannel(input: {memoryRef: $r, loc: "chats:oracle", name: "oracle"}) { id } }`,
    vars: (m) => ({ r: memUrn(m) }),
  },
];

describe('#1316 GraphQL: the delegated resolvers conceal too', () => {
  it.each(GQL_PROBES.map((p) => [p.name, p] as const))('%s: unreadable ≡ missing memory', async (_n, p) => {
    const before = await sideEffects();
    const existing = await gql('outsider', p.query, p.vars(victimSlug, PROBE));
    const missing = await gql('outsider', p.query, p.vars(absentSlug, PROBE));
    expect(gqlCode(missing)).toBe(p.node ? 'NODE_NOT_FOUND' : 'MEMORY_NOT_FOUND');
    expect(wire(existing)).toBe(wire(missing));
    expect(JSON.stringify(existing)).not.toContain(victimId);
    expect(await sideEffects()).toEqual(before);
  });

  it.each(GQL_PROBES.filter((p) => p.node).map((p) => [p.name, p] as const))(
    '%s: existing node ≡ missing loc in an unreadable memory',
    async (_n, p) => {
      const existing = await gql('outsider', p.query, p.vars(victimSlug, PROBE));
      const missingLoc = await gql('outsider', p.query, p.vars(victimSlug, ABSENT_LOC));
      expect(wire(existing)).toBe(wire(missingLoc));
    },
  );

  it.each(GQL_PROBES.map((p) => [p.name, p] as const))('%s: a reader keeps FORBIDDEN', async (_n, p) => {
    const before = await sideEffects();
    const result = await gql('reader', p.query, p.vars(victimSlug, PROBE));
    expect(gqlCode(result)).toBe('FORBIDDEN');
    expect(await sideEffects()).toEqual(before);
  });

  const UPDATE_DATA = GQL_PROBES[0]!;

  it('a DB fault while classifying a denial propagates as a fault, never as not-found', async () => {
    // `app.findMany` is reached only by the node-content classifier for this
    // principal (the App-derived fold), never by the write authorization —
    // measured, not assumed. The spy must fire, or this proves nothing.
    const fault = vi.spyOn(db.app, 'findMany').mockRejectedValueOnce(new Error('injected classification db failure'));
    try {
      const before = await sideEffects();
      const result = await gql('outsider', UPDATE_DATA.query, UPDATE_DATA.vars(victimSlug, PROBE));
      expect(fault).toHaveBeenCalled();
      expect(gqlCode(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
      expect(await sideEffects()).toEqual(before);
    } finally {
      fault.mockRestore();
    }
  });

  it('a fault inside the authorization itself propagates, never as not-found', async () => {
    const fault = vi
      .spyOn(db.memory, 'findUniqueOrThrow')
      .mockRejectedValueOnce(new Error('injected authorization db failure'));
    try {
      const result = await gql('outsider', UPDATE_DATA.query, UPDATE_DATA.vars(victimSlug, PROBE));
      expect(fault).toHaveBeenCalled();
      expect(gqlCode(result)).toBe('INTERNAL_SERVER_ERROR');
      // #1789: a fault is the generic envelope (detail goes to the log), and never NOT_FOUND/FORBIDDEN (Pin 1).
      expect(result.errors![0]!.message).toBe('Internal server error.');
      expect(result.errors![0]!.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
    } finally {
      fault.mockRestore();
    }
  });
});

// Last: these succeed, so they move the side-effect baseline.
describe('#1316 permitted callers are never narrowed', () => {
  it('a writer still writes through MCP and GraphQL', async () => {
    const created = await call('writer', 'hadron_create_node', { urn: nodeUrn(victimSlug, 'writer-made'), name: 'w' });
    expect(text(created)).not.toMatch(/not found|denied/i);
    const merged = await call('writer', 'hadron_update_node_data', { nodeUrn: nodeUrn(victimSlug, PROBE), data: { k: 3 } });
    expect(text(merged)).not.toMatch(/not found|denied|forbidden/i);
    const viaGql = await gql('writer', GQL_PROBES[0]!.query, GQL_PROBES[0]!.vars(victimSlug, PROBE));
    expect(viaGql.errors).toBeUndefined();
  });
});
