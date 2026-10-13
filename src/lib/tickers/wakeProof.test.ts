import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signWakeProof, verifyWakeProof, sameRequester, type WakeProof } from './wakeProof.js';
import { attentionTokenSecret } from '../teamAttention.js';

const proof = (over: Partial<WakeProof> = {}): WakeProof => ({
  v: 1, kind: 'wake-proof', appId: 'a', workerId: 'w', requester: { userId: 'u' }, channels: [], ticks: [], exempt: false, issuedAt: Date.now(), ...over,
});
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as any).extensions?.code; }
  return null;
};

describe('wake proofs — R4', () => {
  it('round-trips and binds the requester', () => {
    const p = verifyWakeProof(signWakeProof(proof()));
    expect(p.workerId).toBe('w');
    expect(sameRequester(p, { userId: 'u' })).toBe(true);
    expect(sameRequester(p, { userId: 'someone-else' })).toBe(false);
    expect(sameRequester(p, { appKeyId: 'u' })).toBe(false);
  });

  it('refuses a tampered payload, garbage and non-strings', () => {
    const t = signWakeProof(proof());
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...proof(), workerId: 'other' })).toString('base64url');
    expect(code(() => verifyWakeProof(`${forged}.${sig}`))).toBe('WAKE_PROOF_INVALID');
    expect(code(() => verifyWakeProof(`${body}.x`))).toBe('WAKE_PROOF_INVALID');
    expect(code(() => verifyWakeProof('nope'))).toBe('WAKE_PROOF_INVALID');
    expect(code(() => verifyWakeProof(42))).toBe('WAKE_PROOF_INVALID');
  });

  it('an unknown version is refused even when correctly signed', () => {
    expect(code(() => verifyWakeProof(signWakeProof({ ...proof(), v: 2 } as never)))).toBe('WAKE_PROOF_INVALID');
  });

  it('is domain-separated from the attention token: a token signed under the attention key is not a proof', () => {
    const body = Buffer.from(JSON.stringify(proof())).toString('base64url');
    const attentionKey = createHmac('sha256', attentionTokenSecret()).update('hadron/team-attention/v1').digest();
    const asAttention = `${body}.${createHmac('sha256', attentionKey).update(body).digest('base64url')}`;
    expect(code(() => verifyWakeProof(asAttention))).toBe('WAKE_PROOF_INVALID');
    // and a proof signed with the raw secret (no domain) is refused too
    const raw = `${body}.${createHmac('sha256', attentionTokenSecret()).update(body).digest('base64url')}`;
    expect(code(() => verifyWakeProof(raw))).toBe('WAKE_PROOF_INVALID');
  });
});
