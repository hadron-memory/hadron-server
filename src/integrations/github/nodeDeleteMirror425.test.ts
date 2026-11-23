/**
 * #425 — a node delete leaves a PENDING REMOVE obligation in a Git-synced, unencrypted memory,
 * the sweep applies it (id-guarded), and a sync after the apply cannot resurrect the node.
 *
 * Real git against a temp BARE remote, no network (the #2308 harness: `execGit` runs real git with
 * every protocol refused but `file`, and one `insteadOf` rule rewrites the memory's github URL to
 * the bare repo). `gitBranch.js` is NOT mocked. `child_process.execFile` is mocked ONLY for the
 * syncGraphFromGithub leg (canned git answers, exactly as syncGraphFromGithub.test.ts does), while
 * `execFileSync` stays real for this file's own git calls. The checkout lock is wrapped, never replaced:
 * the wrapper records each arrival and acquisition, and `execGit` can hold one call, so a pin can commit
 * a restore in the middle of the sweep's removal. Rows are read straight from
 * `git_mirror_obligations`; deletes are driven straight at `nodes`, below every writer (resolver,
 * MCP delegate, merge, cascade) the same trigger serves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { db } from '../db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph, writeFrontmatterNode } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const env = vi.hoisted(() => ({
  failure: null as unknown, root: '', bare: '', failOn: null as null | ((args: string[]) => boolean),
  /** A one-shot hold: the FIRST matching `execGit` call signals `entered`, then waits for `released`. */
  hold: null as null | { on: (args: string[]) => boolean; entered: () => void; released: Promise<void> },
  /** Checkout-lock arrivals and acquisitions, in order (the wrapper mock below). */
  lockEvents: [] as string[],
}));
const TOKEN = 'tok-425-secret';
const SOURCE = 'https://github.com/acme/repo-425.git';
vi.mock('./githubApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./githubApp.js')>()),
  getInstallationToken: vi.fn(async () => TOKEN),
}));
vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return { ...real, get GRAPHS_PATH() { return env.root; } };
});
// Only execFile is canned (syncGraphFromGithub's git leg); execFileSync stays real for this file.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    execFile: vi.fn((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as Function;
      if (typeof cb !== 'function') return;
      cb(null, {
        stdout: argv.includes('ls-remote') ? 'ref: refs/heads/main\tHEAD\n' : argv.includes('rev-list') ? '0\n' : '',
        stderr: '',
      });
    }),
  };
});
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    if (env.failOn?.(args)) throw env.failure ?? new Error('Git command failed. Check the repository and branch, then retry.');
    const hold = env.hold;
    if (hold?.on(args)) { env.hold = null; hold.entered(); await hold.released; }
    const stdout = execFileSync('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
      '-c', `url.${env.bare}.insteadOf=${SOURCE.replace('https://github.com/', `https://x-access-token:${TOKEN}@github.com/`)}`,
      ...args,
    ], { ...options, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '' };
  }),
}));

// Observe the checkout lock's queue WITHOUT replacing the real lock (the #430 sweep harness's pattern): every
// arrival and every acquisition is recorded, so a pin can tell "queued behind" from "ran alongside".
vi.mock('./mirrorCheckoutLock.js', async importOriginal => {
  const real = await importOriginal<typeof import('./mirrorCheckoutLock.js')>();
  return {
    ...real,
    withMirrorCheckoutLock: <T>(id: string, work: () => Promise<T>, opts?: { fenceEncryption?: boolean }) => {
      env.lockEvents.push('requested');
      return real.withMirrorCheckoutLock(id, async () => { env.lockEvents.push('acquired'); return work(); }, opts);
    },
  };
});

import { gitMirrorSweepTick } from '../../jobs/sweepGitMirrorObligations.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { nodeFilePath } from './nodeFrontmatter.js';
import { memoryLocalPath } from './gitMirrorCheckout.js';
import { writeNodeToGit } from './writeNodeToGit.js';
import { validateMemoryNodes } from '../../lib/memoryValidation.js';

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENT } }).trim();

let memoryId: string;
let local: string;

interface SetupOpts {
  repo?: boolean;
  writeBranch?: string | null;
  readBranch?: string | null;
  encrypted?: boolean;
  noSource?: boolean;
  softDeletedMemory?: boolean;
}

async function setup(opts: SetupOpts = {}) {
  const withRepo = opts.repo !== false;
  if (withRepo) {
    env.bare = mkdtempSync(join(tmpdir(), 'hadron-425-bare-'));
    git(env.bare, 'init', '--bare', '-b', 'main');
    const seed = mkdtempSync(join(tmpdir(), 'hadron-425-seed-'));
    git(seed, 'init', '-b', 'main');
    git(seed, 'commit', '--allow-empty', '-m', 'seed');
    git(seed, 'push', env.bare, '--all');
    rmSync(seed, { recursive: true, force: true });
  }
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'org425', graphName: 'repo425' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 4242 } });
  await db.memory.update({
    where: { id: graph.id },
    data: {
      source: opts.noSource ? null : SOURCE,
      ...(opts.readBranch !== undefined ? { readBranch: opts.readBranch } : {}),
      ...(opts.writeBranch !== undefined ? { writeBranch: opts.writeBranch } : {}),
      ...(opts.encrypted ? { isEncrypted: true } : {}),
      ...(opts.softDeletedMemory ? { deletedAt: new Date() } : {}),
    },
  });
  memoryId = graph.id;
  local = memoryLocalPath(org.urn, graph.urn);
  if (withRepo) cloneRemote();
  return { org, graph };
}

/** Clone the bare remote into the memory's local path, as a first mirror write or sync would. */
const cloneRemote = () => {
  mkdirSync(dirname(local), { recursive: true });
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`, 'clone', SOURCE, local], { stdio: 'ignore' });
};
const sequenceValue = () => db.$queryRaw<Array<{ value: string; is_called: boolean }>>`SELECT last_value::text AS value, is_called FROM git_mirror_attempt_seq`;
/** Poll until `done` holds; fails the test after five seconds instead of hanging a held sweep forever. */
const eventually = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!done()) throw new Error('not reached within five seconds');
};

const makeNode = (loc: string, id = generateId()) => createDbNode(db, { id, loc, memoryId, name: loc || 'root' });
const softDelete = (id: string) => db.node.update({ where: { id }, data: { deletedAt: new Date() } });
const restore = (id: string) => db.node.update({ where: { id }, data: { deletedAt: null } });

const rows = () => db.gitMirrorObligation.findMany({ where: { memoryId }, orderBy: [{ nodeId: 'asc' }] });
const owed = (nodeId: string, loc: string, branch = 'hadron-updates') =>
  expect.objectContaining({ nodeId, kind: 'REMOVE' as const, removeLoc: loc, branch, state: 'PENDING' as const, errorClass: 'PENDING' as const, attempts: 1 });

/**
 * Put the fixture files on the write branch only, the way a real mirror write did: main keeps its seed
 * commit, hadron-updates carries the nodes. The working tree stays on hadron-updates.
 */
const commitFixtures = (files: string[]) => {
  git(local, 'checkout', '-b', 'hadron-updates');
  git(local, 'add', ...files);
  git(local, 'commit', '-m', 'fixtures');
  git(local, 'push', env.bare, 'hadron-updates');
};

beforeEach(async () => {
  env.root = mkdtempSync(join(tmpdir(), 'hadron-425-'));
  env.failOn = null;
  env.failure = null;
  env.hold = null;
  env.lockEvents = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await cleanDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(env.root, { recursive: true, force: true });
  if (env.bare) rmSync(env.bare, { recursive: true, force: true });
});

describe('#425 a node delete leaves a PENDING REMOVE obligation', () => {
  it('a soft-deleted node owes one PENDING REMOVE row for its loc', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
  });

  it('the row carries the memory write branch when one is configured', async () => {
    await setup({ repo: false, writeBranch: 'feature/x' });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a', 'feature/x')]);
  });

  it('a {client} template write branch owes nothing: no client identity to key the debt on', async () => {
    // The eligibility predicates accept the raw template as fitting itself, so a row keyed on it would be
    // routed to a literal client/{client} branch (findings:raw-template-branch-fits-itself). #3042: never
    // substitute an unknown client — a templated delete does not propagate, as on main today.
    await setup({ repo: false, writeBranch: 'client/{client}' });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([]);
  });

  it('a hard-deleted node owes the same row', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await db.node.delete({ where: { id: node.id } });
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
  });

  it('a deleted subtree owes one row per deleted node', async () => {
    await setup({ repo: false });
    const parent = await makeNode('docs:p');
    const child = await makeNode('docs:p:README');
    const leaf = await makeNode('docs:other');
    await db.node.deleteMany({ where: { memoryId, id: { in: [parent.id, child.id, leaf.id] } } });
    const found = await rows();
    expect(found).toHaveLength(3);
    expect(found.map(r => `${r.nodeId}:${r.removeLoc}`).sort()).toEqual(
      [`${child.id}:docs:p:README`, `${leaf.id}:docs:other`, `${parent.id}:docs:p`].sort());
    for (const r of found) {
      expect(r).toEqual(expect.objectContaining({
        kind: 'REMOVE' as const, state: 'PENDING' as const, errorClass: 'PENDING' as const, attempts: 1, branch: 'hadron-updates',
      }));
    }
  });

  it('a deleted root owes nothing: the root README is the memory, not a node file', async () => {
    await setup({ repo: false });
    const root = await makeNode('');
    await db.node.delete({ where: { id: root.id } });
    expect(await rows()).toEqual([]);
  });

  it('re-deleting an already-deleted node keeps exactly one row at one attempt', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
  });

  it('a DB-only memory (no source) owes nothing', async () => {
    await setup({ repo: false, noSource: true });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([]);
  });

  it('a user-owned memory (a source, but no organization) owes nothing: no sweep could ever select it', async () => {
    // The capture's organization predicate is no other pin's subject (review: a mutant dropping it survived).
    // Such a row is due the moment it exists, and the sweep's candidate query joins organizations, so it
    // would never be selected: "waiting for the next mirror sweep" for good.
    await setup({ repo: false });
    const owner = await db.user.create({ data: { githubId: 425999, githubUsername: 'owner-425' } });
    await db.memory.update({ where: { id: memoryId }, data: { organizationId: null, ownerUserId: owner.id } });
    const soft = await makeNode('docs:a');
    await softDelete(soft.id);
    await db.node.delete({ where: { id: (await makeNode('docs:b')).id } });
    expect(await rows()).toEqual([]);
  });

  it('an encrypted memory owes nothing: it never had a mirror to clean', async () => {
    await setup({ repo: false, encrypted: true });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([]);
  });

  it('a node deleted in an already-soft-deleted memory owes nothing', async () => {
    await setup({ repo: false, softDeletedMemory: true });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([]);
  });

  it('a memory delete still succeeds and leaves no debt: the mirror dies with the memory', async () => {
    await setup({ repo: false });
    await makeNode('docs:a');
    await db.memory.delete({ where: { id: memoryId } });
    expect(await db.memory.findUnique({ where: { id: memoryId } })).toBeNull();
    expect(await db.gitMirrorObligation.findMany({ where: { memoryId } })).toEqual([]);
  });

  it('a restore cancels the unapplied debt, and deleting again re-owes it fresh', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
    await restore(node.id);
    expect(await rows()).toEqual([]);
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
  });

  it('a fresh capture reads as waiting for the sweep, not as a failure against the repository', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    const findings = (await validateMemoryNodes(db, memoryId)).findings.filter(f => f.kind === 'GIT_MIRROR_FAILED');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toBe('Git mirror removal of this path is waiting for the next mirror sweep; not yet applied');
    expect(findings[0]!.nodeLoc).toBe('docs:a');
  });

  it('a restore also cancels an own-loc row the sweep exhausted; a vacated-loc row survives', async () => {
    await setup({ repo: false });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    // Age the capture to EXHAUSTED exactly as ten failed attempts leave it: the sweep no longer selects
    // such a row, so without this cancellation it would read as a mirror failure forever after a restore.
    await db.gitMirrorObligation.updateMany({
      where: { memoryId },
      data: { state: 'EXHAUSTED', errorClass: 'PUSH_FAILED', attempts: 10 },
    });
    // A move's vacated-loc debt on the same node is not the node's current file: the move still owes it.
    await db.gitMirrorObligation.create({ data: {
      memoryId, nodeId: node.id, kind: 'REMOVE', removeLoc: 'docs:old', branch: 'hadron-updates',
      state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 2, attemptSeq: 2n, lastAttemptAt: new Date(),
    } });
    await restore(node.id);
    expect(await rows()).toEqual([expect.objectContaining({ removeLoc: 'docs:old', state: 'FAILED' as const })]);
  });
});

describe('#425 the sweep applies a PENDING REMOVE obligation', () => {
  it('removes the file (locally and on the remote branch) and clears the row when the frontmatter names the node id', async () => {
    await setup();
    const root = await makeNode('');
    const node = await makeNode('docs:a');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    const file = nodeFilePath(local, 'docs:a');
    writeFrontmatterNode(file, { id: node.id, name: 'a' }, 'body');
    commitFixtures(['README.md', 'docs/a.md']);
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(existsSync(file)).toBe(false);
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).not.toContain('docs/a.md');
    expect(await rows()).toEqual([]);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).deletedAt).not.toBeNull();
  });

  it('keeps the file and records TREE_WRITE when the frontmatter names a different node id', async () => {
    await setup();
    const node = await makeNode('docs:a');
    const file = nodeFilePath(local, 'docs:a');
    writeFrontmatterNode(file, { id: generateId(), name: 'someone else' }, 'body');
    commitFixtures(['docs/a.md']);
    await softDelete(node.id);
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(existsSync(file)).toBe(true);
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).toContain('docs/a.md');
    expect(await rows()).toEqual([expect.objectContaining({
      nodeId: node.id, kind: 'REMOVE' as const, removeLoc: 'docs:a', state: 'FAILED' as const, errorClass: 'TREE_WRITE' as const, attempts: 2,
    })]);
  });

  it('with no local clone the capture settles NOT_CLONED: the debt is kept, backs off, and applies when the clone returns (#425 review)', async () => {
    await setup();
    const node = await makeNode('docs:a');
    writeFrontmatterNode(nodeFilePath(local, 'docs:a'), { id: node.id, name: 'a' }, 'body');
    commitFixtures(['docs/a.md']);
    // The clone is gone (another host, an evicted checkout). The delete still succeeds, and the sweep never clones (#430).
    rmSync(local, { recursive: true, force: true });
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
    // A capture is due the moment it exists and a skip runs no attempt: left alone, this row was selected on EVERY
    // tick, forever, reading "waiting for the next mirror sweep". The skip settles it instead, to the state an
    // ordinary writer's un-cloned attempt records.
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    const settled = [expect.objectContaining({
      nodeId: node.id, kind: 'REMOVE' as const, removeLoc: 'docs:a', state: 'NOT_CLONED' as const, errorClass: 'NOT_CLONED' as const, attempts: 2,
    })];
    expect(await rows()).toEqual(settled);
    // `validate` stops reading "waiting for the next mirror sweep": this is an ordinary recorded failure now.
    const report = await validateMemoryNodes(db, memoryId);
    expect(report.findings.filter(f => f.kind === 'GIT_MIRROR_FAILED').map(f => f.detail)).toEqual([
      'Git mirror removal of this path did not land (NOT_CLONED, 2 attempts); the repository may be stale',
    ]);
    // Now it backs off like any other debt: not due yet...
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(await rows()).toEqual(settled);
    // ...and due again but still un-cloned, the pass skips it byte-identically, with no attempt and no sequence (#3060).
    const seq = await sequenceValue();
    expect(await gitMirrorSweepTick(db, new Date(Date.now() + 16 * 60_000))).toBe(0);
    expect(await rows()).toEqual(settled);
    expect(await sequenceValue()).toEqual(seq);
    // The clone returns: the kept debt applies on the pass after its backoff.
    cloneRemote();
    expect(await gitMirrorSweepTick(db, new Date(Date.now() + 21 * 60_000))).toBe(1);
    expect(await rows()).toEqual([]);
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).not.toContain('docs/a.md');
  });

  it('an invalid stored source voids the capture instead of skipping it forever: not mirrored means nothing owed (#425 review)', async () => {
    // With a clone present: the source check comes first, so no Git runs against a source this server refuses.
    await setup();
    await db.memory.update({ where: { id: memoryId }, data: { source: 'not-a-github-source' } });
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(await rows()).toEqual([]);
  });

  it('a delete with an unreachable remote keeps the debt: the attempt fails soft as BRANCH_SETUP', async () => {
    await setup();
    const node = await makeNode('docs:a');
    await softDelete(node.id);
    env.failOn = args => args[0] === 'fetch';
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(await rows()).toEqual([expect.objectContaining({
      nodeId: node.id, kind: 'REMOVE' as const, removeLoc: 'docs:a', state: 'FAILED' as const, errorClass: 'BRANCH_SETUP' as const, attempts: 2,
    })]);
  });

  it('a restore after the debt was applied re-writes the file: it is never left removed', async () => {
    await setup();
    const root = await makeNode('');
    const node = await makeNode('docs:a');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    writeFrontmatterNode(nodeFilePath(local, 'docs:a'), { id: node.id, name: 'a' }, 'body');
    commitFixtures(['README.md', 'docs/a.md']);
    await softDelete(node.id);
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(await rows()).toEqual([]);
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).not.toContain('docs/a.md');
    // The applied debt is gone; the restore runs the ordinary mirror write every writer runs, and the
    // file comes back (item 2: never left removed).
    const restored = await restore(node.id);
    await writeNodeToGit({ ...restored, outgoingEdges: [] }, '', null, memoryId);
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).toContain('docs/a.md');
  });

  it('a restore committing while the sweep is mid-removal still ends with the file back (#425 review)', async () => {
    await setup();
    const root = await makeNode('');
    const node = await makeNode('docs:a');
    const file = nodeFilePath(local, 'docs:a');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    writeFrontmatterNode(file, { id: node.id, name: 'a' }, 'body');
    commitFixtures(['README.md', 'docs/a.md']);
    await softDelete(node.id);
    // Hold the sweep INSIDE the checkout lock: it has re-read the row, found no live owner, removed the file
    // and staged the removal, and is about to commit. A restore committing here is the interleaving the
    // sequential pin above cannot reach: the owner check has already been made.
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    env.hold = { on: args => args[0] === 'commit', entered: enter, released: held };
    const sweeping = gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    await entered;
    // The sweep holds the checkout lock.
    expect(env.lockEvents).toEqual(['requested', 'acquired']);
    let writing: Promise<unknown> = Promise.resolve();
    try {
      expect(existsSync(file)).toBe(false);
      const restored = await restore(node.id);
      // The cancel trigger takes the row the sweep is working on, so the sweep's own clear is then a no-op.
      expect(await rows()).toEqual([]);
      // Every restore publishes node.written, and that mirror write takes the same checkout lock: it queues.
      writing = writeNodeToGit({ ...restored, outgoingEdges: [] }, '', null, memoryId);
      await eventually(() => env.lockEvents.length === 3);
      expect(env.lockEvents).toEqual(['requested', 'acquired', 'requested']);
    } finally {
      release();
      await Promise.all([sweeping, writing]);
    }
    // The sweep's removal was pushed first; the restore's write, queued behind it, put the file back.
    expect(env.lockEvents).toEqual(['requested', 'acquired', 'requested', 'acquired']);
    expect(await rows()).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).toContain('docs/a.md');
  });

  it('under a row budget a pass takes the oldest-due row first, a capture and a failed debt alike, and leaves the rest untouched', async () => {
    await setup();
    const root = await makeNode('');
    const failed = await makeNode('docs:failed');
    const earlier = await makeNode('docs:earlier');
    const later = await makeNode('docs:later');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    for (const n of [failed, earlier, later]) writeFrontmatterNode(nodeFilePath(local, n.loc), { id: n.id, name: n.loc }, 'body');
    commitFixtures(['README.md', 'docs/failed.md', 'docs/earlier.md', 'docs/later.md']);
    await softDelete(failed.id);
    await softDelete(earlier.id);
    await softDelete(later.id);
    // Due times are set, not the microseconds between two captures: the first debt's attempt failed once (two
    // attempts, its 10-minute backoff elapsed), so it is the oldest, then the earlier capture, then the later
    // one. A capture is due the moment it exists.
    const now = Date.now();
    await db.gitMirrorObligation.updateMany({ where: { nodeId: failed.id }, data: {
      state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 2, lastAttemptAt: new Date(now - 30 * 60_000),
    } });
    await db.gitMirrorObligation.updateMany({ where: { nodeId: earlier.id }, data: { lastAttemptAt: new Date(now - 3 * 60_000) } });
    await db.gitMirrorObligation.updateMany({ where: { nodeId: later.id }, data: { lastAttemptAt: new Date(now - 60_000) } });
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '1');
    try {
      // One row per pass, oldest due first; every other row is byte-identical until its own pass.
      for (const taken of [failed, earlier, later]) {
        const before = JSON.stringify(await rows(), (_, v) => typeof v === 'bigint' ? v.toString() : v);
        expect(await gitMirrorSweepTick(db, new Date(now + 60_000))).toBe(1);
        const after = JSON.stringify((await rows()).filter(r => r.nodeId !== taken.id), (_, v) => typeof v === 'bigint' ? v.toString() : v);
        expect(after).toBe(JSON.stringify(JSON.parse(before).filter((r: { nodeId: string }) => r.nodeId !== taken.id)));
        expect(await db.gitMirrorObligation.findMany({ where: { memoryId, nodeId: taken.id } })).toEqual([]);
      }
      expect(await gitMirrorSweepTick(db, new Date(now + 60_000))).toBe(0);
      expect(git(env.bare, 'ls-tree', '-r', '--name-only', 'hadron-updates')).not.toMatch(/docs\/failed.md|docs\/earlier.md|docs\/later.md/);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('#425 the resurrection window', () => {
  // The window pins read the WRITE branch (readBranch: 'hadron-updates'), the branch the mirror
  // removes from, so what the sync sees is exactly what the obligation owed. With a separate read
  // branch the same window simply lasts until that branch merges the removal — the pre-existing
  // repo-wins rule for every mirror write, unchanged by #425.
  it('a sync after the obligation is applied does not resurrect the node', async () => {
    await setup({ readBranch: 'hadron-updates' });
    const root = await makeNode('');
    const node = await makeNode('docs:a');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    writeFrontmatterNode(nodeFilePath(local, 'docs:a'), { id: node.id, name: 'a' }, 'body');
    commitFixtures(['README.md', 'docs/a.md']);
    // Hard delete: the row is gone, so a later sync minting a node from the still-present file is
    // the resurrection risk item 5 names. (A soft-deleted row is not resurrectable by sync at all.)
    await db.node.delete({ where: { id: node.id } });
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(await rows()).toEqual([]);
    expect(existsSync(nodeFilePath(local, 'docs:a'))).toBe(false);
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, include: { organization: true } });
    const result = await syncGraphFromGithub(memory as MemoryWithOrg);
    expect(result.error).toBeUndefined();
    expect(await db.node.findFirst({ where: { memoryId, loc: 'docs:a' } })).toBeNull();
  });

  it('a node resurrected while the debt is PENDING keeps its file: the sweep clears the debt instead', async () => {
    await setup({ readBranch: 'hadron-updates' });
    const root = await makeNode('');
    const node = await makeNode('docs:a');
    const file = nodeFilePath(local, 'docs:a');
    writeFrontmatterNode(join(local, 'README.md'), { id: root.id, name: 'root' }, 'root');
    writeFrontmatterNode(file, { id: node.id, name: 'a' }, 'body');
    commitFixtures(['README.md', 'docs/a.md']);
    await db.node.delete({ where: { id: node.id } });
    expect(await rows()).toEqual([owed(node.id, 'docs:a')]);
    // Repo wins while the debt is unapplied: with the row gone the sync mints a live node at that
    // loc from the still-present file. That live owner is what the sweep checks before removing.
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, include: { organization: true } });
    const result = await syncGraphFromGithub(memory as MemoryWithOrg);
    expect(result.error).toBeUndefined();
    const liveOwner = await db.node.findFirst({ where: { memoryId, loc: 'docs:a', deletedAt: null } });
    expect(liveOwner).not.toBeNull();
    // The live owner at that loc voids the removal: the debt clears without touching the file.
    await gitMirrorSweepTick(db, new Date(Date.now() + 60_000));
    expect(await rows()).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});
