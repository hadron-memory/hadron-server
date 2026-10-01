/**
 * #1544 follow-up: the shared SERIALIZABLE retry re-runs only on P2034, gives
 * up after SERIALIZATION_RETRIES, and waits a bounded random delay between
 * attempts so two mutually aborting transactions stop retrying in lockstep.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { retryOnSerializationFailure, SERIALIZATION_RETRIES } from './serializableRetry.js';

const p2034 = () => new Prisma.PrismaClientKnownRequestError(
  'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
  { code: 'P2034', clientVersion: 'test' },
);

describe('retryOnSerializationFailure', () => {
  it('re-runs after a P2034 and returns the eventual result', async () => {
    let calls = 0;
    const out = await retryOnSerializationFailure(async () => {
      calls++;
      if (calls < 3) throw p2034();
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after SERIALIZATION_RETRIES re-runs and surfaces the P2034', async () => {
    let calls = 0;
    await expect(retryOnSerializationFailure(async () => { calls++; throw p2034(); }))
      .rejects.toMatchObject({ code: 'P2034' });
    expect(calls).toBe(SERIALIZATION_RETRIES + 1);
  });

  it('never retries any other error', async () => {
    let calls = 0;
    await expect(retryOnSerializationFailure(async () => { calls++; throw new Error('Cannot remove the last owner'); }))
      .rejects.toThrow('last owner');
    expect(calls).toBe(1);
  });

  it('waits between attempts (jittered backoff), and the total wait stays bounded', async () => {
    const stamps: number[] = [];
    await expect(retryOnSerializationFailure(async () => { stamps.push(Date.now()); throw p2034(); }, 3))
      .rejects.toMatchObject({ code: 'P2034' });
    expect(stamps).toHaveLength(4);
    // Ceilings 10 + 20 + 40 ms: never longer than that plus scheduling slack.
    expect(stamps[3] - stamps[0]).toBeLessThan(70 + 200);
  });
});
