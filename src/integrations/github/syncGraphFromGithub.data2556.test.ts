/** #2556: real file-Git import; synthetic credentials never leave the process. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import type { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { writeNodeFile } from './writeNodeToGit.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';

const SOURCE = 'https://github.com/synthetic/data2556.git';
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
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] });
const payload = { nullValue: null, falseValue: false, nested: [[], {}, { unicode: '🧪', text: 'true', multiline: 'a\n---\nb' }], decimal: '12345678901234567890' };
let seed: string;
let graph: MemoryWithOrg;
const commit = () => { git(seed, 'add', '-A'); git(seed, 'commit', '--allow-empty', '-m', 'fixture'); git(seed, 'push', 'origin', 'main'); };
const file = (loc: string, nodeType: string, data: Prisma.InputJsonValue = payload) => writeNodeFile(seed, {
  id: generateId(), loc, name: loc, nodeType, data, content: null, tags: [], outgoingEdges: [],
});

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  env.root = mkdtempSync(join(tmpdir(), 'hadron-2556-'));
  env.bare = join(env.root, 'remote.git'); seed = join(env.root, 'seed');
  git(env.root, 'init', '--bare', '-b', 'main', env.bare);
  git(env.root, 'clone', env.bare, seed);
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Import fixture', urn: 'data2556-org', githubInstallationId: 123 } });
  graph = await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'Import', urn: 'data2556-org:fresh', class: 'knowledge', source: SOURCE }, include: { organization: true } });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(env.root, { recursive: true, force: true }); });

it('imports every exported bodyless data node with exact type and payload into a fresh memory', async () => {
  file('datasets:first', 'data'); file('datasets:second', 'data', { ...payload, second: true });
  file('custom', 'third-party-widget'); commit();
  const result = await syncGraphFromGithub(graph);
  expect(result.error).toBeUndefined();
  const rows = await db.node.findMany({ where: { memoryId: graph.id }, orderBy: { loc: 'asc' } });
  expect(rows.map(({ loc, nodeType, data, content }) => ({ loc, nodeType, data, content }))).toEqual([
    { loc: 'custom', nodeType: 'third-party-widget', data: payload, content: null },
    { loc: 'datasets:first', nodeType: 'data', data: payload, content: null },
    { loc: 'datasets:second', nodeType: 'data', data: { ...payload, second: true }, content: null },
  ]);
});

it('preserves existing type and payload when both keys are absent, by id and by loc', async () => {
  const existing = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'kept', name: 'Kept', nodeType: 'data', data: payload, ownerRepo: 'synthetic/data2556' } });
  writeFileSync(join(seed, 'kept.md'), `---\nid: ${existing.id}\nname: Kept\n---\n`); commit();
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(await db.node.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ nodeType: 'data', data: payload });
  writeFileSync(join(seed, 'kept.md'), '---\nname: Kept\n---\n'); commit();
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(await db.node.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ nodeType: 'data', data: payload });
});

it('applies explicit type and payload on an existing row', async () => {
  await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'changed', name: 'Old', nodeType: 'info', data: { old: true }, ownerRepo: 'synthetic/data2556' } });
  file('changed', 'data'); commit();
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  const row = await db.node.findFirstOrThrow({ where: { memoryId: graph.id, loc: 'changed' } });
  expect(row.nodeType).toBe('data'); expect(row.data).toEqual(payload);
});

it('keeps omitted keys absent in both filesystem layouts', async () => {
  writeFileSync(join(seed, 'plain.md'), '---\nname: Plain\n---\n');
  const legacy = join(seed, 'legacy'); mkdirSync(join(legacy, '.node'), { recursive: true });
  writeFileSync(join(legacy, '.node', 'node.yaml'), 'name: Legacy\n');
  for (const path of [join(seed, 'plain.md'), legacy]) {
    const { node } = await loadNodeFromFs(path, seed, 'synthetic/data2556');
    expect(node).not.toHaveProperty('nodeType'); expect(node).not.toHaveProperty('data');
  }
});

it('reads type and data through the legacy layout too', async () => {
  const legacy = join(seed, 'legacy'); mkdirSync(join(legacy, '.node'), { recursive: true });
  writeFileSync(join(legacy, '.node', 'node.yaml'), 'name: Legacy\ntype: data\ndata:\n  enabled: false\n');
  const { node } = await loadNodeFromFs(legacy, seed, 'synthetic/data2556');
  expect(node).toMatchObject({ nodeType: 'data', data: { enabled: false } });
});
