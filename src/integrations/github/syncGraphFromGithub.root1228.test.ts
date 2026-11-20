/** #1228: root README identity survives its move to the memory slug. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { mirrorNodeMoveToGit } from './mirrorNodeMove.js';
import { pushMemoryToGit } from './pushMemoryToGit.js';
import { removeNodeFile, writeNodeToGit } from './writeNodeToGit.js';
import { nodeFilePath } from './nodeFrontmatter.js';
import { rootLocForMemory } from '../localFs/loadNodeFromFs.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import { validateLoc } from '../../lib/validateLoc.js';
import { nodeUrnRoundTrips } from '../../lib/urnEmit.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  // rev-list --count answers 0: nothing unpublished (#2308).
  (args.at(-1) as Function)(null, { stdout: (args[1] as string[]).includes('rev-list') ? '0\n' : '', stderr: '' });
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
  it('#4583: a migrated edge and its runtime twin (both spellings of a non-BMP name) each keep their own spelling when the root moves', async () => {
    // The root's loc changes from '' to the memory slug, so both derived locs are re-derived. If both went to the SAME
    // spelling they would land on one (loc, memory) and abort the sync; each must stay in the spelling it carries.
    const root = await legacyRoot();
    const child = await db.node.create({ data: { memoryId: graph.id, loc: 'child', name: 'Child' } });
    const migrated = await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: root.id, loc: 'child:a-b:', name: 'a😀b' } });
    const runtime = await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: root.id, loc: 'child:a--b:', name: 'a😀b' } });
    readme();
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect((await db.edge.findUniqueOrThrow({ where: { id: migrated.id } })).loc).toBe('child:a-b:root-memory');
    expect((await db.edge.findUniqueOrThrow({ where: { id: runtime.id } })).loc).toBe('child:a--b:root-memory');
  });
  it('#4583: a migrated edge whose loc carries the backfill suffix keeps it when the root moves', async () => {
    const root = await legacyRoot();
    const child = await db.node.create({ data: { memoryId: graph.id, loc: 'child', name: 'Child' } });
    const literal = await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: root.id, loc: 'child:a-b:', name: 'a-b' } });
    const suffixed = await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: root.id, loc: 'child:a-b::2', name: 'a😀b' } });
    readme();
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect((await db.edge.findUniqueOrThrow({ where: { id: literal.id } })).loc).toBe('child:a-b:root-memory');
    expect((await db.edge.findUniqueOrThrow({ where: { id: suffixed.id } })).loc).toBe('child:a-b:root-memory:2');
  });
  it('#4583: a migrated edge whose re-keyed loc is already owned by another edge follows the existing collision policy: the sync aborts and nothing moves', async () => {
    // The root move re-derives incident edge locs and "collisions abort the whole transaction" (the policy this block
    // already had for runtime-spelling edges). A migrated edge newly recognized by #4583 is under the same policy.
    const root = await legacyRoot();
    const child = await db.node.create({ data: { memoryId: graph.id, loc: 'child', name: 'Child' } });
    const migrated = await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: root.id, loc: 'child:a-b:', name: 'a😀b' } });
    const other = await db.node.create({ data: { memoryId: graph.id, loc: 'other', name: 'Other' } });
    const owner = await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: other.id, loc: 'child:a-b:root-memory', name: 'authored' } });
    readme();
    const outcome = await syncGraphFromGithub(graph);
    // The collision itself, raised by the re-key's own edge update on the (loc, memory) unique: not some other failure.
    expect(outcome.error).toMatch(/tx\.edge\.update\(\)/);
    expect(outcome.error).toMatch(/Unique constraint failed on the fields: \(`loc`/);
    expect(await db.node.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ loc: '' }); // the move did not happen
    expect((await db.edge.findUniqueOrThrow({ where: { id: migrated.id } })).loc).toBe('child:a-b:');
    expect((await db.edge.findUniqueOrThrow({ where: { id: owner.id } })).loc).toBe('child:a-b:root-memory');
  });
  it.each(['', 'unknown1228'])('refuses a missing or mismatched live root id (%s) before replacement', async (fileId) => {
    const root = await legacyRoot();
    readme(fileId);
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
  it('keeps an unreadable legacy root rather than deleting it under its new slug', async () => {
    await legacyRoot();
    readme();
    writeFileSync(join(repoRoot(), 'README.md'), '---\nname: [broken\n---\nRoot');
    expect((await syncGraphFromGithub(graph)).error).toContain('nothing was written');
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: '' });
  });
  it.each(['', '.hadron'])('writes the migrated root back to its %s README, never a second slug file', async (prefix) => {
    await legacyRoot();
    readme(rootId, prefix);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    const row = await db.node.findUniqueOrThrow({ where: { id: rootId } });
    const payload = { ...row, tags: [], outgoingEdges: [] };
    mkdirSync(join(repoRoot(), '.git'), { recursive: true });
    await writeNodeToGit({ ...payload, content: 'Updated root' }, 'test/repo', null, graph.id);
    expect(existsSync(join(repoRoot(), 'root-memory.md'))).toBe(false);
    expect(readFileSync(join(repoRoot(), prefix, 'README.md'), 'utf8')).toContain('Updated root');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: 'root-memory', content: 'Updated root' });
    expect(await db.node.count({ where: { memoryId: graph.id } })).toBe(1);
  });
  it('uses the renamed memory slug on the next sync while retaining the README id', async () => {
    await legacyRoot(); readme();
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    graph = await db.memory.update({ where: { id: graph.id }, data: { urn: 'test-org:new-name' }, include: { organization: true } });
    const dir = join(graphsPath, 'test-org', 'new-name'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `---\nid: ${rootId}\nname: Root\n---\nRoot body`);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: 'new-name' });
    expect(nodeFilePath(dir, 'new-name', graph.urn)).toBe(join(dir, 'README.md'));
  });
  it.each(['hrn:mem:test-org:root-memory', 'test-org::root-memory'])('normalizes accepted simple memory identity %s', (urn) => {
    expect(rootLocForMemory(urn)).toBe('root-memory');
  });

  it('bulk-exports the root with its id into README and syncs it without duplication', async () => {
    await legacyRoot(); readme();
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect((await pushMemoryToGit(graph.id)).error).toBeUndefined();
    expect(readFileSync(join(repoRoot(), 'README.md'), 'utf8')).toContain(rootId);
    expect(existsSync(join(repoRoot(), 'root-memory.md'))).toBe(false);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id } })).toBe(1);
  });
  it('removes a vacated slug-root README only when its id matches', () => {
    readme();
    expect(removeNodeFile(repoRoot(), 'root-memory', 'different-id', graph.urn)).toBe(false);
    expect(existsSync(join(repoRoot(), 'README.md'))).toBe(true);
    expect(removeNodeFile(repoRoot(), 'root-memory', rootId, graph.urn)).toBe(true);
    expect(existsSync(join(repoRoot(), 'README.md'))).toBe(false);
  });
  it('rolls back root relocation, history and edge changes if an incident edge rekey collides', async () => {
    await legacyRoot(); readme();
    const child = await db.node.create({ data: { memoryId: graph.id, loc: 'child', name: 'Child' } });
    await db.edge.create({ data: { memoryId: graph.id, sourceId: child.id, targetId: rootId, loc: 'child:uses:', name: 'uses' } });
    await db.edge.create({ data: { memoryId: graph.id, sourceId: rootId, targetId: child.id, loc: 'child:uses:root-memory', name: 'other' } });
    expect((await syncGraphFromGithub(graph)).error).toBeDefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: '' });
    expect(await db.nodeRevision.count({ where: { nodeId: rootId } })).toBe(0);
    expect(await db.edge.count({ where: { memoryId: graph.id, loc: 'child:uses:' } })).toBe(1);
  });

  it('refuses a second repo file at the root slug before it can overwrite the README', async () => {
    await legacyRoot(); readme();
    writeFileSync(join(repoRoot(), 'root-memory.md'), '---\nname: Occupant\n---\nOther body');
    expect((await syncGraphFromGithub(graph)).error).toContain('occupied by another repository file');
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: '', content: 'Root body' });
  });

  it('mirrors moves into and out of the slug-root using the correct files', async () => {
    await legacyRoot(); readme();
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    mkdirSync(join(repoRoot(), '.git'), { recursive: true });
    await db.node.update({ where: { id: rootId }, data: { loc: 'moved-root' } });
    await mirrorNodeMoveToGit(db, { srcMemoryId: graph.id, destMemoryId: graph.id, moved: [{ id: rootId, previousLoc: 'root-memory' }] });
    expect(existsSync(join(repoRoot(), 'README.md'))).toBe(false);
    expect(existsSync(join(repoRoot(), 'moved-root.md'))).toBe(true);
    await db.node.update({ where: { id: rootId }, data: { loc: 'root-memory' } });
    await mirrorNodeMoveToGit(db, { srcMemoryId: graph.id, destMemoryId: graph.id, moved: [{ id: rootId, previousLoc: 'moved-root' }] });
    expect(existsSync(join(repoRoot(), 'README.md'))).toBe(true);
    expect(existsSync(join(repoRoot(), 'moved-root.md'))).toBe(false);
    expect(existsSync(join(repoRoot(), 'root-memory.md'))).toBe(false);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id } })).toBe(1);
  });

  it('lets the README claim its live id before an alphabetically earlier copied file', async () => {
    await legacyRoot(); readme();
    writeFileSync(join(repoRoot(), 'A-copy.md'), `---\nid: ${rootId}\nname: Copy\n---\nCopy body`);
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: rootId } })).toMatchObject({ loc: 'root-memory', name: 'Root' });
    const copy = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'A-copy', memoryId: graph.id } } });
    expect(copy.id).not.toBe(rootId);
    expect(copy.content).toBe('Copy body');
  });

  it.each(['', '.hadron'])('gives a legacy %s/.node root the same valid slug', async (prefix) => {
    const dir = join(repoRoot(), prefix, '.node'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'node.yaml'), `id: ${rootId}\nname: Root\n`);
    writeFileSync(join(dir, 'topic.md'), 'Legacy root');
    const loaded = await loadGraphFromFs(repoRoot(), graph.urn, 'test/repo');
    expect(loaded.rootNode).toMatchObject({ id: rootId, loc: 'root-memory' });
    expect(loaded.skippedInvalidLoc).toEqual([]);
  });

});
