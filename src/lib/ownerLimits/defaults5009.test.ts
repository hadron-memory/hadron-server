/** #5009 (Billing A7a): OWNER_DEFAULT_LIMITS, its shape and its fixed refusal text (the boot refusal is boot5009.test.ts). */
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOwnerDefaultLimits, ownerDefaultLimit, OWNER_DEFAULT_LIMITS_ERROR, parseOwnerDefaultLimits, reloadOwnerDefaultLimitsForTests,
} from './defaults.js';
import { OWNER_LIMIT_KEYS } from './keys.js';

const MARKER = 'x7Qmarker';
afterEach(() => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }));

describe('#5009 parseOwnerDefaultLimits', () => {
  it('reads per owner type; unset and empty mean no limits', () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '{ "user": { "nodes": 2000, "apps": 0 }, "organization": { "apps": 3 } }' });
    expect(ownerDefaultLimit('user', 'nodes')).toBe(2000n);
    expect(ownerDefaultLimit('user', 'apps')).toBe(0n);
    expect(ownerDefaultLimit('organization', 'apps')).toBe(3n);
    expect(ownerDefaultLimit('organization', 'nodes')).toBeNull();
    for (const env of [{}, { OWNER_DEFAULT_LIMITS: '' }, { OWNER_DEFAULT_LIMITS: '  ' }, { OWNER_DEFAULT_LIMITS: '{}' }]) {
      reloadOwnerDefaultLimitsForTests(env);
      expect(ownerDefaultLimit('user', 'nodes')).toBeNull();
    }
  });

  it.each([
    ['malformed JSON', `{"user":${MARKER}`],
    ['an array', `["${MARKER}"]`],
    ['null', 'null'],
    ['a scalar', '5'],
    ['an unknown owner type', `{"${MARKER}":{}}`],
    ['an owner type that is an array', `{"user":["${MARKER}"]}`],
    ['an owner type that is null', '{"user":null}'],
    ['an unknown key', `{"user":{"${MARKER}":1}}`],
    ['an inherited property name', '{"user":{"toString":1}}'],
    ['__proto__', '{"user":{"__proto__":1}}'],
    ['a negative', '{"user":{"nodes":-1}}'],
    ['a fraction', '{"user":{"nodes":1.5}}'],
    ['a string number', '{"user":{"nodes":"7"}}'],
    ['a null value', '{"user":{"nodes":null}}'],
    ['an unsafe integer', '{"user":{"nodes":9007199254740992}}'],
  ])('refuses %s with the fixed sentence', (_name, raw) => {
    expect(() => parseOwnerDefaultLimits(raw)).toThrow(OWNER_DEFAULT_LIMITS_ERROR);
    expect(OWNER_DEFAULT_LIMITS_ERROR).not.toContain(MARKER);
    try { parseOwnerDefaultLimits(raw); } catch (e) {
      expect((e as Error).message).toBe(OWNER_DEFAULT_LIMITS_ERROR);
      expect((e as Error).cause).toBeUndefined();
      expect(String((e as Error).stack)).not.toContain(MARKER);
    }
  });

  it('refuses a key the registry reports but does not let anyone set', () => {
    const entry = OWNER_LIMIT_KEYS.apps as { settable: boolean };
    entry.settable = false;
    try { expect(() => parseOwnerDefaultLimits('{"user":{"apps":1}}')).toThrow(OWNER_DEFAULT_LIMITS_ERROR); } finally { entry.settable = true; }
  });

  it('a failed load keeps the previous defaults', () => {
    loadOwnerDefaultLimits({ OWNER_DEFAULT_LIMITS: '{"user":{"nodes":1}}' });
    expect(() => loadOwnerDefaultLimits({ OWNER_DEFAULT_LIMITS: 'no' })).toThrow(OWNER_DEFAULT_LIMITS_ERROR);
    expect(ownerDefaultLimit('user', 'nodes')).toBe(1n);
  });
});
