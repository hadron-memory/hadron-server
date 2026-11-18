/**
 * #425 slice A — the full export never writes a soft-deleted node.
 *
 * `pushMemoryToGit` loaded every non-data node of the memory, tombstones
 * included, so a deleted node's content was re-published as a `.md` file on the
 * next full push. The filter is the whole change: this pins it against a
 * checkout directory on disk, with git itself faked (a local-path remote is
 * refused by `execGit`'s transport allowlist, by design).
 *
 * Scope boundary, pinned on purpose: nothing here prunes a file that is already
 * in the repo. Removal is a separate, gated slice (#287, #430).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const graphsRoot = vi.hoisted(() => ({ path: '' }));

vi.mock('../../config.js', async importOriginal => {
  const { mkdtempSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  graphsRoot.path = mkdtempSync(join(tmpdir(), 'push425-'));
  return { ...(await importOriginal<typeof import('../../config.js')>()), GRAPHS_PATH: graphsRoot.path };
});
vi.mock('./execGit.js', () => ({
  // `status --porcelain` non-empty so the push proceeds to commit; all else no-ops.
  execGit: vi.fn(async (args: string[]) => ({ stdout: args[0] === 'status' ? ' M x\n' : '', stderr: '' })),
}));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));

import { pushMemoryToGit } from './pushMemoryToGit.js';
import { nodeFilePath } from './nodeFrontmatter.js';

const REPO = 'https://github.com/acme/repo.git';

let memoryId: string;
let localPath: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'p425-org', urn: 'p425-org' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'm', urn: 'p425-org:m', class: 'knowledge', source: REPO },
  });
  memoryId = memory.id;
  localPath = join(graphsRoot.path, 'p425-org', 'm');
  rmSync(localPath, { recursive: true, force: true });
  // An existing clone, so the push takes the fetch path rather than cloning.
  mkdirSync(join(localPath, '.git'), { recursive: true });
});

afterAll(() => rmSync(graphsRoot.path, { recursive: true, force: true }));

const makeNode = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`, tags: [], ...extra } });

describe('pushMemoryToGit — soft-deleted nodes (#425 slice A)', () => {
  it('writes the live node and not the tombstone', async () => {
    await makeNode('live');
    await makeNode('gone', { deletedAt: new Date() });

    const result = await pushMemoryToGit(memoryId);

    expect(result.error).toBeUndefined();
    expect(existsSync(nodeFilePath(localPath, 'live', 'p425-org:m'))).toBe(true);
    expect(existsSync(nodeFilePath(localPath, 'gone', 'p425-org:m'))).toBe(false);
    expect(result.nodeCount).toBe(1);
  });

  it('a memory whose only nodes are tombstones exports none', async () => {
    await makeNode('gone', { deletedAt: new Date() });

    const result = await pushMemoryToGit(memoryId);

    expect(result.error).toBeUndefined();
    expect(result.nodeCount).toBe(0);
    expect(existsSync(nodeFilePath(localPath, 'gone', 'p425-org:m'))).toBe(false);
  });

  it('a file already in the repo for a deleted node is left alone (no pruning in this slice)', async () => {
    const stale = nodeFilePath(localPath, 'gone', 'p425-org:m');
    mkdirSync(join(stale, '..'), { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(stale, 'stale\n');
    await makeNode('gone', { deletedAt: new Date() });

    await pushMemoryToGit(memoryId);

    expect(existsSync(stale)).toBe(true);
  });
});
