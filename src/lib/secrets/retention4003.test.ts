/**
 * #4003 (S8 of #3991) — `SECRET_VERSION_RETENTION_DAYS` (open question 10, ruled R5: "30 days").
 *
 * A plain integer from 1 to 3650, default 30. Unset is the default with no warning. An empty or invalid value
 * (0, negatives, fractions, exponent or hex spellings, anything above 3650, junk) falls back to 30 with ONE warn
 * line, so no value becomes "keep forever" or "purge at once" by accident; the value is never echoed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SECRET_VERSION_RETENTION_DAYS,
  resetSecretRetentionWarningsForTests,
  secretVersionRetentionDays,
} from './retention.js';

const ENV = 'SECRET_VERSION_RETENTION_DAYS';
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env[ENV];
  resetSecretRetentionWarningsForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env[ENV];
  vi.restoreAllMocks();
});

describe('SECRET_VERSION_RETENTION_DAYS (R5)', () => {
  it('defaults to 30 when unset, without a warning', () => {
    expect(DEFAULT_SECRET_VERSION_RETENTION_DAYS).toBe(30);
    expect(secretVersionRetentionDays()).toBe(30);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts every plain integer from 1 to 3650', () => {
    for (const [raw, want] of [['1', 1], ['30', 30], ['365', 365], ['3650', 3650], [' 90 ', 90]] as const) {
      process.env[ENV] = raw;
      expect(secretVersionRetentionDays()).toBe(want);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '0', '-1', '-30', '1.5', '30.0', '3651', '99999999999999999999', '1e2', '0x1e', '+30', 'thirty', '30d'])(
    'falls back to 30 with one warn line for %j, never echoing the value',
    (raw) => {
      process.env[ENV] = raw;
      expect(secretVersionRetentionDays()).toBe(30);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain(ENV);
      if (raw.trim() !== '') expect(line).not.toContain(raw.trim());
    },
  );

  it('warns once, not on every read, for the same invalid value', () => {
    process.env[ENV] = '0';
    for (let i = 0; i < 5; i++) expect(secretVersionRetentionDays()).toBe(30);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is read per call, so a corrected value takes effect without a restart', () => {
    process.env[ENV] = 'junk';
    expect(secretVersionRetentionDays()).toBe(30);
    process.env[ENV] = '7';
    expect(secretVersionRetentionDays()).toBe(7);
  });
});
