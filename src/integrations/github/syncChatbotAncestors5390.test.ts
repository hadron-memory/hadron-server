/**
 * #5390: the Git sync is a covered writer. Conversation, stage and prompt files synced into an Agent's system memory leave
 * no loc without its container parent (`conversations`, `prompts`, `prompts:<name>`); the parents carry no `ownerRepo`, so
 * the next sync's repo-wins cleanup keeps them, and a second sync adds nothing. A non-system memory gains nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir, writeFrontmatterNode } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

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
const graphOf = (): MemoryWithOrg => ({
  id: memoryId, organizationId: orgId, urn: 'test-org:test/repo', name: 'test/repo',
  source: 'git@github.com:test/repo.git', readBranch: 'main', writeBranch: null,
  organization: { id: orgId, name: 'Test Org', urn: 'test-org', githubInstallationId: 12345 },
}) as unknown as MemoryWithOrg;
const repo = () => join(mockSources, 'test-org', 'test/repo');

beforeEach(async () => {
  ({ dir: mockSources, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'test/repo' });
  memoryId = graph.id;
  orgId = org.id;
  await db.memory.update({ where: { id: graph.id }, data: { readBranch: 'main' } });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  mkdirSync(join(repo(), 'conversations', 'welcome'), { recursive: true });
  mkdirSync(join(repo(), 'prompts', 'welcome'), { recursive: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const liveLocs = async () =>
  (await db.node.findMany({ where: { memoryId, deletedAt: null }, select: { loc: true } })).map((n) => n.loc).sort();

function writeDesign(): void {
  writeFrontmatterNode(join(repo(), 'conversations', 'welcome.md'), { name: 'welcome', nodeType: 'system', data: { stageOrder: ['greet'] } } as never, '');
  writeFrontmatterNode(join(repo(), 'conversations', 'welcome', 'greet.md'), { name: 'greet', nodeType: 'system' } as never, '');
  writeFrontmatterNode(join(repo(), 'prompts', 'welcome', 'greet.md'), { name: 'greet', nodeType: 'system' } as never, 'Say hello.');
}

describe('#5390 git sync creates the missing container parents', () => {
  it('in an Agent system memory: the parents appear once, unowned by the repo, and survive the next sync', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { class: 'system', acceptsUploads: false } });
    await db.agent.create({ data: { organizationId: orgId, name: 'synced', urn: 'test-org:synced', systemMemoryId: memoryId, visibility: 'ORGANIZATION' } });
    writeDesign();
    expect((await syncGraphFromGithub(graphOf())).error).toBeUndefined();
    const want = ['conversations', 'conversations:welcome', 'conversations:welcome:greet', 'prompts', 'prompts:welcome', 'prompts:welcome:greet'];
    expect((await liveLocs()).filter((l) => want.includes(l))).toEqual(want);
    const parents = await db.node.findMany({ where: { memoryId, loc: { in: ['conversations', 'prompts', 'prompts:welcome'] } } });
    expect(parents.map((p) => [p.loc, p.ownerRepo, p.nodeType, p.createdBy]).sort()).toEqual([
      ['conversations', null, 'info', 'system:github-sync'], ['prompts', null, 'info', 'system:github-sync'], ['prompts:welcome', null, 'info', 'system:github-sync'],
    ]);
    expect((await syncGraphFromGithub(graphOf())).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId, loc: { in: ['conversations', 'prompts', 'prompts:welcome'] } } })).toBe(3);
    expect((await db.node.findMany({ where: { memoryId, loc: { in: ['conversations', 'prompts', 'prompts:welcome'] }, deletedAt: null } })).map((p) => p.id).sort())
      .toEqual(parents.map((p) => p.id).sort());
  });

  it('in a non-system memory: nothing is added', async () => {
    writeDesign();
    expect((await syncGraphFromGithub(graphOf())).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId, loc: { in: ['conversations', 'prompts', 'prompts:welcome'] } } })).toBe(0);
  });
});
