/**
 * #5453 PR B (Ask 5) — the Git sync door. A sync asked for by a worker session writes, changes and prunes a boot
 * prompt source like any other mirrored node (the worker-session refusal is gone on every door); it still never
 * writes a compiled boot prompt, whoever asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { runAsActor } from '../../lib/requestActor.js';
import { BOOT_PROMPT_COMPILED_ROLE, BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../lib/bootPrompt.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({
  getInstallationToken: vi.fn(async () => 'fake-token'),
  toHttpsUrl: vi.fn((source: string) => source),
}));
let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;
let workerId: string;
vi.mock('../../config.js', async (original) => ({
  ...await original<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
const repoRoot = () => join(graphsPath, 'test-org', 'boot-memory');
const rootId = 'aaaa5453000000000000000000000001';
function mirror(loc: string, frontmatter: string, body: string) {
  mkdirSync(repoRoot(), { recursive: true });
  writeFileSync(join(repoRoot(), 'README.md'), `---\nid: ${rootId}\nname: Root\n---\nRoot body\n`);
  writeFileSync(join(repoRoot(), `${loc}.md`), `---\n${frontmatter}\n---\n${body}\n`);
}
const syncAsWorker = () => runAsActor({ workerId, agentId: null }, () => syncGraphFromGithub(graph));

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'boot-memory' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: {
    urn: 'test-org:boot-memory', source: 'git@github.com:test/repo.git', readBranch: 'main',
  }, include: { organization: true } });
  const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'test-org:app', organizationId: org.id } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'test-org:agent', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } })).id;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('#5453 Ask 5: a worker session\'s Git sync and boot prompts', () => {
  it.each([
    ['the source leaf', 'role: boot-prompt.source\ntype: system', 'boot-prompt.source'],
    ['the bare legacy role', 'role: boot-prompt', 'boot-prompt'],
    ['a rule', 'role: boot-prompt.rule\ntype: system', 'boot-prompt.rule'],
  ])('it creates a node that declares %s', async (_name, frontmatter, role) => {
    mirror('source', `name: Source\n${frontmatter}`, 'You are a worker.');
    expect((await syncAsWorker()).error).toBeUndefined();
    const node = await db.node.findFirstOrThrow({ where: { memoryId: graph.id, loc: 'source' } });
    expect(node.role).toBe(role);
    expect(node.content).toContain('You are a worker.');
  });

  it('it changes the text of an existing source', async () => {
    const src = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'source', name: 'Source', content: 'old text', role: 'boot-prompt.source', nodeType: 'system', ownerRepo: 'test/repo' } });
    mirror('source', `id: ${src.id}\nname: Source\nrole: boot-prompt.source\ntype: system`, 'new text from the repository');
    expect((await syncAsWorker()).error).toBeUndefined();
    expect((await db.node.findUniqueOrThrow({ where: { id: src.id } })).content).toContain('new text from the repository');
  });

  it('it prunes a source whose file is gone, as the server\'s own sync does', async () => {
    const src = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'boot-source', name: 'Src', content: 'x', role: 'boot-prompt.source', nodeType: 'system', ownerRepo: 'test/repo' } });
    mirror('other', 'name: Other', 'present');
    expect((await syncAsWorker()).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: src.id } })).toBeNull();
  });

  it('it still never writes a compiled boot prompt: a file on one is skipped, a file declaring the role creates nothing, and a missing file prunes none', async () => {
    const c = await withCompileWrite(() => db.node.create({ data: {
      id: generateId(), memoryId: graph.id, loc: 'compiled', name: 'Compiled', content: 'compiled text',
      role: BOOT_PROMPT_COMPILED_ROLE, nodeType: BOOT_PROMPT_NODE_TYPE, ownerRepo: 'test/repo',
    } }));
    mirror('compiled', `id: ${c.id}\nname: Hijacked\nrole: boot-prompt.source\ntype: info`, 'forged text');
    mirror('forged', 'name: Forged\nrole: boot-prompt.compiled\ntype: system', 'forged compiled text');
    expect((await syncAsWorker()).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      name: 'Compiled', content: 'compiled text', nodeType: BOOT_PROMPT_NODE_TYPE, role: BOOT_PROMPT_COMPILED_ROLE,
    });
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'forged' } })).toBe(0);
    // The file is gone on the next sync: repo-wins cleanup keeps the compiled node.
    const { rmSync } = await import('fs');
    rmSync(join(repoRoot(), 'compiled.md'));
    expect((await syncAsWorker()).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: c.id } })).not.toBeNull();
  });
});
