/** #2040 — git sync: invalid include tags skip the file and name it; valid ones derive INCLUDE edges. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'fake-token'),
  toHttpsUrl: vi.fn((source: string) => source),
}));
let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;
vi.mock('../../config.js', async (original) => ({
  ...await original<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
const repoRoot = () => join(graphsPath, 'test-org', 'inc-memory');
const file = (name: string, body: string) => {
  mkdirSync(repoRoot(), { recursive: true });
  writeFileSync(join(repoRoot(), `${name}.md`), `---\nname: ${name}\n---\n${body}\n`);
};

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'inc-memory' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: {
    urn: 'test-org:inc-memory', source: 'git@github.com:test/repo.git', readBranch: 'main',
  }, include: { organization: true } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('git sync include tags (#2040)', () => {
  it('derives an edge to a file synced later in the same run, and skips an invalid file by name', async () => {
    file('a', 'see {{> b}}');
    file('b', 'B body');
    file('bad', '{{> a bogus}}');
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBeUndefined();
    expect(result.skippedInvalidIncludes?.map((s) => s.loc)).toEqual(['bad']);
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'bad' } })).toBe(0);
    const edges = await db.edge.findMany({ where: { memoryId: graph.id, governedKind: 'INCLUDE' }, include: { source: true, target: true } });
    expect(edges.map((e) => `${e.source.loc}>${e.target.loc}`)).toEqual(['a>b']);
  });

  it('a skipped update leaves the stored node as it was', async () => {
    file('a', 'v1');
    await syncGraphFromGithub(graph);
    file('a', '{{> a}}');
    const result = await syncGraphFromGithub(graph);
    expect(result.skippedInvalidIncludes?.map((s) => s.loc)).toEqual(['a']);
    expect((await db.node.findFirstOrThrow({ where: { memoryId: graph.id, loc: 'a' } })).content).toContain('v1');
  });
});
