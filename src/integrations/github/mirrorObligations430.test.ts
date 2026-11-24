/**
 * #430 (first slice) — a mirror attempt that did not land leaves a durable, redacted obligation row (Refs #430, #425).
 *
 * Real git against a temp BARE remote, no network (the #2308 harness: `execGit` runs real git with every protocol refused
 * but `file`, and one `insteadOf` rule rewrites the memory's github URL to the bare repo). `gitBranch.js` is NOT mocked.
 * Rows are read straight from `git_mirror_obligations`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect, promisify } from 'node:util';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
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

/** libpq's PG* variables for a postgres URL (#4978). Only the authority, user, password and database are read: the query string never is. */
function psqlEnvFromUrl(raw: string): Record<string, string> {
  const u = new URL(raw);
  const out: Record<string, string> = {};
  if (u.hostname) out.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) out.PGPORT = u.port;
  if (u.username) out.PGUSER = decodeURIComponent(u.username);
  if (u.password) out.PGPASSWORD = decodeURIComponent(u.password);
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (dbName) out.PGDATABASE = dbName;
  return out;
}

describe('psqlEnvFromUrl (#4978)', () => {
  it('moves the credentials into PG* variables and ignores every query parameter', () => {
    expect(psqlEnvFromUrl('postgresql://u%40x:p%2Fw%3Ad@db.example:6543/my%20db?schema=public&connection_limit=5&pool_timeout=3')).toEqual({
      PGHOST: 'db.example', PGPORT: '6543', PGUSER: 'u@x', PGPASSWORD: 'p/w:d', PGDATABASE: 'my db',
    });
  });
  it('omits what the URL does not carry', () => {
    expect(psqlEnvFromUrl('postgresql://holger@localhost:5432/hadron')).toEqual({ PGHOST: 'localhost', PGPORT: '5432', PGUSER: 'holger', PGDATABASE: 'hadron' });
  });
});

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

  it('#3157 equal-sequence failure settlement preserves the existing row, while a newer failure advances it', async () => {
    await setup();
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'failed', errorClass: 'PUSH_FAILED' }, 10n);
    const before = await rows();
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'failed', errorClass: 'LOCK_FAILED' }, 10n);
    expect(await rows()).toEqual(before);
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'failed', errorClass: 'TREE_WRITE' }, 11n);
    expect(await rows()).toEqual([expect.objectContaining({ attempts: 2, attemptSeq: 11n, errorClass: 'TREE_WRITE' })]);
  });

  it('#3157 equal-sequence success settlement preserves the existing row, while a newer success clears it', async () => {
    await setup();
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'failed', errorClass: 'PUSH_FAILED' }, 10n);
    const before = await rows();
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'cleared' }, 10n);
    expect(await rows()).toEqual(before);
    await settleMirrorObligations(db, memoryId, [WRITE], { result: 'cleared' }, 11n);
    expect(await rows()).toEqual([]);
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
    // #425 review: the state/error_class pairing is closed in BOTH directions. 'PENDING' is the
    // trigger's word alone — a PENDING row wears it and no other state does, EXHAUSTED included (a debt that
    // was never attempted cannot have run out of attempts) — and a captured debt is no failure class.
    await expect(insert({ errorClass: 'PENDING' })).rejects.toThrow();
    await expect(insert({ state: 'PENDING', errorClass: 'TREE_WRITE' })).rejects.toThrow();
    await expect(insert({ state: 'EXHAUSTED', errorClass: 'PENDING', attempts: 10 })).rejects.toThrow();
    // An un-cloned attempt that reaches the cap is the EXHAUSTED shape the settle writer does produce.
    await expect(insert({ state: 'EXHAUSTED', errorClass: 'NOT_CLONED', attempts: 10 })).resolves.toBeDefined();
    await db.gitMirrorObligation.deleteMany({});
    await expect(insert({ state: 'PENDING', errorClass: 'PENDING', kind: 'REMOVE', removeLoc: 'docs:a' })).resolves.toBeDefined();
    await db.gitMirrorObligation.deleteMany({});
  });

  it('(k) a migration carries a byte-identical copy of the current invariants file', () => {
    const sql = readFileSync(new URL('../../../prisma/git-mirror-obligation-invariants.sql', import.meta.url), 'utf8');
    const migrations = new URL('../../../prisma/migrations', import.meta.url);
    // The file is the one source post-push.sql and the test globalSetup apply; a deployed
    // database reaches the same shape ONLY through a migration, so the CURRENT bytes must end
    // some migration verbatim (older carriers keep older copies and no longer match — that is
    // the point: editing the file without a carrying migration goes red here). #425 moved the
    // carrier from 20261117800000_git_mirror_push_rejected to 20261122140000_git_mirror_remove_pending.
    const carriers = readdirSync(migrations).filter((d) => {
      const p = new URL(`../../../prisma/migrations/${d}/migration.sql`, import.meta.url);
      return existsSync(p) && readFileSync(p, 'utf8').endsWith(sql);
    });
    expect(carriers.length, 'no applied migration ends with the current invariants file — append it verbatim to the migration that changes it').toBeGreaterThan(0);
  });

  // One SQL file through psql the way `prisma migrate deploy` and the globalSetup run it (one file, ON_ERROR_STOP).
  // The connection goes in PG* environment variables, never in argv: an execFile failure prints the whole command line,
  // and a URL argument would put the password in the CI log. Query parameters are never read, so Prisma-only ones
  // (connection_limit, pool_timeout, schema, ...) cannot reach libpq.
  const runPsqlFile = async (file: string) => {
    const pg = psqlEnvFromUrl(process.env.DATABASE_URL!); // the per-worker URL — never TEST_DATABASE_URL
    await promisify(execFileCb)('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-f', file],
      { cwd: fileURLToPath(new URL('../../..', import.meta.url)), maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...pg } });
  };

  const INVARIANTS_FILE = 'prisma/git-mirror-obligation-invariants.sql';
  const MIGRATION_FILE = 'prisma/migrations/20261122140000_git_mirror_remove_pending/migration.sql';
  const constraintDef = async () =>
    (await db.$queryRawUnsafe<{ d: string }[]>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'chk_git_mirror_obligation_shape'"))[0]?.d ?? '';
  type LegacyState = 'FAILED' | 'EXHAUSTED' | 'NOT_CLONED' | 'PENDING';
  const insertObligation = (nodeId: string, state: LegacyState, errorClass: string, extra: Partial<MirrorObligationRef> = {}) =>
    db.gitMirrorObligation.create({ data: { ...row(extra), nodeId, state, errorClass, attempts: 3, attemptSeq: 1n } as never });
  const snapshot = async () => (await db.gitMirrorObligation.findMany({ orderBy: [{ nodeId: 'asc' }, { kind: 'asc' }] }))
    .map((r) => `${r.nodeId}|${r.kind}|${r.removeLoc}|${r.state}|${r.errorClass}`);

  /**
   * Put the table in the shape a pre-#425 database has, seed it, then apply `migrationFile` through psql. The shared
   * per-worker schema must end with the CURRENT invariants whatever happens (a failed seed, a failed psql step, a failed
   * assertion), so everything from the first DDL on runs inside the try. Cleanup steps are each attempted and none replaces
   * the error that came first (an AggregateError carries both).
   */
  async function landOnLegacyTable(migrationFile: string): Promise<void> {
    await setup();
    let failure: unknown;
    try {
      await db.$executeRawUnsafe('ALTER TABLE git_mirror_obligations DROP CONSTRAINT chk_git_mirror_obligation_shape');
      await db.$executeRawUnsafe(`ALTER TABLE git_mirror_obligations ADD CONSTRAINT chk_git_mirror_obligation_shape CHECK (
        error_class IN ('TOKEN_UNAVAILABLE', 'BRANCH_SETUP', 'TREE_WRITE', 'PUSH_FAILED', 'PUSH_REJECTED', 'LOCK_FAILED', 'NOT_CLONED') AND
        ((state::text = 'NOT_CLONED' AND error_class = 'NOT_CLONED') OR
         (state::text = 'FAILED' AND error_class <> 'NOT_CLONED') OR state::text = 'EXHAUSTED') AND
        ((kind = 'WRITE' AND remove_loc = '') OR (kind = 'REMOVE' AND remove_loc <> '')) AND
        attempts >= 1)`);
      // One distinct node id per row: the PK is (memory, node, kind, remove_loc, branch), and node ids carry no FK.
      const classes = ['TOKEN_UNAVAILABLE', 'BRANCH_SETUP', 'TREE_WRITE', 'PUSH_FAILED', 'PUSH_REJECTED', 'LOCK_FAILED'];
      for (const [i, ec] of classes.entries()) await insertObligation(`legacy-failed-${i}`, 'FAILED', ec);
      // EXHAUSTED with every old-legal class as a WRITE row (the old CHECK allowed any class, NOT_CLONED included), plus
      // one REMOVE row for the kind coupling #425 left alone: a stricter re-added CHECK on any of these goes red here.
      for (const [i, ec] of [...classes, 'NOT_CLONED'].entries()) await insertObligation(`legacy-exhausted-${i}`, 'EXHAUSTED', ec);
      await insertObligation('legacy-exhausted-rm', 'EXHAUSTED', 'TOKEN_UNAVAILABLE', { kind: 'REMOVE', removeLoc: 'docs:gone' });
      await insertObligation('legacy-not-cloned', 'NOT_CLONED', 'NOT_CLONED');
      const before = await snapshot();
      expect(before).toHaveLength(15);
      // psql, one file, ON_ERROR_STOP: the same runner the test globalSetup uses. It autocommits each statement, which
      // `prisma migrate deploy` does not, so this proves the file's SQL against the data, not Prisma's transaction handling.
      await runPsqlFile(migrationFile);
      // Every legacy row survived the swap unchanged, and the constraint now in force is the new one.
      expect(await snapshot()).toEqual(before);
      await expect(insertObligation('legacy-post-swap', 'EXHAUSTED', 'PENDING')).rejects.toThrow(/chk_git_mirror_obligation_shape/);
      // It is the new CHECK that discriminates, not a bare failure: PENDING with PENDING is now legal.
      await insertObligation('legacy-post-swap-ok', 'PENDING', 'PENDING');
      expect(await db.gitMirrorObligation.count()).toBe(16);
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      // A failing cleanup step must not skip the invariants, nor replace the error that came first.
      const cleanup: unknown[] = [];
      try { await db.gitMirrorObligation.deleteMany({}); } catch (err) { cleanup.push(err); }
      try { await runPsqlFile(INVARIANTS_FILE); } catch (err) { cleanup.push(err); } // the CHECK validates rows, so they went first
      if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], 'cleanup after the legacy-table test failed');
    }
  }

  it('(l) the #425 migration lands on a legacy-shaped table: every seeded pre-#425-legal row survives the re-added CHECK', async () => {
    // The migration re-adds chk_git_mirror_obligation_shape with a plain ADD CONSTRAINT (no NOT VALID), so a deploy
    // validates every existing row: a CHECK stricter than the old one refuses the deploy on data. The rows seeded are
    // the ones the OLD shape (20261117800000's: seven error classes, no PENDING word) allowed that this test reaches:
    // FAILED with each non-NOT_CLONED class, EXHAUSTED with every class as WRITE, one EXHAUSTED REMOVE row, one NOT_CLONED.
    await landOnLegacyTable(MIGRATION_FILE);
    expect(await constraintDef()).toContain('PENDING');
  });

  it('(m) a failing migration step still leaves the current invariants and no legacy rows behind', async () => {
    const bad = join(env.root, 'failing-migration.sql');
    writeFileSync(bad, 'SELECT 1 / 0;\n');
    await expect(landOnLegacyTable(bad)).rejects.toThrow();
    expect(await constraintDef()).toContain('PENDING'); // the legacy-shaped CHECK is gone
    expect(await db.gitMirrorObligation.count()).toBe(0);
  });
});
