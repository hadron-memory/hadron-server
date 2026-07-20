import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/index.js';
import {
  ancestorLocs,
  lockAncestorsForCreate,
  lockAncestorsForCreateMany,
  lockNodeForDelete,
} from './nodeSubtreeLock.js';

describe('ancestorLocs', () => {
  it('returns strict ancestors shortest-first', () => {
    expect(ancestorLocs('a:b:c')).toEqual(['a', 'a:b']);
  });

  it('returns [] for a root-level loc (no ancestor to coordinate)', () => {
    expect(ancestorLocs('a')).toEqual([]);
  });

  it('never includes the node\'s own loc', () => {
    expect(ancestorLocs('cor:web:020:02')).toEqual(['cor', 'cor:web', 'cor:web:020']);
    expect(ancestorLocs('cor:web:020:02')).not.toContain('cor:web:020:02');
  });
});

/**
 * Capture the (memoryId, loc) bind values of each `$executeRaw` tagged-template
 * call, in order — that ordering is the deadlock-avoidance contract.
 */
function makeTxSpy() {
  const calls: Array<{ key1: unknown; key2: unknown }> = [];
  const $executeRaw = vi.fn((_strings: TemplateStringsArray, key1: unknown, key2: unknown) => {
    calls.push({ key1, key2 });
    return Promise.resolve(1);
  });
  return { tx: { $executeRaw } as unknown as Prisma.TransactionClient, calls };
}

describe('lockAncestorsForCreate', () => {
  it('locks each strict ancestor root→leaf, keyed (memoryId, ancestorLoc)', async () => {
    const { tx, calls } = makeTxSpy();
    await lockAncestorsForCreate(tx, 'mem1', 'a:b:c');
    expect(calls).toEqual([
      { key1: 'mem1', key2: 'a' },
      { key1: 'mem1', key2: 'a:b' },
    ]);
  });

  it('acquires no locks for a root-level loc', async () => {
    const { tx, calls } = makeTxSpy();
    await lockAncestorsForCreate(tx, 'mem1', 'a');
    expect(calls).toEqual([]);
  });
});

describe('lockAncestorsForCreateMany', () => {
  it('dedupes the ancestor set across locs and acquires each once, root→leaf', async () => {
    const { tx, calls } = makeTxSpy();
    // `a:b` and `a:c` share ancestor `a`; `a:b:d` adds `a:b`. Union = {a, a:b}.
    await lockAncestorsForCreateMany(tx, 'mem1', ['a:b', 'a:c', 'a:b:d']);
    expect(calls).toEqual([
      { key1: 'mem1', key2: 'a' },
      { key1: 'mem1', key2: 'a:b' },
    ]);
  });

  it('acquires nothing when every loc is root-level', async () => {
    const { tx, calls } = makeTxSpy();
    await lockAncestorsForCreateMany(tx, 'mem1', ['a', 'b', 'c']);
    expect(calls).toEqual([]);
  });

  it('takes the same key a matching delete takes (parity across the batch)', async () => {
    const { tx, calls } = makeTxSpy();
    await lockAncestorsForCreateMany(tx, 'mem1', ['x:y:z']);
    const del = makeTxSpy();
    await lockNodeForDelete(del.tx, 'mem1', 'x:y');
    expect(calls).toContainEqual(del.calls[0]);
  });
});

describe('lockNodeForDelete', () => {
  it('locks the node\'s own loc — the same key a descendant-create takes as an ancestor', async () => {
    const { tx, calls } = makeTxSpy();
    await lockNodeForDelete(tx, 'mem1', 'a:b');
    expect(calls).toEqual([{ key1: 'mem1', key2: 'a:b' }]);
    // Parity: a create of a child of a:b locks a:b among its ancestors, so the
    // two contend on an identical (memoryId, loc) key.
    const create = makeTxSpy();
    await lockAncestorsForCreate(create.tx, 'mem1', 'a:b:child');
    expect(create.calls).toContainEqual({ key1: 'mem1', key2: 'a:b' });
  });
});
