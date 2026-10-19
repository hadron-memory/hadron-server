import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { beginDeliveryTracking, deliveryStateTransaction, loadDeliveryWait, observeDeliveryPolicyThrough, transitionDeliveryException, deliveryAlarmChain } from './deliveryState.js';

const db = new PrismaClient();
const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 10, minute));
const orgId = generateId(), appId = generateId(), agentId = generateId(), workerId = generateId();
const run = <T>(fn: Parameters<typeof deliveryStateTransaction<T>>[3]) => deliveryStateTransaction(db, appId, workerId, fn);
beforeAll(async () => {
  await db.organization.create({ data: { id: orgId, name: 'Delivery policy pins', urn: `s5-${orgId}.example` } });
  await db.agent.create({ data: { id: agentId, organizationId: orgId, name: 'Policy', urn: `s5-${orgId}.example:agent` } });
  await db.app.create({ data: { id: appId, organizationId: orgId, name: 'Policy', urn: `s5-${orgId}.example:app` } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: workerId, appId, agentId, name: 'Policy worker', slug: 'policy-worker' } });
});
afterAll(async () => {
  await db.worker.deleteMany({ where: { id: workerId } });
  await db.app.deleteMany({ where: { id: appId } });
  await db.agent.deleteMany({ where: { id: agentId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.$disconnect();
});

it('policy producers replace future expiry at the actual boundary without losing overlap or historical wait', async () => {
  await run(tx => beginDeliveryTracking(tx, workerId, at(0)));
  const pause = { workerId, cause: 'wake-paused' as const, coverage: { kind: 'worker' as const } };
  await run(tx => transitionDeliveryException(tx, { ...pause, effectiveAt: at(5), until: at(60), active: true }));
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(10)));
  // A resume before the configured expiry replaces the future boundary; a
  // delayed evaluator must not deduct the abandoned 10:20–11:00 interval.
  await Promise.all([1, 2].map(() => run(tx => transitionDeliveryException(tx, { ...pause, effectiveAt: at(20), active: false }))));
  await run(tx => transitionDeliveryException(tx, { workerId, cause: 'isolated', coverage: { kind: 'worker' }, effectiveAt: at(15), until: at(25), active: true }));
  await run(tx => observeDeliveryPolicyThrough(tx, workerId, at(40)));
  const message = { workerId, channelId: 'policy-channel', channelIncarnation: 1, seq: 1, dueSince: at(0) };
  expect((await run(tx => loadDeliveryWait(tx, message, at(30)))).waitedMs).toBe(10 * 60_000);
  // Duplicate resume did not create an interval. The other cause survived.
  expect(await db.workerDeliveryWaitException.count({ where: { workerId } })).toBe(2);
  await expect(run(tx => transitionDeliveryException(tx, { ...pause, effectiveAt: at(19), active: true }))).rejects.toThrow('DELIVERY_POLICY_LATE');
  expect((await run(tx => loadDeliveryWait(tx, { ...message, dueSince: at(12) }, at(30)))).waitedMs).toBe(5 * 60_000);
});

it('does not certify policy time for a worker whose owning organization was deleted', async () => {
  await db.organization.update({ where: { id: orgId }, data: { deletedAt: at(45) } });
  try {
    await expect(run(tx => observeDeliveryPolicyThrough(tx, workerId, at(50)))).rejects.toThrow('DELIVERY_WORKER_NOT_FOUND');
  } finally {
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: null } });
  }
});


it('captures the reportsTo chain nearest first, falling back to current managers only when no reporting line exists', async () => {
  const managerId = generateId(), leadId = generateId(), headId = generateId();
  await db.user.create({ data: { id: managerId, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: managerId, role: 'ADMIN' } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: headId, appId, agentId, name: 'Head', slug: 'head' } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: leadId, appId, agentId, name: 'Lead', slug: 'lead', reportsToWorkerId: headId } });
  await db.worker.update({ where: { id: workerId }, data: { reportsToWorkerId: leadId } });
  try {
    expect(await run(tx => deliveryAlarmChain(tx, workerId))).toEqual([{ workerId: leadId }, { workerId: headId }]);
    await db.worker.update({ where: { id: workerId }, data: { reportsToWorkerId: null } });
    expect(await run(tx => deliveryAlarmChain(tx, workerId))).toEqual([{ userId: managerId, via: 'manager' }]);
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: managerId } }, data: { deletedAt: at(60) } });
    expect(await run(tx => deliveryAlarmChain(tx, workerId))).toEqual([]);
  } finally {
    await db.worker.update({ where: { id: workerId }, data: { reportsToWorkerId: null } });
    await db.worker.deleteMany({ where: { id: { in: [leadId, headId] } } });
    await db.orgMember.deleteMany({ where: { userId: managerId } });
    await db.user.delete({ where: { id: managerId } });
  }
});
