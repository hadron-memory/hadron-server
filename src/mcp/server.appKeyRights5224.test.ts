/**
 * #5224 (Holger, 2026-11-25; hrn:node:hadronmemory.com:specs:cor:acl:010:04 and
 * hrn:node:hadronmemory.com:specs:cor:dmo:060:20): outside a session an App key carries its App owner's rights, so it
 * reads no member's personal or private memory, and it never shares one. Inside a session for a subscribed person the
 * ruling 0203 read stays as #4726 built it ("Subscription = consent").
 *
 * One matrix, two surfaces: every door is called over real HTTP with the raw App key, on GraphQL and on MCP, in an
 * organization's App and in a user-owned App. Two things keep a row from passing by accident: the memory's owner, with
 * their own credential, must get the marker through the SAME call, and a by-reference door must answer for a real
 * memory exactly as it answers for one that does not exist.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentSubscription } from '../test/helpers.js';
import { REGEX_SEARCH_CLASS } from '../lib/rateLimit/index.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, USER_API_KEY_PREFIX, hashAppKey, hashUserApiKey } from '../middleware/auth.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../test/startServerFixture.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { QUESTION_LOG_ROLE } from '../lib/questions/index.js';
import { QUESTION_LOG_CODEC } from '../lib/questions/codec.js';
import { buildSchema, getNamedType } from 'graphql';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// assetDownloadUrl: no object store here, so the owner's download URL is minted by this stand-in.
vi.mock('../integrations/objectstore/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/objectstore/index.js')>()),
  mintGetUrl: vi.fn(async () => 'https://store.invalid/get'),
}));

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(server); });

// ─── The wire ────────────────────────────────────────────────────────────

/**
 * `hadronSession` is the worker session the key acts in (the `x-hadron-session` header); `mcpSessionId` is the MCP
 * transport's own session id, set on the first MCP call. They are unrelated.
 */
interface Caller { bearer: string; hadronSession?: string; mcpSessionId?: string }

const headersOf = (c: Caller) => ({
  'content-type': 'application/json', authorization: `Bearer ${c.bearer}`,
  ...(c.hadronSession ? { 'x-hadron-session': c.hadronSession } : {}),
});

async function gql(c: Caller, query: string, variables: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/graphql`, { method: 'POST', headers: headersOf(c), body: JSON.stringify({ query, variables }) });
  return res.text();
}

let rpc = 1;
/**
 * One JSON-RPC call. Every HTTP answer must be 200 (202 for a notification), and the body is the message carrying this
 * call's id, wherever it sits among the stream's `data:` lines.
 */
async function mcpPost(c: Caller, method: string, params: unknown) {
  const notification = method.startsWith('notifications/');
  const id = notification ? undefined : rpc++;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { ...headersOf(c), accept: 'application/json, text/event-stream', ...(c.mcpSessionId ? { 'mcp-session-id': c.mcpSessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
  });
  const raw = await res.text();
  expect(res.status, `${method}: ${raw}`).toBe(notification ? 202 : 200);
  if (notification) return { res, body: {} as Record<string, any> };
  const lines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5));
  const messages = (lines.length > 0 ? lines : [raw]).map((l) => JSON.parse(l) as Record<string, any>);
  const body = messages.find((x) => x.id === id);
  expect(body, `${method}: no answer with id ${id} in ${raw}`).toBeDefined();
  return { res, body: body! };
}
async function mcp(c: Caller, name: string, args: Record<string, unknown>): Promise<string> {
  if (!c.mcpSessionId) {
    const { res } = await mcpPost(c, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p5224', version: '1' } });
    c.mcpSessionId = res.headers.get('mcp-session-id')!;
    await mcpPost(c, 'notifications/initialized', {});
  }
  const { body } = await mcpPost(c, 'tools/call', { name, arguments: args });
  return JSON.stringify(body.result ?? body.error ?? null);
}

// ─── The world ───────────────────────────────────────────────────────────

interface Target {
  shape: string; id: string; urn: string; nodeId: string; childId: string; edgeId: string;
  assetId: string; revId: string; objectId: string; goneId: string; commentId: string; commentBody: string; mark: string;
}
interface World {
  appId: string; agentId: string; mia: string; leo: string; root: string; tenant: Record<string, string>;
  key: Caller; miaKey: Caller; space: { id: string; urn: string; nodeId: string; mark: string };
}

async function userKey(userId: string): Promise<Caller> {
  const bearer = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { id: generateId(), userId, keyHash: hashUserApiKey(bearer), keyPreview: bearer.slice(-4), label: 'p', oauthScopes: [] } });
  return { bearer };
}

async function makeWorld(kind: 'organization' | 'user'): Promise<World> {
  await cleanDb(db);
  const s = generateId().toLowerCase().slice(-8);
  const person = async (n: number, h: string) =>
    (await db.user.create({ data: { id: generateId(), githubId: 5_224_000 + n, githubUsername: `${h}${s}`, handle: `${h}-${s}` } })).id;
  const mia = await person(1, 'mia');
  const leo = await person(2, 'leo');
  const otto = await person(3, 'otto');
  const org = await db.organization.create({ data: { id: generateId(), name: 'p5224', urn: `p5224-${s}.test` } });
  const tenant: Record<string, string> = kind === 'organization' ? { organizationId: org.id } : { ownerUserId: otto };
  const root = kind === 'organization' ? org.urn : `otto-${s}`;
  const agentId = (await db.agent.create({ data: { id: generateId(), ...tenant, name: 'A', urn: `${root}:a` } as never })).id;
  const appId = (await db.app.create({ data: { id: generateId(), ...tenant, name: 'X', urn: `${root}:x` } as never })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId: mia, role: 'owner' } });
  await createDbAgentSubscription(db, mia, agentId);
  const bearer = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(bearer), keyPreview: bearer.slice(-4), label: 'k' } });
  // PUBLIC knowledge of an organization: what the key DOES read outside a session, whoever owns its App, and the source
  // of the cross-memory edges and includes below.
  const mark = `space${generateId().toLowerCase().slice(-10)}`;
  const space = await db.memory.create({ data: { id: generateId(), class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id, name: `${mark}M`, urn: `${org.urn}:sp${s}` } });
  const node = await db.node.create({ data: { id: generateId(), memoryId: space.id, loc: 'diary', name: `${mark}N`, content: `${mark}C` } });
  return { appId, agentId, mia, leo, root, tenant, key: { bearer }, miaKey: await userKey(mia), space: { id: space.id, urn: space.urn, nodeId: node.id, mark } };
}

/**
 * The marks: each seeded value is `<mark><letter>`, so an answer that carries one names the field it came from.
 */
const MARKS = {
  M: 'memory name', N: 'node name', C: 'node content', A: 'node abstract', K: 'child node name', L: 'child node content',
  E: 'edge name', R: 'revision name and content', F: 'asset filename', B: 'comment body', T: 'node tag',
  O: 'object title', D: 'soft-deleted node name and content', U: 'usage event type', G: 'removed edge name',
  Q: 'question log name',
} as const;
const MARK_LETTERS = Object.keys(MARKS);
/** The marks a write door could echo: every mark of a live value. */
const LIVE_MARKS = MARK_LETTERS.filter((l) => !'DUG'.includes(l));

const SHAPES = ['in the App, the App owner\'s tenancy', 'in the App, the person\'s own tenancy', 'free-standing', 'free-standing, named by an agent memory item', 'in the App, named by an agent memory item', 'the App owner\'s tenancy, no Agent, named by an agent memory item'] as const;

/** One of Mia's memories, with a distinguishable value in every field a read surface can return. */
async function seed(w: World, cls: 'personal' | 'private', shape: (typeof SHAPES)[number]): Promise<Target> {
  const mark = `mia${generateId().toLowerCase().slice(-10)}`;
  const inApp = shape.startsWith('in the App');
  const ownTenancy = shape !== SHAPES[0] && shape !== SHAPES[4] && shape !== SHAPES[5];
  const memory = await db.memory.create({
    data: {
      id: generateId(), class: cls, visibility: null, userId: w.mia, createdBy: w.mia, name: `${mark}M`,
      urn: `${ownTenancy ? `mia-${w.mia.slice(-6)}` : w.root}:m${generateId().toLowerCase().slice(-8)}`,
      ...(ownTenancy ? { ownerUserId: w.mia } : w.tenant),
      ...(inApp ? { appId: w.appId, userMemoryOfAgentId: w.agentId } : {}),
    } as never,
  });
  if (shape.endsWith('named by an agent memory item')) await db.agentMemoryItem.create({ data: { agentId: w.agentId, memoryId: memory.id, role: 'read-write' } });
  const node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'diary', name: `${mark}N`, content: `${mark}C`, abstract: `${mark}A`, tags: [`${mark}T`] } });
  // The child cites a node that is no longer live, so the memory has an unresolved reference to report.
  const child = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'diary:one', name: `${mark}K`, content: `${mark}L, see hrn:node:${memory.urn}:gone`, seq: 1 } });
  const edge = await db.edge.create({ data: { id: generateId(), memoryId: memory.id, sourceId: node.id, targetId: child.id, loc: `diary:e:${node.id}`, name: `${mark}E` } });
  const rev = await db.nodeRevision.create({ data: { id: generateId(), nodeId: node.id, memoryId: memory.id, revNo: 1, loc: 'diary', name: `${mark}R`, content: `${mark}R` } as never });
  const assetId = generateId();
  await db.asset.create({ data: { id: assetId, memoryId: memory.id, filename: `${mark}F.txt`, mimeType: 'text/plain', sizeBytes: 3, storageKey: `k/${assetId}`, scanStatus: 'CLEAN' } });
  // From the PUBLIC memory into hers: an edge to follow and an include to expand.
  await db.edge.create({ data: { id: generateId(), memoryId: w.space.id, sourceId: w.space.nodeId, targetId: node.id, loc: `diary:x:${node.id}`, name: 'x' } });
  await db.node.create({ data: { id: generateId(), memoryId: w.space.id, loc: `inc:${memory.id}`, name: 'inc', content: `{{> hrn:node:${memory.urn}:diary}}` } });
  const object = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'goal:one', name: 'goal', objectType: 'goal', properties: { title: `${mark}O` } } });
  const gone = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'gone', name: `${mark}D`, content: `${mark}D`, deletedAt: new Date() } });
  const logData = {
    codec: QUESTION_LOG_CODEC, kind: 'question.log', prefix: 'Q', lastCode: 0, defaultDeciders: [w.mia], eligibleDeciders: [], purges: [],
    lastAction: { op: 'create', by: { userId: w.mia, workerId: null, appId: null }, at: new Date().toISOString(), reason: null },
  };
  await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'questions', name: `${mark}Q`, role: QUESTION_LOG_ROLE, data: logData } });
  await db.usageEvent.create({ data: { type: `${mark}U`, nodeLoc: 'diary', nodeId: node.id, memoryId: memory.id } });
  await db.usageEvent.create({ data: { type: 'read', nodeLoc: 'diary', nodeId: node.id, memoryId: memory.id } });
  await db.nodeEdgeRemoval.create({ data: { sourceId: node.id, memoryId: memory.id, edgeId: generateId(), edgeLoc: 'diary:r', edgeName: `${mark}G`, targetId: generateId(), targetMemoryId: memory.id, targetLoc: 'r', reason: 'TARGET_HARD_DELETED' } });
  let commentId = generateId();
  const commentBody = `${mark}B`;
  // A private memory takes no comments.
  if (cls === 'personal') {
    const out = await gql(w.miaKey, 'mutation($t: ID!, $b: String!) { createComment(targetRef: $t, body: $b) { id } }', { t: node.id, b: commentBody });
    expect(out).toContain('"createComment":{"id"');
    commentId = (JSON.parse(out) as { data: { createComment: { id: string } } }).data.createComment.id;
  }
  return { shape, id: memory.id, urn: memory.urn, nodeId: node.id, childId: child.id, edgeId: edge.id, assetId, revId: rev.id, objectId: object.id, goneId: gone.id, commentId, commentBody, mark };
}

/** A target that does not exist, for the same-answer comparison. */
const ghostOf = (t: Target): Target => ({
  ...t, id: generateId(), urn: `${t.urn.split(':')[0]}:g${generateId().toLowerCase().slice(-8)}`, nodeId: generateId(),
  childId: generateId(), edgeId: generateId(), assetId: generateId(), revId: generateId(),
  objectId: generateId(), goneId: generateId(), commentId: generateId(),
});
const normalise = (text: string, t: Target) =>
  [t.id, t.urn, t.nodeId, t.childId, t.edgeId, t.assetId, t.revId, t.objectId, t.goneId, t.commentId].reduce((acc, v) => acc.split(v).join('<ref>'), text);

// ─── The doors ───────────────────────────────────────────────────────────

interface Door {
  name: string;
  run: (c: Caller, t: Target, w: World) => Promise<string>;
  /** The door names the target, so its answer must equal the answer for a target that does not exist. */
  byRef: boolean;
  /**
   * How the owner's answer shows she reached her memory, for a door whose answer carries no mark and no id she did not
   * send. Without it, the owner must get a mark or such an id.
   */
  reach?: (out: string, t: Target) => boolean;
  /** The one place the door may repeat the query it was sent; everything else it returns is judged. */
  echo?: (t: Target) => string;
}
type Vars = (t: Target, w: World) => Record<string, unknown>;
interface DoorOpts { byRef?: boolean; reach?: Door['reach']; echo?: Door['echo'] }
const opts = (o: boolean | DoorOpts | undefined): DoorOpts => (typeof o === 'boolean' ? { byRef: o } : o ?? {});
const g = (name: string, query: string, vars: Vars, o?: boolean | DoorOpts): Door =>
  ({ name: `GraphQL ${name}`, ...opts(o), byRef: opts(o).byRef ?? true, run: (c, t, w) => gql(c, query, vars(t, w)) });
const m = (name: string, tool: string, args: Vars, o?: boolean | DoorOpts): Door =>
  ({ name: `MCP ${name}`, ...opts(o), byRef: opts(o).byRef ?? true, run: (c, t, w) => mcp(c, tool, args(t, w)) });

const mem = (t: Target) => `hrn:mem:${t.urn}`;
const node = (t: Target, loc = 'diary') => `hrn:node:${t.urn}:${loc}`;
const FIND = 'query($q: String, $m: FindNodesMode, $f: NodeFilter) { findNodes(query: $q, mode: $m, filter: $f) { total hits { node { id name content } } } }';

const READ_DOORS: Door[] = [
  // by reference, id and URN
  g('memory(id)', 'query($r: ID!) { memory(ref: $r) { id name } }', (t) => ({ r: t.id })),
  g('memory(URN)', 'query($r: ID!) { memory(ref: $r) { id name } }', (t) => ({ r: mem(t) })),
  g('resolveUrn(memory)', 'query($r: String!) { resolveUrn(urn: $r) { id kind } }', (t) => ({ r: mem(t) })),
  g('resolveUrn(node)', 'query($r: String!) { resolveUrn(urn: $r) { id kind } }', (t) => ({ r: node(t) })),
  g('node(id)', 'query($r: ID!) { node(ref: $r) { id name content abstract } }', (t) => ({ r: t.nodeId })),
  g('node(URN)', 'query($r: ID!) { node(ref: $r) { id name content memory { name } } }', (t) => ({ r: node(t) })),
  g('nodeBatch(refs)', 'query($r: [ID!]) { nodeBatch(refs: $r) { nodes { id name content } } }', (t) => ({ r: [t.nodeId, node(t, 'diary:one')] })),
  g('nodeBatch(memory)', 'query($r: ID!) { nodeBatch(memory: $r, locPrefix: "diary") { nodes { id name content } } }', (t) => ({ r: t.id })),
  g('nodeExport', 'query($r: ID!) { nodeExport(ref: $r, format: MD) { data filename } }', (t) => ({ r: node(t) })),
  g('nextNode', 'query($r: ID!) { nextNode(parentRef: $r) { id name content } }', (t) => ({ r: node(t) })),
  g('renderRunNode', 'query($r: String!) { renderRunNode(nodeRef: $r) }', (t) => ({ r: node(t) })),
  g('specDocument', 'query($r: ID!) { specDocument(memoryRef: $r, loc: "diary") { markdown } }', (t) => ({ r: t.id })),
  g('nodeRevisions', 'query($r: ID!) { nodeRevisions(nodeRef: $r) { id name content } }', (t) => ({ r: t.nodeId })),
  g('nodeRevisionsPage', 'query($r: ID!) { nodeRevisionsPage(nodeRef: $r) { items { id name content } } }', (t) => ({ r: node(t) })),
  g('nodeRevision', 'query($r: String!) { nodeRevision(nodeRevRef: $r) { id name content } }', (t) => ({ r: t.revId })),
  g('edge', 'query($r: ID!) { edge(ref: $r) { id name source { name } target { name } } }', (t) => ({ r: t.edgeId })),
  g('commentThreads', 'query($r: ID!) { commentThreads(targetRef: $r) { items { root { body } } } }', (t) => ({ r: t.nodeId })),
  g('memoryAssets', 'query($r: ID!) { memoryAssets(memoryRef: $r) { assets { id filename } } }', (t) => ({ r: t.id })),
  g('memoryNodes', 'query($r: ID!) { memoryNodes(memoryRef: $r) { total nodes { id name } } }', (t) => ({ r: t.id })),
  g('memoryEdges', 'query($r: ID!) { memoryEdges(memoryRef: $r) { total edges { id name } } }', (t) => ({ r: mem(t) })),
  g('comment', 'query($r: ID!) { comment(ref: $r) { id body } }', (t) => ({ r: t.commentId })),
  g('object(id)', 'query($r: ID!) { object(ref: $r) }', (t) => ({ r: t.objectId })),
  g('object(URN)', 'query($r: ID!) { object(ref: $r) }', (t) => ({ r: node(t, 'goal:one') })),
  g('findObjects', 'query($r: String!) { findObjects(memoryRef: $r, type: "goal") { total objects } }', (t) => ({ r: t.id })),
  g('recoveryNode', 'query($r: ID!) { recoveryNode(nodeRef: $r) { id name content } }', (t) => ({ r: t.goneId })),
  g('recoveryNodes', 'query($r: ID!) { recoveryNodes(memoryRef: $r) { total items { id name } } }', (t) => ({ r: t.id })),
  g('recoveryEdges', 'query($r: ID!) { recoveryEdges(memoryRef: $r) { total items { id name } } }', (t) => ({ r: t.id })),
  // #5237: what the memory holds besides nodes, and what the platform says about it
  g('memoryLocSegments', 'query($r: [ID!]!) { memoryLocSegments(memoryRefs: $r, parentLoc: "diary") { items { segment memoryId } } }', (t) => ({ r: [mem(t)] })),
  g('memoryConfig', 'query($r: ID!) { memoryConfig(memoryRef: $r) { memoryId rules { role } } }', (t) => ({ r: mem(t) })),
  g('memoryUsageSummary', 'query($r: ID!) { memoryUsageSummary(memoryRef: $r) { nodeLoc type count } }', (t) => ({ r: t.id })),
  g('usageEvents(memoryRef)', 'query($r: ID!) { usageEvents(memoryRef: $r) { id type memoryId } }', (t) => ({ r: mem(t) })),
  g('usageEventsPage', 'query($r: ID!) { usageEventsPage(memoryRef: $r) { total items { id type memoryId } } }', (t) => ({ r: mem(t) })),
  g('usageActivity', 'query($r: [ID!]) { usageActivity(memoryRefs: $r) { date reads writes } }', (t) => ({ r: [t.id] }),
    { reach: (out) => /"reads":[1-9]/.test(out) }),
  g('validateMemory', 'query($r: ID!) { validateMemory(memoryRef: $r) { memoryId nodesChecked ok } }', (t) => ({ r: mem(t) })),
  g('verifyMemoryNodes', 'query($r: String!) { verifyMemoryNodes(memoryRef: $r) { checked problems { nodeId urn state } } }', (t) => ({ r: mem(t) })),
  g('verifyNode', 'query($r: ID!) { verifyNode(nodeRef: $r) { nodeId urn state } }', (t) => ({ r: node(t) })),
  g('nodeAuthoringCheck', 'query($r: String) { nodeAuthoringCheck(input: { ref: $r }) { state code } }', (t) => ({ r: node(t) }),
    { reach: (out) => out.includes('"nodeAuthoringCheck":{"state"') }),
  g('nodeEdgeRemovals', 'query($r: ID!) { nodeEdgeRemovals(nodeRef: $r) { id edgeName targetId } }', (t) => ({ r: node(t) })),
  g('specBacklinks', 'query($r: ID!) { specBacklinks(memoryRef: $r, loc: "diary:one") { kind sourceNodeId sourceLoc } }', (t) => ({ r: t.id })),
  g('specBacklinksPage', 'query($r: ID!) { specBacklinksPage(memoryRef: $r, loc: "diary:one") { total items { sourceNodeId } } }', (t) => ({ r: t.id })),
  g('specUnresolvedReferences', 'query($r: ID!) { specUnresolvedReferences(memoryRef: $r) { sourceNodeId targetLoc reason } }', (t) => ({ r: t.id })),
  g('specUnresolvedReferencesPage', 'query($r: ID!) { specUnresolvedReferencesPage(memoryRef: $r) { total items { sourceNodeId } } }', (t) => ({ r: t.id })),
  // The node has no compiled prompt, so the owner's answer is an empty one, where the key's is a refusal.
  g('compiledPromptProvenance', 'query($r: ID!) { compiledPromptProvenance(nodeRef: $r, revNo: 1) { total } }', (t) => ({ r: node(t) }),
    { reach: (out) => out.trim() === '{"data":{"compiledPromptProvenance":null}}' }),
  g('assetDownloadUrl', 'query($r: ID!) { assetDownloadUrl(assetId: $r) { url filename } }', (t) => ({ r: t.assetId })),
  // #5404: `automationReadGrants` left this table: the door is retired and refuses DOOR_RETIRED for the owner too, so it has no
  // owner reach to compare against (the key's refusal is pinned with the other retired doors in WIDEN_DOORS).
  g('questionLogs', 'query($r: ID) { questionLogs(memoryRef: $r) { id name } }', (t) => ({ r: t.id })),
  // lists
  g('memories', '{ memories(limit: 200) { total items { id name } } }', () => ({}), false),
  g('appNodes', 'query($a: ID!) { appNodes(appRef: $a, limit: 200) { id name content } }', (_t, w) => ({ a: w.appId }), false),
  g('appNodesPage', 'query($a: ID!) { appNodesPage(appRef: $a, limit: 200) { total items { id name content } } }', (_t, w) => ({ a: w.appId }), false),
  g('appMemoryScope', 'query($a: ID!) { appMemoryScope(appRef: $a) { total items { memoryId name } } }', (_t, w) => ({ a: w.appId }), false),
  g('assets', '{ assets(limit: 200) { items { id filename } } }', () => ({}), false),
  // traversals out of the PUBLIC memory, which the key reads
  g('edge target from PUBLIC knowledge', 'query($r: ID!) { node(ref: $r) { content outgoingEdges { target { name content } } } }', (_t, w) => ({ r: w.space.nodeId }), false),
  g('include from PUBLIC knowledge', 'query($r: ID!) { node(ref: $r) { content } }', (t, w) => ({ r: `hrn:node:${w.space.urn}:inc:${t.id}` }), false),
  // search and filters
  g('edges(filter memory)', 'query($f: EdgeFilter) { edges(filter: $f) { total items { id name } } }', (t) => ({ f: { memoryRef: t.id } })),
  g('edges(filter node)', 'query($f: EdgeFilter) { edges(filter: $f) { total items { id name } } }', (t) => ({ f: { sourceRef: t.nodeId } })),
  g('assets(filter memory)', 'query($f: AssetFilter) { assets(filter: $f) { items { id filename } } }', (t) => ({ f: { memoryRefs: [t.id] } })),
  g('findNodes keyword', FIND, (t) => ({ q: `${t.mark}C`, m: 'keyword' }), false),
  g('findNodes regex', FIND, (t) => ({ q: `^${t.mark}C$`, m: 'regex' }), false),
  g('findNodes filter memoryRefs', FIND, (t) => ({ f: { memoryRefs: [t.id] } })),
  g('findNodes filter memoryClasses', FIND, () => ({ f: { memoryClasses: ['personal', 'private'] } }), false),
  g('findNodes filter tags', FIND, (t) => ({ f: { tags: [`${t.mark}T`] } }), false),
  g('findNodes filter childrenOf', FIND, (t) => ({ f: { memoryRefs: [t.id], childrenOf: 'diary' } })),
  g('findNodes filter locPrefix', FIND, (t) => ({ f: { memoryRefs: [t.id], locPrefix: 'diary' } })),
  g('memories filter memoryClasses', '{ memories(filter: { memoryClasses: [personal, private] }, limit: 200) { total items { id name } } }', () => ({}), false),
  g('globalSearch', 'query($q: String!) { globalSearch(query: $q) { total hits { id name } } }', (t) => ({ q: `${t.mark}N` }), false),
  // MCP
  m('get_node(URN)', 'hadron_get_node', (t) => ({ urn: node(t) })),
  m('get_nodes', 'hadron_get_nodes', (t) => ({ refs: [node(t), t.childId] })),
  m('get_next_node', 'hadron_get_next_node', (t) => ({ parent: node(t) })),
  m('list_nodes', 'hadron_list_nodes', (t) => ({ memoryUrn: mem(t) })),
  m('validate', 'hadron_validate', (t) => ({ memoryUrn: mem(t) }), { reach: (out) => / in \d+ nodes/.test(out) }),
  m('list_comments', 'hadron_list_comments', (t) => ({ targetRef: node(t) })),
  m('get_comment', 'hadron_get_comment', (t) => ({ commentRef: t.commentId })),
  m('get_object(id)', 'hadron_get_object', (t) => ({ ref: t.objectId })),
  m('get_object(URN)', 'hadron_get_object', (t) => ({ ref: node(t, 'goal:one') })),
  m('find_objects', 'hadron_find_objects', (t) => ({ memoryUrn: mem(t), type: 'goal' })),
  m('find_objects match', 'hadron_find_objects', (t) => ({ memoryUrn: t.id, type: 'goal', match: { title: `${t.mark}O` } })),
  m('get_recovery_node', 'hadron_get_recovery_node', (t) => ({ nodeRef: t.goneId })),
  m('list_recovery_nodes', 'hadron_list_recovery_nodes', (t) => ({ memoryRef: t.id })),
  m('list_recovery_edges', 'hadron_list_recovery_edges', (t) => ({ memoryRef: mem(t) })),
  m('run_task by URN', 'hadron_run_task', (t) => ({ urn: node(t) })),
  m('run_action', 'hadron_run_action', (t) => ({ urn: node(t) })),
  m('find_nodes in the memory', 'hadron_find_nodes', (t) => ({ query: 'diary', memoryUrn: mem(t) })),
  m('list_memories', 'hadron_list_memories', () => ({}), false),
  m('find_nodes keyword', 'hadron_find_nodes', (t) => ({ query: `${t.mark}C`, mode: 'keyword', memoryUrns: [mem(t)] })),
  m('find_nodes regex', 'hadron_find_nodes', (t) => ({ query: `^${t.mark}C$`, mode: 'regex', memoryUrns: [mem(t)] })),
  m('search', 'hadron_search', (t) => ({ query: `${t.mark}N`, scope: 'global' }), { byRef: false, echo: (t) => `No results for \\"${t.mark}N\\".` }),
  m('include from PUBLIC knowledge', 'hadron_get_node', (t, w) => ({ urn: `hrn:node:${w.space.urn}:inc:${t.id}` }), false),
];

/**
 * What an answer discloses about the target: any marked value, or the URN or id of a thing the call did not name. A
 * mark counts even when the call sent it (a search door sends the content it looks for), so an answer may not echo the
 * query; only an id or URN the call itself sent may come back.
 */
const leaks = (out: string, sent: string, t: Target) => [
  ...MARK_LETTERS.map((c) => `${t.mark}${c}`).filter((v) => out.includes(v)),
  ...[t.id, t.urn, t.nodeId, t.childId, t.edgeId, t.assetId, t.revId, t.objectId, t.goneId, t.commentId].filter((v) => out.includes(v) && !sent.includes(v)),
];
/** Run a door and keep what it sent, so an echoed id or URN is not read as a disclosure. */
async function probe(d: Door, c: Caller, t: Target, w: World) {
  const real = globalThis.fetch;
  let sent = '';
  // #5486: this matrix probes disclosure, not the regex throttle (10 a minute per caller), which one caller's many probes would trip.
  await db.rateLimitBucket.deleteMany({ where: { fieldClass: REGEX_SEARCH_CLASS } });
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((u, i) => { sent += String(i?.body ?? ''); return real(u, i); });
  try {
    const out = await d.run(c, t, w);
    return { out: d.echo ? out.split(d.echo(t)).join('<the query>') : out, sent };
  } finally { spy.mockRestore(); }
}

describe.each(['organization', 'user'] as const)('#5224 item 1: outside a session, an App key of a %s-owned App', (kind) => {
  let w: World;
  let targets: Target[];
  beforeAll(async () => {
    w = await makeWorld(kind);
    targets = [];
    for (const cls of ['personal', 'private'] as const) for (const shape of SHAPES) targets.push(await seed(w, cls, shape));
  }, 120_000);

  it('reads PUBLIC knowledge on both surfaces (the key works)', async () => {
    const urn = `hrn:node:${w.space.urn}:diary`;
    expect(await gql(w.key, 'query($r: ID!) { node(ref: $r) { content } }', { r: urn })).toContain(`${w.space.mark}C`);
    expect(await mcp(w.key, 'hadron_get_node', { urn })).toContain(`${w.space.mark}C`);
  });

  it.each(READ_DOORS.map((d) => [d.name, d] as const))('%s', async (_name, d) => {
    let ownerReached = 0;
    for (const t of targets) {
      const key = await probe(d, w.key, t, w);
      // A list or a traversal could carry any of them, so every target is judged on every answer.
      for (const other of targets) expect({ shape: other.shape, leaked: leaks(key.out, key.sent, other) }).toEqual({ shape: other.shape, leaked: [] });
      if (d.byRef) {
        const ghost = ghostOf(t);
        expect(normalise(key.out, t)).toBe(normalise((await probe(d, w.key, ghost, w)).out, ghost));
      }
      const owner = await probe(d, w.miaKey, t, w);
      if (d.reach ? d.reach(owner.out, t) && !d.reach(key.out, t) : leaks(owner.out, owner.sent, t).length > 0) ownerReached += 1;
    }
    expect(ownerReached, 'the owner reaches her memory through the same call').toBeGreaterThan(0);
  }, 120_000);
});

// ─── Item 2: the share doors ─────────────────────────────────────────────

const SHARE_DOORS: Array<[string, string, (t: Target, w: World) => Record<string, unknown>]> = [
  ['createMemoryShare', 'mutation($m: ID!, $u: ID!) { createMemoryShare(memoryRef: $m, granteeRef: $u, role: writer) { memoryShare { role } } }', (t, w) => ({ m: t.id, u: w.leo })],
  ['updateMemoryShareRole', 'mutation($m: ID!, $u: ID!) { updateMemoryShareRole(memoryRef: $m, granteeRef: $u, role: writer) { memoryShare { role } } }', (t, w) => ({ m: t.id, u: w.leo })],
  ['deleteMemoryShare', 'mutation($m: ID!, $u: String) { deleteMemoryShare(memoryRef: $m, granteeRef: $u) { memoryId } }', (t, w) => ({ m: t.id, u: w.leo })],
];

/** Memory members exist on group memories only, so on these two classes the doors have nothing to act on. */
const MEMBER_DOORS: typeof SHARE_DOORS = [
  ['addMemoryMember', 'mutation($m: ID!, $u: ID!) { addMemoryMember(memoryRef: $m, userRef: $u, role: writer) { memoryMember { role } } }', (t, w) => ({ m: t.id, u: w.leo })],
  ['updateMemoryMemberRole', 'mutation($m: ID!, $u: ID!) { updateMemoryMemberRole(memoryRef: $m, userRef: $u, role: writer) { memoryMember { role } } }', (t, w) => ({ m: t.id, u: w.leo })],
  ['removeMemoryMember', 'mutation($m: ID!, $u: ID!) { removeMemoryMember(memoryRef: $m, userRef: $u) { memoryId } }', (t, w) => ({ m: t.id, u: w.leo })],
];

/**
 * Doors that would widen a memory's audience some other way, each with the refusal it gives the key. cloneNode's
 * differs in a session: there the key reads the source (ruling 0203), so the refusal is the write to the target.
 */
type Refusal = string | { outside: string; inside: string };
const WIDEN_DOORS: Array<[string, Refusal, (c: Caller, t: Target, w: World) => Promise<string>]> = [
  ['GraphQL addMemoryToAgent', 'AGENT_NOT_FOUND', (c, t, w) => gql(c, 'mutation($a: ID!, $m: ID!) { addMemoryToAgent(agentRef: $a, memoryRef: $m, role: "read") { id } }', { a: w.agentId, m: t.id })],
  ['GraphQL attachMemoryToApp', 'UNAUTHENTICATED', (c, t, w) => gql(c, 'mutation($m: ID!, $p: ID!, $a: ID!) { attachMemoryToApp(memoryRef: $m, appRef: $p, agentRef: $a) { id } }', { m: t.id, p: w.appId, a: w.agentId })],
  ['GraphQL updateMemory(visibility)', 'MEMORY_NOT_FOUND', (c, t) => gql(c, 'mutation($m: ID!) { updateMemory(ref: $m, visibility: PUBLIC) { id } }', { m: t.id })],
  ['GraphQL transferMemoryOwnership', 'MEMORY_NOT_FOUND', (c, t, w) => gql(c, 'mutation($m: ID!, $u: ID!) { transferMemoryOwnership(memoryRef: $m, userRef: $u) { __typename } }', { m: t.id, u: w.leo })],
  ['GraphQL cloneMemory', 'MEMORY_NOT_FOUND', (c, t, w) => gql(c, 'mutation($m: ID!, $u: String!) { cloneMemory(ref: $m, targetUrn: $u) { id } }', { m: t.id, u: `hrn:mem:${w.root}:stolen` })],
  ['GraphQL cloneNode', { outside: 'NODE_NOT_FOUND', inside: 'FORBIDDEN' }, (c, t, w) => gql(c, 'mutation($m: ID!, $u: String) { cloneNode(sourceRef: $m, targetUrn: $u) { id } }', { m: t.nodeId, u: `hrn:node:${w.space.urn}:stolen` })],
  // #5404: the three grant doors below are retired; they refuse DOOR_RETIRED (FORBIDDEN before) and still write nothing.
  ['GraphQL setAppMemoryWriteGrant', 'DOOR_RETIRED', (c, t, w) => gql(c, 'mutation($m: String!, $p: String!) { setAppMemoryWriteGrant(appRef: $p, memoryRef: $m, prefix: "diary") { id } }', { m: t.id, p: w.appId })],
  ['GraphQL setAutomationReadGrant', 'DOOR_RETIRED', (c, t, w) => gql(c, 'mutation($m: String!, $p: String!) { setAutomationReadGrant(appRef: $p, triggerKind: "SCHEDULE", triggerId: "x", memoryRef: $m) { id } }', { m: t.id, p: w.appId })],
  ['GraphQL automationReadGrants', 'DOOR_RETIRED', (c, t, w) => gql(c, 'query($a: String, $r: String) { automationReadGrants(appRef: $a, memoryRef: $r) { id } }', { a: w.appId, r: t.id })],
  ['GraphQL setAssetPublicLink', 'UNAUTHENTICATED', (c, t) => gql(c, 'mutation($a: ID!) { setAssetPublicLink(assetRef: $a, enabled: true) { id } }', { a: t.assetId })],
  ['MCP hadron_set_asset_public_link', 'UNAUTHENTICATED', (c, t) => mcp(c, 'hadron_set_asset_public_link', { asset: t.assetId, enabled: true })],
  ['MCP hadron_set_automation_read_grant', 'DOOR_RETIRED', (c, t, w) => mcp(c, 'hadron_set_automation_read_grant', { app: w.appId, triggerKind: 'SCHEDULE', triggerId: 'x', memory: t.id })],
];

/** Everything that decides who reaches the memories. */
const audience = async () => JSON.stringify([
  await db.memoryShare.findMany({ orderBy: [{ memoryId: 'asc' }, { granteeId: 'asc' }] }),
  await db.memoryMember.findMany({ orderBy: [{ memoryId: 'asc' }, { userId: 'asc' }] }),
  await db.agentMemoryItem.findMany({ orderBy: { memoryId: 'asc' } }),
  await db.memory.findMany({ orderBy: { id: 'asc' }, select: { id: true, class: true, visibility: true, userId: true, ownerUserId: true, organizationId: true, appId: true, userMemoryOfAgentId: true, urn: true } }),
  await db.asset.findMany({ orderBy: { id: 'asc' }, select: { id: true, publicLinkEnabled: true } }),
  await db.appMemoryWriteGrant.findMany(), await db.appAutomationReadGrant.findMany(), await db.node.count(),
]);

/** The refusal code of an answer, or what came back instead, so an unexpected success reads in the failure message. */
function refusalCode(out: string): string {
  const body = JSON.parse(out) as { errors?: Array<{ extensions?: { code?: string } }>; isError?: boolean; content?: Array<{ text?: string }> };
  if (body.errors?.[0]?.extensions?.code) return body.errors[0].extensions.code;
  if (body.isError) return /\[([a-z_]+)\]/.exec(body.content?.[0]?.text ?? '')?.[1]?.toUpperCase() ?? 'MCP_ERROR_WITHOUT_CODE';
  return `NOT REFUSED: ${out}`;
}

describe.each(['organization', 'user'] as const)('#5224 item 2: an App key of a %s-owned App shares nothing', (kind) => {
  for (const cls of ['personal', 'private'] as const) {
    for (const bound of [false, true]) {
      describe(`${cls}, ${bound ? 'inside a session for the owner' : 'outside a session'}`, () => {
        let w: World;
        let t: Target;
        let caller: Caller;
        // One world for the block: every test asserts it wrote nothing, against its own snapshot.
        beforeAll(async () => {
          w = await makeWorld(kind);
          t = await seed(w, cls, SHAPES[0]);
          await db.memoryShare.create({ data: { memoryId: t.id, granteeId: w.leo, grantorId: w.mia, role: 'reader', createdBy: w.mia } });
          const sid = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.mia, agentId: w.agentId, memoryId: t.id } })).id;
          caller = bound ? { ...w.key, hadronSession: sid } : { ...w.key };
        }, 60_000);

        it.each(SHARE_DOORS)('%s: typed, the same for a memory that does not exist, and writes nothing', async (_name, query, vars) => {
          const before = await audience();
          const out = await gql(caller, query, vars(t, w));
          expect(refusalCode(out)).toBe('UNAUTHENTICATED');
          const ghost = ghostOf(t);
          expect(normalise(out, t)).toBe(normalise(await gql(caller, query, vars(ghost, w)), ghost));
          expect(await audience()).toBe(before);
        });

        it.each(MEMBER_DOORS)('%s: typed, and writes nothing', async (_name, query, vars) => {
          const before = await audience();
          const out = await gql(caller, query, vars(t, w));
          expect(['UNAUTHENTICATED', 'FORBIDDEN']).toContain(refusalCode(out));
          for (const f of LIVE_MARKS) expect(out).not.toContain(`${t.mark}${f}`);
          expect(await audience()).toBe(before);
        });

        it.each(WIDEN_DOORS)('%s: refused, writes nothing', async (_name, code, run) => {
          const before = await audience();
          const out = await run(caller, t, w);
          expect(refusalCode(out)).toBe(typeof code === 'string' ? code : code[bound ? 'inside' : 'outside']);
          for (const f of LIVE_MARKS) expect(out).not.toContain(`${t.mark}${f}`);
          expect(await audience()).toBe(before);
        });
      });
    }
  }

  it('the owner herself shares a personal memory through the same call, and a non-owner is FORBIDDEN', async () => {
    const w = await makeWorld(kind);
    const t = await seed(w, 'personal', SHAPES[2]);
    const [, query, vars] = SHARE_DOORS[0]!;
    expect(await gql(await userKey(w.leo), query, vars(t, w))).toContain('"code":"FORBIDDEN"');
    expect(await gql(w.miaKey, query, vars(t, w))).toContain('"role":"writer"');
  });

  // The key rows above stop at the door (UNAUTHENTICATED: attachMemoryToApp is person-only, main's #5224), so they no
  // longer show the memory-visibility check. A signed-in person who cannot see the memory still gets MEMORY_NOT_FOUND.
  it.each(['personal', 'private'] as const)('attachMemoryToApp: a signed-in person outsider to a %s memory gets MEMORY_NOT_FOUND, and nothing is written', async (cls) => {
    const w = await makeWorld(kind);
    const t = await seed(w, cls, SHAPES[2]);
    const before = await audience();
    const out = await gql(await userKey(w.leo), 'mutation($m: ID!, $p: ID!, $a: ID!) { attachMemoryToApp(memoryRef: $m, appRef: $p, agentRef: $a) { id } }', { m: t.id, p: w.appId, a: w.agentId });
    expect(refusalCode(out)).toBe('MEMORY_NOT_FOUND');
    for (const f of LIVE_MARKS) expect(out).not.toContain(`${t.mark}${f}`);
    expect(await audience()).toBe(before);
  });

  it('an App key is never offered a member or share tool on MCP', async () => {
    const w = await makeWorld(kind);
    await mcp(w.key, 'hadron_whoami', {});
    const { body } = await mcpPost(w.key, 'tools/list', {});
    const names = (body.result.tools as Array<{ name: string }>).map((x) => x.name);
    expect(names).toContain('hadron_set_asset_public_link');
    // A new share or member tool must be added to the doors above before it passes here: matched by whole words of the
    // name, and by the MCP names the GraphQL doors would have.
    const words = (n: string) => n.split('_');
    expect(names.filter((n) => words(n).some((x) => /^(share|shares|shared|member|members|collaborator|collaborators|invite|invites)$/.test(x)))).toEqual([]);
    const MUTATION_NAMES = [...SHARE_DOORS, ...MEMBER_DOORS].map(([n]) => `hadron_${n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`);
    expect(names.filter((n) => MUTATION_NAMES.includes(n))).toEqual([]);
    // A tool that sets a grant or a public link is a widening door, and must be in the matrix or say why it is not.
    const NOT_MEMORY_GRANTS: Record<string, string> = {
      hadron_set_automation_team_snapshot_grant: 'grants a read of the App\'s roster and tasks; it names no memory',
    };
    const widening = names.filter((n) => /^hadron_(set|create)_/.test(n) && words(n).some((x) => /^(grant|public)$/.test(x)));
    expect(widening.filter((n) => !WIDEN_DOORS.some(([d]) => d === `MCP ${n}`) && !(n in NOT_MEMORY_GRANTS))).toEqual([]);
  });
});

it('#5224: every GraphQL share and memory-member mutation is in the matrix', () => {
  const doors = Object.keys(resolvers.Mutation).filter((n) => /Memory(Share|Member)/.test(n)).sort();
  expect(doors).toEqual([...SHARE_DOORS, ...MEMBER_DOORS].map(([n]) => n).sort());
});

/**
 * #5237 item 2: a Query field that names a memory, node, asset, comment or revision, or returns one, is a read door. It
 * must be in READ_DOORS, or listed here with the reason it is not.
 */
const NOT_READ_DOORS: Record<string, string> = {
  installMemory: 'an install memory is system-class, never a person\'s personal or private memory',
  automationReadGrants: '#5404: retired, refuses DOOR_RETIRED for every caller (pinned in WIDEN_DOORS); it reads nothing',
};
it('#5237: every GraphQL read door that names or returns a memory, node, asset, comment or revision is in the matrix', () => {
  const NAMES = /^(memoryRef|memoryRefs|memoryUrn|memoryId|memoryIds|memory|nodeRef|nodeRefs|nodeId|nodeRevRef|parentRef|targetRef|assetId|assetRef|commentRef)$/;
  const RETURNS = new Set(['Memory', 'Node', 'Edge', 'Asset', 'Comment', 'NodeRevision']);
  const fields = Object.values(buildSchema(typeDefs).getQueryType()!.getFields())
    .filter((f) => f.args.some((x) => NAMES.test(x.name)) || RETURNS.has(getNamedType(f.type).name))
    .map((f) => f.name);
  const inMatrix = new Set(READ_DOORS.filter((d) => d.name.startsWith('GraphQL ')).flatMap((d) => [...d.name.matchAll(/^GraphQL (\w+)/g)].map((x) => x[1]!)));
  expect(fields.filter((f) => !inMatrix.has(f) && !(f in NOT_READ_DOORS)).sort()).toEqual([]);
  // A listed reason for a door that no longer exists, or that the matrix now covers, is stale.
  expect(Object.keys(NOT_READ_DOORS).filter((f) => !fields.includes(f) || inMatrix.has(f))).toEqual([]);
});

// ─── Item 3: the session read of ruling 0203 is unchanged ────────────────

describe.each(['organization', 'user'] as const)('#5224 item 3: in a session, the key of a %s-owned App reads the subscribed person\'s session memory', (kind) => {
  for (const cls of ['personal', 'private'] as const) {
    for (const surface of ['GraphQL', 'MCP'] as const) {
      const setup = async () => {
        const w = await makeWorld(kind);
        const t = await seed(w, cls, SHAPES[0]);
        const session = (over: Record<string, unknown> = {}) => db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.mia, agentId: w.agentId, memoryId: t.id, ...over } });
        const read = async (c: Caller) => (surface === 'GraphQL'
          ? gql(c, 'query($r: ID!) { node(ref: $r) { content } }', { r: node(t) })
          : mcp(c, 'hadron_get_node', { urn: node(t) }));
        return { w, t, session, read };
      };

      it(`${surface}, ${cls}: read, until the subscription ends, on the same connection`, async () => {
        const { w, t, session, read } = await setup();
        const c: Caller = { ...w.key, hadronSession: (await session()).id };
        expect(await read(c)).toContain(`${t.mark}C`);
        await db.agentSubscription.update({ where: { userId_agentId: { userId: w.mia, agentId: w.agentId } }, data: { revokedAt: new Date() } });
        const refused = await read(c);
        for (const f of LIVE_MARKS) expect(refused).not.toContain(`${t.mark}${f}`);
      });

      it(`${surface}, ${cls}: not in a session for another subscribed person`, async () => {
        const { w, t, session, read } = await setup();
        await createDbAgentSubscription(db, w.leo, w.agentId);
        const c: Caller = { ...w.key, hadronSession: (await session({ userId: w.leo })).id };
        expect(await read(c)).not.toContain(`${t.mark}C`);
      });

      it(`${surface}, ${cls}: not for a memory of another App, nor of another Agent`, async () => {
        for (const column of ['appId', 'userMemoryOfAgentId'] as const) {
          const { w, t, session, read } = await setup();
          const other = column === 'appId'
            ? (await db.app.create({ data: { id: generateId(), ...w.tenant, name: 'Y', urn: `${w.root}:y` } as never })).id
            : (await db.agent.create({ data: { id: generateId(), ...w.tenant, name: 'B', urn: `${w.root}:b` } as never })).id;
          await db.memory.update({ where: { id: t.id }, data: { [column]: other } });
          if (column === 'userMemoryOfAgentId') await createDbAgentSubscription(db, w.mia, other);
          expect(await read({ ...w.key, hadronSession: (await session()).id }), column).not.toContain(`${t.mark}C`);
        }
      });

      it(`${surface}, ${cls}: not the person's other memories, which the session does not name`, async () => {
        const { w, t, session, read } = await setup();
        const c: Caller = { ...w.key, hadronSession: (await session()).id };
        expect(await read(c)).toContain(`${t.mark}C`);
        for (const shape of SHAPES) {
          const other = await seed(w, cls, shape);
          const out = surface === 'GraphQL'
            ? await gql(c, 'query($r: ID!) { node(ref: $r) { content } }', { r: node(other) })
            : await mcp(c, 'hadron_get_node', { urn: node(other) });
          for (const f of LIVE_MARKS) expect(out, shape).not.toContain(`${other.mark}${f}`);
        }
      });

      it(`${surface}, ${cls}: not once the session has ended`, async () => {
        const { w, t, session, read } = await setup();
        const s = await session();
        const c: Caller = { ...w.key, hadronSession: s.id };
        expect(await read(c)).toContain(`${t.mark}C`);
        await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
        expect(await read(c)).not.toContain(`${t.mark}C`);
      });
    }
  }
});
