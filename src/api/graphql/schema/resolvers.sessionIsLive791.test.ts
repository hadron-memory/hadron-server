/**
 * hadron-cli#791 — `Session.isLive`: the exact per-session form of the shared
 * liveness predicate (`isSessionLive`, cor:agt:020:11). Executed through
 * Apollo so the field resolvers run as a client would see them, including
 * the per-request batching of the last-event lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const H = 60 * 60 * 1000;

let admin: { id: string };
const ctx = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] }) as Context;

async function session(at: { startedAt: Date; updatedAt?: Date; endedAt?: Date }) {
  const row = await db.session.create({
    data: { id: generateId(), userId: admin.id, type: 'DEVELOPER', startedAt: at.startedAt, endedAt: at.endedAt ?? null } as never,
  });
  if (at.updatedAt) await db.session.update({ where: { id: row.id }, data: { updatedAt: at.updatedAt } });
  return row;
}

async function liveness(): Promise<Record<string, boolean>> {
  const res = await server.executeOperation({ query: '{ sessions(limit: 50) { id isLive } }' }, { contextValue: ctx() });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(res.body.singleResult.errors).toBeUndefined();
  const rows = (res.body.singleResult.data as { sessions: Array<{ id: string; isLive: boolean }> }).sessions;
  return Object.fromEntries(rows.map((r) => [r.id, r.isLive]));
}

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({ data: { githubId: 7910, githubUsername: 'il-admin', handle: 'il-admin', roles: ['ADMIN'] } });
});

describe('hadron-cli#791 — Session.isLive', () => {
  it('reports each session by the shared predicate: live, lapsed, ended, and live by a recent usage event', async () => {
    const now = Date.now();
    const live = await session({ startedAt: new Date(now - 1 * H) });
    const lapsed = await session({ startedAt: new Date(now - 30 * H), updatedAt: new Date(now - 30 * H) });
    const ended = await session({ startedAt: new Date(now - 1 * H), endedAt: new Date(now - 0.5 * H) });
    const byEvent = await session({ startedAt: new Date(now - 30 * H), updatedAt: new Date(now - 30 * H) });
    await db.usageEvent.create({ data: { countsAsActivity: true, id: generateId(), type: 'mcp.tool', sessionId: byEvent.id, createdAt: new Date(now - 1 * H) } as never });

    expect(await liveness()).toEqual({
      [live.id]: true,
      [lapsed.id]: false, // open, but nobody drove it inside the window
      [ended.id]: false,
      [byEvent.id]: true, // the latest attributed usage event counts as driving
    });
  });

  it('a soft-deleted session is never live, matching the bind gate and Worker.hasLiveSession (Codex-worker P2)', async () => {
    const deleted = await db.session.create({
      data: { id: generateId(), userId: admin.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 1 * H), deletedAt: new Date() } as never,
    });
    const res = await server.executeOperation({ query: 'query($id: ID!) { session(id: $id) { id isLive } }', variables: { id: deleted.id } }, { contextValue: ctx() });
    if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data).toEqual({ session: { id: deleted.id, isLive: false } });
  });

  it('a session list costs ONE grouped usage-event query, not one per row', async () => {
    for (let i = 0; i < 6; i++) await session({ startedAt: new Date(Date.now() - i * H) });
    const groupBy = vi.spyOn(db.usageEvent, 'groupBy');
    try {
      const flags = await liveness();
      expect(Object.values(flags)).toHaveLength(6);
      expect(groupBy).toHaveBeenCalledTimes(1);
    } finally {
      groupBy.mockRestore();
    }
  });
});
