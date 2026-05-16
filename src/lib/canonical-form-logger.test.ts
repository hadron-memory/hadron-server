import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  logCanonicalRewrite,
  setSampleRateForTesting,
} from './canonical-form-logger.js';

describe('logCanonicalRewrite', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let restoreSample: (() => void) | null = null;

  beforeEach(() => {
    // eslint-disable-next-line no-console
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (restoreSample) {
      restoreSample();
      restoreSample = null;
    }
  });

  it('emits one entry per AliasCategory that fired', () => {
    restoreSample = setSampleRateForTesting(1);
    logCanonicalRewrite(
      'urn:agent:org::app:slug::agent:author:agent-slug',
      'urn:agent:org::slug::author:agent-slug',
      ['type-marker-optionality', 'path-slug-shortening'],
    );
    expect(logSpy).toHaveBeenCalledTimes(2);
    const first = JSON.parse(logSpy.mock.calls[0][0] as string);
    const second = JSON.parse(logSpy.mock.calls[1][0] as string);
    expect(first.alias_category).toBe('type-marker-optionality');
    expect(second.alias_category).toBe('path-slug-shortening');
  });

  it('emits the contracted shape (level, event, urns, timestamp)', () => {
    restoreSample = setSampleRateForTesting(1);
    logCanonicalRewrite(
      'urn:agent:org::app:slug',
      'urn:agent:org::slug',
      ['type-marker-optionality'],
    );
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({
      level: 'info',
      event: 'urn.canonical-rewrite',
      alias_category: 'type-marker-optionality',
      input_urn: 'urn:agent:org::app:slug',
      canonical_urn: 'urn:agent:org::slug',
    });
    expect(typeof entry.timestamp).toBe('string');
    expect(new Date(entry.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('includes request_id and user_id from context when supplied', () => {
    restoreSample = setSampleRateForTesting(1);
    logCanonicalRewrite(
      'urn:agent:org::app:slug',
      'urn:agent:org::slug',
      ['type-marker-optionality'],
      { requestId: 'req_xyz', userId: 'usr_abc' },
    );
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.request_id).toBe('req_xyz');
    expect(entry.user_id).toBe('usr_abc');
  });

  it('omits context fields when not supplied', () => {
    restoreSample = setSampleRateForTesting(1);
    logCanonicalRewrite(
      'urn:agent:org::app:slug',
      'urn:agent:org::slug',
      ['type-marker-optionality'],
    );
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.request_id).toBeUndefined();
    expect(entry.user_id).toBeUndefined();
  });

  it('does NOT log when input equals canonical (no rewrite)', () => {
    restoreSample = setSampleRateForTesting(1);
    logCanonicalRewrite(
      'urn:agent:org::slug',
      'urn:agent:org::slug',
      [],
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does NOT log when rewriteCategories is empty even if URNs differ', () => {
    // Defensive: rewriteCategories is the source of truth for "did
    // anything fire". An empty list means no rewrite to log even if the
    // strings happen to differ.
    restoreSample = setSampleRateForTesting(1);
    logCanonicalRewrite(
      'urn:agent:org::slug',
      'urn:agent:org::other',
      [],
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does NOT log when sample rate is 0', () => {
    restoreSample = setSampleRateForTesting(0);
    logCanonicalRewrite(
      'urn:agent:org::app:slug',
      'urn:agent:org::slug',
      ['type-marker-optionality'],
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs 100% of rewrites at sample rate 1', () => {
    restoreSample = setSampleRateForTesting(1);
    for (let i = 0; i < 50; i++) {
      logCanonicalRewrite(
        `urn:agent:org${i}::app:slug`,
        `urn:agent:org${i}::slug`,
        ['type-marker-optionality'],
      );
    }
    expect(logSpy).toHaveBeenCalledTimes(50);
  });

  it('samples approximately the configured fraction at intermediate rates', () => {
    // 10% rate over 1000 trials: expected ~100 with stdev ~9.5
    // (Bernoulli np=100, npq~90, sqrt(90)~9.5). Use a generous ±50
    // window to keep the test from flaking; the goal is to verify the
    // sample gate is wired, not to measure Math.random.
    restoreSample = setSampleRateForTesting(0.1);
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      logCanonicalRewrite(
        `urn:agent:org${i}::app:slug`,
        `urn:agent:org${i}::slug`,
        ['type-marker-optionality'],
      );
    }
    expect(logSpy.mock.calls.length).toBeGreaterThan(50);
    expect(logSpy.mock.calls.length).toBeLessThan(150);
  });
});
