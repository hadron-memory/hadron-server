/**
 * #5146 — `hasRootNode` follows cor:int:010:01: a memory has a root page iff it has a live
 * node at its single-atom slug loc (or an R12 legacy empty-loc root); otherwise the root
 * README.md is the manifest carrying the memory's identity. Git is faked as in the #425 pins.
 * A compound slug is an open spec question and is deliberately not pinned.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const graphsRoot = vi.hoisted(() => ({ path: '' }));

vi.mock('../../config.js', async importOriginal => {
  const { mkdtempSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  graphsRoot.path = mkdtempSync(join(tmpdir(), 'push5146-'));
  return { ...(await importOriginal<typeof import('../../config.js')>()), GRAPHS_PATH: graphsRoot.path };
});
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[]) => ({ stdout: args[0] === 'status' ? ' M x\n' : '', stderr: '' })),
}));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));

import { pushMemoryToGit } from './pushMemoryToGit.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';

const REPO = 'https://github.com/acme/repo.git';
const URN = 'p5146-org:m';

let memoryId: string;
let localPath: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'p5146-org', urn: 'p5146-org' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'm', urn: URN, class: 'knowledge', source: REPO },
  });
  memoryId = memory.id;
  localPath = join(graphsRoot.path, 'p5146-org', 'm');
  rmSync(localPath, { recursive: true, force: true });
  mkdirSync(join(localPath, '.git'), { recursive: true });
});

afterAll(() => rmSync(graphsRoot.path, { recursive: true, force: true }));

const makeNode = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc || 'root', content: `body of ${loc}`, tags: [], ...extra } });
const readme = () => readFileSync(join(localPath, 'README.md'), 'utf-8');

describe('pushMemoryToGit — root page versus manifest (#5146)', () => {
  it('a memory with only flat non-slug nodes still gets the manifest', async () => {
    await makeNode('notes');
    await pushMemoryToGit(memoryId);
    expect(readme()).toContain(`urn: ${URN}`);
  });

  it('a memory with a node at the slug loc gets that node as README.md, not the manifest', async () => {
    const root = await makeNode('m');
    await makeNode('notes');
    await pushMemoryToGit(memoryId);
    const text = readme();
    expect(text).toContain(`id: ${root.id}`);
    expect(text).toContain('body of m');
    expect(text).not.toContain(`urn: ${URN}`);
  });

  it('an R12 legacy empty-loc root is the root page: no manifest', async () => {
    const root = await makeNode('');
    await pushMemoryToGit(memoryId);
    expect(readme()).toContain(`id: ${root.id}`);
    expect(readme()).not.toContain(`urn: ${URN}`);
  });

  it('a soft-deleted slug-loc node is not a root page: the manifest is written', async () => {
    await makeNode('m', { deletedAt: new Date() });
    await pushMemoryToGit(memoryId);
    expect(readme()).toContain(`urn: ${URN}`);
  });

  it('an empty memory gets the manifest', async () => {
    await pushMemoryToGit(memoryId);
    expect(existsSync(join(localPath, 'README.md'))).toBe(true);
    expect(readme()).toContain(`urn: ${URN}`);
  });

  it('round trip: slug-loc node -> README.md -> import keeps loc and id', async () => {
    const root = await makeNode('m');
    await pushMemoryToGit(memoryId);
    const { node } = await loadNodeFromFs(join(localPath, 'README.md'), localPath, URN, URN);
    expect(node.loc).toBe('m');
    expect(node.id).toBe(root.id);
  });
});
