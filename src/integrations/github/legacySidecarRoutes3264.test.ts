import { gitMirrorSweepTick } from '../../jobs/sweepGitMirrorObligations.js';
import { takeAttemptSeq } from './mirrorObligations.js';
/** #3264: sidecar cleanup on the push loop and sweep, real Git file-transport, with no GitHub/network dependency. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

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
      '-c', `url.${env.bare}.insteadOf=https://github.com/synthetic/data3264.git`, ...args.map(a => a.replace('https://x-access-token:fixture-token@github.com/', 'https://github.com/')),
    ], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    stderr: '',
  })),
}));
import * as writer from './writeNodeToGit.js';
import { mirrorMutationMarker } from './mirrorFileMutation.js';
import { pushMemoryToGit } from './pushMemoryToGit.js';

const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  const org = await db.organization.create({ data: { id: generateId(), name: 'Export fixture', urn: 'data3264-org', githubInstallationId: 123 } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Export', urn: 'data3264-org:fixture', class: 'knowledge', source: SOURCE, readBranch: 'main', writeBranch: 'main' } });
  memoryId = memory.id;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});



const checkout = () => join(env.root, 'data3264-org', 'fixture');
const node = (loc: string, content = 'body') => db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content } });
const debt = async (nodeId: string, kind: 'WRITE' | 'REMOVE', removeLoc = '') => db.gitMirrorObligation.create({ data: {
  memoryId, nodeId, kind, removeLoc, branch: 'main', state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 1,
  attemptSeq: await takeAttemptSeq(db), lastAttemptAt: new Date(Date.now() - 86400000),
} });
const rows = () => db.gitMirrorObligation.findMany({ where: { memoryId } });
/** First export clones the checkout; then a local, UNPUBLISHED commit marks what must survive. */
async function checkoutWithUnpublishedCommit(): Promise<string> {
  expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
  writeFileSync(join(checkout(), 'local-only.txt'), 'unpublished');
  git(checkout(), 'add', '-A'); git(checkout(), 'commit', '-m', 'unpublished local commit');
  return git(checkout(), 'rev-parse', 'HEAD');
}
const survived = (head: string) => {
  expect(existsSync(join(checkout(), '.git'))).toBe(true);
  expect(git(checkout(), 'log', '--format=%H')).toContain(head);
};

it('push loop: a node at loc "git" leaves .git and the unpublished commit intact', async () => {
  const head = await checkoutWithUnpublishedCommit();
  await node('git', 'the node called git');
  const result = await pushMemoryToGit(memoryId);
  expect(result.error).toBeUndefined();
  survived(head);
  expect(readFileSync(join(checkout(), 'git.md'), 'utf8')).toContain('the node called git');
});

it('push loop: a real legacy sidecar a/.b/edges.yaml is still removed', async () => {
  await node('a:b');
  await checkoutWithUnpublishedCommit();
  mkdirSync(join(checkout(), 'a', '.b'), { recursive: true });
  writeFileSync(join(checkout(), 'a', '.b', 'edges.yaml'), '- id: x\n  rel: r\n');
  expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
  expect(existsSync(join(checkout(), 'a', '.b'))).toBe(false);
});

it('sweep: a WRITE row for loc "git" settles; .git and the unpublished commit survive', async () => {
  const head = await checkoutWithUnpublishedCommit();
  const g = await node('git', 'swept git node');
  await debt(g.id, 'WRITE');
  expect(await gitMirrorSweepTick(db)).toBe(1);
  expect(await rows()).toEqual([]);
  survived(head);
  expect(git(env.bare, 'show', 'refs/heads/main:git.md')).toContain('swept git node');
});

it('sweep: a REMOVE row for a vacated loc "git" settles; .git and the unpublished commit survive', async () => {
  const head = await checkoutWithUnpublishedCommit();
  const g = await node('git-moved'); // the node now lives elsewhere; its old loc was "git"
  writeFileSync(join(checkout(), 'git.md'), `---\nid: ${g.id}\nname: old\n---\n\nold\n`);
  git(checkout(), 'add', '-A'); git(checkout(), 'commit', '-m', 'old git.md');
  const head2 = git(checkout(), 'rev-parse', 'HEAD');
  await debt(g.id, 'REMOVE', 'git');
  expect(await gitMirrorSweepTick(db)).toBe(1);
  expect(await rows()).toEqual([]);
  survived(head); survived(head2);
  expect(existsSync(join(checkout(), 'git.md'))).toBe(false);
});

it('sweep: a real legacy sidecar a/.b/edges.yaml is removed (WRITE) and its directory goes when empty', async () => {
  const n = await node('a:b');
  await checkoutWithUnpublishedCommit();
  mkdirSync(join(checkout(), 'a', '.b'), { recursive: true });
  writeFileSync(join(checkout(), 'a', '.b', 'edges.yaml'), '- id: x\n  rel: r\n');
  await debt(n.id, 'WRITE');
  expect(await gitMirrorSweepTick(db)).toBe(1);
  expect(existsSync(join(checkout(), 'a', '.b'))).toBe(false);
});

it('sweep rollback: a controlled failure restores the removed edges.yaml exactly and never touches .git', async () => {
  const n = await node('a:b');
  const head = await checkoutWithUnpublishedCommit();
  mkdirSync(join(checkout(), 'a', '.b'), { recursive: true });
  const edges = '- id: x\n  rel: r\n';
  writeFileSync(join(checkout(), 'a', '.b', 'edges.yaml'), edges);
  writeFileSync(join(checkout(), 'a', '.b', 'keep.txt'), 'keep');
  await debt(n.id, 'WRITE');
  const real = writer.writeNodeFile;
  vi.spyOn(writer, 'writeNodeFile').mockImplementation((...args) => { real(...args); throw new Error('synthetic partial write'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await gitMirrorSweepTick(db);
  expect(readFileSync(join(checkout(), 'a', '.b', 'edges.yaml'), 'utf8')).toBe(edges);
  expect(readFileSync(join(checkout(), 'a', '.b', 'keep.txt'), 'utf8')).toBe('keep');
  expect(existsSync(mirrorMutationMarker(checkout()))).toBe(false);
  survived(head);
});
