/**
 * #2043 (S6, cor:agt:040:05/:11) — the compiled-node write guard and the
 * worker-session boot-prompt refusal. A compiled node is written only by a
 * compile (withCompileWrite); a worker session never edits a boot prompt.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

// Pierces the fail-fast merge preflights so a test can reach the in-transaction recheck.
const preflight = vi.hoisted(() => ({ off: false }));
vi.mock('../../../lib/bootPrompt.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/bootPrompt.js')>();
  return {
    ...real,
    assertNoBootPromptMergeCollisions: (...a: Parameters<typeof real.assertNoBootPromptMergeCollisions>) => (preflight.off ? Promise.resolve() : real.assertNoBootPromptMergeCollisions(...a)),
    assertNoBootPromptRowsForWorkerSession: (...a: Parameters<typeof real.assertNoBootPromptRowsForWorkerSession>) => (preflight.off ? Promise.resolve() : real.assertNoBootPromptRowsForWorkerSession(...a)),
  };
});

let admin: { id: string };
let orgId: string;
let memory: { id: string; urn: string };
let workerId: string;
const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId, agentId: null }, fn);
const ctx = (): Context => ({ db, userId: admin.id, roles: [] });
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const source = (loc = 'boot:source') => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: 'Source', content: 'You are {{worker.name}}.', role: 'boot-prompt' },
});
const compiled = () => withCompileWrite(() => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc: 'boot:compiled', name: 'Compiled', content: 'You are Basil.', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
}));
const snapshot = async (id: string) => ({
  node: await db.node.findUniqueOrThrow({ where: { id } }),
  revisions: await db.nodeRevision.findMany({ where: { nodeId: id }, orderBy: { id: 'asc' } }),
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Boot Org', urn: 'boot.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 204301, githubUsername: 'boot-admin', handle: 'boot-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId, name: 'boot-memory' }, ctx());
  const app = await db.app.create({ data: { id: generateId(), name: 'Boot App', urn: 'boot.example:app', organizationId: org.id } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Boot agent', urn: 'boot.example:agent', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } })).id;
});

describe('guard A: a generic write never touches a compiled node (#2043)', () => {
  it.each([
    ['updateNode', (id: string) => resolvers.Mutation.updateNode(null, { input: { id, content: 'edited' } }, ctx())],
    ['updateNode role strip', (id: string) => resolvers.Mutation.updateNode(null, { input: { id, role: 'notes' } }, ctx())],
    ['updateNode marker strip', (id: string) => resolvers.Mutation.updateNode(null, { input: { id, nodeType: 'info' } }, ctx())],
    ['deleteNode', (id: string) => resolvers.Mutation.deleteNode(null, { nodeRef: id }, ctx())],
    ['moveNode', (id: string) => resolvers.Mutation.moveNode(null, { sourceRef: id, targetUrn: `hrn:node:${memory.urn}:elsewhere:compiled` }, ctx())],
  ])('%s is refused and changes nothing', async (_name, op) => {
    const c = await compiled();
    const before = await snapshot(c.id);
    expect(await codeOf(op(c.id))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await snapshot(c.id)).toEqual(before);
  });

  it('mergeNodes is refused with the compiled node as source or as target', async () => {
    const c = await compiled();
    const s = await source('boot:other');
    for (const input of [{ source: c.id, target: s.id }, { source: s.id, target: c.id }]) {
      expect(await codeOf(resolvers.Mutation.mergeNodes(null, { input }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    }
  });

  it('a generic create of a compiled node is refused', async () => {
    expect(await codeOf(resolvers.Mutation.createNode(null, {
      input: { memoryId: memory.id, loc: 'x:1', name: 'X', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
    }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'x:1' } })).toBe(0);
  });

  it('restoreNodeRevision of a compiled node is refused', async () => {
    const c = await compiled();
    await withCompileWrite(() => resolvers.Mutation.updateNode(null, { input: { id: c.id, content: 'second compile' } }, ctx()));
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: c.id } });
    expect(await codeOf(resolvers.Mutation.restoreNodeRevision(null, { revisionId: rev.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
  });

  it('the compile seam writes and revises a compiled node', async () => {
    const c = await compiled();
    await withCompileWrite(() => resolvers.Mutation.updateNode(null, { input: { id: c.id, content: 'recompiled' } }, ctx()));
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('recompiled');
  });

  it('searchReplaceInNodes skips a compiled node and reports it', async () => {
    const c = await compiled();
    await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeIds: [c.id], fields: ['content'], oldText: 'Basil', newText: 'Eve', dryRun: false },
    }, ctx());
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('You are Basil.');
  });

  it('MCP hadron_update_node and hadron_delete_node on a compiled node are refused', async () => {
    const c = await compiled();
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const urn = `hrn:node:${memory.urn}:boot:compiled`;
    const upd = await mcp.callToolText('hadron_update_node', { urn, content: 'edited' }).catch((e: Error) => e.message);
    expect(String(upd)).toContain('BOOT_PROMPT_COMPILED_WRITE');
    const del = await mcp.callToolText('hadron_delete_node', { urn }).catch((e: Error) => e.message);
    expect(String(del)).toContain('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).toBeNull();
  });
});

describe('the DB backstop: a compiled node keeps its role (#2043)', () => {
  it('rejects stripping the role while the marker stays', async () => {
    const c = await compiled();
    await expect(db.node.update({ where: { id: c.id }, data: { role: 'notes' } })).rejects.toThrow(/chk_nodes_compiled_boot_prompt_role/);
    await expect(db.node.update({ where: { id: c.id }, data: { role: null } })).rejects.toThrow(/chk_nodes_compiled_boot_prompt_role/);
    await db.node.update({ where: { id: c.id }, data: { role: 'boot-prompt.worker' } });
  });
});

describe('guard B: a worker session never edits a boot prompt (#2043, cor:agt:040:11)', () => {
  it('refuses update, role removal, reclassification, create and delete; the manager as themselves succeeds', async () => {
    const s = await source();
    const plain = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'n:1', name: 'Plain', content: 'p', role: 'notes' } });
    const before = await snapshot(s.id);
    const refused = (fn: () => Promise<unknown>) => asWorker(() => codeOf(fn()));
    expect(await refused(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'edit' } }, ctx())))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await refused(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, role: 'notes' } }, ctx())))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await refused(() => resolvers.Mutation.updateNode(null, { input: { id: plain.id, role: 'boot-prompt' } }, ctx())))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await refused(() => resolvers.Mutation.createNode(null, { input: { memoryId: memory.id, loc: 'b:2', name: 'B', role: 'boot-prompt' } }, ctx())))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await refused(() => resolvers.Mutation.deleteNode(null, { nodeRef: s.id }, ctx())))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await snapshot(s.id)).toEqual(before);
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'b:2' } })).toBe(0);
    // controls: ordinary node edits by the same session; the manager as themselves.
    expect(await refused(() => resolvers.Mutation.updateNode(null, { input: { id: plain.id, content: 'ok' } }, ctx()))).toBe('NO_ERROR');
    expect(await codeOf(resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'by the manager' } }, ctx()))).toBe('NO_ERROR');
  });

  it('a worker session replace-text skips boot-prompt sources; cloneMemory and mergeMemories refuse whole', async () => {
    const s = await source();
    await asWorker(() => resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeIds: [s.id], fields: ['content'], oldText: 'You', newText: 'We', dryRun: false },
    }, ctx()));
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('You are {{worker.name}}.');
    const target = await resolvers.Mutation.createMemory(null, { orgId, name: 'boot-target' }, ctx());
    const targetBefore = await db.node.count({ where: { memoryId: target.id } });
    expect(await asWorker(() => codeOf(resolvers.Mutation.cloneMemory(null, { ref: memory.id, targetUrn: `hrn:mem:${memory.urn}-clone` }, ctx()))))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await asWorker(() => codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx()))))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await db.node.count({ where: { memoryId: target.id } })).toBe(targetBefore);
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'boot:source' } })).toBe(1);
  });
});

describe('controls (#2043)', () => {
  it('boot-prompt is a plain role: any writer creates and edits a source', async () => {
    const s = await source();
    expect(await codeOf(resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'edit' } }, ctx()))).toBe('NO_ERROR');
    expect(await codeOf(resolvers.Mutation.createNode(null, { input: { memoryId: memory.id, loc: 'b:3', name: 'B3', role: 'boot-prompt.worker' } }, ctx()))).toBe('NO_ERROR');
  });

  it('cloneMemory by a non-session caller excludes the compiled node and carries the source', async () => {
    await source();
    await compiled();
    const clone = await resolvers.Mutation.cloneMemory(null, { ref: memory.id, targetUrn: `hrn:mem:${memory.urn}-copy` }, ctx());
    const locs = (await db.node.findMany({ where: { memoryId: clone.id }, select: { loc: true } })).map((n) => n.loc);
    expect(locs).toContain('boot:source');
    expect(locs).not.toContain('boot:compiled');
  });
});

describe('merge and MCP twins (#2043)', () => {
  it('an admin merge carries the source and not the compiled node (Elena rule A)', async () => {
    await source();
    const c = await compiled();
    const target = await resolvers.Mutation.createMemory(null, { orgId, name: 'merge-target' }, ctx());
    await resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx());
    const locs = (await db.node.findMany({ where: { memoryId: target.id }, select: { loc: true } })).map((n) => n.loc);
    expect(locs).toContain('boot:source');
    expect(locs).not.toContain('boot:compiled');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).memoryId).toBe(memory.id);
  });

  it('a worker session over MCP: create, update and delete of a boot prompt are refused', async () => {
    const s = await source();
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const urn = `hrn:node:${memory.urn}:boot:source`;
    const call = (tool: string, args: Record<string, unknown>) =>
      asWorker(() => mcp.callToolText(tool, args).catch((e: Error) => e.message));
    expect(String(await call('hadron_update_node', { urn, content: 'edit' }))).toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(String(await call('hadron_create_node', { urn: `hrn:node:${memory.urn}:boot:new`, name: 'New', role: 'boot-prompt' })))
      .toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(String(await call('hadron_delete_node', { urn }))).toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'boot:new' } })).toBe(0);
    const row = await db.node.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.content).toBe('You are {{worker.name}}.');
    expect(row.deletedAt).toBeNull();
  });
});

describe('merge target collisions (#2043, Ruth P2)', () => {
  it('a merge cannot fold a source node onto a compiled target; a worker session cannot fold onto a boot-prompt target', async () => {
    const target = await resolvers.Mutation.createMemory(null, { orgId, name: 'collide-target' }, ctx());
    const tCompiled = await withCompileWrite(() => db.node.create({ data: {
      id: generateId(), memoryId: target.id, loc: 'boot:compiled', name: 'TC', content: 'compiled', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE,
    } }));
    const tSource = await db.node.create({ data: { id: generateId(), memoryId: target.id, loc: 'boot:source', name: 'TS', content: 'target source', role: 'boot-prompt' } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'boot:compiled', name: 'S1', content: 'forged over compiled' } });
    const before = await snapshot(tCompiled.id);
    expect(await codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx())))
      .toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await snapshot(tCompiled.id)).toEqual(before);
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'boot:compiled' } })).toBe(1);
    // worker session: a plain source node colliding with a boot-prompt TARGET source.
    await db.node.deleteMany({ where: { memoryId: memory.id, loc: 'boot:compiled' } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'boot:source', name: 'S2', content: 'plain over boot' } });
    const beforeSrc = await snapshot(tSource.id);
    expect(await asWorker(() => codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx()))))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await snapshot(tSource.id)).toEqual(beforeSrc);
    // control: the same collision by a non-session caller on an ordinary-role target is allowed (admin may fold onto a source).
    expect(await codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx()))).toBe('NO_ERROR');
  });
});

describe('merge batches recheck under their locks (#2043, Jane/Cameron P2)', () => {
  it('with the preflights pierced, the fold and the relocate batch still refuse boot-prompt rows', async () => {
    preflight.off = true;
    try {
      const target = await resolvers.Mutation.createMemory(null, { orgId, name: 'late-target' }, ctx());
      // fold: plain source onto a compiled target, and onto a boot-prompt target under a worker session.
      const tCompiled = await withCompileWrite(() => db.node.create({ data: {
        id: generateId(), memoryId: target.id, loc: 'boot:compiled', name: 'TC', content: 'compiled', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE,
      } }));
      const tSource = await db.node.create({ data: { id: generateId(), memoryId: target.id, loc: 'boot:source', name: 'TS', content: 'target source', role: 'boot-prompt' } });
      await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'boot:compiled', name: 'S1', content: 'forged' } });
      const before = await snapshot(tCompiled.id);
      expect(await codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx())))
        .toBe('BOOT_PROMPT_COMPILED_WRITE');
      expect(await snapshot(tCompiled.id)).toEqual(before);
      await db.node.deleteMany({ where: { memoryId: memory.id, loc: 'boot:compiled' } });
      await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'boot:source', name: 'S2', content: 'plain over boot' } });
      const beforeSrc = await snapshot(tSource.id);
      expect(await asWorker(() => codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx()))))
        .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
      expect(await snapshot(tSource.id)).toEqual(beforeSrc);
      // relocate: a boot-prompt source with no counterpart is not moved by a worker session.
      await db.node.deleteMany({ where: { memoryId: memory.id } });
      const bp = await source('boot:relocate');
      expect(await asWorker(() => codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx()))))
        .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
      expect((await db.node.findUniqueOrThrow({ where: { id: bp.id } })).memoryId).toBe(memory.id);
    } finally {
      preflight.off = false;
    }
  });
});

describe('subtree move (#2043, Jane P2-1)', () => {
  it('a worker session cannot move a boot-prompt source or its subtree; the manager and ordinary nodes can', async () => {
    const s = await source();
    const child = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'boot:source:child', name: 'Child', content: 'c' } });
    const plain = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'n:move', name: 'Plain', content: 'p' } });
    const before = await snapshot(s.id);
    const to = (loc: string) => `hrn:node:${memory.urn}:${loc}`;
    expect(await asWorker(() => codeOf(resolvers.Mutation.moveNode(null, { sourceRef: s.id, targetUrn: to('elsewhere:source') }, ctx()))))
      .toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await snapshot(s.id)).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('boot:source:child');
    expect(await asWorker(() => codeOf(resolvers.Mutation.moveNode(null, { sourceRef: plain.id, targetUrn: to('n:moved') }, ctx())))).toBe('NO_ERROR');
    expect(await codeOf(resolvers.Mutation.moveNode(null, { sourceRef: s.id, targetUrn: to('elsewhere:source') }, ctx()))).toBe('NO_ERROR');
  });
});

describe('the invariants file is copied verbatim into its migration (#2043)', () => {
  it('migration carries prisma/boot-prompt-invariants.sql and post-push includes it', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const invariants = read('../../../../prisma/boot-prompt-invariants.sql');
    const dir = fileURLToPath(new URL('../../../../prisma/migrations/', import.meta.url));
    const migration = readdirSync(dir).filter((d) => /_boot_prompt_compiled_check$/.test(d)).sort().at(-1)!;
    expect(read(`../../../../prisma/migrations/${migration}/migration.sql`)).toContain(invariants);
    expect(read('../../../../prisma/post-push.sql')).toContain('\\ir boot-prompt-invariants.sql');
  });
});
