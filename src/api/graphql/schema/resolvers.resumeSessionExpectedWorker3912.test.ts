import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #3912 — the three gaps #3901 left in resumeSession(expectedWorkerId) (cor:agt:020:03; gate: Xul, Victor's FIT 6785345319).
 *  1. firstLiveWorkerSessionOf's overflow refusal: a full scanned page with nothing live in it is RESUME_AMBIGUOUS.
 *  2. The claim pick scope of the mismatch read (Rook's mutant M2): a pick that is not the caller's answers
 *     NOTHING_TO_RESUME even while one of the caller's own claims for another worker waits.
 *  3. A non-id expectedWorkerId (a URN or a name) refuses BAD_USER_INPUT before any read.
 * Header of the file this was cut from, kept for the shared setup:
 * #3822 — resumeSession with an expected worker (cor:agt:020:03, Vera's FIT 6762455524 and ruling 6762811449).
 *
 * On 2026-11-09 a no-argument resume in Jonas's worktree redeemed Greer's waiting claim and bound Greer there. The
 * CLI now sends the worktree's last-bound worker as `expectedWorkerId` (hadron-cli#1839). With it, the call is the
 * no-argument resume restricted to that worker:
 *  - a claim or live session of the expected worker A binds A, even when another worker B's claim waits too;
 *  - nothing of A's waits but something of the caller's for B does (a claim, or one live session): refused
 *    RESUME_REFUSED / WORKER_MISMATCH naming both, before any write — no claim consumed, no session created,
 *    ended or touched;
 *  - nothing of the caller's waits at all: today's NOTHING_TO_RESUME, byte for byte, naming no one;
 *  - the field absent: unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { OPEN_SESSION_SCAN_CAP } from '../../../lib/sessionActivity.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, appId?: string): Context => ({ db, userId, appId, roles: ['READER'] }) as Context;

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return e as GraphQLError;
  }
  throw new Error('expected a refusal');
}
const envelope = async (p: Promise<unknown>) => {
  const g = await refusal(p);
  return JSON.stringify({ message: g.message, extensions: g.extensions });
};

let app: { id: string; urn: string };
let holder: string;
let other: string;
let agentId: string;
let ada: string;
let bea: string;

const start = (userId: string, workerRef: string, plan = 'work') =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef, plan } }, ctx(userId));
const claim = (userId: string, sessionId: string) => M.createResumeClaim({}, { sessionId }, ctx(userId));
const resume = (c: Context, input?: Record<string, unknown>) => M.resumeSession({}, { input: input ?? null }, c);
const nothingEnvelope = () => envelope(resume(ctx(generateId())));

/** Everything a refusal must leave untouched. */
async function footprint() {
  return {
    sessions: await db.session.findMany({ orderBy: { id: 'asc' }, select: { id: true, endedAt: true, updatedAt: true, workerId: true } }),
    claims: await db.resumeClaim.findMany({ orderBy: { id: 'asc' }, select: { id: true, consumedAt: true, revokedAt: true, resumedSessionId: true } }),
    nodes: await db.node.count(),
    holds: await db.worker.findMany({ orderBy: { id: 'asc' }, select: { id: true, heldByUserId: true } }),
  };
}

/** Bea's session, its claim written (a shed), and Ada with nothing waiting. */
async function beaClaimOnly() {
  const b = await start(holder, bea, 'bea work');
  await claim(holder, b.id);
  return b;
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `r3822-${name}-${n}`, roles: ['READER'] }, select: { id: true } }).then((r) => r.id);
  const admin = await u(91, 'admin');
  holder = await u(92, 'holder');
  other = await u(93, 'other');
  const org = await db.organization.create({ data: { name: 'Tenant', urn: `r3822-${n}.example` }, select: { id: true, urn: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: other, role: 'member' } });
  const w = (name: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } }).then((r) => r.id);
  ada = await w('Ada');
  bea = await w('Bea');
  await serveEveryAgent(db);
});


describe('#3912 resumeSession(expectedWorkerId) gaps', () => {
  it('(1) nothing of A, the caller\'s B sessions fill the scanned page with non-live rows and a live one sits past it: RESUME_AMBIGUOUS, footprint unchanged', async () => {
    const now = Date.now();
    const day = 24 * 3600_000;
    // Admitted by the recently-touched filter (updatedAt is fresh) but not live: autoExpiredAt makes the heartbeat not count.
    const fillers = Array.from({ length: OPEN_SESSION_SCAN_CAP }, () => generateId());
    await db.session.createMany({
      data: fillers.map((id) => ({
        id, userId: holder, appId: app.id, workerId: bea, type: 'DEVELOPER' as const,
        startedAt: new Date(now - 2 * day), updatedAt: new Date(now), autoExpiredAt: new Date(now - 3600_000),
      })),
    });
    // A genuinely live session of B, ordered after the page (older startedAt, fresh heartbeat).
    const live = generateId();
    await db.session.create({ data: { id: live, userId: holder, appId: app.id, workerId: bea, type: 'DEVELOPER' as const, startedAt: new Date(now - 3 * day), updatedAt: new Date(now) } });
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada }));
    expect(g.extensions.code).toBe('RESUME_AMBIGUOUS');
    expect(await footprint()).toEqual(before);
  });

  it('(1b) the same page with no live session past it is NOT ambiguous: nothing live anywhere answers NOTHING_TO_RESUME', async () => {
    const none = await nothingEnvelope();
    const now = Date.now();
    const ids = Array.from({ length: OPEN_SESSION_SCAN_CAP - 1 }, () => generateId());
    await db.session.createMany({
      data: ids.map((id) => ({
        id, userId: holder, appId: app.id, workerId: bea, type: 'DEVELOPER' as const,
        startedAt: new Date(now - 48 * 3600_000), updatedAt: new Date(now), autoExpiredAt: new Date(now - 3600_000),
      })),
    });
    expect(await envelope(resume(ctx(holder), { expectedWorkerId: ada }))).toBe(none);
  });

  it('(2) a claim pick of another user\'s claim, while the caller\'s own B claim waits, expected A: NOTHING_TO_RESUME byte for byte, no claim consumed', async () => {
    const none = await nothingEnvelope();
    const cy = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Cy', slug: 'cy' },
      select: { id: true },
    });
    const theirs = await start(other, cy.id, 'cy work');
    await claim(other, theirs.id);
    await beaClaimOnly();
    const before = await footprint();
    expect(await envelope(resume(ctx(holder), { expectedWorkerId: ada, session: theirs.id }))).toBe(none);
    expect(await footprint()).toEqual(before);
    // The caller's own B claim still waits and is redeemable by naming B.
    expect(await resume(ctx(holder), { expectedWorkerId: bea })).toMatchObject({ outcome: 'RESUMED' });
  });

  it.each([
    ['a URN', 'hrn:worker:hadronmemory.com:team:ada'],
    ['a name', 'Ada'],
    ['an uppercase hex', '01A1CA12D23D770E90EC84B195A42D43'],
    ['a short hex', 'abc123'],
  ])('(3) %s as expectedWorkerId refuses BAD_USER_INPUT before any read, even with Bea\'s claim waiting', async (_label, bad) => {
    await beaClaimOnly();
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: bad }));
    expect(g.extensions.code).toBe('BAD_USER_INPUT');
    expect(g.message).not.toContain('Bea');
    expect(await footprint()).toEqual(before);
  });

  it('(3) the refusal comes after the concealing answer: an App key learns nothing about the value, and a valid id is unchanged', async () => {
    const none = await nothingEnvelope();
    expect(await envelope(resume({ db, appId: app.id, roles: [] } as unknown as Context, { expectedWorkerId: 'Ada' }))).toBe(none);
    const a = await start(holder, ada);
    expect(await resume(ctx(holder), { expectedWorkerId: ada })).toMatchObject({ outcome: 'RESUMED', session: { id: a.id } });
  });

  it('(3) the published SDL states the refusal beside the blank one', () => {
    expect(typeDefs.includes('Blank or not an id (a URN or a name): BAD_USER_INPUT')).toBe(true);
  });
});
