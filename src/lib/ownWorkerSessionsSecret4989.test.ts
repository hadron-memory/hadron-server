/**
 * #4989 (ends the #4509 deprecation cycle): the wake/batch proof secret is `WORKER_PROOF_TOKEN_SECRET`, then `JWT_SECRET`.
 * The pre-#4509 name `TEAM_ATTENTION_TOKEN_SECRET` is no longer read. The refusal carries the renamed code and message,
 * and the wake and batch signers sign under `workerProofSecret()` (not `JWT_SECRET` directly).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workerProofSecret } from './ownWorkerSessions.js';
import { signWakeProof, verifyWakeProof, signBatchProof, verifyBatchProof, batchKeyOf, type WakeProof, type BatchProof } from './tickers/wakeProof.js';

const NEW = 'WORKER_PROOF_TOKEN_SECRET';
const OLD = 'TEAM_ATTENTION_TOKEN_SECRET';
const A = 'secret-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'secret-b-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [NEW, OLD, 'JWT_SECRET']) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of [NEW, OLD, 'JWT_SECRET']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as { extensions?: { code?: string } }).extensions?.code ?? 'no-code'; }
  return null;
};
const wake = (): WakeProof => ({
  v: 3, kind: 'wake-proof', appId: 'a', workerId: 'w', requester: { userId: 'u' }, channels: [], ticks: [], tasks: [], exempt: false, issuedAt: Date.now(), wakeKey: 'k',
});
const batch = (): BatchProof => {
  const base = {
    workerId: 'w', channels: [{ channelId: 'c1', incarnation: 1, from: 1, through: 2, seqs: [1, 2] }], renderHash: 'a'.repeat(64),
  };
  return { v: 1, kind: 'batch-proof', appId: 'a', hostId: null, requester: { sessionId: 's' }, issuedAt: Date.now(), batchKey: batchKeyOf(base), ...base };
};

describe('#4989 the proof secret, single name', () => {
  it('the new name wins over JWT_SECRET', () => {
    process.env[NEW] = A; process.env.JWT_SECRET = B;
    expect(workerProofSecret()).toBe(A);
  });

  it('the old name is not read: with only it set, the JWT_SECRET fallback answers', () => {
    process.env[OLD] = A; process.env.JWT_SECRET = B;
    expect(workerProofSecret()).toBe(B);
  });

  it('the old name alone does not configure the signer: renamed code and message', () => {
    process.env[OLD] = A;
    expect(() => workerProofSecret()).toThrow('The worker proof signer is not configured.');
    expect(code(workerProofSecret)).toBe('WORKER_PROOF_NOT_CONFIGURED');
  });

  it('the wake signer signs under workerProofSecret(): a proof minted under A fails under B, and JWT_SECRET is not its key', () => {
    process.env[NEW] = A; process.env.JWT_SECRET = B;
    const token = signWakeProof(wake());
    expect(verifyWakeProof(token).workerId).toBe('w');
    process.env[NEW] = B;
    expect(code(() => verifyWakeProof(token))).toBe('WAKE_PROOF_INVALID');
    // JWT_SECRET is B above, so also pin that changing only JWT_SECRET does not matter while NEW is set.
    process.env[NEW] = A; process.env.JWT_SECRET = 'jwt-other-cccccccccccccccccccccccccccccc';
    expect(verifyWakeProof(token).workerId).toBe('w');
  });

  it('the batch signer signs under workerProofSecret(): a proof minted under A fails under B, and JWT_SECRET is not its key', () => {
    process.env[NEW] = A; process.env.JWT_SECRET = B;
    const token = signBatchProof(batch());
    expect(verifyBatchProof(token).workerId).toBe('w');
    process.env[NEW] = B;
    expect(code(() => verifyBatchProof(token))).toBe('WAKE_PROOF_INVALID');
    process.env[NEW] = A; process.env.JWT_SECRET = 'jwt-other-cccccccccccccccccccccccccccccc';
    expect(verifyBatchProof(token).workerId).toBe('w');
  });
});
