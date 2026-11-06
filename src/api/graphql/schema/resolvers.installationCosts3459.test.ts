/** #3459 diagnostic slice: no source optimization; explicitly approved per-shape ceilings.
 * The logged client belongs only to this file/run's disposable database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import * as installs from '../../../lib/appInstallations.js';
import { locateTeamAgent } from '../../../lib/auth/workerRead.js';
import { writeFileSync } from 'node:fs';
import approved from '../../../test/fixtures/installationCosts3459.approved.json';
import originalObserved from '../../../test/fixtures/installationCosts3459.observed.json';
import distinctObserved from '../../../test/fixtures/installationCosts3459.distinct-observed.json';
import { PARALLEL_DBS, workerDbName } from '../../../test/dbWorkers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
let active = false;
let sql: string[] = [];
let operations: string[] = [];
let projectedPageReads = 0;
let responseBytes = 0;
let graphqlOperations = 0;
logged.$on('query', event => { if (active) sql.push(event.query); });
const measured = logged.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
  if (active) {
    operations.push(`${model}.${operation}`);
    if (model === 'App' && operation === 'findMany' && (args as any)?.select?.appAgents) projectedPageReads++;
  }
  return query(args);
} } } });
const server = new ApolloServer<Context>({ typeDefs, resolvers });
const helpers = [
  vi.spyOn(installs, 'listAppInstallations'),
  vi.spyOn(installs, 'loadAppInstallationPage'),
  vi.spyOn(installs, 'resolveAppInstallation'),
];
const table: any[] = [];
let userId: string, fullUserId: string, orgId: string, vendorId: string, orgUrn: string;
let apps: string[] = [], agents: any[] = [];
const context = (full = false, appId?: string): Context => ({ db: measured as any, userId: full ? fullUserId : userId, roles: full ? ['ADMIN'] : ['READER'], ...(appId ? { appId, organizationId: orgId } : {}) });
const audit = 'agent{id} createdAt createdBy updatedAt updatedBy';
const appQuery = (ids: string[], fields: string) => `query{${ids.map((id, i) => `a${i}:app(ref:"${id}"){${fields}}`).join(' ')}}`;
const toData = (response: any) => {
  expect(response.body.kind).toBe('single');
  const result = response.body.singleResult;
  expect(result.errors).toBeUndefined();
  return result.data;
};
async function barrier() {
  await logged.$queryRaw`SELECT 'installation-cost-3459-log-barrier'`;
  await vi.waitFor(() => expect(sql.some(q => q.includes('installation-cost-3459-log-barrier'))).toBe(true));
}
async function measure(label: string, run: () => Promise<any>, rows: (data: any) => number) {
  // Setup is complete before the event span; no process-global query listener.
  for (const helper of helpers) helper.mockClear();
  sql = []; operations = []; projectedPageReads = 0; responseBytes = 0; graphqlOperations = 0; active = true;
  let data: any;
  try { data = await run(); await barrier(); }
  finally { active = false; }
  const statements = sql.filter(q => !q.includes('installation-cost-3459-log-barrier'));
  expect(statements.length, 'positive SQL discriminator').toBeGreaterThan(0);
  expect(operations.length, 'positive Prisma-operation discriminator').toBeGreaterThan(0);
  const out = { label, sqlCount: statements.length, prismaOperations: operations.length,
    pagePrismaReads: projectedPageReads, helperEntries: helpers.map(h => h.mock.calls.length),
    apiRequests: graphqlOperations, projectedRows: rows(data), responseUtf8Bytes: graphqlOperations ? responseBytes : null,
    operations: [...operations], sql: statements, data };
  table.push(out); // Retain even the failing observation for diagnostics.
  const ceiling = approved.metrics.find(row => row.label === label);
  expect(ceiling, `${label}: explicitly approved shape`).toBeDefined();
  if (ceiling) { // Explicit narrowing for TypeScript after the runtime assertion.
    for (const metric of ['sqlCount', 'prismaOperations', 'pagePrismaReads'] as const)
      expect(out[metric], `${label}: approved ${metric} ceiling`).toBeLessThanOrEqual(ceiling[metric]);
    if (ceiling.pagePrismaReads > 0) expect(out.pagePrismaReads, `${label}: positive page instrumentation`).toBeGreaterThan(0);
    out.helperEntries.forEach((entries, i) => {
      expect(entries, `${label}: approved helper ${i} ceiling`).toBeLessThanOrEqual(ceiling.helperEntries[i]);
      if (ceiling.helperEntries[i] > 0) expect(entries, `${label}: positive helper ${i} instrumentation`).toBeGreaterThan(0);
    });
    expect(out.apiRequests, `${label}: exact GraphQL operations`).toBe(ceiling.apiRequests);
    expect(out.projectedRows, `${label}: exact semantic rows`).toBe(ceiling.projectedRows);
    if (ceiling.responseUtf8Bytes === null) expect(out.responseUtf8Bytes).toBeNull();
    else expect(out.responseUtf8Bytes, `${label}: approved response byte ceiling`).toBeLessThanOrEqual(ceiling.responseUtf8Bytes);
  }
  return out;
}
const wire = async (query: string, ctx: Context) => {
  if (active) graphqlOperations++;
  const response = await server.executeOperation({ query }, { contextValue: ctx });
  if (response.body.kind === 'single' && active) responseBytes += Buffer.byteLength(JSON.stringify(response.body.singleResult), 'utf8');
  return toData(response);
};

async function addApp(index: number) {
  const app = await db.app.create({ data: { name: `App ${index}`, urn: `${orgUrn}:app${index}`, organizationId: orgId, createdAt: new Date('2026-01-01') } });
  apps.push(app.id);
  for (let j = 0; j < 2; j++) await db.appAgent.create({ data: { appId: app.id, agentId: agents[j].id,
    createdAt: new Date(`2026-01-0${j + 2}`), createdBy: userId, updatedBy: userId } });
}

beforeAll(async () => {
  // The shared harness stamps the run scope and creates this exact worker clone.
  // Check BOTH connected clients before cleanDb; a URL denylist is not ownership.
  expect(PARALLEL_DBS, 'diagnostic requires a run-owned parallel worker clone').toBe(true);
  const expected = workerDbName(process.env.VITEST_POOL_ID ?? '1');
  expect(new URL(process.env.DATABASE_URL!).pathname).toBe(`/${expected}`);
  const fixtureDb = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const measuredDb = await logged.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  expect(fixtureDb[0]?.name, 'fixture connected DB must be this run worker clone').toBe(expected);
  expect(measuredDb[0]?.name, 'measured connected DB must be this run worker clone').toBe(expected);
  await cleanDb(db);
  const key = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'Cost holder', urn: `cost-${key}.example` } }); orgId = org.id; orgUrn = org.urn;
  const vendor = await db.organization.create({ data: { name: 'Cost vendor', urn: `vendor-${key}.example` } }); vendorId = vendor.id;
  userId = (await db.user.create({ data: { handle: `cost-${key}`, roles: ['READER'] } })).id;
  fullUserId = (await db.user.create({ data: { handle: `cost-full-${key}`, roles: ['ADMIN'] } })).id;
  expect(fullUserId).not.toBe(userId);
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
  for (let i = 0; i < 4; i++) {
    const organizationId = i % 2 ? vendorId : orgId;
    const sys = await db.memory.create({ data: { name: `System ${i}`, urn: `${org.urn}:sys${i}`, class: 'system', organizationId } });
    agents.push(await db.agent.create({ data: { name: `Agent ${i}`, urn: `${org.urn}:agent${i}`, organizationId,
      visibility: 'ORGANIZATION', personaRole: `role${i}`, systemMemoryId: sys.id, description: 'x'.repeat(4096) } }));
    await db.node.create({ data: { memoryId: sys.id, loc: 'roles', name: 'Roles', content: 'Roles' } });
    await db.node.create({ data: { memoryId: sys.id, loc: `roles:role${i}`, name: `Role ${i}`, content: `Role ${i}` } });
  }
  for (const org of [orgId, vendorId]) for (const agent of [agents[2], agents[3]]) await createDbAgentOrgGrant(db, org, agent.id);
  await createDbAgentImport(db, agents[0].id, agents[2].id, { position: 100 });
  await createDbAgentImport(db, agents[0].id, agents[3].id, { position: 200 });
  await createDbAgentImport(db, agents[1].id, agents[2].id, { position: 100 }); // duplicate derived witness
  await addApp(0);
  // Flush pre-span client startup independently; its listener is disabled here.
  await logged.$connect();
});
afterAll(async () => {
  active = false;
  try {
  if (process.env.HADRON_3459_ARTIFACT) writeFileSync(process.env.HADRON_3459_ARTIFACT, JSON.stringify({
    sourceHead: process.env.HADRON_3459_HEAD ?? 'working-tree', metricDefinitions: {
      sqlCount: 'dedicated-client query events excluding named barrier, measured span only',
      prismaOperations: 'dedicated-client model query-extension entries, raw barrier excluded',
      pagePrismaReads: 'App.findMany with select.appAgents; NOT SQL count',
      helperEntries: 'exported listAppInstallations/loadAppInstallationPage/resolveAppInstallation spy entries; same-module direct calls may not cross spies',
      responseUtf8Bytes: 'UTF8 JSON singleResult including data envelope, not DB wire bytes; API request means in-process GraphQL operation, not HTTP',
    }, table,
  }, null, 2));
    // Whole-file execution is required: neither a missing shape nor a removed
    // shape+ceiling may silently reduce the stamped 53+2 coverage.
    expect(table, 'all 55 selected diagnostic shapes were measured').toHaveLength(55);
    expect(approved.metrics, 'all 55 selected ceilings remain present').toHaveLength(55);
    const observed = [...originalObserved.metrics, ...distinctObserved.metrics].map(row => ({ ...row,
      label: row.label.replace('importedBy/1-parents', 'importedBy/one-Agent-1-aliases').replace('importedBy/3-parents', 'importedBy/one-Agent-3-aliases'),
    }));
    expect([...approved.metrics].sort((a, b) => a.label.localeCompare(b.label)), 'approved original observations remain unchanged').toEqual(observed.sort((a, b) => a.label.localeCompare(b.label)));
    expect(table.map(row => row.label).sort(), 'measured and approved label sets').toEqual(approved.metrics.map(row => row.label).sort());
  } finally {
    try { await server.stop(); }
    finally { try { await logged.$disconnect(); } finally { vi.restoreAllMocks(); } }
  }
});

describe('#3459 owned-client fixed roster diagnostics', () => {
  it('captures A=1/A=3 reader shapes and repeated/fresh Context controls against explicitly approved ceilings', async () => {
    for (const count of [1, 3]) {
      while (apps.length < count) await addApp(apps.length);
      const ids = apps.slice(0, count);
      for (const [name, fields] of [['agents', 'agents{id}'], ['audits', `appAgents{${audit}}`],
        ['siblings', `agents{id} appAgents{${audit}}`]] as const) {
        for (const full of [false, true]) {
          const ctx = context(full);
          for (const phase of ['cold', 'same-context-repeat', 'fresh-context']) {
            const out = await measure(`A${count}/${name}/${full ? 'full' : 'partial'}/${phase}`,
              () => wire(appQuery(ids, fields), phase === 'fresh-context' ? context(full) : ctx),
              data => Object.values(data).reduce((n: number, app: any) => n + (app.agents?.length ?? 0) + (app.appAgents?.length ?? 0), 0));
            expect(Object.keys(out.data)).toHaveLength(count);
            for (const app of Object.values(out.data) as any[]) {
              if (app.appAgents) {
                expect(app.appAgents).toHaveLength(4);
                if (!full) for (const row of app.appAgents) expect(row).toMatchObject({ createdAt: new Date('2026-01-01').toISOString(), createdBy: null, updatedAt: null, updatedBy: null });
                else expect(app.appAgents.filter((r: any) => r.createdBy === userId)).toHaveLength(2);
              }
              if (app.agents) expect(app.agents.map((a: any) => a.id).sort()).toEqual((full ? agents : [agents[0], agents[2]]).map(a => a.id).sort());
            }
          }
        }
      }
      for (const full of [false, true]) {
        const q = `query{agent(ref:"${agents[2].id}"){appAgents{app{id} ${audit}}}}`;
        const out = await measure(`A${count}/reverse/${full ? 'full' : 'partial'}`, () => wire(q, context(full)), data => data.agent.appAgents.length);
        expect(out.data.agent.appAgents).toHaveLength(count);
      }
    }
    // One Agent selected through one/three aliases; not distinct roots or depth expansion.
    for (const count of [1, 3]) {
      const targets = Array.from({ length: count }, () => agents[2]); // repeated parent aliases expose repeated authorization work
      const query = `query{${targets.map((a, i) => `p${i}:agent(ref:"${a.id}"){importedBy{parentAgentId parentAgent{id}}}`).join(' ')}}`;
      const out = await measure(`importedBy/one-Agent-${count}-aliases`, () => wire(query, context(false, apps[0])),
        data => Object.values(data).reduce((n: number, a: any) => n + a.importedBy.length, 0));
      expect(out.data.p0.importedBy).toHaveLength(2);
      expect(out.data.p0.importedBy.map((row: any) => row.parentAgentId).sort()).toEqual([agents[0].id, agents[1].id].sort());
      expect(out.data.p0.importedBy.find((row: any) => row.parentAgentId === agents[1].id).parentAgent).toBeNull();
      if (count === 3) { expect(out.data.p1.importedBy).toHaveLength(2); expect(out.data.p2.importedBy).toHaveLength(2); }
    }
    for (const count of [1, 4]) {
      // Same exact Team Agent, one/four licensed Agents in its role walk.
      if (count === 1) {
        await db.agentImport.deleteMany({ where: { parentAgentId: { in: [agents[0].id, agents[1].id] } } });
        await db.appAgent.deleteMany({ where: { appId: apps[0], agentId: agents[1].id } });
      } else {
        await db.appAgent.create({ data: { appId: apps[0], agentId: agents[1].id } });
        await createDbAgentImport(db, agents[0].id, agents[2].id, { position: 100 });
        await createDbAgentImport(db, agents[0].id, agents[3].id, { position: 200 });
        await createDbAgentImport(db, agents[1].id, agents[2].id, { position: 100 });
      }
      expect(await installs.listAppInstallations(db, apps[0]), `role fixture has ${count} installed Agents`).toHaveLength(count);
      const out = await measure(`role-definition/${count}-agents`, () => wire(`query{teamRoles(appRef:"${apps[0]}",teamAgentRef:"${agents[0].id}"){items{role} total}}`, context(true)),
        data => data.teamRoles.items.length);
      expect(out.data.teamRoles).toEqual({ items: [{ role: 'role0' }], total: 1 });
      const marker = await measure(`role-marker/${count}-agents`, async () => {
        try { const agent = await locateTeamAgent(context(true), apps[0], null); return { agentId: agent.id, code: null }; }
        catch (error: any) { return { agentId: null, code: error.extensions?.code }; }
      }, data => data.agentId ? 1 : 0);
      expect(marker.data).toEqual(count === 1 ? { agentId: agents[0].id, code: null } : { agentId: null, code: 'TEAM_AGENT_AMBIGUOUS' });
    }
    for (const [kind, id] of [['ROW', agents[0].id], ['DERIVED', agents[2].id], ['absent', generateId()]] as const) {
      const out = await measure(`single/${kind}`, () => installs.resolveAppInstallation(measured as any, apps[0], id), data => data ? 1 : 0);
      expect(out.data?.installationKind ?? null).toBe(kind === 'absent' ? null : kind);
    }
    // Fresh partial-principal requests after each license change; opposing principals were measured above.
    const query = appQuery([apps[0]], `appAgents{${audit}}`);
    const before = await measure('grant/active/partial', () => wire(query, context(false)), data => data.a0.appAgents.length);
    expect(before.data.a0.appAgents).toHaveLength(4);
    for (const state of ['inactive', 'revoked', 'expired'] as const) {
      await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId, agentId: agents[3].id } }, data: {
        activatedAt: state === 'inactive' ? null : new Date('2026-01-01'), revokedAt: state === 'revoked' ? new Date('2026-01-01') : null,
        expiresAt: state === 'expired' ? new Date('2026-01-01') : null,
      } });
      const out = await measure(`grant/${state}/fresh`, () => wire(query, context(false)), data => data.a0.appAgents.length);
      expect(out.data.a0.appAgents).toHaveLength(3);
      expect(out.data.a0.appAgents.map((row: any) => row.agent?.id ?? null).sort()).toEqual([agents[0].id, agents[2].id, null].sort());
      for (const row of out.data.a0.appAgents) expect(row).toMatchObject({ createdAt: new Date('2026-01-01').toISOString(), createdBy: null, updatedAt: null, updatedBy: null });
    }
  }, 60000);
  it('records only the missing one/three DISTINCT readable parent-Agent baseline shapes', async () => {
    // Same four Agents and import witnesses. A full principal can read all three
    // distinct selected Agents independently of App-key/partial-reader audiences.
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId, agentId: agents[3].id } },
      data: { activatedAt: new Date('2026-01-01'), revokedAt: null, expiresAt: null } });
    for (const count of [1, 3]) {
      const targets = [agents[2], agents[3], agents[0]].slice(0, count);
      expect(new Set(targets.map(a => a.id)).size).toBe(count);
      const query = `query{${targets.map((a, i) => `p${i}:agent(ref:"${a.id}"){id importedBy{parentAgentId parentAgent{id}}}`).join(' ')}}`;
      const out = await measure(`importedBy/${count}-distinct-Agents/full`, () => wire(query, context(true, apps[0])),
        data => Object.values(data).reduce((n: number, a: any) => n + a.importedBy.length, 0));
      expect(Object.values(out.data).map((a: any) => a.id)).toEqual(targets.map(a => a.id));
      expect(out.data.p0.importedBy.map((r: any) => r.parentAgentId).sort()).toEqual([agents[0].id, agents[1].id].sort());
      expect(out.data.p0.importedBy.every((r: any) => r.parentAgent !== null)).toBe(true);
      if (count === 3) {
        expect(out.data.p1.importedBy.map((r: any) => r.parentAgentId)).toEqual([agents[0].id]);
        expect(out.data.p1.importedBy[0].parentAgent).toEqual({ id: agents[0].id });
        expect(out.data.p2.importedBy).toEqual([]);
      }
    }
  }, 60000);
});
