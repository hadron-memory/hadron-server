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
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { RESUME_CLAIM_TTL_MS } from '../../../lib/resumeClaims.js';
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
  const w = (name: string) => db.worker.create({ data: { appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } }).then((r) => r.id);
  ada = await w('Ada');
  bea = await w('Bea');
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
    const continuity = await (resolvers as any).Worker.continuity({ id: ada, appId: app.id }, {}, ctx(holder));
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
