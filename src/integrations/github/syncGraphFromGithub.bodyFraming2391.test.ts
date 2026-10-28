/**
 * #2391 (cor:int:020:01, F1; cor:dmo:120:01): content pushed by the real mirror
 * writer and synced back by the real loader is unchanged, so the resync records
 * no revision and the approval hash holds. Real file-Git transport; synthetic
 * credentials never leave the process.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { computeApprovalHash } from '../../lib/approvalHash.js';
import { computeContentHash } from '../../lib/contentHash.js';

const SOURCE = 'https://github.com/synthetic/framing2391.git';
const env = vi.hoisted(() => ({ root: '', bare: '' }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  get GRAPHS_PATH() { return env.root; },
}));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'synthetic'),
  toHttpsUrl: (source: string) => source,
}));
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => ({
    stdout: execFileSync('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', `url.${env.bare}.insteadOf=${SOURCE}`, ...args,
    ], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '',
  })),
}));
import { pushMemoryToGit } from './pushMemoryToGit.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] });

/** The gate's required rows (#2391 CHECKED), plus a lone CR and a Unicode boundary. */
const STORED: Record<string, string> = {
  plain: 'X',
  'trailing-newline': 'X\n',
  'leading-newline': '\nX',
  'indented-code': '    code\n',
  'lone-cr': 'A\rB',
  'unicode-boundary': ' X ',
};

let graph: MemoryWithOrg;
beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  env.root = mkdtempSync(join(tmpdir(), 'hadron-2391-'));
  env.bare = join(env.root, 'remote.git');
  const seed = join(env.root, 'seed');
  git(env.root, 'init', '--bare', '-b', 'main', env.bare);
  git(env.root, 'clone', env.bare, seed);
  writeFileSync(join(seed, '.gitkeep'), '');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed'); git(seed, 'push', 'origin', 'main');
  rmSync(seed, { recursive: true, force: true });
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Framing fixture', urn: 'framing2391-org', githubInstallationId: 123 } });
  graph = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'Framing', urn: 'framing2391-org:mirror', class: 'knowledge', source: SOURCE },
    include: { organization: true },
  });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(env.root, { recursive: true, force: true }); });

const approval = (n: { name: string; abstract: string | null; content: string | null }) =>
  computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });

it('push then sync keeps boundary whitespace: same content, same hashes, no revision', async () => {
  for (const [loc, content] of Object.entries(STORED)) {
    await db.node.create({ data: {
      id: generateId(), memoryId: graph.id, loc, name: loc, nodeType: 'info', content,
      contentHash: computeContentHash(content), ownerRepo: 'synthetic/framing2391',
    } });
  }
  const before = await db.node.findMany({ where: { memoryId: graph.id }, orderBy: { loc: 'asc' } });

  expect((await pushMemoryToGit(graph.id)).error).toBeUndefined();
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();

  const after = await db.node.findMany({ where: { memoryId: graph.id, loc: { in: Object.keys(STORED) } }, orderBy: { loc: 'asc' } });
  expect(after.map((n) => [n.loc, n.content])).toEqual(before.map((n) => [n.loc, n.content]));
  expect(after.map((n) => [n.loc, approval(n)])).toEqual(before.map((n) => [n.loc, approval(n)]));
  expect(after.map((n) => [n.loc, n.contentHash])).toEqual(before.map((n) => [n.loc, n.contentHash]));
  const revisions = await db.nodeRevision.findMany({ where: { nodeId: { in: before.map((n) => n.id) } }, select: { loc: true, revLabel: true } });
  expect(revisions).toEqual([]);
});

it('a file whose body carries whitespace the stored text lacks records it once (ruled first-resync effect)', async () => {
  const node = await db.node.create({ data: {
    id: generateId(), memoryId: graph.id, loc: 'trimmed', name: 'trimmed', nodeType: 'info', content: 'X', ownerRepo: 'synthetic/framing2391',
  } });
  expect((await pushMemoryToGit(graph.id)).error).toBeUndefined();
  const seed = join(env.root, 'edit');
  git(env.root, 'clone', env.bare, seed);
  writeFileSync(join(seed, 'trimmed.md'), `---\nid: ${node.id}\nname: trimmed\n---\n\n    X\n\n`);
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'indent'); git(seed, 'push', 'origin', 'main');

  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('    X\n');
  expect(await db.nodeRevision.count({ where: { nodeId: node.id, revLabel: 'Synchronized from GitHub' } })).toBe(1);

  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
});
