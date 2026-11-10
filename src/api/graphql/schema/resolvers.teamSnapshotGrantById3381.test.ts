/** #3381: person-only single-row metadata read; conceal all unauthorized ids, including revoked grants. */
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildSchema } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { requestActorStorage, runAsActor } from '../../../lib/requestActor.js';
import { registerAutomationTeamSnapshotGrantTools } from '../../../mcp/automationTeamSnapshotGrantTools.js';
import { createMcpServerInstance } from '../../../mcp/server.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn(async () => {}) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const FIELDS = 'id appId triggerKind triggerId grantedBy createdAt revokedAt revokedBy';
const QUERY = `query($id:ID!){automationTeamSnapshotGrant(id:$id){${FIELDS}}}`;
const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
beforeAll(() => server.start());
afterAll(() => server.stop());
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const user = () => db.user.create({ data: { handle: `read-${generateId()}`, roles: ['READER'] } });
  const [admin, owner, member, outsider, personalOwner] = await Promise.all([user(), user(), user(), user(), user()]);
  const org = await db.organization.create({ data: { name: 'Read3381', urn: 'read3381.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Team', urn: 'read3381.test:team', organizationId: org.id } });
  const otherApp = await db.app.create({ data: { name: 'Foreign', urn: 'read3381.test:foreign', ownerUserId: outsider.id } });
  await db.appMember.createMany({ data: [{ appId: app.id, userId: owner.id, role: 'owner' }, { appId: app.id, userId: member.id, role: 'member' }] });
  const personalApp = await db.app.create({ data: { name: 'Personal', urn: 'read3381.test:personal', ownerUserId: personalOwner.id } });
  const agent = await db.agent.create({ data: { name: 'Agent', urn: 'read3381.test:agent', organizationId: org.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Reader', slug: 'reader', heldByUserId: admin.id } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: admin.id, tool: 'vitest' } });
  const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'synthetic' } });
  const grant = (appId: string, revoked: boolean) => db.appAutomationTeamSnapshotGrant.create({ data: {
    appId, triggerKind: 'SCHEDULE', triggerId: generateId(), grantedBy: admin.id,
    createdAt: new Date('2026-11-01T01:02:03.000Z'), ...(revoked ? { revokedAt: new Date('2026-11-02T01:02:03.000Z'), revokedBy: admin.id } : {}),
  } });
  const live = await grant(app.id, false), revoked = await grant(app.id, true);
  const foreignLive = await grant(otherApp.id, false), foreignRevoked = await grant(otherApp.id, true);
  const personal = await grant(personalApp.id, false);
  return { admin, owner, member, outsider, personalOwner, org, app, otherApp, personalApp, agent, worker, session, key, live, revoked, foreignLive, foreignRevoked, personal };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { await cleanDb(db); f = await fixture(); });
const ctx = (userId = f.admin.id, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
async function graphql(id: string, c: Context) {
  const result = await server.executeOperation({ query: QUERY, variables: { id } }, { contextValue: c });
  if (result.body.kind !== 'single') throw Error('incremental');
  return JSON.parse(JSON.stringify(result.body.singleResult));
}
async function mcp(id: string, c: Context) {
  const s = new McpServer({ name: '3381', version: '1' });
  registerAutomationTeamSnapshotGrantTools(s, { db: c.db, auth: c as never });
  const client = new Client({ name: '3381', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await s.connect(b); await client.connect(a);
  try { return await client.callTool({ name: 'hadron_get_automation_team_snapshot_grant', arguments: { id } }) as { isError?: boolean; content: Array<{ text: string }> }; }
  finally { await client.close(); await s.close(); }
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const GQL_NOT_FOUND = { errors: [{ message: 'Not found', locations: [{ line: 1, column: 16 }], path: ['automationTeamSnapshotGrant'], extensions: { code: 'NOT_FOUND' } }], data: null };
const MCP_NOT_FOUND = { isError: true, content: [{ type: 'text', text: '[not_found] Not found' }] };
it('exposes exactly the id-only, eight-field read, with no instruction arm', () => {
  const schema = buildSchema(typeDefs), field = schema.getQueryType()!.getFields().automationTeamSnapshotGrant;
  expect(field).toBeDefined(); expect(field.args.map(a => [a.name, String(a.type)])).toEqual([['id', 'ID!']]);
  expect(String(field.type)).toBe('AutomationTeamSnapshotGrant!');
});
for (const row of ['live', 'revoked'] as const) it(`reads all eight ${row} fields identically on GraphQL and MCP, without writes`, async () => {
  const before = await db.appAutomationTeamSnapshotGrantEvent.count();
  const expected = json(f[row]);
  const g = await graphql(f[row].id, ctx()); expect(g.errors).toBeUndefined();
  expect(g.data.automationTeamSnapshotGrant).toEqual(expected);
  const m = await mcp(f[row].id, ctx()); expect(m.isError).not.toBe(true);
  expect(JSON.parse(m.content[0].text)).toEqual(expected);
  expect(Object.keys(expected).sort()).toEqual(FIELDS.split(' ').sort());
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(before);
});
it('uses the shared App-manager arms, including App-member owner and personal owner', async () => {
  for (const [id, c] of [[f.live.id, ctx(f.owner.id)], [f.personal.id, ctx(f.personalOwner.id)]] as const) {
    expect((await graphql(id, c)).data.automationTeamSnapshotGrant.id).toBe(id);
    expect(JSON.parse((await mcp(id, c)).content[0].text).id).toBe(id);
  }
});
for (const row of ['live', 'revoked'] as const) it(`unknown, non-manager and foreign ${row} ids are byte-identical on each surface`, async () => {
  const pairs = [[generateId(), ctx()], [f[row].id, ctx(f.member.id)], [f[row].id, ctx(f.outsider.id)], [f[row === 'live' ? 'foreignLive' : 'foreignRevoked'].id, ctx()]] as const;
  for (const [id, c] of pairs) {
    expect(await graphql(id, c)).toEqual(GQL_NOT_FOUND);
    expect(await mcp(id, c)).toEqual(MCP_NOT_FOUND);
  }
});
for (const principal of ['appKey', 'run', 'impersonation', 'workerSession', 'refusedBinding', 'anonymous'] as const) it(`${principal} never reads even its manager's grant`, async () => {
  const extra: Partial<Context> = principal === 'appKey' ? { appKeyId: f.key.id, appId: f.app.id }
    : principal === 'run' ? { clientId: `run:${generateId()}`, appId: f.app.id }
    : principal === 'impersonation' ? { impersonation: { sessionId: generateId(), actorUserId: f.admin.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } }
    : principal === 'workerSession' ? { sessionId: f.session.id }
    : principal === 'refusedBinding' ? { sessionBindingRefused: true } : { userId: undefined };
  for (const id of [f.live.id, f.revoked.id, generateId()]) {
    expect(await graphql(id, ctx(f.admin.id, extra))).toEqual(GQL_NOT_FOUND);
    expect(await mcp(id, ctx(f.admin.id, extra))).toEqual(MCP_NOT_FOUND);
  }
});
it('refuses published and ambiguous worker actors even without a session argument', async () => {
  const invoke = async () => {
    expect(await graphql(f.live.id, ctx())).toEqual(GQL_NOT_FOUND);
    expect(await mcp(f.live.id, ctx())).toEqual(MCP_NOT_FOUND);
  };
  await runAsActor({ workerId: f.worker.id, agentId: f.agent.id }, invoke);
  await requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['a', 'b'] }, invoke);
});
it('checks the person gate before touching even an unknown id (ordering mutant pin)', async () => {
  const lookup = vi.spyOn(db.appAutomationTeamSnapshotGrant, 'findUnique');
  const personGate = vi.spyOn(db.session, 'findFirst');
  const c = ctx(f.admin.id, { sessionId: f.session.id });
  expect(await graphql(generateId(), c)).toEqual(GQL_NOT_FOUND);
  expect(personGate).toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
  personGate.mockClear(); lookup.mockClear();
  expect(await mcp(generateId(), c)).toEqual(MCP_NOT_FOUND);
  expect(personGate).toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
});
it('does not disguise a database fault as an unknown grant', async () => {
  vi.spyOn(db.appAutomationTeamSnapshotGrant, 'findUnique').mockRejectedValueOnce(new Error('private-db-fault'));
  const out = await graphql(f.live.id, ctx());
  expect(out.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
  expect(JSON.stringify(out)).not.toContain('private-db-fault');
});
it('rechecks manager authority inside the authority transaction', async () => {
  const boundaryDb = db.$extends({ query: { appAutomationTeamSnapshotGrant: {
    findUnique: async ({ args, query }) => {
      const row = await query(args);
      await db.orgMember.deleteMany({ where: { userId: f.admin.id } });
      return row;
    },
  } } });
  expect(await graphql(f.live.id, ctx(f.admin.id, { db: boundaryDb as unknown as Context['db'] }))).toEqual(GQL_NOT_FOUND);
});

/** #3406: defensive boundaries, not evidence of reachable session-binding/App-transfer writers. */
for (const surface of ['graphql', 'production MCP'] as const) it('keeps an inside-transaction fault generic on ' + surface + ' (#3406 M5)', async () => {
  const before = await db.appAutomationTeamSnapshotGrant.findMany({ orderBy: { id: 'asc' } });
  const real = db.$transaction.bind(db);
  let faults = 0;
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: any, options: any) => real(async (tx: any) => {
    const grant = new Proxy(tx.appAutomationTeamSnapshotGrant, { get: (target, key) => key === 'findUnique' ? async (args: any) => {
      if (args.where.id === f.live.id) { faults++; throw Error('private-3406-transaction-diagnostic'); }
      return target.findUnique(args);
    } : target[key] });
    return fn(new Proxy(tx, { get: (target, key) => key === 'appAutomationTeamSnapshotGrant' ? grant : target[key] }));
  }, options)) as any);
  try {
    if (surface === 'graphql') {
      const out = await graphql(f.live.id, ctx());
      expect(out.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
      expect(out.errors[0].message).toBe('Internal server error.');
      expect(out.errors[0].extensions.requestId).toEqual(expect.any(String));
      expect(out.errors[0].extensions.requestId.length).toBeGreaterThan(0);
      expect(out.data).toBeNull();
      expect(JSON.stringify(out)).not.toContain('private-3406');
    } else {
      // Real registration installs withToolErrorBoundary; the baseline bare helper above does not.
      const prod = createMcpServerInstance({ userId: f.admin.id, roles: ['READER'], clientId: 'user:3406' } as never,
        () => undefined, { kind: 'multi-app' });
      const client = new Client({ name: '3406', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await prod.connect(b); await client.connect(a);
        const out: any = await client.callTool({ name: 'hadron_get_automation_team_snapshot_grant', arguments: { id: f.live.id } });
        expect(out.structuredContent?.error?.code).toBe('INTERNAL_SERVER_ERROR');
        expect(out.structuredContent.error.message).toBe('Internal server error.');
        expect(out.structuredContent.error.requestId).toEqual(expect.any(String));
        expect(out.structuredContent.error.requestId.length).toBeGreaterThan(0);
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).not.toContain('private-3406');
      } finally { await client.close(); await prod.close(); }
    }
    expect(faults).toBe(1);
  } finally { spy.mockRestore(); }
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(0);
  expect(await db.agentTeamEvent.count()).toBe(0);
  expect(await db.appAutomationTeamSnapshotGrant.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
});

it('rechecks the same person session after an injected worker-binding transition (#3406 M3)', async () => {
  const session = await db.session.create({ data: { id: generateId(), appId: f.app.id, userId: f.admin.id, tool: 'vitest' } });
  const real = db.$transaction.bind(db);
  let transitions = 0;
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (fn: any, options: any) => {
    // Outer person gate and grant lookup have completed. No production writer is claimed to do this.
    await db.session.update({ where: { id: session.id }, data: { workerId: f.worker.id } });
    transitions++;
    return real(fn, options);
  }) as any);
  try {
    expect(await graphql(f.live.id, ctx(f.admin.id, { sessionId: session.id }))).toEqual(GQL_NOT_FOUND);
    expect(transitions).toBe(1);
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).workerId).toBe(f.worker.id);
    expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(0);
    expect(await db.agentTeamEvent.count()).toBe(0);
  } finally {
    spy.mockRestore();
    await db.session.update({ where: { id: session.id }, data: { workerId: null } });
  }
  expect((await graphql(f.live.id, ctx(f.admin.id, { sessionId: session.id }))).data.automationTeamSnapshotGrant.id).toBe(f.live.id);
});

it('refuses changed App scope despite management of the replacement scope (#3406 B8)', async () => {
  const replacement = await db.organization.create({ data: { name: 'Replacement', urn: 'replacement3406.test' } });
  await db.orgMember.create({ data: { organizationId: replacement.id, userId: f.admin.id, role: 'ADMIN' } });
  const real = db.$transaction.bind(db);
  let transitions = 0;
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (fn: any, options: any) => {
    // Deliberate fixture update after outer lookup: old authority anchors, new observed owner scope.
    await db.app.update({ where: { id: f.app.id }, data: { organizationId: replacement.id } });
    transitions++;
    return real(fn, options);
  }) as any);
  try {
    expect(await graphql(f.live.id, ctx())).toEqual(GQL_NOT_FOUND);
    expect(transitions).toBe(1);
    expect((await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).organizationId).toBe(replacement.id);
    expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(0);
    expect(await db.agentTeamEvent.count()).toBe(0);
  } finally {
    spy.mockRestore();
    await db.app.update({ where: { id: f.app.id }, data: { organizationId: f.org.id } });
  }
  expect((await graphql(f.live.id, ctx())).data.automationTeamSnapshotGrant.id).toBe(f.live.id);
});
