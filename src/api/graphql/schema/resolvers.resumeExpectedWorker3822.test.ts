import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
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

describe('#3822 mismatch: nothing of the expected worker waits, something of another worker of the caller does', () => {
  it('a waiting claim of B only, expected A: refused WORKER_MISMATCH naming both; B\'s claim unconsumed and redeemable', async () => {
    const b = await beaClaimOnly();
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada }));
    expect(g.extensions).toMatchObject({
      code: 'RESUME_REFUSED',
      reason: 'WORKER_MISMATCH',
      expectedWorkerId: ada,
      expectedWorkerName: 'Ada',
      foundWorkerId: bea,
      foundWorkerName: 'Bea',
      foundSource: 'CLAIM',
    });
    expect(g.message).toContain('Ada');
    expect(g.message).toContain('Bea');
    expect(await footprint()).toEqual(before);
    // B's claim still waits: a resume naming B redeems it.
    const r = await resume(ctx(holder), { expectedWorkerId: bea });
    expect(r).toMatchObject({ outcome: 'RESUMED', session: { id: b.id } });
  });

  it('a rotated B (claim on an ended session), expected A: refused before any session is started', async () => {
    const b = await start(holder, bea);
    await M.endSession({}, { id: b.id, handoff: 'h', resumeClaim: true }, ctx(holder));
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada }));
    expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', foundWorkerId: bea });
    expect(await footprint()).toEqual(before);
  });

  it('no claim, one live session of B, expected A: refused naming both; B\'s session unchanged and a no-argument resume adopts it', async () => {
    const b = await start(holder, bea);
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada }));
    expect(g.extensions).toMatchObject({
      code: 'RESUME_REFUSED',
      reason: 'WORKER_MISMATCH',
      expectedWorkerId: ada,
      expectedWorkerName: 'Ada',
      foundWorkerId: bea,
      foundWorkerName: 'Bea',
      foundSource: 'LIVE_SESSION',
    });
    expect(await footprint()).toEqual(before);
    expect(await resume(ctx(holder))).toMatchObject({ outcome: 'RESUMED', session: { id: b.id } });
  });

  it('the expected worker was ended and released: still refused when only another worker\'s claim waits', async () => {
    const a = await start(holder, ada);
    await M.endSession({}, { id: a.id }, ctx(holder));
    await db.worker.update({ where: { id: ada }, data: { heldByUserId: null, heldAt: null } });
    await beaClaimOnly();
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada }));
    expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', expectedWorkerName: 'Ada', foundWorkerId: bea });
    expect(await footprint()).toEqual(before);
  });

  it('picking B\'s session by `session` with expected A is the same mismatch, and consumes nothing', async () => {
    const b = await beaClaimOnly();
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada, session: b.id }));
    expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', foundWorkerId: bea });
    expect(await footprint()).toEqual(before);
  });

  it('an expected worker outside the found item\'s App is echoed by id but never named (no id-to-name oracle)', async () => {
    const elsewhere = await db.app.create({ data: { organizationId: (await db.app.findUniqueOrThrow({ where: { id: app.id } })).organizationId, name: 'Elsewhere', urn: `${app.urn}-x` }, select: { id: true } });
    const cy = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: elsewhere.id, agentId, name: 'Cy', slug: 'cy' }, select: { id: true } })).id;
    await beaClaimOnly();
    const unknown = generateId();
    for (const expected of [cy, unknown]) {
      const g = await refusal(resume(ctx(holder), { expectedWorkerId: expected }));
      expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', expectedWorkerId: expected, expectedWorkerName: null, foundWorkerId: bea });
      expect(g.message).not.toContain('Cy');
    }
  });
});

describe('#3822 the expected worker wins', () => {
  it('A\'s and B\'s claims both waiting, expected A: binds A, B\'s claim stays waiting', async () => {
    const a = await start(holder, ada);
    await claim(holder, a.id);
    const b = await beaClaimOnly();
    const r = await resume(ctx(holder), { expectedWorkerId: ada });
    expect(r).toMatchObject({ outcome: 'RESUMED', session: { id: a.id }, candidates: [] });
    const bClaim = await db.resumeClaim.findFirstOrThrow({ where: { sessionId: b.id } });
    expect(bClaim.consumedAt).toBeNull();
    expect(bClaim.revokedAt).toBeNull();
  });

  it('a live session of A alongside B\'s claim: binds A, B\'s claim untouched', async () => {
    const a = await start(holder, ada);
    const b = await beaClaimOnly();
    const r = await resume(ctx(holder), { expectedWorkerId: ada });
    expect(r).toMatchObject({ outcome: 'RESUMED', session: { id: a.id } });
    expect((await db.resumeClaim.findFirstOrThrow({ where: { sessionId: b.id } })).consumedAt).toBeNull();
    expect((await db.session.findUniqueOrThrow({ where: { id: b.id } })).endedAt).toBeNull();
  });

  it('a claim of A alongside a live session of B: binds A, B\'s session untouched', async () => {
    const a = await start(holder, ada);
    await M.endSession({}, { id: a.id, handoff: 'h', resumeClaim: true }, ctx(holder));
    const b = await start(holder, bea);
    const bBefore = await db.session.findUniqueOrThrow({ where: { id: b.id } });
    const r = await resume(ctx(holder), { expectedWorkerId: ada });
    expect(r.outcome).toBe('STARTED');
    expect(r.session.workerId).toBe(ada);
    expect(await db.session.findUniqueOrThrow({ where: { id: b.id } })).toEqual(bBefore);
  });

  it('two claims of A and one of B, expected A: lists only A\'s, consuming nothing', async () => {
    // Two open sessions of one worker cannot coexist live; a claim of an ended session and a shed one can.
    const a1 = await start(holder, ada, 'first');
    await M.endSession({}, { id: a1.id, resumeClaim: true }, ctx(holder));
    const a2 = await start(holder, ada, 'second');
    await claim(holder, a2.id);
    await beaClaimOnly();
    const r = await resume(ctx(holder), { expectedWorkerId: ada });
    expect(r.outcome).toBe('CHOOSE');
    expect(r.candidates.map((c: any) => c.workerName)).toEqual(['Ada', 'Ada']);
    expect(await db.resumeClaim.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('expected worker equals the one waiting claim\'s worker: resumes as today', async () => {
    const b = await beaClaimOnly();
    expect(await resume(ctx(holder), { expectedWorkerId: bea })).toMatchObject({ outcome: 'RESUMED', session: { id: b.id } });
  });
});

describe('#3822 unchanged answers', () => {
  it('field absent: a lone B claim binds B, as today', async () => {
    const b = await beaClaimOnly();
    expect(await resume(ctx(holder))).toMatchObject({ outcome: 'RESUMED', session: { id: b.id } });
  });

  it('nothing of the caller\'s waits: today\'s NOTHING_TO_RESUME byte for byte, naming no one', async () => {
    const none = await nothingEnvelope();
    // The holder has nothing; another user has claims and live sessions of both workers.
    const o = await start(other, bea);
    await claim(other, o.id);
    const before = await footprint();
    expect(await envelope(resume(ctx(holder), { expectedWorkerId: ada }))).toBe(none);
    expect(await envelope(resume(ctx(holder), { expectedWorkerId: bea }))).toBe(none);
    expect(await envelope(resume(ctx(holder), { expectedWorkerId: generateId() }))).toBe(none);
    // A non-holder, an App key and an impersonation probing with the holder's worker learn nothing either.
    expect(await envelope(resume({ db, appId: app.id, roles: [] } as unknown as Context, { expectedWorkerId: ada }))).toBe(none);
    expect(await envelope(resume({ ...ctx(other), impersonation: { actorUserId: holder } } as unknown as Context, { expectedWorkerId: ada }))).toBe(none);
    expect(await footprint()).toEqual(before);
  });

  it('a blank expectedWorkerId is refused as bad input before any read, and only for a real caller', async () => {
    const none = await nothingEnvelope();
    await beaClaimOnly();
    const before = await footprint();
    expect((await refusal(resume(ctx(holder), { expectedWorkerId: '  ' }))).extensions.code).toBe('BAD_USER_INPUT');
    expect(await envelope(resume({ db, appId: app.id, roles: [] } as unknown as Context, { expectedWorkerId: '' }))).toBe(none);
    expect(await footprint()).toEqual(before);
  });
});

describe('#3901 BLIND fix head (Glen)', () => {
  /** `count` open sessions of `workerId` that read live now (recently touched), written directly. */
  async function liveRows(workerId: string, count: number) {
    const ids = Array.from({ length: count }, () => generateId());
    await db.session.createMany({ data: ids.map((id) => ({ id, userId: holder, appId: app.id, workerId, type: 'DEVELOPER' as const })) });
    return ids;
  }

  it('P2: other workers\' sessions past the scan cap never block resuming the expected worker\'s one live session', async () => {
    const a = await start(holder, ada);
    await liveRows(bea, OPEN_SESSION_SCAN_CAP + 1);
    // Without the narrowing the whole pool is over the cap: today's no-argument answer refuses RESUME_AMBIGUOUS.
    expect((await refusal(resume(ctx(holder)))).extensions.code).toBe('RESUME_AMBIGUOUS');
    expect(await resume(ctx(holder), { expectedWorkerId: ada })).toMatchObject({ outcome: 'RESUMED', session: { id: a.id } });
  });

  it('P2: nothing of A, other workers\' live sessions past the cap: still the mismatch, nothing touched', async () => {
    await liveRows(bea, OPEN_SESSION_SCAN_CAP + 1);
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada }));
    expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', foundWorkerId: bea, foundSource: 'LIVE_SESSION' });
    expect(await footprint()).toEqual(before);
  });

  it('LOCAL P2 (Gene): an older A claim behind 50 newer B claims still binds A; B\'s claims all stay', async () => {
    // A rotation: A's session ended with its claim, so only the claim (never the live pool) can bind A.
    const a = await start(holder, ada);
    await M.endSession({}, { id: a.id, handoff: 'h', resumeClaim: true }, ctx(holder));
    const t = Date.now();
    const sids = Array.from({ length: 50 }, () => generateId());
    await db.session.createMany({ data: sids.map((id) => ({ id, userId: holder, appId: app.id, workerId: bea, type: 'DEVELOPER' as const, endedAt: new Date() })) });
    await db.resumeClaim.createMany({
      data: sids.map((sessionId, i) => ({
        id: generateId(), appId: app.id, sessionId, workerId: bea, holderUserId: holder,
        issuedAt: new Date(t + 1000 + i), expiresAt: new Date(t + 60_000),
      })),
    });
    expect(await resume(ctx(holder), { expectedWorkerId: ada })).toMatchObject({ outcome: 'STARTED', session: { workerId: ada } });
    expect(await db.resumeClaim.count({ where: { workerId: bea, consumedAt: null, revokedAt: null } })).toBe(50);
  });

  it('P3-1: a pick of B\'s claim while A\'s claim waits says the pick is B\'s, not that nothing of A\'s waits; A\'s claim stays', async () => {
    const a = await start(holder, ada);
    await claim(holder, a.id);
    const b = await beaClaimOnly();
    const before = await footprint();
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada, session: b.id }));
    expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', picked: true, foundWorkerId: bea, foundSource: 'CLAIM' });
    expect(g.message).toContain('The session you picked is Bea');
    expect(g.message).not.toContain('Nothing of Ada');
    expect(await footprint()).toEqual(before);
    // A's claim still binds A.
    expect(await resume(ctx(holder), { expectedWorkerId: ada })).toMatchObject({ outcome: 'RESUMED', session: { id: a.id } });
  });

  it('P3-1: a pick that is nothing of the caller\'s answers NOTHING_TO_RESUME even while B is live (the pick, not the pool, decides)', async () => {
    const none = await nothingEnvelope();
    const b = await start(holder, bea);
    const before = await footprint();
    expect(await envelope(resume(ctx(holder), { expectedWorkerId: ada, session: generateId() }))).toBe(none);
    expect(await footprint()).toEqual(before);
    // Picking B's live session itself is the mismatch.
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada, session: b.id }));
    expect(g.extensions).toMatchObject({ reason: 'WORKER_MISMATCH', picked: true, foundSource: 'LIVE_SESSION' });
  });

  it('P3-1: the unpicked mismatch carries picked: false', async () => {
    await beaClaimOnly();
    expect((await refusal(resume(ctx(holder), { expectedWorkerId: ada }))).extensions).toMatchObject({ picked: false });
  });

  it('limit: the expected worker is named only through the worker read gate — a holder who left the App gets the id only', async () => {
    await beaClaimOnly();
    await db.appMember.deleteMany({ where: { appId: app.id, userId: holder } });
    const g = await refusal(resume(ctx(holder), { expectedWorkerId: ada }));
    expect(g.extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', expectedWorkerId: ada, expectedWorkerName: null });
    expect(g.message).not.toContain('Ada');
  });

  it('P3-2: through the published schema, resumeSession accepts expectedWorkerId and the refusal carries its extensions', async () => {
    const a = await start(holder, ada);
    await claim(holder, a.id);
    await beaClaimOnly();
    const run = (expected: string) =>
      graphql({
        schema: buildSchema(typeDefs),
        source: `mutation($e: ID) { resumeSession(input: { expectedWorkerId: $e }) { outcome session { id workerId } candidates { workerName } } }`,
        variableValues: { e: expected },
        contextValue: ctx(holder),
        fieldResolver(parent, args, context, info) {
          const fn = (resolvers as any)[info.parentType.name]?.[info.fieldName];
          return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
        },
      });
    const ok = await run(ada);
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.resumeSession).toMatchObject({ outcome: 'RESUMED', session: { id: a.id, workerId: ada }, candidates: [] });
    // Ada's claim is spent; Bea's waits. A second resume naming Ada refuses through the schema with the typed reason.
    await M.endSession({}, { id: a.id }, ctx(holder));
    const refused = await run(ada);
    expect(refused.errors?.[0].extensions).toMatchObject({ code: 'RESUME_REFUSED', reason: 'WORKER_MISMATCH', foundWorkerId: bea });
  });
});
