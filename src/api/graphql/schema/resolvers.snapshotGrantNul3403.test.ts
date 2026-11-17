/** #3403: NUL-only LIST hardening after admission, on real GraphQL/MCP adapters. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Client as PgClient } from 'pg';
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


/** #3565 A: preservation of built LIST validation priority, not a general sanitizer contract. */
for (const surface of ['graphql', 'mcp'] as const) for (const worker of [false, true]) {
  const label = `${surface} ${worker ? 'instructed' : 'person'}`;
  for (const [position, triggerId] of [['only', '\u0000'], ['leading', '\u0000lead'], ['trailing', 'trail\u0000']] as const) {
    it(`#3565 A ${label} ${position}: NUL boundary and kind precedence preserve fixed errors and zero writes`, async () => {
      const before = await snapshot();
      for (const triggerKind of ['SCHEDULE', 'WEBHOOK']) {
        expect((await invoke(surface, worker, { triggerKind, triggerId })).error).toEqual({
          code: 'BAD_USER_INPUT', message: 'triggerId must not contain U+0000.',
        });
      }
      // MCP's registered schema refuses explicit null before the handler (separate pin below, Xavier90561).
      for (const triggerKind of (surface === 'graphql' ? [undefined, null] : [undefined])) {
        expect((await invoke(surface, worker, { triggerKind, triggerId })).error).toEqual({
          code: 'BAD_USER_INPUT', message: 'triggerKind is required with triggerId.',
        });
      }
      expect((await invoke(surface, worker, { triggerKind: 'MANUAL', triggerId })).error).toEqual({
        code: 'BAD_USER_INPUT', message: 'triggerKind must be SCHEDULE or WEBHOOK.',
      });
      expect(await snapshot()).toEqual(before);
    });
    it(`#3565 A ${label} ${position}: an unauthorized caller gets ordinary FORBIDDEN before malformed filters`, async () => {
      if (worker) await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
      const userId = worker ? f.holder.id : f.stranger.id;
      const before = await snapshot();
      const ordinary = await invoke(surface, worker, { triggerKind: 'SCHEDULE', triggerId: f.schedule.id }, userId);
      expect(ordinary.error?.code).toBe('FORBIDDEN');
      for (const triggerKind of (surface === 'graphql' ? ['SCHEDULE', 'WEBHOOK', 'MANUAL', undefined, null] : ['SCHEDULE', 'WEBHOOK', 'MANUAL', undefined])) {
        expect(await invoke(surface, worker, { triggerKind, triggerId }, userId)).toEqual(ordinary);
      }
      expect(await snapshot()).toEqual(before);
    });
  }
}

/**
 * #3565 B: a real uncommitted session end, not an end-session endpoint protocol.
 * Only the session row is held by the blocker. The request's delegated SQL/PID is observed, never altered.
 */
async function finalSessionWait(endSession: boolean) {
  const blocker = new PgClient({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const observer = new PgClient({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  let blockerConnected = false, observerConnected = false, open = false, failed = false;
  let request: Promise<{ code: unknown; message?: string }> | undefined;
  let pid = 0, enteredSessionShare = false, settled = false, sawWait = false;
  const before = await snapshot();
  try {
    await blocker.connect(); blockerConnected = true;
    await observer.connect(); observerConnected = true;
    const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    expect(Number.isSafeInteger(blockerPid) && blockerPid > 0).toBe(true);
    await blocker.query('BEGIN'); open = true;
    await blocker.query('SET LOCAL lock_timeout = \'3s\'');
    await blocker.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [f.session.id]);
    if (endSession) await blocker.query('UPDATE sessions SET ended_at = clock_timestamp() WHERE id = $1', [f.session.id]);
    const observedDb = new Proxy(db, { get(target, key) {
      if (key !== '$transaction') { const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v; }
      return (callback: (tx: unknown) => Promise<unknown>, options: unknown) => target.$transaction(async tx => {
        pid = Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
        const observedTx = new Proxy(tx, { get(t, prop) {
          const v = Reflect.get(t, prop);
          if (prop !== '$queryRaw') return typeof v === 'function' ? v.bind(t) : v;
          return (...args: unknown[]) => {
            const text = Array.isArray(args[0]) ? args[0].join('?') : '';
            if (/SELECT id FROM sessions WHERE id = \? FOR SHARE/.test(text)) enteredSessionShare = true;
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        } });
        return callback(observedTx);
      }, options as never);
    } });
    const query = resolvers.Query as any;
    const pending: Promise<{ code: unknown; message?: string }> = query.automationTeamSnapshotGrants(null, {
      appRef: f.app.id, triggerKind: 'SCHEDULE', triggerId: nul, instruction,
    }, { db: observedDb, userId: f.holder.id, roles: ['READER'], sessionId: f.session.id })
      .then(() => ({ code: 'SUCCESS' }), (error: any) => ({ code: error.extensions?.code, message: error.message }))
      .finally(() => { settled = true; });
    request = pending;
    const deadline = Date.now() + 5000;
    while (!settled && Date.now() < deadline) {
      if (pid > 0 && enteredSessionShare) {
        const rows = await observer.query(`SELECT pid FROM pg_stat_activity
          WHERE pid = $1 AND state = 'active' AND wait_event_type = 'Lock'
            AND $2::int = ANY(pg_blocking_pids(pid))
            AND query ~ 'SELECT id FROM sessions WHERE id = .* FOR SHARE'`, [pid, blockerPid]);
        if (rows.rowCount === 1) { sawWait = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await blocker.query(endSession ? 'COMMIT' : 'ROLLBACK'); open = false;
    const result = await pending;
    // Outcome first: a relocated validator is assertion-red even if it never reached the waiter.
    expect(result.code).toBe(endSession ? 'FORBIDDEN' : 'BAD_USER_INPUT');
    if (!endSession) expect(result.message).toBe('triggerId must not contain U+0000.');
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(enteredSessionShare).toBe(true);
    expect(sawWait, 'the exact request backend must wait on the owned session blocker at final admission').toBe(true);
    expect(await snapshot()).toEqual(before);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { if (open) await blocker.query('ROLLBACK'); }
    finally {
      try { if (request) await request; }
      finally {
        const closed = await Promise.allSettled([
          ...(observerConnected ? [observer.end()] : []),
          ...(blockerConnected ? [blocker.end()] : []),
        ]);
        if (!failed) expect(closed.every(result => result.status === 'fulfilled')).toBe(true);
      }
    }
  }
}
for (const end of [true, false]) {
  it(`#3565 B final-session wait: ${end ? 'committed session end wins over NUL validation' : 'release without ending reaches NUL validation'}`, async () => {
    await finalSessionWait(end);
    if (end) {
      expect((await invoke('graphql', true, { triggerKind: 'SCHEDULE', triggerId: f.schedule.id })).error?.code).toBe('FORBIDDEN');
    } else {
      const count = await db.agentTeamEvent.count();
      expect((await invoke('graphql', true, { triggerKind: 'SCHEDULE', triggerId: f.schedule.id })).data?.total).toBe(1);
      expect(await db.agentTeamEvent.count()).toBe(count + 1);
    }
  }, 45000);
}


// #3565 bounded adapter distinction accepted by Xavier: this is schema rejection, NOT handler/admission priority.
for (const worker of [false, true]) for (const unauthorized of [false, true]) {
  it(`#3565 A MCP explicit null kind is rejected by the registered schema (worker=${worker}, unauthorized=${unauthorized})`, async () => {
    if (unauthorized && worker) await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
    const before = await snapshot();
    const result = await invoke('mcp', worker, { triggerKind: null, triggerId: '\u0000' }, unauthorized && !worker ? f.stranger.id : f.holder.id);
    expect(result.error?.code).toBeUndefined();
    expect(result.error?.message).toContain('MCP error -32602: Input validation error:');
    expect(result.error?.message).toContain('expected string, received null at triggerKind');
    expect(await snapshot()).toEqual(before);
  });
}
