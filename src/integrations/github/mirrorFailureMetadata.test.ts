import { describe, expect, it } from 'vitest';
import { mirrorFailureMetadata } from './mirrorFailureMetadata.js';

describe('closed mirror diagnostic allowlist', () => {
  it.each(['P2034', 'P2024', 'P1001', 'P1017'])('keeps actionable Prisma code %s (#3057 BLIND P2)', code => {
    expect(mirrorFailureMetadata({ code }, 'settle', 'SETTLEMENT').providerCode).toBe(code);
  });
  it.each(['PrismaClientInitializationError', 'PrismaClientUnknownRequestError'])('keeps a closed code-less error type %s', name => {
    expect(mirrorFailureMetadata({ name }, 'sequence', 'ATTEMPT_SEQUENCE')).toEqual({ phase: 'sequence', class: 'ATTEMPT_SEQUENCE', errorType: name });
  });
  it('drops free error types, provider codes and signals, including wrapper-shaped fields', () => {
    expect(mirrorFailureMetadata({ name: 'secret', providerCode: 'secret', signal: 'secret', code: 'P2034secret' }, 'push', 'PUSH_FAILED'))
      .toEqual({ phase: 'push', class: 'PUSH_FAILED' });
  });

  it.each([128, 0, 255])('retains bounded Git code %s', code => {
    expect(mirrorFailureMetadata({ code }, 'git', 'GIT_COMMAND_FAILED')).toEqual({ phase: 'git', class: 'GIT_COMMAND_FAILED', exitCode: code });
  });
  it.each([null, undefined, '128', -1, 256, NaN, Infinity, 1.5, {}, true])('drops invalid numeric fields %#', value => {
    expect(mirrorFailureMetadata({ exitCode: value, code: value }, 'push', 'PUSH_FAILED')).toEqual({ phase: 'push', class: 'PUSH_FAILED' });
  });
  it.each([100, 503, 599])('retains HTTP status %s', status => {
    expect(mirrorFailureMetadata({ status }, 'token', 'TOKEN_UNAVAILABLE').httpStatus).toBe(status);
  });
  it.each([99, 600, '503', 503.5])('drops invalid HTTP status %#', status => {
    expect(mirrorFailureMetadata({ status }, 'token', 'TOKEN_UNAVAILABLE').httpStatus).toBeUndefined();
  });
  it('accepts only named provider codes; ignores all other error fields', () => {
    expect(mirrorFailureMetadata({ code: 'P2028', message: 'SECRET', name: 'SECRET', cause: 'SECRET', arbitrary: 'SECRET' }, 'settle', 'SETTLEMENT'))
      .toEqual({ phase: 'settle', class: 'SETTLEMENT', providerCode: 'P2028' });
    expect(mirrorFailureMetadata({ code: 'P2028SECRET' }, 'settle', 'SETTLEMENT')).toEqual({ phase: 'settle', class: 'SETTLEMENT' });
  });
  it('avoids accessors/conversion and contains throwing Proxy traps', () => {
    const value = { get code() { throw new Error('secret'); }, toString() { throw new Error('secret'); } };
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret'); } });
    for (const error of [value, proxy, 'secret', null, Object.create({ exitCode: 128 })]) {
      expect(mirrorFailureMetadata(error, 'lock', 'LOCK_FAILED')).toEqual({ phase: 'lock', class: 'LOCK_FAILED' });
    }
  });
});
