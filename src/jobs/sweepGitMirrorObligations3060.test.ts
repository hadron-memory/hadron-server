/**
 * #3060 (test-only follow-up to #3043 and #3064): pins for the retry sweep that the first suite left to combined
 * mutations. Real Git against a private bare remote; every fixture lives under this run's own temp roots.
 * Governing code: `gitMirrorSweepTick` (the selection and the page cursor) and `withMirrorCheckout` (the in-lock guards).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

const env = vi.hoisted(() => ({
  onRetryLock: null as null | (() => void),
  root: '', bare: '',
}));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
// Observe queue arrival without replacing the real PostgreSQL lock (a sleep alone can release the holder early).
vi.mock('../integrations/github/mirrorCheckoutLock.js', async importOriginal => {
  const real = await importOriginal<typeof import('../integrations/github/mirrorCheckoutLock.js')>();
  return {
    ...real,
    withMirrorCheckoutLock: <T>(id: string, work: () => Promise<T>, opts?: { fenceEncryption?: boolean }) => {
      if (opts?.fenceEncryption) env.onRetryLock?.();
      return real.withMirrorCheckoutLock(id, work, opts);
    },
  };
});
const commands: string[][] = [];
vi.mock('../integrations/github/execGit.js', () => ({
  execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    commands.push(args);
    try {
      const stdout = execFileSync('git', [
        '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
        '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
        ...args,
      ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout, stderr: '' };
    } catch {
      throw new Error('Git command failed. Check the repository and branch, then retry.');
    }
  }),
}));

import { withMirrorCheckoutLock } from '../integrations/github/mirrorCheckoutLock.js';
import { takeAttemptSeq } from '../integrations/github/mirrorObligations.js';
import { nodeFilePath, orphanedLegacyPaths } from '../integrations/github/nodeFrontmatter.js';

const SOURCE = 'https://github.com/acme/repo.git';
const ORG_URN = 'mirror3060-org';
const MEMORY_URN = `${ORG_URN}:mem`;
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim();

let orgId: string;
let memoryId: string;
let local: string;

async function setup() {
  git(env.bare, 'init', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(tmpdir(), 'hadron-seed3060-'));
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'seed.txt'), 'seed');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', env.bare, '--all');
  rmSync(seed, { recursive: true, force: true });
  const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: ORG_URN } });
  orgId = org.id;
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'mem', urn: MEMORY_URN, class: 'knowledge', source: SOURCE },
  });
  memoryId = memory.id;
  local = join(env.root, ORG_URN, 'mem');
  mkdirSync(join(env.root, ORG_URN), { recursive: true });
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
    'clone', SOURCE, local], { stdio: 'ignore' });
}

const tick = async (now = new Date()) => (await import('./sweepGitMirrorObligations.js')).gitMirrorSweepTick(db, now);
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000);
const makeNode = (loc = 'topic') => db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: 'current content', tags: [] } });
const owe = async (
  nodeId: string,
  extra: { kind?: 'WRITE' | 'REMOVE'; removeLoc?: string; attempts?: number; lastAttemptAt?: Date; forMemoryId?: string } = {},
) => db.gitMirrorObligation.create({ data: {
  memoryId: extra.forMemoryId ?? memoryId, nodeId, kind: extra.kind ?? 'WRITE', removeLoc: extra.removeLoc ?? '',
  state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: extra.attempts ?? 1, attemptSeq: await takeAttemptSeq(db),
  lastAttemptAt: extra.lastAttemptAt ?? hoursAgo(24),
} });
const rows = (forMemoryId = memoryId) => db.gitMirrorObligation.findMany({ where: { memoryId: forMemoryId }, orderBy: { nodeId: 'asc' } });
const sequenceValue = () => db.$queryRaw<Array<{ value: string; is_called: boolean }>>`SELECT last_value::text AS value, is_called FROM git_mirror_attempt_seq`;
const remoteHas = (path: string) => {
  try { git(env.bare, 'show', `refs/heads/hadron-updates:${path}`); return true; } catch { return false; }
};
const retryQueued = () => new Promise<void>(resolve => { env.onRetryLock = resolve; });
const expectQueued = (waiting: Promise<void>, running: Promise<unknown>) => Promise.race([
  waiting, running.then(error => { throw error ?? new Error('sweep finished before requesting the checkout lock'); }),
]);

beforeEach(async () => {
  env.root = mkdtempSync(join(tmpdir(), 'bindi-sweep3060-'));
  env.bare = mkdtempSync(join(tmpdir(), 'bindi-sweep3060-bare-'));
  env.onRetryLock = null;
  commands.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await cleanDb(db);
  await setup();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});

describe('#3060 in-lock NOT_CLONED guard', () => {
  it('a clone lost while the retry waited for the lock runs no Git and consumes no attempt or sequence', async () => {
    const node = await makeNode();
    await owe(node.id);
    const before = await rows();
    const seq = await sequenceValue();
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    // The outer selection saw the clone (it exists when the sweep runs its filter); the holder removes it afterwards.
    const holder = withMirrorCheckoutLock(memoryId, async () => {
      entered();
      await hold;
      rmSync(join(local, '.git'), { recursive: true });
    });
    await acquired;
    const waiting = retryQueued();
    const running = tick().then(() => null, error => error as Error);
    try { await expectQueued(waiting, running); } finally { release(); await holder; }
    const error = await running;
    if (error) throw error;
    expect(commands).toEqual([]);
    expect(await rows()).toEqual(before);
    expect(await sequenceValue()).toEqual(seq);
  });
});

describe('#3060 page-two selection', () => {
  /** 20 due memories the sweep must skip, all due BEFORE the one eligible memory, so the eligible one is on page two. */
  async function seedSkippedPage() {
    const kinds = ['invalid-source', 'templated', 'uncloned'] as const;
    for (let i = 0; i < 20; i++) {
      const kind = kinds[i % kinds.length]!;
      const memory = await db.memory.create({ data: {
        organizationId: orgId, name: `skip${i}`, urn: `${ORG_URN}:skip${i}`, class: 'knowledge',
        source: kind === 'invalid-source' ? 'https://attacker.invalid/repo' : SOURCE,
        writeBranch: kind === 'templated' ? 'clients/{client}' : null,
      } });
      if (kind !== 'uncloned') mkdirSync(join(env.root, ORG_URN, `skip${i}`, '.git'), { recursive: true });
      await owe(`skipped-${i}`, { forMemoryId: memory.id, lastAttemptAt: hoursAgo(48 + i / 60) });
    }
  }

  it('reaches an eligible memory behind a full page of skipped memories and clears its debt', async () => {
    const node = await makeNode();
    await owe(node.id);
    await seedSkippedPage();
    const skippedBefore = await db.gitMirrorObligation.findMany({ where: { memoryId: { not: memoryId } }, orderBy: { nodeId: 'asc' } });
    const seq = await sequenceValue();
    expect(await tick()).toBe(1);
    expect(await rows()).toEqual([]);
    expect(remoteHas('topic.md')).toBe(true);
    expect(commands.filter(args => args[0] === 'push')).toHaveLength(1);
    // Skipped memories keep their rows byte-identical, and only the one real attempt took a sequence.
    expect(await db.gitMirrorObligation.findMany({ where: { memoryId: { not: memoryId } }, orderBy: { nodeId: 'asc' } })).toEqual(skippedBefore);
    expect(Number((await sequenceValue())[0]!.value)).toBe(Number(seq[0]!.value) + 1);
  });
});

describe('#3060 REMOVE with only the legacy README remaining', () => {
  /** Commit `old/README.md` (frontmatter id `id`) to main so the write branch inherits it from the remote. */
  function commitLegacyReadme(id: string) {
    const { readme } = orphanedLegacyPaths(local, 'old');
    mkdirSync(join(local, 'old'), { recursive: true });
    writeFileSync(readme, `---\nid: ${id}\n---\nold`);
    git(local, 'add', '-A');
    git(local, 'commit', '-m', 'legacy readme');
    git(local, 'push', env.bare, 'main');
    return readme;
  }

  it('keeps the debt while a README owned by another node remains, and clears only after the owner file is removed and absence verified', async () => {
    const moved = await makeNode('new');
    const readme = commitLegacyReadme('somebody-else');
    expect(existsSync(nodeFilePath(local, 'old', MEMORY_URN))).toBe(false);
    await owe(moved.id, { kind: 'REMOVE', removeLoc: 'old' });

    await tick();
    const kept = await rows();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ state: 'FAILED', errorClass: 'TREE_WRITE', attempts: 2 });
    expect(existsSync(readme)).toBe(true);
    expect(commands.some(args => args[0] === 'push')).toBe(false);

    // The README now carries the obligation's own node id: this attempt removes it, then verifies absence.
    // The failed attempt left the clone on the write branch; the README changes owner there.
    writeFileSync(readme, `---\nid: ${moved.id}\n---\nold`);
    git(local, 'commit', '-am', 'readme now owned by the moved node');
    await db.gitMirrorObligation.updateMany({ where: { memoryId }, data: { lastAttemptAt: hoursAgo(24) } });
    commands.length = 0;
    await tick();
    expect(await rows()).toEqual([]);
    expect(existsSync(readme)).toBe(false);
    expect(commands.some(args => args[0] === 'push')).toBe(true);
    expect(remoteHas('old/README.md')).toBe(false);
  });
});
