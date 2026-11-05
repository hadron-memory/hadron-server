import { syncGraphFromGithub } from './syncGraphFromGithub.js';
/** #3507: real Git file-transport export, with no GitHub/network dependency. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

// Track real unlinks: the bulk loop can otherwise delete a live child then rewrite it later, masking the destructive operation.
vi.mock('fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fixture-token'), toHttpsUrl: (source: string) => source }));

const SOURCE = 'https://github.com/synthetic/data3507.git';
const env = vi.hoisted(() => ({ root: '', bare: '' }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  get GRAPHS_PATH() { return env.root; },
}));
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => ({
    stdout: execFileSync('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', `url.${env.bare}.insteadOf=https://github.com/synthetic/data3507.git`, ...args.map(a => a.replace('https://x-access-token:fixture-token@github.com/', 'https://github.com/')),
    ], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    stderr: '',
  })),
}));
import { writeNodeToGit, writeNodeFile } from './writeNodeToGit.js';
import { readNodeFileId } from './nodeFrontmatter.js';
import { pushMemoryToGit } from './pushMemoryToGit.js';

const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let memoryId: string;
beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  env.root = mkdtempSync(join(tmpdir(), 'hadron-3507-'));
  env.bare = mkdtempSync(join(tmpdir(), 'hadron-3507-bare-'));
  const seed = mkdtempSync(join(tmpdir(), 'hadron-3507-seed-'));
  try {
    git(env.bare, 'init', '--bare', '-b', 'main');
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, '.gitkeep'), '');
    git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed');
    git(seed, 'push', env.bare, 'main');
  } finally { rmSync(seed, { recursive: true, force: true }); }
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Export fixture', urn: 'data3507-org', githubInstallationId: 123 } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Export', urn: 'data3507-org:fixture', class: 'knowledge', source: SOURCE, readBranch: 'main', writeBranch: 'main' } });
  memoryId = memory.id;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});


const parent = async () => db.node.create({ data: { id: generateId(), memoryId, loc: 'a', name: 'a', content: 'parent' } });
const checkout = () => join(env.root, 'data3507-org', 'fixture');
const legacyPath = () => join(checkout(), 'a', 'README.md');
const incremental = (node: Awaited<ReturnType<typeof parent>>) => writeNodeToGit({ ...node, tags: [], outgoingEdges: [] }, 'synthetic/data3507', null, memoryId);
const mirror = (node: Awaited<ReturnType<typeof parent>>) => writeNodeFile(checkout(), { ...node, tags: [], outgoingEdges: [] });

for (const route of ['incremental', 'bulk'] as const) {
  it(`${route}: preserves a live a:README file when writing a`, async () => {
    const a = await parent();
    const child = await db.node.create({ data: { id: generateId(), memoryId, loc: 'a:README', name: 'child', content: 'live child' } });
    // Both nodes are mirrored before the parent is written again.
    expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
    // Re-mirror the child even on broken main, then observe the parent update.
    mirror(child);
    const before = readFileSync(legacyPath(), 'utf8');
    vi.mocked(rmSync).mockClear();
    if (route === 'bulk') {
      expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
      expect(git(env.bare, 'show', 'refs/heads/main:a/README.md')).toBe(before.trim());
    } else await incremental(a);
    expect(readFileSync(legacyPath(), 'utf8')).toBe(before);
    expect(readNodeFileId(legacyPath())).toBe(child.id);
    expect(rmSync).not.toHaveBeenCalledWith(legacyPath(), { force: true });
  });

  for (const ownership of ['own', 'missing-id', 'malformed'] as const) {
    it(`${route}: removes ${ownership} legacy README when no live child owns the loc`, async () => {
      const a = await parent();
      expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
      mkdirSync(join(checkout(), 'a'), { recursive: true });
      const body = ownership === 'own' ? `---\nid: ${a.id}\n---\nlegacy\n`
        : ownership === 'missing-id' ? '---\nname: human\n---\nhand-authored\n' : '---\nid: [broken\n---\nunknown\n';
      writeFileSync(legacyPath(), body);
      if (route === 'bulk') expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
      else await incremental(a);
      expect(existsSync(legacyPath())).toBe(false);
    });
  }
}

// Xan control ruling / Rico P2: preserving a stale legacy parent can roll back the live row on repo-wins sync.
for (const route of ['incremental', 'bulk'] as const) {
 for (const ownership of ['missing-id', 'foreign-id'] as const) {
  it(`${route}: sync after writing keeps the edited row over a stale ${ownership} legacy README`, async () => {
   let foreignId: string | undefined;
   if (ownership === 'foreign-id') {
    const own = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const foreign = await db.memory.create({ data: { organizationId: own.organizationId, name: 'Foreign', urn: 'data3507-org:foreign', class: 'knowledge' } });
    const child = await db.node.create({ data: { memoryId: foreign.id, loc: 'server:README', name: 'Foreign child', content: 'foreign' } });
    foreignId = child.id;
   }
   const seed = mkdtempSync(join(tmpdir(), 'hadron-3507-roundtrip-'));
   try {
    git(seed, 'clone', env.bare, '.');
    mkdirSync(join(seed, 'server'), { recursive: true });
    writeFileSync(join(seed, 'README.md'), `---\nid: ${generateId()}\nname: Root\n---\nroot\n`);
    writeFileSync(join(seed, 'server', 'README.md'), `---\n${foreignId ? 'id: ' + foreignId + '\n' : ''}name: Server\n---\nstale repo text\n`);
    git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'legacy parent'); git(seed, 'push', 'origin', 'main');
   } finally { rmSync(seed, { recursive: true, force: true }); }
   const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, include: { organization: true } });
   expect((await syncGraphFromGithub(memory)).error).toBeUndefined();
   const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'server' } });
   const edited = await db.node.update({ where: { id: row.id }, data: { content: 'edited in hadron' } });
   if (route === 'bulk') expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
   else await incremental(edited);
   expect((await syncGraphFromGithub(memory)).error).toBeUndefined();
   expect((await db.node.findUniqueOrThrow({ where: { id: row.id } })).content?.trim()).toBe('edited in hadron');
   expect(existsSync(join(checkout(), 'server', 'README.md'))).toBe(false);
   if (foreignId) expect((await db.node.findUniqueOrThrow({ where: { id: foreignId } })).content).toBe('foreign');
  });
 }
 it(`${route}: a soft-deleted README child does not preserve a stale legacy file`, async () => {
  const a = await parent();
  await db.node.create({ data: { memoryId, loc: 'a:README', name: 'retired child', deletedAt: new Date() } });
  expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
  mkdirSync(join(checkout(), 'a'), { recursive: true });
  writeFileSync(legacyPath(), '---\nname: old\n---\nstale\n');
  if (route === 'bulk') expect((await pushMemoryToGit(memoryId)).error).toBeUndefined();
  else await incremental(a);
  expect(existsSync(legacyPath())).toBe(false);
 });
}
