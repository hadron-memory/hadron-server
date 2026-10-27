/** #2527: real file-only git, synthetic credentials, every read-checkout exit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';

const SOURCE = 'https://github.com/acme/repo.git';
const TOKEN = 'ghs_SYNTHETIC_INSTALLATION_TOKEN_2527';
const TOKEN_URL = SOURCE.replace('https://github.com/', `https://x-access-token:${TOKEN}@github.com/`);
const GENERIC = 'Git command failed. Check the repository and branch, then retry.';
type Fault = 'fetch' | 'checkout' | 'merge' | 'clone' | 'load' | null;
const env = vi.hoisted(() => ({
  root: '', bare: '', local: '', seed: '', fault: null as Fault,
  tokenInstalled: false, originAtFault: null as string | null,
  failRestore: false, restores: 0, insideLock: false, restoreInsideLock: false,
  readOrigin: (() => '') as () => string,
}));

vi.mock('../../config.js', async original => ({
  ...await original<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return env.root; },
}));
vi.mock('./githubApp.js', async original => ({
  ...await original<typeof import('./githubApp.js')>(),
  getInstallationToken: vi.fn(async () => TOKEN),
}));
vi.mock('./mirrorCheckoutLock.js', async original => {
  const real = await original<typeof import('./mirrorCheckoutLock.js')>();
  return { ...real, withMirrorCheckoutLock: <T>(id: string, fn: () => Promise<T>) =>
    real.withMirrorCheckoutLock(id, async () => {
      env.insideLock = true;
      try { return await fn(); } finally { env.insideLock = false; }
    }),
  };
});
vi.mock('../localFs/loadGraphFromFs.js', async original => {
  const real = await original<typeof import('../localFs/loadGraphFromFs.js')>();
  return { ...real, loadGraphFromFs: (...args: Parameters<typeof real.loadGraphFromFs>) => {
    if (env.fault === 'load') {
      env.originAtFault = env.readOrigin();
      throw new Error('synthetic-load-fault-2527');
    }
    return real.loadGraphFromFs(...args);
  } };
});
vi.mock('./execGit.js', async original => {
  const real = await original<typeof import('./execGit.js')>();
  return { ...real, execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const restore = args[0] === 'remote' && args[1] === 'set-url' && args[3] === SOURCE;
    if (restore) {
      env.restores++;
      env.restoreInsideLock = env.insideLock;
      if (env.failRestore) throw Object.assign(new Error(`raw ${TOKEN_URL}`), { code: 'RESTORE_SENTINEL' });
    }
    if (args.some(arg => arg.includes(TOKEN))) env.tokenInstalled = true;
    const run = (argv: string[]) => execFileSync('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
      '-c', `url.${env.bare}.insteadOf=${TOKEN_URL}`, ...argv,
    ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      if (env.fault === 'fetch' && args[0] === 'fetch') {
        env.originAtFault = env.readOrigin();
        // Real git refusal, through the same file-only transport guard.
        run(['fetch', 'origin', 'refs/heads/does-not-exist-2527']);
      }
      if (env.fault === 'checkout' && args[0] === 'checkout') {
        env.originAtFault = env.readOrigin();
        run(['checkout', 'does-not-exist-2527']);
      }
      if (env.fault === 'merge' && args[0] === 'merge') env.originAtFault = env.readOrigin();
      const stdout = run(args);
      if (env.fault === 'clone' && args[0] === 'clone') {
        // A clone can leave a configured .git before reporting failure.
        // Complete real setup, then inject that final failure boundary.
        env.originAtFault = env.readOrigin();
        throw new Error('synthetic-partial-clone-fault');
      }
      return { stdout, stderr: '' };
    } catch {
      // Match production execGit's sanitized error, never its raw argv/stderr.
      throw new real.GitCommandError();
    }
  }) };
});

import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

const IDENT = { GIT_AUTHOR_NAME: 'synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.test', GIT_COMMITTER_NAME: 'synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
let graph: MemoryWithOrg;
let logged: string[];

async function setup(checkout: 'existing' | 'fresh', fault: Fault = null) {
  git(env.bare, 'init', '--bare', '-b', 'main');
  git(env.seed, 'init', '-b', 'main');
  writeFileSync(join(env.seed, 'topic.md'), '---\nname: Topic\n---\nSynthetic body\n');
  git(env.seed, 'add', 'topic.md'); git(env.seed, 'commit', '-m', 'seed');
  git(env.seed, 'push', env.bare, 'main');
  const org = await db.organization.create({ data: { name: 'read2527-org', urn: 'read2527-org', githubInstallationId: 4242 } });
  graph = await db.memory.create({ data: {
    organizationId: org.id, name: 'mem', urn: 'read2527-org:mem', class: 'knowledge', source: SOURCE, readBranch: 'main',
  }, include: { organization: true } });
  env.local = join(env.root, org.urn, 'mem');
  mkdirSync(join(env.root, org.urn), { recursive: true });
  if (checkout === 'existing') {
    execFileSync('git', ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`, 'clone', SOURCE, env.local], { stdio: 'ignore' });
  }
  env.readOrigin = () => git(env.local, 'remote', 'get-url', 'origin');
  if (fault === 'merge') {
    writeFileSync(join(env.local, 'local.txt'), 'local');
    git(env.local, 'add', 'local.txt'); git(env.local, 'commit', '-m', 'local divergence');
    writeFileSync(join(env.seed, 'remote.txt'), 'remote');
    git(env.seed, 'add', 'remote.txt'); git(env.seed, 'commit', '-m', 'remote divergence');
    git(env.seed, 'push', env.bare, 'main');
  }
  env.fault = fault;
}

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  env.root = mkdtempSync(join(tmpdir(), 'hadron-2527-'));
  env.bare = mkdtempSync(join(tmpdir(), 'hadron-2527-bare-'));
  env.seed = mkdtempSync(join(tmpdir(), 'hadron-2527-seed-'));
  Object.assign(env, { local: '', fault: null, tokenInstalled: false, originAtFault: null, failRestore: false, restores: 0, insideLock: false, restoreInsideLock: false });
  logged = [];
  for (const level of ['error', 'warn', 'log'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  await cleanDb(db);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of [env.root, env.bare, env.seed]) rmSync(dir, { recursive: true, force: true });
});

function assertNoCredentialSurface(result: unknown) {
  const visible = JSON.stringify({ result, logged });
  expect(visible).not.toContain(TOKEN);
  expect(visible).not.toContain(SOURCE);
  expect(visible).not.toContain(TOKEN_URL);
}
function assertRestored() {
  expect(env.tokenInstalled).toBe(true);
  expect(env.readOrigin()).toBe(SOURCE);
  expect(readFileSync(join(env.local, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
  expect(env.restores).toBe(1);
  expect(env.restoreInsideLock).toBe(true);
}

describe('#2527 read sync restores origin under the checkout lock', () => {
  it.each(['existing', 'fresh'] as const)('restores after successful %s sync', async checkout => {
    await setup(checkout);
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'topic' } })).toBe(1);
    assertRestored(); assertNoCredentialSurface(result);
  });
  for (const [checkout, fault] of [
    ['existing', 'fetch'], ['existing', 'checkout'], ['existing', 'merge'],
    ['fresh', 'clone'], ['existing', 'load'], ['fresh', 'load'],
  ] as const) {
    it(`${checkout} ${fault} failure restores a genuinely tokenized origin`, async () => {
      await setup(checkout, fault);
      const result = await syncGraphFromGithub(graph);
      expect(result.error).toBe(fault === 'load' ? 'synthetic-load-fault-2527' : GENERIC);
      expect(env.originAtFault).toBe(TOKEN_URL);
      assertRestored(); assertNoCredentialSurface(result);
    });
  }
  it.each([null, 'load'] as const)('restore failure preserves primary outcome (%s)', async fault => {
    await setup('existing', fault);
    env.failRestore = true;
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBe(fault ? 'synthetic-load-fault-2527' : undefined);
    expect(env.readOrigin()).toBe(TOKEN_URL);
    expect(env.restores).toBe(1);
    expect(env.restoreInsideLock).toBe(true);
    expect(logged.join(' ')).toMatch(/may still hold an installation token until the next successful restore/);
    assertNoCredentialSurface(result);
  });
});
