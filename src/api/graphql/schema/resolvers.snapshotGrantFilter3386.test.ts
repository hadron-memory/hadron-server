/** #3386: narrowing trigger filters, authority-first on both call paths. */
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { registerAutomationTeamSnapshotGrantTools } from '../../../mcp/automationTeamSnapshotGrantTools.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start()); afterAll(() => server.stop());
let f: any;
const instruction = { kind: 'LIVE_CHAT', ref: 'synthetic3386:turn' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const list = (args: Record<string, unknown> = {}, c = ctx()) => Q.automationTeamSnapshotGrants({}, { appRef: f.app.id, ...args }, c);
const refusal = async (p: Promise<unknown>) => { try { await p; return { code: 'RESOLVED', message: '' }; } catch (e: any) { return { code: e.extensions?.code, message: e.message }; } };
const events = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id } });
beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'filter-holder', roles: ['READER'] } });
  const stranger = await db.user.create({ data: { handle: 'filter-stranger', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Filter', urn: 'filter3386.test' } });
  const app = await db.app.create({ data: { name: 'A', urn: org.urn + ':a', organizationId: org.id } });
  const other = await db.app.create({ data: { name: 'B', urn: org.urn + ':b', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { name: 'Caller', urn: org.urn + ':agent', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, name: 'Caller', slug: 'caller', appId: app.id, agentId: agent.id, heldByUserId: holder.id } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const schedule = async (appId: string) => db.agentSchedule.create({ data: { organizationId: org.id, appId, name: 'S', cron: '* * * * *', entryNodeUrn: 'hrn:node:filter3386.test:flows:entry' } });
  const one = await schedule(app.id), two = await schedule(app.id), foreign = await schedule(other.id);
  const grant = (appId: string, triggerId: string, revoked: boolean, i: number, triggerKind = 'SCHEDULE') => db.appAutomationTeamSnapshotGrant.create({ data: {
    appId, triggerKind, triggerId, grantedBy: holder.id, createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
    ...(revoked ? { revokedAt: new Date('2025-02-01'), revokedBy: holder.id } : {}),
  } });
  const ended = await grant(app.id, one.id, true, 0), live = await grant(app.id, one.id, false, 1);
  const unrelated = await grant(app.id, two.id, false, 2);
  const webhook = await grant(app.id, generateId(), false, 3, 'WEBHOOK');
  await grant(other.id, foreign.id, true, 4); await grant(other.id, foreign.id, false, 5);
  f = { holder, stranger, org, app, other, worker, session, one, two, foreign, ended, live, unrelated, webhook };
});

it('filters before count/paging, preserves oldest-first projection and accepts kind-only', async () => {
  const args = { triggerKind: 'SCHEDULE', triggerId: f.one.id };
  expect(await list(args)).toEqual({ items: [f.live], total: 1, hasMore: false });
  expect(await list({ ...args, includeRevoked: true, limit: 1 })).toEqual({ items: [f.ended], total: 2, hasMore: true });
  expect(await list({ ...args, includeRevoked: true, limit: 1, offset: 1 })).toEqual({ items: [f.live], total: 2, hasMore: false });
  expect(await list({ ...args, includeRevoked: true, limit: 0 })).toEqual({ items: [], total: 2, hasMore: true });
  expect(await list({ triggerKind: 'WEBHOOK' })).toEqual({ items: [f.webhook], total: 1, hasMore: false });
  expect(await list()).toEqual({ items: [f.live, f.unrelated, f.webhook], total: 3, hasMore: false });
});

for (const includeRevoked of [false, true]) it('unknown and foreign trigger pages are byte-identical, includeRevoked=' + includeRevoked, async () => {
  const unknown = await list({ triggerKind: 'SCHEDULE', triggerId: generateId(), includeRevoked });
  const foreign = await list({ triggerKind: 'SCHEDULE', triggerId: f.foreign.id, includeRevoked });
  expect(unknown).toEqual({ items: [], total: 0, hasMore: false });
  expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
});

for (const worker of [false, true]) it('authority precedes filter validation and existence on ' + (worker ? 'instructed' : 'person') + ' path', async () => {
  if (worker) await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
  const c = worker ? ctx({ sessionId: f.session.id }) : ctx({ userId: f.stranger.id });
  const claim = worker ? { instruction } : {};
  const baseline = await refusal(list(claim, c));
  expect(baseline.code).not.toBe('RESOLVED');
  for (const filter of [
    { triggerKind: 'SCHEDULE', triggerId: f.one.id }, { triggerKind: 'SCHEDULE', triggerId: generateId() },
    { triggerKind: 'SCHEDULE', triggerId: f.foreign.id }, { triggerKind: 'MANUAL', triggerId: f.one.id },
    { triggerId: f.one.id },
  ]) expect(await refusal(list({ ...filter, ...claim }, c))).toEqual(baseline);
  expect(await events()).toHaveLength(0);
});

for (const args of [{ triggerKind: 'MANUAL' }, { triggerKind: '' }, { triggerId: 'missing-kind' }]) it('bad filter is a stable bad argument: ' + JSON.stringify(args), async () => {
  const a = await refusal(list({ ...args, triggerId: f.one.id }));
  const b = await refusal(list({ ...args, triggerId: f.foreign.id }));
  const c = await refusal(list({ ...args, triggerId: generateId() }));
  expect(a.code).toBe('BAD_USER_INPUT'); expect(b).toEqual(a); expect(c).toEqual(a);
  expect(await events()).toHaveLength(0);
});

it('instructed filtered lists each record exactly one event, including empty pages; refused calls none', async () => {
  const c = ctx({ sessionId: f.session.id });
  expect((await list({ triggerKind: 'SCHEDULE', triggerId: f.one.id, instruction }, c)).items).toEqual([f.live]);
  expect(await events()).toHaveLength(1);
  expect(await list({ triggerKind: 'SCHEDULE', triggerId: f.foreign.id, instruction }, c)).toEqual({ items: [], total: 0, hasMore: false });
  expect(await events()).toHaveLength(2);
  expect((await refusal(list({ triggerKind: 'MANUAL', instruction }, c))).code).toBe('BAD_USER_INPUT');
  expect(await events()).toHaveLength(2);
  expect((await refusal(list({ triggerKind: 'SCHEDULE', triggerId: f.one.id }, c))).code).not.toBe('RESOLVED');
  expect(await events()).toHaveLength(2);
});

it('GraphQL and MCP expose the same filters and page, for person and instructed calls', async () => {
  for (const worker of [false, true]) {
    const claim = worker ? instruction : undefined;
    const context = worker ? ctx({ sessionId: f.session.id }) : ctx();
    const variables = { app: f.app.id, kind: 'SCHEDULE', id: f.one.id, instruction: claim };
    const result = await server.executeOperation({ query: 'query($app:ID!,$kind:String,$id:ID,$instruction:ActInstructionInput){automationTeamSnapshotGrants(appRef:$app,triggerKind:$kind,triggerId:$id,includeRevoked:true,instruction:$instruction){items{id appId triggerKind triggerId grantedBy revokedBy createdAt revokedAt} total hasMore}}', variables }, { contextValue: context });
    if (result.body.kind !== 'single') throw new Error('incremental');
    expect(result.body.singleResult.errors).toBeUndefined();
    const mcp = new McpServer({ name: 'filter3386', version: '1' });
    registerAutomationTeamSnapshotGrantTools(mcp, { db, auth: { userId: f.holder.id, roles: ['READER'], ...(worker ? { sessionId: f.session.id } : {}) } as any });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(a); await client.connect(b);
      const response: any = await client.callTool({ name: 'hadron_list_automation_team_snapshot_grants', arguments: { app: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.one.id, includeRevoked: true, ...(worker ? { instruction } : {}) } });
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual(JSON.parse(JSON.stringify(result.body.singleResult.data!.automationTeamSnapshotGrants)));
    } finally { await client.close(); await mcp.close(); }
  }
  expect(await events()).toHaveLength(2);
});
