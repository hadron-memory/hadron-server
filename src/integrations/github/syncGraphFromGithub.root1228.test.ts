/** #1228: root README identity survives its move to the memory slug. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import { validateLoc } from '../../lib/validateLoc.js';
import { nodeUrnRoundTrips } from '../../lib/urnEmit.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, '', '');
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
const rootId = 'aaaa1228000000000000000000000001';
const repoRoot = () => join(graphsPath, 'test-org', 'root-memory');
function readme(id: string | undefined = rootId, prefix = '') {
  const dir = join(repoRoot(), prefix);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), `---\n${id ? `id: ${id}\n` : ''}name: Root\n---\nRoot body\n`);
}
beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'root-memory' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: {
    urn: 'test-org:root-memory', source: 'git@github.com:test/repo.git', readBranch: 'main',
  }, include: { organization: true } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
async function legacyRoot() {
  return db.node.create({ data: { id: rootId, memoryId: graph.id, loc: '', name: 'Root', content: 'Root body', ownerRepo: 'test/repo' } });
}
describe('#1228 root README', () => {
  it.each(['', '.hadron'])('derives a round-trippable memory slug from %s/README.md', async (prefix) => {
    readme(rootId, prefix);
    const loaded = await loadGraphFromFs(repoRoot(), graph.urn, 'test/repo');
    expect(loaded.graph.nodes[0].loc, '#1228 root must have the memory slug, never empty').toBe('root-memory');
    expect(nodeUrnRoundTrips(graph.urn, loaded.graph.nodes[0].loc!)).toBe(true);
    expect(() => validateLoc(deriveEdgeLoc('child', 'uses', loaded.graph.nodes[0].loc!))).not.toThrow();
  });
  it('moves the legacy root id in place and rekeys existing incident edge locs', async () => {
    const root = await legacyRoot();
    const child = await db.node.create({ data: { memoryId: graph.id, loc: 'child', name: 'Child' } });
    const edge = await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: root.id, loc: 'child:uses:', name: 'uses' } });
    readme();
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    const moved = await db.node.findUniqueOrThrow({ where: { id: root.id } });
    expect(moved).toMatchObject({ loc: 'root-memory', createdAt: root.createdAt });
    expect(await db.nodeRevision.count({ where: { nodeId: root.id } })).toBeGreaterThan(0);
    expect(await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).toMatchObject({ sourceId: child.id, targetId: root.id, loc: deriveEdgeLoc('child', 'uses', 'root-memory') });
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'root-memory' } })).toBe(1);
  });
  it('refuses a missing live root id before any legacy root can be replaced', async () => {
    const root = await legacyRoot();
    readme('unknown1228');
    expect((await syncGraphFromGithub(graph)).error).toContain('root README must carry');
    expect(await db.node.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ loc: '' });
    expect(await db.node.count({ where: { memoryId: graph.id } })).toBe(1);
  });
  it('requires operator collision repair, then lets the README win without losing either identity', async () => {
    await legacyRoot();
    const occupant = await db.node.create({ data: { memoryId: graph.id, loc: 'root-memory', name: 'API root' } });
    readme();
    expect((await syncGraphFromGithub(graph)).error).toContain('root README slug is occupied');
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: '' });
    expect(await db.node.findUniqueOrThrow({ where: { id: occupant.id } })).toMatchObject({ loc: 'root-memory' });
    // Synthetic operator repair, not a production repair performed by sync.
    await db.node.update({ where: { id: occupant.id }, data: { loc: 'api-root' } });
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: 'root-memory' });
    expect(await db.node.findUniqueOrThrow({ where: { id: occupant.id } })).toMatchObject({ loc: 'api-root' });
  });
  it('refuses compound memory URNs rather than deriving a multi-atom root', async () => {
    readme();
    await expect(loadGraphFromFs(repoRoot(), 'org:app:agent:shared', 'test/repo')).rejects.toThrow('single-atom memory slug');
  });
});
