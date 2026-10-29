/**
 * #2640 — every App field that names an installed Agent answers as that Agent's own read does.
 * `App.agentId` and `App.installedAgentUrn` once returned the primary install's id / URN with no read gate,
 * while `App.agent` next to them was gated. Real resolvers over real Postgres, two tenants: the hidden Agent
 * is an ORGANIZATION-visibility Agent of a foreign org.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

const SENTINEL = 'ZZ-HIDDEN-AGENT-q7x2';

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let hidden: { id: string; urn: string };
let hidden2: { id: string; urn: string };
let readable: { id: string; urn: string };
let readable2: { id: string; urn: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

const QUERY = `query($ref:ID!){app(ref:$ref){
  agentId agent{id} agents{id} installedAgentUrn appAgents{agent{id}}
}}`;

async function read(userId = member.id) {
  const res = await server.executeOperation({ query: QUERY, variables: { ref: app.urn } }, { contextValue: ctx(userId) });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  const r = res.body.singleResult;
  expect(r.errors).toBeUndefined();
  return { data: r.data!.app as any, json: JSON.stringify(r.data) };
}

async function agent(org: { id: string; urn: string }, slug: string, visibility: 'PUBLIC' | 'ORGANIZATION', name = slug) {
  return db.agent.create({ data: { id: generateId(), organizationId: org.id, name, urn: `${org.urn}:${slug}`, visibility } });
}

let seq = 0;
async function install(agentId: string) {
  // createdAt decides which install is primary (orderBy createdAt asc).
  await db.appAgent.create({ data: { appId: app.id, agentId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)) } });
}

beforeEach(async () => {
  await cleanDb(db);
  seq = 0;
  const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'org-a', urn: `org-a-${s}.com` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'org-b', urn: `org-b-${s}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 98_300, githubUsername: `m-${s}`, roles: ['READER'] }, select: { id: true } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 98_301, githubUsername: `o-${s}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, name: 'App', urn: `${orgA.urn}:app` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  hidden = await agent(orgB, 'hidden-p', 'ORGANIZATION', SENTINEL);
  hidden2 = await agent(orgB, 'hidden-s', 'ORGANIZATION', `${SENTINEL}-2`);
  readable = await agent(orgA, 'readable-p', 'ORGANIZATION');
  readable2 = await agent(orgA, 'readable-s', 'ORGANIZATION');
});

const noLeak = (json: string, ...who: Array<{ id: string; urn: string }>) => {
  for (const w of who) { expect(json).not.toContain(w.id); expect(json).not.toContain(w.urn); }
  expect(json).not.toContain(SENTINEL);
};

describe('App.agentId and installedAgentUrn answer as the Agent read does (#2640)', () => {
  it('hidden primary + readable secondary: agentId, agent and installedAgentUrn are null; agents is partial; appAgents keeps both entries', async () => {
    await install(hidden.id); await install(readable.id);
    const { data, json } = await read();
    expect(data.agentId).toBeNull(); // the PRIMARY, not the first readable
    expect(data.agent).toBeNull();
    expect(data.installedAgentUrn).toBeNull();
    expect(data.agents).toEqual([{ id: readable.id }]);
    expect(data.appAgents).toEqual([{ agent: null }, { agent: { id: readable.id } }]); // entry count unchanged
    noLeak(json, hidden);
  });

  it('hidden secondary + readable primary: the primary shows everywhere, the secondary nowhere', async () => {
    await install(readable.id); await install(hidden.id);
    const { data, json } = await read();
    expect(data.agentId).toBe(readable.id);
    expect(data.agent).toEqual({ id: readable.id });
    expect(data.installedAgentUrn).toBe(`hrn:agent:${readable.urn.split(':')[0]}:readable-p`);
    expect(data.agents).toEqual([{ id: readable.id }]);
    expect(data.appAgents).toEqual([{ agent: { id: readable.id } }, { agent: null }]);
    noLeak(json, hidden);
  });

  it('all hidden: every projection is empty or null, and the install count still shows', async () => {
    await install(hidden.id); await install(hidden2.id);
    const { data, json } = await read();
    expect(data).toEqual({ agentId: null, agent: null, agents: [], installedAgentUrn: null, appAgents: [{ agent: null }, { agent: null }] });
    noLeak(json, hidden, hidden2);
  });

  it('all readable: unchanged', async () => {
    await install(readable.id); await install(readable2.id);
    const { data } = await read();
    expect(data.agentId).toBe(readable.id);
    expect(data.agent).toEqual({ id: readable.id });
    expect(data.agents).toEqual([{ id: readable.id }, { id: readable2.id }]);
    expect(data.appAgents).toEqual([{ agent: { id: readable.id } }, { agent: { id: readable2.id } }]);
  });

  it('a PUBLIC foreign primary is readable, so agentId shows it', async () => {
    const pub = await agent(orgB, 'public-p', 'PUBLIC');
    await install(pub.id);
    expect((await read()).data.agentId).toBe(pub.id);
  });

  it('no install: null, never an error', async () => {
    const { data } = await read();
    expect(data).toEqual({ agentId: null, agent: null, agents: [], installedAgentUrn: null, appAgents: [] });
  });

  // Ticker.app and AppGrant.app load the App without `appAgents`, so readablePrimaryAgent re-fetches the primary.
  describe('re-fetch branch (parent carries no appAgents)', () => {
    const appResolvers = (resolvers as any).App;
    const parent = () => ({ id: app.id, urn: app.urn });

    it('hidden primary + readable secondary: agentId and installedAgentUrn are null, never the secondary', async () => {
      await install(hidden.id); await install(readable.id);
      expect(await appResolvers.agentId(parent(), {}, ctx(member.id))).toBeNull();
      expect(await appResolvers.installedAgentUrn(parent(), {}, ctx(member.id))).toBeNull();
    });

    it('readable primary: the control returns the primary, not the secondary', async () => {
      await install(readable.id); await install(readable2.id);
      expect(await appResolvers.agentId(parent(), {}, ctx(member.id))).toBe(readable.id);
      expect(await appResolvers.installedAgentUrn(parent(), {}, ctx(member.id))).toBe(`hrn:agent:${readable.urn.split(':')[0]}:readable-p`);
    });
  });

  it('the App itself stays unreadable to a non-participant; no Agent id rides along', async () => {
    await install(hidden.id); await install(readable.id);
    const res = await server.executeOperation({ query: QUERY, variables: { ref: app.urn } }, { contextValue: ctx(outsider.id) });
    if (res.body.kind !== 'single') throw new Error('unexpected');
    const out = JSON.stringify(res.body.singleResult);
    expect(res.body.singleResult.data?.app ?? null).toBeNull();
    noLeak(out, hidden, readable);
  });
});
