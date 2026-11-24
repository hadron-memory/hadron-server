/**
 * #5000 — a worker idle for days keeps its binding: a session past its idle window but inside its App's dormancy period is
 * LAPSED, not ended, and its holder's own inbox read resumes it with the SAME session id (cor:agt:020:03, :13). A refusal
 * names the failed condition as `extensions.reason` (a code, never another worker or session: cor:agt:020:09).
 * The post and mark-read paths already resumed (#1617 B); the inbox read (`deliveryBatches` through a session) did not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { lapsedResumeDecision } from '../../../lib/ownWorkerSessions.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const H = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function refusal(p: Promise<unknown>): Promise<{ code?: unknown; reason?: unknown; message: string } | null> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { code: g.extensions?.code, reason: g.extensions?.reason, message: g.message };
  }
  return null;
}

let org: { id: string; urn: string };
let app: { id: string };
let agentId: string;
let holder: { id: string };
let kit: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Lapsed', urn: `lapsed-${n}.example` }, select: { id: true, urn: true } });
  holder = await db.user.create({ data: { githubId: 82_000_000 + n, githubUsername: `lp-h-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(holder.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id }, select: { id: true } });
});

const session = (data: Record<string, unknown> = {}) =>
  db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: kit.id, agentId, ...data } as any });
const lapsed = (hours: number, extra: Record<string, unknown> = {}) => session({ startedAt: ago(hours * H), updatedAt: ago(hours * H), ...extra });
const inbox = (s: { id: string }, userId = holder.id) =>
  Q.deliveryBatches({}, { appRef: app.id }, { ...ctx(userId), appId: app.id, sessionId: s.id });
const row = (s: { id: string }) => db.session.findUniqueOrThrow({ where: { id: s.id } });

describe('#5000 the holder\'s own inbox read resumes a lapsed session', () => {
  it('a session idle 43 h (past the idle window, inside dormancy) is resumed by the read, same id, and the read is served', async () => {
    const s = await lapsed(43);
    const page = await inbox(s);
    expect(page.batches).toEqual([]);
    const after = await row(s);
    expect(after.id).toBe(s.id);
    expect(after.endedAt).toBeNull();
    expect(after.updatedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000); // resumed: driven just now
    expect(await db.appLogEntry.count({ where: { sessionId: s.id, message: 'delivery.batch.read' } })).toBe(1);
    // and it is live from here on: a second read needs no resume
    expect((await inbox(s)).batches).toEqual([]);
  });

  it('a session idle for weeks (still inside the 90-day default dormancy) is resumed too', async () => {
    const s = await lapsed(24 * 20);
    expect((await inbox(s)).batches).toEqual([]);
    expect((await row(s)).updatedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('#5000 a refused resume says which condition failed, and resumes nothing', () => {
  const untouched = async (s: { id: string; updatedAt: Date | null }) => {
    expect((await row(s)).updatedAt).toEqual(s.updatedAt);
    expect(await db.appLogEntry.count({ where: { sessionId: s.id } })).toBe(0);
  };

  it('DORMANT: idle past the App dormancy threshold', async () => {
    const s = await lapsed(24 * 100);
    const r = await refusal(inbox(s));
    expect(r).toMatchObject({ code: 'SESSION_NOT_LIVE', reason: 'DORMANT' });
    await untouched(s);
  });

  it('DORMANT honours a per-App threshold set below the default (the issue\'s candidate c)', async () => {
    await db.app.update({ where: { id: app.id }, data: { sessionDormancyDays: 1 } });
    const s = await lapsed(43);
    expect(await refusal(inbox(s))).toMatchObject({ code: 'SESSION_NOT_LIVE', reason: 'DORMANT' });
    await untouched(s);
  });

  it('OTHER_SESSION_LIVE: another session on the worker is live, and the message names no other session or worker', async () => {
    const mine = await lapsed(43);
    const other = await session({ updatedAt: new Date() });
    const r = await refusal(inbox(mine));
    expect(r).toMatchObject({ code: 'SESSION_NOT_LIVE', reason: 'OTHER_SESSION_LIVE' });
    expect(r!.message).not.toContain(other.id);
    expect(r!.message).not.toContain('Kit');
    await untouched(mine);
  });

  it.each([
    ['explicitly ended', { endedAt: new Date() }],
    ['past its hard expiry', { expiresAt: ago(H) }],
  ])('ENDED: a session %s is never resumed by an act', async (_label, data) => {
    const s = await lapsed(43, data);
    expect(await refusal(inbox(s))).toMatchObject({ code: 'SESSION_NOT_LIVE', reason: 'ENDED' });
    await untouched(s);
    expect((await row(s)).endedAt?.getTime() ?? null).toBe(((data as any).endedAt as Date | undefined)?.getTime() ?? null);
  });

  it('ENDED: a retired worker\'s session is not resumed', async () => {
    const s = await lapsed(43);
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect(await refusal(inbox(s))).toMatchObject({ code: 'SESSION_NOT_LIVE', reason: 'ENDED' });
    await untouched(s);
  });

  it('NOT_OWNER: the worker\'s name is held by nobody (or someone else), so the session is not the caller\'s to resume', async () => {
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null } });
    const s = await lapsed(43);
    expect(await refusal(inbox(s))).toMatchObject({ code: 'SESSION_NOT_LIVE', reason: 'NOT_OWNER' });
    await untouched(s);
  });

  it('another user\'s session is the same not-found as before, with no reason: the code is no existence oracle', async () => {
    const outsider = await db.user.create({ data: { githubId: 90_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: 'lp-outsider', roles: ['ADMIN'] } });
    for (const s of [await lapsed(43), await lapsed(43, { endedAt: new Date() }), await lapsed(24 * 100)]) {
      expect(await refusal(inbox(s, outsider.id))).toMatchObject({ code: 'SESSION_NOT_FOUND', reason: undefined });
    }
  });
});

describe('#5000 the resume commits with the read or not at all', () => {
  // Each failure point comes AFTER the resume (ownBatchSession is the first thing the read does in its transaction): the
  // channel lookup is the read's last query and the audit row its last write, so neither can be part of the resume itself.
  it.each([['appLogEntry', 'create'], ['channel', 'findMany']])('a read that fails at %s.%s after the resume rolls the resume back', async (model, method) => {
    const s = await lapsed(43);
    const failing = new Proxy(db, { get(target, property) {
      if (property === '$transaction') return (fn: any, ...rest: any[]) => target.$transaction(async tx => {
        const proxy = new Proxy(tx, { get(t, p) {
          if (p === model) return new Proxy((t as any)[model], { get(m, meth) {
            if (meth === method) return async () => { throw new Error('read failed after the resume'); };
            const v = Reflect.get(m, meth); return typeof v === 'function' ? v.bind(m) : v;
          } });
          const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v;
        } });
        return fn(proxy);
      }, ...rest);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(Q.deliveryBatches({}, { appRef: app.id }, { ...ctx(holder.id), db: failing, appId: app.id, sessionId: s.id })).rejects.toThrow('read failed after the resume');
    expect((await row(s)).updatedAt).toEqual(s.updatedAt); // the resume writes updatedAt: unchanged means it rolled back
    expect(await db.appLogEntry.count({ where: { sessionId: s.id } })).toBe(0);
    // the same read, once nothing fails, resumes it (so the check above is not vacuous: it was lapsed and is resumable)
    expect((await inbox(s)).batches).toEqual([]);
    expect((await row(s)).updatedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('#5000 concurrent reads through one lapsed session', () => {
  // The resume takes the Worker row FOR UPDATE; if it ran AFTER a Worker SHARE this transaction already held, two or three
  // readers would each hold SHARE and wait on the other's upgrade (40P01). All of them must succeed.
  it('three concurrent inbox reads through one 43 h-idle session all succeed and resume it once', async () => {
    const s = await lapsed(43);
    const results = await Promise.allSettled([inbox(s), inbox(s), inbox(s)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect((await row(s)).updatedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await db.appLogEntry.count({ where: { sessionId: s.id, message: 'delivery.batch.read' } })).toBe(3);
  });
});

describe('#5000 the decision is judged on ownership first (no existence oracle)', () => {
  it('a caller who does not own the session gets NOT_OWNER whatever state it is in, and a missing one the same', async () => {
    const outsider = await db.user.create({ data: { githubId: 91_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: 'lp-oracle', roles: ['ADMIN'] } });
    const states = [await lapsed(43), await lapsed(43, { endedAt: new Date() }), await lapsed(43, { expiresAt: ago(H) }), await lapsed(24 * 100)];
    for (const s of [...states, { id: generateId() }]) {
      expect(await lapsedResumeDecision(ctx(outsider.id), s.id)).toEqual({ verdict: 'REFUSED', reason: 'NOT_OWNER' });
    }
    // the owner, by contrast, is told the state
    expect(await lapsedResumeDecision(ctx(holder.id), states[1]!.id)).toEqual({ verdict: 'REFUSED', reason: 'ENDED' });
  });
});

describe('#5000 only the inbox read resumes; the acknowledgement does not', () => {
  it('acknowledging through a lapsed session is still the plain refusal (no reason, nothing resumed)', async () => {
    const s = await lapsed(43);
    const r = await refusal(M.acknowledgeDeliveryBatches({}, { batchIds: [] }, { ...ctx(holder.id), appId: app.id, sessionId: s.id }));
    expect(r).toMatchObject({ code: 'SESSION_NOT_LIVE', reason: undefined });
    expect((await row(s)).updatedAt).toEqual(s.updatedAt);
  });
});
