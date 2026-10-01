/**
 * #1544 follow-up: the shared SERIALIZABLE retry re-runs only on P2034, gives
 * up after SERIALIZATION_RETRIES, and waits a bounded random delay between
 * attempts so two mutually aborting transactions stop retrying in lockstep.
 * The delay itself is pinned deterministically (Math.random and setTimeout spied).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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

  afterEach(() => { vi.restoreAllMocks(); });

  // Deterministic pin (Charles's #1570 QA, Jane's review): with randomness fixed
  // at 0.5 each retry sleeps half its ceiling, and the ceiling doubles. Fails on
  // "no sleep" and on "fixed delay, no jitter"; the old upper-bound-only timing
  // test passed with the sleep removed.
  it('waits a jittered delay whose ceiling doubles per retry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(fn, 0);
    }) as typeof setTimeout);
    await expect(retryOnSerializationFailure(async () => { throw p2034(); }, 3))
      .rejects.toMatchObject({ code: 'P2034' });
    expect(delays).toEqual([5, 10, 20]);
  });

  // Jane's #1570 delta: recording the requested delays is not proof the retry
  // WAITS for them. Hold the timer: no re-run may start until it fires.
  it('does not re-run until the backoff timer fires', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const held: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      held.push(fn);
      return 0;
    }) as unknown as typeof setTimeout);
    let calls = 0;
    const done = retryOnSerializationFailure(async () => {
      calls++;
      if (calls === 1) throw p2034();
      return 'ok';
    });
    // Let the first attempt fail and the retry reach its sleep.
    for (let i = 0; i < 20 && held.length === 0; i++) await Promise.resolve();
    expect(held).toHaveLength(1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls).toBe(1); // still waiting: no lockstep re-run
    held[0]();
    await expect(done).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('the delay spans the whole jitter range: randomness 0 waits nothing, near 1 waits almost the ceiling', async () => {
    const delaysFor = async (r: number) => {
      vi.spyOn(Math, 'random').mockReturnValue(r);
      const delays: number[] = [];
      const real = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return real(fn, 0);
      }) as typeof setTimeout);
      await expect(retryOnSerializationFailure(async () => { throw p2034(); }, 2)).rejects.toBeTruthy();
      vi.restoreAllMocks();
      return delays;
    };
    expect(await delaysFor(0)).toEqual([0, 0]);
    expect(await delaysFor(0.999)).toEqual([9.99, 19.98]);
  });
});
