import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRateKeys, RateConfigurationError, RATE_KEYRING_REFUSAL } from './config.js';

const SECRET = 'ab12cd34'.repeat(8); // 64 lowercase hex, recognisable
const BAD: Array<[string, string | undefined]> = [
  ['unset', undefined],
  ['empty', ''],
  ['not JSON', 'private-secret'],
  ['valid hex inside broken JSON', `{"current":"k1","keys":{"k1":"${SECRET}"`],
  ['bad current id', JSON.stringify({ current: 'bad id!', keys: { 'bad id!': SECRET } })],
  ['current not among keys', JSON.stringify({ current: 'k2', keys: { k1: SECRET } })],
  ['short key', JSON.stringify({ current: 'k1', keys: { k1: SECRET.slice(2) } })],
  ['three keys', JSON.stringify({ current: 'a', keys: { a: SECRET, b: SECRET, c: SECRET } })],
];

describe('#4527 RATE_LIMIT_KEYRING refusal text', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(BAD)('%s: names the variable and the shape, echoes nothing of the value', (_n, value) => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (value === undefined) delete env.RATE_LIMIT_KEYRING; else env.RATE_LIMIT_KEYRING = value;
    let err: unknown;
    try { readRateKeys(env); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RateConfigurationError);
    const e = err as Error;
    expect(e.message).toBe(RATE_KEYRING_REFUSAL);
    expect(e.message).toContain('RATE_LIMIT_KEYRING');
    expect(e.message).toContain('64 lowercase hex');
    const seen = [e.message, JSON.stringify(e), String(e.stack)].join('\n');
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain(SECRET.slice(0, 16));
    expect(seen).not.toContain('private-secret');
    expect(seen).not.toContain('bad id!');
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });

  it('a valid keyring still reads', () => {
    const r = readRateKeys({ RATE_LIMIT_KEYRING: JSON.stringify({ current: 'k1', keys: { k1: SECRET } }) } as NodeJS.ProcessEnv);
    expect(r.current).toBe('k1');
  });
});
