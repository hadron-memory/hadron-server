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
    await db.usageEvent.create({ data: { countsAsActivity: true, id: generateId(), type: 'mcp.tool', sessionId: byEvent.id, createdAt: eventAt } as never });

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

  it('a narrow { id } parent reads its row ONCE for both fields, so they share one snapshot (#1623 review)', async () => {
    const live = await session({ startedAt: new Date(Date.now() - 1 * H) });
    const S = (resolvers as unknown as { Session: Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>> }).Session;
    const c = ctx();
    const findUnique = vi.spyOn(db.session, 'findUnique');
    try {
      const [isLive, lapsesAt] = await Promise.all([
        S.isLive({ id: live.id }, {}, c),
        S.lapsesAt({ id: live.id }, {}, c),
      ]);
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(isLive).toBe(true);
      expect((lapsesAt as Date).getTime()).toBe(live.updatedAt!.getTime() + DEFAULT_SESSION_IDLE_WINDOW_MS);

      // The session ends between the two field reads: the memoized snapshot
      // keeps the pair consistent instead of answering { true, null }.
      const c2 = ctx();
      const first = await S.isLive({ id: live.id }, {}, c2);
      await db.session.update({ where: { id: live.id }, data: { endedAt: new Date() } });
      const second = await S.lapsesAt({ id: live.id }, {}, c2);
      expect(first).toBe(true);
      expect(second).not.toBeNull();
    } finally {
      findUnique.mockRestore();
    }
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
