import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fixture'), toHttpsUrl: vi.fn((s: string) => s) }));
let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;
vi.mock('../../config.js', async original => ({ ...await original<typeof import('../../config.js')>(), get GRAPHS_PATH() { return graphsPath; } }));
const file = (loc: string, content: string) => {
  const root = join(graphsPath, 'report-org', 'report-memory');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${loc}.md`), `---\nname: ${loc}\n---\n${content}\n`);
};
const storedReport = async () => (await db.memory.findUniqueOrThrow({ where: { id: graph.id } }) as unknown as { lastSyncReport?: string | null }).lastSyncReport;

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'report-org', graphName: 'report-memory' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: { urn: 'report-org:report-memory', source: 'git@github.com:fixture/repo.git', readBranch: 'main' }, include: { organization: true } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('#1507 persisted sync outcome', () => {
  it('reports an invalid include as partial alongside committed graph writes', async () => {
    file('good', 'committed'); file('bad', '{{> good bogus}}');
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'good' } })).toBe(1);
    const text = await storedReport();
    expect(typeof text).toBe('string');
    expect(JSON.parse(text!)).toMatchObject({ version: 1, outcome: 'partial', entries: [{ kind: 'invalid_include', loc: 'bad', code: expect.any(String) }] });
  });

  it('uses null only after a clean committed sync', async () => {
    file('good', 'committed');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await storedReport()).toBeNull();
  });

  it('persists fixed failed metadata when preflight fails without claiming committed files', async () => {
    const result = await syncGraphFromGithub({ ...graph, source: 'https://not-a-github-host.test/repo' });
    expect(result.error).toBeDefined();
    const text = await storedReport();
    expect(typeof text).toBe('string');
    expect(JSON.parse(text!)).toMatchObject({ version: 1, outcome: 'failed', code: 'SYNC_FAILED', entries: [] });
    expect(text).not.toContain('not-a-github-host');
  });
});
