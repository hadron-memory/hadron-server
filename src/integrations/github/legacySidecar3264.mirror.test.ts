/**
 * #3264, mirror paths: the full-memory push loop and the retry sweep (checkpoint + rollback) run
 * the same legacy-sidecar cleanup as the incremental writers, on a real checkout and a real
 * bare remote (file transport, no network). Unit-level pins live in legacySidecar3264.test.ts.
 *
 * The rollback pin injects its failure at `rmdirSync`, which only the non-recursive helper calls;
 * it pins the new contract (rollback restores exactly the owned file) rather than a main-side bug.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { gitMirrorSweepTick } from '../../jobs/sweepGitMirrorObligations.js';
import { takeAttemptSeq } from './mirrorObligations.js';
import { mirrorMutationMarker } from './mirrorFileMutation.js';

// Record every checkpoint copy, and let one test fail the helper's directory removal.
vi.mock('fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, cpSync: vi.fn(fs.cpSync), rmdirSync: vi.fn(fs.rmdirSync) };
});
import * as fs from 'fs';

vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fixture-token'), toHttpsUrl: (source: string) => source }));

const SOURCE = 'https://github.com/synthetic/data3264.git';
const env = vi.hoisted(() => ({ root: '', bare: '' }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  get GRAPHS_PATH() { return env.root; },
}));
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => ({
    stdout: execFileSync('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', `url.${env.bare}.insteadOf=https://github.com/synthetic/data3264.git`,
      ...args.map(a => a.replace('https://x-access-token:fixture-token@github.com/', 'https://github.com/')),
    ], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    stderr: '',
  })),
}));
import { pushMemoryToGit } from './pushMemoryToGit.js';

const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const checkout = () => join(env.root, 'data3264-org', 'fixture');
const put = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
let memoryId: string;

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  env.root = mkdtempSync(join(tmpdir(), 'hadron-3264-'));
  env.bare = mkdtempSync(join(tmpdir(), 'hadron-3264-bare-'));
  const seed = mkdtempSync(join(tmpdir(), 'hadron-3264-seed-'));
  try {
    git(env.bare, 'init', '--bare', '-b', 'main');
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, '.gitkeep'), '');
    git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed');
    git(seed, 'push', env.bare, 'main');
  } finally { rmSync(seed, { recursive: true, force: true }); }
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Sidecar fixture', urn: 'data3264-org', githubInstallationId: 123 } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Sidecar', urn: 'data3264-org:fixture', class: 'knowledge', source: SOURCE, readBranch: 'main', writeBranch: 'main' } });
  memoryId = memory.id;
  vi.mocked(fs.cpSync).mockClear();
  vi.mocked(fs.rmdirSync).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});

/** Create the real checkout (first push), then add one local commit that exists nowhere else. */
async function checkoutWithUnpublishedCommit() {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'seed', name: 'seed', content: 'seed' } });
  expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
  writeFileSync(join(checkout(), 'local.txt'), 'unpublished');
  git(checkout(), 'add', '-A'); git(checkout(), 'commit', '-m', 'unpublished local commit');
}
const survives = () => {
  expect(lstatSync(join(checkout(), '.git')).isDirectory()).toBe(true);
  expect(git(checkout(), 'log', '--format=%s')).toContain('unpublished local commit');
};
const dueRow = async (nodeId: string, kind: 'WRITE' | 'REMOVE', removeLoc = '') =>
  db.gitMirrorObligation.create({ data: {
    memoryId, nodeId, kind, removeLoc, branch: 'main', state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 1,
    attemptSeq: await takeAttemptSeq(db), lastAttemptAt: new Date(Date.now() - 86400000),
  } });

it('push loop: a node with loc `git` is exported without deleting the checkout .git', async () => {
  await checkoutWithUnpublishedCommit();
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'git', name: 'git', content: 'about git' } });
  const result = await pushMemoryToGit(memoryId);
  expect(result.error).toBeUndefined();
  survives();
  expect(git(env.bare, 'show', 'refs/heads/main:git.md')).toContain('about git');
});

it('sweep WRITE: a loc `git` row settles and the checkout .git survives', async () => {
  await checkoutWithUnpublishedCommit();
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'git', name: 'git', content: 'retried git' } });
  await dueRow(node.id, 'WRITE');
  expect(await gitMirrorSweepTick(db)).toBe(1);
  expect(await db.gitMirrorObligation.count({ where: { memoryId, nodeId: node.id } })).toBe(0);
  survives();
  expect(git(env.bare, 'show', 'refs/heads/main:git.md')).toContain('retried git');
});

it('sweep REMOVE: a loc `git` row settles and the checkout .git survives', async () => {
  await checkoutWithUnpublishedCommit();
  const gone = await db.node.create({ data: { id: generateId(), memoryId, loc: 'git', name: 'git', content: 'x', deletedAt: new Date() } });
  put(join(checkout(), 'git.md'), `---\nid: ${gone.id}\nname: git\n---\n\nx\n`);
  git(checkout(), 'add', '-A'); git(checkout(), 'commit', '-m', 'unpublished local commit 2');
  await dueRow(gone.id, 'REMOVE', 'git');
  expect(await gitMirrorSweepTick(db)).toBe(1);
  expect(await db.gitMirrorObligation.count({ where: { memoryId, nodeId: gone.id } })).toBe(0);
  survives();
  expect(existsSync(join(checkout(), 'git.md'))).toBe(false);
});

it('sweep WRITE: checkpoints only the owned edges.yaml file, never the sidecar directory', async () => {
  await checkoutWithUnpublishedCommit();
  const sidecar = join(checkout(), 'a', '.b');
  put(join(sidecar, 'edges.yaml'), '- {id: X, rel: stale}\n');
  put(join(sidecar, 'keep.txt'), 'not ours');
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'a:b', name: 'b', content: 'fresh' } });
  await dueRow(node.id, 'WRITE');
  vi.mocked(fs.cpSync).mockClear();
  expect(await gitMirrorSweepTick(db)).toBe(1);
  const copied = vi.mocked(fs.cpSync).mock.calls.map(c => String(c[0]));
  expect(copied).not.toContain(sidecar);
  expect(copied).toContain(join(sidecar, 'edges.yaml'));
  expect(existsSync(join(sidecar, 'edges.yaml'))).toBe(false);
  expect(readFileSync(join(sidecar, 'keep.txt'), 'utf8')).toBe('not ours');
  survives();
});

it('sweep WRITE (control): an ordinary edges.yaml-only sidecar and its directory are removed', async () => {
  await checkoutWithUnpublishedCommit();
  put(join(checkout(), 'a', '.b', 'edges.yaml'), '- {id: X, rel: stale}\n');
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'a:b', name: 'b', content: 'fresh' } });
  await dueRow(node.id, 'WRITE');
  expect(await gitMirrorSweepTick(db)).toBe(1);
  expect(existsSync(join(checkout(), 'a', '.b'))).toBe(false);
  expect(git(env.bare, 'show', 'refs/heads/main:a/b.md')).toContain('fresh');
});

it('rollback after a failure inside the cleanup restores exactly the owned file and metadata', async () => {
  await checkoutWithUnpublishedCommit();
  const sidecar = join(checkout(), 'a', '.b');
  put(join(sidecar, 'edges.yaml'), '- {id: X, rel: stale}\n');
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'a:b', name: 'b', content: 'fresh' } });
  await dueRow(node.id, 'WRITE');
  vi.mocked(fs.rmdirSync).mockImplementationOnce(() => { throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await gitMirrorSweepTick(db);
  vi.restoreAllMocks();
  expect(await db.gitMirrorObligation.count({ where: { memoryId, nodeId: node.id } })).toBe(1);
  expect(readFileSync(join(sidecar, 'edges.yaml'), 'utf8')).toBe('- {id: X, rel: stale}\n');
  expect(existsSync(join(checkout(), 'a', 'b.md'))).toBe(false);
  expect(existsSync(mirrorMutationMarker(checkout()))).toBe(false);
  survives();
});

it('#3692 rollback after the cleanup removed the directory recreates the parent and restores edges.yaml', async () => {
  await checkoutWithUnpublishedCommit();
  const sidecar = join(checkout(), 'a', '.b');
  put(join(sidecar, 'edges.yaml'), '- {id: X, rel: stale}\n');
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'a:b', name: 'b', content: 'fresh' } });
  await dueRow(node.id, 'WRITE');
  // The helper's rmdir really succeeds (the directory is gone), then the mutation fails afterwards.
  vi.mocked(fs.rmdirSync).mockImplementationOnce(((path: string) => {
    execFileSync('rmdir', [path]);
    expect(existsSync(path)).toBe(false);
    throw Object.assign(new Error('synthetic post-rmdir EIO'), { code: 'EIO' });
  }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await gitMirrorSweepTick(db);
  vi.restoreAllMocks();
  expect(await db.gitMirrorObligation.count({ where: { memoryId, nodeId: node.id } })).toBe(1);
  expect(lstatSync(sidecar).isDirectory()).toBe(true);
  expect(readFileSync(join(sidecar, 'edges.yaml'), 'utf8')).toBe('- {id: X, rel: stale}\n');
  expect(existsSync(join(checkout(), 'a', 'b.md'))).toBe(false);
  expect(existsSync(mirrorMutationMarker(checkout()))).toBe(false);
  survives();
});
