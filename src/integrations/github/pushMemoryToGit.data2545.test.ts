/** #2545: real Git file-transport export, with no GitHub/network dependency. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

const SOURCE = 'https://github.com/synthetic/data2545.git';
const env = vi.hoisted(() => ({ root: '', bare: '' }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  get GRAPHS_PATH() { return env.root; },
}));
vi.mock('./execGit.js', () => ({
  execGit: vi.fn(async (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => ({
    stdout: execFileSync('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', `url.${env.bare}.insteadOf=https://github.com/synthetic/data2545.git`, ...args,
    ], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    stderr: '',
  })),
}));
import { pushMemoryToGit } from './pushMemoryToGit.js';

const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let memoryId: string;
const payload = {
  count: 7, enabled: false, missing: null,
  nested: { values: ['alpha', 0, true, { text: '🧪 payload' }] },
  coercibleStrings: ['true', 'false', 'null', '1.0', '0123', '2024-01-01', 'yes', 'no', '.nan', '1e3'],
  multiline: 'first line\n---\nlast line\n',
  'key: with colon': { '#hash': 'value: #still text' },
  emptyObject: {}, emptyArray: [],
  largeJsonNumber: Number.MAX_SAFE_INTEGER,
  // JSON cannot store BigInt or losslessly represent integers beyond this range.
  largeDecimalIdentifier: '123456789012345678901234567890',
};

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  env.root = mkdtempSync(join(tmpdir(), 'hadron-2545-'));
  env.bare = mkdtempSync(join(tmpdir(), 'hadron-2545-bare-'));
  const seed = mkdtempSync(join(tmpdir(), 'hadron-2545-seed-'));
  try {
    git(env.bare, 'init', '--bare', '-b', 'main');
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, '.gitkeep'), '');
    git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed');
    git(seed, 'push', env.bare, 'main');
  } finally { rmSync(seed, { recursive: true, force: true }); }
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Export fixture', urn: 'data2545-org' } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Export', urn: 'data2545-org:fixture', class: 'knowledge', source: SOURCE } });
  memoryId = memory.id;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.bare, { recursive: true, force: true });
});

const add = (loc: string, nodeType: string, deletedAt: Date | null = null) => db.node.create({ data: {
  id: generateId(), memoryId, loc, name: loc, nodeType, deletedAt,
  content: nodeType === 'data' ? null : `body ${loc}`,
  data: nodeType === 'data' ? payload : undefined,
} });
const remoteFiles = () => git(env.bare, 'ls-tree', '-r', '--name-only', 'refs/heads/main').split('\n');
const remoteFile = (path: string) => git(env.bare, 'show', `refs/heads/main:${path}`);

it('pushes a bodyless structured data node and preserves its complete payload in the remote artifact', async () => {
  const node = await add('datasets:sample', 'data');
  const result = await pushMemoryToGit(memoryId);
  expect(result.error).toBeUndefined();
  expect(remoteFiles()).toContain('datasets/sample.md');
  const text = remoteFile('datasets/sample.md');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  expect(match).not.toBeNull();
  const artifact = parse(match![1]);
  expect(artifact).toMatchObject({ id: node.id, type: 'data' });
  expect(artifact.data).toEqual(payload);
  expect(text.slice(match![0].length).trim()).toBe('');
  expect(result.nodeCount).toBe(1);
});

it('keeps a soft-deleted data node out of a fresh remote', async () => {
  await add('datasets:deleted', 'data', new Date());
  const result = await pushMemoryToGit(memoryId);
  expect(result).toMatchObject({ nodeCount: 0 });
  expect(result.error).toBeUndefined();
  expect(remoteFiles()).not.toContain('datasets/deleted.md');
});

it('keeps ordinary, custom and reserved node-type export behavior unchanged', async () => {
  const types = ['info', 'prompt', 'record', 'system', 'third-party-widget', 'chat-message'];
  for (const type of types) await add(`controls:${type}`, type);
  const result = await pushMemoryToGit(memoryId);
  expect(result.error).toBeUndefined();
  expect(result.nodeCount).toBe(types.length);
  for (const type of types) {
    const text = remoteFile(`controls/${type}.md`);
    expect(text).toContain(`body controls:${type}`);
    expect(remoteFiles()).toContain(`controls/${type}.md`);
  }
  // The test checkout and the remote are distinct: assertions above read the pushed commit.
  expect(existsSync(join(env.root, 'data2545-org', 'fixture', '.git'))).toBe(true);
});


it('exports only the requested memory even when another memory has a live data artifact', async () => {
  await add('datasets:own', 'data');
  const ownMemory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  const foreign = await db.memory.create({ data: {
    id: generateId(), organizationId: ownMemory.organizationId, urn: 'data2545-org:foreign',
    name: 'Foreign', class: 'knowledge',
  } });
  await db.node.create({ data: {
    id: generateId(), memoryId: foreign.id, loc: 'datasets:foreign', name: 'Foreign data',
    nodeType: 'data', data: { secret: 'belongs to another memory' },
  } });
  const result = await pushMemoryToGit(memoryId);
  expect(result.error).toBeUndefined();
  expect(result.nodeCount).toBe(1);
  expect(remoteFiles().sort()).toEqual(['.gitkeep', 'README.md', 'datasets/own.md']);
});
