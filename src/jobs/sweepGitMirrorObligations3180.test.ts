/**
 * #3180 (test-only, successor of #3060 items 1-2): the empty row-query race and the security-optional
 * coverage of the retry sweep. Real Git against a private bare remote; every fixture lives under this run's own temp roots.
 * Governing code: `gitMirrorSweepTick` (selection, bounded row query) and `withMirrorCheckout` (the in-lock guards).
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
  onRetryLock: null as null | (() => void), failLock: false,
  root: '', bare: '',
}));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
// Observe queue arrival without replacing the real PostgreSQL lock (a sleep alone can release the holder early).
vi.mock('../integrations/github/mirrorCheckoutLock.js', async importOriginal => {
  const real = await importOriginal<typeof import('../integrations/github/mirrorCheckoutLock.js')>();
  return {
    ...real,
    withMirrorCheckoutLock: <T>(id: string, work: () => Promise<T>, opts?: { fenceEncryption?: boolean }) => {
      if (env.failLock) return Promise.reject(new Error('synthetic lock failure'));
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
import { withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import { writeNodeToGit } from '../integrations/github/writeNodeToGit.js';
import { gitMirrorSweepTick } from './sweepGitMirrorObligations.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { takeAttemptSeq } from '../integrations/github/mirrorObligations.js';
import { nodeFilePath } from '../integrations/github/nodeFrontmatter.js';

const SOURCE = 'https://github.com/acme/repo.git';
const ORG_URN = 'mirror3180-org';
const MEMORY_URN = `${ORG_URN}:mem`;
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim();

let orgId: string;
let memoryId: string;
let local: string;

async function setup() {
  git(env.bare, 'init', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(tmpdir(), 'hadron-seed3180-'));
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

const tick = async (now = new Date(), client: PrismaClient = db) => gitMirrorSweepTick(client, now);
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
  env.root = mkdtempSync(join(tmpdir(), 'bindi-sweep3180-'));
  env.bare = mkdtempSync(join(tmpdir(), 'bindi-sweep3180-bare-'));
  env.onRetryLock = null;
  env.failLock = false;
  commands.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await cleanDb(db);
  await setup();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});


const RETRY = () => ({ now: new Date(), maxAttempts: 10 });
const noMutate = () => { throw new Error('mutate must not run'); };
const rejectPushes = () => { const hook = join(env.bare, 'hooks', 'pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755); };

describe('#3180 item 1: the due CTE selects a memory whose last obligation is settled before its row query', () => {
  /**
   * Wrap `db` so that, once the due CTE has resolved, `afterCte` runs before the sweep's next statement: the exact
   * seam between the selection and the bounded per-memory row query. Everything else is the real client.
   */
  function racing(afterCte: () => Promise<void>): PrismaClient {
    let fired = false;
    return new Proxy(db, {
      get(target, prop) {
        if (prop === '$queryRaw') {
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const result = await target.$queryRaw(strings, ...values);
            if (!fired && strings.join('?').includes('WITH due')) { fired = true; await afterCte(); }
            return result;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  async function laterMemory(lastAttemptAt: Date) {
    const memory = await db.memory.create({ data: {
      organizationId: orgId, name: 'later', urn: `${ORG_URN}:later`, class: 'knowledge', source: SOURCE,
    } });
    mkdirSync(join(env.root, ORG_URN, 'later', '.git'), { recursive: true });
    await owe('later-missing-node', { forMemoryId: memory.id, lastAttemptAt });
    return memory.id;
  }

  it('an empty row result stalls neither the later memory nor the budget, and touches no unrelated row', async () => {
    // One slot only: a candidate that reserved a slot for its empty row result would starve the later memory.
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '1');
    const node = await makeNode();
    await owe(node.id, { lastAttemptAt: hoursAgo(48) });            // memory A: due first, settled mid-run
    const laterId = await laterMemory(hoursAgo(24));                 // memory B: due second
    const backoff = await db.memory.create({ data: {
      organizationId: orgId, name: 'quiet', urn: `${ORG_URN}:quiet`, class: 'knowledge', source: SOURCE,
    } });
    await owe('still-backing-off', { forMemoryId: backoff.id, lastAttemptAt: new Date(), attempts: 3 });
    const unrelatedBefore = await rows(backoff.id);
    const seq = await sequenceValue();
    const client = racing(async () => { await db.gitMirrorObligation.deleteMany({ where: { memoryId } }); });

    expect(await tick(new Date(), client)).toBe(2);                  // A counted as handled, B ran behind it
    expect(await rows()).toEqual([]);
    expect(await rows(laterId)).toEqual([]);                         // B's due row ran and cleared
    expect(await rows(backoff.id)).toEqual(unrelatedBefore);
    expect(commands).toEqual([]);                                    // the later row's node is missing: no Git at all
    expect(Number((await sequenceValue())[0]!.value)).toBe(Number(seq[0]!.value) + 1); // B's attempt only; A took none
  });
});

describe('#3180 item 2: security-optional coverage (names the existing pin each one does not duplicate)', () => {
  const ref = (nodeId: string) => [{ nodeId, kind: 'WRITE' as const }];

  // The sweep's cap/state predicates exist in the CTE, in the row query and in withMirrorCheckout's re-read. Calling
  // withMirrorCheckout directly (as the sweep does) isolates the in-lock layer from the two outer ones.
  it('the in-lock cap re-read refuses a row already at the cap, and takes no sequence', async () => {
    const node = await makeNode();
    await owe(node.id, { attempts: 10 });
    const before = await rows(); const seq = await sequenceValue();
    expect(await withMirrorCheckout({ db, memoryId, obligations: ref(node.id), retry: RETRY(), commitSubject: 'cap', logPrefix: '[3180]' }, noMutate)).toBe('skipped');
    expect(await rows()).toEqual(before);
    expect(await sequenceValue()).toEqual(seq);
    expect(commands).toEqual([]);
  });

  it('the in-lock state re-read refuses an EXHAUSTED row that is still under the cap', async () => {
    const node = await makeNode();
    await db.gitMirrorObligation.create({ data: {
      memoryId, nodeId: node.id, kind: 'WRITE', removeLoc: '', state: 'EXHAUSTED', errorClass: 'PUSH_FAILED',
      attempts: 3, attemptSeq: await takeAttemptSeq(db), lastAttemptAt: hoursAgo(24),
    } });
    const before = await rows(); const seq = await sequenceValue();
    expect(await withMirrorCheckout({ db, memoryId, obligations: ref(node.id), retry: RETRY(), commitSubject: 'state', logPrefix: '[3180]' }, noMutate)).toBe('skipped');
    expect(await rows()).toEqual(before);
    expect(await sequenceValue()).toEqual(seq);
    expect(commands).toEqual([]);
  });

  it('ordinary failures that reach the cap leave the row FAILED (shared counter) and the sweep makes no attempt', async () => {
    const node = await makeNode();
    await owe(node.id, { attempts: 9 });
    rejectPushes();
    await writeNodeToGit({ ...node, outgoingEdges: [] }, '', null, memoryId);
    expect((await rows())[0]).toMatchObject({ state: 'FAILED', attempts: 10 });  // no cap is passed on the ordinary path
    rmSync(join(env.bare, 'hooks', 'pre-receive'));
    const before = await rows(); const seq = await sequenceValue();
    commands.length = 0;
    await tick(new Date(Date.now() + 7 * 24 * 60 * 60_000));
    expect(commands).toEqual([]);
    expect(await rows()).toEqual(before);
    expect(await sequenceValue()).toEqual(seq);
  });

  it('a memory deleted while the retry waited for the lock runs no Git and keeps its row', async () => {
    const node = await makeNode();
    await owe(node.id);
    const before = await rows(); const seq = await sequenceValue();
    let release!: () => void; let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const holder = withMirrorCheckoutLock(memoryId, async () => {
      entered(); await hold;
      await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
    });
    await acquired;
    const waiting = retryQueued();
    const running = withMirrorCheckout({ db, memoryId, obligations: ref(node.id), retry: RETRY(), commitSubject: 'deleted', logPrefix: '[3180]' }, noMutate)
      .then(outcome => outcome, error => error as Error);
    try { await expectQueued(waiting, running); } finally { release(); await holder; }
    expect(await running).toBe('skipped');
    expect(await rows()).toEqual(before);
    expect(await sequenceValue()).toEqual(seq);
    expect(commands).toEqual([]);
  });

  // Does not duplicate #3156's throwing-hook pins: those throw INSIDE the lock; here the lock itself cannot be taken.
  it('a checkout lock that cannot be taken leaves a retry row unchanged: no attempt, no sequence', async () => {
    const node = await makeNode();
    await owe(node.id);
    const before = await rows(); const seq = await sequenceValue();
    env.failLock = true;
    expect(await withMirrorCheckout({ db, memoryId, obligations: ref(node.id), retry: RETRY(), commitSubject: 'lock', logPrefix: '[3180]' }, noMutate)).toBe('failed');
    expect(await rows()).toEqual(before);
    expect(await sequenceValue()).toEqual(seq);
    expect(commands).toEqual([]);
  });

  // Does not duplicate #3060's README pin (second operand of the verify) nor the uncommitted-file pin in the first suite.
  it('a COMMITTED foreign-id file at the node path, with no live owner, keeps REMOVE debt via the no-change verify', async () => {
    const moved = await makeNode('new');
    const path = nodeFilePath(local, 'old', MEMORY_URN);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '---\nid: somebody-else\n---\nold');
    git(local, 'add', '-A'); git(local, 'commit', '-m', 'foreign owner'); git(local, 'push', env.bare, 'main');
    await owe(moved.id, { kind: 'REMOVE', removeLoc: 'old' });
    await tick();
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ state: 'FAILED', errorClass: 'TREE_WRITE', attempts: 2 });
    expect(existsSync(path)).toBe(true);
    expect(commands.some(args => args[0] === 'push')).toBe(false);   // a clean tree is the no-change path, never a push
  });
});
