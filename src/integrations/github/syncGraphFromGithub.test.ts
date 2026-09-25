import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir, writeFrontmatterNode, writeNodeFiles } from '../../test/helpers.js';
import { splitGitArgv } from '../../test/gitArgv.js';
import { GIT_TRANSPORT_GUARD } from './execGit.js';
import { syncGraphFromGithub, updateNodeFromGitSync, GitSyncTargetMovedError, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { ensureChannelWithRoot, lockMemoryForChannelChange } from '../../lib/channels.js';
import { generateId } from '../../lib/id.js';
import { acquireLockSet, ancestorLocs, lockAncestorsForCreate } from '../../lib/nodeSubtreeLock.js';
import { moveNodeSubtree } from '../../lib/nodeSubtreeMove.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';

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

/** Every recorded `git` argv, with the #561 transport guard split off. */
async function gitCalls(): Promise<{ guarded: boolean; args: string[] }[]> {
  const { execFile } = await import('child_process');
  const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
  return execFileMock.mock.calls.map((c: any[]) => splitGitArgv(c[1] as string[]));
}

async function waitForChannelMemoryLockWaiters(
  memoryId: string,
  minimumWaiters: number,
  timeoutMs = 10_000,
): Promise<void> {
  const key = `channel-host:${memoryId}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = (((hashtext(${key})::bigint >> 32) & 4294967295))::oid
        AND objid = ((hashtext(${key})::bigint & 4294967295))::oid
        AND objsubid = 1
    `;
    if (Number(count) >= minimumWaiters) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${minimumWaiters} Channel memory-lock waiter(s) on ${memoryId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLockWaiters(
  locktype: 'advisory' | 'transactionid',
  minimumWaiters: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_locks
      WHERE locktype = ${locktype}
        AND NOT granted
        AND (
          locktype = 'transactionid'
          OR database = (SELECT oid FROM pg_database WHERE datname = current_database())
        )
    `;
    if (Number(count) >= minimumWaiters) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${minimumWaiters} ${locktype} waiter(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('syncGraphFromGithub', () => {
  it('calls git clone when .git directory does not exist', async () => {
    const result = await syncGraphFromGithub(makeGraph());

    const cloneCall = (await gitCalls()).find((c) => c.args[0] === 'clone');
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.args).toContain('git@github.com:test/repo.git');
    expect(result.error).toBeUndefined();
  });

  it('calls git pull when .git directory already exists', async () => {
    // Pre-create .git directory so it looks like an existing clone
    const repoPath = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    await syncGraphFromGithub(makeGraph());

    const pullCall = (await gitCalls()).find((c) => c.args[0] === 'pull');
    expect(pullCall).toBeDefined();
    expect(pullCall!.args).toContain('--ff-only');
  });

  // ── #561: the transport guard reaches the clone ───────────────────────────
  //
  // The defect these pin is not "the URL is wrong" — it is that git reads a
  // remote URL as a TRANSPORT SELECTOR, so `Memory.source` chooses how git
  // talks, not just where. Measured (2026-09-08): a bare local path clones by
  // default and ingests that repo's files as nodes; `ext::` is refused by
  // current git's own default but by nothing we control.
  // `validateMemorySource` refuses such a value at the mutation AND again here
  // against the stored one; the guard below is the transport half, and it has to
  // be asserted where git is actually invoked, because an operation test that
  // stops at the thrown error cannot see what argv reached the process.

  it('the clone carries the transport allowlist, ahead of the URL', async () => {
    await syncGraphFromGithub(makeGraph());

    const { execFile } = await import('child_process');
    const raw = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => c[1] as string[])
      .find((argv) => argv.includes('clone'));
    expect(raw, 'expected a clone invocation').toBeDefined();
    // The guard must LEAD: git honours `-c` only before the subcommand, so a
    // guard that arrived after `clone` would be passed to clone as arguments
    // and silently not apply. What the policy SAYS is pinned once, literally,
    // in execGit.test.ts — asserting it again here would be a second copy to
    // keep in sync, which is the drift this repo keeps filing.
    expect(raw!.slice(0, GIT_TRANSPORT_GUARD.length)).toEqual([...GIT_TRANSPORT_GUARD]);
    expect(raw!.indexOf('clone')).toBe(GIT_TRANSPORT_GUARD.length);
  });

  it('the clone ends option parsing before the URL, so a `-`-leading source cannot become a flag', async () => {
    await syncGraphFromGithub(makeGraph());

    const clone = (await gitCalls()).find((c) => c.args[0] === 'clone')!;
    const sep = clone.args.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    // The URL must come AFTER the separator — before it, `--upload-pack=<cmd>`
    // would be read as an option and executed.
    expect(clone.args[sep + 1]).toBe('git@github.com:test/repo.git');
  });

  // ── #561: a source already IN the column, which never passed a mutation ───
  //
  // @codex, PR #1142: `validateMemorySource` at the mutations governs every
  // future write and no existing row. This function is reached by the startup
  // batch loop and the webhook, neither of which goes through a mutation — and
  // the transport guard does not cover the SSRF case, because https is
  // explicitly allowed there. So the allowlist runs against the STORED value.

  it('refuses a stored non-github https source, and never invokes git', async () => {
    const result = await syncGraphFromGithub(
      makeGraph({ source: 'https://github.com.evil.example/o/r' }),
    );

    expect(result.error).toMatch(/Invalid memory source/);
    // The refusal has to precede the invocation, not follow it: the SSRF is the
    // request itself, so a check that ran after the clone would have made it.
    expect(await gitCalls()).toHaveLength(0);
  });

  it('refuses a stored local path (the transport guard would too, this fails earlier)', async () => {
    const result = await syncGraphFromGithub(makeGraph({ source: '/srv/evil-repo' }));

    expect(result.error).toMatch(/Invalid memory source/);
    expect(await gitCalls()).toHaveLength(0);
  });

  it('records the refusal as a sync ERROR an operator can see', async () => {
    // A legacy row cannot be fixed by anyone who cannot find it. The message
    // lands in `syncError`, which is what the portal and `syncStatus` surface.
    await syncGraphFromGithub(makeGraph({ source: 'ext::whoami' }));

    const row = await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } });
    expect(row.syncStatus).toBe('ERROR');
    expect(row.syncError).toMatch(/Invalid memory source/);
  });

  it('every git invocation on the pull path is guarded too', async () => {
    const repoPath = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    await syncGraphFromGithub(makeGraph());

    const calls = await gitCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.guarded)).toBe(true);
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
    const inDb = await db.node.findFirst({ where: { loc: 'nodeA', memoryId: dbGraphId } });
    expect(inDb).not.toBeNull();
    expect(inDb!.name).toBe('nodeA');
  });

  it('re-sync preserves node IDs for unchanged nodes', async () => {
    const nodeId = 'aaaa000000000000000000000000000000';
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'nodeA');
    mkdirSync(nodeA, { recursive: true });
    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeA', description: 'v1' });

    await syncGraphFromGithub(makeGraph());
    const first = await db.node.findFirst({ where: { loc: 'nodeA', memoryId: dbGraphId } });

    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeA', description: 'v2' });
    await syncGraphFromGithub(makeGraph());
    const second = await db.node.findFirst({ where: { loc: 'nodeA', memoryId: dbGraphId } });

    expect(second!.id).toBe(first!.id);
    expect(second!.description).toBe('v2');
    expect(second!.revSeq).toBe(2);
    expect(await db.nodeRevision.findMany({ where: { nodeId }, select: { revNo: true, description: true } }))
      .toEqual([{ revNo: 1, description: 'v1' }]);
  });

  it('a sync over unrevisioned drift takes the reconcile AND its own revision (#1339 review)', async () => {
    // @codex P1: a raw write between two syncs used to be folded into the
    // sync's single revision, and the refreshed fingerprint then hid it.
    const nodeId = 'aaaa000000000000000000000000001339';
    const nodeA = join(mockSources, 'test-org', 'test/repo', 'nodeD');
    mkdirSync(nodeA, { recursive: true });
    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeD', description: 'v1' });
    await syncGraphFromGithub(makeGraph());
    await db.node.update({ where: { id: nodeId }, data: { content: 'raw writer' } });

    writeNodeFiles(nodeA, { id: nodeId, name: 'nodeD', description: 'v2' });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();

    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).revSeq).toBe(3);
    const history = await db.nodeRevision.findMany({ where: { nodeId }, orderBy: { revNo: 'asc' } });
    expect(history.map((r) => r.revNo)).toEqual([1, 2]);
    expect(history[0]!.revLabel).toMatch(/Reconciled state changed outside a revisioned writer/);
    expect(history[1]!.revLabel).toBe('Synchronized from GitHub');
    expect(history[1]!.description).toBe('v1');
  });

  it('refuses to apply a sync update to a row that has left the synced memory (#1339 review)', async () => {
    // @copilot: the row lock must re-validate ownership — a concurrent
    // cross-memory move between the preflight lookup and the lock would
    // otherwise have the repo's update rewrite a FOREIGN memory's node.
    const nodeId = 'aaaa000000000000000000000000001340';
    const row = await db.node.create({ data: { id: nodeId, memoryId: dbGraphId, loc: 'moved:away', name: 'n', content: 'mine' } });
    await expect(
      db.$transaction((tx) => updateNodeFromGitSync(tx, row, { content: 'from git' }, undefined, 'some-other-memory')),
    ).rejects.toBeInstanceOf(GitSyncTargetMovedError);
    const after = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(after.content).toBe('mine');
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
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

  it('does not promote a soft-deleted PendingEdge when its target is synced', async () => {
    const { graph: sourceMemory } = await createDbOrgAndGraph(db, {
      orgName: 'cancelled-pending-source-org',
      graphName: 'cancelled/pending-source',
    });
    const source = await db.node.create({
      data: { id: generateId(), memoryId: sourceMemory.id, loc: 'source', name: 'source' },
    });
    const targetId = 'abab000000000000000000000000000000';
    const cancelledAt = new Date();
    const pending = await db.pendingEdge.create({
      data: {
        id: generateId(),
        sourceId: source.id,
        targetId,
        name: 'cancelled',
        deletedAt: cancelledAt,
      },
    });
    const targetDir = join(mockSources, 'test-org', 'test/repo', 'target');
    mkdirSync(targetDir, { recursive: true });
    writeNodeFiles(targetDir, { id: targetId, name: 'target' });

    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.pendingEdge.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      deletedAt: cancelledAt,
    });
    expect(await db.edge.count({ where: { sourceId: source.id, targetId } })).toBe(0);
  });

  it('reconciles the foreign source memory when target sync promotes its PendingEdge', async () => {
    const { graph: sourceMemory } = await createDbOrgAndGraph(db, {
      orgName: 'foreign-pending-source-org',
      graphName: 'foreign/pending-source',
    });
    const source = await db.node.create({
      data: { id: generateId(), memoryId: sourceMemory.id, loc: 'source', name: 'source' },
    });
    const targetId = 'eeee000000000000000000000000000000';
    const pending = await db.pendingEdge.create({
      data: { id: generateId(), sourceId: source.id, targetId, name: 'cross-memory' },
    });
    await db.memory.update({
      where: { id: sourceMemory.id },
      data: { pendingEdgeCount: 1 },
    });

    const targetDir = join(mockSources, 'test-org', 'test/repo', 'target');
    mkdirSync(targetDir, { recursive: true });
    writeNodeFiles(targetDir, { id: targetId, name: 'target' });

    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await db.edge.findFirst({
      where: { memoryId: sourceMemory.id, sourceId: source.id, targetId, deletedAt: null },
    })).not.toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: sourceMemory.id } })).pendingEdgeCount).toBe(0);
  });

  it('retains a PendingEdge when its derived loc is occupied by another relationship', async () => {
    const { graph: sourceMemory } = await createDbOrgAndGraph(db, {
      orgName: 'foreign-pending-collision-org',
      graphName: 'foreign/pending-collision',
    });
    const source = await db.node.create({
      data: { id: generateId(), memoryId: sourceMemory.id, loc: 'source', name: 'source' },
    });
    const otherTarget = await db.node.create({
      data: { id: generateId(), memoryId: sourceMemory.id, loc: 'target', name: 'other target' },
    });
    const targetId = 'ffff000000000000000000000000000000';
    const edgeLoc = deriveEdgeLoc(source.loc, 'cross-memory', 'target');
    const occupied = await db.edge.create({
      data: {
        id: generateId(),
        memoryId: sourceMemory.id,
        sourceId: source.id,
        targetId: otherTarget.id,
        loc: edgeLoc,
        name: 'cross-memory',
      },
    });
    const pending = await db.pendingEdge.create({
      data: { id: generateId(), sourceId: source.id, targetId, name: 'cross-memory' },
    });
    await db.memory.update({
      where: { id: sourceMemory.id },
      data: { pendingEdgeCount: 1 },
    });

    const targetDir = join(mockSources, 'test-org', 'test/repo', 'target');
    mkdirSync(targetDir, { recursive: true });
    writeNodeFiles(targetDir, { id: targetId, name: 'target' });

    await expect(syncGraphFromGithub(makeGraph())).resolves.toMatchObject({
      error: expect.stringContaining('already occupied'),
    });
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).not.toBeNull();
    expect(await db.edge.findUniqueOrThrow({ where: { id: occupied.id } })).toMatchObject({
      sourceId: source.id,
      targetId: otherTarget.id,
      deletedAt: null,
    });
    expect(await db.node.findUnique({ where: { id: targetId } })).toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: sourceMemory.id } })).pendingEdgeCount).toBe(1);
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

  it('records one committed revision per node when two files swap locs', async () => {
    const aId = 'aaaa111100000000000000000000000021';
    const bId = 'bbbb222200000000000000000000000022';
    const aDir = join(repoRoot(), 'a');
    const bDir = join(repoRoot(), 'b');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    writeNodeFiles(aDir, { id: aId, name: 'A' });
    writeNodeFiles(bDir, { id: bId, name: 'B' });
    await syncGraphFromGithub(makeGraph());
    await db.memory.update({ where: { id: dbGraphId }, data: { maxRevCount: 1 } });

    rmSync(aDir, { recursive: true });
    rmSync(bDir, { recursive: true });
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    writeNodeFiles(aDir, { id: bId, name: 'B' });
    writeNodeFiles(bDir, { id: aId, name: 'A' });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();

    expect(await db.node.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ loc: 'b', revSeq: 2 });
    expect(await db.node.findUniqueOrThrow({ where: { id: bId } })).toMatchObject({ loc: 'a', revSeq: 2 });
    expect(
      await db.nodeRevision.findMany({
        where: { nodeId: { in: [aId, bId] } },
        orderBy: { nodeId: 'asc' },
        select: { nodeId: true, revNo: true, loc: true },
      }),
    ).toEqual([
      { nodeId: aId, revNo: 1, loc: 'a' },
      { nodeId: bId, revNo: 1, loc: 'b' },
    ]);
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

describe('Channel-protected mirror cleanup (#1226)', () => {
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');

  it('locks a cross-memory edge target through Channel reuse before inserting', async () => {
    const { graph: targetMemory } = await createDbOrgAndGraph(db, {
      orgName: 'edge-target-org',
      graphName: 'edge/target',
    });
    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: targetMemory.id,
      loc: 'chats:edge-race',
      name: 'edge-race',
      createdBy: null,
    });
    const oldMessage = await db.node.create({
      data: {
        id: 'eeee999900000000000000000000000009',
        memoryId: targetMemory.id,
        loc: 'chats:edge-race:messages:0001',
        name: 'old message',
      },
    });
    const deletedAt = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt } }),
    ]);

    const sourceDir = join(repoRoot(), 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeNodeFiles(sourceDir, {
      name: 'source',
      nodes: [{ id: oldMessage.id, rel: 'points to old transcript' }],
    });

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, targetMemory.id);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    const reusing = ensureChannelWithRoot(db, {
      memoryId: targetMemory.id,
      loc: 'chats:edge-race',
      name: 'edge-race',
      createdBy: null,
    });
    try {
      await waitForChannelMemoryLockWaiters(targetMemory.id, 1);
      const syncing = syncGraphFromGithub(makeGraph());
      await waitForChannelMemoryLockWaiters(targetMemory.id, 2);
      signalRelease();
      await holder;
      await reusing;
      const result = await syncing;
      expect(result.error).toBeUndefined();
      expect(await db.edge.count({ where: { targetId: oldMessage.id, deletedAt: null } })).toBe(0);
      expect(await db.pendingEdge.count({ where: { targetId: oldMessage.id } })).toBe(1);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('retries preflight when a cross-memory target becomes live after the lock set was collected', async () => {
    const { graph: targetMemory } = await createDbOrgAndGraph(db, {
      orgName: 'late-edge-target-org',
      graphName: 'late/edge-target',
    });
    const targetId = 'ffff999900000000000000000000000009';
    const sourceDir = join(repoRoot(), 'late-source');
    mkdirSync(sourceDir, { recursive: true });
    writeNodeFiles(sourceDir, {
      name: 'late source',
      nodes: [{ id: targetId, rel: 'points to late target' }],
    });

    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const release = new Promise<void>((resolve) => { signalRelease = resolve; });
    const holder = db.$transaction(async (tx) => {
      await lockMemoryForChannelChange(tx, dbGraphId);
      signalHeld();
      await release;
    }, { timeout: 20_000 });

    await held;
    const syncing = syncGraphFromGithub(makeGraph());
    try {
      // The first preflight saw no target and is now waiting to enter its
      // transaction with only dbGraphId in the endpoint-memory set.
      await waitForChannelMemoryLockWaiters(dbGraphId, 1);
      await db.node.create({
        data: {
          id: targetId,
          memoryId: targetMemory.id,
          loc: 'targets:late',
          name: 'late target',
        },
      });
      signalRelease();
      await holder;

      const result = await syncing;
      expect(result.error).toBeUndefined();
      expect(await db.edge.count({ where: { targetId, deletedAt: null } })).toBe(1);
      expect(await db.pendingEdge.count({ where: { targetId } })).toBe(0);
    } finally {
      signalRelease();
      await holder.catch(() => undefined);
    }
  }, 20_000);

  it('holds the source path through edge insertion so a cross-memory move carries the new edge', async () => {
    const { graph: targetMemory } = await createDbOrgAndGraph(db, {
      orgName: 'source-move-target-org',
      graphName: 'source/move-target',
    });
    const { graph: movedMemory } = await createDbOrgAndGraph(db, {
      orgName: 'source-move-destination-org',
      graphName: 'source/move-destination',
    });
    const sourceId = 'eeee888800000000000000000000000008';
    const source = await db.node.create({
      data: { id: sourceId, memoryId: dbGraphId, loc: 'source', name: 'source' },
    });
    const target = await db.node.create({
      data: {
        id: 'ffff888800000000000000000000000008',
        memoryId: targetMemory.id,
        loc: 'target',
        name: 'target',
      },
    });
    const sourceDir = join(repoRoot(), 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeNodeFiles(sourceDir, {
      id: source.id,
      name: 'source',
      nodes: [{ id: target.id, rel: 'cross-memory target' }],
    });

    let releaseTarget!: () => void;
    let targetHeld!: () => void;
    const targetReady = new Promise<void>((resolve) => { targetHeld = resolve; });
    const targetRelease = new Promise<void>((resolve) => { releaseTarget = resolve; });
    const targetHolder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${target.id} FOR UPDATE`;
      targetHeld();
      await targetRelease;
    }, { timeout: 20_000 });

    await targetReady;
    const syncing = syncGraphFromGithub(makeGraph());
    try {
      // The edge insert has reached the target FK and is blocked while the
      // sync transaction still holds the source's complete path lock.
      await waitForLockWaiters('transactionid', 1);
      const moving = db.$transaction(async (tx) => {
        await acquireLockSet(tx, [
          ...ancestorLocs('moved:source').map((loc) => ({ memoryId: movedMemory.id, loc })),
          ...ancestorLocs(source.loc).map((loc) => ({ memoryId: source.memoryId, loc })),
          { memoryId: source.memoryId, loc: source.loc },
        ]);
        await lockAncestorsForCreate(tx, movedMemory.id, 'moved:source');
        return moveNodeSubtree(tx, {
          source,
          destMemoryId: movedMemory.id,
          destLoc: 'moved:source',
          editor: { info: 'sync-source-race-test' },
        });
      }, { timeout: 20_000 });

      // Mutation-test of the source-path fix: without the exact path lock the
      // move completes here and snapshots no edge; the later insert is stranded
      // in dbGraphId with a source that now belongs to movedMemory.
      await waitForLockWaiters('advisory', 1);
      releaseTarget();
      await targetHolder;

      expect((await syncing).error).toBeUndefined();
      await moving;
      expect(await db.node.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
        memoryId: movedMemory.id,
        loc: 'moved:source',
      });
      expect(await db.edge.findFirstOrThrow({
        where: { sourceId: source.id, targetId: target.id, deletedAt: null },
      })).toMatchObject({ memoryId: movedMemory.id });
    } finally {
      releaseTarget();
      await targetHolder.catch(() => undefined);
    }
  }, 20_000);

  it('keeps a skipped file that still exists under a dead Channel and deletes only the true orphan', async () => {
    const keptId = 'aaaa999900000000000000000000000001';
    const goneId = 'bbbb999900000000000000000000000002';
    const keptDir = join(repoRoot(), 'chats', 'dead', 'messages', 'kept');
    const goneDir = join(repoRoot(), 'chats', 'dead', 'messages', 'gone');
    mkdirSync(keptDir, { recursive: true });
    mkdirSync(goneDir, { recursive: true });
    writeNodeFiles(keptDir, { id: keptId, name: 'kept' });
    writeNodeFiles(goneDir, { id: goneId, name: 'gone' });
    await syncGraphFromGithub(makeGraph());

    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: dbGraphId,
      loc: 'chats:dead',
      name: 'dead',
      createdBy: null,
    });
    const now = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt: now } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt: now } }),
    ]);
    rmSync(goneDir, { recursive: true });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(result.skippedProtected).toContain('chats:dead:messages:kept');
    expect(await db.node.findUnique({ where: { id: keptId } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: goneId } })).toBeNull();
  });

  it('does not cascade a cross-memory edge while pruning an orphan below a dead Channel', async () => {
    const orphanId = 'cccc999900000000000000000000000003';
    const orphanDir = join(repoRoot(), 'chats', 'dead-edge', 'messages', 'orphan');
    mkdirSync(orphanDir, { recursive: true });
    writeNodeFiles(orphanDir, { id: orphanId, name: 'orphan' });
    await syncGraphFromGithub(makeGraph());

    const { channel, rootId } = await ensureChannelWithRoot(db, {
      memoryId: dbGraphId,
      loc: 'chats:dead-edge',
      name: 'dead-edge',
      createdBy: null,
    });
    const now = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt: now } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt: now } }),
    ]);
    const { graph: otherMemory } = await createDbOrgAndGraph(db, {
      orgName: 'cleanup-edge-other-org',
      graphName: 'cleanup/edge-other',
    });
    const external = await db.node.create({
      data: { id: generateId(), memoryId: otherMemory.id, loc: 'external', name: 'external' },
    });
    const edge = await db.edge.create({
      data: {
        id: generateId(),
        memoryId: dbGraphId,
        sourceId: orphanId,
        targetId: external.id,
        loc: 'chats:dead-edge:messages:orphan:rel:external',
        name: 'rel',
      },
    });
    rmSync(orphanDir, { recursive: true });

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toMatch(/bridge nodes selected for hard-delete/i);
    expect(await db.node.findUnique({ where: { id: orphanId } })).not.toBeNull();
    expect(await db.edge.findUnique({ where: { id: edge.id } })).not.toBeNull();
  });
});

/**
 * #1224 — validating the mirror's derived loc means some files are skipped,
 * and a skip meets a destructive cleanup pass. These pin the interaction
 * rather than the validator (which `loadGraphFromFs.test.ts` covers).
 */
describe('a file whose path cannot be a loc (#1224)', () => {
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');

  /** Write a frontmatter node at `<repoRoot>/<relPath>.md`. */
  function writeMd(relPath: string, id: string, name: string): void {
    const full = join(repoRoot(), `${relPath}.md`);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `---\nid: ${id}\nname: ${name}\n---\n# ${name}`, 'utf-8');
  }

  it('does not write a loc the API would refuse, and syncs the rest of the memory', async () => {
    writeMd('ok', 'aaaa111100000000000000000000000001', 'ok');
    writeMd('evil--> x', 'bbbb222200000000000000000000000002', 'bad');

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const locs = (await db.node.findMany({ where: { memoryId: dbGraphId } })).map((n) => n.loc);
    expect(locs).toEqual(['ok']);
  });

  it('a rename INTO an invalid name fails to move the node — it does not delete it', async () => {
    // The hazard this half exists for. The cleanup pass hard-deletes every
    // git-owned row it did not upsert, so a skipped file would take its node
    // with it: renaming `notes.md` to something unusable would destroy the
    // node instead of failing to move it. Repo-wins decides what a node IS,
    // not whether a file this loader cannot address is still a node.
    const nodeId = 'cccc333300000000000000000000000003';
    writeMd('notes', nodeId, 'notes');
    await syncGraphFromGithub(makeGraph());
    expect(await db.node.findUnique({ where: { id: nodeId } })).not.toBeNull();

    // The rename: same frontmatter id, a path that cannot be a loc.
    rmSync(join(repoRoot(), 'notes.md'));
    writeMd('notes--> evil', nodeId, 'notes');

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const row = await db.node.findUnique({ where: { id: nodeId } });
    expect(row).not.toBeNull();
    expect(row!.loc).toBe('notes'); // still at its old, valid address
  });

  it('refuses a competing move rather than parking the occupant at a loc validateLoc rejects', async () => {
    // @codex P2 on PR #1229. The move-collision branch parks an occupant at
    // `<loc>~displaced-<id>` — a loc `validateLoc` REFUSES — and relies on the
    // cleanup pass to collect it moments later. Protecting skipped rows broke
    // that: the parked row survived, so this PR's own guard would have stored
    // the invariant violation the PR exists to prevent, permanently.
    const occupantId = 'aaaa000000000000000000000000000011';
    const moverId = 'bbbb000000000000000000000000000012';
    writeMd('a', occupantId, 'occupant');
    writeMd('b', moverId, 'mover');
    await syncGraphFromGithub(makeGraph());

    // The occupant's file is renamed to something unusable, and in the SAME
    // sync the mover's file takes the loc it just vacated.
    rmSync(join(repoRoot(), 'a.md'));
    rmSync(join(repoRoot(), 'b.md'));
    writeMd('a--> evil', occupantId, 'occupant');
    writeMd('a', moverId, 'mover');

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const rows = await db.node.findMany({ where: { memoryId: dbGraphId }, select: { id: true, loc: true } });
    // Nothing is stored at an address the API would refuse — the assertion
    // the whole finding turns on.
    expect(rows.filter((r) => r.loc.includes('~'))).toEqual([]);
    // Both rows survive, at their original valid addresses.
    expect(rows.find((r) => r.id === occupantId)?.loc).toBe('a');
    expect(rows.find((r) => r.id === moverId)?.loc).toBe('b');
  });

  it('suppresses the destructive cleanup when a skipped file names no row it can resolve', async () => {
    // @copilot on PR #1229: the cleanup keys on the SURVIVING ROW id, and a
    // file's frontmatter id is not always that id — an id-less file has none
    // at all. Protecting the raw file id would read as a guarantee while
    // protecting nothing, so an unresolvable skip fails CLOSED: the run does
    // not delete rows it cannot vouch for.
    const goneId = 'cccc000000000000000000000000000013';
    writeMd('gone', goneId, 'gone');
    await syncGraphFromGithub(makeGraph());
    expect(await db.node.findUnique({ where: { id: goneId } })).not.toBeNull();

    // `gone.md` really is deleted — normally its row would be cleaned up (the
    // control test below proves it). But an ID-LESS file is skipped in the
    // same run, so the cleanup cannot tell that row from this one.
    rmSync(join(repoRoot(), 'gone.md'));
    const full = join(repoRoot(), 'no-id--> evil.md');
    writeFileSync(full, `---\nname: no id here\n---\n# x`, 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await syncGraphFromGithub(makeGraph());
    // Read the calls BEFORE restoring: `mockRestore` clears them, so the
    // assertion below would read an emptied instrument and match nothing.
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    expect(result.error).toBeUndefined();

    expect(await db.node.findUnique({ where: { id: goneId } })).not.toBeNull();
    // Named, and named by FILE — an operator cannot grep for a row id.
    expect(line).toMatch(/cleanup SUPPRESSED/);
    expect(line).toMatch(/no-id--> evil\.md/);
  });

  it('still deletes a row whose file is genuinely GONE', async () => {
    // The control for the test above: sparing skipped rows must not spare
    // every row, or "repo-wins" would stop meaning anything and the
    // assertion above would pass against a cleanup pass that deletes nothing.
    const nodeId = 'dddd444400000000000000000000000006';
    writeMd('notes', nodeId, 'notes');
    await syncGraphFromGithub(makeGraph());
    expect(await db.node.findUnique({ where: { id: nodeId } })).not.toBeNull();

    rmSync(join(repoRoot(), 'notes.md'));

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: nodeId } })).toBeNull();
  });
});

// ── #1348: git sync restores objectType, and absence never clears it ────────
// cor:int:020:01 (amended 2026-09-25): a field absent from the file means no
// opinion — on create it takes its default, on update the stored value is kept,
// and clearing takes an explicit statement for that field. For objectType a
// FILE never clears it (hadron-cli#725: absent, "" and blank are all no
// opinion; `node update --object-type ""` is the clear), so only a non-blank
// value is written, as-is. Both file forms, and every persistence path.
describe('#1348 — objectType through git sync', () => {
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');
  const legacy = (loc: string, meta: Parameters<typeof writeNodeFiles>[1]) => {
    const dir = join(repoRoot(), loc);
    mkdirSync(dir, { recursive: true });
    writeNodeFiles(dir, meta);
  };
  const frontmatter = (loc: string, meta: Parameters<typeof writeFrontmatterNode>[1]) =>
    writeFrontmatterNode(join(repoRoot(), `${loc}.md`), meta, 'Body.');
  const stored = async (loc: string) =>
    (await db.node.findFirst({ where: { loc, memoryId: dbGraphId }, select: { objectType: true, role: true } }));
  const sync = async () => {
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
  };

  it.each([
    ['frontmatter', frontmatter],
    ['legacy directory', legacy],
  ] as const)('%s: a fresh restore CREATES the node with its objectType', async (_n, write) => {
    write('competitors:acme', { name: 'Acme', objectType: 'competitor' });
    await sync();
    expect((await stored('competitors:acme'))?.objectType).toBe('competitor');
  });

  it.each([
    ['frontmatter', frontmatter],
    ['legacy directory', legacy],
  ] as const)('%s: an ID-FIRST update applies a changed objectType', async (_n, write) => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'a', name: 'A', objectType: 'lead', ownerRepo: 'test/repo' } });
    write('a', { id, name: 'A', objectType: 'customer' });
    await sync();
    expect((await stored('a'))?.objectType).toBe('customer');
  });

  it('a sync-changed objectType is revisioned like any tracked field (#1339 path)', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'h', name: 'H', objectType: 'lead', ownerRepo: 'test/repo' } });
    frontmatter('h', { id, name: 'H', objectType: 'customer' });
    await sync();
    const revs = await db.nodeRevision.findMany({ where: { nodeId: id }, select: { objectType: true, changes: true } });
    expect(revs).toContainEqual(expect.objectContaining({ objectType: 'lead', changes: expect.arrayContaining(['objectType']) }));
  });

  it('an ID-FIRST MOVE carries the objectType to the new loc', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'old', name: 'A', objectType: 'lead', ownerRepo: 'test/repo' } });
    frontmatter('new', { id, name: 'A', objectType: 'customer' });
    await sync();
    expect(await stored('old')).toBeNull();
    expect((await stored('new'))?.objectType).toBe('customer');
  });

  it('a LOC-KEYED update (file id unknown) applies a changed objectType', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: dbGraphId, loc: 'b', name: 'B', objectType: 'lead', ownerRepo: 'test/repo' } });
    frontmatter('b', { name: 'B', objectType: 'customer' }); // writeFrontmatterNode mints a fresh, unknown id
    await sync();
    expect((await stored('b'))?.objectType).toBe('customer');
  });

  // The load-bearing half: every mirrored file written before #725 lacks the key.
  it.each([
    ['omitted', {}],
    ['explicit null', { objectType: null }],
    ['empty string', { objectType: '' }],
    ['whitespace', { objectType: '   ' }],
  ] as const)('a file with objectType %s PRESERVES the stored value on update (both forms)', async (_n, extra) => {
    const idF = generateId();
    const idL = generateId();
    await db.node.create({ data: { id: idF, memoryId: dbGraphId, loc: 'f', name: 'F', objectType: 'insight', ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: idL, memoryId: dbGraphId, loc: 'l', name: 'L', objectType: 'insight', ownerRepo: 'test/repo' } });
    frontmatter('f', { id: idF, name: 'F', ...extra });
    legacy('l', { id: idL, name: 'L', ...extra });
    await sync();
    expect((await stored('f'))?.objectType).toBe('insight');
    expect((await stored('l'))?.objectType).toBe('insight');
  });

  it.each([
    ['omitted', {}],
    ['empty string', { objectType: '' }],
    ['whitespace', { objectType: '   ' }],
  ] as const)('a NEW node whose file has objectType %s gets the unset default', async (_n, extra) => {
    frontmatter('plain', { name: 'Plain', ...extra });
    await sync();
    expect((await stored('plain'))?.objectType).toBeNull();
  });

  it('a non-blank value is written as-is, like CLI import (no trimming)', async () => {
    frontmatter('padded', { name: 'P', objectType: ' competitor ' });
    await sync();
    expect((await stored('padded'))?.objectType).toBe(' competitor ');
  });

  // #725: a structured record must satisfy its collection. Sync restores no
  // properties, so the record is judged with the properties the row already has.
  describe('on a memory with a property schema (@codex P1, PR #1358)', () => {
    const schema = {
      objectTypes: {
        competitor: { fields: { url: { type: 'text', required: true } } },
        note: { fields: { topic: { type: 'text' } } },
      },
    };
    beforeEach(async () => {
      await db.memory.update({ where: { id: dbGraphId }, data: { schema } });
    });
    const syncResult = async () => {
      const result = await syncGraphFromGithub(makeGraph());
      expect(result.error).toBeUndefined();
      return result;
    };

    it('a value whose record conforms IS written — on update and on create', async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'c', name: 'C', objectType: 'note', properties: { url: 'https://x' }, ownerRepo: 'test/repo' } });
      frontmatter('c', { id, name: 'C', objectType: 'competitor' });
      frontmatter('n', { name: 'N', objectType: 'note' });
      const result = await syncResult();
      expect((await stored('c'))?.objectType).toBe('competitor');
      expect((await stored('n'))?.objectType).toBe('note');
      expect(result.skippedObjectTypes).toEqual([]);
    });

    it('an UNDECLARED collection is not written: the stored value is kept and the file is reported', async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'u', name: 'U', objectType: 'note', ownerRepo: 'test/repo' } });
      frontmatter('u', { id, name: 'U-renamed', objectType: 'bogus' });
      const result = await syncResult();
      const row = await db.node.findFirst({ where: { loc: 'u', memoryId: dbGraphId } });
      expect([row?.objectType, row?.name]).toEqual(['note', 'U-renamed']); // the rest of the file still applied
      expect(result.skippedObjectTypes).toEqual([expect.stringMatching(/^u \(bogus\): /)]);
    });

    it('a collection whose REQUIRED field the row lacks is not written — a fresh restore creates the node without it', async () => {
      frontmatter('fresh', { name: 'F', objectType: 'competitor' });
      frontmatter('other', { name: 'O' });
      const result = await syncResult();
      expect((await stored('fresh'))?.objectType).toBeNull();
      expect(await stored('other')).not.toBeNull(); // one bad file never fails the memory's sync
      expect(result.skippedObjectTypes).toEqual([expect.stringMatching(/^fresh \(competitor\): /)]);
    });

    it('judges the properties the row already has (sync restores none): a conforming row takes the collection', async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'l', name: 'L', properties: { url: 'https://y' }, ownerRepo: 'test/repo' } });
      frontmatter('l', { id, name: 'L', objectType: 'competitor' });
      await syncResult();
      expect((await stored('l'))?.objectType).toBe('competitor');
    });
  });

  it('#1218 governed signals are untouched: an objectType-only file keeps a stored role, and a file role still sets it', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'r', name: 'R', role: 'review', ownerRepo: 'test/repo' } });
    frontmatter('r', { id, name: 'R', objectType: 'insight' });
    frontmatter('s', { name: 'S', objectType: 'insight', role: 'review' });
    await sync();
    expect(await stored('r')).toEqual({ objectType: 'insight', role: 'review' });
    expect(await stored('s')).toEqual({ objectType: 'insight', role: 'review' });
  });
});
