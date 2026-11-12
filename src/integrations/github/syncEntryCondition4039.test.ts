/**
 * #4039 (gate B4, pin 9b): git sync is a covered writer. A conversation file whose `data.entryCondition` is invalid, or
 * reads a variable with no value at chat start, refuses the whole sync before its first write, the way an invalid edge
 * condition does; a valid condition syncs.
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
  mkdirSync(join(repo(), 'conversations'), { recursive: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('#4039 git sync refuses an invalid entry condition (9b)', () => {
  it('a chat.* condition fails the sync and nothing of this attempt is written, a valid one syncs', async () => {
    writeFrontmatterNode(join(repo(), 'plain.md'), { name: 'Plain' }, 'body');
    writeFrontmatterNode(join(repo(), 'conversations', 'welcome.md'), {
      name: 'welcome', data: { stageOrder: ['s1'], entryCondition: { '==': [{ var: 'chat.message_count' }, 0] } },
    }, 'body');
    const refused = await syncGraphFromGithub(graphOf());
    expect(String(refused.error)).toContain('invalid entry condition');
    expect(String(refused.error)).toContain('SCOPE_NOT_AVAILABLE_AT_START');
    expect(await db.node.count({ where: { memoryId, loc: { in: ['plain', 'conversations:welcome'] } } })).toBe(0);

    writeFrontmatterNode(join(repo(), 'conversations', 'welcome.md'), {
      name: 'welcome', data: { stageOrder: ['s1'], entryCondition: { '!': [{ var: 'memory.name' }] } },
    }, 'body');
    expect((await syncGraphFromGithub(graphOf())).error).toBeUndefined();
    const stored = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'conversations:welcome', memoryId } } });
    expect((stored.data as Record<string, unknown>).entryCondition).toEqual({ '!': [{ var: 'memory.name' }] });
  });
});
