/**
 * #1328 — git sync counts as authoring. A file carries `authoredWith: task@rev`
 * in its frontmatter; a refused file is skipped and reported, its row survives,
 * and the rest of the sync applies, as for a strict-sub-role refusal (#1330).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir, writeFrontmatterNode, writeNodeFiles } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { buildNodeFrontmatter } from './nodeFrontmatter.js';
import { generateId } from '../../lib/id.js';

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const argv = args[1] as string[];
    const cb = args[args.length - 1] as (...a: unknown[]) => void;
    if (typeof cb !== 'function') return;
    cb(null, { stdout: argv.includes('ls-remote') ? 'ref: refs/heads/main\tHEAD\n' : argv.includes('rev-list') ? '0\n' : '', stderr: '' });
  }),
}));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'fake-token'),
  toHttpsUrl: vi.fn((source: string) => source),
}));

let mockSources: string;
let cleanup: () => void;
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get GRAPHS_PATH() { return mockSources; },
}));

let memoryId: string;
let orgId: string;
let taskId: string;
const graphOf = (): MemoryWithOrg => ({
  id: memoryId, organizationId: orgId, urn: 'test-org:test/repo', name: 'test/repo',
  source: 'git@github.com:test/repo.git', readBranch: 'main', writeBranch: null,
  organization: { id: orgId, name: 'Test Org', urn: 'test-org', githubInstallationId: 12345 },
}) as unknown as MemoryWithOrg;
const stored = (loc: string) => db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc, memoryId } } });
const repo = () => join(mockSources, 'test-org', 'test/repo');
const sync = () => syncGraphFromGithub(graphOf());

beforeEach(async () => {
  ({ dir: mockSources, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'test/repo' });
  memoryId = graph.id;
  orgId = org.id;
  await db.memory.update({ where: { id: graph.id }, data: { readBranch: 'main' } });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  mkdirSync(repo(), { recursive: true });
  const taskMemory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'test-org:tasks', name: 'tasks', class: 'knowledge' } });
  taskId = (await db.node.create({ data: { id: generateId(), memoryId: taskMemory.id, loc: 'task', name: 'Task', isRunnable: true } })).id;
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('#1328 git sync', () => {
  it('a claimless file is skipped and reported, a current claim stamps it, in both file shapes', async () => {
    writeFrontmatterNode(join(repo(), 'modern.md'), { name: 'Modern', role: 'guide' }, 'body');
    writeNodeFiles(join(repo(), 'legacy'), { name: 'Legacy', role: 'guide' }, 'body');
    const refused = await sync();
    expect(refused.error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId, loc: { in: ['modern', 'legacy'] } } })).toBe(0);
    const report = JSON.parse((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).lastSyncReport!);
    expect(report.entries).toContainEqual(expect.objectContaining({ kind: 'attestation_refused', loc: 'modern', code: 'AUTHORING_ATTESTATION_MISSING' }));

    writeFrontmatterNode(join(repo(), 'modern.md'), { name: 'Modern', role: 'guide', authoredWith: `${taskId}@1` }, 'body');
    writeNodeFiles(join(repo(), 'legacy'), { name: 'Legacy', role: 'guide', authoredWith: `${taskId}@1` }, 'body');
    expect((await sync()).error).toBeUndefined();
    for (const loc of ['modern', 'legacy']) {
      expect(await stored(loc)).toMatchObject({ role: 'guide', authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1 });
    }
  });

  it('an unchanged file without the key keeps the stamp; a legacy governed row is not touched', async () => {
    writeFrontmatterNode(join(repo(), 'a.md'), { name: 'A', role: 'guide', authoredWith: `${taskId}@1` }, 'body');
    await sync();
    const { id } = await stored('a');
    writeFrontmatterNode(join(repo(), 'a.md'), { id, name: 'A', role: 'guide' }, 'body');
    await sync();
    expect(await stored('a')).toMatchObject({ authoredByTask: taskId, authoredByRevision: 1, content: expect.stringContaining('body') });
  });

  it('a stale, wrong or malformed claim on an edit keeps the row and its stamp, and survives cleanup', async () => {
    writeFrontmatterNode(join(repo(), 'a.md'), { name: 'A', role: 'guide', authoredWith: `${taskId}@1` }, 'body');
    await sync();
    const { id } = await stored('a');
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    for (const authoredWith of [`${taskId}@1`, `${generateId()}@2`, 'not a claim', 7]) {
      writeFrontmatterNode(join(repo(), 'a.md'), { id, name: 'A', role: 'guide', authoredWith }, 'edited');
      expect((await sync()).error).toBeUndefined();
      expect(await stored('a')).toMatchObject({ id, deletedAt: null, authoredByRevision: 1 });
      expect((await stored('a')).content).not.toContain('edited');
    }
    writeFrontmatterNode(join(repo(), 'a.md'), { id, name: 'A', role: 'guide', authoredWith: `${taskId}@2` }, 'edited');
    await sync();
    expect(await stored('a')).toMatchObject({ authoredByRevision: 2, content: expect.stringContaining('edited') });
  });

  it('a file that drops the role cannot shed the requirement', async () => {
    writeFrontmatterNode(join(repo(), 'a.md'), { name: 'A', role: 'guide', authoredWith: `${taskId}@1` }, 'body');
    await sync();
    const { id } = await stored('a');
    writeFrontmatterNode(join(repo(), 'a.md'), { id, name: 'A', role: null }, 'edited');
    await sync();
    expect(await stored('a')).toMatchObject({ role: 'guide', authoredByTask: taskId });
  });

  it('a verified task stamp exports as task@revision; a HUMAN stamp never does', () => {
    const base = { id: 'n', name: 'N', tags: [], role: 'guide', isRunnable: null, isPlaceholder: false } as never;
    const task = buildNodeFrontmatter({ ...(base as object), authorshipKind: 'TASK', authoredByTask: 't', authoredByRevision: 3 } as never, []);
    expect(task.authoredWith).toBe('t@3');
    const human = buildNodeFrontmatter({ ...(base as object), authorshipKind: 'HUMAN', authoredByHuman: 'u' } as never, []);
    expect(human.authoredWith).toBeUndefined();
  });
});
