/**
 * #4318: the deadlock predicate and its bounded retry are separate from the serialization ones, so the existing callers of
 * `retryOnSerializationFailure` keep exactly their behaviour (a 40P01 is still not a serialization failure for them).
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { DEADLOCK_RETRIES, isDeadlock, isSerializationFailure, retryOnDeadlock } from './serializableRetry.js';

const raw = (code: string) => new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${code}\``, { code: 'P2010', clientVersion: 'test', meta: { code } });
const p2034 = () => new Prisma.PrismaClientKnownRequestError(
  'Transaction failed due to a write conflict or a deadlock. Please retry your transaction', { code: 'P2034', clientVersion: 'test' });

describe('#4318 isDeadlock', () => {
  it('matches only the structured SQLSTATE 40P01; Prisma\'s ambiguous conflict-or-deadlock P2034 is not a deadlock', () => {
    expect(isDeadlock(raw('40P01'))).toBe(true);
    for (const e of [p2034(), raw('40001'), raw('23505'), new Error('40P01'), undefined, 'deadlock']) expect(isDeadlock(e)).toBe(false);
  });
  it('leaves isSerializationFailure unchanged: a raw 40P01 is still not a serialization failure', () => {
    expect(isSerializationFailure(raw('40P01'))).toBe(false);
    expect(isSerializationFailure(raw('40001'))).toBe(true);
  });
});

describe('#4318 retryOnDeadlock', () => {
  it('re-runs the whole transaction on a deadlock and returns the first success', async () => {
    let runs = 0;
    await expect(retryOnDeadlock(async () => { if (++runs < 3) throw raw('40P01'); return 'done'; })).resolves.toBe('done');
    expect(runs).toBe(3);
  });
  it('is bounded: after DEADLOCK_RETRIES re-runs the 40P01 surfaces unchanged', async () => {
    let runs = 0;
    const e = raw('40P01');
    await expect(retryOnDeadlock(async () => { runs++; throw e; })).rejects.toBe(e);
    expect(runs).toBe(DEADLOCK_RETRIES + 1);
  });
  it('never retries another failure: a serialization abort, a P2034 write conflict or anything else', async () => {
    for (const e of [raw('40001'), p2034(), raw('23505'), new Error('boom')]) {
      let runs = 0;
      await expect(retryOnDeadlock(async () => { runs++; throw e; })).rejects.toBe(e);
      expect(runs).toBe(1);
    }
  });
});
