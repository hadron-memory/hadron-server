import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #1156 / cor:dmo:070:05: end evidence is first-writer-wins, never inferred. */
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { endSessionFirstWins } from './resolvers.mutation.session.js';
import { runSessionReaper } from '../../../jobs/reapSessions.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const S = (resolvers as any).Session;
let owner: { id: string }, other: { id: string };
const ctx = (userId = owner.id): Context => ({ db, userId, roles: ['READER'] });
const row = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
const reason = (s: unknown) => S.endReason?.(s);
const create = (over = {}) => db.session.create({ data: { id: generateId(), userId: owner.id, ...over } });
beforeEach(async () => {
  await cleanDb(db);
  owner = await db.user.create({ data: { id: generateId(), handle: `o-${generateId()}`, roles: ['READER'] } });
  other = await db.user.create({ data: { id: generateId(), handle: `x-${generateId()}`, roles: ['READER'] } });
});

describe('session end reason #1156', () => {
  it('publishes the same closed vocabulary on the shared Session type', () => {
    const schema = buildSchema(typeDefs);
    const field = (schema.getType('Session') as GraphQLObjectType).getFields().endReason;
    expect(String(field.type)).toBe('SessionEndReason');
    expect((schema.getType('SessionEndReason') as any).getValues().map((v: { name: string }) => v.name)).toEqual(['ended', 'superseded', 'expired', 'unknown']);
  });
  it('stamps an explicit end and preserves evidence on repeat calls', async () => {
    const s = await create();
    await M.endSession({}, { id: s.id }, ctx());
    const first = await row(s.id);
    expect(first).toMatchObject({ endReason: 'ended' });
    await M.endSession({}, { id: s.id, summary: 'late metrics' }, ctx());
    expect(await row(s.id)).toMatchObject({ endedAt: first.endedAt, endReason: 'ended' });
  });
  it('stamps promised expiry and cannot relabel it as an explicit end', async () => {
    const now = new Date();
    const s = await create({ expiresAt: new Date(now.getTime() - 1000) });
    await runSessionReaper(db, now);
    expect(await row(s.id)).toMatchObject({ endReason: 'expired', endedAt: now, autoExpiredAt: now });
    await endSessionFirstWins(db, s.id, {});
    expect(await row(s.id)).toMatchObject({ endReason: 'expired', endedAt: now, autoExpiredAt: now });
  });
  it('keeps one coherent end in an explicit-end/reaper race', async () => {
    const s = await create({ expiresAt: new Date(Date.now() - 1000) });
    await Promise.all([runSessionReaper(db), endSessionFirstWins(db, s.id, {})]);
    const first = await row(s.id) as any;
    expect(['ended', 'expired']).toContain(first.endReason);
    expect(first.autoExpiredAt).toEqual(first.endReason === 'expired' ? first.endedAt : null);
    await endSessionFirstWins(db, s.id, {});
    expect(await row(s.id)).toMatchObject({ endedAt: first.endedAt, endReason: first.endReason, autoExpiredAt: first.autoExpiredAt });
  });
  it('reads open as null, legacy as unknown without guessing or backfilling; conceals foreign sessions', async () => {
    const open = await create();
    const legacy = await create({ endedAt: new Date(), autoExpiredAt: new Date(), summary: 'superseded by session old' });
    expect(reason(await Q.session({}, { id: open.id }, ctx()))).toBeNull();
    expect(reason(await Q.session({}, { id: legacy.id }, ctx()))).toBe('unknown');
    await M.endSession({}, { id: legacy.id }, ctx());
    expect(reason(await row(legacy.id))).toBe('unknown');
    expect(await Q.session({}, { id: legacy.id }, ctx(other.id))).toBeNull();
    await expect(M.endSession({}, { id: open.id }, ctx(other.id))).rejects.toThrow();
    expect((await row(open.id)).endedAt).toBeNull();
  });
  for (const force of [false, true]) {
    it(`stamps ${force ? 'forced live' : 'automatic lapsed'} supersession, keeping summaries and holds`, async () => {
      const app = await db.app.create({ data: { ownerUserId: owner.id, name: 'Team', urn: `hrn:app:test:team-${generateId()}` } });
      const agent = await db.agent.create({ data: { ownerUserId: owner.id, name: 'Engineer', urn: `hrn:agent:test:eng-${generateId()}` } });
      await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
      const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Test', slug: 'test', heldByUserId: owner.id } });
      const at = new Date(Date.now() - (force ? 1000 : 7 * 86400000));
      const previous = await create({ appId: app.id, agentId: agent.id, workerId: worker.id, startedAt: at, updatedAt: at, summary: 'driver summary' });
      await M.startSession({}, { input: { id: generateId(), workerRef: worker.id, tool: 'codex', force } }, ctx());
      expect(await row(previous.id)).toMatchObject({ endReason: 'superseded', summary: 'driver summary' });
      expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).heldByUserId).toBe(owner.id);
      await M.endSession({}, { id: previous.id }, ctx());
      expect(await row(previous.id)).toMatchObject({ endReason: 'superseded' });
    });
  }
  it('stamps direct agent close', async () => {
    const app = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'Reason', urn: `hrn:app:test:reason-${generateId()}` } });
    const s = await create({ appId: app.id });
    await M.endAgentSession({}, { sessionId: s.id }, { db, appId: app.id, roles: [] });
    expect(await row(s.id)).toMatchObject({ endReason: 'ended' });
  });
  it('agent close preserves expiry when it lands between the read and write', async () => {
    const app = await db.app.create({ data: { ownerUserId: owner.id, name: 'Race', urn: `hrn:app:test:race-${generateId()}` } });
    const s = await create({ appId: app.id });
    const expiredAt = new Date(Date.now() - 1000);
    const original = db.session.updateMany.bind(db.session);
    const spy = vi.spyOn(db.session, 'updateMany').mockImplementationOnce((async (args: any) => {
      await db.session.update({ where: { id: s.id }, data: { endedAt: expiredAt, autoExpiredAt: expiredAt, endReason: 'expired' } });
      return original(args);
    }) as never);
    try {
      await M.endAgentSession({}, { sessionId: s.id }, { db, appId: app.id, roles: [] });
      expect(await row(s.id)).toMatchObject({ endedAt: expiredAt, autoExpiredAt: expiredAt, endReason: 'expired' });
    } finally { spy.mockRestore(); }
  });
  it('shows explicit and legacy reasons on MCP identity reads, never another user\'s row', async () => {
    const s = await create();
    const legacy = await create({ endedAt: new Date() });
    await endSessionFirstWins(db, s.id, {});
    const mine = createTestableMcpServer({ userId: owner.id, roles: ['READER'] });
    const text = await mine.callToolText('hadron_whoami', { includeEnded: true });
    expect(text).toContain('end reason: ended');
    expect(text).toContain('end reason: unknown');
    const foreign = await createTestableMcpServer({ userId: other.id, roles: ['READER'] }).callToolText('hadron_whoami', { includeEnded: true });
    expect(foreign).not.toContain(s.id);
    expect(foreign).not.toContain(legacy.id);
  });
});
