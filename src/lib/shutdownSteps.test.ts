import { describe, expect, it, vi } from 'vitest';
import { errorToken, logFailedShutdownSteps, settleStep } from './shutdownSteps.js';

describe('#3845 shutdownSteps', () => {
  it('errorToken keeps only a plain code or name, never a message', () => {
    expect(errorToken(Object.assign(new Error('secret'), { code: 'ERR_SERVER_NOT_RUNNING' }))).toBe('ERR_SERVER_NOT_RUNNING');
    expect(errorToken(new TypeError('secret'))).toBe('TypeError');
    expect(errorToken(Object.assign(new Error('x'), { code: 'has space/url://' }))).toBe('Error');
    expect(errorToken('a string with secret')).toBe('unknown');
    expect(errorToken(null)).toBe('unknown');
    expect(errorToken({ code: 5, name: 'x'.repeat(100) })).toBe('unknown');
  });

  it('settleStep turns a rejection into a token and passes an outcome through', async () => {
    expect(await settleStep(Promise.resolve('grace_timeout'))).toBe('grace_timeout');
    expect(await settleStep(Promise.reject(new RangeError('secret')))).toBe('rejected:RangeError');
  });

  it('logFailedShutdownSteps logs only the failing steps and returns their count', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(logFailedShutdownSteps([['a', 'ok'], ['b', 'grace_timeout'], ['c', 'ok']])).toBe(1);
    expect(err.mock.calls).toEqual([['shutdown.step_failed step=b outcome=grace_timeout']]);
    err.mockRestore();
  });
});
