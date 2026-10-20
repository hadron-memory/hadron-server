import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2017 S1 slice (b): batch proofs (`signBatchProof` / `verifyBatchProof`) and the range-bounded
 * `acknowledgeBatchProofs`, against a real test database. One block per row of the retry matrix in
 * Liam's engineering layer (issue comment 6246569316 §3), the partial-`through` pin (6246615573,
 * 6246620593) and the stable-key/fresh-id pair (6246604128). cor:agt:080:12/:16/:17.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import {
  batchKeyOf, signBatchProof, verifyBatchProof, signWakeProof, verifyWakeProof,
  BATCH_PROOF_MAX_SEQS, type BatchProof, type WakeProof,
} from './wakeProof.js';
import { acknowledgeBatchProofs } from './acknowledge.js';
import { batchProofPayload, type LoadedBatch } from './deliveryBatch.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return (e as GraphQLError).extensions?.code as string; }
  return undefined;
}

const KEY = { appKeyId: 'key-host-a' };
const MIN = 60_000;
const allow = async () => true;

let manager: { id: string };
let app: { id: string };
let worker: { id: string };
let chA: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let chB: { id: string; memoryId: string; loc: string; chatRootNodeId: string };

async function mkChannel(memoryId: string, loc: string) {
  const made = await ensureChannelWithRoot(db, { memoryId, loc, name: loc, createdBy: manager.id });
  return { id: made.channel.id, memoryId, loc, chatRootNodeId: made.rootId };
}
async function say(ch: typeof chA, body = 'hi'): Promise<number> {
  const enc = await getMemoryEncryptionInfo(db, ch.memoryId);
  const node = await appendChatMessage(db, { id: ch.chatRootNodeId, memoryId: ch.memoryId, loc: ch.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: ch.memoryId, loc: `${ch.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: ch.id, content: body, data: { mentions: [] } } }),
    { asChannel: true });
  return (node as { seq: number }).seq;
}
const renderHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** A proof as the loader would issue it: ranges over rendered seqs, its batchKey derived from them. */
function proofFor(channels: BatchProof['channels'], over: Partial<BatchProof> = {}): BatchProof {
  const base = { workerId: worker.id, channels, renderHash: renderHash('text') };
  return {
    v: 1, kind: 'batch-proof', appId: app.id, workerId: worker.id, hostId: 'host-a', requester: KEY,
    channels, renderHash: base.renderHash, batchKey: batchKeyOf(base), issuedAt: Date.now(), ...over,
  };
}
const range = (ch: { id: string }, seqs: number[], from = seqs[0]!, incarnation = 1) =>
  ({ channelId: ch.id, incarnation, from, through: seqs[seqs.length - 1]!, seqs });
const ack = (acks: Array<{ proof: string; through?: Array<{ channelId: string; seq: number }> }>, extra: Record<string, unknown> = {}) =>
  acknowledgeBatchProofs({ ctx: ctx(manager.id), requester: KEY, acks, mayAckBatch: allow, ...extra });
const mark = async (ch: { id: string }) =>
  (await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: worker.id, channelId: ch.id } } }))?.deliveredThroughSeq ?? null;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'ba-org', urn: `ba-org-${suffix}.com` } });
  manager = await db.user.create({ data: { id: generateId(), githubId: 98_100, githubUsername: `ba-${suffix}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  chA = await mkChannel(memory.id, 'chats:a');
  chB = await mkChannel(memory.id, 'chats:b');
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam' }, select: { id: true } });
});

describe('batch proof: signing, domain separation, shape', () => {
  it('round-trips, and neither a wake proof nor a batch proof verifies as the other', async () => {
    const p = proofFor([range(chA, [1, 2])]);
    expect(verifyBatchProof(signBatchProof(p))).toEqual(p);
    const wake: WakeProof = { v: 2, kind: 'wake-proof', appId: app.id, workerId: worker.id, requester: KEY, channels: [], ticks: [], tasks: [], exempt: false, issuedAt: Date.now() };
    expect(await code(() => verifyBatchProof(signWakeProof(wake)))).toBe('WAKE_PROOF_INVALID');
    expect(await code(() => verifyWakeProof(signBatchProof(p)))).toBe('WAKE_PROOF_INVALID');
  });

  it('an id built by the loader\'s batchProofPayload verifies to the same payload, and acknowledges', async () => {
    await say(chA); await say(chA);
    const ranges = [{ channelId: chA.id, incarnation: 1, fromSeq: 1, throughSeq: 2, seqs: [1, 2] }];
    const batch: LoadedBatch = {
      workerId: worker.id, workerName: 'Liam', text: 'text', renderHash: renderHash('text'),
      batchKey: batchKeyOf({ workerId: worker.id, renderHash: renderHash('text'), channels: ranges.map((r) => ({ channelId: r.channelId, incarnation: r.incarnation, from: r.fromSeq, through: r.throughSeq, seqs: r.seqs })) }),
      deliverAfter: new Date(), busyDeadline: new Date(), interrupt: false, overflow: 0, ranges,
    };
    const payload = batchProofPayload(batch, { appId: app.id, hostId: 'host-a', appKeyId: KEY.appKeyId, now: new Date() });
    expect(verifyBatchProof(signBatchProof(payload))).toEqual(payload);
    expect(await ack([{ proof: signBatchProof(payload) }])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await mark(chA)).toBe(2);
  });

  it('a tampered body, a batchKey presented as an id, and an unknown version are invalid', async () => {
    const p = proofFor([range(chA, [1, 2])]);
    const [body, sig] = signBatchProof(p).split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...p, channels: [range(chA, [1, 2, 3])] })).toString('base64url');
    expect(await code(() => verifyBatchProof(`${forged}.${sig}`))).toBe('WAKE_PROOF_INVALID');
    expect(await code(() => verifyBatchProof(p.batchKey))).toBe('WAKE_PROOF_INVALID');
    expect(await code(() => verifyBatchProof(signBatchProof({ ...p, v: 2 as 1 })))).toBe('WAKE_PROOF_INVALID');
    expect(body.length).toBeGreaterThan(0);
  });

  it('refuses a malformed range: unsorted or empty seqs, through not the last seq, from above the first seq, a repeated channel, too many seqs, a bad renderHash, a batchKey that does not match', async () => {
    const bad: BatchProof[] = [
      proofFor([{ ...range(chA, [1, 2]), seqs: [2, 1] }]),
      proofFor([{ ...range(chA, [1]), seqs: [] }]),
      proofFor([{ ...range(chA, [1, 2]), through: 3 }]),
      proofFor([{ ...range(chA, [1, 2]), from: 2 }]),
      proofFor([range(chA, [1]), range(chA, [2])]),
      proofFor([range(chA, Array.from({ length: BATCH_PROOF_MAX_SEQS + 1 }, (_, i) => i + 1))]),
      proofFor([range(chA, [1])], { renderHash: 'not-a-hash' }),
      proofFor([range(chA, [1])], { batchKey: 'f'.repeat(32) }),
      proofFor([]),
    ];
    for (const p of bad) expect(await code(() => verifyBatchProof(signBatchProof(p)))).toBe('WAKE_PROOF_INVALID');
  });

  it('the same messages give the same batchKey on every read, and a different id', async () => {
    const a = proofFor([range(chA, [1, 2])], { issuedAt: Date.now() - MIN });
    const b = proofFor([range(chA, [1, 2])]);
    expect(a.batchKey).toBe(b.batchKey);
    expect(signBatchProof(a)).not.toBe(signBatchProof(b));
    expect(proofFor([range(chA, [1, 2, 3])]).batchKey).not.toBe(a.batchKey);
  });
});

describe('acknowledgeBatchProofs: the retry matrix', () => {
  it('a full ack raises each channel to its range end; a repeat (double ack, lost response) is unchanged and rewrites nothing', async () => {
    for (let i = 0; i < 3; i++) { await say(chA); await say(chB); }
    const id = signBatchProof(proofFor([range(chA, [1, 2]), range(chB, [1, 2, 3])]));
    expect(await ack([{ proof: id }])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect([await mark(chA), await mark(chB)]).toEqual([2, 3]);
    const before = await db.workerDeliveryChannel.findMany({ orderBy: { channelId: 'asc' } });
    expect(await ack([{ proof: id }], { now: new Date(Date.now() + MIN) })).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await db.workerDeliveryChannel.findMany({ orderBy: { channelId: 'asc' } })).toEqual(before);
  });

  it('two concurrent acks of the same batch move the mark once', async () => {
    await say(chA); await say(chA);
    const id = signBatchProof(proofFor([range(chA, [1, 2])]));
    const results = await Promise.all([ack([{ proof: id }]), ack([{ proof: id }])]);
    expect(results.map((r) => r.acknowledged).sort()).toEqual([0, 1]);
    expect(await mark(chA)).toBe(2);
  });

  it('crash before ack: nothing moved, a re-read gives the same batchKey with a fresh id; the expired id is stale, the fresh one moves once', async () => {
    await say(chA); await say(chA);
    const old = proofFor([range(chA, [1, 2])], { issuedAt: Date.now() - 16 * MIN });
    const fresh = proofFor([range(chA, [1, 2])]);
    expect(fresh.batchKey).toBe(old.batchKey);
    expect(await code(ack([{ proof: signBatchProof(old) }]))).toBe('WAKE_PROOF_STALE');
    expect(await mark(chA)).toBeNull();
    expect(await ack([{ proof: signBatchProof(fresh) }])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await ack([{ proof: signBatchProof(fresh) }])).toEqual({ acknowledged: 0, unchanged: 1 });
  });

  it('a proof issued in the future is stale; a proof for another requester is a mismatch; nothing moves', async () => {
    await say(chA);
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chA, [1])], { issuedAt: Date.now() + 5 * MIN })) }]))).toBe('WAKE_PROOF_STALE');
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chA, [1])], { requester: { appKeyId: 'key-other' } })) }]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await mark(chA)).toBeNull();
  });

  it('authority is decided inside the transaction by the injected callback; a refusal moves nothing', async () => {
    await say(chA);
    const seen: string[] = [];
    const mayAckBatch = vi.fn(async (p: BatchProof, tx: unknown) => { seen.push(p.workerId); expect(tx).toBeTruthy(); return false; });
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chA, [1])])) }], { mayAckBatch }))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(seen).toEqual([worker.id]);
    expect(await mark(chA)).toBeNull();
  });

  it('a retired worker or a worker of another App is stale', async () => {
    await say(chA);
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chA, [1])])) }]))).toBe('WAKE_PROOF_STALE');
  });

  it('channel recreated (incarnation moved) or deleted since issue: stale, nothing moves', async () => {
    await say(chA); await say(chB);
    await db.channel.update({ where: { id: chA.id }, data: { incarnation: 2 } });
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chA, [1]), range(chB, [1])])) }]))).toBe('WAKE_PROOF_STALE');
    await db.channel.update({ where: { id: chB.id }, data: { deletedAt: new Date() } });
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chB, [1])])) }]))).toBe('WAKE_PROOF_STALE');
    expect([await mark(chA), await mark(chB)]).toEqual([null, null]);
  });

  it('a forged range past the channel head is invalid; nothing moves', async () => {
    await say(chA);
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chA, [1, 7])])) }]))).toBe('WAKE_PROOF_INVALID');
    expect(await mark(chA)).toBeNull();
  });

  it('a range that starts above the delivered mark (an unseen prefix) is stale; nothing moves', async () => {
    for (let i = 0; i < 6; i++) await say(chA);
    await ack([{ proof: signBatchProof(proofFor([range(chA, [1, 2])])) }]);
    expect(await code(ack([{ proof: signBatchProof(proofFor([range(chA, [5, 6], 5)])) }]))).toBe('WAKE_PROOF_STALE');
    expect(await mark(chA)).toBe(2);
    // A range widened down to the mark (ineligible seqs 3-4 below the first rendered one) is fine.
    expect(await ack([{ proof: signBatchProof(proofFor([range(chA, [5, 6], 3)])) }])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await mark(chA)).toBe(6);
  });

  it('later posts are outside the range: the mark stops at the last rendered seq', async () => {
    await say(chA); await say(chA);
    const id = signBatchProof(proofFor([range(chA, [1, 2])]));
    await say(chA); await say(chA);
    await ack([{ proof: id }]);
    expect(await mark(chA)).toBe(2);
  });

  it('all or nothing across a call: one stale proof leaves the valid one unwritten', async () => {
    await say(chA); await say(chB);
    const good = signBatchProof(proofFor([range(chA, [1])]));
    const stale = signBatchProof(proofFor([range(chB, [1])], { issuedAt: Date.now() - 20 * MIN }));
    expect(await code(ack([{ proof: good }, { proof: stale }]))).toBe('WAKE_PROOF_STALE');
    await db.channel.update({ where: { id: chB.id }, data: { incarnation: 3 } });
    expect(await code(ack([{ proof: good }, { proof: signBatchProof(proofFor([range(chB, [1])])) }]))).toBe('WAKE_PROOF_STALE');
    expect(await mark(chA)).toBeNull();
  });

  it('writes only the delivery mark: no read state, no wake budget, no reservation is touched', async () => {
    await say(chA);
    // A wake reservation outstanding for the same worker: a batch ack neither spends nor frees it.
    await db.appWakeReservation.create({ data: { appId: app.id, workerId: worker.id, reservedAt: new Date(), wakeKey: 'k', wake: {} } });
    const counts = async () => [await db.channelReadState.count(), await db.appWakeDay.count(), await db.appWakeReservation.count(), await db.workerDeliveryTick.count()];
    const before = await counts();
    await ack([{ proof: signBatchProof(proofFor([range(chA, [1])])) }]);
    expect(await counts()).toEqual(before);
    expect(await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: worker.id, channelId: chA.id } } }))
      .toMatchObject({ deliveredThroughSeq: 1, channelIncarnation: 1, ackedByAppKeyId: KEY.appKeyId, ackedByUserId: null });
  });

  it('at most the call cap of proofs', async () => {
    const id = signBatchProof(proofFor([range(chA, [1])]));
    expect(await code(ack(Array.from({ length: 201 }, () => ({ proof: id }))))).toBe('BAD_USER_INPUT');
  });
});

describe('acknowledgeBatchProofs: partial through', () => {
  beforeEach(async () => { for (let i = 0; i < 3; i++) { await say(chA); await say(chB); } });
  const twoChannel = () => signBatchProof(proofFor([range(chA, [1, 2, 3]), range(chB, [1, 3], 1)]));

  it('only the listed channel moves, to its listed seq; the omitted channel stays due', async () => {
    expect(await ack([{ proof: twoChannel(), through: [{ channelId: chA.id, seq: 2 }] }])).toEqual({ acknowledged: 1, unchanged: 0 });
    expect([await mark(chA), await mark(chB)]).toEqual([2, null]);
  });

  it('without through every channel moves to its range end; through at the last seq equals the full ack', async () => {
    await ack([{ proof: twoChannel(), through: [{ channelId: chA.id, seq: 3 }, { channelId: chB.id, seq: 3 }] }]);
    expect([await mark(chA), await mark(chB)]).toEqual([3, 3]);
  });

  it('a seq in range but not rendered, a seq outside the range, a channel not in the proof, or a repeated channel is refused; nothing moves', async () => {
    const chC = await mkChannel(chA.memoryId, 'chats:c');
    for (const through of [
      [{ channelId: chB.id, seq: 2 }],
      [{ channelId: chA.id, seq: 4 }],
      [{ channelId: chC.id, seq: 1 }],
      [{ channelId: chA.id, seq: 1 }, { channelId: chA.id, seq: 2 }],
      [{ channelId: chA.id, seq: 1.5 }],
    ]) {
      expect(await code(ack([{ proof: twoChannel(), through }]))).toBe('BAD_USER_INPUT');
    }
    expect([await mark(chA), await mark(chB)]).toEqual([null, null]);
  });

  it('a partial ack below the mark is unchanged and never lowers it', async () => {
    await ack([{ proof: twoChannel() }]);
    expect(await ack([{ proof: twoChannel(), through: [{ channelId: chA.id, seq: 1 }] }])).toEqual({ acknowledged: 0, unchanged: 1 });
    expect(await mark(chA)).toBe(3);
  });
});

describe('R57 self arm: a worker acknowledges its own batches through its own live session (cor:agt:080:17/:22)', () => {
  const SELF = { sessionId: 'session-a' };
  const selfProof = (channels: BatchProof['channels'], over: Partial<BatchProof> = {}) =>
    proofFor(channels, { requester: SELF, hostId: null, ...over } as Partial<BatchProof>);
  const ackAs = (requester: unknown, acks: Array<{ proof: string }>, extra: Record<string, unknown> = {}) =>
    acknowledgeBatchProofs({ ctx: ctx(manager.id), requester: requester as never, acks, mayAckBatch: allow, ...extra });

  it('decodes exactly one principal: a session requester pairs with a null hostId, an App key with a host', async () => {
    const ok = selfProof([range(chA, [1])]);
    expect(verifyBatchProof(signBatchProof(ok))).toEqual(ok);
    const bad = [
      proofFor([range(chA, [1])], { requester: { appKeyId: 'k', sessionId: 's' } as never }),
      proofFor([range(chA, [1])], { requester: {} as never }),
      proofFor([range(chA, [1])], { requester: { sessionId: '' } as never, hostId: null as never }),
      proofFor([range(chA, [1])], { requester: { appKeyId: '' } }),
      proofFor([range(chA, [1])], { requester: SELF as never }), // a session with a host
      proofFor([range(chA, [1])], { hostId: null as never }), // an App key without one
      proofFor([range(chA, [1])], { hostId: '' }),
    ];
    for (const p of bad) expect(await code(() => verifyBatchProof(signBatchProof(p)))).toBe('WAKE_PROOF_INVALID');
  });

  it('its own session acknowledges; the mark records the worker, the session\'s user and no App key', async () => {
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id }, select: { agentId: true } });
    await db.session.create({ data: { id: SELF.sessionId, appId: app.id, userId: manager.id, workerId: worker.id, agentId: w.agentId, type: 'DEVELOPER', startedAt: new Date() } });
    await say(chA); await say(chA);
    const seen: unknown[] = [];
    const mayAckBatch = vi.fn(async (p: BatchProof) => { seen.push(p.requester); return true; });
    expect(await ackAs(SELF, [{ proof: signBatchProof(selfProof([range(chA, [1, 2])])) }], { mayAckBatch })).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(seen).toEqual([SELF]); // liveness and "its own worker" are decided by the callback, inside the transaction
    expect(await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: worker.id, channelId: chA.id } } }))
      .toMatchObject({ deliveredThroughSeq: 2, ackedByWorkerId: worker.id, ackedByAppKeyId: null, ackedByUserId: manager.id });
  });

  it('another session (same worker, same holder), a host key, or a session acking a host proof is a mismatch; nothing moves', async () => {
    await say(chA);
    const self = signBatchProof(selfProof([range(chA, [1])]));
    const host = signBatchProof(proofFor([range(chA, [1])]));
    expect(await code(ackAs({ sessionId: 'session-b' }, [{ proof: self }]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(ackAs(KEY, [{ proof: self }]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await code(ackAs(SELF, [{ proof: host }]))).toBe('WAKE_PROOF_REQUESTER_MISMATCH');
    expect(await mark(chA)).toBeNull();
  });

  it('the session arm keeps every other refusal: stale, recreated channel, all-or-nothing', async () => {
    await say(chA); await say(chB);
    expect(await code(ackAs(SELF, [{ proof: signBatchProof(selfProof([range(chA, [1])], { issuedAt: Date.now() - 16 * MIN })) }]))).toBe('WAKE_PROOF_STALE');
    await db.channel.update({ where: { id: chB.id }, data: { incarnation: 2 } });
    expect(await code(ackAs(SELF, [
      { proof: signBatchProof(selfProof([range(chA, [1])])) },
      { proof: signBatchProof(selfProof([range(chB, [1])])) },
    ]))).toBe('WAKE_PROOF_STALE');
    expect([await mark(chA), await mark(chB)]).toEqual([null, null]);
  });

  it('batchKey does not depend on the requester: host and self reads of the same batch share it', async () => {
    expect(selfProof([range(chA, [1, 2])]).batchKey).toBe(proofFor([range(chA, [1, 2])]).batchKey);
  });
});

describe('#2102 Dara P2-3: freshness is re-checked when the marks are written, not only at entry', () => {
  const slowGate = (ms: number) => async () => { await new Promise((r) => setTimeout(r, ms)); return true; };

  it('a proof that expires while the call waits on its gate is refused, and writes no mark', async () => {
    const seq = await say(chA);
    const proof = signBatchProof(proofFor([range(chA, [seq])], { issuedAt: Date.now() - 899_000 }));
    expect(await code(ack([{ proof }], { mayAckBatch: slowGate(1_200) }))).toBe('WAKE_PROOF_STALE');
    expect(await mark(chA)).toBeNull();
  });

  it('a multi-proof call rolls back entirely when a later proof expires during its wait', async () => {
    const a = await say(chA);
    const b = await say(chB);
    const fresh = signBatchProof(proofFor([range(chA, [a])]));
    const old = signBatchProof(proofFor([range(chB, [b])], { issuedAt: Date.now() - 899_000 }));
    let calls = 0;
    const gate = async () => { calls++; if (calls === 2) await new Promise((r) => setTimeout(r, 1_200)); return true; };
    expect(await code(ack([{ proof: fresh }, { proof: old }], { mayAckBatch: gate }))).toBe('WAKE_PROOF_STALE');
    expect(await mark(chA)).toBeNull();
    expect(await mark(chB)).toBeNull();
  });

  it('control: a slow gate on a fresh proof still acknowledges', async () => {
    const seq = await say(chA);
    const proof = signBatchProof(proofFor([range(chA, [seq])]));
    expect(await ack([{ proof }], { mayAckBatch: slowGate(300) })).toEqual({ acknowledged: 1, unchanged: 0 });
    expect(await mark(chA)).toBe(seq);
  });
});

it('a requester-only alteration preserves batch shape/key but cannot keep the original signature', async () => {
  const p = proofFor([range(chA, [1, 2])]);
  const [, sig] = signBatchProof(p).split('.');
  const altered = { ...p, requester: { appKeyId: 'other-requester' } };
  expect(altered.batchKey).toBe(p.batchKey);
  const body = Buffer.from(JSON.stringify(altered)).toString('base64url');
  expect(await code(() => verifyBatchProof(`${body}.${sig}`))).toBe('WAKE_PROOF_INVALID');
});
