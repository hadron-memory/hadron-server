/** #2043: git sync never writes a compiled boot prompt, and a worker session's sync never touches a boot prompt. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { runAsActor } from '../../lib/requestActor.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../lib/bootPrompt.js';
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
      role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE,
    } }));
    mirror('compiled', `id: ${c.id}\nname: Hijacked`, 'forged text');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      name: 'Compiled', content: 'compiled text', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE,
    });
  });

  it('a worker session\'s sync that would write a boot-prompt node is refused', async () => {
    const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'test-org:app', organizationId: graph.organizationId! } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'test-org:agent', organizationId: graph.organizationId! } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    mirror('source', 'name: Source\nrole: boot-prompt', 'You are a worker.');
    const result = await runAsActor({ workerId: worker.id, agentId: null }, () => syncGraphFromGithub(graph));
    expect(result.error ?? '').toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'source' } })).toBe(0);
    // control: the server's own sync (no worker) writes the same source.
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'source' } })).toBe(1);
  });

  it('repo-wins cleanup keeps a compiled node whose file is gone, and prunes an ordinary repo row (control)', async () => {
    const compiledRow = await withCompileWrite(() => db.node.create({ data: {
      id: generateId(), memoryId: graph.id, loc: 'compiled', name: 'Compiled', content: 'compiled text',
      role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE, ownerRepo: 'test/repo',
    } }));
    const ordinary = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'gone', name: 'Gone', content: 'x', ownerRepo: 'test/repo' } });
    mirror('other', 'name: Other', 'present');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: compiledRow.id } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: ordinary.id } })).toBeNull();
  });

  it('a worker session\'s sync that would prune a boot-prompt source is refused whole', async () => {
    const app = await db.app.create({ data: { id: generateId(), name: 'App', urn: 'test-org:app', organizationId: graph.organizationId! } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'test-org:agent', organizationId: graph.organizationId! } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    const src = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'boot-source', name: 'Src', content: 'x', role: 'boot-prompt', ownerRepo: 'test/repo' } });
    mirror('other', 'name: Other', 'present');
    const refused = await runAsActor({ workerId: worker.id, agentId: null }, () => syncGraphFromGithub(graph));
    expect(refused.error ?? '').toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await db.node.findUnique({ where: { id: src.id } })).not.toBeNull();
    // control: the server's own sync (no worker) prunes the absent source.
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUnique({ where: { id: src.id } })).toBeNull();
  });

  it('the saved worker requester survives the system re-entry used by the preflight retry', async () => {
    const { withSyncCaller, boundWorkerId } = await import('../../lib/bootPrompt.js');
    const { runAsSystem } = await import('../../lib/requestActor.js');
    const seen = await runAsActor({ workerId: 'w-1', agentId: null }, () =>
      withSyncCaller(boundWorkerId(), () => runAsSystem(async () => {
        const first = boundWorkerId();
        // the recursive call re-wraps exactly as the exported entry point does
        return withSyncCaller(boundWorkerId(), () => runAsSystem(async () => [first, boundWorkerId()]));
      })));
    expect(seen).toEqual(['w-1', 'w-1']);
  });
});
