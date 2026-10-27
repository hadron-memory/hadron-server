/**
 * #430 (first slice) — which obligations a move hands the checkout primitive. The primitive is faked (the contract under
 * test is WHAT the move names, not git): same memory, the destination owes each node's WRITE and every old loc's REMOVE;
 * across memories, the destination owes the WRITE and the source owes the REMOVE.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

vi.mock('./gitMirrorCheckout.js', () => ({
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


const obligationsOf = () => vi.mocked(withMirrorCheckout).mock.calls.map(([opts]) => ({
  memoryId: opts.memoryId, obligations: opts.obligations,
}));

describe('mirrorNodeMoveToGit obligations (#430)', () => {
  it('same memory: one checkout owes WRITE and REMOVE(old loc) for every moved node', async () => {
    const mem = await makeMemory('same', { source: REPO });
    const a = await makeNode(mem.id, 'q');
    const b = await makeNode(mem.id, 'q:c');
    await mirrorNodeMoveToGit(db, { srcMemoryId: mem.id, destMemoryId: mem.id, moved: [
      { id: a.id, previousLoc: 'p' }, { id: b.id, previousLoc: 'p:c' }] });
    expect(obligationsOf()).toEqual([{ memoryId: mem.id, obligations: [
      { nodeId: a.id, kind: 'WRITE' }, { nodeId: b.id, kind: 'WRITE' },
      { nodeId: a.id, kind: 'REMOVE', removeLoc: 'p' }, { nodeId: b.id, kind: 'REMOVE', removeLoc: 'p:c' },
    ] }]);
  });

  it('cross memory: the destination owes the WRITE, the source owes the REMOVE', async () => {
    const src = await makeMemory('src', { source: REPO });
    const dest = await makeMemory('dest', { source: REPO });
    const n = await makeNode(dest.id, 'q');
    await mirrorNodeMoveToGit(db, { srcMemoryId: src.id, destMemoryId: dest.id, moved: [{ id: n.id, previousLoc: 'p' }] });
    expect(obligationsOf()).toEqual([
      { memoryId: dest.id, obligations: [{ nodeId: n.id, kind: 'WRITE' }] },
      { memoryId: src.id, obligations: [{ nodeId: n.id, kind: 'REMOVE', removeLoc: 'p' }] },
    ]);
  });

  it('a root (empty previous loc) owes no REMOVE: there is no path to vacate', async () => {
    const mem = await makeMemory('root', { source: REPO });
    const n = await makeNode(mem.id, 'q');
    await mirrorNodeMoveToGit(db, { srcMemoryId: mem.id, destMemoryId: mem.id, moved: [{ id: n.id, previousLoc: '' }] });
    expect(obligationsOf()).toEqual([{ memoryId: mem.id, obligations: [{ nodeId: n.id, kind: 'WRITE' }] }]);
  });
});
