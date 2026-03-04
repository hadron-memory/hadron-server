import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, makeTmpDir, writeNodeFiles } from '../../test/helpers.js';
import { syncGraphFromGithub, type GraphWithOrg } from './syncGraphFromGithub.js';

// ---------------------------------------------------------------------------
// Mock child_process.execFile so no actual git commands run
// execFile may be called with 3 args (cmd, args, cb) or 4 args (cmd, args, opts, cb)
// depending on whether options are passed. Always treat the last arg as the callback.
// ---------------------------------------------------------------------------
vi.mock('child_process', () => {
  const execFile = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as Function;
    if (typeof cb === 'function') cb(null, '', '');
  });
  return { execFile };
});

// ---------------------------------------------------------------------------
// Mock config to control SOURCES_PATH dynamically
// ---------------------------------------------------------------------------
let mockSources: string;
let cleanup: () => void;

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get SOURCES_PATH() {
      return mockSources;
    },
  };
});

// ---------------------------------------------------------------------------
// Fixture: a minimal GraphWithOrg object for "test-org/test/repo"
// local path = join(SOURCES_PATH, 'test-org', 'test/repo')
// ---------------------------------------------------------------------------
function makeGraph(overrides?: Partial<GraphWithOrg>): GraphWithOrg {
  return {
    id: 'graph-1',
    organizationId: 'org-1',
    name: 'test/repo',
    source: 'git@github.com:test/repo.git',
    readBranch: null,
    writeBranch: null,
    version: null,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    organization: {
      id: 'org-1',
      name: 'Test Org',
      slug: 'test-org',
      githubInstallationId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  } as GraphWithOrg;
}

beforeEach(async () => {
  ({ dir: mockSources, cleanup } = makeTmpDir());
  await cleanDb(db);
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
    const inDb = await db.node.findUnique({ where: { loc: 'nodeA' } });
    expect(inDb).not.toBeNull();
    expect(inDb!.name).toBe('nodeA');
  });

  it('re-sync preserves node IDs for unchanged nodes', async () => {
    const nodeId = 'aaaa000000000000000000000000000000';
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'nodeA');
    mkdirSync(nodeA, { recursive: true });
    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeA', description: 'v1' });

    await syncGraphFromGithub(makeGraph());
    const first = await db.node.findUnique({ where: { loc: 'nodeA' } });

    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeA', description: 'v2' });
    await syncGraphFromGithub(makeGraph());
    const second = await db.node.findUnique({ where: { loc: 'nodeA' } });

    expect(second!.id).toBe(first!.id);
    expect(second!.description).toBe('v2');
  });

  it('re-sync replaces old nodes with the new set', async () => {
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'nodeA');
    mkdirSync(nodeA, { recursive: true });
    writeNodeFiles(nodeA, { name: 'nodeA' });

    await syncGraphFromGithub(makeGraph());
    expect(await db.node.count({ where: { namespace: 'test.repo' } })).toBe(1);

    const { rmSync } = await import('fs');
    rmSync(nodeA, { recursive: true });
    const nodeB = join(mockSources, 'test-org', 'test/repo', 'nodeB');
    mkdirSync(nodeB, { recursive: true });
    writeNodeFiles(nodeB, { name: 'nodeB' });

    await syncGraphFromGithub(makeGraph());

    const nodes = await db.node.findMany({ where: { namespace: 'test.repo' } });
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
    expect(edges[0].label).toBe('uses');
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
    expect(pending[0].label).toBe('depends on');
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
    expect(edges[0].label).toBe('depends on');
  });
});
