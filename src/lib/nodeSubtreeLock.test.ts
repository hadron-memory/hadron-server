import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/index.js';
import {
  ancestorLocs,
  lockAncestorsForCreate,
  lockAncestorsForCreateMany,
  lockNodeForDelete,
  lockPathForCreateUnder,
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
 * Capture resolved key pairs; a small deterministic hash fixture isolates
 * ancestor coverage. Real PostgreSQL hashes are pinned in nodeSubtreeLock1214.
 */
const hash = (value: string) => [...value].reduce((sum, c) => sum + c.charCodeAt(0), 0);
function makeTxSpy() {
  const calls: Array<{ key1: unknown; key2: unknown }> = [];
  const $executeRaw = vi.fn((_strings: TemplateStringsArray, key1: unknown, key2: unknown) => {
    calls.push({ key1: typeof key1 === 'string' ? hash(key1) : key1, key2: typeof key2 === 'string' ? hash(key2) : key2 });
    return Promise.resolve(1);
  });
  const $queryRaw = vi.fn(async (_strings: TemplateStringsArray, input: string) =>
    (JSON.parse(input) as Array<{ memoryId: string; loc: string }>).map((k) => ({ h1: hash(k.memoryId), h2: hash(k.loc) })));
  // Spec 049 S4: every helper consults the protected-loc gate after locking.
  // Its ONE source is the Channel table, so a memory with no Channels is the
  // unprotected world these tests describe.
  //
  // #1180 briefly added `Memory.protectedLocs` as a second source and this fake
  // stubbed `memory.findUnique` to satisfy it; #1201 removed the column, and
  // the stub is removed with it (@copilot, PR #1203). Not because it broke
  // anything — the cast below absorbs an extra property, which is why nothing
  // failed — but because a fake that answers a call the code no longer makes is
  // a fixture describing a world that does not exist, and it would silently
  // satisfy the gate if that read ever came back.
  const channel = { findMany: vi.fn(async () => []) };
  return { tx: { $executeRaw, $queryRaw, channel } as unknown as Prisma.TransactionClient, calls };
}

describe('lockAncestorsForCreate', () => {
  it('locks every strict ancestor in resolved-key order', async () => {
    const { tx, calls } = makeTxSpy();
    await lockAncestorsForCreate(tx, 'mem1', 'a:b:c');
    expect(calls).toEqual([
      { key1: hash('mem1'), key2: hash('a') },
      { key1: hash('mem1'), key2: hash('a:b') },
    ]);
  });

  it('acquires no locks for a root-level loc', async () => {
    const { tx, calls } = makeTxSpy();
    await lockAncestorsForCreate(tx, 'mem1', 'a');
    expect(calls).toEqual([]);
  });
});

describe('lockAncestorsForCreateMany', () => {
  it('dedupes the ancestor set and acquires each resolved key once', async () => {
    const { tx, calls } = makeTxSpy();
    // `a:b` and `a:c` share ancestor `a`; `a:b:d` adds `a:b`. Union = {a, a:b}.
    await lockAncestorsForCreateMany(tx, 'mem1', ['a:b', 'a:c', 'a:b:d']);
    expect(calls).toEqual([
      { key1: hash('mem1'), key2: hash('a') },
      { key1: hash('mem1'), key2: hash('a:b') },
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

describe('lockPathForCreateUnder', () => {
  it('takes exactly the keys a create under that parent would take (#919)', async () => {
    // The contract: identical key set and order to lockAncestorsForCreate on
    // any child, so an allocator that must lock BEFORE it knows the child's
    // name still contends with — and cannot slip past — the ordinary creates.
    const under = makeTxSpy();
    await lockPathForCreateUnder(under.tx, 'mem1', 'chats:c1:messages');
    const child = makeTxSpy();
    await lockAncestorsForCreate(child.tx, 'mem1', 'chats:c1:messages:001-user');
    expect(under.calls).toEqual(child.calls);
    expect(under.calls).toEqual([
      { key1: hash('mem1'), key2: hash('chats') },
      { key1: hash('mem1'), key2: hash('chats:c1') },
      { key1: hash('mem1'), key2: hash('chats:c1:messages') },
    ]);
  });

  it('locks a root-level parent itself (it is still an ancestor of its children)', async () => {
    const { tx, calls } = makeTxSpy();
    await lockPathForCreateUnder(tx, 'mem1', 'a');
    expect(calls).toEqual([{ key1: hash('mem1'), key2: hash('a') }]);
  });

  it('contends with a delete of the parent', async () => {
    const { tx, calls } = makeTxSpy();
    await lockPathForCreateUnder(tx, 'mem1', 'a:b');
    const del = makeTxSpy();
    await lockNodeForDelete(del.tx, 'mem1', 'a:b');
    expect(calls).toContainEqual(del.calls[0]);
  });
});

describe('lockNodeForDelete', () => {
  it('locks the node\'s own loc — the same key a descendant-create takes as an ancestor', async () => {
    const { tx, calls } = makeTxSpy();
    await lockNodeForDelete(tx, 'mem1', 'a:b');
    expect(calls).toEqual([{ key1: hash('mem1'), key2: hash('a:b') }]);
    // Parity: a create of a child of a:b locks a:b among its ancestors, so the
    // two contend on an identical (memoryId, loc) key.
    const create = makeTxSpy();
    await lockAncestorsForCreate(create.tx, 'mem1', 'a:b:child');
    expect(create.calls).toContainEqual({ key1: hash('mem1'), key2: hash('a:b') });
  });
});
