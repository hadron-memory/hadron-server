import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { isSerializationFailure, retryOnSerializationFailure } from './serializableRetry.js';

// #2876: a 40001 raised by a raw statement ($queryRaw / $executeRaw) reaches
// the caller as P2010 with the SQLSTATE in meta.code, not as P2034. The retry
// helper must re-run those, and only those: a P2010 wrapping any other
// database code is a real failure and propagates on the first attempt.
const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`raw failure ${code}`, { code, clientVersion: 'test', meta });

const countRuns = async (error: unknown) => {
  let runs = 0;
  const outcome = await retryOnSerializationFailure(async () => {
    runs += 1;
    if (runs === 1) throw error;
    return 'retried';
  }).catch((e: unknown) => e);
  return { runs, outcome };
};

describe('#2876 serialization failures from raw statements', () => {
  it('a P2010 wrapping 40001 is a serialization failure and is retried', async () => {
    const error = known('P2010', { code: '40001', message: 'could not serialize access' });
    expect(isSerializationFailure(error)).toBe(true);
    expect(await countRuns(error)).toEqual({ runs: 2, outcome: 'retried' });
  });

  it.each(['40P01', '23505', '57014', undefined])('a P2010 wrapping %s is not retried', async (dbCode) => {
    const error = known('P2010', dbCode === undefined ? undefined : { code: dbCode });
    expect(isSerializationFailure(error)).toBe(false);
    const { runs, outcome } = await countRuns(error);
    expect(runs).toBe(1);
    expect(outcome).toBe(error);
  });

  it('control: P2034 is still retried, and a non-Prisma 40001 look-alike is not', async () => {
    expect(await countRuns(known('P2034'))).toEqual({ runs: 2, outcome: 'retried' });
    const lookAlike = Object.assign(new Error('40001'), { code: 'P2010', meta: { code: '40001' } });
    expect(isSerializationFailure(lookAlike)).toBe(false);
    expect((await countRuns(lookAlike)).runs).toBe(1);
  });
});
