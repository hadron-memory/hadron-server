import { describe, it, expect, vi } from 'vitest';
import { ensureAssetsParent, ASSETS_PARENT_LOC } from './parent.js';

describe('ensureAssetsParent', () => {
  it('returns the existing parent if one exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'parent-1', loc: 'assets' });
    const create = vi.fn();
    const db = { node: { findUnique, create } } as unknown as Parameters<typeof ensureAssetsParent>[0];

    const out = await ensureAssetsParent(db, 'mem-1');
    expect(out).toEqual({ id: 'parent-1', loc: 'assets' });
    expect(create).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      where: { loc_memoryId: { loc: ASSETS_PARENT_LOC, memoryId: 'mem-1' } },
      select: { id: true, loc: true },
    });
  });

  it('creates the parent when missing', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      id: data.id,
      loc: data.loc,
    }));
    const db = { node: { findUnique, create } } as unknown as Parameters<typeof ensureAssetsParent>[0];

    const out = await ensureAssetsParent(db, 'mem-2');
    expect(out.loc).toBe('assets');
    expect(out.id).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg.data.memoryId).toBe('mem-2');
    expect(arg.data.nodeType).toBe('info');
    expect(arg.data.name).toBe('Assets');
  });
});
