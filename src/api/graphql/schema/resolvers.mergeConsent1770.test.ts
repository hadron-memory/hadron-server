import { transportRateIdentity } from '../../../lib/rateLimit/identity.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { orgMutations } from './resolvers.mutation.org.js';
import {
  approveUserMergeConsent, beginUserMergeConsent, MERGE_CONSENT_LIVE_CAP, mergeConsentAlreadyApplied, sweepRetiredMergeConsents,
} from '../../../lib/userMergeConsent.js';
import { mergeUsers } from '../../../controller/operations/mergeUsers.js';
import type { Context } from './resolvers.helpers.js';

// #1770, per cor:api:010:02: the live-proof cap, the 30-day retention sweep,
// the typed concurrent-loser refusal and the executor sessionId pins.

beforeEach(() => cleanDb(db));

const DAY = 86_400_000;
const hash = (proof: string) => createHash('sha256').update(proof).digest('hex');
const liveCount = (requestedBy: string) =>
  db.userMergeConsent.count({ where: { requestedBy, consumedAt: null, expiresAt: { gt: new Date() } } });

async function parties(prefix = 'p') {
  const admin = await db.user.create({ data: { handle: `${prefix}-admin`, roles: ['ADMIN'] } });
  const source = await db.user.create({ data: { handle: `${prefix}-source` } });
  const target = await db.user.create({ data: { handle: `${prefix}-target` } });
  return { admin, source, target };
}

/** Begin, then approve as both accounts with a fresh login: an executable proof. */
async function approvedProof(p: Awaited<ReturnType<typeof parties>>) {
  const { proof } = await beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }));
  const c = await db.userMergeConsent.findUniqueOrThrow({ where: { proofHash: hash(proof) } });
  const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'], login: { at: c.createdAt.getTime(), method: 'email' } });
  await approveUserMergeConsent(ctx(p.source.id), proof, p.source.id, p.target.id);
  await approveUserMergeConsent(ctx(p.target.id), proof, p.source.id, p.target.id);
  return proof;
}

describe('#1770 live-proof cap (10 per requester)', () => {
  it('the cap is the ruled 10', () => expect(MERGE_CONSENT_LIVE_CAP).toBe(10));

  it('refuses the 11th begin with MERGE_CONSENT_LIMIT_REACHED and writes nothing', async () => {
    const p = await parties();
    for (let i = 0; i < 10; i++) await beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }));
    const before = await db.userMergeConsent.findMany({ orderBy: { id: 'asc' } });
    await expect(beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id })))
      .rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_LIMIT_REACHED' } });
    expect(await db.userMergeConsent.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('the resolver surfaces the same typed refusal', async () => {
    const p = await parties();
    for (let i = 0; i < 10; i++) await beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }));
    await expect(orgMutations.beginMergeUsersConsent({}, { source: p.source.id, target: p.target.id },
      { db, userId: p.admin.id, roles: ['ADMIN'] })).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_LIMIT_REACHED' } });
    expect(await db.userMergeConsent.count()).toBe(10);
  });

  it('a second requester has independent capacity', async () => {
    const p = await parties();
    const other = await db.user.create({ data: { handle: 'other-admin', roles: ['ADMIN'] } });
    for (let i = 0; i < 10; i++) await beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }));
    await expect(beginUserMergeConsent(db, p.source.id, p.target.id, other.id, transportRateIdentity({ userId: other.id }))).resolves.toMatchObject({ proof: expect.any(String) });
  });

  it('expired and consumed proofs stop counting without waiting for the sweep', async () => {
    const p = await parties();
    for (let i = 0; i < 10; i++) await beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }));
    const [a, b] = await db.userMergeConsent.findMany({ orderBy: { id: 'asc' }, take: 2 });
    await db.userMergeConsent.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }))).resolves.toBeTruthy();
    await expect(beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id })))
      .rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_LIMIT_REACHED' } });
    await db.userMergeConsent.update({ where: { id: b.id }, data: { consumedAt: new Date() } });
    await expect(beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }))).resolves.toBeTruthy();
    expect(await liveCount(p.admin.id)).toBe(10);
  });

  it('concurrent begins at 9 live cannot exceed 10', async () => {
    for (let round = 0; round < 3; round++) {
      await cleanDb(db);
      const p = await parties(`r${round}`);
      for (let i = 0; i < 9; i++) await beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }));
      const results = await Promise.allSettled([0, 1, 2].map(() => beginUserMergeConsent(db, p.source.id, p.target.id, p.admin.id, transportRateIdentity({ userId: p.admin.id }))));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter(r => r.status === 'rejected'))
        expect((r as PromiseRejectedResult).reason).toMatchObject({ extensions: { code: 'MERGE_CONSENT_LIMIT_REACHED' } });
      expect(await liveCount(p.admin.id)).toBe(10);
    }
  });
});

describe('#1770 retention sweep (30 days after the later of expiry and consumption)', () => {
  const T = new Date('2026-10-13T12:00:00.000Z');
  const ago = (ms: number) => new Date(T.getTime() - ms);
  const W = 30 * DAY;

  async function seed() {
    const p = await parties();
    const row = (tag: string, expiresAt: Date, consumedAt: Date | null) => db.userMergeConsent.create({ data: {
      proofHash: hash(tag), sourceUserId: p.source.id, targetUserId: p.target.id, requestedBy: p.admin.id,
      createdAt: new Date(expiresAt.getTime() - 15 * 60_000), expiresAt, consumedAt,
    } });
    const eligible = [
      await row('expired-old', ago(W + DAY), null),
      await row('expired-at-boundary', ago(W), null),
      await row('consumed-old-expiry-later', ago(W + 1000), ago(W + 2000)),
      await row('consumed-old-consumption-later', ago(W + 2000), ago(W + 1000)),
    ];
    const kept = [
      await row('live', new Date(T.getTime() + 10 * 60_000), null),
      await row('expired-young', ago(DAY), null),
      await row('expired-just-inside', ago(W - 1), null),
      await row('consumed-expiry-later-young', ago(W - 1000), ago(W + DAY)),
      await row('consumed-consumption-later-young', ago(W + DAY), ago(W - 1000)),
    ];
    const merge = await db.userMerge.create({ data: { sourceUserId: p.source.id, targetUserId: p.target.id, mergedBy: p.admin.id,
      consentHash: hash('expired-old'), consentReceipt: { scope: 'FULL_CONSOLIDATION', sealed: true } } });
    return { eligible, kept, merge };
  }

  it('removes only eligible retired requests and leaves everything else byte-identical', async () => {
    const s = await seed();
    const keptBefore = await db.userMergeConsent.findMany({ where: { id: { in: s.kept.map(r => r.id) } }, orderBy: { id: 'asc' } });
    const removed = await sweepRetiredMergeConsents(db, { now: T, batchSize: 100 });
    expect(removed).toBe(s.eligible.length);
    expect(await db.userMergeConsent.count({ where: { id: { in: s.eligible.map(r => r.id) } } })).toBe(0);
    expect(await db.userMergeConsent.findMany({ where: { id: { in: s.kept.map(r => r.id) } }, orderBy: { id: 'asc' } })).toEqual(keptBefore);
    expect(await db.userMerge.findUniqueOrThrow({ where: { sourceUserId: s.merge.sourceUserId } })).toEqual(s.merge);
  });

  it('bounded passes converge without exceeding the batch size', async () => {
    const s = await seed();
    const passes: number[] = [];
    for (let i = 0; i < 6; i++) passes.push(await sweepRetiredMergeConsents(db, { now: T, batchSize: 3 }));
    expect(passes).toEqual([3, 1, 0, 0, 0, 0]);
    expect(await db.userMergeConsent.count()).toBe(s.kept.length);
  });
});

describe('#1770 concurrent merge loser', () => {
  it('exactly one execution commits; the loser gets MERGE_ALREADY_APPLIED with no database diagnostic', async () => {
    for (let round = 0; round < 3; round++) {
      await cleanDb(db);
      const p = await parties(`m${round}`);
      const proof = await approvedProof(p);
      const run = () => mergeUsers(db, { sourceUserId: p.source.id, targetUserId: p.target.id, actorUserId: p.admin.id,
        mergeGlobalRoles: true, consentProof: proof });
      const results = await Promise.allSettled([run(), run()]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const loser = (results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason;
      expect(loser).toMatchObject({ extensions: { code: 'MERGE_ALREADY_APPLIED' } });
      expect(String(loser?.message)).not.toMatch(/40001|serializ|prisma|postgres|sql|transaction/i);
      expect(await db.userMerge.count()).toBe(1);
    }
  });

  it('another admin reusing a spent proof is refused, never as MERGE_ALREADY_APPLIED', async () => {
    const p = await parties();
    const proof = await approvedProof(p);
    await mergeUsers(db, { sourceUserId: p.source.id, targetUserId: p.target.id, actorUserId: p.admin.id, mergeGlobalRoles: true, consentProof: proof });
    const other = await db.user.create({ data: { handle: 'other-admin', roles: ['ADMIN'] } });
    const err = await mergeUsers(db, { sourceUserId: p.source.id, targetUserId: p.target.id, actorUserId: other.id,
      mergeGlobalRoles: true, consentProof: proof }).catch(e => e);
    expect(err?.extensions?.code).not.toBe('MERGE_ALREADY_APPLIED');
    expect(await db.userMerge.count()).toBe(1);
  });
});

describe('#1770 the loser check reveals only the caller’s own applied proof', () => {
  it('true only for this proof, this ordered pair and this requester', async () => {
    const p = await parties();
    const proof = await approvedProof(p);
    const other = await db.user.create({ data: { handle: 'other-admin', roles: ['ADMIN'] } });
    expect(await mergeConsentAlreadyApplied(db, proof, p.source.id, p.target.id, p.admin.id)).toBe(false);
    await mergeUsers(db, { sourceUserId: p.source.id, targetUserId: p.target.id, actorUserId: p.admin.id, mergeGlobalRoles: true, consentProof: proof });
    expect(await mergeConsentAlreadyApplied(db, proof, p.source.id, p.target.id, p.admin.id)).toBe(true);
    expect(await mergeConsentAlreadyApplied(db, proof, p.source.id, p.target.id, other.id)).toBe(false);
    expect(await mergeConsentAlreadyApplied(db, proof, p.source.id, p.target.id, null)).toBe(false);
    expect(await mergeConsentAlreadyApplied(db, proof, p.target.id, p.source.id, p.admin.id)).toBe(false);
    expect(await mergeConsentAlreadyApplied(db, 'not-the-proof', p.source.id, p.target.id, p.admin.id)).toBe(false);
  });
});

describe('#1770 executor sessionId pins', () => {
  it('a session-bound ADMIN cannot begin consent; the unbound control can', async () => {
    const p = await parties();
    const ctx = { db, userId: p.admin.id, roles: ['ADMIN' as const] };
    await expect(orgMutations.beginMergeUsersConsent({}, { source: p.source.id, target: p.target.id }, { ...ctx, sessionId: 'worker-session' }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.userMergeConsent.count()).toBe(0);
    await expect(orgMutations.beginMergeUsersConsent({}, { source: p.source.id, target: p.target.id }, ctx)).resolves.toBeTruthy();
    expect(await db.userMergeConsent.count()).toBe(1);
  });

  it('a session-bound ADMIN cannot execute a dual-approved proof; the unbound control can', async () => {
    const p = await parties();
    const proof = await approvedProof(p);
    const ctx = { db, userId: p.admin.id, roles: ['ADMIN' as const] };
    const input = { source: p.source.id, target: p.target.id, consentProof: proof };
    await expect(orgMutations.mergeUsers({}, { input }, { ...ctx, sessionId: 'worker-session' }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect((await db.userMergeConsent.findUniqueOrThrow({ where: { proofHash: hash(proof) } })).consumedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: p.source.id } })).deletedAt).toBeNull();
    expect(await db.userMerge.count()).toBe(0);
    await expect(orgMutations.mergeUsers({}, { input }, ctx)).resolves.toMatchObject({ id: p.target.id });
  });
});
