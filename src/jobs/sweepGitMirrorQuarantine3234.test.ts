/**
 * #3234 — quarantine rejected-but-unpublished git-mirror commits (Holger's data-integrity ruling, 2026-11-10: quarantine).
 *
 * A file-specific remote rejection (a pre-receive hook, i.e. push protection) used to leave the rejected commit on the
 * local write branch, so every later push carried it and a healthy file's separate retry was rejected too and ran out its
 * debt. Real Git against a private bare remote with a REAL pre-receive hook that rejects only trees containing `bad`.
 *
 * `execGit` is replaced by a wrapper that runs real git (file transport only, one insteadOf rule) and, like the real
 * wrapper, throws a GitCommandError that keeps ONLY the numeric exit code. Nothing here reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

const env = vi.hoisted(() => ({
  root: '', bare: '', failPush: null as null | number,
  /** Throw a RAW error (message carries a secret) on the Nth push of this test, to model a transport failure mid-split. */
  rawFailOnPush: null as null | number, pushes: 0,
}));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
vi.mock('../integrations/github/execGit.js', async importOriginal => {
  const real = await importOriginal<typeof import('../integrations/github/execGit.js')>();
  return {
    ...real,
    execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
      if (env.failPush !== null && args[0] === 'push') throw new real.GitCommandError({ exitCode: env.failPush });
      if (args[0] === 'push' && env.rawFailOnPush !== null && ++env.pushes === env.rawFailOnPush) {
        throw Object.assign(new Error(`fatal: unable to access 'https://x-access-token:${LEAK}@github.com/acme/repo.git/'`), { exitCode: 128 });
      }
      try {
        const stdout = execFileSync('git', [
          '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
          '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
          ...args,
        ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { stdout, stderr: '' };
      } catch (e) {
        throw new real.GitCommandError({ exitCode: (e as { status?: number }).status ?? undefined });
      }
    }),
  };
});

import { withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import { gitMirrorSweepTick } from './sweepGitMirrorObligations.js';
import { takeAttemptSeq } from '../integrations/github/mirrorObligations.js';

const SOURCE = 'https://github.com/acme/repo.git';
const ORG_URN = 'mirror3234-org';
const MEMORY_URN = `${ORG_URN}:mem`;
const BRANCH = 'hadron-updates';
const LEAK = 'ghs_LEAKED_TOKEN_3234';
const BAD_BODY = 'SECRET-PUSH-PROTECTED-BODY-3234';
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim();

let orgId: string;
let memoryId: string;
let local: string;
let logs: string[];

async function setup(opts: { encrypted?: boolean } = {}) {
  git(env.bare, 'init', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(tmpdir(), 'hadron-seed3234-'));
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'seed.txt'), 'seed');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', env.bare, '--all');
  rmSync(seed, { recursive: true, force: true });
  const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: ORG_URN } });
  orgId = org.id;
  const memory = await db.memory.create({ data: {
    id: generateId(), organizationId: org.id, name: 'mem', urn: MEMORY_URN, class: 'knowledge', source: SOURCE,
    ...(opts.encrypted ? { isEncrypted: true } : {}),
  } });
  memoryId = memory.id;
  local = join(env.root, ORG_URN, 'mem');
  mkdirSync(join(env.root, ORG_URN), { recursive: true });
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`, 'clone', SOURCE, local], { stdio: 'ignore' });
}

/** A path-specific rejection: any proposed tree containing a path with `bad` in it is refused. */
const rejectBad = () => {
  const hook = join(env.bare, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  if git ls-tree -r --name-only "$new" | grep -q bad; then exit 1; fi\ndone\nexit 0\n');
  chmodSync(hook, 0o755);
};
const allowAll = () => rmSync(join(env.bare, 'hooks', 'pre-receive'), { force: true });
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000);
const makeNode = (loc: string, content = 'ordinary content') =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, tags: [] } });
const owe = async (nodeId: string, extra: { attempts?: number; lastAttemptAt?: Date } = {}) => db.gitMirrorObligation.create({ data: {
  memoryId, nodeId, kind: 'WRITE', removeLoc: '', branch: BRANCH, state: 'FAILED', errorClass: 'PUSH_FAILED',
  attempts: extra.attempts ?? 1, attemptSeq: await takeAttemptSeq(db), lastAttemptAt: extra.lastAttemptAt ?? hoursAgo(24),
} });
const rows = () => db.gitMirrorObligation.findMany({ where: { memoryId }, orderBy: { nodeId: 'asc' } });
const remoteHas = (path: string) => { try { git(env.bare, 'show', `refs/heads/${BRANCH}:${path}`); return true; } catch { return false; } };
const localTree = () => git(local, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`).split('\n');
const heldRefs = () => git(local, 'for-each-ref', '--format=%(refname)', 'refs/hadron-quarantine/').split('\n').filter(Boolean);
const remoteRefs = () => git(env.bare, 'for-each-ref', '--format=%(refname)').split('\n');
const tick = () => gitMirrorSweepTick(db, new Date());

beforeEach(async () => {
  env.root = mkdtempSync(join(tmpdir(), 'bob-q3234-'));
  env.bare = mkdtempSync(join(tmpdir(), 'bob-q3234-bare-'));
  env.failPush = null; env.rawFailOnPush = null; env.pushes = 0;
  logs = [];
  const capture = (...a: unknown[]) => { logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'log').mockImplementation(capture);
  await cleanDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});

describe('#3234: a rejected unpublished commit is quarantined, so a healthy sibling still publishes', () => {
  it('acceptance 1+2+3: bad and healthy owed at attempts 9; healthy lands and clears, bad is charged alone and held', async () => {
    await setup(); rejectBad();
    const bad = await makeNode('bad', BAD_BODY); const healthy = await makeNode('healthy');
    await owe(bad.id, { attempts: 9, lastAttemptAt: hoursAgo(48) }); await owe(healthy.id, { attempts: 9 });

    expect(await tick()).toBe(1);

    // healthy published and its debt cleared; the rejected file never reached the remote
    expect(remoteHas('healthy.md')).toBe(true);
    expect(remoteHas('bad.md')).toBe(false);
    const left = await rows();
    expect(left.map(r => [r.nodeId, r.state, r.errorClass, r.attempts])).toEqual([[bad.id, 'EXHAUSTED', 'PUSH_REJECTED', 10]]);
    // the rejected commit is no longer an ancestor of the write branch ...
    expect(localTree()).not.toContain('bad.md');
    // ... and its work is HELD, recoverable, local only
    // two holds: the refused batch (bad + healthy), then the bad row alone; both keep the bad file's content
    const held = heldRefs();
    expect(held).toHaveLength(2);
    for (const h of held) {
      expect(git(local, 'ls-tree', '-r', '--name-only', h)).toContain('bad.md');
      expect(git(local, 'show', `${h}:bad.md`)).toContain(BAD_BODY);
    }
  });

  it('acceptance 2: the held work is never pushed to any remote ref and never reaches report or error text', async () => {
    await setup(); rejectBad();
    const bad = await makeNode('bad', BAD_BODY); const healthy = await makeNode('healthy');
    await owe(bad.id, { attempts: 9, lastAttemptAt: hoursAgo(48) }); await owe(healthy.id, { attempts: 9 });
    await tick();

    const held = heldRefs();
    expect(held).toHaveLength(2);
    expect(remoteRefs().filter(r => /quarantine/i.test(r))).toEqual([]);
    for (const h of held) expect(() => git(env.bare, 'cat-file', '-e', git(local, 'rev-parse', h))).toThrow(); // objects never left
    const text = logs.join('\n');
    expect(text).not.toContain(BAD_BODY);
    expect(text).not.toMatch(/bad\.md|x-access-token|ghs_/);
    // one fixed-class line announces the blocked branch: memory and branch, no content
    const lines = logs.filter(l => l.includes('git-mirror.quarantine'));
    expect(lines).toHaveLength(2);
    for (const l of lines) { expect(l).toContain(memoryId); expect(l).toContain(BRANCH); }
  });

  it('acceptance 4: after the rejection is removed and the blocked row is reset, the bad file lands and the held work stays accounted for', async () => {
    await setup(); rejectBad();
    const bad = await makeNode('bad', BAD_BODY); const healthy = await makeNode('healthy');
    await owe(bad.id, { attempts: 9, lastAttemptAt: hoursAgo(48) }); await owe(healthy.id, { attempts: 9 });
    await tick();
    const held = heldRefs();

    allowAll();
    await db.gitMirrorObligation.updateMany({ where: { memoryId }, data: { state: 'FAILED', attempts: 1, lastAttemptAt: hoursAgo(24) } });
    await tick();

    expect(remoteHas('bad.md')).toBe(true);
    expect(remoteHas('healthy.md')).toBe(true);
    expect(await rows()).toEqual([]);
    expect(heldRefs()).toEqual(held);                                       // never silently discarded
  });

  it('the ordinary writer path quarantines too: the next, healthy write is not poisoned by the rejected one', async () => {
    await setup(); rejectBad();
    const write = (name: string) => withMirrorCheckout({ memoryId, commitSubject: 'w', logPrefix: '[t]' },
      ({ localPath }) => { writeFileSync(join(localPath, name), 'x'); });
    expect(await write('bad-one.md')).toBe('failed');
    expect(heldRefs()).toHaveLength(1);
    expect(await write('fine.md')).toBe('mirrored');
    expect(remoteHas('fine.md')).toBe(true);
    expect(remoteHas('bad-one.md')).toBe(false);
  });

  it('a transport failure (exit 128) is not a rejection: nothing is quarantined and the commit stays for the retry (#2308)', async () => {
    await setup();
    env.failPush = 128;
    expect(await withMirrorCheckout({ memoryId, commitSubject: 'w', logPrefix: '[t]' },
      ({ localPath }) => { writeFileSync(join(localPath, 'a.md'), 'x'); })).toBe('failed');
    expect(heldRefs()).toEqual([]);
    expect(localTree()).toContain('a.md');
  });

  it('a push that failed only because the remote moved (not a fast-forward) is not quarantined', async () => {
    await setup();
    // Local branch carries an unpublished commit (a transport failure), then the remote branch advances: diverged.
    env.failPush = 128;
    await withMirrorCheckout({ memoryId, commitSubject: 'w', logPrefix: '[t]' },
      ({ localPath }) => { writeFileSync(join(localPath, 'first.md'), 'x'); });
    env.failPush = null;
    const other = mkdtempSync(join(tmpdir(), 'bob-q3234-other-'));
    try {
      execFileSync('git', ['clone', '-q', env.bare, other]);
      git(other, 'checkout', '-q', '-b', BRANCH); writeFileSync(join(other, 'theirs.md'), 't');
      git(other, 'add', '-A'); git(other, 'commit', '-qm', 'theirs'); git(other, 'push', '-q', 'origin', BRANCH);
    } finally { rmSync(other, { recursive: true, force: true }); }
    expect(await withMirrorCheckout({ memoryId, commitSubject: 'w', logPrefix: '[t]' },
      ({ localPath }) => { writeFileSync(join(localPath, 'mine.md'), 'x'); })).toBe('failed');
    expect(heldRefs()).toEqual([]);
    expect(localTree()).toContain('mine.md');
  });

  it('a transport failure DURING the split stops it: every row is charged once as PUSH_FAILED, nothing reaches the remote, and the failure log carries no raw error text', async () => {
    await setup(); rejectBad();
    const bad = await makeNode('bad', BAD_BODY); const healthy = await makeNode('healthy');
    await owe(bad.id); await owe(healthy.id);
    env.rawFailOnPush = 2; // push 1 = the refused batch (real hook); push 2 = the first isolated row, which dies on transport

    expect(await tick()).toBe(1);

    expect(remoteHas('bad.md')).toBe(false);
    expect(remoteHas('healthy.md')).toBe(false);
    // charged exactly once each (attempts 1 -> 2), by the split's own settle, not again by the outer catch
    expect((await rows()).map(r => [r.state, r.errorClass, r.attempts])).toEqual([['FAILED', 'PUSH_FAILED', 2], ['FAILED', 'PUSH_FAILED', 2]]);
    const text = logs.join('\n');
    expect(text).not.toContain(LEAK);
    expect(text).not.toMatch(/x-access-token|unable to access/);
    expect(logs.some(l => l.includes('Row-isolated push failed'))).toBe(true);
  });

  it('a single-obligation batch that the remote refuses is quarantined and charged PUSH_REJECTED without a split', async () => {
    await setup(); rejectBad();
    const bad = await makeNode('bad', BAD_BODY);
    await owe(bad.id);
    expect(await tick()).toBe(1);
    expect((await rows()).map(r => [r.state, r.errorClass, r.attempts])).toEqual([['FAILED', 'PUSH_REJECTED', 2]]);
    expect(heldRefs()).toHaveLength(1);
    expect(localTree()).not.toContain('bad.md');
  });

  it('acceptance 5: an encrypted memory never reaches the quarantine path (R206 refusal unchanged)', async () => {
    await setup({ encrypted: true }); rejectBad();
    const node = await makeNode('bad', BAD_BODY);
    expect(await withMirrorCheckout({ memoryId, commitSubject: 'w', logPrefix: '[t]',
      obligations: [{ nodeId: node.id, kind: 'WRITE' }] }, () => { throw new Error('mutate must not run'); })).toBe('refused-encrypted');
    expect(heldRefs()).toEqual([]);
    expect(existsSync(join(local, 'bad.md'))).toBe(false);
    expect(await rows()).toEqual([]);
    void orgId;
  });
});
