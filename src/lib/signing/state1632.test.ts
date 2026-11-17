/**
 * #1632 — pure pins for signature-state derivation (cor:dmo:130:04) and the
 * S0 conformance fixture's approval hashes (#1629). The v1 payload it also carries is no longer built or
 * accepted (R80, #1632 S2b-2): the v3 bytes are pinned in payloadV3_1632.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeApprovalHash } from '../approvalHash.js';
import { signatureChallenge, signaturePayloadBytes, UnsupportedSignaturePayloadError } from './payload.js';
import { compareSignaturesForDisplay, deriveSignatureState, rollUpSignatureState, type SignatureStateInput } from './state.js';

const t = (iso: string) => new Date(`2026-10-13T${iso}Z`);
const noWindow = { revokedAt: null, windowEndsAt: null, windowEndedAt: null, windowOutcome: null };
const base = (over: Partial<SignatureStateInput> = {}): SignatureStateInput => ({
  verifiedAt: t('10:00:00'), valid: true, passkey: noWindow, contentChangedAt: null, memoryEncrypted: false, now: t('12:00:00'), ...over,
});

describe('deriveSignatureState (cor:dmo:130:04)', () => {
  it('CURRENT with no content change since; EARLIER after one; same millisecond counts as changed', () => {
    expect(deriveSignatureState(base())).toBe('CURRENT');
    expect(deriveSignatureState(base({ contentChangedAt: t('09:00:00') }))).toBe('CURRENT');
    expect(deriveSignatureState(base({ contentChangedAt: t('11:00:00') }))).toBe('EARLIER');
    expect(deriveSignatureState(base({ contentChangedAt: t('10:00:00') }))).toBe('EARLIER');
  });

  it('NOT_APPLICABLE beats everything on an encrypted node; INVALID next', () => {
    expect(deriveSignatureState(base({ memoryEncrypted: true, valid: false }))).toBe('NOT_APPLICABLE');
    expect(deriveSignatureState(base({ valid: false }))).toBe('INVALID');
  });

  const window = (over: Partial<SignatureStateInput['passkey']> = {}) => ({
    revokedAt: null, windowEndsAt: t('20:00:00'), windowEndedAt: null, windowOutcome: null, ...over,
  });

  it('PENDING inside an open first-passkey window; EARLIER instead once content changed (#10014)', () => {
    expect(deriveSignatureState(base({ passkey: window() }))).toBe('PENDING');
    expect(deriveSignatureState(base({ passkey: window(), contentChangedAt: t('11:00:00') }))).toBe('EARLIER');
  });

  it('CANCELLED when the passkey was revoked inside the window, by the cancel link or any route (#10398)', () => {
    expect(deriveSignatureState(base({ passkey: window({ revokedAt: t('11:00:00'), windowEndedAt: t('11:00:00'), windowOutcome: 'cancelled' }) }))).toBe('CANCELLED');
    expect(deriveSignatureState(base({ passkey: window({ revokedAt: t('11:00:00') }) }))).toBe('CANCELLED');
    expect(deriveSignatureState(base({ passkey: window({ revokedAt: t('11:00:00') }), contentChangedAt: t('11:30:00') }))).toBe('CANCELLED');
  });

  it('counts once the window ends normally: ran out, or ended early (#10013)', () => {
    expect(deriveSignatureState(base({ now: t('21:00:00'), passkey: window() }))).toBe('CURRENT');
    expect(deriveSignatureState(base({ passkey: window({ windowEndedAt: t('11:00:00'), windowOutcome: 'ended-early' }) }))).toBe('CURRENT');
  });

  it('a signature made after the window ended was never pending', () => {
    expect(deriveSignatureState(base({ verifiedAt: t('11:30:00'), passkey: window({ windowEndedAt: t('11:00:00'), windowOutcome: 'ended-early' }) }))).toBe('CURRENT');
  });

  it('a passkey revoked after the window keeps the signature\'s state', () => {
    expect(deriveSignatureState(base({ now: t('23:00:00'), passkey: window({ revokedAt: t('22:00:00') }) }))).toBe('CURRENT');
    expect(deriveSignatureState(base({ passkey: { ...noWindow, revokedAt: t('11:00:00') } }))).toBe('CURRENT');
  });
});

describe('roll-up and display order (cor:dmo:130:06)', () => {
  it('rolls up to the best state; NOT_APPLICABLE when encrypted; null with none', () => {
    expect(rollUpSignatureState(['EARLIER', 'CURRENT'], false)).toBe('CURRENT');
    expect(rollUpSignatureState(['CANCELLED', 'EARLIER', 'PENDING'], false)).toBe('PENDING');
    expect(rollUpSignatureState([], true)).toBe('NOT_APPLICABLE');
    expect(rollUpSignatureState([], false)).toBeNull();
  });
  it('lists current signers first, then newest first', () => {
    const rows = [
      { state: 'EARLIER' as const, verifiedAt: t('12:00:00') },
      { state: 'CURRENT' as const, verifiedAt: t('09:00:00') },
      { state: 'PENDING' as const, verifiedAt: t('11:00:00') },
    ].sort(compareSignaturesForDisplay);
    expect(rows.map((r) => r.state)).toEqual(['CURRENT', 'EARLIER', 'PENDING']);
  });
});

describe('the S0 fixture still pins the approval hash, and its v1 payload is no longer built (#1629, R80)', () => {
  const fixture = JSON.parse(readFileSync('src/lib/signaturePayload.fixture.json', 'utf8')) as {
    cases: Array<{ name: string; input: { nodeId: string; fields: { title: string | null; abstract: string | null; content: string | null } };
      approvalHash: string; canonical: string; challengeHex: string }>;
  };
  for (const c of fixture.cases) {
    it(c.name, () => {
      const approvalHash = computeApprovalHash(c.input.fields as never);
      expect(approvalHash).toBe(c.approvalHash);
      // The v1 bytes are the fixture's own literal framing: still the S0 contract, no longer produced by the server.
      const v1 = Buffer.from(`hadron-signature-v1\nnode ${c.input.nodeId}\napproval-hash ${approvalHash}\n`, 'utf8');
      expect(v1.toString('base64')).toBe(c.canonical);
      expect(signatureChallenge(v1).toString('hex')).toBe(c.challengeHex);
      expect(() => signaturePayloadBytes('hadron-signature-v1', { nodeId: c.input.nodeId, approvalHash })).toThrow(UnsupportedSignaturePayloadError);
    });
  }
  it('refuses v1 (R80) and v2 (retired) loudly, and malformed input', () => {
    const ok = { nodeId: 'n', approvalHash: 'a'.repeat(64), requestId: 'AAAAAAAAAAAAAAAAAAAAAA' };
    expect(() => signaturePayloadBytes('hadron-signature-v1', ok)).toThrow(UnsupportedSignaturePayloadError);
    expect(() => signaturePayloadBytes('hadron-signature-v2', ok)).toThrow(UnsupportedSignaturePayloadError);
    expect(() => signaturePayloadBytes('hadron-signature-v3', { ...ok, approvalHash: 'A'.repeat(64) })).toThrow();
    expect(() => signaturePayloadBytes('hadron-signature-v3', { ...ok, nodeId: 'a\nb' })).toThrow();
  });
});
