/**
 * #4509: the wake/batch proof secret is read under its new env name first, then the old `TEAM_ATTENTION_TOKEN_SECRET`
 * for one deprecation cycle, then `JWT_SECRET` (the existing fallback). The error code and the signer message stay as
 * they are in this slice. A value never appears in the warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacyProofSecretWarning, workerProofSecret } from './ownWorkerSessions.js';

const NEW = 'WORKER_PROOF_TOKEN_SECRET';
const OLD = 'TEAM_ATTENTION_TOKEN_SECRET';
const saved: Record<string, string | undefined> = {};
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of [NEW, OLD, 'JWT_SECRET']) { saved[k] = process.env[k]; delete process.env[k]; }
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetLegacyProofSecretWarning();
});
afterEach(() => {
  for (const k of [NEW, OLD, 'JWT_SECRET']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  warn.mockRestore();
});

describe('#4509 the proof secret env name, dual-read', () => {
  it('only the new name set: the signer is configured and no warning is logged', () => {
    process.env[NEW] = 'new-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(workerProofSecret()).toBe('new-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(warn).not.toHaveBeenCalled();
  });

  it('only the old name set: its value is used and one warning is logged that carries neither value', () => {
    process.env[OLD] = 'old-value-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    process.env.JWT_SECRET = 'jwt-value-cccccccccccccccccccccccccccccc';
    expect(workerProofSecret()).toBe('old-value-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0].join(' '));
    expect(line).toContain(OLD);
    expect(line).toContain(NEW);
    expect(line).not.toContain('old-value');
    expect(line).not.toContain('jwt-value');
  });

  it('both set: the new name wins, with no warning', () => {
    process.env[NEW] = 'new-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env[OLD] = 'old-value-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(workerProofSecret()).toBe('new-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(warn).not.toHaveBeenCalled();
  });

  it('neither name set: the JWT_SECRET fallback, with no warning', () => {
    process.env.JWT_SECRET = 'jwt-value-cccccccccccccccccccccccccccccc';
    expect(workerProofSecret()).toBe('jwt-value-cccccccccccccccccccccccccccccc');
    expect(warn).not.toHaveBeenCalled();
  });

  it('none of the three: today\'s refusal and today\'s signer message', () => {
    expect(() => workerProofSecret()).toThrow('The team-attention token signer is not configured.');
    try { workerProofSecret(); } catch (e) { expect((e as { extensions?: { code?: string } }).extensions?.code).toBe('TEAM_ATTENTION_NOT_CONFIGURED'); }
  });

  it('the warning is logged once per process, not on every read', () => {
    process.env[OLD] = 'old-value-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    workerProofSecret(); workerProofSecret(); workerProofSecret();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
