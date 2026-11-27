/** #5019 (Billing A11): a Git sync skips a file over `NODE_CONTENT_MAX_BYTES`, keeps its row, names it in the report and does not fail. RED on main: it is written. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { OWNER_LIMIT_KEYS } from '../../lib/ownerLimits/keys.js';
import { describeSyncOutcome, syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

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
let orgId: string;
vi.mock('../../config.js', async (original) => ({
  ...await original<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
const file = (name: string, body: string, front = '') => {
  const root = join(graphsPath, 'test-org', 'size-memory');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.md`), `---\nname: ${name}\n${front}---\n${body}\n`);
};
const at = (loc: string) => db.node.findFirst({ where: { memoryId: graph.id, loc } });
const report = async () => JSON.parse((await db.memory.findUniqueOrThrow({ where: { id: graph.id } })).lastSyncReport!);

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'size-memory' });
  orgId = org.id;
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: {
    urn: 'test-org:size-memory', source: 'git@github.com:test/repo.git', readBranch: 'main',
  }, include: { organization: true } });
  vi.stubEnv('NODE_CONTENT_MAX_BYTES', '1000');
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(); vi.clearAllMocks(); });

describe('#5019 git sync', () => {
  it('writes every other file, skips the over-size one and names it', async () => {
    file('ok', 'fine');
    file('big', 'x'.repeat(1001));
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBeUndefined();
    expect(result.skippedOversize).toEqual(['big']);
    expect(await at('ok')).not.toBeNull();
    expect(await at('big')).toBeNull();
    expect(await report()).toMatchObject({ version: 3, outcome: 'partial', entries: [{ kind: 'oversize', loc: 'big', code: 'NODE_CONTENT_TOO_LARGE' }] });
    expect(describeSyncOutcome(result)).toContain('- big');
  });

  it('#5160: a file exactly at the ceiling is written', async () => {
    file('at', 'x'.repeat(1000));
    const result = await syncGraphFromGithub(graph);
    expect(result.skippedOversize).toEqual([]);
    expect((await at('at'))!.content).toHaveLength(1000);
  });

  it('keeps the stored row of a file that grew over the ceiling, and does not delete it', async () => {
    file('a', 'v1');
    await syncGraphFromGithub(graph);
    const before = await at('a');
    file('a', 'x'.repeat(1001));
    const result = await syncGraphFromGithub(graph);
    expect(result.skippedOversize).toEqual(['a']);
    expect(await at('a')).toEqual(before);
  });

  it('measures the resulting node: properties the row keeps count', async () => {
    file('a', 'v1');
    await syncGraphFromGithub(graph);
    await db.node.updateMany({ where: { memoryId: graph.id, loc: 'a' }, data: { properties: { k: 'x'.repeat(600) } } });
    file('a', 'x'.repeat(600));
    expect((await syncGraphFromGithub(graph)).skippedOversize).toEqual(['a']);
  });

  it('a skipped file is not in the owner-limit amount', async () => {
    const limitValue = (await OWNER_LIMIT_KEYS.nodes.count(db, { organizationId: orgId })) + 1n;
    await db.ownerLimit.create({ data: { id: generateId(), organizationId: orgId, key: 'nodes', limitValue, sourceType: 'manual', sourceId: 't', note: 't' } });
    file('ok', 'fine');
    file('big', 'x'.repeat(1001));
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBeUndefined();
    expect(await at('ok')).not.toBeNull();
  });

  it('unset: nothing is skipped', async () => {
    vi.stubEnv('NODE_CONTENT_MAX_BYTES', '');
    file('big', 'x'.repeat(5000));
    expect((await syncGraphFromGithub(graph)).skippedOversize).toEqual([]);
    expect(await at('big')).not.toBeNull();
  });
});
