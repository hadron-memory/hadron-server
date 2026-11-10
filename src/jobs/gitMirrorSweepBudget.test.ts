import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Git mirror sweep row budget', () => {
  it.each(['1', '200', '2147483647'])('accepts positive bounded integer %s', async value => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', value);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gitMirrorSweepRowBudget } = await import('./gitMirrorSweepBudget.js');
    expect(gitMirrorSweepRowBudget()).toBe(Number(value));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '2147483648', 'secret-not-a-budget'])
  ('falls back without disabling or echoing invalid input %s', async value => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', value);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gitMirrorSweepRowBudget } = await import('./gitMirrorSweepBudget.js');
    expect(gitMirrorSweepRowBudget()).toBe(200);
    expect(gitMirrorSweepRowBudget()).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      '[git-mirror-sweep] GIT_MIRROR_SWEEP_MAX_ROWS unset or invalid; using 200 rows per run',
    ]);
  });

  it('reads an operator change for the next tick', async () => {
    const { gitMirrorSweepRowBudget } = await import('./gitMirrorSweepBudget.js');
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '5');
    expect(gitMirrorSweepRowBudget()).toBe(5);
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '2');
    expect(gitMirrorSweepRowBudget()).toBe(2);
  });
});
