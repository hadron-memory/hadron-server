/**
 * #2308 — a retry after a failed mirror push must publish the commit the failed
 * attempt left on the write branch (Refs #430, #425).
 *
 * Real git against a temp BARE remote, no network. `execGit` is replaced by a
 * wrapper that runs real git with the transport guard inverted: every protocol
 * is refused except `file`, and one `insteadOf` rule rewrites the memory's
 * github URL to the bare repo, so the stored source stays a valid github URL
 * (validateMemorySource refuses a path) while any other URL fails instead of
 * reaching the network. `gitBranch.js` is NOT mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const env = vi.hoisted(() => ({
  root: '', bare: '', failOn: null as null | ((args: string[]) => boolean),
}));
vi.mock('../../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    if (env.failOn?.(args)) throw new Error('Git command failed. Check the repository and branch, then retry.');
    try {
      const stdout = execFileSync('git', [
        '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
        '-c', `url.${env.bare}.insteadOf=${SOURCE}`, ...args,
      ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout, stderr: '' };
    } catch {
      throw new Error('Git command failed. Check the repository and branch, then retry.');
    }
  }),
}));

import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { pushMemoryToGit } from './pushMemoryToGit.js';

const SOURCE = 'https://github.com/acme/repo.git';
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim();

let memoryId: string;
let local: string;
let errors: string[];

/** Seed the bare remote: `main` (HEAD) and optionally `develop` one commit ahead of it. */
function seedRemote(opts: { develop?: boolean; empty?: boolean } = {}) {
  git(env.bare, 'init', '--bare', '-b', 'main');
  if (opts.empty) return;
  const seed = mkdtempSync(join(tmpdir(), 'hadron-seed-'));
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'seed.txt'), 'seed');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed');
  if (opts.develop) {
    git(seed, 'checkout', '-b', 'develop');
    writeFileSync(join(seed, 'dev.txt'), 'dev');
    git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'dev');
    git(seed, 'checkout', 'main');
  }
  git(seed, 'push', env.bare, '--all');
  rmSync(seed, { recursive: true, force: true });
}

async function setup(opts: { develop?: boolean; empty?: boolean; readBranch?: string } = {}) {
  seedRemote(opts);
  const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: 'mirror2308-org' } });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, name: 'mem', urn: 'mirror2308-org:mem',
      class: 'knowledge', source: SOURCE, readBranch: opts.readBranch ?? null,
    },
  });
  memoryId = memory.id;
  local = join(env.root, org.urn, 'mem');
  mkdirSync(join(env.root, org.urn), { recursive: true });
  // The clone's origin is the github URL, rewritten to the bare repo by insteadOf.
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
    'clone', ...(opts.readBranch ? ['--branch', opts.readBranch] : []), SOURCE, local], { stdio: 'ignore' });
}

const run = (content: readonly [string, string] | null) =>
  withMirrorCheckout({ memoryId, commitSubject: 'mirror write', logPrefix: '[t]' }, ({ localPath }) => {
    if (content) writeFileSync(join(localPath, content[0]), content[1]);
  });
const remoteTip = (branch: string) => {
  try { return git(env.bare, 'rev-parse', `refs/heads/${branch}`); } catch { return null; }
};
const localTip = (branch: string) => git(local, 'rev-parse', `refs/heads/${branch}`);
const rejectPushes = () => {
  const hook = join(env.bare, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
};
const allowPushes = () => rmSync(join(env.bare, 'hooks', 'pre-receive'), { force: true });

beforeEach(async () => {
  env.root = mkdtempSync(join(tmpdir(), 'hadron-2308-'));
  env.bare = mkdtempSync(join(tmpdir(), 'hadron-2308-bare-'));
  env.failOn = null;
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await cleanDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});

const originUrl = () => git(local, 'remote', 'get-url', 'origin');

describe('withMirrorCheckout — unpublished commit on the write branch (#2308)', () => {
  it('(A/d) no origin twin, one commit past base: a retry after a failed push publishes it', async () => {
    await setup();
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    expect(remoteTip('hadron-updates')).toBeNull();
    allowPushes();
    expect(await run(null)).toBe('mirrored');
    expect(remoteTip('hadron-updates')).toBe(localTip('hadron-updates'));
    expect(originUrl()).toBe(SOURCE);
  });

  it('(f) origin twin exists and the local branch is ahead by one: the retry pushes it', async () => {
    await setup();
    expect(await run(['a.txt', 'one'])).toBe('mirrored');
    rejectPushes();
    expect(await run(['b.txt', 'two'])).toBe('failed');
    expect(remoteTip('hadron-updates')).not.toBe(localTip('hadron-updates'));
    allowPushes();
    expect(await run(null)).toBe('mirrored');
    expect(remoteTip('hadron-updates')).toBe(localTip('hadron-updates'));
  });

  it('(C) clean and synced stays no-changes and leaves the remote alone', async () => {
    await setup();
    expect(await run(['a.txt', 'one'])).toBe('mirrored');
    const tip = remoteTip('hadron-updates');
    expect(await run(null)).toBe('no-changes');
    expect(remoteTip('hadron-updates')).toBe(tip);
  });

  it('(C) a diverged remote keeps failing and the local commit is preserved', async () => {
    await setup();
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    allowPushes();
    const mine = localTip('hadron-updates');
    // Someone else publishes the same branch name from main with a different commit.
    const other = mkdtempSync(join(tmpdir(), 'hadron-other-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', env.bare, other], { stdio: 'ignore' });
    git(other, 'checkout', '-b', 'hadron-updates');
    writeFileSync(join(other, 'x.txt'), 'x'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'x');
    git(other, 'push', 'origin', 'hadron-updates'); rmSync(other, { recursive: true, force: true });
    expect(await run(null)).toBe('failed');
    expect(localTip('hadron-updates')).toBe(mine);
    expect(originUrl()).toBe(SOURCE);
  });

  it('(D) an unknown ahead state is failed, never no-changes', async () => {
    await setup();
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    allowPushes();
    env.failOn = (args) => args[0] === 'rev-list';
    expect(await run(null)).toBe('failed');
    expect(remoteTip('hadron-updates')).toBeNull();
  });

  it('(a) read branch is not origin/HEAD: one commit past the read branch is published', async () => {
    await setup({ develop: true, readBranch: 'develop' });
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    allowPushes();
    expect(await run(null)).toBe('mirrored');
    expect(remoteTip('hadron-updates')).toBe(localTip('hadron-updates'));
  });

  it('(b) read branch is not origin/HEAD: a write branch level with the read branch is no-changes', async () => {
    await setup({ develop: true, readBranch: 'develop' });
    // A mutation that changes nothing creates the branch from origin/develop with no extra commit.
    expect(await run(null)).toBe('no-changes');
    expect(remoteTip('hadron-updates')).toBeNull();
    // origin/HEAD (main) is a different commit; the old origin/HEAD comparison would have counted develop's extra commit.
    expect(git(local, 'rev-parse', 'origin/HEAD')).not.toBe(git(local, 'rev-parse', 'origin/develop'));
  });

  it('(c) a local write branch with no twin and no extra commit is no-changes', async () => {
    await setup();
    expect(await run(null)).toBe('no-changes');
    expect(remoteTip('hadron-updates')).toBeNull();
  });

  it('(e) an empty remote has no fork point, so a retry is failed rather than no-changes', async () => {
    await setup({ empty: true });
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    allowPushes();
    expect(await run(null)).toBe('failed');
    expect(remoteTip('hadron-updates')).toBeNull();
  });

  it('a failed origin-URL restore changes no outcome and leaks nothing to the log', async () => {
    await setup();
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    allowPushes();
    env.failOn = (args) => args[0] === 'remote' && args[1] === 'set-url';
    expect(await run(null)).toBe('mirrored');
    expect(remoteTip('hadron-updates')).toBe(localTip('hadron-updates'));
    for (const line of errors) {
      expect(line).not.toContain('github.com');
      expect(line).not.toContain(env.bare);
      expect(line).not.toContain('x-access-token');
    }
  });
});

describe('pushMemoryToGit — the same unpublished-commit retry (#2308)', () => {
  it('a retry after a failed full push publishes the commit the failure left behind', async () => {
    await setup();
    const before = remoteTip('main'); // a full push's default write branch is main
    rejectPushes();
    expect((await pushMemoryToGit(memoryId)).error).toMatch(/Commit\/push failed/);
    expect(remoteTip('main')).toBe(before);
    allowPushes();
    expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
    expect(remoteTip('main')).toBe(localTip('main'));
    expect(remoteTip('main')).not.toBe(before);
    expect(originUrl()).toBe(SOURCE);
  });

  it('an unknown ahead state is an error, not a silent success', async () => {
    await setup();
    const before = remoteTip('main');
    rejectPushes();
    await pushMemoryToGit(memoryId);
    allowPushes();
    env.failOn = (args) => args[0] === 'rev-list';
    expect((await pushMemoryToGit(memoryId)).error).toMatch(/Commit\/push failed/);
    expect(remoteTip('main')).toBe(before);
  });
});
