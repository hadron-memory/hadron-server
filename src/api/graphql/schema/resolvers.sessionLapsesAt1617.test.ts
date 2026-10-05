/**
 * #1617 — `Session.lapsesAt`: the deadline beside `Session.isLive`. Liveness
 * was invisible until a post was refused; this is the field a client reads to
 * warn first. It must never disagree with `isLive` about the same row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { DEFAULT_SESSION_IDLE_WINDOW_MS } from '../../../lib/sessionActivity.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const H = 60 * 60 * 1000;

let admin: { id: string };
const ctx = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] }) as Context;

async function session(at: { startedAt: Date; updatedAt?: Date; endedAt?: Date; deletedAt?: Date }) {
  const row = await db.session.create({
    data: {
      id: generateId(), userId: admin.id, type: 'DEVELOPER', startedAt: at.startedAt,
      endedAt: at.endedAt ?? null, deletedAt: at.deletedAt ?? null,
    } as never,
  });
  if (at.updatedAt) await db.session.update({ where: { id: row.id }, data: { updatedAt: at.updatedAt } });
  return db.session.findUniqueOrThrow({ where: { id: row.id } });
}

type Row = { id: string; isLive: boolean; lapsesAt: string | null };
async function rows(): Promise<Record<string, Row>> {
  const res = await server.executeOperation({ query: '{ sessions(limit: 50) { id isLive lapsesAt } }' }, { contextValue: ctx() });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(res.body.singleResult.errors).toBeUndefined();
  const list = (res.body.singleResult.data as { sessions: Row[] }).sessions;
  return Object.fromEntries(list.map((r) => [r.id, r]));
}

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({ data: { githubId: 16170, githubUsername: 'la-admin', handle: 'la-admin', roles: ['ADMIN'] } });
});

describe('#1617 — Session.lapsesAt', () => {
  it('is last activity + the window, agrees with isLive, and is null once ended', async () => {
    const now = Date.now();
    const live = await session({ startedAt: new Date(now - 30 * H), updatedAt: new Date(now - 2 * H) });
    const lapsed = await session({ startedAt: new Date(now - 30 * H), updatedAt: new Date(now - 30 * H) });
    const ended = await session({ startedAt: new Date(now - 1 * H), endedAt: new Date(now - 0.5 * H) });
    const byEvent = await session({ startedAt: new Date(now - 30 * H), updatedAt: new Date(now - 30 * H) });
    const eventAt = new Date(now - 1 * H);
    await db.usageEvent.create({ data: { id: generateId(), type: 'mcp.tool', sessionId: byEvent.id, createdAt: eventAt } as never });

    const out = await rows();
    expect(out[live.id].lapsesAt).toBe(new Date(live.updatedAt!.getTime() + DEFAULT_SESSION_IDLE_WINDOW_MS).toISOString());
    expect(out[byEvent.id].lapsesAt).toBe(new Date(eventAt.getTime() + DEFAULT_SESSION_IDLE_WINDOW_MS).toISOString());
    expect(out[ended.id].lapsesAt).toBeNull();
    // A lapsed row reports WHEN it lapsed, in the past.
    expect(new Date(out[lapsed.id].lapsesAt!).getTime()).toBeLessThan(now);

    // The two fields are one computation: in the future ⇔ live.
    for (const r of Object.values(out)) {
      expect(r.lapsesAt !== null && new Date(r.lapsesAt).getTime() > Date.now()).toBe(r.isLive);
    }
  });

  it('is null for a soft-deleted session, as isLive is false for one', async () => {
    const deleted = await session({ startedAt: new Date(Date.now() - 1 * H), deletedAt: new Date() });
    const res = await server.executeOperation(
      { query: 'query($id: ID!) { session(id: $id) { id isLive lapsesAt } }', variables: { id: deleted.id } },
      { contextValue: ctx() },
    );
    if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data).toEqual({ session: { id: deleted.id, isLive: false, lapsesAt: null } });
  });

  it('isLive and lapsesAt over a list still cost ONE grouped usage-event query', async () => {
    for (let i = 0; i < 6; i++) await session({ startedAt: new Date(Date.now() - i * H) });
    const groupBy = vi.spyOn(db.usageEvent, 'groupBy');
    try {
      expect(Object.values(await rows())).toHaveLength(6);
      expect(groupBy).toHaveBeenCalledTimes(1);
    } finally {
      groupBy.mockRestore();
    }
  });
});
