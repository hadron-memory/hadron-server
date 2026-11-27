/** #5390: the Git sync gives a synced conversation, stage or prompt file its container parents, in an Agent's system memory only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { nodeFilePath } from './nodeFrontmatter.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: (args[1] as string[]).includes('rev-list') ? '0\n' : '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'fake-token'),
  toHttpsUrl: vi.fn((source: string) => source),
}));
let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;
let orgId: string;
vi.mock('../../config.js', async (original) => ({
  ...await original<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
const repoRoot = () => join(graphsPath, 'test-org', 'bot-memory');
function file(loc: string, id: string) {
  const path = nodeFilePath(repoRoot(), loc, graph.urn);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nid: ${id}\nname: ${loc}\n---\nbody of ${loc}\n`);
}
const locs = async () => (await db.node.findMany({ where: { memoryId: graph.id, deletedAt: null }, select: { loc: true } })).map((n) => n.loc).sort();

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'bot-memory' });
  orgId = org.id;
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: {
    urn: 'test-org:bot-memory', source: 'git@github.com:test/repo.git', readBranch: 'main',
  }, include: { organization: true } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('#5390 Git sync', () => {
  it('an Agent system memory gains the container parents of a synced stage and prompt, and a second sync adds none', async () => {
    await db.memory.update({ where: { id: graph.id }, data: { class: 'system', acceptsUploads: false } });
    await db.agent.create({ data: { organizationId: orgId, name: 'bot', urn: 'test-org:bot', systemMemoryId: graph.id, visibility: 'ORGANIZATION' } });
    file('conversations:welcome', 'aaaa5390000000000000000000000001');
    file('conversations:welcome:ask', 'aaaa5390000000000000000000000002');
    file('prompts:welcome:ask', 'aaaa5390000000000000000000000003');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await locs()).toEqual(['conversations', 'conversations:welcome', 'conversations:welcome:ask', 'prompts', 'prompts:welcome', 'prompts:welcome:ask']);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await locs()).toHaveLength(6);
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'prompts:welcome' } })).toBe(1);
  });

  it('an ordinary memory gets no parents', async () => {
    file('conversations:welcome:ask', 'aaaa5390000000000000000000000002');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await locs()).toEqual(['conversations:welcome:ask']);
  });
});
