/** #4731: a sync's stored and returned failure text names no host; an operator-facing refusal keeps its words. */
import { describe, expect, it } from 'vitest';
import { INTERNAL_SYNC_FAILURE, infrastructureFaultText, syncFailureText } from './syncErrorText.js';
import { GitCommandError } from './execGit.js';

describe('#4731 syncFailureText', () => {
  it.each([
    ['a Node connect error', Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED', syscall: 'connect', errno: -111 }), `${INTERNAL_SYNC_FAILURE} (ECONNREFUSED)`],
    ['a Postgres error with a SQLSTATE', Object.assign(new Error('terminating connection on host db-7.internal'), { code: '57P01', severity: 'FATAL' }), `${INTERNAL_SYNC_FAILURE} (57P01)`],
    ['a Prisma-coded error', Object.assign(new Error("Can't reach database server at `db-7.internal:5432`"), { code: 'P1001' }), `${INTERNAL_SYNC_FAILURE} (P1001)`],
    ['a Prisma client error without a code', Object.assign(new Error('engine failed at host 10.0.0.5'), { name: 'PrismaClientInitializationError' }), INTERNAL_SYNC_FAILURE],
  ])('%s becomes fixed text plus its code', (_label, error, expected) => {
    expect(syncFailureText(error)).toBe(expected);
    expect(syncFailureText(error)).not.toMatch(/10\.0\.0\.5|db-7|internal:/);
  });

  it.each([
    ['an operator-facing refusal', new Error('Invalid memory source: ext::whoami')],
    ['a git failure (fixed, credential-free text)', new GitCommandError(new Error('x'))],
    ['a plain error with a short code that is not a SQLSTATE', Object.assign(new Error('odd'), { code: 'GIT_COMMAND_FAILED' })],
  ])('%s keeps its own message', (_label, error) => {
    expect(infrastructureFaultText(error)).toBeNull();
    expect(syncFailureText(error)).toBe((error as Error).message);
  });

  it('a non-object is not an infrastructure fault', () => {
    expect(infrastructureFaultText('boom')).toBeNull();
    expect(infrastructureFaultText(null)).toBeNull();
  });

  it('a thrown non-Error is stored as its own text, never undefined (#4731 BLIND F6)', () => {
    expect(syncFailureText('boom')).toBe('boom');
    expect(syncFailureText(null)).toBe('null');
    expect(syncFailureText({ message: 'obj' })).toBe('obj');
  });
});
