import { describe, expect, it, vi } from 'vitest';
import { findLiveUrnAliasTargets } from './urnAlias.js';

describe('URN alias pagination guard', () => {
  const dbWithRows = (hasOverflow: boolean) => ({
    urnAlias: {
      findMany: vi.fn(async ({ skip, take }: { skip: number; take: number }) => {
        if (skip < 10_000) {
          return Array.from({ length: take }, (_, i) => ({ entityId: `old-${skip + i}` }));
        }
        return hasOverflow ? [{ entityId: 'overflow' }] : [];
      }),
    },
  });

  it('accepts exactly 100 full pages when the next page is empty', async () => {
    const db = dbWithRows(false);
    await expect(findLiveUrnAliasTargets(
      db as never, 'NODE', 'example:mem:old', async () => [], { all: true },
    )).resolves.toEqual([]);
    expect(db.urnAlias.findMany).toHaveBeenCalledTimes(101);
  });

  it('refuses when a row exists beyond the guard', async () => {
    const db = dbWithRows(true);
    await expect(findLiveUrnAliasTargets(
      db as never, 'NODE', 'example:mem:old', async () => [], { all: true },
    )).rejects.toThrow('URN alias walk exceeded 100 pages');
  });
});
