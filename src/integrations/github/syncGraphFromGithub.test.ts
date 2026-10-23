import type { Prisma } from '../../generated/prisma/index.js';
import { withIncludeHistoryTransaction, withIncludeHistoryClientTransaction } from '../../lib/includes/includeHistoryFence.js';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { dirname, join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { stringify } from 'yaml';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir, writeFrontmatterNode, writeNodeFiles } from '../../test/helpers.js';
import { splitGitArgv } from '../../test/gitArgv.js';
import { GIT_TRANSPORT_GUARD } from './execGit.js';
import { syncGraphFromGithub, updateNodeFromGitSync, GitSyncTargetMovedError, describeSyncOutcome, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { ensureChannelWithRoot, lockMemoryForChannelChange } from '../../lib/channels.js';
import { generateId } from '../../lib/id.js';
import { setMintedSpecPermanenceEnforcedForTests } from '../../lib/mintedSpecPermanence.js';
import { acquireLockSet, ancestorLocs, lockAncestorsForCreate } from '../../lib/nodeSubtreeLock.js';
import { moveNodeSubtree } from '../../lib/nodeSubtreeMove.js';
import { lockMemoryConfigExclusive } from '../../lib/governedRole.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { buildNodeFrontmatter } from './nodeFrontmatter.js';
import { pendingEdgeStableTargetKey, reconcilePendingEdgeCount } from '../../lib/pendingEdgePromotion.js';
import { writeNodeFile } from './writeNodeToGit.js';
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { mirrorCheckoutLockKey } from './mirrorCheckoutLock.js';
import { Client } from 'pg';
import * as fsLoader from '../localFs/loadGraphFromFs.js';

// ---------------------------------------------------------------------------
// Mock child_process.execFile so no actual git commands run
// ---------------------------------------------------------------------------
let mockDefaultBranch = 'main';
let mockLocalBranchExists = true;
vi.mock('child_process', () => {
  const execFile = vi.fn((...args: unknown[]) => {
    const argv = (args[1] as string[]);
    const cb = args[args.length - 1] as Function;
    if (typeof cb !== 'function') return;
    if (argv.includes('show-ref') && !mockLocalBranchExists) {
      cb(new Error('reference missing'), '', '');
      return;
    }
    cb(null, {
      stdout: argv.includes('ls-remote') ? `ref: refs/heads/${mockDefaultBranch}\tHEAD\n` : '',
      stderr: '',
    });
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
    readBranch: 'main',
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
  mockDefaultBranch = 'main';
  mockLocalBranchExists = true;
  ({ dir: mockSources, cleanup } = makeTmpDir());
  await cleanDb(db);
  // Create org and graph in DB so FK constraints are satisfied
  const { org, graph } = await createDbOrgAndGraph(db, {
    orgName: 'test-org',
    graphName: 'test/repo',
  });
  dbGraphId = graph.id;
  dbOrgId = org.id;
  await db.memory.update({ where: { id: graph.id }, data: { readBranch: 'main' } });
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


describe('syncGraphFromGithub', () => {
  it('refuses an encrypted memory before Git I/O or a Node write', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { isEncrypted: true } });
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toContain('cannot write an encrypted memory');
    expect(await gitCalls()).toHaveLength(0);
    expect(await db.node.count({ where: { memoryId: dbGraphId } })).toBe(0);
  });

  it('refuses a Git sync whose plaintext preflight predates the encryption flip', async () => {
    const filePath = join(mockSources, 'test-org', 'test/repo', 'late-entry');
    mkdirSync(filePath, { recursive: true });
    writeNodeFiles(filePath, { name: 'Late entry' }, 'late Git plaintext');
    const findMemory = db.memory.findUnique.bind(db.memory);
    let reached!: () => void;
    let release!: () => void;
    const atOldFlag = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const lookup = vi.spyOn(db.memory, 'findUnique').mockImplementation((async (args: Parameters<typeof findMemory>[0]) => {
      const row = await findMemory(args);
      if (!held && args?.where?.id === dbGraphId && args.select?.isEncrypted === true) {
        held = true;
        reached();
        await resume;
      }
      return row;
    }) as unknown as typeof db.memory.findUnique);
    try {
      const syncing = syncGraphFromGithub(makeGraph());
      await atOldFlag;
      await db.memory.update({ where: { id: dbGraphId }, data: { isEncrypted: true } });
      release();
      expect((await syncing).error).toContain('cannot write an encrypted memory');
    } finally {
      release();
      lookup.mockRestore();
    }
    expect(await db.node.count({ where: { memoryId: dbGraphId } })).toBe(0);
  });

  it('takes the source path before the Memory fence when a move and Git sync overlap', async () => {
    const source = await db.node.create({
      data: { id: generateId(), memoryId: dbGraphId, loc: 'source', name: 'source' },
    });
    const childDir = join(mockSources, 'test-org', 'test/repo', 'source', 'child');
    mkdirSync(childDir, { recursive: true });
    writeNodeFiles(childDir, { name: 'child' }, 'from Git');

    let signalPathHeld!: () => void;
    let releaseMove!: () => void;
    const pathHeld = new Promise<void>((resolve) => { signalPathHeld = resolve; });
    const mayMove = new Promise<void>((resolve) => { releaseMove = resolve; });
    const moving = withIncludeHistoryClientTransaction(db, async (tx) => {
      await acquireLockSet(tx, [{ memoryId: dbGraphId, loc: 'source' }]);
      signalPathHeld();
      await mayMove;
      return moveNodeSubtree(tx, {
        source, destLoc: 'moved', editor: { info: 'git-sync-lock-order-test' },
      });
    }, { timeout: 20_000 });
    await pathHeld;

    const syncing = syncGraphFromGithub(makeGraph());
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      releaseMove();
    }
    await moving;
    expect((await syncing).error).toBeUndefined();
  }, 20_000);

  it('calls git clone when .git directory does not exist', async () => {
    const result = await syncGraphFromGithub(makeGraph());

    const cloneCall = (await gitCalls()).find((c) => c.args[0] === 'clone');
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.args).toContain('git@github.com:test/repo.git');
    expect(result.error).toBeUndefined();
  });

  it('selects the remote default and fast-forwards it when .git already exists', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null } });
    // Pre-create .git directory so it looks like an existing clone
    const repoPath = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    await syncGraphFromGithub(makeGraph({ readBranch: null }));

    const calls = (await gitCalls()).map((c) => c.args);
    expect(calls).toContainEqual(['ls-remote', '--symref', 'origin', 'HEAD']);
    expect(calls).toContainEqual(['checkout', 'main']);
    expect(calls).toContainEqual(['merge', '--ff-only', 'origin/main']);
    expect(calls.some((c) => c[0] === 'pull')).toBe(false);
  });

  it('selects a custom remote default after a mirror has left the checkout elsewhere', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null } });
    mockDefaultBranch = 'release/v2';
    mockLocalBranchExists = false;
    mkdirSync(join(mockSources, 'test-org', 'test/repo', '.git'), { recursive: true });

    const result = await syncGraphFromGithub(makeGraph({ readBranch: null }));

    expect(result.error).toBeUndefined();
    const calls = (await gitCalls()).map((c) => c.args);
    expect(calls).toContainEqual(['checkout', '-b', 'release/v2', 'origin/release/v2']);
    expect(calls).toContainEqual(['merge', '--ff-only', 'origin/release/v2']);
  });

  it('reads the default branch after a Hadron mirror checks out the write branch', async () => {
    mkdirSync(join(mockSources, 'test-org', 'test/repo', '.git'), { recursive: true });
    await db.memory.update({
      where: { id: dbGraphId },
      data: { source: 'git@github.com:test/repo.git', readBranch: null, writeBranch: 'hadron-qa' },
    });

    expect(await withMirrorCheckout({
      memoryId: dbGraphId,
      commitSubject: 'test write',
      logPrefix: '[test]',
    }, async () => {})).toBe('no-changes');
    const result = await syncGraphFromGithub(makeGraph({ readBranch: null, writeBranch: 'hadron-qa' }));

    expect(result.error).toBeUndefined();
    const calls = (await gitCalls()).map((c) => c.args);
    const writeCheckout = calls.findIndex((c) => c[0] === 'checkout' && c[1] === 'hadron-qa');
    const readCheckout = calls.findIndex((c) => c[0] === 'checkout' && c[1] === 'main');
    expect(writeCheckout).toBeGreaterThan(-1);
    expect(readCheckout).toBeGreaterThan(writeCheckout);
    expect(calls).toContainEqual(['merge', '--ff-only', 'origin/main']);
  });

  it('honors an explicit read branch without querying the remote default', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: 'docs' } });
    mkdirSync(join(mockSources, 'test-org', 'test/repo', '.git'), { recursive: true });

    const result = await syncGraphFromGithub(makeGraph({ readBranch: 'docs' }));

    expect(result.error).toBeUndefined();
    const calls = (await gitCalls()).map((c) => c.args);
    expect(calls).toContainEqual(['checkout', 'docs']);
    expect(calls).toContainEqual(['merge', '--ff-only', 'origin/docs']);
    expect(calls.some((c) => c[0] === 'ls-remote')).toBe(false);
  });

  it('fails closed when the remote default cannot be resolved', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null } });
    mockDefaultBranch = '';
    mkdirSync(join(mockSources, 'test-org', 'test/repo', '.git'), { recursive: true });

    const result = await syncGraphFromGithub(makeGraph({ readBranch: null }));

    expect(result.error).toContain('could not resolve the remote default branch');
    const calls = (await gitCalls()).map((c) => c.args);
    expect(calls.some((c) => c[0] === 'checkout' || c[0] === 'merge')).toBe(false);
  });

  it('holds nodes adopted by an old write-branch sync until an explicit Read branch is reviewed', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: 'hadron-qa' } });
    const repoPath = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    const hadronId = generateId();
    await db.node.create({
      data: { id: hadronId, memoryId: dbGraphId, loc: 'hadron-note', name: 'Hadron note' },
    });
    const writeOnlyPath = join(repoPath, 'hadron-note');
    writeNodeFiles(writeOnlyPath, { id: hadronId, name: 'Hadron note' }, 'from Hadron');
    // Reproduce the persisted state of an earlier wrong-branch sync: the
    // Hadron-created node was imported from the write branch as repo-owned.
    expect((await syncGraphFromGithub(makeGraph({ readBranch: 'hadron-qa' }))).error).toBeUndefined();
    expect((await db.node.findUniqueOrThrow({ where: { id: hadronId } })).ownerRepo).toBe('test/repo');

    rmSync(writeOnlyPath, { recursive: true, force: true });
    writeNodeFiles(join(repoPath, 'main-change'), { name: 'Main change' }, 'from main');
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null, readBranchCorrected: false } });
    const first = await syncGraphFromGithub(makeGraph({ readBranch: null }));
    expect(first.error).toContain('GIT_SYNC_REVIEW_REQUIRED');
    expect(first.error).toContain('hadron-note');
    expect(await db.node.findUnique({ where: { id: hadronId } })).toMatchObject({ deletedAt: null, ownerRepo: 'test/repo' });
    // The warning aborts the whole sync under cor:int:010:01; no partial
    // upsert may commit beside a held deletion.
    expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'main-change' } })).toBeNull();
    expect(await db.memory.findUnique({ where: { id: dbGraphId } })).toMatchObject({
      syncStatus: 'ERROR', syncError: expect.stringContaining('GIT_SYNC_REVIEW_REQUIRED'), readBranchCorrected: false,
    });

    // A later boot/webhook still cannot prune it without human review.
    expect((await syncGraphFromGithub(makeGraph({ readBranch: null }))).error).toContain('GIT_SYNC_REVIEW_REQUIRED');
    expect(await db.node.findUnique({ where: { id: hadronId } })).not.toBeNull();
    expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'main-change' } })).toBeNull();

    // Explicit Read branch is the post-review path for normal repo-wins cleanup.
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: 'main' } });
    expect((await syncGraphFromGithub(makeGraph({ readBranch: 'main' }))).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: hadronId } })).toBeNull();
    expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'main-change' } })).not.toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } })).readBranchCorrected).toBe(true);
  });

  it('marks a clean first corrected sync, then permits later default-branch deletions', async () => {
    // New and pre-fix rows both begin pending; a clean first sync releases
    // normal repo-wins cleanup without an operator round-trip.
    expect((await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } })).readBranchCorrected).toBe(false);
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null } });
    const repoPath = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    const nodePath = join(repoPath, 'ordinary');
    writeNodeFiles(nodePath, { name: 'Ordinary' }, 'from main');

    expect((await syncGraphFromGithub(makeGraph({ readBranch: null }))).error).toBeUndefined();
    expect((await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } })).readBranchCorrected).toBe(true);
    rmSync(nodePath, { recursive: true, force: true });
    expect((await syncGraphFromGithub(makeGraph({ readBranch: null }))).error).toBeUndefined();
    expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'ordinary' } })).toBeNull();
  });

  it('keeps the first-sync guard pending when an unusable file suppresses cleanup', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null } });
    const repoPath = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    const adoptedId = generateId();
    await db.node.create({ data: {
      id: adoptedId, memoryId: dbGraphId, loc: 'adopted-on-write', name: 'Adopted', ownerRepo: 'test/repo',
    } });
    const unusableFile = join(repoPath, 'no-id--> evil.md');
    writeFileSync(unusableFile, '---\nname: unusable\n---\n# unusable', 'utf-8');

    expect((await syncGraphFromGithub(makeGraph({ readBranch: null }))).error).toBeUndefined();
    expect((await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } })).readBranchCorrected).toBe(false);
    rmSync(unusableFile);
    expect((await syncGraphFromGithub(makeGraph({ readBranch: null }))).error).toContain('GIT_SYNC_REVIEW_REQUIRED');
    expect(await db.node.findUnique({ where: { id: adoptedId } })).not.toBeNull();
  });

  it('waits for the mirror checkout lock before any Git or filesystem read', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null } });
    const external = new Client({ connectionString: process.env.DATABASE_URL });
    await external.connect();
    const key = mirrorCheckoutLockKey(dbGraphId);
    await external.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    let syncing: ReturnType<typeof syncGraphFromGithub> | undefined;
    try {
      syncing = syncGraphFromGithub(makeGraph({ readBranch: null }));
      await waitForLockWaitersOfType(db, 'advisory', 1, 2_000);
      expect(await gitCalls()).toHaveLength(0);
    } finally {
      await external.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      await external.end();
    }
    expect((await syncing).error).toBeUndefined();
    expect((await gitCalls()).some((c) => c.args[0] === 'clone')).toBe(true);
  }, 15_000);

  it('keeps the checkout lock until filesystem loading completes', async () => {
    let signalLoadEntered!: () => void;
    let releaseLoad!: () => void;
    const loadEntered = new Promise<void>((resolve) => { signalLoadEntered = resolve; });
    const mayFinishLoad = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const realLoad = fsLoader.loadGraphFromFs;
    const loader = vi.spyOn(fsLoader, 'loadGraphFromFs').mockImplementation(async (...args) => {
      signalLoadEntered();
      await mayFinishLoad;
      return realLoad(...args);
    });
    let syncing: ReturnType<typeof syncGraphFromGithub> | undefined;
    const keyBits = BigInt.asUintN(64, BigInt(mirrorCheckoutLockKey(dbGraphId)));
    const classId = Number(keyBits >> 32n);
    const objectId = Number(keyBits & 0xffffffffn);
    try {
      syncing = syncGraphFromGithub(makeGraph());
      await loadEntered;
      const [{ held }] = await db.$queryRaw<Array<{ held: number }>>`
        SELECT count(*)::int AS held FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND classid = ${classId}::oid AND objid = ${objectId}::oid
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      expect(held).toBe(1);
    } finally {
      releaseLoad();
      await Promise.allSettled([syncing]);
      loader.mockRestore();
    }
    expect((await syncing).error).toBeUndefined();
  }, 15_000);

  it('refuses cleanup when Read branch config changes during sync', async () => {
    const node = await db.node.create({
      data: { id: generateId(), memoryId: dbGraphId, loc: 'missing', name: 'Missing', ownerRepo: 'test/repo' },
    });
    // The caller fetched `main`, then an admin cleared Read branch before the
    // transactional fence. The tree loaded under the old config cannot prune.
    await db.memory.update({ where: { id: dbGraphId }, data: { readBranch: null } });

    const result = await syncGraphFromGithub(makeGraph({ readBranch: 'main' }));

    expect(result.error).toContain('Read branch changed while syncing');
    expect(await db.node.findUnique({ where: { id: node.id } })).not.toBeNull();
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
    expect(result.error).toBe('Git command failed. Check the repository and branch, then retry.');
    expect((await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } })).syncError).toBe(result.error);
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

  it('reports a missing name without exposing a server path or changing nodes', async () => {
    const repo = join(mockSources, 'test-org', 'test/repo');
    const glossary = join(repo, 'glossary');
    mkdirSync(glossary, { recursive: true });
    const file = join(glossary, 'noname.md');
    const keptId = 'aaaa1567000000000000000000000001';
    writeFileSync(file, `---\nid: ${keptId}\nname: Existing\n---\nOld body`);
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();

    writeFileSync(file, `---\nid: ${keptId}\ndescription: no name here\n---\nNew body`);
    writeFileSync(join(repo, 'new.md'), '---\nname: New\n---\nNew node');
    const result = await syncGraphFromGithub(makeGraph());

    expect(result).toMatchObject({
      error: 'Git sync cannot import "glossary/noname.md": name must be a non-empty string.',
      errorCode: 'BAD_USER_INPUT',
    });
    expect(result.error).not.toContain(mockSources);
    expect(await db.node.findUniqueOrThrow({ where: { id: keptId } }))
      .toMatchObject({ name: 'Existing', content: 'Old body' });
    expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'new' } })).toBeNull();
    expect(await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } }))
      .toMatchObject({ syncStatus: 'ERROR', syncError: result.error });
  });

  describe('#1568: an unreadable file never silently deletes the node it holds', () => {
    const repo = () => join(mockSources, 'test-org', 'test/repo');
    const id = (n: number) => `aaaa15680000000000000000000000${String(n).padStart(2, '0')}`;

    /** Sync once so the node exists, then break the file and add a new node in the same push. */
    async function breakAfterSync(rel: string, nodeId: string, broken: string) {
      const file = join(repo(), rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `---\nid: ${nodeId}\nname: Existing\n---\nOld body`);
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      writeFileSync(file, broken);
      writeFileSync(join(repo(), 'new.md'), '---\nname: New\n---\nNew node');
      return syncGraphFromGithub(makeGraph());
    }

    async function expectRefusedAndUntouched(result: Awaited<ReturnType<typeof syncGraphFromGithub>>, rel: string, nodeId: string) {
      expect(result.errorCode).toBe('BAD_USER_INPUT');
      expect(result.error).toContain(JSON.stringify(rel));
      expect(result.error).toContain('nothing was written');
      expect(result.error).not.toContain(mockSources);
      expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } }))
        .toMatchObject({ name: 'Existing', content: 'Old body', deletedAt: null });
      expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'new' } })).toBeNull();
      expect(await db.memory.findUniqueOrThrow({ where: { id: dbGraphId } }))
        .toMatchObject({ syncStatus: 'ERROR', syncError: result.error });
    }

    it('broken YAML on a node that has an id: refused, node kept, nothing written', async () => {
      const result = await breakAfterSync('glossary/stage.md', id(1), `---\nid: ${id(1)}\nname: [broken\n---\nNew body`);
      await expectRefusedAndUntouched(result, 'glossary/stage.md', id(1));
    });

    it('frontmatter removed: refused, node kept', async () => {
      const result = await breakAfterSync('decisions/retention-policy.md', id(2), 'Just a body, no frontmatter');
      await expectRefusedAndUntouched(result, 'decisions/retention-policy.md', id(2));
    });

    it('the root README broken: refused, the addressable #1228 root node kept', async () => {
      await db.memory.update({ where: { id: dbGraphId }, data: { urn: 'test-org:root-memory' } });
      const target = makeGraph({ urn: 'test-org:root-memory' });
      const dir = join(mockSources, 'test-org', 'root-memory');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'README.md');
      writeFileSync(file, `---\nid: ${id(3)}\nname: Existing\n---\nOld body`);
      expect((await syncGraphFromGithub(target)).error).toBeUndefined();
      writeFileSync(file, `---\nname: [broken\n---\nRoot`);
      writeFileSync(join(dir, 'new.md'), '---\nname: New\n---\nNew node');
      await expectRefusedAndUntouched(await syncGraphFromGithub(target), 'README.md', id(3));
    });

    it('CONTROL: an unreadable file with no node at its path is skipped, and the rest syncs', async () => {
      mkdirSync(repo(), { recursive: true });
      writeFileSync(join(repo(), 'stray.md'), 'A plain document with no frontmatter');
      writeFileSync(join(repo(), 'real.md'), '---\nname: Real\n---\nBody');
      const result = await syncGraphFromGithub(makeGraph());
      expect(result.error).toBeUndefined();
      expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'real' } })).not.toBeNull();
      expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'stray' } })).toBeNull();
    });

    it('CONTROL: deleting the file from the repo still deletes its node (repo-wins unchanged)', async () => {
      mkdirSync(repo(), { recursive: true });
      const file = join(repo(), 'gone.md');
      writeFileSync(file, `---\nid: ${id(4)}\nname: Gone\n---\nBody`);
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      rmSync(file);
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      expect(await db.node.findUnique({ where: { id: id(4) } })).toBeNull();
    });

    it('a row that appears at an unreadable path AFTER the refusal check is not deleted by cleanup (Codex P1 / Copilot)', async () => {
      // A stray, unreadable file with no node at its path: the check passes and
      // the sync proceeds. Then a concurrent writer puts a row at that path
      // (simulated right after the check's query, through another connection).
      mkdirSync(repo(), { recursive: true });
      writeFileSync(join(repo(), 'anchor.md'), '---\nname: Anchor\n---\nBody');
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      const ownerRepo = (await db.node.findFirstOrThrow({ where: { memoryId: dbGraphId, loc: 'anchor' } })).ownerRepo;
      writeFileSync(join(repo(), 'stray.md'), 'no frontmatter here');

      const lateId = id(9);
      const realTransaction = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
      const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: unknown, opts?: unknown) => {
        if (typeof fn !== 'function') return realTransaction(fn, opts);
        return realTransaction(async (tx: { node: { findMany: (a: unknown) => Promise<unknown> } }) => {
          const findMany = tx.node.findMany.bind(tx.node);
          let injected = false;
          tx.node.findMany = async (args: unknown) => {
            const out = await findMany(args);
            const where = (args as { where?: { loc?: { in?: string[] } } })?.where;
            if (!injected && where?.loc?.in?.includes('stray')) {
              injected = true;
              await db.node.create({ data: {
                id: lateId, memoryId: dbGraphId, loc: 'stray', name: 'Late', content: 'written concurrently', ownerRepo,
              } });
            }
            return out;
          };
          return (fn as (tx: unknown) => Promise<unknown>)(tx);
        }, opts);
      }) as never);
      try {
        expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect(await db.node.findUnique({ where: { id: lateId } })).toMatchObject({ loc: 'stray', deletedAt: null });
    });

    it('fixing the file lets the next sync apply it', async () => {
      const result = await breakAfterSync('glossary/fixed.md', id(5), `---\nid: ${id(5)}\nname: [broken\n---\nNew body`);
      expect(result.errorCode).toBe('BAD_USER_INPUT');
      writeFileSync(join(repo(), 'glossary/fixed.md'), `---\nid: ${id(5)}\nname: Fixed\n---\nNew body`);
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      expect(await db.node.findUniqueOrThrow({ where: { id: id(5) } })).toMatchObject({ name: 'Fixed', content: 'New body' });
    });
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

  it('runs as the system inside a worker request: node and revision both name no worker or agent (#1658 review)', async () => {
    const { runAsActor } = await import('../../lib/requestActor.js');
    const actor = { workerId: 'w-requester', agentId: 'a-requester' };
    const nodeId = 'aaaa000000000000000000000000001658';
    const dir = join(mockSources, 'test-org', 'test/repo', 'nodeAttr');
    mkdirSync(dir, { recursive: true });
    writeNodeFiles(dir, { id: nodeId, name: 'nodeAttr', description: 'v1' });
    expect((await runAsActor(actor, () => syncGraphFromGithub(makeGraph()))).error).toBeUndefined();
    writeNodeFiles(dir, { id: nodeId, name: 'nodeAttr', description: 'v2' });
    expect((await runAsActor(actor, () => syncGraphFromGithub(makeGraph()))).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({
      where: { id: nodeId },
      select: { createdByWorkerId: true, createdByAgentId: true, updatedByWorkerId: true, updatedByAgentId: true },
    })).toEqual({ createdByWorkerId: null, createdByAgentId: null, updatedByWorkerId: null, updatedByAgentId: null });
    const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId }, orderBy: { revNo: 'desc' } });
    expect(revision).toMatchObject({ editedByInfo: 'system:github-sync', editedByWorkerId: null, editedByAgentId: null });
  });

  it('refuses to apply a sync update to a row that has left the synced memory (#1339 review)', async () => {
    // @copilot: the row lock must re-validate ownership — a concurrent
    // cross-memory move between the preflight lookup and the lock would
    // otherwise have the repo's update rewrite a FOREIGN memory's node.
    const nodeId = 'aaaa000000000000000000000000001340';
    const row = await db.node.create({ data: { id: nodeId, memoryId: dbGraphId, loc: 'moved:away', name: 'n', content: 'mine' } });
    await expect(
      withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, row, { content: 'from git' }, undefined, 'some-other-memory')),
    ).rejects.toBeInstanceOf(GitSyncTargetMovedError);
    const after = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(after.content).toBe('mine');
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
  });

  it('carries attribution through a path move but clears it when Git rewrites content', async () => {
    const task = await db.node.create({
      data: { id: generateId(), memoryId: dbGraphId, loc: 'author-task', name: 'Author task', nodeType: 'task' },
    });
    const authoredAt = new Date('2026-09-26T20:00:00Z');
    const original = await db.node.create({
      data: {
        id: generateId(), memoryId: dbGraphId, loc: 'old-path', name: 'Authored', content: 'old body',
        authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 1, authoredAt,
      },
    });
    await withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, original, { loc: 'new-path' }, undefined, dbGraphId));
    const moved = await db.node.findUniqueOrThrow({ where: { id: original.id } });
    expect(moved).toMatchObject({
      loc: 'new-path', authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 1, authoredAt,
    });

    await withIncludeHistoryClientTransaction(db, (tx) => updateNodeFromGitSync(tx, moved, { content: 'new body' }, undefined, dbGraphId));
    expect(await db.node.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      content: 'new body', authorshipKind: null, authoredByTask: null,
      authoredByRevision: null, authoredAt: null,
    });
    const history = await db.nodeRevision.findMany({ where: { nodeId: original.id }, orderBy: { revNo: 'asc' } });
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      content: 'old body', authorshipKind: 'TASK', authoredByTask: task.id,
      authoredByRevision: 1, authoredAt,
    });
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

    // An unchanged repo edge is an idempotent re-sync, not a collision.
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.edge.findMany()).toMatchObject([{ id: edges[0].id }]);

    // Git's edge exporter omits runnable: false; absent and false mean the same thing.
    await db.edge.update({ where: { id: edges[0].id }, data: { isRunnable: false } });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
  });

  it('refuses a repo edge when its derived loc belongs to another live edge', async () => {
    const bId = generateId();
    const tId = generateId();
    const bDir = join(mockSources, 'test-org', 'test/repo', 'b');
    const tDir = join(mockSources, 'test-org', 'test/repo', 't');
    mkdirSync(bDir, { recursive: true });
    mkdirSync(tDir, { recursive: true });
    writeNodeFiles(bDir, { id: bId, name: 'before' });
    writeNodeFiles(tDir, { id: tId, name: 'target' });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();

    const a = await db.node.create({
      data: { id: generateId(), memoryId: dbGraphId, loc: 'a', name: 'unrelated' },
    });
    const occupied = await db.edge.create({
      data: {
        id: generateId(), memoryId: dbGraphId, sourceId: a.id, targetId: tId,
        loc: deriveEdgeLoc('b', 'uses', 't'), name: 'unrelated',
      },
    });

    // Put the non-colliding edge first so its insert also has to roll back.
    writeNodeFiles(bDir, {
      id: bId, name: 'after',
      nodes: [{ id: tId, rel: 'control' }, { id: tId, rel: 'uses' }],
    });
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toContain('already occupied');
    expect(await db.node.findUniqueOrThrow({ where: { id: bId } })).toMatchObject({ name: 'before' });
    expect(await db.edge.findUniqueOrThrow({ where: { id: occupied.id } })).toMatchObject({
      sourceId: a.id, targetId: tId, name: 'unrelated', deletedAt: null,
    });
    expect(await db.edge.count({ where: { sourceId: bId, targetId: tId } })).toBe(0);
    expect(await db.pendingEdge.count({ where: { sourceId: bId, targetId: tId } })).toBe(0);
  });

  it.each([
    ['data', { data: { edited: true } }],
    ['empty description', { description: '' }],
    ['priority', { priority: 1 }],
  ] as const)('keeps %s-only edge drift without blocking repeated syncs', async (_field, edit) => {
    const tId = generateId();
    const aDir = join(mockSources, 'test-org', 'test/repo', 'a');
    const tDir = join(mockSources, 'test-org', 'test/repo', 't');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(tDir, { recursive: true });
    writeNodeFiles(aDir, { name: 'a', nodes: [{ id: tId, rel: 'uses' }] });
    writeNodeFiles(tDir, { id: tId, name: 't' });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();

    const edge = await db.edge.findFirstOrThrow();
    await db.edge.update({ where: { id: edge.id }, data: edit });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).toMatchObject(edit);
  });

  it('persists a declared condition and priority and accepts an exact re-sync', async () => {
    const aId = generateId();
    const tId = generateId();
    const condition = { '==': [{ var: 'agent.role' }, 'mentor'] };
    const aDir = join(mockSources, 'test-org', 'test/repo', 'a');
    const tDir = join(mockSources, 'test-org', 'test/repo', 't');
    mkdirSync(aDir, { recursive: true });
    mkdirSync(tDir, { recursive: true });
    writeNodeFiles(aDir, { id: aId, name: 'a' });
    writeFileSync(join(aDir, '.node', 'node.yaml'), stringify({
      id: aId, name: 'a', nodes: [{ id: tId, rel: 'gated', condition, priority: 7 }],
    }));
    writeNodeFiles(tDir, { id: tId, name: 't' });

    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    const edge = await db.edge.findFirstOrThrow();
    expect(edge).toMatchObject({ condition, priority: 7 });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).toMatchObject({ condition, priority: 7 });
  });

  it('restores edge data and an empty description from an exported file into a fresh memory', async () => {
    const sourceId = generateId();
    const targetId = generateId();
    const root = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(root, { recursive: true });
    const source = buildNodeFrontmatter({ id: sourceId, name: 'Source', tags: [] }, [
      { target: { id: targetId, loc: 'target' }, name: 'uses', description: '', data: { weight: 3 } },
    ]);
    const target = buildNodeFrontmatter({ id: targetId, name: 'Target', tags: [] });
    writeFileSync(join(root, 'source.md'), `---\n${stringify(source, { lineWidth: 0 }).trim()}\n---\n`, 'utf-8');
    writeFileSync(join(root, 'target.md'), `---\n${stringify(target, { lineWidth: 0 }).trim()}\n---\n`, 'utf-8');

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(await db.edge.findFirstOrThrow({ where: { sourceId, targetId } })).toMatchObject({
      description: '',
      data: { weight: 3 },
    });
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
    expect(pending[0]).toMatchObject({ description: null, data: null });
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

  it('preserves edge data and an empty description when the target arrives after the source sync', async () => {
    const sourceId = generateId();
    const targetId = generateId();
    const root = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(root, { recursive: true });
    const source = buildNodeFrontmatter({ id: sourceId, name: 'Source', tags: [] }, [
      { target: { id: targetId, loc: 'target' }, name: 'uses', description: '', data: { weight: 3 } },
    ]);
    writeFileSync(join(root, 'source.md'), `---\n${stringify(source, { lineWidth: 0 }).trim()}\n---\n`, 'utf-8');

    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.pendingEdge.findUniqueOrThrow({
      where: { sourceId_targetId: { sourceId, targetId } },
    })).toMatchObject({ description: '', data: { weight: 3 } });
    expect(await db.edge.count({ where: { sourceId, targetId } })).toBe(0);

    const target = buildNodeFrontmatter({ id: targetId, name: 'Target', tags: [] });
    writeFileSync(join(root, 'target.md'), `---\n${stringify(target, { lineWidth: 0 }).trim()}\n---\n`, 'utf-8');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.pendingEdge.count({ where: { sourceId, targetId, deletedAt: null } })).toBe(0);
    expect(await db.edge.findFirstOrThrow({ where: { sourceId, targetId } })).toMatchObject({
      description: '',
      data: { weight: 3 },
    });
  });

  it('uses current Git metadata when an older pending edge and its target resolve in the same sync', async () => {
    const sourceId = generateId();
    const targetId = generateId();
    const root = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(root, { recursive: true });
    const writeSource = (description?: string, data?: unknown) => {
      const source = buildNodeFrontmatter({ id: sourceId, name: 'Source', tags: [] }, [
        { target: { id: targetId, loc: 'target' }, name: 'uses', description, data },
      ]);
      writeFileSync(join(root, 'source.md'), `---\n${stringify(source, { lineWidth: 0 }).trim()}\n---\n`, 'utf-8');
    };

    writeSource();
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.pendingEdge.findUniqueOrThrow({
      where: { sourceId_targetId: { sourceId, targetId } },
    })).toMatchObject({ description: null, data: null });

    writeSource('', { weight: 3 });
    const target = buildNodeFrontmatter({ id: targetId, name: 'Target', tags: [] });
    writeFileSync(join(root, 'target.md'), `---\n${stringify(target, { lineWidth: 0 }).trim()}\n---\n`, 'utf-8');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.edge.findFirstOrThrow({ where: { sourceId, targetId } })).toMatchObject({
      description: '', data: { weight: 3 },
    });
  });

  it('refreshes a parked edge from the latest Git file, including cleared metadata', async () => {
    const sourceId = generateId();
    const targetId = generateId();
    const root = join(mockSources, 'test-org', 'test/repo');
    mkdirSync(root, { recursive: true });
    const writeSource = (description?: string, data?: unknown) => {
      const source = buildNodeFrontmatter({ id: sourceId, name: 'Source', tags: [] }, [
        { target: { id: targetId, loc: 'target' }, name: 'uses', description, data },
      ]);
      writeFileSync(join(root, 'source.md'), `---\n${stringify(source, { lineWidth: 0 }).trim()}\n---\n`, 'utf-8');
    };
    const pending = () => db.pendingEdge.findUniqueOrThrow({
      where: { sourceId_targetId: { sourceId, targetId } },
    });

    writeSource('', { weight: 3 });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await pending()).toMatchObject({ description: '', data: { weight: 3 } });

    writeSource('revised', { weight: 4 });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await pending()).toMatchObject({ description: 'revised', data: { weight: 4 } });

    writeSource();
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await pending()).toMatchObject({ description: null, data: null });
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
      data: {
        id: generateId(), sourceId: source.id, targetId, name: 'cross-memory',
        description: '', data: { weight: 3 },
      },
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
    })).toMatchObject({ description: '', data: { weight: 3 } });
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
      data: {
        id: generateId(), sourceId: source.id, targetId, name: 'cross-memory',
        description: '', data: { weight: 3 },
      },
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
    expect(await db.pendingEdge.findUnique({ where: { id: pending.id } })).toMatchObject({
      description: '', data: { weight: 3 },
    });
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
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      const moving = withIncludeHistoryClientTransaction(db, async (tx) => {
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
      await waitForLockWaitersOfType(db, 'advisory', 1);
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

  /** #1411 review (@codex P2; Charles QA V3/V5/V7): an edge aimed at a mover whose move is skipped waits for the move. */
  const edgeTo = (id: string) => {
    mkdirSync(join(repoRoot(), 'g'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id, rel: 'uses' }] });
  };
  const edgesTo = (id: string) => db.edge.findMany({ where: { targetId: id, deletedAt: null }, select: { loc: true } });

  it('V3: a move blocked by a Channel at its SOURCE loc — an edge aimed at the mover waits', async () => {
    await ensureChannelWithRoot(db, { memoryId: dbGraphId, loc: 'chats:live', name: 'live', createdBy: null });
    const moverId = generateId();
    await db.node.create({ data: { id: moverId, memoryId: dbGraphId, loc: 'chats:live:messages:m', name: 'M', ownerRepo: 'test/repo' } });
    writeMd('moved', moverId, 'M');
    edgeTo(moverId);
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(result.skippedProtected).toContain('chats:live:messages:m → moved');
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'chats:live:messages:m' });
    expect(await edgesTo(moverId)).toEqual([]);
  });

  it('V5: a move refused because its occupant\'s file has an invalid path — an edge aimed at the mover waits', async () => {
    const occupantId = 'eeee000000000000000000000000000031';
    const moverId = 'eeee000000000000000000000000000032';
    writeMd('a', occupantId, 'occupant');
    writeMd('b', moverId, 'mover');
    await syncGraphFromGithub(makeGraph());
    rmSync(join(repoRoot(), 'a.md'));
    rmSync(join(repoRoot(), 'b.md'));
    writeMd('a--> evil', occupantId, 'occupant');
    writeMd('a', moverId, 'mover');
    edgeTo(moverId);
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'b' });
    expect(await edgesTo(moverId)).toEqual([]);
  });

  it('V7: a move HELD behind an unsettleable occupant — its incoming edge waits, then lands once under the new loc', async () => {
    const occupantId = 'eeee000000000000000000000000000041';
    const moverId = 'eeee000000000000000000000000000042';
    writeMd('a', occupantId, 'occupant');
    writeMd('b', moverId, 'mover');
    await syncGraphFromGithub(makeGraph());
    rmSync(join(repoRoot(), 'a.md'));
    rmSync(join(repoRoot(), 'b.md'));
    writeMd('a', moverId, 'mover');
    writeFileSync(join(repoRoot(), 'no-id--> evil.md'), `---\nname: no id here\n---\n# x`, 'utf-8');
    edgeTo(moverId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const held = await syncGraphFromGithub(makeGraph());
    warn.mockRestore();
    expect(held.heldMoves).toEqual([`b → a (occupant ${occupantId})`]);
    expect(await edgesTo(moverId)).toEqual([]);
    rmSync(join(repoRoot(), 'no-id--> evil.md'));
    await syncGraphFromGithub(makeGraph());
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'a' });
    const edges = await edgesTo(moverId);
    expect(edges).toHaveLength(1);
  });

  it('a suppressed cleanup cannot leave a parked occupant behind: the move that displaced it is held (#1411 review)', async () => {
    // The parking step relies on the cleanup to collect an occupant whose file
    // is gone. When the cleanup is suppressed, that occupant would commit at
    // `<loc>~displaced-<id>`.
    const occupantId = 'eeee000000000000000000000000000021';
    const moverId = 'eeee000000000000000000000000000022';
    writeMd('a', occupantId, 'occupant');
    writeMd('b', moverId, 'mover');
    await syncGraphFromGithub(makeGraph());

    rmSync(join(repoRoot(), 'a.md'));
    rmSync(join(repoRoot(), 'b.md'));
    writeMd('a', moverId, 'mover');
    writeFileSync(join(repoRoot(), 'no-id--> evil.md'), `---\nname: no id here\n---\n# x`, 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await syncGraphFromGithub(makeGraph());
    warn.mockRestore();
    expect(result.error).toBeUndefined();
    expect(result.heldMoves).toEqual([`b → a (occupant ${occupantId})`]);
    const rows = await db.node.findMany({ where: { memoryId: dbGraphId }, select: { id: true, loc: true } });
    expect(rows.filter((r) => r.loc.includes('~'))).toEqual([]);
    expect(rows.find((r) => r.id === occupantId)?.loc).toBe('a');
    expect(rows.find((r) => r.id === moverId)?.loc).toBe('b');

    // Once the bad file is fixed the cleanup runs, and the move lands.
    rmSync(join(repoRoot(), 'no-id--> evil.md'));
    const next = await syncGraphFromGithub(makeGraph());
    expect(next.heldMoves).toEqual([]);
    expect(await db.node.findUnique({ where: { id: occupantId } })).toBeNull();
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'a' });
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

// ── #280 / PR #1432 review P1: a malformed root must not delete its row ─────
// The loader refuses a file whose YAML fails to parse, is empty, or is a
// primitive. Those shapes already failed before #280. Every other object root,
// including an array and a tagged Set/Map/Buffer, still loads as a partial node
// (no id, no name). This pins the consequence that matters: sync updates the
// existing git-owned row in place rather than dropping the file and letting the
// repo-wins cleanup pass hard-delete the row. A mapping-only check in the
// loader fails this test.
describe('a malformed YAML root keeps its mirrored row (#280)', () => {
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');

  it.each([
    ['an array', '- id: x\n- name: y'],
    ['a !!set', '!!set {a: null}'],
    ['a !!omap', '!!omap [a: 1]'],
  ])('an existing node whose frontmatter becomes %s survives the next sync', async (_label, yamlBody) => {
    const nodeId = 'eeee280000000000000000000000000001';
    const full = join(repoRoot(), 'kept.md');
    mkdirSync(repoRoot(), { recursive: true });
    writeFileSync(full, `---\nid: ${nodeId}\nname: Kept\n---\n# Kept`, 'utf-8');
    await syncGraphFromGithub(makeGraph());
    expect(await db.node.findUnique({ where: { id: nodeId } })).not.toBeNull();

    // Only the YAML root changes. The path, and so the loc, stays the same.
    writeFileSync(full, `---\n${yamlBody}\n---\n# Kept`, 'utf-8');

    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();

    const row = await db.node.findUnique({ where: { id: nodeId } });
    expect(row).not.toBeNull();
    expect(row!.loc).toBe('kept');
    // An absent name is omitted from the update, so the stored one is kept.
    expect(row!.name).toBe('Kept');
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

  // #1219 (cor:dmo:060:02, ruling A): an empty or whitespace file role is the
  // same as no role → null — on create (never stored as "") and on update
  // (clears, like the file's explicit `role: null` clear — role's file codec
  // HAS a clear form, unlike objectType's never-clear contract, cor:int:020:01).
  it('#1219 an empty or whitespace file role stores null, and clears a stored role on update', async () => {
    frontmatter('blank-role', { name: 'Blank role', role: '' });
    frontmatter('ws-role', { name: 'Ws role', role: '   ' });
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'clr-role', name: 'Clr', role: 'anchor', ownerRepo: 'test/repo' } });
    frontmatter('clr-role', { id, name: 'Clr', role: '' });
    await sync();
    expect((await stored('blank-role'))?.role).toBeNull();
    expect((await stored('ws-role'))?.role).toBeNull();
    expect((await stored('clr-role'))?.role).toBeNull();
  });
});

describe('#1330 — strict sub-roles through git sync', () => {
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');
  const frontmatter = (loc: string, meta: Parameters<typeof writeFrontmatterNode>[1], body = 'Body.') =>
    writeFrontmatterNode(join(repoRoot(), `${loc}.md`), meta, body);
  const stored = (loc: string) =>
    db.node.findFirst({ where: { loc, memoryId: dbGraphId }, select: { id: true, role: true, content: true } });
  const rules = async (...rs: Array<{ role: string; strictSubRoles?: boolean }>) => {
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: dbGraphId } });
    for (const r of rs) await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, ...r } });
  };
  const sync = async () => {
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    return result;
  };

  it('a file creating an undeclared sub-role is skipped and reported; the rest of the memory syncs', async () => {
    await rules({ role: 'doc', strictSubRoles: true }, { role: 'doc.guide' });
    frontmatter('bad', { name: 'Bad', role: 'doc.unknown' });
    frontmatter('guide', { name: 'Guide', role: 'doc.guide' });
    frontmatter('parent', { name: 'Parent', role: 'doc' });
    frontmatter('other', { name: 'Other', role: 'notes.anything' });
    frontmatter('plain', { name: 'Plain' });
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([
      { loc: 'bad', role: 'doc.unknown', strictParent: 'doc', code: 'ROLE_NOT_DECLARED' },
    ]);
    expect(await stored('bad')).toBeNull();
    for (const loc of ['guide', 'parent', 'other', 'plain']) expect(await stored(loc)).not.toBeNull();
    expect(result.writtenNodes!.map((n) => n.loc).sort()).toEqual(['guide', 'other', 'parent', 'plain']);
  });

  it('a file ASSIGNING an undeclared role to an existing row leaves that row exactly as it was, and the cleanup keeps it', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'a', name: 'A', content: 'old', role: 'doc.legacy', ownerRepo: 'test/repo' } });
    await rules({ role: 'doc', strictSubRoles: true });
    frontmatter('a', { id, name: 'A', role: 'doc.other' }, 'new');
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'a', role: 'doc.other', strictParent: 'doc' })]);
    expect(await stored('a')).toEqual({ id, role: 'doc.legacy', content: 'old' });
  });

  it('the same refusal on the LOC-KEYED path (file id unknown to this memory)', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'a', name: 'A', content: 'old', role: 'doc.legacy', ownerRepo: 'test/repo' } });
    await rules({ role: 'doc', strictSubRoles: true });
    frontmatter('a', { name: 'A', role: 'doc.other' }, 'new');
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toHaveLength(1);
    expect(await stored('a')).toEqual({ id, role: 'doc.legacy', content: 'old' });
  });

  it('an ID-FIRST MOVE that assigns an undeclared role does not move the node', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'old', name: 'N', content: 'x', ownerRepo: 'test/repo' } });
    await rules({ role: 'doc', strictSubRoles: true });
    frontmatter('new', { id, name: 'N', role: 'doc.unknown' });
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'new' })]);
    expect(await db.node.findUniqueOrThrow({ where: { id } })).toMatchObject({ loc: 'old', role: null });
  });

  it('no retroactive effect: a file keeping a now-undeclared role still syncs its other changes', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'a', name: 'A', content: 'old', role: 'doc.legacy', ownerRepo: 'test/repo' } });
    await rules({ role: 'doc', strictSubRoles: true });
    frontmatter('a', { id, name: 'A', role: 'doc.legacy' }, 'new');
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([]);
    expect(await stored('a')).toMatchObject({ role: 'doc.legacy', content: expect.stringContaining('new') });
  });

  it('exempt: a file whose node is runnable after the sync', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    frontmatter('t', { name: 'T', role: 'doc.task', isRunnable: true });
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([]);
    expect(await stored('t')).toMatchObject({ role: 'doc.task' });
  });

  it('a refused file declares no edges, and does not fail the sync over them', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const bId = generateId();
    mkdirSync(join(repoRoot(), 'a'), { recursive: true });
    mkdirSync(join(repoRoot(), 'b'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'a'), { name: 'a', role: 'doc.unknown', nodes: [{ id: bId, rel: 'uses' }] });
    writeNodeFiles(join(repoRoot(), 'b'), { id: bId, name: 'b' });
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'a' })]);
    expect(await stored('b')).not.toBeNull();
    expect(await db.edge.count()).toBe(0);
    expect(await db.pendingEdge.count()).toBe(0);
  });

  it('takes its row locks BEFORE the rulebook lock: a rule write holding a node the sync updates does not deadlock it', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const zId = generateId();
    await db.node.create({ data: { id: zId, memoryId: dbGraphId, loc: 'z', name: 'Z', content: 'old', ownerRepo: 'test/repo' } });
    // The judged file sorts BEFORE the row the rule write holds, so a sync
    // taking the rulebook lock at its first judgement would then wait on `z`
    // while holding it.
    frontmatter('a', { name: 'A', role: 'doc.unknown' });
    frontmatter('z', { id: zId, name: 'Z' }, 'new');
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The shape of a rule write (#1400 / #1399): its referenced node FOR
    // SHARE first, the memory's rulebook lock exclusively after.
    const ruleWrite = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${zId} FOR SHARE`;
        held();
        await gate;
        await lockMemoryConfigExclusive(tx, dbGraphId);
      },
      { timeout: 15_000 },
    );
    await holding;
    const syncing = syncGraphFromGithub(makeGraph());
    await waitForLockWaitersOfType(db, 'transactionid', 1);
    release();
    await ruleWrite;
    const result = await syncing;
    expect(result.error).toBeUndefined();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'a' })]);
    expect(await stored('z')).toMatchObject({ content: expect.stringContaining('new') });
  });

  it('a row inserted AFTER the up-front lock is left for the next sync, not deleted under the rulebook lock (#1411 review)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    frontmatter('a', { name: 'A', role: 'doc.unknown' });
    const release = <T,>() => {
      let open!: (v: T) => void;
      return { gate: new Promise<T>((r) => (open = r)), open };
    };
    // 1. Hold the rulebook lock so the sync stops right after its row scan.
    const holdSignal = release<void>();
    const holdGate = release<void>();
    const holder = db.$transaction(async (tx) => {
      await lockMemoryConfigExclusive(tx, dbGraphId);
      holdSignal.open();
      await holdGate.gate;
    }, { timeout: 15_000 });
    await holdSignal.gate;
    const syncing = syncGraphFromGithub(makeGraph());
    await waitForLockWaitersOfType(db, 'advisory', 1);
    // 2. A repo-owned row the cleanup would select, inserted after the scan.
    const lateId = generateId();
    await db.node.create({ data: { id: lateId, memoryId: dbGraphId, loc: 'late', name: 'Late', ownerRepo: 'test/repo' } });
    // 3. A rule write: that row FOR SHARE, then the rulebook lock exclusively.
    const ruleWrite = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${lateId} FOR SHARE`;
      await lockMemoryConfigExclusive(tx, dbGraphId);
    }, { timeout: 15_000 });
    await waitForLockWaitersOfType(db, 'advisory', 2);
    holdGate.open();
    await holder;
    const [result] = await Promise.all([syncing, ruleWrite]);
    expect(result.error).toBeUndefined();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'a' })]);
    expect(await db.node.findUnique({ where: { id: lateId } })).not.toBeNull();
    // The next sync owns it from the start, and prunes it as usual.
    await sync();
    expect(await db.node.findUnique({ where: { id: lateId } })).toBeNull();
  });

  /**
   * The late-row schedule: the sync scans and queues for the rulebook lock;
   * then a row is created, a rule write holds it FOR SHARE and queues for the
   * lock exclusively, and the first holder releases.
   */
  async function raceLateRow(createLate: () => Promise<string>) {
    const signal = (() => { let open!: () => void; const gate = new Promise<void>((r) => (open = r)); return { gate, open }; });
    const held = signal();
    const done = signal();
    const holder = db.$transaction(async (tx) => {
      await lockMemoryConfigExclusive(tx, dbGraphId);
      held.open();
      await done.gate;
    }, { timeout: 15_000 });
    await held.gate;
    const syncing = syncGraphFromGithub(makeGraph());
    await waitForLockWaitersOfType(db, 'advisory', 1);
    const lateId = await createLate();
    const ruleWrite = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${lateId} FOR SHARE`;
      await lockMemoryConfigExclusive(tx, dbGraphId);
    }, { timeout: 15_000 });
    await waitForLockWaitersOfType(db, 'advisory', 2);
    done.open();
    await holder;
    const [result] = await Promise.all([syncing, ruleWrite]);
    expect(result.error).toBeUndefined();
    return { result, lateId };
  }

  it('a node CREATED at a file\'s root loc after the up-front lock defers that file to the next sync (@codex P2, #1411)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    frontmatter('late', { name: 'Late' }, 'from-file');
    const { result, lateId } = await raceLateRow(async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'late', name: 'Late', content: 'concurrent', ownerRepo: 'test/repo' } });
      return id;
    });
    expect(result.deferredLateRows).toEqual([`late (node ${lateId})`]);
    expect(result.writtenNodes!.map((n) => n.loc)).not.toContain('late');
    expect(await stored('late')).toMatchObject({ id: lateId, content: 'concurrent' });
    const next = await sync();
    expect(next.deferredLateRows).toEqual([]);
    expect(await stored('late')).toMatchObject({ id: lateId, content: expect.stringContaining('from-file') });
  });

  it('a MOVE into a loc whose occupant arrived after the up-front lock is deferred, and the mover is kept', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const moverId = generateId();
    await db.node.create({ data: { id: moverId, memoryId: dbGraphId, loc: 'old', name: 'M', content: 'x', ownerRepo: 'test/repo' } });
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    frontmatter('dest', { id: moverId, name: 'M' });
    const { result, lateId } = await raceLateRow(async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'dest', name: 'Occupant', ownerRepo: 'test/repo' } });
      return id;
    });
    expect(result.deferredLateRows).toEqual([`dest (node ${lateId})`]);
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'old', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: lateId } })).toMatchObject({ loc: 'dest' });
    await sync();
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'dest' });
  });

  it('a node carrying the file\'s id that arrived after the up-front lock is deferred too (id-first path)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const fileId = generateId();
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    frontmatter('x', { id: fileId, name: 'X' }, 'from-file');
    const { result } = await raceLateRow(async () => {
      await db.node.create({ data: { id: fileId, memoryId: dbGraphId, loc: 'elsewhere', name: 'X', content: 'concurrent', ownerRepo: 'test/repo' } });
      return fileId;
    });
    expect(result.deferredLateRows).toEqual([`x (node ${fileId})`]);
    expect(await db.node.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({ loc: 'elsewhere', content: 'concurrent' });
    await sync();
    expect(await db.node.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({ loc: 'x' });
  });

  it('locks the memory\'s rule rows before the rulebook lock: a pruned node a rule references cannot deadlock a rule writer (SET NULL)', async () => {
    const taskId = generateId();
    await db.node.create({ data: { id: taskId, memoryId: dbGraphId, loc: 'gone', name: 'Gone', ownerRepo: 'test/repo' } });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: dbGraphId } });
    const rule = await db.nodeRoleRule.create({
      data: { id: generateId(), configId: config.id, role: 'doc', strictSubRoles: true, descriptionNodeId: taskId },
    });
    // No file for `gone`: the cleanup prunes it, and its FK sets the rule's
    // descriptionNodeId to NULL.
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    // A rule writer's shape: its rule row FOR UPDATE, then the rulebook lock.
    const ruleWrite = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "node_role_rules" WHERE "id" = ${rule.id} FOR UPDATE`;
      held();
      await gate;
      await lockMemoryConfigExclusive(tx, dbGraphId);
    }, { timeout: 15_000 });
    await holding;
    const syncing = syncGraphFromGithub(makeGraph());
    await waitForLockWaitersOfType(db, 'transactionid', 1);
    go();
    const [result] = await Promise.all([syncing, ruleWrite]);
    expect(result.error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: taskId } })).toBeNull();
    expect((await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } })).descriptionNodeId).toBeNull();
  });

  /**
   * #1411 review (Andi) — the swap shape: A's file takes B's loc `b-old`, which
   * parks B at `b-old~displaced-<id>`, and B's own file (`dest`) would settle
   * it. If B's file is then deferred or refused, B must not commit parked.
   */
  const seedSwap = async () => {
    const aId = generateId();
    const bId = generateId();
    await db.node.create({ data: { id: aId, memoryId: dbGraphId, loc: 'a-old', name: 'A', ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: bId, memoryId: dbGraphId, loc: 'b-old', name: 'B', ownerRepo: 'test/repo' } });
    frontmatter('b-old', { id: aId, name: 'A' });
    return { aId, bId };
  };
  const noInvalidLocs = async () => {
    const rows = await db.node.findMany({ where: { memoryId: dbGraphId }, select: { loc: true } });
    expect(rows.filter((r) => r.loc.includes('~'))).toEqual([]);
  };

  it('a later file REFUSED for its role cannot leave an earlier move\'s parked occupant committed (#1411 review)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const { aId, bId } = await seedSwap();
    frontmatter('dest', { id: bId, name: 'B', role: 'doc.unknown' });
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'dest' })]);
    expect(result.heldMoves).toEqual([`a-old → b-old (occupant ${bId})`]);
    await noInvalidLocs();
    expect(await db.node.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ loc: 'a-old' });
    expect(await db.node.findUniqueOrThrow({ where: { id: bId } })).toMatchObject({ loc: 'b-old' });
    expect(result.writtenNodes!.map((n) => n.id)).not.toContain(aId);

    // Declare the role: B's file syncs, so the swap completes.
    frontmatter('dest', { id: bId, name: 'B', role: 'doc.guide' });
    await db.nodeRoleRule.create({
      data: { id: generateId(), configId: (await db.memoryConfig.findFirstOrThrow({ where: { memoryId: dbGraphId } })).id, role: 'doc.guide' },
    });
    const next = await sync();
    expect(next.heldMoves).toEqual([]);
    await noInvalidLocs();
    expect(await db.node.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ loc: 'b-old' });
    expect(await db.node.findUniqueOrThrow({ where: { id: bId } })).toMatchObject({ loc: 'dest' });
  });

  it('a later file DEFERRED for a late occupant cannot leave an earlier move\'s parked occupant committed (#1411 review)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const { aId, bId } = await seedSwap();
    frontmatter('dest', { id: bId, name: 'B' });
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    const { result, lateId } = await raceLateRow(async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'dest', name: 'Late', ownerRepo: 'test/repo' } });
      return id;
    });
    // The first attempt deferred B's file and rolled back; the rerun locks the
    // late row from the start, so nothing is deferred and only A's move waits.
    expect(result.heldMoves).toEqual([`a-old → b-old (occupant ${bId})`]);
    expect(result.deferredLateRows).toEqual([]);
    await noInvalidLocs();
    expect(await db.node.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ loc: 'a-old' });
    expect(await db.node.findUniqueOrThrow({ where: { id: bId } })).toMatchObject({ loc: 'dest' });
    expect(await db.node.findUnique({ where: { id: lateId } })).toBeNull();

    const next = await sync();
    expect(next.heldMoves).toEqual([]);
    await noInvalidLocs();
    expect(await db.node.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ loc: 'b-old' });
  });

  /** #1411 review (@codex P2) — edges aimed at a skipped loc-keyed file. */
  const foreignNode = async () => {
    const { graph: other } = await createDbOrgAndGraph(db, { orgName: 'foreign-org-1411', graphName: 'foreign/repo-1411' });
    return db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'elsewhere', name: 'Foreign' } });
  };

  const edgeFrom = (id: string) => {
    mkdirSync(join(repoRoot(), 'g'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id, rel: 'uses' }] });
  };

  it('V4: a DEFERRED id-first move (the node arrived late) — its incoming edge waits, then lands once under the new loc', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const fileId = generateId();
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    frontmatter('x', { id: fileId, name: 'X' });
    edgeFrom(fileId);
    const { result } = await raceLateRow(async () => {
      await db.node.create({ data: { id: fileId, memoryId: dbGraphId, loc: 'elsewhere', name: 'X', ownerRepo: 'test/repo' } });
      return fileId;
    });
    expect(result.deferredLateRows).toEqual([`x (node ${fileId})`]);
    expect(await db.edge.count({ where: { targetId: fileId } })).toBe(0);
    await sync();
    expect(await db.node.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({ loc: 'x' });
    expect(await db.edge.count({ where: { targetId: fileId, deletedAt: null } })).toBe(1);
  });

  it('V6: a move DEFERRED behind a late occupant — its incoming edge waits, then lands once under the new loc', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const moverId = generateId();
    await db.node.create({ data: { id: moverId, memoryId: dbGraphId, loc: 'old', name: 'M', ownerRepo: 'test/repo' } });
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    frontmatter('dest', { id: moverId, name: 'M' });
    edgeFrom(moverId);
    const { result } = await raceLateRow(async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'dest', name: 'Occupant', ownerRepo: 'test/repo' } });
      return id;
    });
    expect(result.deferredLateRows).toHaveLength(1);
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'old' });
    expect(await db.edge.count({ where: { targetId: moverId } })).toBe(0);
    await sync();
    expect(await db.node.findUniqueOrThrow({ where: { id: moverId } })).toMatchObject({ loc: 'dest' });
    expect(await db.edge.count({ where: { targetId: moverId, deletedAt: null } })).toBe(1);
  });

  it('a REFUSED loc-keyed file with a foreign id: an edge aimed at that id lands on this memory\'s row, never the foreign node', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const foreign = await foreignNode();
    const rowId = generateId();
    await db.node.create({ data: { id: rowId, memoryId: dbGraphId, loc: 'f', name: 'F', ownerRepo: 'test/repo' } });
    mkdirSync(join(repoRoot(), 'f'), { recursive: true });
    mkdirSync(join(repoRoot(), 'g'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'f'), { id: foreign.id, name: 'F', role: 'doc.unknown' });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id: foreign.id, rel: 'uses' }] });
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'f' })]);
    const edges = await db.edge.findMany({ where: { deletedAt: null }, select: { targetId: true } });
    expect(edges).toEqual([{ targetId: rowId }]);
    expect(await db.pendingEdge.count()).toBe(0);
  });

  it('a REFUSED new file with an unknown id: an edge aimed at it waits, no spurious PendingEdge', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const unknownId = generateId();
    mkdirSync(join(repoRoot(), 'n'), { recursive: true });
    mkdirSync(join(repoRoot(), 'g'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'n'), { id: unknownId, name: 'N', role: 'doc.unknown' });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id: unknownId, rel: 'uses' }] });
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'n' })]);
    expect(await db.pendingEdge.count()).toBe(0);
    expect(await db.edge.count()).toBe(0);
  });

  it('a REFUSED id-first MOVE: an edge aimed at it waits, so the later move does not leave a duplicate under the old loc (@codex P2, #1411)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'old', name: 'N', ownerRepo: 'test/repo' } });
    mkdirSync(join(repoRoot(), 'new'), { recursive: true });
    mkdirSync(join(repoRoot(), 'g'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'new'), { id, name: 'N', role: 'doc.unknown' });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id, rel: 'uses' }] });
    const first = await sync();
    expect(first.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'new' })]);
    expect(await db.node.findUniqueOrThrow({ where: { id } })).toMatchObject({ loc: 'old' });
    expect(await db.edge.count()).toBe(0);
    // Declare the role: the move lands, and so does exactly ONE edge, under the new loc.
    await db.nodeRoleRule.create({
      data: { id: generateId(), configId: (await db.memoryConfig.findFirstOrThrow({ where: { memoryId: dbGraphId } })).id, role: 'doc.unknown' },
    });
    await sync();
    expect(await db.node.findUniqueOrThrow({ where: { id } })).toMatchObject({ loc: 'new' });
    const edges = await db.edge.findMany({ where: { deletedAt: null }, select: { targetId: true, loc: true } });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(id);
    expect(edges[0].loc).toContain('new');
  });

  /**
   * #1411 review (@codex P2): a later COPY of a skipped first claimant's
   * frontmatter id must never take the id over. Which file the loader reaches
   * first is filesystem order (unsorted readdir), so each test asserts the
   * order-independent invariant: no edge aimed at the shared id lands on the
   * copy's fresh row. (`a-…` before `b-…` on APFS is the order that exposed it.)
   */
  const edgesNotOnTheCopy = async (sharedId: string) => {
    const edges = await db.edge.findMany({ where: { deletedAt: null }, select: { targetId: true } });
    for (const e of edges) expect(e.targetId).toBe(sharedId);
    return edges;
  };

  it('a refused first claimant that does NOT move keeps the id: a later copy cannot take its edges', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'a-first', name: 'A', ownerRepo: 'test/repo' } });
    for (const d of ['a-first', 'b-copy', 'g']) mkdirSync(join(repoRoot(), d), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'a-first'), { id, name: 'A', role: 'doc.unknown' });
    writeNodeFiles(join(repoRoot(), 'b-copy'), { id, name: 'Copy' });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id, rel: 'uses' }] });
    await sync();
    expect(await edgesNotOnTheCopy(id)).toHaveLength(1);
  });

  it('an unwritten PLACEHOLDER\'s blank file with an undeclared role is not refused: its other changes sync, role stays spec (@codex P2, #1411)', async () => {
    await rules({ role: 'spec', strictSubRoles: true });
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'p', name: 'Old', role: 'spec', isPlaceholder: true, ownerRepo: 'test/repo' } });
    frontmatter('p', { id, name: 'New', role: 'spec.foo' }, '');
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([]);
    expect(await db.node.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: 'New', role: 'spec', isPlaceholder: true });
  });

  it('a placeholder WRITTEN in the same file is judged normally: an undeclared role is refused', async () => {
    await rules({ role: 'spec', strictSubRoles: true });
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'p', name: 'Old', role: 'spec', isPlaceholder: true, ownerRepo: 'test/repo' } });
    frontmatter('p', { id, name: 'New', role: 'spec.foo' }, 'Now written.');
    const result = await sync();
    expect(result.skippedUndeclaredRoles).toEqual([expect.objectContaining({ loc: 'p', role: 'spec.foo' })]);
    expect(await db.node.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: 'Old', isPlaceholder: true });
  });

  it('an APPLIED first claimant keeps the id when a later LOC-KEYED copy is refused (Charles QA Z4, #1411)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const id = generateId();
    const copyRowId = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'a', name: 'A', ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: copyRowId, memoryId: dbGraphId, loc: 'b', name: 'B', ownerRepo: 'test/repo' } });
    for (const d of ['a', 'b', 'g']) mkdirSync(join(repoRoot(), d), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'a'), { id, name: 'A' });
    // A copy of A's id at another loc, refused: it resolves loc-keyed to the row at `b`.
    writeNodeFiles(join(repoRoot(), 'b'), { id, name: 'B', role: 'doc.unknown' });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id, rel: 'uses' }] });
    await sync();
    await edgesNotOnTheCopy(id);
    expect(await db.edge.count({ where: { targetId: copyRowId } })).toBe(0);
  });

  it('a refused first claimant that MOVES: its edges wait, and a later copy cannot take them', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'old', name: 'A', ownerRepo: 'test/repo' } });
    for (const d of ['a-new', 'b-copy', 'g']) mkdirSync(join(repoRoot(), d), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'a-new'), { id, name: 'A', role: 'doc.unknown' });
    writeNodeFiles(join(repoRoot(), 'b-copy'), { id, name: 'Copy' });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id, rel: 'uses' }] });
    await sync();
    await edgesNotOnTheCopy(id);
    expect(await db.pendingEdge.count()).toBe(0);
  });

  it('a REFUSED id-first file that does NOT move keeps its loc, so an edge aimed at it is written now', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'same', name: 'S', ownerRepo: 'test/repo' } });
    mkdirSync(join(repoRoot(), 'same'), { recursive: true });
    mkdirSync(join(repoRoot(), 'g'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'same'), { id, name: 'S', role: 'doc.unknown' });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id, rel: 'uses' }] });
    await sync();
    const edges = await db.edge.findMany({ where: { deletedAt: null }, select: { targetId: true } });
    expect(edges).toEqual([{ targetId: id }]);
  });

  it('a DEFERRED loc-keyed file with a foreign id: the edge waits, then lands on the row once the file applies', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    const foreign = await foreignNode();
    frontmatter('r', { name: 'R', role: 'doc.unknown' });
    frontmatter('late', { id: foreign.id, name: 'Late' });
    mkdirSync(join(repoRoot(), 'g'), { recursive: true });
    writeNodeFiles(join(repoRoot(), 'g'), { name: 'G', nodes: [{ id: foreign.id, rel: 'uses' }] });
    const { result, lateId } = await raceLateRow(async () => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'late', name: 'Late', ownerRepo: 'test/repo' } });
      return id;
    });
    expect(result.deferredLateRows).toEqual([`late (node ${lateId})`]);
    // Nothing aimed at the file yet: not the foreign node, and not the late
    // row, which this sync must not touch under the rulebook lock.
    expect(await db.edge.count()).toBe(0);
    expect(await db.pendingEdge.count()).toBe(0);
    await sync();
    const edges = await db.edge.findMany({ where: { deletedAt: null }, select: { targetId: true } });
    expect(edges).toEqual([{ targetId: lateId }]);
  });
});

describe('#1641 — git sync never writes a decision', () => {
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');
  const frontmatter = (loc: string, meta: Parameters<typeof writeFrontmatterNode>[1], body = 'Body.') =>
    writeFrontmatterNode(join(repoRoot(), `${loc}.md`), meta, body);
  const stored = (loc: string) =>
    db.node.findFirst({ where: { loc, memoryId: dbGraphId }, select: { id: true, role: true, content: true } });

  it('a file declaring a decision or decision-log role is skipped; the rest of the memory syncs', async () => {
    frontmatter('forged', { name: 'DA: forged', role: 'decision' });
    frontmatter('log', { name: 'Decisions', role: 'decision.log' });
    frontmatter('plain', { name: 'Plain' });
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(await stored('forged')).toBeNull();
    expect(await stored('log')).toBeNull();
    expect(await stored('plain')).not.toBeNull();
  });

  it('a file landing on a decision row leaves the row exactly as it was, and the cleanup keeps it', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId: dbGraphId, loc: 'd', name: 'DA: x', content: 'kept', role: 'decision', ownerRepo: 'test/repo' } });
    frontmatter('d', { id, name: 'DA: x' }, 'overwritten');
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(await stored('d')).toEqual({ id, role: 'decision', content: 'kept' });
  });
});

describe('describeSyncOutcome — the on-demand sync report (#1411 review, @codex P2)', () => {
  it('names every file the sync left unapplied', () => {
    const report = describeSyncOutcome({
      nodeCount: 4,
      skippedUndeclaredRoles: [{ loc: 'bad', role: 'doc.x', strictParent: 'doc', code: 'ROLE_NOT_DECLARED' }],
      deferredLateRows: ['late (node n1)'],
      heldMoves: ['a-old → b-old (occupant n2)'],
    });
    expect(report).toContain('Synced 4 nodes.');
    expect(report).toMatch(/Skipped 1 file\(s\), ROLE_NOT_DECLARED[^\n]*\n- bad \(role "doc\.x", strict parent "doc"\)/);
    expect(report).toMatch(/Deferred 1 file\(s\)[^\n]*sync again[^\n]*\n- late \(node n1\)/);
    expect(report).toMatch(/Held 1 move\(s\)[^\n]*\n- a-old → b-old \(occupant n2\)/);
  });

  it('a clean sync is one line', () => {
    expect(describeSyncOutcome({ nodeCount: 2, skippedUndeclaredRoles: [], deferredLateRows: [], heldMoves: [] })).toBe('Synced 2 nodes.');
  });
});

describe('#1477 Git placeholder marker', () => {
  const file = (meta: { id?: string; name: string; role?: string; placeholder?: boolean }, content?: string) => {
    const path = join(mockSources, 'test-org', 'test/repo', 'pas', '010', '01.md');
    writeFrontmatterNode(path, meta, content);
  };
  const stored = () => db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'pas:010:01', memoryId: dbGraphId } } });

  it('recreates a reserved citation from an incremental mirror file', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusDraft: true } });
    const id = generateId();
    const reserved = await db.node.create({ data: {
      id, memoryId: dbGraphId, loc: 'pas:010:01', name: 'Reserved',
      role: 'spec', isPlaceholder: true, ownerRepo: 'test/repo',
    } });
    writeNodeFile(join(mockSources, 'test-org', 'test/repo'), {
      id: reserved.id, loc: reserved.loc, name: reserved.name, tags: [],
      role: reserved.role, isRunnable: reserved.isRunnable,
      isPlaceholder: reserved.isPlaceholder, outgoingEdges: [],
    });
    await db.node.delete({ where: { id } });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await stored()).toMatchObject({ id, role: 'spec', content: null, isPlaceholder: true });
  });

  it('restores a blank spec reservation in a draft, including a dotted spec role', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusDraft: true } });
    file({ name: 'Reserved', role: 'spec.rule', placeholder: true });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await stored()).toMatchObject({ role: 'spec.rule', content: null, isPlaceholder: true });
  });

  it('ignores and reports a marker on a MINTED node while syncing it (#1591: per node)', async () => {
    const id = generateId();
    await db.node.create({ data: {
      id, memoryId: dbGraphId, loc: 'pas:010:01', name: 'Published', role: 'spec', ownerRepo: 'test/repo',
      mintedAt: new Date(), mintedByInfo: 'test',
    } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      file({ id, name: 'Still imported', role: 'spec', placeholder: true });
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      expect(await stored()).toMatchObject({ name: 'Still imported', isPlaceholder: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored placeholder marker'));
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['non-spec role', true, 'review', undefined],
    ['lookalike role', true, 'special', undefined],
    ['written body', true, 'spec', 'The rule.'],
  ] as const)('ignores and reports a marker in a %s while syncing the node', async (_case, draft, role, content) => {
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusDraft: draft } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      file({ name: 'Still imported', role, placeholder: true }, content);
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      expect(await stored()).toMatchObject({ name: 'Still imported', role, isPlaceholder: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored placeholder marker'));
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves an old mirrored placeholder when the key is absent and clears it when the file writes content', async () => {
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusDraft: true } });
    const id = generateId();
    await db.node.create({ data: {
      id, memoryId: dbGraphId, loc: 'pas:010:01', name: 'Reserved',
      role: 'spec', isPlaceholder: true, ownerRepo: 'test/repo',
    } });
    file({ id, name: 'Renamed' });
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await stored()).toMatchObject({ name: 'Renamed', role: 'spec', isPlaceholder: true });

    file({ id, name: 'Written', role: 'spec', placeholder: true }, 'The rule.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
      expect(await stored()).toMatchObject({ name: 'Written', content: 'The rule.', isPlaceholder: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored placeholder marker'));
    } finally {
      warn.mockRestore();
    }
  });
});

// ── #1468: git sync never prunes a spec from a mint-stamped corpus ──────────
describe('#1468 — git sync pruning and minted specs', () => {
  // #1591: minted-spec permanence is switched off in production for now; the
  // guard's own assertions run with it on.
  beforeAll(() => setMintedSpecPermanenceEnforcedForTests(true));
  afterAll(() => setMintedSpecPermanenceEnforcedForTests(false));
  const repoRoot = () => join(mockSources, 'test-org', 'test/repo');
  const writeSpec = (loc: string) =>
    writeFrontmatterNode(join(repoRoot(), `${loc}.md`), { name: loc, tags: ['spec'] }, 'Rule text.');
  const liveLocs = async () =>
    (await db.node.findMany({ where: { memoryId: dbGraphId, deletedAt: null }, select: { loc: true } }))
      .map((n) => n.loc).sort();

  const writeNote = (loc: string) =>
    writeFrontmatterNode(join(repoRoot(), `${loc}.md`), { name: loc }, 'Note.');

  it('keeps a minted spec whose file is gone, warns, and still prunes the rest', async () => {
    writeSpec('pas:010');
    writeSpec('pas:020');
    writeNote('notes');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });

    rmSync(join(repoRoot(), 'pas:010.md'));
    rmSync(join(repoRoot(), 'notes.md'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await syncGraphFromGithub(makeGraph());
    expect(result.error).toBeUndefined();
    expect(await liveLocs()).toEqual(['pas:010', 'pas:020']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/kept 1 minted spec.*pas:010/));
    warn.mockRestore();
  });

  it("a kept minted spec's cross-memory edge does not refuse the prune", async () => {
    writeSpec('pas:010');
    writeNote('notes');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    const other = await db.memory.create({
      data: { id: generateId(), organizationId: dbOrgId, urn: 'test-org:other', name: 'other', class: 'knowledge' },
    });
    const citer = await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'citer', name: 'citer' } });
    const spec = await db.node.findFirstOrThrow({ where: { memoryId: dbGraphId, loc: 'pas:010' } });
    await db.edge.create({ data: { id: generateId(), memoryId: other.id, sourceId: citer.id, targetId: spec.id, loc: 'citer:cites:pas:010', name: 'cites' } });

    rmSync(join(repoRoot(), 'pas:010.md'));
    rmSync(join(repoRoot(), 'notes.md'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    warn.mockRestore();
    expect(await liveLocs()).toEqual(['pas:010']);
  });

  it('keeps the spec marker when a file drops it from a minted spec, and applies the rest (#4403)', async () => {
    writeSpec('pas:010');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });

    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { name: 'pas:010', tags: ['other'] }, 'Edited rule text.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/kept the spec marker on minted spec pas:010/));
    warn.mockRestore();
    const spec = await db.node.findFirstOrThrow({ where: { memoryId: dbGraphId, loc: 'pas:010' } });
    expect(spec).toMatchObject({ tags: ['spec'], content: 'Edited rule text.' });
  });

  it('control: an unstamped memory takes the marker drop from the file', async () => {
    writeSpec('pas:010');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();

    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { name: 'pas:010', tags: ['other'] }, 'Rule text.');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    const node = await db.node.findFirstOrThrow({ where: { memoryId: dbGraphId, loc: 'pas:010' } });
    expect(node.tags).toEqual(['other']);
  });

  it("refuses a move that would displace a minted spec with no file of its own (Codex P1)", async () => {
    const specId = 'aaaa146800000000000000000000000001';
    const noteId = 'bbbb146800000000000000000000000002';
    await db.node.create({ data: { id: specId, memoryId: dbGraphId, loc: 'pas:010', name: 'spec', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: noteId, memoryId: dbGraphId, loc: 'notes', name: 'note', ownerRepo: 'test/repo' } });
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { id: noteId, name: 'note' }, 'Note.');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refusing move of .* → "pas:010" — the loc is held by a row that will not move/));
    warn.mockRestore();
    expect(await db.node.findUniqueOrThrow({ where: { id: specId } })).toMatchObject({ loc: 'pas:010', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: noteId } })).toMatchObject({ loc: 'notes', deletedAt: null });
  });

  it("never parks a minted spec, even when its own file is present but skipped as protected (Chip QA #4732)", async () => {
    const specId = 'aaaa146800000000000000000000000007';
    const noteId = 'bbbb146800000000000000000000000008';
    await db.node.create({ data: { id: specId, memoryId: dbGraphId, loc: 'pas:010', name: 'spec', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: noteId, memoryId: dbGraphId, loc: 'notes', name: 'note', ownerRepo: 'test/repo' } });
    const { channel, rootId } = await ensureChannelWithRoot(db, { memoryId: dbGraphId, loc: 'chats:dead', name: 'dead', createdBy: null });
    const deletedAt = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt } }),
    ]);
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    mkdirSync(join(repoRoot(), 'chats', 'dead', 'messages'), { recursive: true });
    writeFrontmatterNode(join(repoRoot(), 'chats', 'dead', 'messages', 'kept.md'), { id: specId, name: 'spec', tags: ['spec'] }, 'Rule text.');
    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { id: noteId, name: 'note' }, 'Note.');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    warn.mockRestore();
    expect(await db.node.findUniqueOrThrow({ where: { id: specId } })).toMatchObject({ loc: 'pas:010', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: noteId } })).toMatchObject({ loc: 'notes', deletedAt: null });
  });

  it('refuses a repo swap of two minted specs: both keep their published citations', async () => {
    const aId = 'aaaa146800000000000000000000000009';
    const bId = 'bbbb146800000000000000000000000010';
    await db.node.create({ data: { id: aId, memoryId: dbGraphId, loc: 'pas:010', name: 'a', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: bId, memoryId: dbGraphId, loc: 'pas:020', name: 'b', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { id: bId, name: 'b', tags: ['spec'] }, 'B.');
    writeFrontmatterNode(join(repoRoot(), 'pas:020.md'), { id: aId, name: 'a', tags: ['spec'] }, 'A.');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    warn.mockRestore();
    expect(await db.node.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ loc: 'pas:010', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: bId } })).toMatchObject({ loc: 'pas:020', deletedAt: null });
    expect(await db.node.count({ where: { memoryId: dbGraphId, loc: { contains: '~' } } })).toBe(0);
  });

  it('refuses a move chain ending on a minted spec before parking anything (Codex P1, chain)', async () => {
    const aId = 'aaaa146800000000000000000000000011';
    const bId = 'bbbb146800000000000000000000000012';
    const cId = 'cccc146800000000000000000000000013';
    await db.node.create({ data: { id: aId, memoryId: dbGraphId, loc: 'a', name: 'a', ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: bId, memoryId: dbGraphId, loc: 'b', name: 'b', ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: cId, memoryId: dbGraphId, loc: 'pas:010', name: 'c', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    // File order puts A's move (onto b) before B's (onto the minted spec).
    writeFrontmatterNode(join(repoRoot(), 'b.md'), { id: aId, name: 'a' }, 'A.');
    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { id: bId, name: 'b' }, 'B.');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    warn.mockRestore();
    const locs = Object.fromEntries((await db.node.findMany({ where: { memoryId: dbGraphId, deletedAt: null } })).map((n) => [n.id, n.loc]));
    expect(locs).toEqual({ [aId]: 'a', [bId]: 'b', [cId]: 'pas:010' });
  });

  it("a refused move's outgoing edges are skipped, so the sync still succeeds (Codex P1, edges)", async () => {
    const specId = 'aaaa146800000000000000000000000014';
    const noteId = 'bbbb146800000000000000000000000015';
    await db.node.create({ data: { id: specId, memoryId: dbGraphId, loc: 'pas:010', name: 'spec', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: noteId, memoryId: dbGraphId, loc: 'notes', name: 'note', ownerRepo: 'test/repo' } });
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    writeFrontmatterNode(join(repoRoot(), 'target.md'), { name: 'target' }, 'Target.');
    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { id: noteId, name: 'note' }, 'Note.', [{ target: 'target', rel: 'cites' }]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await syncGraphFromGithub(makeGraph());
    warn.mockRestore();
    expect(result.error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: noteId } })).toMatchObject({ loc: 'notes', deletedAt: null });
    expect(await db.node.findFirst({ where: { memoryId: dbGraphId, loc: 'target', deletedAt: null } })).not.toBeNull();
    expect(await db.edge.count({ where: { sourceId: noteId } })).toBe(0);
  });

  it("never parks a row whose own file is skipped under a protected loc (Codex P1, pinned rows)", async () => {
    const aId = 'aaaa146800000000000000000000000016';
    const bId = 'bbbb146800000000000000000000000017';
    await db.node.create({ data: { id: aId, memoryId: dbGraphId, loc: 'a', name: 'a', ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: bId, memoryId: dbGraphId, loc: 'b', name: 'b', ownerRepo: 'test/repo' } });
    const { channel, rootId } = await ensureChannelWithRoot(db, { memoryId: dbGraphId, loc: 'chats:dead', name: 'dead', createdBy: null });
    const deletedAt = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt } }),
    ]);
    // Unstamped on purpose: stranding any row at a waypoint is the defect.
    mkdirSync(join(repoRoot(), 'chats', 'dead', 'messages'), { recursive: true });
    writeFrontmatterNode(join(repoRoot(), 'chats', 'dead', 'messages', 'b.md'), { id: bId, name: 'b' }, 'B.');
    writeFrontmatterNode(join(repoRoot(), 'b.md'), { id: aId, name: 'a' }, 'A.');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    warn.mockRestore();
    expect(await db.node.findUniqueOrThrow({ where: { id: bId } })).toMatchObject({ loc: 'b', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ loc: 'a', deletedAt: null });
    expect(await db.node.count({ where: { memoryId: dbGraphId, loc: { contains: '~' } } })).toBe(0);
  });

  it("an edge aimed at a refused mover waits with the move (#1411's skipped-move contract)", async () => {
    const specId = 'aaaa146800000000000000000000000018';
    const noteId = 'bbbb146800000000000000000000000019';
    await db.node.create({ data: { id: specId, memoryId: dbGraphId, loc: 'pas:010', name: 'spec', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: noteId, memoryId: dbGraphId, loc: 'notes', name: 'note', ownerRepo: 'test/repo' } });
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { id: noteId, name: 'note' }, 'Note.');
    writeFrontmatterNode(join(repoRoot(), 'citer.md'), { name: 'citer' }, 'Cites the note.', [{ target: 'x', id: noteId, rel: 'uses' }]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    warn.mockRestore();
    expect(await db.node.findUniqueOrThrow({ where: { id: noteId } })).toMatchObject({ loc: 'notes' });
    expect(await db.edge.count({ where: { targetId: noteId, deletedAt: null } })).toBe(0);
  });

  it('control: an unstamped memory still lets that move displace the occupant', async () => {
    const specId = 'aaaa146800000000000000000000000003';
    const noteId = 'bbbb146800000000000000000000000004';
    await db.node.create({ data: { id: specId, memoryId: dbGraphId, loc: 'pas:010', name: 'spec', tags: ['spec'], ownerRepo: 'test/repo' } });
    await db.node.create({ data: { id: noteId, memoryId: dbGraphId, loc: 'notes', name: 'note', ownerRepo: 'test/repo' } });
    writeFrontmatterNode(join(repoRoot(), 'pas:010.md'), { id: noteId, name: 'note' }, 'Note.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    warn.mockRestore();
    expect(await db.node.findUniqueOrThrow({ where: { id: noteId } })).toMatchObject({ loc: 'pas:010' });
  });

  it("records a URN alias when a repo rename moves a minted spec, so its citation still resolves (Codex P1)", async () => {
    const specId = 'aaaa146800000000000000000000000005';
    // #1591: a minted node's old address is published, so its rename leaves an alias.
    await db.node.create({ data: { id: specId, memoryId: dbGraphId, loc: 'pas:010', name: 'spec', tags: ['spec'], ownerRepo: 'test/repo', mintedAt: new Date(), mintedByInfo: 'test' } });
    await db.memory.update({ where: { id: dbGraphId }, data: { corpusMintedAt: new Date() } });
    writeFrontmatterNode(join(repoRoot(), 'pas:099.md'), { id: specId, name: 'spec', tags: ['spec'] }, 'Rule text.');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: specId } })).toMatchObject({ loc: 'pas:099' });
    const aliases = await db.urnAlias.findMany({ where: { entityId: specId } });
    expect(aliases.map((a) => a.urn)).toEqual([expect.stringMatching(/:pas:010$/)]);
  });

  it('a repo rename in an unstamped memory also records the old address (#1404)', async () => {
    const specId = 'aaaa146800000000000000000000000006';
    // #1591: a minted node's old address is published, so its rename leaves an alias.
    await db.node.create({ data: { id: specId, memoryId: dbGraphId, loc: 'pas:010', name: 'spec', tags: ['spec'], ownerRepo: 'test/repo', mintedAt: new Date(), mintedByInfo: 'test' } });
    writeFrontmatterNode(join(repoRoot(), 'pas:099.md'), { id: specId, name: 'spec', tags: ['spec'] }, 'Rule text.');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect((await db.urnAlias.findMany({ where: { entityId: specId } })).map((a) => a.urn))
      .toEqual([expect.stringMatching(/:pas:010$/)]);
  });

  it('control: an unstamped memory still prunes the spec whose file is gone', async () => {
    writeSpec('pas:010');
    writeSpec('pas:020');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();

    rmSync(join(repoRoot(), 'pas:010.md'));
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await liveLocs()).toEqual(['pas:020']);
  });
});

// ── #449: the repo-wins prune removes PendingEdges aimed at the pruned rows ──
describe('#449 — git sync cleanup and PendingEdges aimed at pruned nodes', () => {
  it('pruning a node removes the raw-id and stable-key rows aimed at it; a loc-keyed row stays', async () => {
    const repo = join(mockSources, 'test-org', 'test/repo');
    writeFrontmatterNode(join(repo, 'keep.md'), { name: 'keep' }, 'Kept.');
    writeFrontmatterNode(join(repo, 'gone.md'), { name: 'gone' }, 'Pruned next sync.');
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    const gone = await db.node.findFirstOrThrow({ where: { memoryId: dbGraphId, loc: 'gone' } });

    // The rows' source lives in another memory, whose count must follow.
    const other = await db.memory.create({
      data: { id: generateId(), organizationId: dbOrgId, urn: 'test-org:pe-source', name: 'pe-source', class: 'knowledge' },
    });
    const source = await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'src', name: 'src' } });
    for (const targetId of [gone.id, pendingEdgeStableTargetKey(gone.id), 'gone']) {
      await db.pendingEdge.create({ data: { id: generateId(), sourceId: source.id, targetId, name: 'cites' } });
    }
    await reconcilePendingEdgeCount(db, other.id);

    rmSync(join(repo, 'gone.md'));
    expect((await syncGraphFromGithub(makeGraph())).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: gone.id } })).toBeNull();
    expect((await db.pendingEdge.findMany({ select: { targetId: true } })).map((p) => p.targetId)).toEqual(['gone']);
    expect((await db.memory.findUniqueOrThrow({ where: { id: other.id } })).pendingEdgeCount).toBe(1);
  });
});


it('Git sync waits on history before source rows and snapshots', async () => {
  const source = await db.node.create({ data: { memoryId: dbGraphId, loc: 'boundary', name: 'Boundary', content: 'Before' } });
  const path = join(mockSources, 'test-org', 'test/repo', 'boundary');
  mkdirSync(path, { recursive: true });
  writeNodeFiles(path, { name: 'Boundary' }, 'After');
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const pending = syncGraphFromGithub(makeGraph());
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 1500);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${dbGraphId} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${source.id} FOR UPDATE NOWAIT`;
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe('Before');
    expect(await db.nodeRevision.count({ where: { nodeId: source.id } })).toBe(0);
  } finally { release(); await holder; await outcome; }
  expect((await pending).error).toBeUndefined();
  expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe('After');
});

it('Git sync retains history exclusivity through its actual deciding commit', async () => {
  const source = await db.node.create({ data: { memoryId: dbGraphId, loc: 'boundary', name: 'Boundary', content: 'Before' } });
  const path = join(mockSources, 'test-org', 'test/repo', 'boundary');
  mkdirSync(path, { recursive: true });
  writeNodeFiles(path, { name: 'Boundary' }, 'After');
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transaction = db.$transaction.bind(db);
  let first = true;
  const hook = vi.spyOn(db, '$transaction').mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
    const held = first; first = false;
    return transaction(async (tx) => { const value = await work(tx); if (held) { entered(); await gate; } return value; }, options as never);
  }) as typeof db.$transaction);
  const pending = syncGraphFromGithub(makeGraph());
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  let otherEntered = false;
  try {
    await Promise.race([ready, outcome.then((result) => { if ('error' in result) throw result.error; throw new Error('missing Git commit barrier'); })]);
    const counterparty = withIncludeHistoryTransaction(db, async () => { otherEntered = true; });
    const otherOutcome = counterparty.then(() => undefined, (error: unknown) => error);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 1500);
      expect(otherEntered).toBe(false);
      expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe('Before');
    } finally { release(); await outcome; await otherOutcome; }
    expect((await pending).error).toBeUndefined();
    expect(otherEntered).toBe(true);
  } finally { release(); hook.mockRestore(); }
});

// Evidence-only: requires the held #2258 compile implementation.
import { compileBootPrompt } from '../../api/graphql/schema/compileBootPrompt.js';
it.each(['read', 'write', 'writer-first'] as const)('actual affected-source compile and Git sync: %s', async (phase) => {
  const source = await db.node.create({ data: { memoryId: dbGraphId, loc: 'boundary', name: 'Boundary', content: 'Before' } });
  const path = join(mockSources, 'test-org', 'test/repo', 'boundary');
  mkdirSync(path, { recursive: true });
  writeNodeFiles(path, { name: 'Boundary' }, 'After');
  const user = await db.user.create({ data: { handle: 'git-compile-admin', roles: ['ADMIN'] } });
  await db.memory.update({ where: { id: dbGraphId }, data: { class: 'system' } });
  const agent = await db.agent.create({ data: { organizationId: dbOrgId, systemMemoryId: dbGraphId, urn: 'test-org:compile-agent', name: 'Compile' } });
  await db.node.create({ data: { memoryId: dbGraphId, loc: 'boot:source', role: 'boot-prompt', name: 'Source', content: '{{> boundary}}' } });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transaction = db.$transaction.bind(db);
  const compileDb = new Proxy(db, {
    get(client, key, receiver) {
      if (key !== '$transaction') return Reflect.get(client, key, receiver);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
        const result = await work(tx);
        if (phase === 'write') { entered(); await gate; }
        return result;
      }, options as never);
    },
  });
  let restoreHook: (() => void) | undefined;
  if (phase === 'writer-first') {
    const hook = vi.spyOn(db, '$transaction').mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => transaction(async (tx) => {
      const result = await work(tx); entered(); await gate; return result;
    }, options as never)) as typeof db.$transaction);
    restoreHook = () => hook.mockRestore();
  }
  const compile = () => compileBootPrompt({ db: compileDb, userId: user.id, roles: ['ADMIN'] }, { kind: 'AGENT', agentId: agent.id }, phase === 'read' ? { seams: { beforeAssemble: async () => { entered(); await gate; } } } : {});
  const first: Promise<unknown> = phase === 'writer-first' ? syncGraphFromGithub(makeGraph()) : compile();
  const firstResult = first.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await Promise.race([ready, firstResult.then((result) => { if ('error' in result) throw result.error; throw new Error('missing combined Git/compile barrier'); })]);
    const second: Promise<unknown> = phase === 'writer-first' ? compile() : syncGraphFromGithub(makeGraph());
    const secondResult = second.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      // The write-phase compiler holds the output Memory row. Git's standalone
      // syncStatus prelude queues there before its deciding F-first transaction.
      await waitForLockWaitersOfType(db, phase === 'write' ? 'transactionid' : 'advisory', 1, 1500);
      expect(await db.compiledPromptRevision.count()).toBe(0);
    } finally { release(); await firstResult; await secondResult; }
    expect(await firstResult).toHaveProperty('value');
    expect(await secondResult).toHaveProperty('value');
    const receipt = await db.compiledPromptRevision.findFirstOrThrow();
    const output = await db.node.findUniqueOrThrow({ where: { id: receipt.compiledNodeId } });
    expect(output.content).toBe(phase === 'writer-first' ? 'After' : 'Before');
    expect(receipt.provenance).toMatchObject({ occurrences: [{}, { nodeId: source.id, revNo: phase === 'writer-first' ? 2 : 1 }] });
    expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe('After');
  } finally { release(); restoreHook?.(); }
});
