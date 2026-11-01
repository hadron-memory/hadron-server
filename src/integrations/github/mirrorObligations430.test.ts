/**
 * #430 (first slice) — a mirror attempt that did not land leaves a durable, redacted obligation row (Refs #430, #425).
 *
 * Real git against a temp BARE remote, no network (the #2308 harness: `execGit` runs real git with every protocol refused
 * but `file`, and one `insteadOf` rule rewrites the memory's github URL to the bare repo). `gitBranch.js` is NOT mocked.
 * Rows are read straight from `git_mirror_obligations`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const env = vi.hoisted(() => ({
  failure: null as unknown, tokenFails: false, root: '', bare: '', failOn: null as null | ((args: string[]) => boolean),
  stdoutFor: null as null | ((args: string[]) => string | null),
}));
const TOKEN = 'tok-430-secret';
vi.mock('./githubApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./githubApp.js')>()),
  getInstallationToken: vi.fn(async () => { if (env.tokenFails) throw new Error(`boom ${TOKEN}`); return TOKEN; }),
}));
vi.mock('../../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    if (env.failOn?.(args)) throw env.failure ?? new Error('Git command failed. Check the repository and branch, then retry.');
    const forged = env.stdoutFor?.(args);
    if (forged != null) return { stdout: forged, stderr: '' };
    try {
      const stdout = execFileSync('git', [
        '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
        '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
        '-c', `url.${env.bare}.insteadOf=${SOURCE.replace('https://github.com/', `https://x-access-token:${TOKEN}@github.com/`)}`,
        ...args,
      ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout, stderr: '' };
    } catch {
      throw new Error('Git command failed. Check the repository and branch, then retry.');
    }
  }),
}));

import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { writeNodeToGit } from './writeNodeToGit.js';
import { settleMirrorObligations, takeAttemptSeq, type MirrorObligationRef } from './mirrorObligations.js';

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

async function setup(opts: { develop?: boolean; empty?: boolean; readBranch?: string; token?: boolean } = {}) {
  seedRemote(opts);
  const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: 'mirror430-org', ...(opts.token ? { githubInstallationId: 4242 } : {}) } });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, name: 'mem', urn: 'mirror430-org:mem',
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

const NODE = 'node-430-a';
const WRITE: MirrorObligationRef = { nodeId: NODE, kind: 'WRITE' };
const run = (content: readonly [string, string] | null, obligations: MirrorObligationRef[] = [WRITE]) =>
  withMirrorCheckout({ memoryId, commitSubject: 'mirror write', logPrefix: '[t]', obligations }, ({ localPath }) => {
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
  env.root = mkdtempSync(join(tmpdir(), 'hadron-430-'));
  env.bare = mkdtempSync(join(tmpdir(), 'hadron-430-bare-'));
  env.failOn = null;
  env.failure = null;
  env.stdoutFor = null;
  env.tokenFails = false;
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


const rows = () => db.gitMirrorObligation.findMany({ where: { memoryId }, orderBy: [{ nodeId: 'asc' }, { kind: 'asc' }, { removeLoc: 'asc' }] });
const row = (extra: Partial<MirrorObligationRef> = {}) => ({
  memoryId, nodeId: NODE, kind: 'WRITE', removeLoc: '', ...extra,
});

describe('a failed mirror attempt leaves a redacted obligation (#430)', () => {
  it('fetch failure logs only bounded metadata and stores only the fixed branch class (#3057)', async () => {
    await setup({ token: true });
    const secret = `https://x-access-token:${TOKEN}@github.com/private/repo Bearer synthetic-3057`;
    env.failure = Object.assign(new Error(secret), { stack: secret, cause: { nested: secret }, token: secret, exitCode: 128, toString: () => secret });
    env.failOn = args => args[0] === 'fetch';
    const captured: unknown[][] = [];
    for (const channel of ['log', 'warn', 'error'] as const) vi.spyOn(console, channel).mockImplementation((...args) => { captured.push(args); });
    expect(await run(['a.txt', 'one'])).toBe('failed');
    const found = await rows();
    expect(found).toEqual([expect.objectContaining({ errorClass: 'BRANCH_SETUP', attempts: 1 })]);
    const text = inspect({ captured, found }, { depth: null });
    for (const fragment of [TOKEN, 'x-access-token', 'synthetic-3057', secret]) expect(text).not.toContain(fragment);
    expect(text).toContain('exitCode: 128');
    expect(text).toContain("phase: 'branch'");
  });

  it('(a) a rejected push records ONE WRITE row with the fixed class, and no token, URL or git text in any column', async () => {
    await setup({ token: true });
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    const found = await rows();
    expect(found).toEqual([expect.objectContaining({ ...row(), state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 1 })]);
    const everything = JSON.stringify(found, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const secret of [TOKEN, 'x-access-token', 'github.com', 'acme/repo', env.bare, 'Git command failed']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('(b) lock order: failure then success leaves no row; success then failure leaves a FAILED row', async () => {
    await setup();
    rejectPushes();
    expect(await run(['a.txt', 'one'])).toBe('failed');
    expect(await rows()).toHaveLength(1);
    allowPushes();
    expect(await run(null)).toBe('mirrored');
    expect(await rows()).toEqual([]);
    // Now a later failure describes newer state: it records.
    rejectPushes();
    expect(await run(['b.txt', 'two'])).toBe('failed');
    expect(await rows()).toEqual([expect.objectContaining({ ...row(), state: 'FAILED', errorClass: 'PUSH_FAILED', attempts: 1 })]);
  });

  it('(b2) a repeated failure bumps attempts and keeps ONE row', async () => {
    await setup();
    rejectPushes();
    await run(['a.txt', 'one']);
    await run(['a.txt', 'two']);
    expect(await rows()).toEqual([expect.objectContaining({ ...row(), errorClass: 'PUSH_FAILED', attempts: 2 })]);
  });

  it('(b3) an out-of-order settle (lower attempt_seq after a higher one) is a no-op, for a failure and for a success', async () => {
    await setup();
    const ref = [WRITE];
    await settleMirrorObligations(db, memoryId, ref, { result: 'failed', errorClass: 'PUSH_FAILED' }, 10n);
    await settleMirrorObligations(db, memoryId, ref, { result: 'failed', errorClass: 'TREE_WRITE' }, 5n);
    await settleMirrorObligations(db, memoryId, ref, { result: 'cleared' }, 7n);
    expect(await rows()).toEqual([expect.objectContaining({ errorClass: 'PUSH_FAILED', attempts: 1, attemptSeq: 10n })]);
    await settleMirrorObligations(db, memoryId, ref, { result: 'cleared' }, 11n);
    expect(await rows()).toEqual([]);
    await settleMirrorObligations(db, memoryId, ref, { result: 'failed', errorClass: 'PUSH_FAILED' }, 12n);
    expect(await rows()).toHaveLength(1);
  });

  it('(b4) KNOWN LIMIT: a success delete keeps no high-water mark, so a lower-numbered failure arriving after it re-creates the row', async () => {
    await setup();
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'cleared' }, 20n);
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'failed', errorClass: 'PUSH_FAILED' }, 15n);
    // A spurious row, the safe direction; only reachable outside the checkout lock (see mirrorObligations.ts).
    expect(await rows()).toEqual([expect.objectContaining({ errorClass: 'PUSH_FAILED', attemptSeq: 15n })]);
  });

  it('(b5) a settle for one memory never touches another memory\'s rows (success delete and not-mirrored clear are both memory-scoped)', async () => {
    await setup();
    const other = await db.memory.create({ data: { id: generateId(), organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId,
      name: 'other', urn: 'mirror430-org:other', class: 'knowledge' } });
    await db.gitMirrorObligation.create({ data: { ...row({}), memoryId: other.id, state: 'FAILED', errorClass: 'PUSH_FAILED', attemptSeq: 1n } as never });
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'cleared' }, 99n);
    expect(await db.gitMirrorObligation.count({ where: { memoryId: other.id } })).toBe(1);
    await db.memory.update({ where: { id: memoryId }, data: { source: null } });
    expect(await run(['a.txt', 'one'])).toBe('skipped');
    expect(await db.gitMirrorObligation.count({ where: { memoryId: other.id } })).toBe(1);
  });

  it('(l) a sequence that cannot be taken does not stop the mirror: Git still publishes, nothing is recorded, a fixed line is logged', async () => {
    await setup();
    const real = db.$queryRaw.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, '$queryRaw').mockImplementation(((...a: unknown[]) => {
      const text = String((a[0] as { strings?: string[] })?.strings?.join('') ?? a[0]);
      if (text.includes('git_mirror_attempt_seq')) return Promise.reject(new Error(`seq boom ${TOKEN}`));
      return real(...a);
    }) as never);
    expect(await run(['a.txt', 'one'])).toBe('mirrored');
    spy.mockRestore();
    expect(remoteTip('hadron-updates')).toBe(localTip('hadron-updates'));
    expect(await rows()).toEqual([]);
    expect(errors.some((e) => e.includes('Could not take an attempt number'))).toBe(true);
    expect(errors.join('\n')).not.toContain(TOKEN);
  });

  it('(m) an older "not mirrored" observation, delayed past a newer failed attempt, cannot clear that attempt\'s row', async () => {
    await setup();
    rejectPushes();
    await db.memory.update({ where: { id: memoryId }, data: { source: null } });
    const realExec = db.$executeRaw.bind(db) as (...a: unknown[]) => Promise<number>;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const atClear = new Promise<void>((r) => { entered = r; });
    let first = true;
    const spy = vi.spyOn(db, '$executeRaw').mockImplementation(((...a: unknown[]) => {
      if (first) { first = false; entered(); return gate.then(() => realExec(...a)); }
      return realExec(...a);
    }) as never);
    const older = run(['a.txt', 'one']);       // sees no source, pauses at its clear
    await atClear;
    await db.memory.update({ where: { id: memoryId }, data: { source: SOURCE } });
    expect(await run(['a.txt', 'one'])).toBe('failed'); // a newer attempt: real push rejected, row recorded
    expect(await rows()).toHaveLength(1);
    release();
    expect(await older).toBe('skipped');
    spy.mockRestore();
    expect(await rows()).toEqual([expect.objectContaining({ ...row(), errorClass: 'PUSH_FAILED' })]);
  });

  it('(c) the failure class follows the stage that failed', async () => {
    await setup({ token: true });
    env.tokenFails = true;
    expect(await run(['a.txt', 'one'])).toBe('failed');
    expect((await rows())[0]).toMatchObject({ errorClass: 'TOKEN_UNAVAILABLE', state: 'FAILED' });
    env.tokenFails = false;

    env.failOn = (args) => args[0] === 'fetch';
    expect(await run(['a.txt', 'one'])).toBe('failed');
    expect((await rows())[0]).toMatchObject({ errorClass: 'BRANCH_SETUP', attempts: 2 });
    env.failOn = null;

    const thrown = await withMirrorCheckout(
      { memoryId, commitSubject: 'm', logPrefix: '[t]', obligations: [WRITE] }, () => { throw new Error(`disk ${TOKEN}`); });
    expect(thrown).toBe('failed');
    expect((await rows())[0]).toMatchObject({ errorClass: 'TREE_WRITE', attempts: 3 });
    expect(JSON.stringify(await rows(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(TOKEN);
  });

  it('(d) a clean tree that is already published clears the row', async () => {
    await setup();
    // Seeded from the real sequence, so the attempt below is strictly newer however many tests ran before this one.
    await db.gitMirrorObligation.create({ data: { ...row(), kind: 'WRITE', state: 'FAILED', errorClass: 'PUSH_FAILED', attemptSeq: await takeAttemptSeq(db) } as never });
    expect(await run(null)).toBe('no-changes');
    expect(await rows()).toEqual([]);
  });

  it('(e) a repository that is configured but not cloned records NOT_CLONED, and a later success clears it', async () => {
    await setup();
    rmSync(local, { recursive: true, force: true });
    expect(await run(['a.txt', 'one'])).toBe('skipped');
    expect(await rows()).toEqual([expect.objectContaining({ ...row(), state: 'NOT_CLONED', errorClass: 'NOT_CLONED' })]);
    execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`, 'clone', SOURCE, local], { stdio: 'ignore' });
    expect(await run(['a.txt', 'one'])).toBe('mirrored');
    expect(await rows()).toEqual([]);
  });

  it('(f) a memory that is not mirrored (no source, no org, encrypted) records NO row and clears an existing one', async () => {
    await setup();
    await db.gitMirrorObligation.create({ data: { ...row(), state: 'FAILED', errorClass: 'PUSH_FAILED', attemptSeq: await takeAttemptSeq(db) } as never });
    await db.memory.update({ where: { id: memoryId }, data: { source: null } });
    expect(await run(['a.txt', 'one'])).toBe('skipped');
    expect(await rows()).toEqual([]);
    await db.memory.update({ where: { id: memoryId }, data: { source: SOURCE } });
    await db.gitMirrorObligation.create({ data: { ...row(), state: 'FAILED', errorClass: 'PUSH_FAILED', attemptSeq: await takeAttemptSeq(db) } as never });
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    expect(await run(['a.txt', 'one'])).toBe('refused-encrypted');
    expect(await rows()).toEqual([]);
  });

  it('(g) a call that names no obligation records none (no new write triggers)', async () => {
    await setup();
    rejectPushes();
    expect(await withMirrorCheckout({ memoryId, commitSubject: 'm', logPrefix: '[t]' }, ({ localPath }) => {
      writeFileSync(join(localPath, 'a.txt'), 'one');
    })).toBe('failed');
    expect(await rows()).toEqual([]);
  });

  it('(h) a WRITE and two REMOVE rows for different old locs coexist; a REMOVE row survives its node hard delete; the memory cascades them', async () => {
    await setup();
    rejectPushes();
    const refs: MirrorObligationRef[] = [
      WRITE, { nodeId: NODE, kind: 'REMOVE', removeLoc: 'old:one' }, { nodeId: NODE, kind: 'REMOVE', removeLoc: 'old:two' },
    ];
    expect(await run(['a.txt', 'one'], refs)).toBe('failed');
    expect((await rows()).map(r => [r.kind, r.removeLoc])).toEqual([['WRITE', ''], ['REMOVE', 'old:one'], ['REMOVE', 'old:two']]);
    // No FK to nodes: deleting a node that never existed or no longer does cannot touch these rows.
    await db.node.deleteMany({ where: { id: NODE } });
    expect(await rows()).toHaveLength(3);
    // A success settle for only the first removal clears only that row.
    allowPushes();
    expect(await run(null, [{ nodeId: NODE, kind: 'REMOVE', removeLoc: 'old:one' }])).toBe('mirrored');
    expect((await rows()).map(r => r.removeLoc)).toEqual(['', 'old:two']);
    await db.memory.delete({ where: { id: memoryId } });
    expect(await db.gitMirrorObligation.count()).toBe(0);
  });

  it('(i) writeNodeToGit names the node it mirrors, so a failure from the event path leaves that node\'s row', async () => {
    await setup();
    rejectPushes();
    const node = { id: NODE, loc: 'topic', name: 'Topic', nodeType: null, objectType: null, alias: null, description: null, abstract: null,
      abstractOriginHash: null, contentHash: null, content: 'body', tags: [], seq: null, data: null, properties: null, role: null,
      isRunnable: null, isPlaceholder: false, outgoingEdges: [] };
    await writeNodeToGit(node as never, '', null, memoryId);
    expect(await rows()).toEqual([expect.objectContaining({ ...row(), errorClass: 'PUSH_FAILED' })]);
  });

  it('(j) the CHECK refuses a free-text error class, a REMOVE with no loc and a WRITE with one', async () => {
    await setup();
    const insert = (over: Record<string, unknown>) => db.gitMirrorObligation.create({
      data: { ...row(), state: 'FAILED', errorClass: 'PUSH_FAILED', attemptSeq: 1n, ...over } as never });
    await expect(insert({ errorClass: 'fatal: could not read from https://x-access-token:abc@github.com' })).rejects.toThrow();
    await expect(insert({ kind: 'REMOVE', removeLoc: '' })).rejects.toThrow();
    await expect(insert({ kind: 'WRITE', removeLoc: 'old' })).rejects.toThrow();
    await expect(insert({ state: 'NOT_CLONED', errorClass: 'PUSH_FAILED' })).rejects.toThrow();
  });

  it('(k) the migration carries a byte-identical copy of the invariants file', () => {
    const sql = readFileSync(new URL('../../../prisma/git-mirror-obligation-invariants.sql', import.meta.url), 'utf8');
    const dir = readdirSync(new URL('../../../prisma/migrations', import.meta.url)).find((d) => d.endsWith('_git_mirror_retry_exhausted'));
    expect(dir).toBeDefined();
    const migration = readFileSync(new URL(`../../../prisma/migrations/${dir}/migration.sql`, import.meta.url), 'utf8');
    expect(migration.endsWith(sql)).toBe(true);
  });
});
