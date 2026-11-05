/** #3403: NUL-only LIST hardening after admission, on real GraphQL/MCP adapters. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { createMcpServerInstance } from '../../../mcp/server.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn(async () => {}) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
beforeAll(() => server.start());
afterAll(() => server.stop());
const instruction = { kind: 'LIVE_CHAT', ref: 'synthetic3403:turn' };
const nul = 'unknown\u0000trigger';
let f: Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const holder = await db.user.create({ data: { handle: 'nul3403-holder', roles: ['READER'] } });
  const stranger = await db.user.create({ data: { handle: 'nul3403-stranger', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Nul3403', urn: 'nul3403.test' } });
  const app = await db.app.create({ data: { name: 'A', urn: 'nul3403.test:a', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { name: 'Caller', urn: 'nul3403.test:caller', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, name: 'Caller', slug: 'caller', appId: app.id, agentId: agent.id, heldByUserId: holder.id } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: 'hrn:node:nul3403.test:flows:entry' } });
  const grant = (revoked: boolean, second: number) => db.appAutomationTeamSnapshotGrant.create({ data: {
    appId: app.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, grantedBy: holder.id,
    createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, second)),
    ...(revoked ? { revokedAt: new Date('2025-02-01'), revokedBy: holder.id } : {}),
  } });
  const ended = await grant(true, 0), live = await grant(false, 1);
  return { holder, stranger, app, session, schedule, ended, live };
}
beforeEach(async () => { await cleanDb(db); f = await fixture(); });
const snapshot = async () => ({
  grants: await db.appAutomationTeamSnapshotGrant.findMany({ orderBy: { id: 'asc' } }),
  grantEvents: await db.appAutomationTeamSnapshotGrantEvent.findMany({ orderBy: { id: 'asc' } }),
  teamEvents: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
});
async function invoke(surface: 'graphql' | 'mcp', worker: boolean, filter: Record<string, unknown>, userId = f.holder.id) {
  const claim = worker ? { instruction } : {};
  const context: Context = { db, userId, roles: ['READER'], ...(worker ? { sessionId: f.session.id } : {}) };
  if (surface === 'graphql') {
    const result = await server.executeOperation({
      query: 'query($app:ID!,$kind:String,$id:ID,$instruction:ActInstructionInput,$revoked:Boolean,$limit:Int,$offset:Int){automationTeamSnapshotGrants(appRef:$app,triggerKind:$kind,triggerId:$id,instruction:$instruction,includeRevoked:$revoked,limit:$limit,offset:$offset){items{id} total hasMore}}',
      variables: { app: f.app.id, kind: filter.triggerKind, id: filter.triggerId, revoked: filter.includeRevoked, limit: filter.limit, offset: filter.offset, ...claim },
    }, { contextValue: context });
    if (result.body.kind !== 'single') throw Error('incremental result');
    const body = result.body.singleResult;
    if (body.errors?.length) return { error: { code: body.errors[0].extensions?.code, message: body.errors[0].message } };
    return { data: body.data!.automationTeamSnapshotGrants as any };
  }
  // Production server registration includes the global fault boundary omitted by bare tool registration.
  const mcp = createMcpServerInstance({ userId, roles: ['READER'], appId: f.app.id, clientId: 'github:synthetic3403', ...(worker ? { sessionId: f.session.id } : {}) } as never, () => undefined, { kind: 'multi-app' });
  const client = new Client({ name: 'nul3403', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(b); await client.connect(a);
    const result: any = await client.callTool({ name: 'hadron_list_automation_team_snapshot_grants', arguments: { app: f.app.id, ...filter, ...claim } });
    if (result.isError) {
      const structured = result.structuredContent?.error;
      if (structured) return { error: { code: structured.code, message: structured.message } };
      const text = result.content?.[0]?.text ?? '';
      const match = /^\[([^\]]+)\]\s*(.*)$/s.exec(text);
      return { error: { code: match?.[1].toUpperCase(), message: match?.[2] ?? text } };
    }
    return { data: JSON.parse(result.content[0].text) };
  } finally { await client.close(); await mcp.close(); }
}
for (const surface of ['graphql', 'mcp'] as const) for (const worker of [false, true]) {
  const label = `${surface} ${worker ? 'instructed manager' : 'person manager'}`;
  it(`${label}: NUL refuses BAD_USER_INPUT with zero events or grant writes`, async () => {
    const before = await snapshot();
    const result = await invoke(surface, worker, { triggerKind: 'SCHEDULE', triggerId: nul });
    expect(result.error?.code).toBe('BAD_USER_INPUT');
    expect(await snapshot()).toEqual(before);
  });
  it(`${label}: unauthorized same NUL keeps FORBIDDEN before validation`, async () => {
    if (worker) await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
    const userId = worker ? f.holder.id : f.stranger.id;
    const before = await snapshot();
    const baseline = await invoke(surface, worker, { triggerKind: 'SCHEDULE', triggerId: f.schedule.id }, userId);
    expect(baseline.error?.code).toBe('FORBIDDEN');
    expect(await invoke(surface, worker, { triggerKind: 'SCHEDULE', triggerId: nul }, userId)).toEqual(baseline);
    expect(await snapshot()).toEqual(before);
  });
  it(`${label}: ordinary/unknown/page/count and other control characters unchanged`, async () => {
    const filter = { triggerKind: 'SCHEDULE', triggerId: f.schedule.id, includeRevoked: true, limit: 1 };
    expect((await invoke(surface, worker, filter)).data).toMatchObject({ items: [{ id: f.ended.id }], total: 2, hasMore: true });
    expect((await invoke(surface, worker, { ...filter, offset: 1 })).data).toMatchObject({ items: [{ id: f.live.id }], total: 2, hasMore: false });
    expect((await invoke(surface, worker, { ...filter, limit: 0 })).data).toEqual({ items: [], total: 2, hasMore: true });
    for (const triggerId of ['unknown', 'x\ny', 'x\ty', 'x\u0001y']) {
      expect((await invoke(surface, worker, { triggerKind: 'SCHEDULE', triggerId })).data).toEqual({ items: [], total: 0, hasMore: false });
    }
    expect(await db.agentTeamEvent.count()).toBe(worker ? 7 : 0);
    const before = await snapshot();
    expect((await invoke(surface, worker, { triggerKind: 'MANUAL', triggerId: 'normal' })).error?.code).toBe('BAD_USER_INPUT');
    expect((await invoke(surface, worker, { triggerId: 'missing-kind' })).error?.code).toBe('BAD_USER_INPUT');
    expect(await snapshot()).toEqual(before);
  });
}
