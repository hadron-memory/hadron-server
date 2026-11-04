/**
 * #3435 (companion to #2168; cor:dmo:050:03/:06/:11): how each agent is installed in an App, on the App's agent
 * surfaces. The lifecycle pins (createdAt, uninstall, register rows) live in resolvers.derivedInstallLifecycle2168.test.ts (#3443).
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
const M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
const T = (n: number) => new Date(Date.UTC(2026, 0, n));
let user: { id: string }, org: { id: string }, app: { id: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });
const agent = (name: string) => M.createAgent({}, { orgId: org.id, name, personaRole: name.toLowerCase() }, ctx());
async function grant(agentId: string) {
  await db.agentOrgGrant.upsert({
    where: { orgId_agentId: { orgId: org.id, agentId } },
    create: { orgId: org.id, agentId, activatedAt: new Date(), revokedAt: null },
    update: { activatedAt: new Date(), revokedAt: null },
  });
}
async function importEdge(parentId: string, childId: string, createdAt: Date) {
  await grant(childId);
  return db.agentImport.create({
    data: { parentAgentId: parentId, importedAgentId: childId, position: 100, required: true, agentOrgGrantOrgId: org.id, agentOrgGrantAgentId: childId, createdAt },
  });
}


beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Install method', urn: `im-${generateId().toLowerCase()}.example` } });
  user = await db.user.create({ data: { handle: `im-${generateId()}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Install method', urn: `im-${generateId().toLowerCase()}.example:team` } });
});

// ── the wire shape (SDL ruling A: one public field pair, gated on the WHOLE App) ──
const ROSTER = `query($ref: ID!) { app(ref: $ref) { appAgents {
  installMethod importer { id } agent { id }
  bootPromptRef bootPromptTargetDeleted bootPromptServe { served { pointerLevel } refusal }
  createdAt createdBy updatedAt updatedBy } } }`;
async function wire(query: string, variables: Record<string, unknown> = {}, as: Context = ctx()) {
  const res = await server.executeOperation({ query, variables }, { contextValue: as });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return res.body.singleResult;
}
async function rosterWire(as: Context = ctx()) {
  const out = await wire(ROSTER, { ref: app.id }, as);
  expect(out.errors).toBeUndefined();
  const rows = (out.data as any).app.appAgents as any[];
  // AppAgent has no agentId field (it would name a withheld entry): readable entries are found by agent.id,
  // the withheld ones are the entries whose agent is null.
  return { rows, by: (id: string) => rows.find((r) => r.agent?.id === id), withheld: () => rows.filter((r) => r.agent === null) };
}
/** An Agent in ANOTHER org, visible only to that org: this caller (a member of the App's org only) cannot read it. */
async function foreignAgent(name: string) {
  const other = await db.organization.create({ data: { name: `Other ${name}`, urn: `other-${generateId().toLowerCase()}.example` } });
  const a = await db.agent.create({ data: { id: generateId(), organizationId: other.id, name, urn: `${other.urn}:${name.toLowerCase()}`, visibility: 'ORGANIZATION' } });
  return { org: other, agent: a };
}

it('the GraphQL shape: AppAgent.installMethod is a nullable InstallMethod {ROW, DERIVED}; importer is a nullable Agent', async () => {
  const out = await wire(`{ a: __type(name: "AppAgent") { fields { name type { kind name ofType { name } } } } e: __type(name: "InstallMethod") { enumValues { name } } }`);
  expect(out.errors).toBeUndefined();
  const fields = new Map(((out.data as any).a.fields as any[]).map((f) => [f.name, f.type]));
  expect(fields.get('installMethod')).toMatchObject({ kind: 'ENUM', name: 'InstallMethod' }); // nullable: not NON_NULL
  expect(fields.get('importer')).toMatchObject({ kind: 'OBJECT', name: 'Agent' });
  expect(((out.data as any).e.enumValues as any[]).map((v) => v.name).sort()).toEqual(['DERIVED', 'ROW']);
});

// Ruling A (Xan 6632122086, Riana's §10 condition): the one public field is the gated pair. #3443's ungated, non-null
// installationKind must not reach main next to it; the lib-internal installationKind stays (casting). This pin is red on
// a branch that still carries #3443's SDL field and goes green when #3443's drop is merged into this stack.
it('the public AppAgent type has no ungated per-entry install kind (#3443 drops installationKind / AppAgentInstallationKind)', async () => {
  const out = await wire(`{ a: __type(name: "AppAgent") { fields { name } } k: __type(name: "AppAgentInstallationKind") { name } }`);
  expect(out.errors).toBeUndefined();
  expect(((out.data as any).a.fields as any[]).map((f) => f.name)).not.toContain('installationKind');
  expect((out.data as any).k).toBeNull();
});

it('all installed Agents readable: ROW and DERIVED with the importer; the derived entry has no row-audit identity and the Agent-arm prompt', async () => {
  const [a, b] = [await agent('Alpha'), await agent('Beta')];
  await serveAgentBootPrompt(db, b.id, 'BETA PROMPT');
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdBy: user.id } });
  await importEdge(a.id, b.id, T(2));
  const r = await rosterWire();
  expect(r.by(a.id)).toMatchObject({ installMethod: 'ROW', importer: null });
  const d = r.by(b.id);
  expect(d).toMatchObject({ installMethod: 'DERIVED', importer: { id: a.id }, agent: { id: b.id }, createdBy: null, updatedAt: null, updatedBy: null, bootPromptRef: null, bootPromptTargetDeleted: null });
  expect(d.bootPromptServe).toMatchObject({ served: { pointerLevel: 'AGENT' }, refusal: null });
  expect(d.createdAt).toBeTruthy();
});

it('withheld (B readable, its only importer A unreadable): installMethod and importer are null on B AND on every ROW entry; agent: null for A', async () => {
  const f = await foreignAgent('Hidden');
  const b = await agent('Beta');
  const rowOnly = await agent('Gamma');
  await db.appAgent.create({ data: { appId: app.id, agentId: f.agent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: rowOnly.id } });
  await grant(b.id);
  await db.agentImport.create({ data: { parentAgentId: f.agent.id, importedAgentId: b.id, position: 100, required: true, agentOrgGrantOrgId: org.id, agentOrgGrantAgentId: b.id, createdAt: T(2) } });
  const r = await rosterWire();
  expect(r.rows).toHaveLength(3);
  expect(r.withheld()).toEqual([expect.objectContaining({ agent: null, installMethod: null, importer: null })]);
  expect(r.by(b.id)).toMatchObject({ agent: { id: b.id }, installMethod: null, importer: null });
  expect(r.by(rowOnly.id)).toMatchObject({ agent: { id: rowOnly.id }, installMethod: null, importer: null });
});

it('control: an unreadable installed Agent that imports nothing also nulls every entry (the null is App-wide, never keyed to edges)', async () => {
  const f = await foreignAgent('Hidden');
  const readable = await agent('Alpha');
  await db.appAgent.create({ data: { appId: app.id, agentId: f.agent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: readable.id } });
  const r = await rosterWire();
  expect(r.rows).toHaveLength(2);
  for (const row of r.rows) expect(row).toMatchObject({ installMethod: null, importer: null });
  expect(r.withheld()).toHaveLength(1);
});

// P3 pins (Andi, Dorian): a non-App.appAgents route to an AppAgent answers null for the pair; the withheld read shares one time.
it('a non-roster route to an AppAgent (installAgentIntoApp payload) answers installMethod and importer null', async () => {
  const a = await agent('Alpha');
  const out = await wire(`mutation($appRef: ID!, $agentRef: ID!) { installAgentIntoApp(appRef: $appRef, agentRef: $agentRef) { appAgent { installMethod importer { id } } } }`,
    { appRef: app.id, agentRef: a.id });
  expect(out.errors).toBeUndefined();
  expect((out.data as any).installAgentIntoApp.appAgent).toEqual({ installMethod: null, importer: null });
});

it('multiple importers: the derived entry names the earliest witness, and a withheld read shows every entry the same App createdAt', async () => {
  const [a, c, b] = [await agent('Alpha'), await agent('Gamma'), await agent('Beta')];
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdAt: T(3) } });
  await db.appAgent.create({ data: { appId: app.id, agentId: c.id, createdAt: T(5) } });
  await importEdge(a.id, b.id, T(2));
  await importEdge(c.id, b.id, T(6));
  const full = await rosterWire();
  expect(full.by(b.id)).toMatchObject({ installMethod: 'DERIVED', importer: { id: a.id } });
  expect(new Date(full.by(b.id).createdAt).getTime()).toBe(T(3).getTime()); // earliest of (importer install, import) over importers
  const f = await foreignAgent('Hidden');
  await db.appAgent.create({ data: { appId: app.id, agentId: f.agent.id } });
  const part = await rosterWire();
  const times = new Set(part.rows.map((r) => new Date(r.createdAt).getTime()));
  expect(times.size).toBe(1);
});

// g5b/g6b (Xan A3.2 split, Riana P3): the Agent-side route to an AppAgent never serves the pair, ROW or DERIVED, whole App readable.
it('Agent.appAgents answers installMethod null and importer null for ROW and DERIVED rows even when the whole App is readable', async () => {
  const [a, b] = [await agent('Alpha'), await agent('Beta')];
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdBy: user.id } });
  await importEdge(a.id, b.id, T(2));
  const roster = await rosterWire();
  expect(roster.by(b.id)).toMatchObject({ installMethod: 'DERIVED', importer: { id: a.id } }); // the App route does serve it
  for (const id of [a.id, b.id]) {
    const out = await wire(`query($ref: ID!) { agent(ref: $ref) { appAgents { installMethod importer { id } } } }`, { ref: id });
    expect(out.errors).toBeUndefined();
    const rows = (out.data as any).agent.appAgents as any[];
    for (const row of rows) expect(row).toEqual({ installMethod: null, importer: null });
  }
});
