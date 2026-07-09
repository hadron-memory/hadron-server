import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir, writeNodeFiles } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

// ---------------------------------------------------------------------------
// Mock child_process.execFile so no actual git commands run
// ---------------------------------------------------------------------------
vi.mock('child_process', () => {
  const execFile = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as Function;
    if (typeof cb === 'function') cb(null, '', '');
  });
  return { execFile };
});

// ---------------------------------------------------------------------------
// Mock GitHub App functions so we don't need real credentials
// ---------------------------------------------------------------------------
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'fake-token'),
  toHttpsUrl: vi.fn((source: string, _token: string) => source),
}));

// ---------------------------------------------------------------------------
// Mock config to control GRAPHS_PATH dynamically
// ---------------------------------------------------------------------------
let mockSources: string;
let cleanup: () => void;

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get GRAPHS_PATH() {
      return mockSources;
    },
  };
});

// ---------------------------------------------------------------------------
// Fixture: a minimal MemoryWithOrg object for "test-org/test/repo"
// local path = join(GRAPHS_PATH, 'test-org', 'test/repo')
// ---------------------------------------------------------------------------
let dbGraphId: string;
let dbOrgId: string;

function makeGraph(overrides?: Partial<MemoryWithOrg>): MemoryWithOrg {
  return {
    id: dbGraphId,
    organizationId: dbOrgId,
    urn: 'test-org:test/repo',
    name: 'test/repo',
    source: 'git@github.com:test/repo.git',
    readBranch: null,
    writeBranch: null,
    visibility: 'ORGANIZATION',
    syncStatus: 'PENDING',
    syncError: null,
    pendingEdgeCount: 0,
    sourceTokenEncrypted: null,
    sourceTokenExpiresAt: null,
    lastSyncedAt: null,
    deletedAt: null,
    deletedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    organization: {
      id: dbOrgId,
      name: 'Test Org',
      urn: 'test-org',
      githubInstallationId: 12345,
      deletedAt: null,
      deletedBy: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  } as MemoryWithOrg;
}

beforeEach(async () => {
  ({ dir: mockSources, cleanup } = makeTmpDir());
  await cleanDb(db);
  // Create org and graph in DB so FK constraints are satisfied
  const { org, graph } = await createDbOrgAndGraph(db, {
    orgName: 'test-org',
    graphName: 'test/repo',
  });
  dbGraphId = graph.id;
  dbOrgId = org.id;
  // Set githubInstallationId on the org
  await db.organization.update({
    where: { id: org.id },
    data: { githubInstallationId: 12345 },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('syncGraphFromGithub', () => {
  it('calls git clone when .git directory does not exist', async () => {
    const { execFile } = await import('child_process');
    const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

    const result = await syncGraphFromGithub(makeGraph());

    const calls = execFileMock.mock.calls;
    const cloneCall = calls.find((c: any[]) => c[1]?.[0] === 'clone');
    expect(cloneCall).toBeDefined();
    expect(cloneCall![1]).toContain('git@github.com:test/repo.git');
    expect(result.error).toBeUndefined();
  });

  it('calls git pull when .git directory already exists', async () => {
    const { execFile } = await import('child_process');
    const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

    // Pre-create .git directory so it looks like an existing clone
    const repoPath = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    await syncGraphFromGithub(makeGraph());

    const calls = execFileMock.mock.calls;
    const pullCall = calls.find((c: any[]) => c[1]?.[0] === 'pull');
    expect(pullCall).toBeDefined();
    expect(pullCall![1]).toContain('--ff-only');
  });

  it('returns an error when git fails', async () => {
    const { execFile } = await import('child_process');
    const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function;
      if (typeof cb === 'function') cb(new Error('git authentication failed'), '', '');
    });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toContain('git authentication failed');
  });

  it('loads nodes from the filesystem and upserts them into the DB', async () => {
    const nodeDir = join(mockSources, 'test-org', 'test/repo', 'nodeA');
    mkdirSync(nodeDir, { recursive: true });
    writeNodeFiles(nodeDir, { name: 'nodeA', description: 'Test node' }, '## Content');

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(result.nodeCount).toBe(1);

    // loc is the path relative to the graph root, not prefixed with the graph name
    const inDb = await db.node.findFirst({ where: { loc: 'nodeA' } });
    expect(inDb).not.toBeNull();
    expect(inDb!.name).toBe('nodeA');
  });

  it('re-sync preserves node IDs for unchanged nodes', async () => {
    const nodeId = 'aaaa000000000000000000000000000000';
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'nodeA');
    mkdirSync(nodeA, { recursive: true });
    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeA', description: 'v1' });

    await syncGraphFromGithub(makeGraph());
    const first = await db.node.findFirst({ where: { loc: 'nodeA' } });

    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeA', description: 'v2' });
    await syncGraphFromGithub(makeGraph());
    const second = await db.node.findFirst({ where: { loc: 'nodeA' } });

    expect(second!.id).toBe(first!.id);
    expect(second!.description).toBe('v2');
  });

  it('re-sync replaces old nodes with the new set', async () => {
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'nodeA');
    mkdirSync(nodeA, { recursive: true });
    writeNodeFiles(nodeA, { name: 'nodeA' });

    await syncGraphFromGithub(makeGraph());
    expect(await db.node.count({ where: { memoryId: dbGraphId } })).toBe(1);

    const { rmSync } = await import('fs');
    rmSync(nodeA, { recursive: true });
    const nodeB = join(mockSources, 'test-org', 'test/repo', 'nodeB');
    mkdirSync(nodeB, { recursive: true });
    writeNodeFiles(nodeB, { name: 'nodeB' });

    await syncGraphFromGithub(makeGraph());

    const nodes = await db.node.findMany({ where: { memoryId: dbGraphId } });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('nodeB');
  });

  it('creates edges between nodes in the DB', async () => {
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'a');
    const nodeB = join(mockSources, 'test-org', 'test/repo', 'b');
    mkdirSync(nodeA, { recursive: true });
    mkdirSync(nodeB, { recursive: true });
    const bId = 'bbbb000000000000000000000000000000';
    writeNodeFiles(nodeA, { name: 'a', nodes: [{ id: bId, rel: 'uses' }] });
    writeNodeFiles(nodeB, { id: bId, name: 'b' });

    await syncGraphFromGithub(makeGraph());

    const edges = await db.edge.findMany();
    expect(edges).toHaveLength(1);
    expect(edges[0].name).toBe('uses');
  });

  it('parks a cross-repo edge as PendingEdge when target is not yet in DB', async () => {
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'a');
    mkdirSync(nodeA, { recursive: true });
    const missingId = 'cccc000000000000000000000000000000';
    writeNodeFiles(nodeA, { name: 'a', nodes: [{ id: missingId, rel: 'depends on' }] });

    await syncGraphFromGithub(makeGraph());

    expect(await db.edge.count()).toBe(0);
    const pending = await db.pendingEdge.findMany();
    expect(pending).toHaveLength(1);
    expect(pending[0].targetId).toBe(missingId);
    expect(pending[0].name).toBe('depends on');
  });

  it('resolves a PendingEdge to a real Edge when the target node is later synced', async () => {
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'a');
    mkdirSync(nodeA, { recursive: true });
    const missingId = 'dddd000000000000000000000000000000';
    writeNodeFiles(nodeA, { name: 'a', nodes: [{ id: missingId, rel: 'depends on' }] });
    await syncGraphFromGithub(makeGraph());
    expect(await db.pendingEdge.count()).toBe(1);
    expect(await db.edge.count()).toBe(0);

    const nodeB = join(mockSources, 'test-org', 'test/repo', 'b');
    mkdirSync(nodeB, { recursive: true });
    writeNodeFiles(nodeB, { id: missingId, name: 'b' });
    await syncGraphFromGithub(makeGraph());

    expect(await db.pendingEdge.count()).toBe(0);
    const edges = await db.edge.findMany();
    expect(edges).toHaveLength(1);
    expect(edges[0].name).toBe('depends on');
  });
});

// ---------------------------------------------------------------------------
// Move-aware identity (the startup-sync P2002 regression): a file that kept
// its frontmatter id but changed its path is a MOVE, a foreign-memory id is
// never stolen, a duplicated id within one repo mints a fresh id, and the
// repo-wins deletion pass keys on the SURVIVING row id.
// ---------------------------------------------------------------------------
describe('move-aware identity', () => {
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');

  it('treats a same-id file at a new path as a move (no P2002, loc updated)', async () => {
    const nodeId = 'aaaa111100000000000000000000000001';
    await db.node.create({
      data: { id: nodeId, memoryId: dbGraphId, loc: 'tasks:create-platform-spec', name: 'old', ownerRepo: 'test/repo' },
    });

    const dir = join(repoRoot(), 'tasks', 'add-platform-spec');
    mkdirSync(dir, { recursive: true });
    writeNodeFiles(dir, { id: nodeId, name: 'renamed task' });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const rows = await db.node.findMany({ where: { memoryId: dbGraphId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(nodeId);
    expect(rows[0].loc).toBe('tasks:add-platform-spec');
    expect(rows[0].name).toBe('renamed task');
  });

  it('never steals a foreign memory\'s node id — mints a fresh id instead', async () => {
    const foreignId = 'bbbb222200000000000000000000000002';
    const { graph: otherGraph } = await createDbOrgAndGraph(db, {
      orgName: 'other-org',
      graphName: 'other/repo',
    });
    await db.node.create({
      data: { id: foreignId, memoryId: otherGraph.id, loc: 'shared:create-task', name: 'foreign' },
    });

    const dir = join(repoRoot(), 'copied');
    mkdirSync(dir, { recursive: true });
    writeNodeFiles(dir, { id: foreignId, name: 'copied node' });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    // The foreign node is untouched…
    const foreign = await db.node.findUniqueOrThrow({ where: { id: foreignId } });
    expect(foreign.memoryId).toBe(otherGraph.id);
    expect(foreign.loc).toBe('shared:create-task');
    // …and the copied file became a NEW node with a fresh id.
    const copied = await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'copied' } });
    expect(copied).not.toBeNull();
    expect(copied!.id).not.toBe(foreignId);
  });

  it('a duplicated frontmatter id within one repo yields two nodes (second gets a fresh id)', async () => {
    const dupId = 'cccc333300000000000000000000000003';
    const dirA = join(repoRoot(), 'a-first');
    const dirB = join(repoRoot(), 'b-second');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeNodeFiles(dirA, { id: dupId, name: 'first' });
    writeNodeFiles(dirB, { id: dupId, name: 'second copy' });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const rows = await db.node.findMany({ where: { memoryId: dbGraphId }, orderBy: { loc: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { loc: string }) => r.loc)).toEqual(['a-first', 'b-second']);
    expect(rows.filter((r: { id: string }) => r.id === dupId)).toHaveLength(1);
  });

  it('remaps edge endpoints when a replacement id was minted (duplicate-id file keeps its own edges)', async () => {
    const dupId = 'ffff666600000000000000000000000006';
    const targetId = 'ffff777700000000000000000000000007';
    const dirTarget = join(repoRoot(), 'target');
    const dirA = join(repoRoot(), 'a-first');
    const dirB = join(repoRoot(), 'b-second');
    mkdirSync(dirTarget, { recursive: true });
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeNodeFiles(dirTarget, { id: targetId, name: 'target' });
    writeNodeFiles(dirA, { id: dupId, name: 'first' });
    // The SECOND claimant of dupId gets a fresh row id — its edge must
    // attach to THAT row, not to the first claimant (PR-576 codex review).
    writeNodeFiles(dirB, { id: dupId, name: 'second copy', nodes: [{ id: targetId, rel: 'points at' }] });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const second = await db.node.findFirstOrThrow({ where: { memoryId: dbGraphId, loc: 'b-second' } });
    expect(second.id).not.toBe(dupId);
    const edges = await db.edge.findMany({ where: { memoryId: dbGraphId } });
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(second.id);
    expect(edges[0].targetId).toBe(targetId);
  });

  it('keys the repo-wins deletion pass on the SURVIVING row id when the file id differs', async () => {
    const survivingId = 'dddd444400000000000000000000000004';
    await db.node.create({
      data: { id: survivingId, memoryId: dbGraphId, loc: 'keep', name: 'existing', ownerRepo: 'test/repo' },
    });

    // Same loc, DIFFERENT frontmatter id: the loc-keyed update keeps the
    // existing row (and its id). Recording the file id in upsertedIds would
    // make the notIn deletion pass delete the row we just updated.
    const dir = join(repoRoot(), 'keep');
    mkdirSync(dir, { recursive: true });
    writeNodeFiles(dir, { id: 'eeee555500000000000000000000000005', name: 'updated' });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const rows = await db.node.findMany({ where: { memoryId: dbGraphId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(survivingId);
    expect(rows[0].name).toBe('updated');
  });
});
