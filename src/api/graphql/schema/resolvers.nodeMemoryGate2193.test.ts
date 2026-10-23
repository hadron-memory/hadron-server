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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { MEMORY_INCLUDE } from './resolvers.helpers.js';

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
async function post(bearer: string, query: string, variables: Record<string, unknown> = {}): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Gql>;
}
/** What Query.memory answers this bearer for one memory: its id, or null. */
async function oracle(bearer: string, memoryId: string): Promise<string | null> {
  const r = await post(bearer, 'query($r: ID!) { memory(ref: $r) { id } }', { r: memoryId });
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
