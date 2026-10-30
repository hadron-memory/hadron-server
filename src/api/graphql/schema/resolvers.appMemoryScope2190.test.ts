/**
 * #2190 (cor:dmo:050:17) — appMemoryScope: the memories appNodes reads for a
 * caller, one row per memory with every reason it is in scope, paged, with an
 * advisory viewerCanWrite from the createNode gate.
 *
 * appNodes is the oracle: both fields share one admission-and-scope helper, and
 * the differential below holds them to the same inventory for every principal
 * shape (org reader, org reader who is also an App member, external App member,
 * org admin). The fixture carries every exclusion the fold applies — a worker's
 * working memory, another App's memory, an unlicensed foreign Agent — plus a
 * memory linked by two Agents, an empty memory, an inherited base, and a base
 * whose only node is a boot prompt (never inherited, so never listed).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;

type Row = { memoryId: string; memoryUrn: string; name: string; class: string; sources: Array<{ kind: string; agentId: string | null }>; viewerCanWrite: boolean };

let n: number;
let org: { id: string; urn: string };
let foreignOrg: { id: string; urn: string };
let appId: string;
const user: Record<string, string> = {};
const agent: Record<string, string> = {};
const mem: Record<string, string> = {};

const ctx = (who: string): Context => ({ db, userId: user[who], roles: ['READER'] });

async function memory(key: string, data: { orgId?: string; class?: string; appId?: string; sharedMemoryOfAgentId?: string } = {}, withNode = true) {
  const o = data.orgId === foreignOrg?.id ? foreignOrg : org;
  mem[key] = (await db.memory.create({
    data: {
      class: (data.class ?? 'knowledge') as any,
      organizationId: o.id,
      name: key,
      urn: `${o.urn}:${key.toLowerCase()}`,
      appId: data.appId ?? null,
      sharedMemoryOfAgentId: data.sharedMemoryOfAgentId ?? null,
    },
  })).id;
  if (withNode) await db.node.create({ data: { memoryId: mem[key], loc: `notes:${key.toLowerCase()}`, name: key, content: key } });
  return mem[key]!;
}

async function makeAgent(key: string, opts: { orgId?: string; base?: string } = {}) {
  const o = opts.orgId === foreignOrg?.id ? foreignOrg : org;
  const sys = await db.memory.create({ data: { class: 'system', organizationId: o.id, name: `${key} system`, urn: `${o.urn}:${key}-system` } });
  mem[`sys${key}`] = sys.id;
  agent[key] = (await db.agent.create({
    data: { organizationId: o.id, name: key, urn: `${o.urn}:${key}`, visibility: 'ORGANIZATION', systemMemoryId: sys.id, extendsAgentId: opts.base ? agent[opts.base] : null },
  })).id;
  return agent[key]!;
}

const link = (agentKey: string, memKey: string, role: 'read' | 'read-write' = 'read') =>
  db.agentMemoryItem.create({ data: { agentId: agent[agentKey]!, memoryId: mem[memKey]!, role } });

async function scopeAll(who: string, pageSize = 2): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: pageSize, offset }, ctx(who));
    rows.push(...page.items);
    if (page.items.length === 0 || rows.length >= page.total) break;
  }
  return rows;
}

const appNodesMemoryIds = async (who: string) =>
  new Set<string>((await Q.appNodes({}, { appRef: appId }, ctx(who))).map((x: { memoryId: string }) => x.memoryId));

const keyOf = (id: string) => Object.entries(mem).find(([, v]) => v === id)?.[0] ?? id;
const keysOf = (rows: Row[]) => rows.map((r) => keyOf(r.memoryId)).sort();

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Scope', urn: `scope2190-${n}.example` }, select: { id: true, urn: true } });
  foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: `foreign2190-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['reader', 'member', 'external', 'admin', 'stranger']) {
    user[who] = (await db.user.create({ data: { handle: `s2190-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.reader!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.member!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.admin!, role: 'ADMIN' } });

  appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  const otherAppId = (await db.app.create({ data: { name: 'Other', urn: `${org.urn}:other`, organizationId: org.id } })).id;
  await db.appMember.create({ data: { appId, userId: user.member!, role: 'member' } });
  await db.appMember.create({ data: { appId, userId: user.external!, role: 'member' } });

  // Agents: Alpha installed first; Beta (extends Core, which extends Root)
  // second; Gamma, a foreign Agent with no org grant, third.
  await makeAgent('Root');
  await makeAgent('Core', { base: 'Root' });
  await makeAgent('Alpha');
  await makeAgent('Beta', { base: 'Core' });
  await makeAgent('Gamma', { orgId: foreignOrg.id });
  const t0 = Date.now();
  for (const [i, key] of ['Alpha', 'Beta', 'Gamma'].entries()) {
    await db.appAgent.create({ data: { appId, agentId: agent[key]!, createdAt: new Date(t0 + i * 1000) } });
  }

  // System memories get a node each; Core's is inherited into Beta, Root's
  // only node is a boot prompt, which no child ever inherits.
  for (const key of ['Alpha', 'Beta', 'Core']) {
    await db.node.create({ data: { memoryId: mem[`sys${key}`]!, loc: `notes:${key.toLowerCase()}`, name: key, content: key } });
  }
  await db.node.create({ data: { memoryId: mem.sysRoot!, loc: 'prompts:boot', name: 'boot', content: 'boot', role: 'boot-prompt' } });

  await memory('KnowA');
  await memory('KnowShared');
  await memory('KnowEmpty', {}, false);
  await memory('KnowB');
  await memory('KnowC', { orgId: foreignOrg.id });
  // Linked by Alpha, but in an org Alpha's tenant cannot reach: the link is a
  // limit, never a grant (cor:dmo:050:09), so it caps to nothing.
  await memory('KnowF', { orgId: foreignOrg.id });
  await memory('TeamSpace', { class: 'app', appId, sharedMemoryOfAgentId: agent.Alpha });
  await memory('WorkerMem', { class: 'app', appId });
  await memory('OtherAppMem', { class: 'app', appId: otherAppId });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.Alpha!, name: 'Iris', slug: 'iris', memoryId: mem.WorkerMem! } });

  await link('Alpha', 'KnowA', 'read-write');
  await link('Alpha', 'KnowShared');
  await link('Alpha', 'KnowEmpty');
  await link('Alpha', 'WorkerMem');
  await link('Alpha', 'OtherAppMem');
  await link('Alpha', 'KnowF', 'read-write');
  await link('Beta', 'KnowShared', 'read-write');
  await link('Beta', 'KnowB');
  await link('Gamma', 'KnowC');
});

describe('#2190 — the inventory matches appNodes for every principal', () => {
  for (const who of ['reader', 'member', 'external', 'admin']) {
    it(`${who}: every appNodes memory is a row, and the only rows appNodes lacks are empty`, async () => {
      const rows = await scopeAll(who);
      const fromNodes = await appNodesMemoryIds(who);
      const scoped = new Set(rows.map((r) => r.memoryId));
      for (const id of fromNodes) expect(scoped.has(id), `appNodes memory ${keyOf(id)} missing from memoryScope`).toBe(true);
      const extra = [...scoped].filter((id) => !fromNodes.has(id)).map(keyOf);
      expect(extra.every((k) => k === 'KnowEmpty'), `rows with visible nodes absent from appNodes: ${extra}`).toBe(true);
    });
  }
});

describe('#2190 — what is in scope, and why', () => {
  it('an org reader who is also an App member: every licensed Agent, the team space, and the inherited base', async () => {
    expect(keysOf(await scopeAll('member'))).toEqual(
      ['KnowA', 'KnowB', 'KnowEmpty', 'KnowShared', 'TeamSpace', 'sysAlpha', 'sysBeta', 'sysCore'],
    );
  });

  it('an org reader who is not an App member gets no team space', async () => {
    expect(keysOf(await scopeAll('reader'))).toEqual(
      ['KnowA', 'KnowB', 'KnowEmpty', 'KnowShared', 'sysAlpha', 'sysBeta', 'sysCore'],
    );
  });

  it('an external App member gets the first Agent and the team space only', async () => {
    expect(keysOf(await scopeAll('external'))).toEqual(['KnowA', 'KnowEmpty', 'KnowShared', 'TeamSpace', 'sysAlpha']);
  });

  it('never lists a worker memory, another App\'s memory, an unlicensed Agent\'s memory, a link capped to nothing, or a base with nothing inherited', async () => {
    const keys = keysOf(await scopeAll('admin'));
    for (const k of ['WorkerMem', 'OtherAppMem', 'KnowC', 'KnowF', 'sysGamma', 'sysRoot']) expect(keys).not.toContain(k);
  });

  it('one row per memory, with every source in kind then install order', async () => {
    const rows = await scopeAll('member');
    const by = (k: string) => rows.find((r) => r.memoryId === mem[k])!;
    expect(rows.filter((r) => r.memoryId === mem.KnowShared)).toHaveLength(1);
    expect(by('KnowShared').sources).toEqual([
      { kind: 'AGENT_LINK', agentId: agent.Alpha },
      { kind: 'AGENT_LINK', agentId: agent.Beta },
    ]);
    expect(by('sysAlpha').sources).toEqual([{ kind: 'AGENT_SYSTEM', agentId: agent.Alpha }]);
    expect(by('sysCore').sources).toEqual([{ kind: 'INHERITED_BASE', agentId: agent.Core }]);
    expect(by('TeamSpace').sources).toEqual([{ kind: 'TEAM_SPACE', agentId: null }]);
    expect(by('KnowEmpty')).toMatchObject({ name: 'KnowEmpty', class: 'knowledge' });
  });

  it('an external member sees only the first Agent\'s link on a memory two Agents share', async () => {
    const shared = (await scopeAll('external')).find((r) => r.memoryId === mem.KnowShared)!;
    expect(shared.sources).toEqual([{ kind: 'AGENT_LINK', agentId: agent.Alpha }]);
  });
});

describe('#2190 — viewerCanWrite is the viewer\'s createNode gate, not the Agent\'s link', () => {
  it('a read-write link does not make a memory writable for an org reader', async () => {
    const row = (await scopeAll('reader')).find((r) => r.memoryId === mem.KnowA)!;
    expect(row.viewerCanWrite).toBe(false);
  });

  it('a read link does not stop an org admin who may write the memory', async () => {
    const row = (await scopeAll('admin')).find((r) => r.memoryId === mem.KnowB)!;
    expect(row.viewerCanWrite).toBe(true);
  });

  it('agrees with createNode, row by row', async () => {
    for (const who of ['reader', 'member', 'admin']) {
      for (const row of await scopeAll(who)) {
        let wrote = true;
        try {
          await (resolvers.Mutation as any).createNode({}, { input: { memoryId: row.memoryId, loc: `probe:${n}-${who}`, name: 'probe' } }, ctx(who));
        } catch {
          wrote = false;
        }
        expect(row.viewerCanWrite, `${who} on ${keyOf(row.memoryId)}`).toBe(wrote);
      }
    }
  });
});

describe('#2190 — a write-gate failure is a failure, never a read-only answer', () => {
  it('fails the field when the gate errors with anything but its FORBIDDEN denial', async () => {
    const boom = new Error('simulated memory lookup failure');
    const memory = new Proxy(db.memory, {
      get: (target, prop, recv) => (prop === 'findUniqueOrThrow' ? () => Promise.reject(boom) : Reflect.get(target, prop, recv)),
    });
    const failing = new Proxy(db, { get: (target, prop, recv) => (prop === 'memory' ? memory : Reflect.get(target, prop, recv)) });
    await expect(Q.appMemoryScope({}, { appRef: appId }, { ...ctx('member'), db: failing as typeof db })).rejects.toBe(boom);
  });
});

describe('#2190 — paging (cor:api:120:04)', () => {
  it('pages in memoryUrn order without dropping or repeating a row', async () => {
    const full = (await Q.appMemoryScope({}, { appRef: appId }, ctx('member'))).items as Row[];
    const paged = await scopeAll('member', 3);
    expect(paged.map((r) => r.memoryId)).toEqual(full.map((r) => r.memoryId));
    const urns = full.map((r) => r.memoryUrn);
    expect(urns).toEqual([...urns].sort());
    expect(new Set(urns).size).toBe(urns.length);
  });

  it('reports the whole scope in total, and an offset past the end returns no items', async () => {
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: 2, offset: 100 }, ctx('member'));
    expect(page.items).toEqual([]);
    expect(page.total).toBe(8);
  });

  it('a limit over the cap returns a page of the cap, never a refusal', async () => {
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: 10_000 }, ctx('member'));
    expect(page.items).toHaveLength(8);
  });
});

describe('#2190 — admission is appNodes\' own', () => {
  it('a caller appNodes refuses gets the same refusal', async () => {
    const refusal = await Q.appNodes({}, { appRef: appId }, ctx('stranger')).catch((e: Error) => e);
    expect(refusal).toBeInstanceOf(Error);
    await expect(Q.appMemoryScope({}, { appRef: appId }, ctx('stranger'))).rejects.toThrow(refusal.message);
  });

  it('an App in a soft-deleted organization has an empty scope, as appNodes does', async () => {
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await Q.appNodes({}, { appRef: appId }, ctx('member'))).toEqual([]);
    expect(await Q.appMemoryScope({}, { appRef: appId }, ctx('member'))).toEqual({ items: [], total: 0 });
  });
});

// #2196 QA (Clark): the composition only the real HTTP boundary has. The
// outer Query.app gate, and the read-only plugin that refuses an impersonated
// mutation before any resolver runs, are invisible to direct-resolver calls.
describe('#2190 — over the real GraphQL HTTP boundary', () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createHttpServer(await createServer());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const keyFor = async (who: string) =>
    (await mintUserApiKey(db, { userId: user[who]!, label: null, createdBy: user[who]!, issuedVia: 'test' })).rawKey;
  // `status` is 200 unless named: the read-only plugin refuses at
  // didResolveOperation, which Apollo answers with a 500 carrying the code.
  const post = async (bearer: string, query: string, variables: Record<string, unknown> = {}, status = 200) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    expect(response.status).toBe(status);
    return response.json() as Promise<{ data?: any; errors?: Array<{ message: string; extensions?: { code?: string } }> }>;
  };
  const SCOPE = 'query($a: ID!) { appMemoryScope(appRef: $a, limit: 200) { total items { memoryId viewerCanWrite } } }';
  const NODES = 'query($a: ID!) { appNodes(appRef: $a) { memoryId } }';

  it('answers an external App participant whom Query.app refuses, with appNodes\' scope', async () => {
    const key = await keyFor('external');
    const app = await post(key, 'query($a: ID!) { app(ref: $a) { id } }', { a: appId });
    expect(app.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const scope = await post(key, SCOPE, { a: appId });
    expect(scope.errors).toBeUndefined();
    const ids = new Set<string>(scope.data.appMemoryScope.items.map((r: Row) => r.memoryId));
    expect([...ids].map(keyOf).sort()).toEqual(keysOf(await scopeAll('external')));
    expect(ids.has(mem.TeamSpace!)).toBe(true);
    const nodes = await post(key, NODES, { a: appId });
    for (const { memoryId } of nodes.data.appNodes) expect(ids.has(memoryId)).toBe(true);
  });

  it('gives total 0 for an App in a soft-deleted organization, as appNodes gives []', async () => {
    const key = await keyFor('member');
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect((await post(key, NODES, { a: appId })).data.appNodes).toEqual([]);
    const scope = await post(key, SCOPE, { a: appId });
    expect(scope.errors).toBeUndefined();
    expect(scope.data.appMemoryScope).toEqual({ total: 0, items: [] });
  });

  it('reads no row as writable in a read-only impersonation session, where createNode is refused', async () => {
    user.owner = (await db.user.create({ data: { handle: `s2190-owner-${n}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.owner, role: 'OWNER' } });
    const started = await post(await keyFor('owner'),
      'mutation($o: String!, $u: String!) { startImpersonation(orgRef: $o, userRef: $u) { token } }', { o: org.id, u: user.admin });
    expect(started.errors).toBeUndefined();
    const token: string = started.data.startImpersonation.token;

    // Control: the same admin, signed in as themselves, may write some rows.
    const own = (await post(await keyFor('admin'), SCOPE, { a: appId })).data.appMemoryScope.items as Row[];
    const writable = own.filter((r) => r.viewerCanWrite);
    expect(writable.length).toBeGreaterThan(0);

    const impersonated = await post(token, SCOPE, { a: appId });
    expect(impersonated.errors).toBeUndefined();
    const rows = impersonated.data.appMemoryScope.items as Row[];
    expect(rows.map((r) => r.memoryId)).toEqual(own.map((r) => r.memoryId));
    expect(rows.filter((r) => r.viewerCanWrite)).toEqual([]);

    const created = await post(token, 'mutation($i: CreateNodeInput!) { createNode(input: $i) { id } }',
      { i: { memoryId: writable[0]!.memoryId, loc: `probe:imp-${n}`, name: 'probe' } }, 500);
    expect(created.errors?.[0]?.extensions?.code).toBe('IMPERSONATION_READ_ONLY');
    expect(await db.node.count({ where: { memoryId: writable[0]!.memoryId, loc: `probe:imp-${n}` } })).toBe(0);
  });
});
