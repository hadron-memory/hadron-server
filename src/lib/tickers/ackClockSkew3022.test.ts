/** #3022: a signed wake's issue clock may lead the acknowledgement clock by up to 60 seconds. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { acknowledgeWakes } from './acknowledge.js';
import { signWakeProof, type WakeProof } from './wakeProof.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

// Explicit clocks avoid sleeps and cross-midnight budget changes. These are real
// HMAC proofs and real PostgreSQL writes; no receipt, transaction or budget is mocked.
const AT = new Date('2026-11-01T12:00:00.000Z');
let appId: string;
let workerId: string;
let userId: string;
let ctx: Context;

beforeEach(async () => {
  await cleanDb(db);
  userId = generateId();
  const orgId = generateId();
  await db.user.create({ data: { id: userId, githubId: 3022001, githubUsername: 'clock-skew-fixture', roles: ['ADMIN'] } });
  await db.organization.create({ data: { id: orgId, name: 'clock-skew', urn: `clock-${orgId}.test` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'clock-agent', urn: `hrn:agent:clock-${orgId}.test:fixture` } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'clock-app', urn: `hrn:app:clock-${orgId}.test:fixture` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Clock', slug: 'clock' } });
  workerId = worker.id;
  ctx = { db, userId, roles: ['ADMIN'] };
});

// A textless v3 wake keeps its identity across a fresh issue after the floor (#2072).
const proof = (issuedAt: number, wakeKey = 'clock-wake') => signWakeProof({
  v: 3, kind: 'wake-proof', appId, workerId, requester: { userId },
  channels: [], ticks: [], tasks: [], exempt: false, issuedAt, wakeKey,
} satisfies WakeProof);
const ack = (p: string, at: number) => acknowledgeWakes({
  ctx, requester: { userId }, proofs: [p], now: new Date(at), mayReadWorker: async () => true,
});
const charged = async () => (await db.appWakeDay.findMany({ where: { appId } })).reduce((sum, row) => sum + row.wakes, 0);
const receipt = () => db.workerWakeAck.findUniqueOrThrow({ where: { workerId_wakeKey: { workerId, wakeKey: 'clock-wake' } } });

describe('repeat acknowledgement across issue/ack clock skew', () => {
  for (const skew of [1000, 30_000, 60_000]) {
    it(`charges a proof issued ${skew}ms ahead only once, even while the ack clock advances`, async () => {
      const p = proof(AT.getTime() + skew);
      expect(await ack(p, AT.getTime())).toEqual({ acknowledged: 1, unchanged: 0 });
      const first = await receipt();
      expect(first.ackedAt).toEqual(AT); // the floor uses actual acknowledgement time, not future issue time
      expect(await ack(p, AT.getTime())).toEqual({ acknowledged: 0, unchanged: 1 });
      expect(await ack(p, AT.getTime() + 500)).toEqual({ acknowledged: 0, unchanged: 1 });
      expect(await ack(p, AT.getTime() + skew + 1000)).toEqual({ acknowledged: 0, unchanged: 1 });
      expect(await charged()).toBe(1);
      expect(await receipt()).toEqual(first);
    });
  }

  it('preserves the normal-clock repeat as unchanged with one charge', async () => {
    const p = proof(AT.getTime() - 1000);
    expect(await ack(p, AT.getTime())).toEqual({ acknowledged: 1, unchanged: 0 });
    const first = await receipt();
    expect(await ack(p, AT.getTime() + 500)).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await charged()).toBe(1);
    expect(await receipt()).toEqual(first);
  });

  it('charges a genuinely fresh issue of the same wake after the floor, not an old-proof replay', async () => {
    const old = proof(AT.getTime() + 30_000);
    expect(await ack(old, AT.getTime())).toEqual({ acknowledged: 1, unchanged: 0 });
    const later = AT.getTime() + 5 * 60_000;
    const fresh = proof(later);
    expect(await ack(fresh, later)).toEqual({ acknowledged: 1, unchanged: 0 });
    const second = await receipt();
    expect(second.ackedAt).toEqual(new Date(later));
    expect(await charged()).toBe(2);
    expect(await ack(fresh, later + 500)).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await ack(old, later + 1000)).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await charged()).toBe(2);
    expect(await receipt()).toEqual(second);
  });

  it('an absorbed ancestor with a future issue is not charged after its descendant is acknowledged', async () => {
    const ancestor = proof(AT.getTime() + 1000, 'ancestor');
    const descendant = proof(AT.getTime() + 30_000);
    await db.appWakeReservation.create({ data: {
      workerId, appId, wakeKey: 'clock-wake', reservedAt: AT, wake: {}, absorbedKeys: ['ancestor'],
    } });
    expect(await ack(descendant, AT.getTime())).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await db.appWakeReservation.count({ where: { workerId } })).toBe(0);
    const rows = await db.workerWakeAck.findMany({ where: { workerId }, orderBy: { wakeKey: 'asc' } });
    expect(await ack(ancestor, AT.getTime() + 500)).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await charged()).toBe(1);
    expect(await db.workerWakeAck.findMany({ where: { workerId }, orderBy: { wakeKey: 'asc' } })).toEqual(rows);
  });

  it('serializes concurrent acknowledgements of the same future-issued proof into one charge', async () => {
    const p = proof(AT.getTime() + 30_000);
    const results = await Promise.all([ack(p, AT.getTime()), ack(p, AT.getTime() + 500)]);
    expect(results.reduce((n, r) => n + r.acknowledged, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.unchanged, 0)).toBe(1);
    expect(await charged()).toBe(1);
  });
});
