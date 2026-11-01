/** #3022: a signed wake's issue clock may lead the acknowledgement clock by up to 60 seconds. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { acknowledgeWakes } from './acknowledge.js';
import { signWakeProof, verifyWakeProof, type WakeProof } from './wakeProof.js';
import { computeDueWakes } from './dueWakes.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
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
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'clock-agent', urn: `clock-${orgId}.test:fixture` } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'clock-app', urn: `clock-${orgId}.test:fixture` } });
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
      expect(first.issuedAt).toEqual(new Date(AT.getTime() + skew));
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

  for (const skew of [60_001, 61_000]) {
    it(`refuses an issue ${skew}ms ahead before writing a receipt or charging`, async () => {
      await expect(ack(proof(AT.getTime() + skew), AT.getTime())).rejects.toMatchObject({
        extensions: { code: 'WAKE_PROOF_STALE' },
      });
      expect(await db.workerWakeAck.count({ where: { workerId } })).toBe(0);
      expect(await charged()).toBe(0);
    });
  }

  it('the real issuer with a 60s floor blocks a slower issuer until a fresh same-key issue can charge', async () => {
    const worker = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
    const app = await db.app.update({ where: { id: appId }, data: { tickerMinCadenceSeconds: 60 } });
    const memory = await db.memory.create({ data: {
      id: generateId(), organizationId: app.organizationId, appId, class: 'app',
      sharedMemoryOfAgentId: worker.agentId, name: 'clock-chat', urn: `clock.test:fixture-${appId}`,
    } });
    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: memory.id, loc: 'chats:clock', name: 'clock', createdBy: userId,
    });
    await db.registerEntry.create({ data: { id: generateId(), appId, channelId: channel.id, attendeeWorkerId: workerId, role: 'BOTH' } });
    const enc = await getMemoryEncryptionInfo(db, memory.id);
    await appendChatMessage(db, { id: rootId, memoryId: memory.id, loc: 'chats:clock' }, enc,
      async ({ tx, seq, msgNum }) => tx.node.create({ data: {
        id: generateId(), memoryId: memory.id, loc: `chats:clock:messages:${msgNum}`, name: msgNum,
        nodeType: 'chat-message', messageChannelId: channel.id, seq, content: 'clock fixture', data: { mentions: ['clock'] },
      } }), { asChannel: true });
    const due = (at: number) => computeDueWakes({
      ctx, app, reader: { manager: true, userId }, requester: { userId }, workerIds: [workerId], now: new Date(at),
    });
    const [first] = (await due(AT.getTime() + 60_000)).wakes;
    expect(first).toBeDefined();
    expect(await ack(first!.proof, AT.getTime())).toEqual({ acknowledged: 1, unchanged: 0 });
    // A slower issuer at T+10 cannot hand out the hypothetical fresh delivery:
    // the actual receipt at T, not the leading issue at T+60, starts the floor.
    expect((await due(AT.getTime() + 10_000)).wakes).toEqual([]);
    const [equal] = (await due(AT.getTime() + 60_000)).wakes;
    expect(equal!.proof).toBe(first!.proof); // equal issue + payload is literally the same signed proof
    expect(await ack(equal!.proof, AT.getTime() + 60_000)).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await db.appWakeReservation.count({ where: { workerId } })).toBe(1);
    const [fresh] = (await due(AT.getTime() + 60_001)).wakes;
    expect(verifyWakeProof(fresh!.proof).wakeKey).toBe(verifyWakeProof(first!.proof).wakeKey);
    expect(await ack(fresh!.proof, AT.getTime() + 60_001)).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await charged()).toBe(2);
    expect(await db.appWakeReservation.count({ where: { workerId } })).toBe(0);
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

  it('a NULL watermark from an old writer falls back to its receipt and permits a later real issue', async () => {
    // Old code on the expanded schema still inserts these columns only.
    await db.$executeRaw`
      INSERT INTO worker_wake_acks (worker_id, wake_key, acked_at)
      VALUES (${workerId}, 'clock-wake', ${toNaiveUtc(AT)}::timestamp)`;
    const old = await receipt();
    expect(old.issuedAt).toBeNull();
    expect(await ack(proof(AT.getTime() - 1000), AT.getTime() + 500)).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await receipt()).toEqual(old);
    expect(await charged()).toBe(0);
    const later = AT.getTime() + 5 * 60_000;
    expect(await ack(proof(later), later)).toEqual({ acknowledged: 1, unchanged: 0 });
    expect((await receipt()).issuedAt).toEqual(new Date(later));
    expect(await charged()).toBe(1);
  });

  for (const absorbed of [false, true]) {
    it(`keeps the floor timestamp and its acker together under a clock rollback (absorbed: ${absorbed})`, async () => {
      const earlier = await db.user.create({ data: {
        id: generateId(), githubId: 3022002, githubUsername: 'earlier-clock-fixture', roles: ['READER'],
      } });
      const key = absorbed ? 'ancestor' : 'clock-wake';
      const previousAt = new Date(AT.getTime() + 10_000);
      await db.workerWakeAck.create({ data: { workerId, wakeKey: key, ackedAt: previousAt, ackedByUserId: earlier.id } });
      if (absorbed) await db.appWakeReservation.create({ data: {
        workerId, appId, wakeKey: 'clock-wake', reservedAt: AT, wake: {}, absorbedKeys: ['ancestor'],
      } });
      const p = proof(AT.getTime() + 20_000);
      expect(await ack(p, AT.getTime())).toEqual({ acknowledged: 1, unchanged: 0 });
      const row = await db.workerWakeAck.findUniqueOrThrow({ where: { workerId_wakeKey: { workerId, wakeKey: key } } });
      expect(row.ackedAt).toEqual(previousAt);
      expect(row.ackedByUserId).toBe(earlier.id); // attribution belongs to the retained receipt clock
      expect(row.issuedAt).toEqual(new Date(AT.getTime() + 20_000));
      expect(await ack(p, AT.getTime() + 21_000)).toEqual({ acknowledged: 0, unchanged: 1 });
      expect(await charged()).toBe(1);
      expect(await db.workerWakeAck.findUniqueOrThrow({ where: { workerId_wakeKey: { workerId, wakeKey: key } } })).toEqual(row);
    });
  }

  for (const existing of [false, true]) {
    it(`an absorbed ancestor with a future issue is not charged after its descendant (existing receipt: ${existing})`, async () => {
      const ancestor = proof(AT.getTime() + 1000, 'ancestor');
      const descendant = proof(AT.getTime() + 30_000);
      if (existing) await db.workerWakeAck.create({ data: { workerId, wakeKey: 'ancestor', ackedAt: AT } });
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
  }

  it('serializes concurrent acknowledgements of the same future-issued proof into one charge', async () => {
    const p = proof(AT.getTime() + 30_000);
    const results = await Promise.all([ack(p, AT.getTime()), ack(p, AT.getTime() + 500)]);
    expect(results.reduce((n, r) => n + r.acknowledged, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.unchanged, 0)).toBe(1);
    expect(await charged()).toBe(1);
  });
});
