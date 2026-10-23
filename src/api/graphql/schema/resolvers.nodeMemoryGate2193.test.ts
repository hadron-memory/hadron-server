/**
 * #2193 — Node.memory is an entry onto the Memory entity (cor:acl:110), so it
 * answers with the memory RECORD only when Query.memory would, for the same
 * principal: an unreadable or deleted memory reads as null (cor:api:140:03).
 * #474 — it never trusts a preloaded Memory, which appNodes truncates to
 * id/urn/name/organizationId.
 *
 * The parent's Node admission is unchanged: a Worker's handoff stays visible
 * to the team while its working memory's record is null for a member who may
 * not read it. Query.memory is the oracle for every principal and surface.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { hashAppKey, mintUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { buildAppKey, cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { MEMORY_INCLUDE } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const NodeR = (resolvers as any).Node;

let n: number;
let org: { id: string; urn: string };
let appId: string;
let workerId: string;
const user: Record<string, string> = {};
const mem: Record<string, string> = {};
const node: Record<string, string> = {};

const ctx = (who: string, extra: Partial<Context> = {}): Context => ({ db, userId: user[who], roles: ['READER'], ...extra });

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

type Gql = { data?: any; errors?: Array<{ message: string; extensions?: { code?: string } }> };
const keyFor = async (who: string) =>
  (await mintUserApiKey(db, { userId: user[who]!, label: null, createdBy: user[who]!, issuedVia: 'test' })).rawKey;
async function post(
  bearer: string, query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {},
): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Gql>;
}
/** What Query.memory answers this bearer for one memory: its id, or null. */
async function oracle(bearer: string, memoryId: string, headers: Record<string, string> = {}): Promise<string | null> {
  const r = await post(bearer, 'query($r: ID!) { memory(ref: $r) { id } }', { r: memoryId }, headers);
  expect(r.errors).toBeUndefined();
  return r.data.memory?.id ?? null;
}

const CONTINUITY = `query($w: ID!, $a: ID) { worker(ref: $w, appRef: $a) { continuity { handoff {
  id memoryId memory { id description data createdAt } } } } }`;
const APP_NODES = 'query($a: ID!) { appNodes(appRef: $a) { id memoryId memory { id name description createdAt } } }';

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Gate', urn: `gate2193-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['owner', 'admin', 'reader', 'member', 'stranger']) {
    user[who] = (await db.user.create({ data: { handle: `g2193-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.owner!, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.admin!, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.reader!, role: 'READER' } });

  appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  // An App member with no role in the owning org: the #2193 repro principal.
  await db.appMember.create({ data: { appId, userId: user.member!, role: 'member' } });

  mem.sys = (await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'Iris system', urn: `${org.urn}:iris-system` } })).id;
  const agentId = (await db.agent.create({
    data: { organizationId: org.id, name: 'Iris', urn: `${org.urn}:iris`, visibility: 'ORGANIZATION', systemMemoryId: mem.sys },
  })).id;
  await db.appAgent.create({ data: { appId, agentId } });

  mem.know = (await db.memory.create({
    data: {
      class: 'knowledge', organizationId: org.id, visibility: 'ORGANIZATION', name: 'Know', urn: `${org.urn}:know`,
      description: 'knowledge description', data: { planted: 'knowledge' },
    },
  })).id;
  await db.agentMemoryItem.create({ data: { agentId, memoryId: mem.know, role: 'read' } });

  // The Worker's app-owned working memory, with a description only its
  // record readers may see.
  mem.work = (await db.memory.create({
    data: {
      class: 'app', organizationId: org.id, appId, name: 'Iris working', urn: `${org.urn}:iris-working`,
      description: 'working-memory description', data: { planted: 'working' },
    },
  })).id;
  workerId = (await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Iris', slug: 'iris', memoryId: mem.work },
  })).id;

  for (const [key, memoryId, loc] of [
    ['sys', mem.sys, 'notes:sys'], ['know', mem.know, 'notes:know'], ['handoff', mem.work, 'handoffs:0001'],
  ] as const) {
    node[key] = (await db.node.create({ data: { memoryId, loc, name: key, content: key } })).id;
  }
});

describe('#2193 — Worker.continuity keeps the handoff and hides an unreadable working memory', () => {
  it('an App member who is not an org member sees the handoff with memory null, as Query.memory answers', async () => {
    const key = await keyFor('member');
    const r = await post(key, CONTINUITY, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    const handoff = r.data.worker.continuity.handoff;
    expect(handoff).toMatchObject({ id: node.handoff, memoryId: mem.work });
    expect(await oracle(key, mem.work)).toBeNull();
    expect(handoff.memory).toBeNull();
  });

  it('an org admin gets the full working-memory row, as Query.memory answers', async () => {
    const key = await keyFor('admin');
    const r = await post(key, CONTINUITY, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    expect(await oracle(key, mem.work)).toBe(mem.work);
    expect(r.data.worker.continuity.handoff.memory).toMatchObject({
      id: mem.work, description: 'working-memory description', data: { planted: 'working' }, createdAt: expect.any(String),
    });
  });
});

describe('#2193 — Node.memory agrees with Query.memory for every principal and surface', () => {
  async function bearers(): Promise<Array<[string, string]>> {
    const out: Array<[string, string]> = [];
    for (const who of ['reader', 'member', 'admin', 'stranger']) out.push([who, await keyFor(who)]);
    const started = await post(await keyFor('owner'),
      'mutation($o: String!, $u: String!) { startImpersonation(orgRef: $o, userRef: $u) { token } }', { o: org.id, u: user.admin });
    expect(started.errors).toBeUndefined();
    out.push(['impersonated admin', started.data.startImpersonation.token]);
    return out;
  }

  it('on appNodes, continuity, node(ref) and findNodes', async () => {
    let compared = 0;
    for (const [who, bearer] of await bearers()) {
      const nodes: Array<{ id: string; memoryId: string; memory: { id: string } | null }> = [];
      const app = await post(bearer, APP_NODES, { a: appId });
      if (!app.errors) nodes.push(...app.data.appNodes);
      const cont = await post(bearer, CONTINUITY, { w: workerId, a: appId });
      const handoff = cont.data?.worker?.continuity?.handoff;
      if (handoff) nodes.push(handoff);
      for (const id of Object.values(node)) {
        const one = await post(bearer, 'query($r: ID!) { node(ref: $r) { id memoryId memory { id } } }', { r: id });
        if (one.data?.node) nodes.push(one.data.node);
      }
      const found = await post(bearer, 'query { findNodes(limit: 50) { hits { node { id memoryId memory { id } } } } }');
      expect(found.errors, `${who}: findNodes`).toBeUndefined();
      for (const hit of found.data.findNodes.hits) nodes.push(hit.node);
      for (const x of nodes) {
        expect(x.memory?.id ?? null, `${who}: node ${x.id}`).toBe(await oracle(bearer, x.memoryId));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(10);
  });
});

describe('#474 — appNodes returns the authorized full row, never the truncated preload', () => {
  it('an admitted caller selects createdAt and description through appNodes', async () => {
    const key = await keyFor('admin');
    const r = await post(key, APP_NODES, { a: appId });
    expect(r.errors).toBeUndefined();
    const know = r.data.appNodes.find((x: { id: string }) => x.id === node.know);
    expect(know.memory).toMatchObject({ id: mem.know, description: 'knowledge description', createdAt: expect.any(String) });
  });
});

describe('#2193 — controls that keep their memory', () => {
  it('createNode returns its memory to the writer', async () => {
    const r = await post(await keyFor('admin'),
      'mutation($i: CreateNodeInput!) { createNode(input: $i) { id memory { id name } } }',
      { i: { memoryId: mem.know, loc: `notes:new-${n}`, name: 'new' } });
    expect(r.errors).toBeUndefined();
    expect(r.data.createNode.memory).toEqual({ id: mem.know, name: 'Know' });
  });
});

describe('#2193 — other Node parents: Node.memory still answers as Query.memory', () => {
  async function allBearers(): Promise<Array<[string, string]>> {
    const out: Array<[string, string]> = [];
    for (const who of ['owner', 'admin', 'reader', 'member', 'stranger']) out.push([who, await keyFor(who)]);
    return out;
  }
  const memoryMatchesOracle = async (who: string, bearer: string, nodes: Array<{ id: string; memoryId: string; memory: { id: string } | null }>) => {
    for (const x of nodes) expect(x.memory?.id ?? null, `${who}: node ${x.id}`).toBe(await oracle(bearer, x.memoryId));
  };

  // Who the fixtures admit. The org owner and admin read every memory of the org;
  // the others are admitted by the oracle, never assumed.
  const ADMITTED = ['owner', 'admin'];

  it('nodeBatch, for every principal', async () => {
    for (const [who, bearer] of await allBearers()) {
      const r = await post(bearer, 'query($r: [ID!]) { nodeBatch(refs: $r) { nodes { id memoryId memory { id } } } }', { r: Object.values(node) });
      expect(r.errors, `${who}: nodeBatch`).toBeUndefined();
      const nodes = r.data.nodeBatch.nodes as Array<{ id: string; memoryId: string; memory: { id: string } | null }>;
      if (ADMITTED.includes(who)) {
        expect(nodes.map((x) => x.id).sort(), `${who}: admitted nodes`).toEqual(Object.values(node).sort());
        for (const x of nodes) expect(x.memory?.id, `${who}: node ${x.id}`).toBe(x.memoryId);
      }
      // Expected admission, stated up front and not read off the response: the
      // org reader reads the ORGANIZATION-visible knowledge node and nothing in
      // the app-owned working memory; the App member reads neither.
      const ids = nodes.map((x) => x.id);
      if (who === 'reader') expect(ids, 'reader: knowledge node admitted').toContain(node.know);
      if (who === 'reader' || who === 'member' || who === 'stranger') expect(ids, `${who}: handoff denied`).not.toContain(node.handoff);
      if (who === 'stranger') expect(ids, `${who}: knowledge node denied`).not.toContain(node.know);
      await memoryMatchesOracle(who, bearer, nodes);
    }
  });

  it('Edge.source and Edge.target, for every principal', async () => {
    // A cross-memory edge, so the two endpoints sit under different record gates.
    await db.edge.create({ data: { memoryId: mem.know!, sourceId: node.know!, targetId: node.handoff!, loc: `edges:e-${n}` } });
    for (const [who, bearer] of await allBearers()) {
      const r = await post(bearer, 'query($o: ID) { edges(orgId: $o, limit: 50) { items { loc source { id memoryId memory { id } } target { id memoryId memory { id } } } } }', { o: org.id });
      expect(r.errors, `${who}: edges`).toBeUndefined();
      const items = r.data.edges.items as Array<{ loc: string; source: any; target: any }>;
      const e = items.find((x) => x.loc === `edges:e-${n}`);
      if (ADMITTED.includes(who)) {
        // Both endpoints are served, each with its own full Memory record.
        expect(e, `${who}: the edge`).toBeDefined();
        expect(e!.source, `${who}: source`).toMatchObject({ id: node.know, memory: { id: mem.know } });
        expect(e!.target, `${who}: target`).toMatchObject({ id: node.handoff, memory: { id: mem.work } });
      }
      if (who === 'reader') {
        // Stated up front: the org reader sees the edge and its knowledge-node
        // source with that memory's record; the target sits in the working
        // memory the reader may not read (nodeBatch pins the same denial).
        expect(e, 'reader: the edge').toBeDefined();
        expect(e!.source, 'reader: source').toMatchObject({ id: node.know, memory: { id: mem.know } });
        expect(e!.target, 'reader: target').toBeNull();
      }
      if (e) await memoryMatchesOracle(who, bearer, [e.source, e.target].filter(Boolean));
    }
  });

  it('AppRun.entryNode, for every principal', async () => {
    const admin = await keyFor('admin');
    const urn = (await post(admin, 'query($r: ID!) { node(ref: $r) { urn } }', { r: node.know })).data.node.urn as string;
    const run = await db.appRun.create({
      data: { id: generateId(), organizationId: org.id, appId, triggerKind: 'MANUAL', entryNodeUrn: urn, status: 'RUNNING' },
    });
    for (const [who, bearer] of await allBearers()) {
      const r = await post(bearer, 'query($r: ID!) { appRun(ref: $r) { entryNode { id memoryId memory { id } } } }', { r: run.id });
      expect(r.errors, `${who}: appRun`).toBeUndefined();
      const entry = r.data.appRun?.entryNode;
      if (ADMITTED.includes(who) || who === 'reader') {
        expect(entry, `${who}: entryNode`).toMatchObject({ id: node.know, memory: { id: mem.know } });
      }
      if (entry) await memoryMatchesOracle(who, bearer, [entry]);
    }
  });

  it('a soft-deleted memory reads null over the wire where the parent still admits the node', async () => {
    const admin = await keyFor('admin');
    const before = await post(admin, CONTINUITY, { w: workerId, a: appId });
    expect(before.data.worker.continuity.handoff.memory).toMatchObject({ id: mem.work });
    await db.memory.update({ where: { id: mem.work }, data: { deletedAt: new Date() } });
    const after = await post(admin, CONTINUITY, { w: workerId, a: appId });
    expect(after.errors).toBeUndefined();
    expect(after.data.worker.continuity.handoff).toMatchObject({ id: node.handoff });
    expect(after.data.worker.continuity.handoff.memory).toBeNull();
    expect(await oracle(admin, mem.work)).toBeNull();
  });
});

describe('#2193 — the resolver itself', () => {
  const memoryOf = (parent: Record<string, unknown>, who: string, extra: Partial<Context> = {}) =>
    NodeR.memory(parent, {}, ctx(who, extra));

  it('ignores a preloaded Memory: a denied caller gets null even when the parent carries one', async () => {
    const preload = await db.memory.findUniqueOrThrow({ where: { id: mem.work } });
    expect(await memoryOf({ memoryId: mem.work, memory: preload }, 'member')).toBeNull();
  });

  it('ignores a truncated preload: an admitted caller gets the full row', async () => {
    const row = await memoryOf({ memoryId: mem.know, memory: { id: mem.know, urn: 'x', name: 'x', organizationId: org.id } }, 'admin');
    expect(row).toMatchObject({ id: mem.know, description: 'knowledge description', createdAt: expect.any(Date) });
  });

  it('a soft-deleted memory is null, with or without a preload', async () => {
    const preload = await db.memory.findUniqueOrThrow({ where: { id: mem.know } });
    await db.memory.update({ where: { id: mem.know }, data: { deletedAt: new Date() } });
    expect(await memoryOf({ memoryId: mem.know }, 'admin')).toBeNull();
    expect(await memoryOf({ memoryId: mem.know, memory: preload }, 'admin')).toBeNull();
  });

  it('an inherited node stays null even for a caller who may read the base record', async () => {
    expect(await memoryOf({ memoryId: mem.know }, 'admin')).not.toBeNull();
    expect(await memoryOf({ memoryId: mem.know, inheritedFrom: { agentId: 'base', agentUrn: 'x:base' } }, 'admin')).toBeNull();
  });

  it('loads each distinct memory once per request', async () => {
    let loads = 0;
    const memory = new Proxy(db.memory, {
      get: (target, prop, recv) => (prop === 'findUnique'
        ? (args: { include?: unknown }) => {
          if (args.include === MEMORY_INCLUDE) loads++;
          return (target as any).findUnique(args);
        }
        : Reflect.get(target, prop, recv)),
    });
    const counting = new Proxy(db, { get: (target, prop, recv) => (prop === 'memory' ? memory : Reflect.get(target, prop, recv)) });
    const c = { ...ctx('admin'), db: counting as typeof db };
    for (const memoryId of [mem.know, mem.know, mem.work, mem.know, mem.work]) await NodeR.memory({ memoryId }, {}, c);
    expect(loads).toBe(2);
  });
});


// ---------------------------------------------------------------------------
// #2193 remaining controls (Chip QA 6369387618, Atilla §10 6369397229, CHECKED 6323973854)
// ---------------------------------------------------------------------------

type Served = { id: string; memoryId: string; memory: { id: string; description?: string | null; createdAt?: string } | null };

/** Every principal that is not a user key: the App's own key, bare and bound to the Worker's session. */
async function appPrincipals(): Promise<Array<{ who: string; bearer: string; headers: Record<string, string> }>> {
  const raw = buildAppKey();
  await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
  const sessionId = generateId();
  await db.session.create({ data: { id: sessionId, appId, agentId: (await db.worker.findUniqueOrThrow({ where: { id: workerId } })).agentId, workerId, memoryId: mem.work } });
  return [
    { who: 'app key', bearer: raw, headers: {} },
    { who: 'app key + worker session', bearer: raw, headers: { 'x-hadron-session': sessionId } },
  ];
}

describe('#2193 — App-key and session principals: Node.memory answers as Query.memory', () => {
  it('on appNodes, node(ref) and continuity, with the admission each principal is expected to get', async () => {
    let compared = 0;
    for (const { who, bearer, headers } of await appPrincipals()) {
      // appNodes is a participant/org-member surface: a bare App key is refused there.
      const app = await post(bearer, APP_NODES, { a: appId }, headers);
      expect(app.errors?.[0]?.extensions?.code, `${who}: appNodes`).toBe('FORBIDDEN');
      const served: Served[] = [];
      const cont = await post(bearer, CONTINUITY, { w: workerId, a: appId }, headers);
      if (cont.data?.worker?.continuity?.handoff) served.push(cont.data.worker.continuity.handoff);
      for (const id of Object.values(node)) {
        const one = await post(bearer, 'query($r: ID!) { node(ref: $r) { id memoryId memory { id } } }', { r: id }, headers);
        expect(one.errors, `${who}: node(ref)`).toBeUndefined();
        if (one.data.node) served.push(one.data.node);
      }
      // Stated up front, per principal and node: what the Memory record must answer.
      // The bare App key reaches the installed Agent's own memories (system, knowledge) and not
      // the app-owned working memory. A session narrows it to the session's reach (cor:aut:020:02):
      // the Agent's system memory only. Neither reaches a Worker's working memory record
      // (sessionScopedMemoryIds, #1349), though the parent still admits the handoff node.
      const bare = !headers['x-hadron-session'];
      const expected: Record<string, string | null> = {
        [node.sys!]: mem.sys!, [node.know!]: bare ? mem.know! : null, [node.handoff!]: null,
      };
      expect(served.map((x) => x.id), `${who}: handoff admitted`).toContain(node.handoff);
      for (const [id, memoryId] of Object.entries(expected)) {
        const x = served.find((y) => y.id === id);
        if (id !== node.handoff && memoryId === null) continue;
        expect(x, `${who}: node ${id} served`).toBeDefined();
        expect(x!.memory?.id ?? null, `${who}: node ${id} memory`).toBe(memoryId);
      }
      for (const x of served) {
        expect(x.memory?.id ?? null, `${who}: node ${x.id} vs Query.memory`).toBe(await oracle(bearer, x.memoryId, headers));
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(2);
  });
});

describe('#2193 — Decision.node, with the parent admitting the node', () => {
  it('serves the node with its memory exactly where Query.memory does', async () => {
    const owner = ctx('owner');
    const log = await (resolvers as any).Mutation.createDecisionLog(null,
      { memoryRef: mem.know, loc: 'decisions', defaultDeciders: [user.owner] }, owner);
    const asked = await (resolvers as any).Mutation.askDecision(null, {
      logRef: log.row.id,
      input: { title: 'Ship it?', parts: [{ question: 'Ship it now?', yesno: true, recommendation: { key: 'yes', reason: 'ready' } }] },
    }, owner);
    for (const who of ['owner', 'admin', 'reader', 'stranger']) {
      const bearer = await keyFor(who);
      const r = await post(bearer, 'query($r: ID!) { decision(ref: $r) { id node { id memoryId memory { id description } } } }', { r: asked.row.id });
      expect(r.errors, `${who}: decision`).toBeUndefined();
      const d = r.data.decision;
      // Stated up front: the org's owner, admin and reader read the ORGANIZATION-visible
      // memory the decision lives in; a stranger reads neither the decision nor its memory.
      if (who === 'stranger') { expect(d, 'stranger: concealed').toBeNull(); expect(await oracle(bearer, mem.know)).toBeNull(); continue; }
      expect(d, `${who}: decision admitted`).not.toBeNull();
      expect(d.node, `${who}: node`).toMatchObject({ id: asked.row.id, memoryId: mem.know });
      expect(await oracle(bearer, mem.know), `${who}: oracle`).toBe(mem.know);
      expect(d.node.memory, `${who}: memory`).toMatchObject({ id: mem.know, description: 'knowledge description' });
    }
  });
});

describe('#2193 — listed task and process nodes', () => {
  it('agentTaskList and agentProcessList serve each node with Node.memory as Query.memory answers', async () => {
    const task = await db.node.create({ data: { memoryId: mem.sys, loc: 'tasks:t', name: 't', content: 't', isRunnable: true } });
    const proc = await db.node.create({ data: { memoryId: mem.sys, loc: 'processes:p', name: 'p', content: 'p', role: 'process' } });
    await db.edge.create({ data: { memoryId: mem.sys, sourceId: proc.id, targetId: task.id, loc: `edges:stage-${n}`, name: 'stage 1' } });
    const agentUrn = `${org.urn}:iris`;
    const LISTS = `query($r: ID!) {
      agentTaskList(ref: $r) { node { id memoryId memory { id description } } }
      agentProcessList(ref: $r) { kind node { id memoryId memory { id description } } } }`;
    let compared = 0;
    for (const who of ['owner', 'admin', 'reader', 'member', 'stranger']) {
      const bearer = await keyFor(who);
      const r = await post(bearer, LISTS, { r: agentUrn });
      const sysReadable = (await oracle(bearer, mem.sys)) === mem.sys;
      if (who === 'owner' || who === 'admin') {
        // Stated up front: org owner and admin read the Agent's system memory, so
        // both lists are served and carry its full Memory record.
        expect(r.errors, `${who}: lists`).toBeUndefined();
        expect(r.data.agentTaskList.map((e: any) => e.node.id), `${who}: task`).toContain(task.id);
        expect(r.data.agentProcessList.map((e: any) => [e.node.id, e.kind]), `${who}: process`).toContainEqual([proc.id, 'INVOLVED']);
      }
      if (r.errors) { expect(sysReadable, `${who}: refused only where the system memory is unreadable`).toBe(false); continue; }
      for (const e of [...r.data.agentTaskList, ...r.data.agentProcessList] as Array<{ node: Served }>) {
        expect(e.node.memory?.id ?? null, `${who}: node ${e.node.id}`).toBe(await oracle(bearer, e.node.memoryId));
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(4);
  });
});

describe('#474 / #2193 — preload and no-preload twins over HTTP', () => {
  it('appNodes (truncated preload) and node(ref) (none) answer the same memory for the same principal', async () => {
    // Stated up front, per principal, before any response is read: the nodes appNodes must serve
    // (the installed Agent's system and knowledge memories, never the app-owned working memory),
    // or the refusal it must give. A principal whose list vanished fails here, not silently.
    const expected: Record<string, { ids: string[] } | { refused: true }> = {
      owner: { ids: [node.sys!, node.know!] }, admin: { ids: [node.sys!, node.know!] },
      reader: { ids: [node.sys!, node.know!] }, member: { ids: [node.sys!, node.know!] }, stranger: { refused: true },
    };
    const q = 'query($a: ID!) { appNodes(appRef: $a) { id memory { id name description createdAt } } }';
    for (const who of Object.keys(expected)) {
      const bearer = await keyFor(who);
      const app = await post(bearer, q, { a: appId });
      const want = expected[who]!;
      if ('refused' in want) { expect(app.errors?.[0]?.extensions?.code, `${who}: appNodes refusal`).toBe('FORBIDDEN'); continue; }
      expect(app.errors, `${who}: appNodes`).toBeUndefined();
      const preload = new Map<string, any>(app.data.appNodes.map((x: any) => [x.id, x.memory]));
      expect([...preload.keys()].sort(), `${who}: nodes served`).toEqual([...want.ids].sort());
      for (const id of want.ids) {
        const one = await post(bearer, 'query($r: ID!) { node(ref: $r) { memory { id name description createdAt } } }', { r: id });
        expect(one.errors, `${who}: node(ref)`).toBeUndefined();
        // Where node(ref) does not admit the node at all, the preloaded path must not hand out
        // the record either: a list that admits a node node(ref) hides still answers null.
        expect(preload.get(id), `${who}: twin of node ${id}`).toEqual(one.data.node ? one.data.node.memory : null);
      }
      // The reader's twins stay observable: the knowledge record in full, the system record null.
      if (who === 'reader') {
        expect(preload.get(node.know!), 'reader: knowledge record').toMatchObject({ id: mem.know, description: 'knowledge description' });
        expect(preload.get(node.sys!), 'reader: system record').toBeNull();
      }
    }
  });
});

describe('#2193 — the wire-level load count', () => {
  it('an appNodes response loads each distinct memory once, counting only the record loader', async () => {
    await db.node.create({ data: { memoryId: mem.know, loc: 'notes:know-2', name: 'know 2', content: 'k2' } });
    const spy = vi.spyOn(db.memory, 'findUnique');
    try {
      const r = await post(await keyFor('admin'), APP_NODES, { a: appId });
      expect(r.errors).toBeUndefined();
      const nodes = r.data.appNodes as Array<{ memoryId: string }>;
      const distinct = new Set(nodes.map((x) => x.memoryId)).size;
      expect(nodes.length, 'the list repeats a memory').toBeGreaterThan(distinct);
      const loads = spy.mock.calls.filter(([args]) => (args as { include?: unknown })?.include === MEMORY_INCLUDE).length;
      expect(loads).toBe(distinct);
    } finally { spy.mockRestore(); }
  });
});


describe('#2193 — run principal', () => {
  it('Node.memory answers as Query.memory for an AppRun acting for its App and a user', async () => {
    const { runAuthContext } = await import('../../../lib/auth/runPrincipal.js');
    const Q = (resolvers as any).Query;
    for (const who of ['admin', 'member']) {
      const run = await db.appRun.create({
        data: { id: generateId(), organizationId: org.id, appId, userId: user[who], triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:x:y:z', status: 'RUNNING' },
      });
      const c: Context = { db, ...runAuthContext(run) };
      for (const [key, memoryId] of [['know', mem.know], ['handoff', mem.work]] as const) {
        const record = await Q.memory(null, { ref: memoryId }, c);
        const viaNode = await NodeR.memory({ memoryId }, {}, c);
        expect(viaNode?.id ?? null, `run for ${who}: ${key}`).toBe(record?.id ?? null);
      }
      // Stated up front: the run reaches the installed Agent's knowledge memory, so the
      // control is not vacuously null on both sides.
      expect(await NodeR.memory({ memoryId: mem.know }, {}, c), `run for ${who}: know`).toMatchObject({ id: mem.know });
    }
  });
});

describe('#2193 — a soft-deleted memory, over the wire, through a parent that still serves the node', () => {
  it('Worker.continuity keeps the handoff and reads its deleted memory null, even for a platform admin the record gate always admits', async () => {
    // A platform admin passes canReadMemoryRecord for any memory, so the loader's own
    // deleted check is the only thing between them and a deleted memory's record.
    user.platform = (await db.user.create({ data: { handle: `g2193-platform-${n}`, roles: ['ADMIN'] } })).id;
    const platform = await keyFor('platform');
    const before = await post(platform, CONTINUITY, { w: workerId, a: appId });
    expect(before.errors).toBeUndefined();
    expect(before.data.worker.continuity.handoff, 'before: handoff and its memory served').toMatchObject({ id: node.handoff, memory: { id: mem.work } });
    await db.memory.update({ where: { id: mem.work }, data: { deletedAt: new Date() } });
    const after = await post(platform, CONTINUITY, { w: workerId, a: appId });
    expect(after.errors).toBeUndefined();
    expect(await oracle(platform, mem.work!), 'Query.memory').toBeNull();
    expect(after.data.worker.continuity.handoff, 'after: the parent still serves the node').toMatchObject({ id: node.handoff });
    expect(after.data.worker.continuity.handoff.memory, 'after: the deleted memory').toBeNull();
  });
});
