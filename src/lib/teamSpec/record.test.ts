import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { canonicalizeTeamJson } from './canonicalize.js';
import { readTeamRecordKeys, sealTeamRecord, teamRecordStateText, teamValueToken, verifyTeamRecord, TEAM_RECORD_CODEC } from './record.js';
import { createServer } from '../../server.js';

const k1 = '1'.repeat(64), k2 = '2'.repeat(64);
const ring = () => readTeamRecordKeys(JSON.stringify({ current: 'k1', keys: { k1 } }))!;
const binding = { appId: 'app-one', recordNodeId: 'record-one' };
const state = (keys = ring()) => ({
  managed: { 'role.engineer.prompt': { token: teamValueToken(keys, binding.appId, 'role.engineer.prompt', 'protected text') } },
  annotations: { team: { 'hadron.dev/source': 'team.json' } },
  sources: { engineer: [{ node: 'source-one', revision: 12, token: teamValueToken(keys, binding.appId, 'source.engineer.0', 'a'.repeat(64)) }] },
  identities: { engineer: { agent: 'agent-one' } },
});
const receipt = () => ({ planHash: 'b'.repeat(64), userId: 'user-one', at: '2026-10-06T00:00:00.000Z', summary: { cast: 2 } });
const body = () => JSON.stringify(sealTeamRecord(ring(), binding, state(), receipt()));

describe('team-record codec foundation', () => {
  it('validates keyrings without exposing bad secret input', () => {
    expect(readTeamRecordKeys('')).toBeNull();
    for (const input of ['private-bad-value', JSON.stringify({ current: 'k2', keys: { k1 } }), JSON.stringify({ current: 'k1', keys: { k1: 'too-short' } })]) {
      let message = '';
      try { readTeamRecordKeys(input); } catch (e) { message = (e as Error).message; }
      expect(message).toContain('TEAM_RECORD_KEYRING'); expect(message).not.toContain(input);
    }
  });
  it('refuses server boot on a malformed configured keyring', async () => {
    vi.stubEnv('TEAM_RECORD_KEYRING', 'private-bad-value');
    try {
      await expect(createServer()).rejects.toThrow('TEAM_RECORD_KEYRING must name a current key');
    } finally { vi.unstubAllEnvs(); }
  });
  it('uses domain-separated, App/address-bound value tokens', () => {
    const value = 'protected text';
    const expected = createHmac('sha256', Buffer.from(k1, 'hex'))
      .update('hadron/team-record-token/v1\0')
      .update(canonicalizeTeamJson({ appId: binding.appId, address: 'prompt', value })).digest('base64url');
    expect(teamValueToken(ring(), binding.appId, 'prompt', value)).toBe('k1:' + expected);
    expect(teamValueToken(ring(), 'other-app', 'prompt', value)).not.toBe('k1:' + expected);
    expect(teamValueToken(ring(), binding.appId, 'other-field', value)).not.toBe('k1:' + expected);
  });
  it('round trips a sealed record and binds both App and node identity', () => {
    expect(verifyTeamRecord(ring(), binding, body()).status).toBe('valid');
    for (const other of [{ ...binding, appId: 'other-app' }, { ...binding, recordNodeId: 'other-record' }]) {
      expect(verifyTeamRecord(ring(), other, body())).toEqual({ status: 'refused', code: 'TEAM_RECORD_FOREIGN' });
    }
  });
  it('authenticates state and receipt; receipt does not participate in state comparison', () => {
    const input = JSON.parse(body());
    const changed = { ...input, receipt: { ...input.receipt, userId: 'user-two' } };
    expect(verifyTeamRecord(ring(), binding, JSON.stringify(changed)).status).toBe('refused');
    const signed = sealTeamRecord(ring(), binding, state(), changed.receipt);
    expect(verifyTeamRecord(ring(), binding, JSON.stringify(signed)).status).toBe('valid');
    expect(teamRecordStateText(signed.state)).toBe(teamRecordStateText(input.state));
    input.state.managed['role.engineer.prompt'].token = 'k1:' + 'a'.repeat(43);
    expect(verifyTeamRecord(ring(), binding, JSON.stringify(input)).status).toBe('refused');
  });
  it('distinguishes absence, bad seals, unknown codecs and dropped keys', () => {
    expect(verifyTeamRecord(ring(), binding, null)).toEqual({ status: 'absent' });
    for (const input of ['', '{}', JSON.stringify({ ...JSON.parse(body()), seal: {} })]) {
      expect(verifyTeamRecord(ring(), binding, input)).toEqual({ status: 'refused', code: 'TEAM_RECORD_FOREIGN' });
    }
    expect(verifyTeamRecord(ring(), binding, JSON.stringify({ ...JSON.parse(body()), codec: 'future' }))).toEqual({ status: 'refused', code: 'TEAM_RECORD_UNVERIFIABLE' });
    const dropped = readTeamRecordKeys(JSON.stringify({ current: 'k2', keys: { k2 } }))!;
    expect(verifyTeamRecord(dropped, binding, body())).toEqual({ status: 'refused', code: 'TEAM_RECORD_UNVERIFIABLE' });
  });
  it('retains verification and baseline comparison under an old key across rotation', () => {
    const rotated = readTeamRecordKeys(JSON.stringify({ current: 'k2', keys: { k1, k2 } }))!;
    expect(verifyTeamRecord(rotated, binding, body()).status).toBe('valid');
    expect(teamValueToken(rotated, binding.appId, 'prompt', 'value', 'k1')).toBe(teamValueToken(ring(), binding.appId, 'prompt', 'value'));
    expect(teamValueToken(rotated, binding.appId, 'prompt', 'value')).not.toBe(teamValueToken(ring(), binding.appId, 'prompt', 'value'));
    expect(() => sealTeamRecord(rotated, binding, state(), receipt())).toThrow('baselines must use the current key');
    const resealed = sealTeamRecord(rotated, binding, state(rotated), receipt());
    expect(resealed.seal.keyId).toBe('k2');
    expect(verifyTeamRecord(rotated, binding, JSON.stringify(resealed)).status).toBe('valid');
  });
  it('stores keyed baselines, never plaintext prompts or bare source digests', () => {
    const record = sealTeamRecord(ring(), binding, state(), receipt());
    expect(record.codec).toBe(TEAM_RECORD_CODEC);
    expect(JSON.stringify(record.state)).not.toContain('protected text');
    expect(JSON.stringify(record.state)).not.toContain('a'.repeat(64));
    for (const value of Object.values(record.state.managed)) expect(value.token).toMatch(/^k1:[a-zA-Z0-9_-]{43}$/);
    for (const source of record.state.sources.engineer) expect(source.token).toMatch(/^k1:[a-zA-Z0-9_-]{43}$/);
    expect(Object.keys(record.state).sort()).toEqual(['annotations', 'identities', 'managed', 'sources']);
  });
  it('preserves inert annotation keys across seal and verification', () => {
    const value = state();
    value.annotations.team = JSON.parse('{"__proto__":"note","constructor":"note"}');
    const signed = sealTeamRecord(ring(), binding, value, receipt());
    const checked = verifyTeamRecord(ring(), binding, JSON.stringify(signed));
    expect(checked.status).toBe('valid');
    if (checked.status === 'valid') expect(checked.record.state.annotations.team).toEqual(value.annotations.team);
  });
  it('validates preserved keys in keyrings, nested annotations and receipts', () => {
    expect(() => readTeamRecordKeys(JSON.stringify({ current: 'k1', keys: { k1, ['__proto__']: 'not-hex' } }))).toThrow('TEAM_RECORD_KEYRING');
    const value = state(); value.annotations.team = JSON.parse('{"__proto__":17}');
    expect(() => sealTeamRecord(ring(), binding, value, receipt())).toThrow();
    const input = JSON.parse(body()); input.state.annotations.team = JSON.parse('{"__proto__":17}');
    expect(verifyTeamRecord(ring(), binding, JSON.stringify(input))).toEqual({ status: 'refused', code: 'TEAM_RECORD_FOREIGN' });
    const invalidReceipt = receipt(); invalidReceipt.summary = JSON.parse('{"__proto__":"not-count"}');
    expect(() => sealTeamRecord(ring(), binding, state(), invalidReceipt)).toThrow();
  });
  it('treats malformed Unicode as a foreign record rather than an internal exception', () => {
    const input = JSON.parse(body()); input.state.annotations.team.note = '\ud800';
    expect(verifyTeamRecord(ring(), binding, JSON.stringify(input))).toEqual({ status: 'refused', code: 'TEAM_RECORD_FOREIGN' });
  });
});
