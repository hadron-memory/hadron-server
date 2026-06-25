/**
 * Unit tests for the Edge.source / Edge.target field resolvers.
 *
 * Callers preload only the relevant endpoint per direction (nodeById does
 * `outgoingEdges: { include: { target: true } }`, `incomingEdges: { include:
 * { source: true } }`). Because Edge.source/target are non-null (`Node!`), a
 * client selecting the UNLOADED side would resolve to null, violate the
 * non-null field, and error the whole query (regression: the portal edge
 * detail page selected `source` on an outgoing edge → 500). The resolvers
 * lazily load the missing endpoint by FK. Pure-mock, no DB needed.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolvers, type Context } from './resolvers.js';

const edge = resolvers.Edge as {
  source: (e: unknown, a: unknown, c: Context) => Promise<unknown>;
  target: (e: unknown, a: unknown, c: Context) => Promise<unknown>;
};

function ctxWith(findUnique: ReturnType<typeof vi.fn>): Context {
  return { db: { node: { findUnique } } as unknown as Context['db'] } as Context;
}

describe('Edge.source / Edge.target resolvers', () => {
  it('returns the preloaded endpoint without touching the DB', async () => {
    const findUnique = vi.fn();
    const ctx = ctxWith(findUnique);
    const preloaded = { id: 'src-1', loc: 'a' };

    const out = await edge.source({ sourceId: 'src-1', source: preloaded }, null, ctx);

    expect(out).toBe(preloaded);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('lazily loads source by FK when it was not preloaded (the 500 fix)', async () => {
    const loaded = { id: 'src-9', loc: 'lazy' };
    const findUnique = vi.fn().mockResolvedValue(loaded);
    const ctx = ctxWith(findUnique);

    // e.g. an OUTGOING edge from nodeById: only `target` was included.
    const out = await edge.source({ sourceId: 'src-9' }, null, ctx);

    expect(out).toEqual(loaded);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'src-9' } });
  });

  it('lazily loads target by FK when it was not preloaded', async () => {
    const loaded = { id: 'tgt-9', loc: 'lazy' };
    const findUnique = vi.fn().mockResolvedValue(loaded);
    const ctx = ctxWith(findUnique);

    // e.g. an INCOMING edge from nodeById: only `source` was included.
    const out = await edge.target({ targetId: 'tgt-9' }, null, ctx);

    expect(out).toEqual(loaded);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'tgt-9' } });
  });
});
