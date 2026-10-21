import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
/**
 * Holger's DY rulings (2026-10-05) on session lifetime:
 *  - DY-2 (#1653): a usage event counts as ACTIVITY only when its session was
 *    live and owned by the recorder at write time, so an attributed request
 *    can no longer revive a lapsed session behind DA's checks;
 *  - DY-1: a pure App key's attributed request resumes its OWN App's lapsed,
 *    person-less session on an unheld worker, through the same locked verdict;
 *  - DY-5: past its App's `sessionDormancyDays`, no agent act resumes a
 *    session, and routing drops it; only a rebind brings the worker back;
 *  - DY-4: a locked-memory error says how to get the key back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { isSessionDormant, isSessionLive, loadLastEventBySession, usageEventCountsAsActivity } from './sessionActivity.js';
import { attributedRequestActivity, recordNodeUsage } from './usageRecorder.js';
import { lapsedResumeVerdict, resumeOwnLapsedSessionInTx, resumableOwnWorkerIds } from './teamAttention.js';
import { sessionKeyReleasedHint } from './sessionKeyCache.js';
import { decryptNodeFields } from './nodeCrypto.js';

const H = 60 * 60 * 1000;
const D = 24 * H;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let holder: { id: string };
let other: { id: string };
let app: { id: string };
let otherApp: { id: string };
let worker: { id: string };

const userCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const appKeyCtx = (appId: string): Context => ({ db, appId, roles: [] }) as unknown as Context;

/** An open session last driven `idleMs` ago (by its row heartbeat only). */
async function session(opts: { idleMs: number; userId: string | null; appId?: string; workerId?: string }) {
  const at = new Date(Date.now() - opts.idleMs);
  return db.session.create({
    data: {
      id: generateId(), type: 'DEVELOPER', userId: opts.userId, appId: opts.appId ?? app.id,
      workerId: opts.workerId ?? worker.id, startedAt: at, updatedAt: at,
    },
  });
}

/** A real node to attribute reads to (usage events reference it by FK). */
async function aNode() {
  const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}-m-${generateId().slice(-6)}`, name: 'm', class: 'knowledge' } });
  const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'x', name: 'x' } });
  return { id: node.id, loc: node.loc, memoryId: mem.id };
}

async function live(id: string): Promise<boolean> {
  const row = await db.session.findUniqueOrThrow({ where: { id } });
  return isSessionLive(row, (await loadLastEventBySession(db as never, [id])).get(id), new Date());
}

/** Wait for the fire-and-forget recorder to land its row. */
async function eventsFor(sessionId: string, n = 1) {
  for (let i = 0; i < 100; i++) {
    const rows = await db.usageEvent.findMany({ where: { sessionId } });
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('usage event never landed');
}

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'dy', urn: `dy-${t}` } });
  holder = await db.user.create({ data: { id: generateId(), githubId: 71001, githubUsername: `dy-h-${t}`, handle: `dy-h-${t}` } });
  other = await db.user.create({ data: { id: generateId(), githubId: 71002, githubUsername: `dy-o-${t}`, handle: `dy-o-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: other.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' } });
});

describe('DY-2 (#1653): a usage event on a lapsed session is attribution, never activity', () => {
  it('counts only for a live session the recorder owns', async () => {
    const liveOwn = await session({ idleMs: 1 * H, userId: holder.id });
    const lapsedOwn = await session({ idleMs: 30 * H, userId: holder.id });
    const appKeyLive = await session({ idleMs: 1 * H, userId: null });
    expect(await usageEventCountsAsActivity(db as never, { userId: holder.id }, liveOwn.id)).toBe(true);
    expect(await usageEventCountsAsActivity(db as never, { userId: holder.id }, lapsedOwn.id)).toBe(false);
    // Someone else's id (the client-supplied recordUsage case), and impersonation.
    expect(await usageEventCountsAsActivity(db as never, { userId: other.id }, liveOwn.id)).toBe(false);
    expect(await usageEventCountsAsActivity(db as never, { userId: holder.id, impersonation: {} }, liveOwn.id)).toBe(false);
    // A pure App key: only its own App's person-less sessions.
    expect(await usageEventCountsAsActivity(db as never, { appId: app.id }, appKeyLive.id)).toBe(true);
    expect(await usageEventCountsAsActivity(db as never, { appId: otherApp.id }, appKeyLive.id)).toBe(false);
    // bindSession's rule exactly: an App key owns every session of its App,
    // a user-bound (startAgentSession) one included (#1660 review, Baloo P2-1).
    expect(await usageEventCountsAsActivity(db as never, { appId: app.id }, liveOwn.id)).toBe(true);
  });

  it('the #1653 repro: an attributed read on a lapsed session leaves it lapsed', async () => {
    const lapsed = await session({ idleMs: 30 * H, userId: holder.id });
    recordNodeUsage(db, 'read', await aNode(), { userId: holder.id, sessionId: lapsed.id });
    const [ev] = await eventsFor(lapsed.id);
    expect(ev.countsAsActivity).toBe(false);
    expect(await live(lapsed.id)).toBe(false);
  });

  it('an attributed read on a LIVE session counts and keeps it live', async () => {
    const s = await session({ idleMs: 23.9 * H, userId: holder.id });
    recordNodeUsage(db, 'read', await aNode(), { userId: holder.id, sessionId: s.id });
    const [ev] = await eventsFor(s.id);
    expect(ev.countsAsActivity).toBe(true);
    expect(await live(s.id)).toBe(true);
  });

  it('recordUsage with SOMEONE ELSE\'S session id never keeps it live', async () => {
    const lapsed = await session({ idleMs: 30 * H, userId: holder.id });
    await M.recordUsage({}, { event: { type: 'read', sessionId: lapsed.id } }, userCtx(other.id));
    const ev = await db.usageEvent.findFirstOrThrow({ where: { userId: other.id } });
    expect(ev.sessionId).toBeNull();
    expect(ev.countsAsActivity).toBe(false);
    expect(await live(lapsed.id)).toBe(false);
  });
});

describe('#1660 review (local P2s): counting is atomic with what it counts', () => {
  it('P2-1: an event is stamped at the instant it was judged live, even if the insert lands after the deadline', async () => {
    // Live for one more second; the insert is delayed 1.5 s past that.
    const s = await db.session.create({
      data: { id: generateId(), type: 'DEVELOPER', userId: holder.id, appId: app.id, workerId: worker.id,
        startedAt: new Date(Date.now() - 2 * D), updatedAt: new Date(Date.now() - 24 * H + 1000) },
    });
    const deadline = Date.now() + 1000;
    const slow = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'usageEvent') {
          return new Proxy(target.usageEvent, {
            get(ue, p2, r2) {
              if (p2 === 'createMany') {
                return async (args: unknown) => {
                  await new Promise((r) => setTimeout(r, 1500));
                  return (ue.createMany as (a: unknown) => Promise<unknown>)(args);
                };
              }
              const v = Reflect.get(ue, p2, r2);
              return typeof v === 'function' ? v.bind(ue) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    recordNodeUsage(slow as never, 'read', await aNode(), { userId: holder.id, sessionId: s.id });
    const [ev] = await eventsFor(s.id);
    expect(ev.countsAsActivity).toBe(true);
    expect(ev.createdAt.getTime()).toBeLessThanOrEqual(deadline);
  });

  it('P2-2: a resume earned inside the caller\'s transaction rolls back if that transaction fails', async () => {
    const s = await session({ idleMs: 30 * H, userId: null });
    await expect(db.$transaction(async (tx) => {
      expect(await attributedRequestActivity(db, { appId: app.id }, s.id, { tx })).toBe(true);
      throw new Error('the insert that would have recorded the act failed');
    })).rejects.toThrow('the insert');
    expect(await live(s.id)).toBe(false);
    // Today recordUsage, the one caller that passes its transaction, refuses a
    // pure App key outright (it needs READER), so this is defence in depth.
    await expect(M.recordUsage({}, { event: { type: 'read', sessionId: s.id } }, appKeyCtx(app.id)))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

describe('DY-1: a pure App key resumes its OWN App\'s lapsed session by an attributed request', () => {
  it('resumes a person-less session of the key\'s App on an unheld worker', async () => {
    const s = await session({ idleMs: 30 * H, userId: null });
    expect(await attributedRequestActivity(db, { appId: app.id }, s.id)).toBe(true);
    expect(await live(s.id)).toBe(true);
  });

  it('refuses when the worker is HELD (a held name is a person\'s)', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: holder.id, heldAt: new Date() } });
    const s = await session({ idleMs: 30 * H, userId: null });
    expect(await attributedRequestActivity(db, { appId: app.id }, s.id)).toBe(false);
    expect(await live(s.id)).toBe(false);
  });

  it('refuses another App\'s key, and while another session on the worker is live', async () => {
    const s = await session({ idleMs: 30 * H, userId: null });
    expect(await attributedRequestActivity(db, { appId: otherApp.id }, s.id)).toBe(false);
    await session({ idleMs: 1 * H, userId: null }); // another live stint
    expect(await attributedRequestActivity(db, { appId: app.id }, s.id)).toBe(false);
    expect(await live(s.id)).toBe(false);
  });

  it('a USER with that App selected (hybrid principal) never resumes the App\'s App-key session (#1660 review, Rook P3-1)', async () => {
    const s = await session({ idleMs: 30 * H, userId: null });
    expect(await attributedRequestActivity(db, { userId: holder.id, appId: app.id }, s.id)).toBe(false);
    expect(await live(s.id)).toBe(false);
  });

  it('a USER\'s attributed request never resumes (users resume by post, read or mark-read)', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: holder.id, heldAt: new Date() } });
    const s = await session({ idleMs: 30 * H, userId: holder.id });
    expect(await attributedRequestActivity(db, { userId: holder.id }, s.id)).toBe(false);
    expect(await live(s.id)).toBe(false);
  });
});

describe('DY-5: a DORMANT session is past every agent act', () => {
  it('the holder\'s resume is refused DORMANT past the App threshold, and OK inside it', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: holder.id, heldAt: new Date() } });
    const recent = await session({ idleMs: 10 * D, userId: holder.id });
    expect(await lapsedResumeVerdict(userCtx(holder.id), recent.id)).toBe('OK');
    await db.session.update({ where: { id: recent.id }, data: { endedAt: new Date() } });
    const old = await session({ idleMs: 91 * D, userId: holder.id });
    expect(await lapsedResumeVerdict(userCtx(holder.id), old.id)).toBe('DORMANT');
  });

  it('the threshold is never shorter than the idle window, so a dormant session is always lapsed (#1660 review, Baloo P2-2)', async () => {
    process.env.SESSION_IDLE_WINDOW_DEVELOPER_MS = String(20 * D);
    try {
      await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: holder.id, heldAt: new Date() } });
      await db.app.update({ where: { id: app.id }, data: { sessionDormancyDays: 7 } });
      // Idle 10 days: past the 7-day setting, but still inside the 20-day window.
      const s = await session({ idleMs: 10 * D, userId: holder.id });
      expect(await live(s.id)).toBe(true);
      const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
      expect(isSessionDormant(row, null, 7, new Date())).toBe(false);
      // Past the window too: lapsed AND dormant.
      expect(isSessionDormant(row, null, 7, new Date(Date.now() + 11 * D))).toBe(true);
    } finally {
      delete process.env.SESSION_IDLE_WINDOW_DEVELOPER_MS;
    }
  });

  it('the threshold is per App', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: holder.id, heldAt: new Date() } });
    await db.app.update({ where: { id: app.id }, data: { sessionDormancyDays: 7 } });
    const s = await session({ idleMs: 10 * D, userId: holder.id });
    expect(await lapsedResumeVerdict(userCtx(holder.id), s.id)).toBe('DORMANT');
  });

  it('an App key cannot resume a dormant session either', async () => {
    const s = await session({ idleMs: 91 * D, userId: null });
    expect(await attributedRequestActivity(db, { appId: app.id }, s.id)).toBe(false);
    expect(await live(s.id)).toBe(false);
  });

  it('routing drops a dormant worker but keeps a merely lapsed one', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: holder.id, heldAt: new Date() } });
    await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
    const s = await session({ idleMs: 30 * H, userId: holder.id });
    const now = new Date();
    expect([...await resumableOwnWorkerIds(userCtx(holder.id), { userId: holder.id, appId: app.id, now })]).toEqual([worker.id]);
    const old = new Date(Date.now() - 91 * D);
    await db.session.update({ where: { id: s.id }, data: { startedAt: old, updatedAt: old } });
    expect([...await resumableOwnWorkerIds(userCtx(holder.id), { userId: holder.id, appId: app.id, now })]).toEqual([]);
  });

  it('updateApp refuses a non-positive threshold', async () => {
    await expect(M.updateApp({}, { ref: app.id, sessionDormancyDays: 0 }, userCtx(holder.id)))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const updated = await M.updateApp({}, { ref: app.id, sessionDormancyDays: 30 }, userCtx(holder.id));
    expect(updated.sessionDormancyDays).toBe(30);
  });
});

describe('DY-4: a locked encrypted memory says how to get its key back', () => {
  it('the SESSION_EXPIRED error carries the re-unlock hint', () => {
    expect(() => decryptNodeFields({ content: 'x' }, { id: generateId(), isEncrypted: true } as never))
      .toThrow(sessionKeyReleasedHint());
    expect(sessionKeyReleasedHint()).toMatch(/released after [\d.]+h unused .* hadron_unlock_memory/);
  });
});


describe('#1741: recordUsage follows App → Worker → Session lifecycle lock order', () => {
  // Ordinary App keys still fail READER. Supplying that role here reaches
  // the internal App-resume branch without widening the HTTP auth contract.
  const recorderCtx = () => ({ ...appKeyCtx(app.id), roles: ['READER'] }) as Context;

  it('does not hold the Session while waiting for the resume Worker lock', async () => {
    const s = await session({ idleMs: 30 * H, userId: null });
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const binder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${worker.id} FOR UPDATE`;
      locked();
      await gate;
    }, { timeout: 10000 });
    await ready;
    const recording = M.recordUsage({}, { event: { type: 'read', sessionId: s.id } }, recorderCtx());
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query LIKE '%FROM workers%FOR UPDATE%') AS waiting`;
        if (rows[0].waiting) { waiting = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      // A bind holding Worker must be free to update its Sessions next.
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${s.id} FOR UPDATE NOWAIT`;
      });
    } finally {
      release();
      await binder;
      await recording;
    }
    expect(await live(s.id)).toBe(true);
    expect(await db.usageEvent.findFirstOrThrow({ where: { sessionId: s.id } }))
      .toMatchObject({ countsAsActivity: true });
  });

  it('concurrent own-App recorders resume without a Session lock upgrade', async () => {
    const s = await session({ idleMs: 30 * H, userId: null });
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      M.recordUsage({}, { event: { type: 'read', sessionId: s.id } }, recorderCtx())));
    expect(results).toEqual([true, true, true, true]);
    expect(await db.usageEvent.count({ where: { sessionId: s.id, countsAsActivity: true } })).toBe(4);
    expect(await live(s.id)).toBe(true);
  });
});


describe('#1741 Rook P3: resume refuses foreign ownership before lifecycle locks', () => {
  it.each(['foreign-App', 'foreign-user', 'App-end-user'] as const)('%s takes no App or Worker locks', async (kind) => {
    const s = await session({ idleMs: 30 * H, userId: kind === 'App-end-user' ? holder.id : null });
    const principal = kind === 'foreign-App' ? appKeyCtx(otherApp.id)
      : kind === 'foreign-user' ? userCtx(other.id) : appKeyCtx(app.id);
    await db.$transaction(async (tx) => {
      const sql = vi.spyOn(tx, '$queryRaw');
      expect(await resumeOwnLapsedSessionInTx(principal, tx, s.id)).toBe(false);
      expect(sql).not.toHaveBeenCalled();
    });
    expect(await live(s.id)).toBe(false);
  });
});
