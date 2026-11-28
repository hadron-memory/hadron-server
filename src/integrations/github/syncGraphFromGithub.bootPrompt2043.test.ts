/**
 * #2043: git sync never writes a compiled boot prompt. It also pinned "a worker session's sync never touches a boot
 * prompt"; #5453 Ask 5 removed that refusal on every door, so those tests are restated: a worker session's sync
 * mirrors a source like any other node (more in syncGraphFromGithub.workerSession5453.test.ts).
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
vi.mock('../../config.js', async (original) => ({
  ...await original<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return graphsPath; },
}));
const repoRoot = () => join(graphsPath, 'test-org', 'boot-memory');
const rootId = 'aaaa2043000000000000000000000001';
function mirror(loc: string, frontmatter: string, body: string) {
  mkdirSync(repoRoot(), { recursive: true });
  writeFileSync(join(repoRoot(), 'README.md'), `---\nid: ${rootId}\nname: Root\n---\nRoot body\n`);
  writeFileSync(join(repoRoot(), `${loc}.md`), `---\n${frontmatter}\n---\n${body}\n`);
}
beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'test-org', graphName: 'boot-memory' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: {
    urn: 'test-org:boot-memory', source: 'git@github.com:test/repo.git', readBranch: 'main',
  }, include: { organization: true } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('git sync and boot prompts (#2043)', () => {
  it('a mirrored file at a compiled node is skipped and the node kept', async () => {
    const c = await withCompileWrite(() => db.node.create({ data: {
      id: generateId(), memoryId: graph.id, loc: 'compiled', name: 'Compiled', content: 'compiled text',
      role: BOOT_PROMPT_COMPILED_ROLE, nodeType: BOOT_PROMPT_NODE_TYPE,
    } }));
    mirror('compiled', `id: ${c.id}\nname: Hijacked`, 'forged text');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      name: 'Compiled', content: 'compiled text', nodeType: BOOT_PROMPT_NODE_TYPE, role: BOOT_PROMPT_COMPILED_ROLE,
    });
  });

  // #5453 — the compiled mark is the role now, so each arm of the skip is its own row class.
  it('#5453: a file that would re-role or retype a compiled node is skipped, and the role is not overwritten', async () => {
    const c = await withCompileWrite(() => db.node.create({ data: {
      id: generateId(), memoryId: graph.id, loc: 'compiled', name: 'Compiled', content: 'compiled text',
      role: BOOT_PROMPT_COMPILED_ROLE, nodeType: BOOT_PROMPT_NODE_TYPE,
    } }));
    mirror('compiled', `id: ${c.id}\nname: Hijacked\nrole: prompt.boot.source\ntype: info`, 'forged text');
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      name: 'Compiled', content: 'compiled text', nodeType: BOOT_PROMPT_NODE_TYPE, role: BOOT_PROMPT_COMPILED_ROLE,
    });
  });

  it.each([
    ['the compiled role', 'role: prompt.boot.compiled\ntype: system'],
    ['the retired node type', 'role: boot-prompt\ntype: compiled-boot-prompt'],
  ])('#5453: a file that declares %s creates no node (only a compile writes a compiled prompt)', async (_name, frontmatter) => {
    mirror('forged', `name: Forged\n${frontmatter}`, 'forged compiled text');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'forged' } })).toBe(0);
    expect(await db.node.count({ where: { memoryId: graph.id, role: BOOT_PROMPT_COMPILED_ROLE } })).toBe(0);
  });

  it('#5453: a source file that still carries the bare role and type info is written as it is (the tolerated legacy form)', async () => {
    mirror('boot-source', 'name: Source\nrole: boot-prompt\ntype: info', 'You are a worker.');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findFirstOrThrow({ where: { memoryId: graph.id, loc: 'boot-source' } })).toMatchObject({ role: 'boot-prompt' });
  });

  it('#5453 PR A: a worker session\'s sync writes a rule (prompt.boot.rule), as it wrote a boot-prompt-rule one', async () => {
    const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'test-org:app', organizationId: graph.organizationId! } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'test-org:agent', organizationId: graph.organizationId! } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    mirror('rule', 'name: Rule\nrole: prompt.boot.rule\ntype: system', 'Post in the channel.');
    const result = await runAsActor({ workerId: worker.id, agentId: null }, () => syncGraphFromGithub(graph));
    expect(result.error).toBeUndefined();
    expect(await db.node.findFirstOrThrow({ where: { memoryId: graph.id, loc: 'rule' } })).toMatchObject({ role: 'prompt.boot.rule' });
  });

  it('a worker session\'s sync that writes a boot-prompt node is admitted (#5453 Ask 5; refused before)', async () => {
    const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'test-org:app', organizationId: graph.organizationId! } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'test-org:agent', organizationId: graph.organizationId! } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    mirror('source', 'name: Source\nrole: boot-prompt', 'You are a worker.');
    const result = await runAsActor({ workerId: worker.id, agentId: null }, () => syncGraphFromGithub(graph));
    expect(result.error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'source', role: 'boot-prompt' } })).toBe(1);
    // control: the server's own sync (no worker) leaves the same source in place.
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'source' } })).toBe(1);
  });

  it('repo-wins cleanup keeps a compiled node whose file is gone, and prunes an ordinary repo row (control)', async () => {
    const compiledRow = await withCompileWrite(() => db.node.create({ data: {
      id: generateId(), memoryId: graph.id, loc: 'compiled', name: 'Compiled', content: 'compiled text',
      role: BOOT_PROMPT_COMPILED_ROLE, nodeType: BOOT_PROMPT_NODE_TYPE, ownerRepo: 'test/repo',
    } }));
    const ordinary = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'gone', name: 'Gone', content: 'x', ownerRepo: 'test/repo' } });
    mirror('other', 'name: Other', 'present');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: compiledRow.id } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: ordinary.id } })).toBeNull();
  });

  it('a worker session\'s sync prunes a boot-prompt source whose file is gone, as the server\'s own sync does (#5453 Ask 5; refused whole before)', async () => {
    const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'test-org:app', organizationId: graph.organizationId! } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'test-org:agent', organizationId: graph.organizationId! } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    const src = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'boot-source', name: 'Src', content: 'x', role: 'boot-prompt', ownerRepo: 'test/repo' } });
    mirror('other', 'name: Other', 'present');
    const synced = await runAsActor({ workerId: worker.id, agentId: null }, () => syncGraphFromGithub(graph));
    expect(synced.error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: src.id } })).toBeNull();
  });

  it('no worker requester is carried into the sync any more: inside the system scope nothing is bound to a worker (#5453 Ask 5)', async () => {
    // Until #5453 the requester was saved across the system re-entry (`withSyncCaller`) for the worker-session refusal
    // alone. The refusal is gone and so is the carrier: the sync runs as the system, whoever asked.
    const bootPrompt = await import('../../lib/bootPrompt.js');
    const { runAsSystem } = await import('../../lib/requestActor.js');
    expect('withSyncCaller' in bootPrompt).toBe(false);
    const seen = await runAsActor({ workerId: 'w-1', agentId: null }, async () => {
      const outside = bootPrompt.boundWorkerId();
      return [outside, await runAsSystem(async () => bootPrompt.boundWorkerId())];
    });
    expect(seen).toEqual(['w-1', null]);
  });
});
