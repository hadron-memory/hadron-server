import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1956 — the worker resume claim (cor:agt:020:03; Holger via Vera #11904, the 60-second window #12291).
 *
 * A worker session's driver writes a claim before a deliberate context reset; the fresh context recovers its
 * worker with one call and no arguments. Pinned per Xylon's gate on the issue:
 *  - write a claim, then redeem it: one claim binds (the open session for a shed, a new session for a rotation);
 *  - two claims list, and nothing is consumed until the human picks;
 *  - an expired or used claim, and a non-holder's redemption, answer exactly as "nothing to resume";
 *  - single use under a race: of two concurrent redemptions one binds and the other is refused;
 *  - the fast path, both ways: one live bound session binds, two list rather than guess;
 *  - nothing is ever posted or written on the human's behalf on a refusal, and no claim id is ever shown.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { RESUME_CLAIM_TTL_MS, consumeResumeClaim, writeResumeClaim } from '../../../lib/resumeClaims.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, appId?: string): Context => ({ db, userId, appId, roles: ['READER'] }) as Context;

/** The whole observable refusal: message, code and every extension. */
async function envelope(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return JSON.stringify({ message: g.message, extensions: g.extensions });
  }
  throw new Error('expected a refusal');
}

let app: { id: string; urn: string };
let holder: string;
let other: string;
let ada: string;
let bea: string;

const start = (userId: string, workerRef: string, plan = 'work') =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef, plan } }, ctx(userId));
const claim = (userId: string, sessionId: string) => M.createResumeClaim({}, { sessionId }, ctx(userId));
const resume = (c: Context, input?: Record<string, unknown>) => M.resumeSession({}, { input: input ?? null }, c);
const nothingEnvelope = () => envelope(resume(ctx(generateId())));

/** Everything a refusal must leave untouched: no session, no node (a post is a node), no consumed claim. */
async function footprint() {
  return {
    sessions: await db.session.count(),
    nodes: await db.node.count(),
    consumed: await db.resumeClaim.count({ where: { consumedAt: { not: null } } }),
  };
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `r56-${name}-${n}`, roles: ['READER'] }, select: { id: true } }).then((r) => r.id);
  const admin = await u(81, 'admin');
  holder = await u(82, 'holder');
  other = await u(83, 'other');
  const org = await db.organization.create({ data: { name: 'Tenant', urn: `r56-${n}.example` }, select: { id: true, urn: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  const agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: other, role: 'member' } });
  const w = (name: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } }).then((r) => r.id);
  ada = await w('Ada');
  bea = await w('Bea');
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

describe('writing a claim', () => {
  it('lives 60 seconds from the write, for the session\'s own driver, and replaces an unused claim for the same session', async () => {
    const s = await start(holder, ada);
    const r = await claim(holder, s.id);
    expect(r).toMatchObject({ sessionId: s.id, workerId: ada });
    const row = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(row.expiresAt.getTime() - row.issuedAt.getTime()).toBe(RESUME_CLAIM_TTL_MS);
    expect(RESUME_CLAIM_TTL_MS).toBe(60_000);
    expect(row.holderUserId).toBe(holder);
    await claim(holder, s.id);
    expect(await db.resumeClaim.count({ where: { sessionId: s.id, revokedAt: null } })).toBe(1);
    // The receipt carries no claim id: there is nothing to present, so nothing to leak.
    expect(JSON.stringify(r)).not.toContain(row.id);
  });

  it('refuses someone else\'s session exactly as an absent one, an ended session, and a session with no worker', async () => {
    const s = await start(holder, ada);
    const missing = generateId();
    expect((await envelope(claim(other, s.id))).replace(s.id, missing)).toBe(await envelope(claim(other, missing)));
    const plain = await M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id } }, ctx(holder));
    expect(await envelope(claim(holder, plain.id))).toContain('SESSION_NOT_WORKER_BOUND');
    await M.endSession({}, { id: s.id }, ctx(holder));
    expect(await envelope(claim(holder, s.id))).toContain('SESSION_ENDED');
    expect(await db.resumeClaim.count()).toBe(0);
  });

  it('endSession writes the claim with the handoff, before the end', async () => {
    const s = await start(holder, ada);
    await M.endSession({}, { id: s.id, handoff: 'what landed', resumeClaim: true }, ctx(holder));
    const row = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(row.holderUserId).toBe(holder);
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).endedAt).not.toBeNull();
  });
});

describe('redeeming: one claim binds', () => {
  it('a shed (the session stays open): the open session is resumed, no new session, the claim spent', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    // A second live session would make the fast path list: the claim must decide, not the fast path.
    await start(holder, bea);
    const sessionsBefore = await db.session.count();
    const r = await resume(ctx(holder));
    expect(r.outcome).toBe('RESUMED');
    expect(r.session.id).toBe(s.id);
    expect(r.candidates).toEqual([]);
    expect(await db.session.count()).toBe(sessionsBefore);
    const row = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(row.consumedAt).not.toBeNull();
    expect(row.resumedSessionId).toBe(s.id);
  });

  it('a rotation (the session ended with its handoff): a new session starts for the worker and inherits the handoff', async () => {
    const s = await start(holder, ada);
    await M.endSession({}, { id: s.id, handoff: 'the open items', resumeClaim: true }, ctx(holder));
    const r = await resume(ctx(holder), { description: 'next stint' });
    expect(r.outcome).toBe('STARTED');
    expect(r.session.id).not.toBe(s.id);
    expect(r.session.workerId).toBe(ada);
    expect(r.session.userId).toBe(holder);
    expect(r.session.endedAt).toBeNull();
    const row = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(row.resumedSessionId).toBe(r.session.id);
    const continuity = await (resolvers as any).Worker.continuity(await db.worker.findUniqueOrThrow({ where: { id: ada } }), {}, ctx(holder));
    expect(continuity.handoff?.content ?? '').toContain('the open items');
  });
});

describe('several claims list; the human picks', () => {
  it('lists each worker with its session description, consumes nothing, and never shows a claim id', async () => {
    const a = await start(holder, ada, 'ada work');
    const b = await start(holder, bea, 'bea work');
    await claim(holder, a.id);
    await claim(holder, b.id);
    const r = await resume(ctx(holder));
    expect(r.outcome).toBe('CHOOSE');
    expect(r.session).toBeNull();
    expect(r.candidates.map((c: any) => [c.workerName, c.description, c.source]).sort()).toEqual([
      ['Ada', 'ada work', 'CLAIM'],
      ['Bea', 'bea work', 'CLAIM'],
    ]);
    expect(await db.resumeClaim.count({ where: { consumedAt: { not: null } } })).toBe(0);
    const ids = (await db.resumeClaim.findMany({ select: { id: true } })).map((c) => c.id);
    for (const id of ids) expect(JSON.stringify(r)).not.toContain(id);
    // The pick: by the listed session.
    const picked = await resume(ctx(holder), { session: b.id });
    expect(picked).toMatchObject({ outcome: 'RESUMED', session: { id: b.id } });
    expect(await db.resumeClaim.count({ where: { consumedAt: { not: null } } })).toBe(1);
  });
});

describe('nothing to resume: one answer, no oracle, no footprint', () => {
  it('an expired claim, a used claim and no claim at all answer identically', async () => {
    const none = await nothingEnvelope();
    expect(none).toContain('NOTHING_TO_RESUME');

    const s = await start(holder, ada);
    await M.endSession({}, { id: s.id, resumeClaim: true }, ctx(holder));
    await db.resumeClaim.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    let before = await footprint();
    expect(await envelope(resume(ctx(holder)))).toBe(none);
    expect(await envelope(resume(ctx(holder), { session: s.id }))).toBe(none);
    expect(await footprint()).toEqual(before);

    // Used: redeem a fresh claim for an ended session, end what it started, then present the spent one by its session.
    const s2 = await start(holder, ada);
    await M.endSession({}, { id: s2.id, resumeClaim: true }, ctx(holder));
    const r = await resume(ctx(holder));
    expect(r.outcome).toBe('STARTED');
    await M.endSession({}, { id: r.session.id }, ctx(holder));
    before = await footprint();
    expect(await envelope(resume(ctx(holder), { session: s2.id }))).toBe(none);
    expect(await envelope(resume(ctx(holder)))).toBe(none);
    expect(await footprint()).toEqual(before);
  });

  it('a non-holder, an App key and an impersonation learn nothing, and the holder\'s claim survives their probes', async () => {
    const none = await nothingEnvelope();
    const s = await start(holder, ada);
    await claim(holder, s.id);
    const before = await footprint();
    expect(await envelope(resume(ctx(other)))).toBe(none);
    expect(await envelope(resume(ctx(other), { session: s.id }))).toBe(none);
    expect(await envelope(resume({ db, appId: app.id, roles: [] } as unknown as Context))).toBe(none);
    expect(await envelope(resume({ ...ctx(holder), impersonation: { actorUserId: other } } as unknown as Context))).toBe(none);
    expect(await footprint()).toEqual(before);
    expect((await resume(ctx(holder))).session.id).toBe(s.id);
  });
});

describe('single use under a race', () => {
  it('of two concurrent redemptions of one claim, exactly one binds and the other is refused', async () => {
    const none = await nothingEnvelope();
    const s = await start(holder, ada);
    await M.endSession({}, { id: s.id, resumeClaim: true }, ctx(holder));
    const results = await Promise.allSettled([resume(ctx(holder)), resume(ctx(holder))]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(await envelope(Promise.reject(lost[0].reason))).toBe(none);
    expect(await db.session.count({ where: { workerId: ada, endedAt: null } })).toBe(1);
  });
});

describe('the consume guard itself', () => {
  // The resolver-level race above can pass without the guard (the loser often reads the claim already spent), so
  // the guard is pinned directly: a spent claim never consumes again, concurrently or later, and a claim is never
  // consumed for anyone but its holder.
  it('consumes once: concurrent and repeated consumes of one claim succeed exactly once', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    const { id } = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    const wins = await Promise.all([1, 2, 3, 4].map(() => consumeResumeClaim(db, id, holder)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await consumeResumeClaim(db, id, holder)).toBe(false);
  });

  it('never consumes for a non-holder, an expired claim or a revoked one', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    const first = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(await consumeResumeClaim(db, first.id, other)).toBe(false);
    await claim(holder, s.id); // revokes the first
    expect(await consumeResumeClaim(db, first.id, holder)).toBe(false);
    const second = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id, revokedAt: null } });
    expect(await consumeResumeClaim(db, second.id, holder)).toBe(true);
    const third = await claim(holder, s.id).then(() => db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id, revokedAt: null, consumedAt: null } }));
    await db.resumeClaim.update({ where: { id: third.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await consumeResumeClaim(db, third.id, holder)).toBe(false);
  });
});

describe('the fast path, no claim', () => {
  it('exactly one live bound session binds to it', async () => {
    const s = await start(holder, ada);
    const r = await resume(ctx(holder));
    expect(r).toMatchObject({ outcome: 'RESUMED', session: { id: s.id }, candidates: [] });
  });

  it('two live bound sessions list rather than guess', async () => {
    await start(holder, ada, 'ada work');
    await start(holder, bea, 'bea work');
    const r = await resume(ctx(holder));
    expect(r.outcome).toBe('CHOOSE');
    expect(r.session).toBeNull();
    expect(r.candidates.map((c: any) => [c.workerName, c.source]).sort()).toEqual([['Ada', 'LIVE_SESSION'], ['Bea', 'LIVE_SESSION']]);
  });

  it('counts only the caller\'s own sessions that read live, and never a plain session', async () => {
    const none = await nothingEnvelope();
    await start(other, ada);
    await M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id } }, ctx(holder));
    expect(await envelope(resume(ctx(holder)))).toBe(none);
    const mine = await start(holder, bea);
    await db.session.update({ where: { id: mine.id }, data: { updatedAt: new Date(0), startedAt: new Date(0) } });
    expect(await envelope(resume(ctx(holder)))).toBe(none);
  });
});

describe('MCP: hadron_resume_session and the claim tools', () => {
  const mcp = (userId: string) => createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` }, { sessionId: generateId() });

  it('a shed through MCP: write the claim, then one no-argument call binds and returns the briefing', async () => {
    const s = await start(holder, ada);
    const srv = mcp(holder);
    expect(await srv.callToolText('hadron_create_resume_claim', { session: s.id })).toContain('60');
    const text = await srv.callToolText('hadron_resume_session', {});
    expect(text).toContain(`Session resumed: ${s.id}`);
    expect(text).toContain('Working as Ada');
  });

  it('a rotation through MCP: end with the claim, then the no-argument call starts the next stint', async () => {
    const s = await start(holder, ada);
    const srv = mcp(holder);
    await srv.callToolText('hadron_end_session', { id: s.id, handoff: 'open items', resumeClaim: true });
    const text = await srv.callToolText('hadron_resume_session', {});
    expect(text).toMatch(/Session started: \S+/);
    expect(text).toContain('Working as Ada');
    expect(text).toContain('open items');
  });

  it('several claims list by worker name and session id, with no claim id; nothing is a typed refusal that binds nothing', async () => {
    const a = await start(holder, ada, 'ada work');
    const b = await start(holder, bea, 'bea work');
    await claim(holder, a.id);
    await claim(holder, b.id);
    const srv = mcp(holder);
    const list = await srv.callToolText('hadron_resume_session', {});
    expect(list).toContain('Ada');
    expect(list).toContain('Bea');
    expect(list).toContain(a.id);
    for (const { id } of await db.resumeClaim.findMany({ select: { id: true } })) expect(list).not.toContain(id);
    const before = await footprint();
    const none = await mcp(other).callToolText('hadron_resume_session', {});
    expect(none).toContain('NOTHING_TO_RESUME');
    expect(await footprint()).toEqual(before);
  });
});

describe('fix head: Anne\'s blind review on #1966', () => {
  it('P2-1: a claim is recovery intent, not a waiver — the name moved to another holder refuses, nothing is touched', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    // Lapse the claimed session, release the name, and let another member bind the worker.
    await db.session.update({ where: { id: s.id }, data: { startedAt: new Date(0), updatedAt: new Date(0) } });
    await db.worker.update({ where: { id: ada }, data: { heldByUserId: null, heldAt: null } });
    const theirs = await start(other, ada);
    const before = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(await envelope(resume(ctx(holder)))).toContain('RESUME_REFUSED');
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).updatedAt).toEqual(before.updatedAt);
    expect((await db.session.findUniqueOrThrow({ where: { id: theirs.id } })).endedAt).toBeNull();
  });

  it('P2-1: driving authority revoked after the claim refuses (the holder left the App)', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    await db.appMember.deleteMany({ where: { appId: app.id, userId: holder } });
    expect(await envelope(resume(ctx(holder)))).toContain('RESUME_REFUSED');
  });

  it('P2-1: a session past its hard expiry refuses, and so does the fast path', async () => {
    const s = await start(holder, ada);
    await db.session.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await claim(holder, s.id);
    expect(await envelope(resume(ctx(holder)))).toContain('RESUME_REFUSED');
    // #1036: once the claim is spent, a hard-expired row is not a LIVE
    // fast-path candidate, even before the reaper records its end.
    expect(await envelope(resume(ctx(holder), { session: s.id }))).toContain('NOTHING_TO_RESUME');
  });

  it('P2-1: an end racing the selection is never answered RESUMED', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    // The session ends between the redemption's read and its touch: the shared gate re-decides under the lock.
    const ending = new Proxy(db, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return async (...args: unknown[]) => {
          await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const r = await resume({ ...ctx(holder), db: ending } as Context).catch((e: GraphQLError) => e);
    expect(r instanceof GraphQLError ? r.extensions.code : (r as any).outcome).not.toBe('RESUMED');
  });

  it('P2-2: the fast path decides on the whole live pool — 60 quiet open sessions never hide a second live one', async () => {
    const day = 24 * 60 * 60 * 1000;
    const live1 = await start(holder, ada);
    const live2 = await start(holder, bea);
    // Started 10 days ago but driven just now: live, and sorted after every quiet row by startedAt.
    await db.$executeRaw`UPDATE sessions SET started_at = ${new Date(Date.now() - 10 * day)} WHERE id = ${live2.id}`;
    // 60 open sessions started 2 days ago and never driven since: not live, but newer than live2 by startedAt.
    const quietStart = new Date(Date.now() - 2 * day);
    const quiet = Array.from({ length: 60 }, () => generateId());
    await db.session.createMany({
      data: quiet.map((id) => ({ id, userId: holder, appId: app.id, workerId: ada, type: 'DEVELOPER' as const, startedAt: quietStart })),
    });
    await db.$executeRawUnsafe(`UPDATE sessions SET updated_at = $1 WHERE id = ANY($2)`, quietStart, quiet);
    const r = await resume(ctx(holder));
    expect(r.outcome).toBe('CHOOSE');
    expect(r.candidates.map((c: any) => c.sessionId).sort()).toEqual([live1.id, live2.id].sort());
  });

  it('P2-3: expiry is judged at the transition by the database clock, not by a timestamp read before a wait', async () => {
    const s = await start(holder, ada);
    await M.endSession({}, { id: s.id, resumeClaim: true }, ctx(holder));
    // The claim lapses while the redemption is paused between its read and its consume.
    const pausing = new Proxy(db, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== 'resumeClaim') return typeof v === 'function' ? v.bind(target) : v;
        return new Proxy(v as object, {
          get(t, p) {
            const f = Reflect.get(t, p) as (...a: unknown[]) => Promise<unknown>;
            if (p !== 'findMany') return typeof f === 'function' ? f.bind(t) : f;
            return async (...a: unknown[]) => {
              // The redemption read its clock before this call. The claim lapses at t0 + 5 ms, after that read and
              // before the consume, which runs once this returns, 30 ms later.
              const t0 = Date.now();
              await new Promise((r) => setTimeout(r, 15));
              const rows = await f.apply(t, a);
              await db.resumeClaim.updateMany({ data: { expiresAt: new Date(t0 + 5) } });
              await new Promise((r) => setTimeout(r, 15));
              return rows;
            };
          },
        });
      },
    });
    const before = await db.session.count();
    const r = await resume({ ...ctx(holder), db: pausing } as Context).catch((e: GraphQLError) => e);
    expect(r).toBeInstanceOf(GraphQLError);
    expect((r as GraphQLError).extensions.code).toBe('NOTHING_TO_RESUME');
    expect(await db.session.count()).toBe(before);
  });

  it('P3: concurrent claim writes for one session leave exactly one live claim', async () => {
    const s = await start(holder, ada);
    await Promise.all(Array.from({ length: 20 }, () => claim(holder, s.id)));
    expect(await db.resumeClaim.count({ where: { sessionId: s.id, revokedAt: null, consumedAt: null } })).toBe(1);
  });
});

describe('fix head 2: Anne\'s delta on #1966', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('P2-3: a consume that waits on a lock released unchanged after the deadline does not consume', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    const row = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    await db.$executeRaw`UPDATE resume_claims SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') + interval '400 milliseconds' WHERE id = ${row.id}`;
    // A holds the claim's row lock past its deadline and releases it without changing the row.
    const holderTx = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM resume_claims WHERE id = ${row.id} FOR UPDATE`;
      await sleep(900);
    }, { timeout: 10_000 });
    await sleep(100);
    const consumed = await consumeResumeClaim(db, row.id, holder);
    await holderTx;
    expect(consumed).toBe(false);
    expect((await db.resumeClaim.findUniqueOrThrow({ where: { id: row.id } })).consumedAt).toBeNull();
  });

  it('P2-4: a claim replacement racing an open redemption never deadlocks, and the outcome is coherent', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    // The writer takes the session lock, then pauses before touching the claims; the redemption starts meanwhile.
    const pausingWriter = new Proxy(db, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const paused = new Proxy(tx, {
              get(t, p) {
                const f = Reflect.get(t, p);
                if (p !== '$queryRaw') return typeof f === 'function' ? f.bind(t) : f;
                return async (...a: unknown[]) => {
                  const r = await (f as (...x: unknown[]) => Promise<unknown>).apply(t, a);
                  await sleep(500);
                  return r;
                };
              },
            });
            return fn(paused);
          }, { timeout: 10_000 });
      },
    });
    const writing = writeResumeClaim(pausingWriter as typeof db, { sessionId: s.id, appId: app.id, workerId: ada, holderUserId: holder });
    await sleep(150);
    const redeeming = resume(ctx(holder)).then((r: any) => ({ ok: r }), (e: unknown) => ({ err: e }));
    const [w, r] = await Promise.allSettled([writing, redeeming]);
    expect(w.status).toBe('fulfilled');
    const out = (r as PromiseFulfilledResult<any>).value;
    if (out.err) {
      expect(String((out.err as GraphQLError).extensions?.code), String((out.err as Error).message)).toBe('NOTHING_TO_RESUME');
    } else {
      expect(out.ok.outcome).toBe('RESUMED');
    }
    // Either way exactly one claim is still unconsumed and unrevoked unless the redemption spent it.
    const live = await db.resumeClaim.count({ where: { sessionId: s.id, consumedAt: null, revokedAt: null } });
    const consumed = await db.resumeClaim.count({ where: { sessionId: s.id, consumedAt: { not: null } } });
    expect(live + consumed).toBe(1);
  });
});

describe('a refused resumeClaim writes no handoff (found composing with #1938)', () => {
  // A handoff is a node; nothing else in these ends writes one, so the node count is the handoff count.
  const handoffs = () => db.node.count();

  it('GraphQL: someone else\'s endSession(handoff, resumeClaim) refuses before the handoff, and nothing ends', async () => {
    const s = await start(holder, ada);
    // An App key may end this App's user-less sessions; give the session no user so #1938's gate admits the key.
    await db.session.update({ where: { id: s.id }, data: { userId: null } });
    const key = { db, appId: app.id, roles: [] } as unknown as Context;
    const before = await handoffs();
    await expect(M.endSession({}, { id: s.id, handoff: 'prose', resumeClaim: true }, key)).rejects.toThrow();
    expect(await handoffs()).toBe(before);
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).endedAt).toBeNull();
    expect(await db.resumeClaim.count()).toBe(0);
  });

  it('MCP: hadron_end_session(handoff, resumeClaim) on a session that cannot take a claim writes no handoff', async () => {
    const s = await start(holder, ada);
    await db.session.update({ where: { id: s.id }, data: { userId: null } });
    const srv = createTestableMcpServer({ appId: app.id, roles: [] } as never, { sessionId: generateId() });
    const before = await handoffs();
    const text = await srv.callToolText('hadron_end_session', { id: s.id, handoff: 'prose', resumeClaim: true });
    expect(text).toContain('No resume claim was written');
    expect(await handoffs()).toBe(before);
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).endedAt).toBeNull();
  });
});
