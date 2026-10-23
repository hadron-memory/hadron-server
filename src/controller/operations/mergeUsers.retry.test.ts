/** #1574: exercise the outer retry protocol, without changing or running the merge transaction body. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { mergeUsers } from './mergeUsers.js';
import { mergeConsentAlreadyApplied } from '../../lib/userMergeConsent.js';

vi.mock('../../lib/userMergeConsent.js', () => ({
  consumeUserMergeConsent: vi.fn(),
  mergeConsentAlreadyApplied: vi.fn(),
}));

const args = { sourceUserId: 'source', targetUserId: 'target', actorUserId: 'actor' };
const abort = (code = 'P2034', state?: string) => new Prisma.PrismaClientKnownRequestError('retry probe', {
  code, clientVersion: 'test', ...(state ? { meta: { code: state } } : {}),
});
const asDb = ($transaction: ReturnType<typeof vi.fn>) => ({ $transaction }) as unknown as PrismaClient;

function recordDelays(): number[] {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return real(fn, 0);
  }) as typeof setTimeout);
  return delays;
}

beforeEach(() => { vi.mocked(mergeConsentAlreadyApplied).mockResolvedValue(false); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('mergeUsers retry timing', () => {
  it('waits full-jitter backoff between serialization aborts and eventual success', async () => {
    const delays = recordDelays();
    const winner = { id: 'target' };
    const txn = vi.fn().mockRejectedValueOnce(abort()).mockRejectedValueOnce(abort()).mockResolvedValue(winner);
    await expect(mergeUsers(asDb(txn), args)).resolves.toBe(winner);
    expect(txn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([5, 10]);
    expect(mergeConsentAlreadyApplied).not.toHaveBeenCalled();
  });

  it.each([['P2034', undefined], ['P2010', '40001']])('keeps four total attempts for %s/%s, with no final sleep', async (code, state) => {
    const delays = recordDelays();
    const error = abort(code, state);
    const txn = vi.fn().mockRejectedValue(error);
    await expect(mergeUsers(asDb(txn), args)).rejects.toBe(error);
    expect(txn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([5, 10, 20]);
  });

  it('does not broaden retries to a different raw SQL failure', async () => {
    const delays = recordDelays();
    const error = abort('P2010', '23505');
    const txn = vi.fn().mockRejectedValue(error);
    await expect(mergeUsers(asDb(txn), args)).rejects.toBe(error);
    expect(txn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retains consumed-proof translation only after the retry budget is exhausted', async () => {
    const delays = recordDelays();
    const txn = vi.fn().mockRejectedValue(abort('P2010', '40001'));
    vi.mocked(mergeConsentAlreadyApplied).mockImplementation(async () => {
      expect(txn).toHaveBeenCalledTimes(4);
      return true;
    });
    const db = asDb(txn);
    await expect(mergeUsers(db, { ...args, consentProof: 'proof' })).rejects.toMatchObject({
      extensions: { code: 'MERGE_ALREADY_APPLIED' },
    });
    expect(delays).toEqual([5, 10, 20]);
    expect(mergeConsentAlreadyApplied).toHaveBeenCalledExactlyOnceWith(db, 'proof', 'source', 'target', 'actor');
  });

  it('waits for the timer before starting the next transaction', async () => {
    const held: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      held.push(fn);
      return 0;
    }) as unknown as typeof setTimeout);
    const txn = vi.fn().mockRejectedValueOnce(abort()).mockResolvedValue({ id: 'target' });
    const result = mergeUsers(asDb(txn), args);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(txn).toHaveBeenCalledTimes(1);
    expect(held).toHaveLength(1);
    held[0]();
    await expect(result).resolves.toMatchObject({ id: 'target' });
  });
});
