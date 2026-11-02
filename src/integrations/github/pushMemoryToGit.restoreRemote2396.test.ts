/**
 * #2396 — a full push leaves no installation token in the checkout's `origin`
 * on ANY exit after a tokenized remote can have been installed.
 *
 * `pushMemoryToGit` swaps the installation token into `origin` at setup (existing
 * checkout: `remote set-url`; fresh clone: `clone <tokenUrl>`), but restored the
 * tokenless source only from the setup catch, the snapshot refusal, the clean
 * return and the commit/push construct. The node-load transaction, the node
 * render/path/write loop and the conditional root README serialization/write ran
 * between them with no restoring construct, so a fault there left
 * `https://x-access-token:<token>@…` in `.git/config` of the shared checkout.
 *
 * Real git against a temp BARE remote, no network, synthetic token only. `execGit`
 * is replaced by a wrapper that runs real git with the transport guard inverted
 * (every protocol refused except `file`; `insteadOf` rewrites the memory's github
 * URL and its tokenized twin to the bare repo, so the stored source stays a valid
 * github URL). Each middle-phase fault is injected independently, and the hook
 * that raises it first reads `origin` to prove the tokenized URL really was
 * installed (otherwise the pin would be vacuous).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const SOURCE = 'https://github.com/acme/repo.git';
const TOKEN = 'ghs_SYNTHETIC_INSTALLATION_TOKEN_2396';
const TOKEN_URL = SOURCE.replace('https://github.com/', `https://x-access-token:${TOKEN}@github.com/`);
const FAULT_MESSAGE = 'injected-2396-fault';
const GENERIC = 'Git command failed. Check the repository and branch, then retry.';

type Site = 'transaction' | 'path' | 'render' | 'write' | 'rootSerialize' | 'rootWrite';

const env = vi.hoisted(() => ({
  restoreTimeouts: [] as Array<number | undefined>,
  root: '', bare: '', local: '',
  fault: null as string | null,
  /** `origin` as read at the instant a fault fired (proves the token was installed). */
  originAtFault: null as string | null,
  /** Faults the restore `remote set-url origin <source>` itself. */
  failRestore: false,
  restoreAttempts: 0,
  /** A git call carried the tokenized URL (clone or `remote set-url`): the token was installed. */
  tokenInstalled: false,
  readOrigin: (() => '') as () => string,
}));

vi.mock('./githubApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./githubApp.js')>()),
  getInstallationToken: vi.fn(async () => TOKEN),
}));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get GRAPHS_PATH() { return env.root; },
}));

vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const isRestore = args[0] === 'remote' && args[1] === 'set-url' && args[3] === 'https://github.com/acme/repo.git';
    if (isRestore) {
      env.restoreAttempts++;
      env.restoreTimeouts.push((options as { timeout?: number }).timeout);
      if (env.failRestore) {
        // Carries the token the way a raw execFile rejection would: a raw-error log leaks it.
        throw Object.assign(new Error(`raw ${TOKEN_URL}`), { code: 'RESTORE_SENTINEL' });
      }
    }
    if (args.some((a) => a.includes('ghs_SYNTHETIC_INSTALLATION_TOKEN_2396'))) env.tokenInstalled = true;
    const { execFileSync } = await import('child_process');
    try {
      const stdout = execFileSync('git', [
        '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
        '-c', `url.${env.bare}.insteadOf=https://github.com/acme/repo.git`,
        '-c', `url.${env.bare}.insteadOf=https://x-access-token:ghs_SYNTHETIC_INSTALLATION_TOKEN_2396@github.com/acme/repo.git`,
        ...args,
      ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout, stderr: '' };
    } catch {
      throw new Error(GENERIC);
    }
  }),
}));

/** Raises the fault for `site` after recording whether `origin` carried the token. */
function fire(site: string): void {
  if (env.fault !== site) return;
  try { env.originAtFault = env.readOrigin(); } catch { env.originAtFault = null; }
  throw new Error(FAULT_MESSAGE);
}

vi.mock('./nodeFrontmatter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./nodeFrontmatter.js')>();
  return {
    ...real,
    // `nodeFilePath` is also called by the legacy-sidecar check; the first call per
    // node is the one under test and is the only one that reaches `fire`.
    nodeFilePath: (...a: Parameters<typeof real.nodeFilePath>) => { fire('path'); return real.nodeFilePath(...a); },
    buildNodeFrontmatter: (...a: Parameters<typeof real.buildNodeFrontmatter>) => { fire('render'); return real.buildNodeFrontmatter(...a); },
  };
});
vi.mock('yaml', async (importOriginal) => {
  const real = await importOriginal<typeof import('yaml')>();
  return {
    ...real,
    // The root manifest is the only serialized object with a `urn` and no `id`.
    stringify: (v: unknown, ...rest: unknown[]) => {
      if (v && typeof v === 'object' && 'urn' in v && !('id' in v)) fire('rootSerialize');
      return (real.stringify as (...a: unknown[]) => string)(v, ...rest);
    },
  };
});

import { pushMemoryToGit } from './pushMemoryToGit.js';

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim();
const originUrl = () => git(env.local, 'remote', 'get-url', 'origin');
const remoteTip = (branch: string) => { try { return git(env.bare, 'rev-parse', `refs/heads/${branch}`); } catch { return null; } };

let memoryId: string;
let logged: string[];

/**
 * The two write sites fault through REAL filesystem errors, so their obstacle is
 * committed to the remote and arrives with the checkout (existing or fresh alike):
 * a regular file where the node's directory must go (`mkdirSync` fails), and a
 * dangling `README.md` symlink (`existsSync` is false so the root is written, and
 * `writeFileSync` follows the link into a missing directory).
 */
function seedRemote(site?: Site) {
  git(env.bare, 'init', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(tmpdir(), 'hadron-2396-seed-'));
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'seed.txt'), 'seed');
  if (site === 'write') writeFileSync(join(seed, 'blocked'), 'in the way');
  if (site === 'rootWrite') symlinkSync(join(env.root, 'no-such-dir', 'README.md'), join(seed, 'README.md'));
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', env.bare, '--all');
  rmSync(seed, { recursive: true, force: true });
}

/** `checkout: 'existing'` pre-clones with the tokenless origin; `'fresh'` leaves the push to clone. */
async function setup(checkout: 'existing' | 'fresh', opts: { token?: boolean; branch?: string; site?: Site } = {}) {
  seedRemote(opts.site);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'o', urn: 'push2396-org', ...(opts.token === false ? {} : { githubInstallationId: 4242 }) },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, name: 'mem', urn: 'push2396-org:mem', class: 'knowledge', source: SOURCE,
      ...(opts.branch ? { writeBranch: opts.branch } : {}),
    },
  });
  memoryId = memory.id;
  env.local = join(env.root, org.urn, 'mem');
  mkdirSync(join(env.root, org.urn), { recursive: true });
  if (checkout === 'existing') {
    execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`, 'clone', SOURCE, env.local], { stdio: 'ignore' });
  }
  env.readOrigin = originUrl;
}

const makeNode = (loc: string) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`, tags: [] } });

/** Everything an operator or a log aggregator could see from one push. */
const surface = (result: unknown) => JSON.stringify({ result, logged });

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  env.root = mkdtempSync(join(tmpdir(), 'hadron-2396-'));
  env.bare = mkdtempSync(join(tmpdir(), 'hadron-2396-bare-'));
  env.local = '';
  env.fault = null;
  env.originAtFault = null;
  env.failRestore = false;
  env.restoreAttempts = 0;
  env.restoreTimeouts = [];
  env.tokenInstalled = false;
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { logged.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a) => { logged.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await cleanDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
  for (const timeout of env.restoreTimeouts) expect(timeout, 'restore-only fixed deadline').toBe(10_000);
});

/** The origin as git stores it, read from the config FILE (not through any rewrite). */
const configText = () => readFileSync(join(env.local, '.git', 'config'), 'utf8');

/** Arms the fault for one middle-phase site (after `setup(checkout, { site })`). */
async function arm(site: Site) {
  env.fault = site;
  if (site === 'transaction') {
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      fire('transaction');
      return real(...a);
    }) as never);
  }
  await makeNode(site === 'write' ? 'blocked:leaf' : 'topic:leaf');
}

const SITES: Site[] = ['transaction', 'path', 'render', 'write', 'rootSerialize', 'rootWrite'];

describe('pushMemoryToGit — origin is restored on every middle-phase exit (#2396)', () => {
  for (const checkout of ['existing', 'fresh'] as const) {
    for (const site of SITES) {
      it(`${checkout} checkout, fault at ${site}: origin ends tokenless`, async () => {
        await setup(checkout, { site });
        await arm(site);
        const seedTip = remoteTip('main');

        const result = await pushMemoryToGit(memoryId);

        // The fault really fired AFTER the tokenized URL was installed: git was handed
        // it, and (for the hooked sites) `origin` read back as it at the instant of the fault.
        expect(env.tokenInstalled).toBe(true);
        expect(result.error).toBeDefined();
        if (site !== 'write' && site !== 'rootWrite') {
          expect(env.originAtFault).toBe(TOKEN_URL);
          expect(result.error).toContain(FAULT_MESSAGE);
        }
        expect(remoteTip('main')).toBe(seedTip);
        expect(result.nodeCount).toBe(0);
        expect(originUrl()).toBe(SOURCE);
        expect(configText()).not.toContain(TOKEN);
        expect(surface(result)).not.toContain(TOKEN);
      });
    }
  }

  it('a faulted push does not publish: the remote is untouched', async () => {
    await setup('existing', { site: 'render' });
    await arm('render');
    const before = remoteTip('main');
    expect(before).not.toBeNull();
    await pushMemoryToGit(memoryId);
    expect(remoteTip('main')).toBe(before);
    expect(git(env.bare, 'log', '--oneline', 'main')).not.toContain('Push ');
  });
});

describe('pushMemoryToGit — a failed restore never masks the primary outcome (#2396)', () => {
  it('reports the primary fault, logs only sanitized diagnostics, and states the residual risk', async () => {
    await setup('existing', { site: 'render' });
    await arm('render');
    env.failRestore = true;

    const result = await pushMemoryToGit(memoryId);

    expect(env.restoreAttempts).toBe(1);
    // The primary outcome is the injected fault, not the restore failure.
    expect(result.error).toContain(FAULT_MESSAGE);
    expect(result.error).not.toContain(GENERIC);
    // The restore did not happen, and the log says so without echoing any secret.
    expect(originUrl()).toBe(TOKEN_URL);
    const text = surface(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN_URL);
    expect(logged.some((l) => /restore/i.test(l) && /token/i.test(l))).toBe(true);
  });
});

describe('pushMemoryToGit — a failed restore after a successful publish (#2396)', () => {
  it('still reports success, publishes, and warns without leaking the token', async () => {
    await setup('existing');
    await makeNode('topic:leaf');
    env.failRestore = true;
    const result = await pushMemoryToGit(memoryId);
    expect(result).toEqual({ nodeCount: 1 });
    expect(git(env.bare, 'log', '--oneline', 'main')).toContain('Push 1 nodes');
    expect(originUrl()).toBe(TOKEN_URL);
    expect(surface(result)).not.toContain(TOKEN);
    expect(logged.some((l) => /restore/i.test(l) && /token/i.test(l))).toBe(true);
  });
});

describe('pushMemoryToGit — controls keep their contracts (#2396)', () => {
  it('existing checkout, ordinary successful push: published, origin restored once', async () => {
    await setup('existing');
    await makeNode('topic:leaf');
    const result = await pushMemoryToGit(memoryId);
    expect(result.error).toBeUndefined();
    expect(result.nodeCount).toBe(1);
    expect(git(env.bare, 'log', '--oneline', 'main')).toContain('Push 1 nodes');
    expect(originUrl()).toBe(SOURCE);
    expect(env.restoreAttempts).toBe(1);
  });

  it('fresh clone, ordinary successful push: published, origin restored', async () => {
    await setup('fresh');
    await makeNode('topic:leaf');
    const result = await pushMemoryToGit(memoryId);
    expect(result.error).toBeUndefined();
    expect(git(env.bare, 'log', '--oneline', 'main')).toContain('Push 1 nodes');
    expect(originUrl()).toBe(SOURCE);
    expect(configText()).not.toContain(TOKEN);
  });

  it('no-change, nothing ahead: succeeds without a commit and origin is restored', async () => {
    await setup('existing');
    // No nodes and no README to add... a manifest is still written, so land it first.
    expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
    const tip = remoteTip('main');
    const again = await pushMemoryToGit(memoryId);
    expect(again.error).toBeUndefined();
    expect(remoteTip('main')).toBe(tip);
    expect(originUrl()).toBe(SOURCE);
  });

  it('a push the remote rejects keeps its Commit/push failed result and restores origin', async () => {
    await setup('existing');
    await makeNode('topic:leaf');
    const hook = join(env.bare, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    execFileSync('chmod', ['755', hook]);
    const result = await pushMemoryToGit(memoryId);
    expect(result.error).toMatch(/^Commit\/push failed:/);
    expect(result.nodeCount).toBe(0);
    expect(originUrl()).toBe(SOURCE);
    expect(surface(result)).not.toContain(TOKEN);
  });

  it('setup refusal (bad write branch) keeps its Git setup failed result; origin tokenless', async () => {
    await setup('existing', { branch: 'bad..branch' });
    const result = await pushMemoryToGit(memoryId);
    expect(result.error).toMatch(/^Git setup failed:/);
    expect(originUrl()).toBe(SOURCE);
  });

  it('encrypted flip caught at the snapshot keeps its refusal; origin tokenless', async () => {
    await setup('existing');
    vi.spyOn(db, '$transaction').mockImplementation((async () => null) as never);
    const result = await pushMemoryToGit(memoryId);
    expect(result.errorCode).toBe('ENCRYPTED_GIT_SYNC_UNAVAILABLE');
    expect(originUrl()).toBe(SOURCE);
  });

  it('encrypted memory refuses before any setup: no checkout work, no remote change', async () => {
    await setup('existing');
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    const result = await pushMemoryToGit(memoryId);
    expect(result.errorCode).toBe('ENCRYPTED_GIT_SYNC_UNAVAILABLE');
    expect(env.restoreAttempts).toBe(0);
    expect(originUrl()).toBe(SOURCE);
    expect(existsSync(join(env.local, 'README.md'))).toBe(false);
  });
});
