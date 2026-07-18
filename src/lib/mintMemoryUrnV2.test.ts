/**
 * mintMemoryUrnV2 (#697 Stage 3) — collision-free single-atom v2 memory URN
 * minting. Pure w.r.t. the DB via a stubbed `memory.count` probe.
 */
import { describe, it, expect, vi } from 'vitest';
import { mintMemoryUrnV2 } from './mintMemoryUrnV2.js';

/** A fake db whose memory.count returns >0 for any urn in `taken`. */
function fakeDb(taken: Set<string>) {
  return {
    memory: {
      count: vi.fn(async ({ where }: { where: { OR: Array<{ urn?: string; legacyUrn?: string }> } }) => {
        const urns = where.OR.map((c) => c.urn ?? c.legacyUrn);
        return urns.some((u) => u && taken.has(u)) ? 1 : 0;
      }),
    },
  } as never;
}

describe('mintMemoryUrnV2', () => {
  it('keeps the desired slug when free — the opaque-id (app-user/anon) path', async () => {
    const urn = await mintMemoryUrnV2(fakeDb(new Set()), {
      root: 'acme.com',
      desiredSlug: 'c0abc123',
      authorRoot: 'coder',
    });
    expect(urn).toBe('acme.com:c0abc123');
  });

  it('deterministically aliases a named slug on a live collision (app-mem)', async () => {
    const urn = await mintMemoryUrnV2(fakeDb(new Set(['acme.com:recipes'])), {
      root: 'acme.com',
      desiredSlug: 'recipes',
      authorRoot: 'coder',
    });
    // Author-derived alias (never random, never the foreign slug verbatim).
    expect(urn).toBe('acme.com:recipes-coder');
  });

  it('advances the numeric tail on a repeat collision', async () => {
    const urn = await mintMemoryUrnV2(
      fakeDb(new Set(['acme.com:recipes', 'acme.com:recipes-coder'])),
      { root: 'acme.com', desiredSlug: 'recipes', authorRoot: 'coder' },
    );
    expect(urn).toBe('acme.com:recipes-coder-2');
  });

  it('treats a legacyUrn hit as taken (must not shadow a stored legacy identity)', async () => {
    // The desired urn is free as a primary `urn` but claimed as another row's
    // `legacyUrn` — the probe ORs both, so the mint aliases away.
    const db = {
      memory: {
        count: vi.fn(async ({ where }: { where: { OR: Array<{ urn?: string; legacyUrn?: string }> } }) => {
          const legacyHit = where.OR.some((c) => c.legacyUrn === 'acme.com:recipes');
          return legacyHit ? 1 : 0;
        }),
      },
    } as never;
    const urn = await mintMemoryUrnV2(db, {
      root: 'acme.com',
      desiredSlug: 'recipes',
      authorRoot: 'coder',
    });
    expect(urn).toBe('acme.com:recipes-coder');
  });
});
