import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { isSessionDormant, DEFAULT_SESSION_IDLE_WINDOW_MS, dormancyThresholdMs } from '../../../lib/sessionActivity.js';
import { lapsedResumeVerdict } from '../../../lib/teamAttention.js';
import { validateSessionBinding } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const NOW = new Date('2026-10-23T12:00:00.000Z');
const D = 86400000;
let owner: { id: string };
let outsider: { id: string };
let app: { id: string };
let viewerApp: { id: string };
let worker: { id: string };
const ctx = (userId = owner.id): Context => ({ db, userId, roles: ['READER'] });
const S = resolvers.Session as unknown as Record<string, (s: unknown, a: unknown, c: Context) => Promise<unknown>>;
async function session(idle = 3600000, extra: Record<string, unknown> = {}) {
  const at = new Date(NOW.getTime() - idle);
  return db.session.create({ data: { id: generateId(), type: 'DEVELOPER', userId: owner.id,
    appId: app.id, workerId: worker.id, startedAt: at, updatedAt: at, ...extra } as never });
}
async function query(id: string, c = ctx()) {
  const out = await server.executeOperation({ query: 'query($id:ID!){session(id:$id){id state isLive lapsesAt}}', variables: { id } }, { contextValue: c });
  if (out.body.kind !== 'single') throw new Error('incremental response');
  expect(out.body.singleResult.errors).toBeUndefined();
  return out.body.singleResult.data?.session as { id: string; state: string; isLive: boolean; lapsesAt: string | null } | null;
}
beforeEach(async () => {
  for (const type of ['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE']) vi.stubEnv(`SESSION_IDLE_WINDOW_${type}_MS`, String(DEFAULT_SESSION_IDLE_WINDOW_MS));
  await cleanDb(db);
  owner = await db.user.create({ data: { githubId: 228801, githubUsername: 'state-owner' } });
  outsider = await db.user.create({ data: { githubId: 228802, githubUsername: 'state-outsider' } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'state', urn: `state-${generateId()}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'own', urn: `${org.urn}:own`, sessionDormancyDays: 7 } });
  viewerApp = await db.app.create({ data: { organizationId: org.id, name: 'viewer', urn: `${org.urn}:viewer`, sessionDormancyDays: 90 } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'agent', urn: `${org.urn}:agent` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'State', slug: 'state', heldByUserId: owner.id } });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('#2288 Session.state', () => {
  it.each([
    ['LIVE', 3600000, {}], ['LAPSED', 2 * D, {}], ['DORMANT', 8 * D, {}],
    ['ENDED', 3600000, { endedAt: NOW }],
    ['ENDED', 3600000, { endedAt: NOW, autoExpiredAt: NOW }],
    ['ENDED', 8 * D, { deletedAt: NOW }],
    ['ENDED', 8 * D, { expiresAt: NOW }],
  ] as const)('reports %s, idle %i, terminal %j through GraphQL', async (state, idle, extra) => {
    const row = await session(idle, extra);
    expect((await query(row.id))?.state).toBe(state);
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } }))).toEqual(row);
  });

  it.each([-1, 0, 1])('idle deadline %+d ms is inclusive', async (offset) => {
    const row = await session(DEFAULT_SESSION_IDLE_WINDOW_MS);
    vi.setSystemTime(NOW.getTime() + offset);
    const out = await query(row.id);
    expect(out).toMatchObject({ state: offset <= 0 ? 'LIVE' : 'LAPSED', isLive: offset <= 0, lapsesAt: NOW.toISOString() });
  });

  it.each([-1, 0, 1])('hard expiry %+d ms is exclusive, including coincident idle deadline', async (offset) => {
    const row = await session(DEFAULT_SESSION_IDLE_WINDOW_MS, { expiresAt: NOW });
    vi.setSystemTime(NOW.getTime() + offset);
    expect(await query(row.id)).toMatchObject({ state: offset < 0 ? 'LIVE' : 'ENDED', isLive: offset < 0, lapsesAt: NOW.toISOString() });
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).endedAt).toBeNull();
  });

  it.each([-1, 0, 1])('dormancy %+d ms agrees with the resume DORMANT arm and shared predicate', async (offset) => {
    const row = await session(dormancyThresholdMs(7));
    vi.setSystemTime(NOW.getTime() + offset);
    const dormant = isSessionDormant(row, null, 7, new Date());
    expect(dormant).toBe(offset > 0);
    expect((await query(row.id))?.state).toBe(dormant ? 'DORMANT' : 'LAPSED');
    expect(await lapsedResumeVerdict(ctx(), row.id)).toBe(dormant ? 'DORMANT' : 'OK');
  });

  it('uses its own App policy; App-less and missing-worker sessions remain defined', async () => {
    const own = await session(8 * D, { workerId: null });
    expect((await query(own.id))?.state).toBe('DORMANT');
    // The parent gate may conceal a session outside the selected App. Once
    // authorized, the field still uses the row's App, never that selection.
    expect(await query(own.id, { ...ctx(), appId: viewerApp.id })).toBeNull();
    expect(await S.state(own, {}, { ...ctx(), appId: viewerApp.id })).toBe('DORMANT');
    const appLess = await session(8 * D, { appId: null, workerId: null });
    expect((await query(appLess.id))?.state).toBe('LAPSED');
    const old = await session(91 * D, { appId: null, workerId: null });
    expect((await query(old.id))?.state).toBe('DORMANT');
  });

  it.each(['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE'])('describes App-less %s sessions without requiring a worker', async (type) => {
    const row = await session(91 * D, { type, appId: null, workerId: null });
    expect((await query(row.id))?.state).toBe('DORMANT');
  });

  it('batches different own-App policies without borrowing the first row policy', async () => {
    const own = await session(8 * D);
    const other = await session(8 * D, { appId: viewerApp.id, workerId: null });
    const c = ctx();
    const out = await Promise.all([S.state(own, {}, c), S.state(other, {}, c)]);
    expect(out).toEqual(['DORMANT', 'LAPSED']);
  });

  it('uses the shared dormancy floor rather than a second threshold', async () => {
    await db.app.update({ where: { id: app.id }, data: { sessionDormancyDays: 1 } });
    const row = await session(DEFAULT_SESSION_IDLE_WINDOW_MS);
    expect((await query(row.id))?.state).toBe('LIVE');
    vi.setSystemTime(NOW.getTime() + 1);
    expect((await query(row.id))?.state).toBe('DORMANT');
  });

  it('honors a configured idle window and its dormancy floor', async () => {
    vi.stubEnv('SESSION_IDLE_WINDOW_DEVELOPER_MS', String(3 * D));
    await db.app.update({ where: { id: app.id }, data: { sessionDormancyDays: 1 } });
    const row = await session(2 * D);
    expect((await query(row.id))?.state).toBe('LIVE');
    vi.setSystemTime(NOW.getTime() + D + 1);
    expect((await query(row.id))?.state).toBe('DORMANT');
  });

  it('counts only genuine activity and never revives terminal history with late usage', async () => {
    const row = await session(8 * D);
    await db.usageEvent.create({ data: { id: generateId(), type: 'mcp.tool', sessionId: row.id, countsAsActivity: false, createdAt: NOW } });
    expect((await query(row.id))?.state).toBe('DORMANT');
    await db.usageEvent.create({ data: { id: generateId(), type: 'mcp.tool', sessionId: row.id, countsAsActivity: true, createdAt: NOW } });
    expect((await query(row.id))?.state).toBe('LIVE');
    await db.session.update({ where: { id: row.id }, data: { endedAt: new Date(NOW.getTime() - D) } });
    expect((await query(row.id))?.state).toBe('ENDED');
  });

  it('retains parent point/list read gates and does not disclose a foreign state', async () => {
    const row = await session();
    expect(await query(row.id, ctx(outsider.id))).toBeNull();
    const out = await server.executeOperation({ query: '{sessions{ id state }}' }, { contextValue: ctx(outsider.id) });
    if (out.body.kind !== 'single') throw new Error('incremental response');
    expect(out.body.singleResult.errors).toBeUndefined();
    expect(out.body.singleResult.data?.sessions).toEqual([]);
  });

  it('memoizes one narrow snapshot, activity and request clock for all three fields', async () => {
    const row = await session(DEFAULT_SESSION_IDLE_WINDOW_MS);
    const c = ctx();
    const read = vi.spyOn(db.session, 'findUnique');
    const events = vi.spyOn(db.usageEvent, 'groupBy');
    try {
      expect(await S.isLive({ id: row.id }, {}, c)).toBe(true);
      vi.setSystemTime(NOW.getTime() + 1);
      await db.session.update({ where: { id: row.id }, data: { endedAt: new Date() } });
      expect(await S.state({ id: row.id }, {}, c)).toBe('LIVE');
      expect(await S.lapsesAt({ id: row.id }, {}, c)).toEqual(NOW);
      expect(read).toHaveBeenCalledTimes(1);
      expect(events).toHaveBeenCalledTimes(1);
      expect((await query(row.id))?.state).toBe('ENDED');
    } finally { read.mockRestore(); events.mockRestore(); }
  });

  it('uses one request clock across different rows and late field evaluation', async () => {
    const first = await session(DEFAULT_SESSION_IDLE_WINDOW_MS);
    const second = await session(DEFAULT_SESSION_IDLE_WINDOW_MS);
    const c = ctx();
    expect(await S.state(first, {}, c)).toBe('LIVE');
    vi.setSystemTime(NOW.getTime() + 1);
    expect(await S.isLive(second, {}, c)).toBe(true);
    expect(await S.state(second, {}, c)).toBe('LIVE');
    expect((await query(second.id))?.state).toBe('LAPSED');
  });

  it('batches list activity and own-App policy and performs no state-read writes', async () => {
    const rows = await Promise.all(Array.from({ length: 6 }, () => session(8 * D)));
    const events = vi.spyOn(db.usageEvent, 'groupBy');
    const policies = vi.spyOn(db.app, 'findMany');
    try {
      const out = await server.executeOperation({ query: '{sessions{ id state isLive lapsesAt }}' }, { contextValue: ctx() });
      if (out.body.kind !== 'single') throw new Error('incremental response');
      expect(out.body.singleResult.errors).toBeUndefined();
      expect((out.body.singleResult.data?.sessions as { state: string }[]).map(r => r.state)).toEqual(Array(6).fill('DORMANT'));
      expect(events).toHaveBeenCalledTimes(1);
      expect(policies.mock.calls.filter(([args]) => (args as { select?: { sessionDormancyDays?: boolean } }).select?.sessionDormancyDays)).toHaveLength(1);
      for (const row of rows) expect(await db.session.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    } finally { events.mockRestore(); policies.mockRestore(); }
  });

  it('describes dormancy without changing the existing promised-expiry binding distinction', async () => {
    const open = await session(8 * D);
    const promised = await session(8 * D, { expiresAt: new Date(NOW.getTime() + D) });
    const principal = { userId: owner.id, roles: ['READER'] } as never;
    expect((await query(open.id))?.state).toBe('DORMANT');
    expect((await query(promised.id))?.state).toBe('DORMANT');
    expect(await validateSessionBinding(db, principal, open.id)).toBeNull();
    expect(await validateSessionBinding(db, principal, promised.id)).toMatchObject({ sessionId: promised.id });
  });
});
