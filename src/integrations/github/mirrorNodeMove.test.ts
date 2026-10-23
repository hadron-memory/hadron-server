/**
 * Move-aware git mirror (#1095).
 *
 * Pins the contract that let `moveNodeSubtree` drop its blanket refusal of any
 * cross-memory move touching a git-backed memory: BOTH halves of the move reach
 * the repos — the destination gains the moved nodes' files at their NEW locs,
 * and the source loses them at their OLD ones. Losing the second half is the
 * expensive failure: a stale source file is re-minted as a duplicate by the next
 * repo-wins sync, which is exactly what the old guard existed to prevent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

vi.mock('./gitMirrorCheckout.js', () => ({
  // Run the caller's mutation against a fixed fake checkout so the assertions
  // are about WHICH files a move reshapes, not about git.
  withMirrorCheckout: vi.fn(async (opts: any, mutate: any) => {
    await mutate({ localPath: `/repo/${opts.memoryId}`, branch: 'hadron-updates', memoryUrn: 'test-org:root-memory' });
    return 'mirrored';
  }),
}));
vi.mock('./writeNodeToGit.js', async importOriginal => ({
  ...await importOriginal<typeof import('./writeNodeToGit.js')>(),
  writeNodeFile: vi.fn(() => true),
  removeNodeFile: vi.fn(),
  writeNodeToGit: vi.fn(async () => {}),
}));

import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { writeNodeFile, removeNodeFile } from './writeNodeToGit.js';
import { mirrorNodeMoveToGit } from './mirrorNodeMove.js';

const REPO = 'https://github.com/acme/repo.git';

let orgId: string;

/** Written paths, as (memoryId, loc) pairs — the checkout fake encodes the memory in localPath. */
const written = () =>
  vi.mocked(writeNodeFile).mock.calls.map(([localPath, node]) => [localPath, node.loc]).sort((a, b) => a[1].localeCompare(b[1]));
/** Removals, as (repo, loc) pairs. */
const removed = () => vi.mocked(removeNodeFile).mock.calls.map(([localPath, loc]) => [localPath, loc]);
/** Removals with the id the removal is gated on — every one must carry the MOVED node's id. */
const removedWithId = () =>
  vi.mocked(removeNodeFile).mock.calls.map(([localPath, loc, id]) => [localPath, loc, id]);

async function makeMemory(slug: string, extra: Record<string, unknown> = {}) {
  return db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      name: slug,
      urn: `mv-org:${slug}`,
      class: 'knowledge',
      ...extra,
    },
  });
}

const makeNode = (memoryId: string, loc: string) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, tags: [] } });

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mv-org', urn: 'mv-org' },
  });
  orgId = org.id;
});

describe('mirrorNodeMoveToGit — cross-memory', () => {
  it('writes into the destination repo AND removes the stale files from the source repo', async () => {
    const src = await makeMemory('src', { source: REPO });
    const dest = await makeMemory('dest', { source: REPO });
    const parent = await makeNode(dest.id, 'q');
    const child = await makeNode(dest.id, 'q:c');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: src.id,
      destMemoryId: dest.id,
      moved: [
        { id: parent.id, previousLoc: 'p' },
        { id: child.id, previousLoc: 'p:c' },
      ],
    });

    // One commit per side, never one per node.
    expect(withMirrorCheckout).toHaveBeenCalledTimes(2);
    expect(written()).toEqual([
      [`/repo/${dest.id}`, 'q'],
      [`/repo/${dest.id}`, 'q:c'],
    ]);
    // The source repo loses the OLD locs — the half that stops the next
    // repo-wins sync from re-minting the moved nodes as duplicates. Each removal
    // is gated on the MOVED node's id, so a file another node has since written
    // to that path is left alone.
    expect(removedWithId()).toEqual([
      [`/repo/${src.id}`, 'p', parent.id],
      [`/repo/${src.id}`, 'p:c', child.id],
    ]);
  });

  it('still removes from a git-backed source when the destination is DB-only', async () => {
    const src = await makeMemory('src', { source: REPO });
    const dest = await makeMemory('dest'); // no source
    const node = await makeNode(dest.id, 'q');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: src.id,
      destMemoryId: dest.id,
      moved: [{ id: node.id, previousLoc: 'p' }],
    });

    expect(written()).toEqual([]);
    expect(removed()).toEqual([[`/repo/${src.id}`, 'p']]);
  });

  it('writes to a git-backed destination when the source is DB-only (nothing to remove)', async () => {
    const src = await makeMemory('src');
    const dest = await makeMemory('dest', { source: REPO });
    const node = await makeNode(dest.id, 'q');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: src.id,
      destMemoryId: dest.id,
      moved: [{ id: node.id, previousLoc: 'p' }],
    });

    expect(written()).toEqual([[`/repo/${dest.id}`, 'q']]);
    expect(removed()).toEqual([]);
  });

  it('does nothing at all when neither memory is git-backed', async () => {
    const src = await makeMemory('src');
    const dest = await makeMemory('dest');
    const node = await makeNode(dest.id, 'q');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: src.id,
      destMemoryId: dest.id,
      moved: [{ id: node.id, previousLoc: 'p' }],
    });

    expect(withMirrorCheckout).not.toHaveBeenCalled();
  });

  it('punts the WRITE on an encrypted destination but still removes from the source', async () => {
    // Rendering a node's file needs plaintext, and this runs after the request
    // that held the session key — but removing a stale path needs no decryption.
    const src = await makeMemory('src', { source: REPO });
    const dest = await makeMemory('dest', { source: REPO, isEncrypted: true });
    const node = await makeNode(dest.id, 'q');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: src.id,
      destMemoryId: dest.id,
      moved: [{ id: node.id, previousLoc: 'p' }],
    });

    expect(written()).toEqual([]);
    expect(removed()).toEqual([[`/repo/${src.id}`, 'p']]);
  });

  it('skips a node that was deleted between the commit and the mirror', async () => {
    const src = await makeMemory('src', { source: REPO });
    const dest = await makeMemory('dest', { source: REPO });
    const node = await makeNode(dest.id, 'q');
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: src.id,
      destMemoryId: dest.id,
      moved: [{ id: node.id, previousLoc: 'p' }],
    });

    expect(written()).toEqual([]);
    // The source file still goes — the node is not there either way.
    expect(removed()).toEqual([[`/repo/${src.id}`, 'p']]);
  });
});

describe('mirrorNodeMoveToGit — never throws', () => {
  it('swallows a mirror failure: callers fire it with `void` after the move committed', async () => {
    const src = await makeMemory('src', { source: REPO });
    const dest = await makeMemory('dest', { source: REPO });
    const node = await makeNode(dest.id, 'q');
    vi.mocked(withMirrorCheckout).mockRejectedValueOnce(new Error('git exploded'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      mirrorNodeMoveToGit(db, {
        srcMemoryId: src.id,
        destMemoryId: dest.id,
        moved: [{ id: node.id, previousLoc: 'p' }],
      }),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('mirrorNodeMoveToGit — same memory', () => {
  it('re-reads moved nodes after entering the checkout, not while waiting for it', async () => {
    const mem = await makeMemory('mem', { source: REPO });
    const node = await makeNode(mem.id, 'new-loc');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(withMirrorCheckout).mockImplementationOnce(async (opts, mutate) => {
      await gate;
      await mutate({ localPath: `/repo/${opts.memoryId}`, branch: 'hadron-updates', memoryUrn: 'test-org:root-memory' });
      return 'mirrored';
    });

    const moving = mirrorNodeMoveToGit(db, {
      srcMemoryId: mem.id, destMemoryId: mem.id,
      moved: [{ id: node.id, previousLoc: 'old-loc' }],
    });
    await vi.waitFor(() => expect(withMirrorCheckout).toHaveBeenCalledOnce());
    await db.node.update({ where: { id: node.id }, data: { name: 'Updated after move' } });
    release();
    await moving;
    expect(vi.mocked(writeNodeFile).mock.lastCall?.[1].name).toBe('Updated after move');
  });

  it('removes the old paths and writes the new ones in ONE commit', async () => {
    const mem = await makeMemory('mem', { source: REPO });
    const parent = await makeNode(mem.id, 'q');
    const child = await makeNode(mem.id, 'q:c');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: mem.id,
      destMemoryId: mem.id,
      moved: [
        { id: parent.id, previousLoc: 'p' },
        { id: child.id, previousLoc: 'p:c' },
      ],
    });

    expect(withMirrorCheckout).toHaveBeenCalledTimes(1);
    expect(removed()).toEqual([
      [`/repo/${mem.id}`, 'p'],
      [`/repo/${mem.id}`, 'p:c'],
    ]);
    expect(written()).toEqual([
      [`/repo/${mem.id}`, 'q'],
      [`/repo/${mem.id}`, 'q:c'],
    ]);
  });

  it('removes the old path even when the node has since moved OUT (live is empty)', async () => {
    // The mirror is fire-and-forget: by the time it runs the node may have moved
    // again, including out to another memory, which drops it from the post-move
    // read. Removal is driven by `moved` (captured in-transaction), so the file
    // it stranded still goes — keying off `live` would leave it to be re-minted
    // by the next repo-wins sync.
    const mem = await makeMemory('mem', { source: REPO });
    const elsewhere = await makeMemory('elsewhere');
    const node = await makeNode(elsewhere.id, 'moved-on');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: mem.id,
      destMemoryId: mem.id,
      moved: [{ id: node.id, previousLoc: 'p' }],
    });

    expect(written()).toEqual([]); // it no longer lives in this memory
    expect(removedWithId()).toEqual([[`/repo/${mem.id}`, 'p', node.id]]);
  });

  it('removes BEFORE writing, so an overlapping rebase cannot delete a file it just wrote', async () => {
    // Moving `a:b` up to `a` sends grandchild `a:b:b` onto the vacated `a:b`.
    const mem = await makeMemory('mem', { source: REPO });
    const parent = await makeNode(mem.id, 'a');
    const grandchild = await makeNode(mem.id, 'a:b');

    await mirrorNodeMoveToGit(db, {
      srcMemoryId: mem.id,
      destMemoryId: mem.id,
      moved: [
        { id: parent.id, previousLoc: 'a:b' },
        { id: grandchild.id, previousLoc: 'a:b:b' },
      ],
    });

    const order = vi.mocked(removeNodeFile).mock.invocationCallOrder;
    const writeOrder = vi.mocked(writeNodeFile).mock.invocationCallOrder;
    expect(Math.max(...order)).toBeLessThan(Math.min(...writeOrder));
    // `a:b` is removed as an old loc and re-written as the grandchild's new one.
    expect(removed()).toContainEqual([`/repo/${mem.id}`, 'a:b']);
    expect(written()).toContainEqual([`/repo/${mem.id}`, 'a:b']);
  });
});


describe('move mirror ciphertext batch belt (#1273)', () => {
  it('leaves old paths intact before refusing a ciphertext batch', async () => {
    const memory = await makeMemory('cipher-batch', { source: REPO });
    const node = await makeNode(memory.id, 'new');
    await db.node.update({ where: { id: node.id }, data: { content: 'enc:v1:stored-ciphertext' } });
    await mirrorNodeMoveToGit(db, {
      srcMemoryId: memory.id, destMemoryId: memory.id,
      moved: [{ id: node.id, previousLoc: 'old' }],
    });
    expect(withMirrorCheckout).toHaveBeenCalledOnce();
    expect(written()).toEqual([]);
    expect(removed()).toEqual([]);
  });
});
