import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { GitCommandError } from './execGit.js';
import { mirrorFailureMetadata } from './mirrorFailureMetadata.js';

describe('closed mirror diagnostic allowlist', () => {
  it.each(['P1001', 'P1017'])('reads the real Prisma initialization errorCode %s', errorCode => {
    const error = new Prisma.PrismaClientInitializationError('synthetic-secret-3057', 'test', errorCode);
    expect(Object.getOwnPropertyDescriptor(error, 'errorCode')?.value).toBe(errorCode);
    expect(mirrorFailureMetadata(error, 'sequence', 'ATTEMPT_SEQUENCE')).toEqual({
      phase: 'sequence', class: 'ATTEMPT_SEQUENCE', providerCode: errorCode, errorType: 'PrismaClientInitializationError',
    });
  });
  it.each([
    ['PrismaClientInitializationError', () => new Prisma.PrismaClientInitializationError('secret', 'test')],
    ['PrismaClientKnownRequestError', () => new Prisma.PrismaClientKnownRequestError('secret', { clientVersion: 'test', code: 'P2034' })],
    ['PrismaClientUnknownRequestError', () => new Prisma.PrismaClientUnknownRequestError('secret', { clientVersion: 'test' })],
    ['PrismaClientRustPanicError', () => new Prisma.PrismaClientRustPanicError('secret', 'test')],
    ['PrismaClientValidationError', () => new Prisma.PrismaClientValidationError('secret', { clientVersion: 'test' })],
  ] as const)('preserves the real own name of %s', (name, make) => {
    const error = make();
    expect(Object.getOwnPropertyDescriptor(error, 'name')?.value).toBe(name);
    expect(mirrorFailureMetadata(error, 'settle', 'SETTLEMENT').errorType).toBe(name);
  });
  it.each(['Error', 'TypeError', 'RangeError'])('an own name of %s is not an allowlisted errorType', name => {
    expect(mirrorFailureMetadata({ name }, 'tree', 'TREE_WRITE')).toEqual({ phase: 'tree', class: 'TREE_WRITE' });
  });
  it.each([new Error('secret'), new TypeError('secret'), new RangeError('secret')])('real native Error instances yield only phase and class (their name is inherited, not own) %#', error => {
    expect(mirrorFailureMetadata(error, 'tree', 'TREE_WRITE')).toEqual({ phase: 'tree', class: 'TREE_WRITE' });
  });
  it('the real GitCommandError has an own name and yields errorType GitCommandError', () => {
    const error = new GitCommandError({ code: 'EACCES' });
    expect(Object.getOwnPropertyDescriptor(error, 'name')?.value).toBe('GitCommandError');
    expect(mirrorFailureMetadata(error, 'git', 'GIT_COMMAND_FAILED')).toEqual({
      phase: 'git', class: 'GIT_COMMAND_FAILED', providerCode: 'EACCES', errorType: 'GitCommandError',
    });
  });
  it.each(['code', 'name', 'errorCode', 'providerCode'] as const)('ignores an inherited allowlisted %s', key => {
    const value = key === 'name' ? 'PrismaClientInitializationError' : key === 'providerCode' ? 'EACCES' : 'P1001';
    const inherited = Object.create({ [key]: value, ...(key === 'providerCode' ? { code: 'GIT_COMMAND_FAILED' } : {}) });
    expect(mirrorFailureMetadata(inherited, 'settle', 'SETTLEMENT')).toEqual({ phase: 'settle', class: 'SETTLEMENT' });
  });
  it('a non-allowlisted native code falls through to an allowlisted errorCode', () => {
    expect(mirrorFailureMetadata({ code: 'EPERM', errorCode: 'P1001' }, 'sequence', 'ATTEMPT_SEQUENCE'))
      .toEqual({ phase: 'sequence', class: 'ATTEMPT_SEQUENCE', providerCode: 'P1001' });
    expect(mirrorFailureMetadata({ code: 'EPERM', errorCode: 'EPERM' }, 'sequence', 'ATTEMPT_SEQUENCE'))
      .toEqual({ phase: 'sequence', class: 'ATTEMPT_SEQUENCE' });
  });
  it.each([['sequence', 'ATTEMPT_SEQUENCE'], ['settle', 'SETTLEMENT']] as const)('a real initialization error at %s keeps providerCode and errorType together', (phase, cls) => {
    const error = new Prisma.PrismaClientInitializationError('synthetic-secret-3057', 'test', 'P1001');
    expect(mirrorFailureMetadata(error, phase, cls)).toEqual({ phase, class: cls, providerCode: 'P1001', errorType: 'PrismaClientInitializationError' });
  });
  it('prefers native code except for the fixed Git wrapper marker', () => {
    expect(mirrorFailureMetadata({ code: 'P2002', providerCode: 'ENOENT', errorCode: 'P1001' }, 'settle', 'SETTLEMENT').providerCode).toBe('P2002');
    expect(mirrorFailureMetadata({ code: 'GIT_COMMAND_FAILED', providerCode: 'EACCES' }, 'push', 'PUSH_FAILED').providerCode).toBe('EACCES');
    expect(mirrorFailureMetadata({ code: 'GIT_COMMAND_FAILED', providerCode: 'secret' }, 'push', 'PUSH_FAILED').providerCode).toBe('GIT_COMMAND_FAILED');
  });
  it('never invokes name or initialization-code getters', () => {
    let reads = 0;
    const error = Object.defineProperties({}, {
      name: { get() { reads++; return 'PrismaClientInitializationError'; } },
      errorCode: { get() { reads++; return 'P1001'; } },
    });
    expect(mirrorFailureMetadata(error, 'settle', 'SETTLEMENT')).toEqual({ phase: 'settle', class: 'SETTLEMENT' });
    expect(reads).toBe(0);
  });

  it.each(['P2034', 'P2024', 'P1001', 'P1017'])('keeps actionable Prisma code %s (#3057 BLIND P2)', code => {
    expect(mirrorFailureMetadata({ code }, 'settle', 'SETTLEMENT').providerCode).toBe(code);
  });
  it.each(['PrismaClientInitializationError', 'PrismaClientUnknownRequestError'])('keeps a closed code-less error type %s', name => {
    expect(mirrorFailureMetadata({ name }, 'sequence', 'ATTEMPT_SEQUENCE')).toEqual({ phase: 'sequence', class: 'ATTEMPT_SEQUENCE', errorType: name });
  });
  it('drops free error types, provider codes and signals, including wrapper-shaped fields', () => {
    expect(mirrorFailureMetadata({ name: 'secret', providerCode: 'secret', signal: 'secret', code: 'P2034secret', errorCode: 'secret' }, 'push', 'PUSH_FAILED'))
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
