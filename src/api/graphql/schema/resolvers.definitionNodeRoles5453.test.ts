/**
 * #5453 PR A (Ask 2) — the compile-only write guard, keyed on the ROLE `prompt.boot.compiled`.
 *
 * Until #5453 a compiled boot prompt was told apart by a node type of its own. The mark is the role now, and
 * the guard keeps its strength: outside a compile, no generic door produces, edits, re-roles, retypes, moves,
 * deletes, restores over or copies a `prompt.boot.compiled` node. One pin per door, each on a node that is
 * type `system` (so the old type-keyed guard cannot be what refuses it).
 *
 * The same file pinned what PR A must NOT change: guard B's reach (a worker session wrote a rule and was refused a
 * source). PR B (Ask 5) removed guard B, so those three tests are restated at the end: a worker session writes a
 * rule AND a source, and a compiled node stays out of its reach like anyone's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const COMPILED = 'prompt.boot.compiled';
const SOURCE = 'prompt.boot.source';
const RULE = 'prompt.boot.rule';

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
const mk = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: 'You are Basil.', ...extra },
});
/** A compiled prompt as #5453 stores it: type `system`, role `prompt.boot.compiled`. */
const compiled = (memoryId = memory.id, loc = 'boot:compiled') =>
  withCompileWrite(() => mk(memoryId, loc, { nodeType: 'system', role: COMPILED }));
const snapshot = async (id: string) => ({
  node: await db.node.findUniqueOrThrow({ where: { id } }),
  revisions: await db.nodeRevision.findMany({ where: { nodeId: id }, orderBy: { id: 'asc' } }),
});
const mcp = () => createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
const urn = (loc: string) => `hrn:node:${memory.urn}:${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Roles Org', urn: 'roles5453.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 545301, githubUsername: 'roles-admin', handle: 'roles-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: orgId, name: 'roles-memory' }, ctx());
  const app = await db.app.create({ data: { id: generateId(), name: 'Roles App', urn: 'roles5453.example:app', organizationId: org.id } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Roles agent', urn: 'roles5453.example:agent', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } })).id;
});

describe('#5453 guard A by role: one pin per generic door', () => {
  it('door CREATE: a generic create cannot produce a compiled node (GraphQL and MCP)', async () => {
    expect(await codeOf(resolvers.Mutation.createNode(null, {
      input: { memoryRef: memory.id, loc: 'x:1', name: 'X', nodeType: 'system', role: COMPILED },
    }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    const viaMcp = await mcp().callToolText('hadron_create_node', { urn: urn('x:2'), name: 'X2', nodeType: 'system', role: COMPILED }).catch((e: Error) => e.message);
    expect(String(viaMcp)).toContain('BOOT_PROMPT_COMPILED_WRITE');
    expect(await db.node.count({ where: { memoryId: memory.id, loc: { in: ['x:1', 'x:2'] } } })).toBe(0);
  });

  it('door CREATE: the retired node type is refused with the same code, before the database sees it', async () => {
    expect(await codeOf(resolvers.Mutation.createNode(null, {
      input: { memoryRef: memory.id, loc: 'x:3', name: 'X', nodeType: 'compiled-boot-prompt', role: 'boot-prompt' },
    }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'x:3' } })).toBe(0);
  });

  it.each([
    ['edits the text', { content: 'edited' }],
    ['strips the role to another role', { role: 'notes' }],
    ['strips the role to the source leaf', { role: SOURCE }],
    ['retypes it', { nodeType: 'info' }],
  ])('door UPDATE: a generic update that %s is refused and changes nothing', async (_name, change) => {
    const c = await compiled();
    const before = await snapshot(c.id);
    expect(await codeOf(resolvers.Mutation.updateNode(null, { input: { ref: c.id, ...change } }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await snapshot(c.id)).toEqual(before);
  });

  it('door UPDATE: a generic update cannot make a node compiled by setting the role (GraphQL and MCP)', async () => {
    const plain = await mk(memory.id, 'n:plain', { nodeType: 'system' });
    const before = await snapshot(plain.id);
    expect(await codeOf(resolvers.Mutation.updateNode(null, { input: { ref: plain.id, role: COMPILED } }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    const viaMcp = await mcp().callToolText('hadron_update_node', { urn: urn('n:plain'), role: COMPILED }).catch((e: Error) => e.message);
    expect(String(viaMcp)).toContain('BOOT_PROMPT_COMPILED_WRITE');
    expect(await snapshot(plain.id)).toEqual(before);
  });

  it('door UPDATE and DELETE over MCP: a compiled node is refused', async () => {
    const c = await compiled();
    const upd = await mcp().callToolText('hadron_update_node', { urn: urn('boot:compiled'), content: 'edited' }).catch((e: Error) => e.message);
    expect(String(upd)).toContain('BOOT_PROMPT_COMPILED_WRITE');
    const del = await mcp().callToolText('hadron_delete_node', { urn: urn('boot:compiled') }).catch((e: Error) => e.message);
    expect(String(del)).toContain('BOOT_PROMPT_COMPILED_WRITE');
    const row = await db.node.findUniqueOrThrow({ where: { id: c.id } });
    expect([row.content, row.deletedAt]).toEqual(['You are Basil.', null]);
  });

  it('door DELETE: deleteNode is refused and the node stays live', async () => {
    const c = await compiled();
    expect(await codeOf(resolvers.Mutation.deleteNode(null, { nodeRef: c.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).toBeNull();
  });

  it('door MOVE: moveNode is refused for the node and for a subtree that holds it', async () => {
    const c = await compiled();
    const parent = await mk(memory.id, 'boot');
    expect(await codeOf(resolvers.Mutation.moveNode(null, { sourceRef: c.id, targetUrn: urn('elsewhere:compiled') }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await codeOf(resolvers.Mutation.moveNode(null, { sourceRef: parent.id, targetUrn: urn('elsewhere') }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).loc).toBe('boot:compiled');
  });

  it('door MERGE (nodes): refused with the compiled node as source or as target', async () => {
    const c = await compiled();
    const s = await mk(memory.id, 'boot:other', { nodeType: 'system', role: SOURCE });
    for (const input of [{ source: c.id, target: s.id }, { source: s.id, target: c.id }]) {
      expect(await codeOf(resolvers.Mutation.mergeNodes(null, { input }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).toBeNull();
  });

  it('door MERGE (memories): a source node cannot fold onto a compiled target, and a compiled source is not carried', async () => {
    const target = await resolvers.Mutation.createMemory(null, { orgRef: orgId, name: 'roles-target' }, ctx());
    const tCompiled = await compiled(target.id);
    await mk(memory.id, 'boot:compiled', { content: 'forged over compiled' });
    const before = await snapshot(tCompiled.id);
    expect(await codeOf(resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await snapshot(tCompiled.id)).toEqual(before);
    // The other direction: the source memory's own compiled node stays where it is; its plain neighbour moves.
    await db.node.deleteMany({ where: { memoryId: memory.id, loc: 'boot:compiled' } });
    await db.node.deleteMany({ where: { memoryId: target.id, loc: 'boot:compiled' } });
    const sCompiled = await compiled(memory.id);
    await mk(memory.id, 'boot:source', { nodeType: 'system', role: SOURCE });
    await resolvers.Mutation.mergeMemories(null, { input: { source: memory.id, target: target.id } }, ctx());
    const locs = (await db.node.findMany({ where: { memoryId: target.id }, select: { loc: true } })).map((n) => n.loc);
    expect(locs).toContain('boot:source');
    expect(locs).not.toContain('boot:compiled');
    expect((await db.node.findUniqueOrThrow({ where: { id: sCompiled.id } })).memoryId).toBe(memory.id);
  });

  it('door RESTORE (revision): restoreNodeRevision of a compiled node is refused', async () => {
    const c = await compiled();
    await withCompileWrite(() => resolvers.Mutation.updateNode(null, { input: { ref: c.id, content: 'second compile' } }, ctx()));
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: c.id } });
    const before = await snapshot(c.id);
    expect(await codeOf(resolvers.Mutation.restoreNodeRevision(null, { nodeRevRef: rev.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await snapshot(c.id)).toEqual(before);
  });

  it('door RESTORE (revision): a revision that would turn a plain node into a compiled one is refused', async () => {
    const plain = await mk(memory.id, 'n:was', { nodeType: 'system' });
    await resolvers.Mutation.updateNode(null, { input: { ref: plain.id, content: 'second' } }, ctx());
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: plain.id } });
    await db.nodeRevision.update({ where: { id: rev.id }, data: { role: COMPILED } });
    expect(await codeOf(resolvers.Mutation.restoreNodeRevision(null, { nodeRevRef: rev.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: plain.id } })).role).toBeNull();
  });

  it('door RESTORE (undelete): restoreNode of a retired compiled node is refused and it stays retired', async () => {
    const c = await compiled();
    await db.node.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    expect(await codeOf((resolvers.Mutation as any).restoreNode(null, { nodeRef: c.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).not.toBeNull();
  });

  it('door DELETE (subtree): deleting a parent with its descendants is refused while a compiled node is under it', async () => {
    const c = await compiled();
    const parent = await mk(memory.id, 'boot');
    expect(await codeOf((resolvers.Mutation as any).deleteNode(null, { nodeRef: parent.id, recursive: true }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: parent.id } })).deletedAt).toBeNull();
  });

  it('door UPDATE (edges): an edge from a compiled node is not created, changed or removed by a generic write', async () => {
    const c = await compiled();
    const other = await mk(memory.id, 'notes:target');
    const kept = await db.edge.create({ data: { id: generateId(), memoryId: memory.id, loc: 'boot:compiled->notes:target', name: 'compiled-from', sourceId: c.id, targetId: other.id } as never });
    const M = resolvers.Mutation as any;
    expect(await codeOf(M.createEdge(null, { sourceRef: c.id, targetRef: other.id, name: 'cites' }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await codeOf(M.updateEdge(null, { edgeRef: kept.id, description: 'changed' }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await codeOf(M.deleteEdge(null, { edgeRef: kept.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await db.edge.findMany({ where: { sourceId: c.id }, select: { id: true, name: true, deletedAt: true } })).toEqual([{ id: kept.id, name: 'compiled-from', deletedAt: null }]);
  });

  it('door CREATE (MCP parent): hadron_create_parent_node at a compiled node\'s address is refused', async () => {
    const c = await compiled();
    const out = await mcp().callToolText('hadron_create_parent_node', { urn: urn('boot:compiled'), name: 'Hijack' }).catch((e: Error) => e.message);
    expect(String(out)).toContain('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).name).toBe('boot:compiled');
  });

  it('door CLONE: a whole-memory copy carries the source and the rule, never the compiled node', async () => {
    await compiled();
    await mk(memory.id, 'boot:source', { nodeType: 'system', role: SOURCE });
    await mk(memory.id, 'boot:rules:core', { nodeType: 'system', role: RULE });
    await mk(memory.id, 'notes:plain');
    const clone = await resolvers.Mutation.cloneMemory(null, { ref: memory.id, targetUrn: `hrn:mem:${memory.urn}-copy` }, ctx());
    const locs = (await db.node.findMany({ where: { memoryId: clone.id }, select: { loc: true } })).map((n) => n.loc);
    expect(locs).toEqual(expect.arrayContaining(['boot:source', 'boot:rules:core', 'notes:plain']));
    expect(locs).not.toContain('boot:compiled');
  });

  it('door REPLACE: searchReplaceInNodes skips a compiled node', async () => {
    const c = await compiled();
    await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeRefs: [c.id], fields: ['content'], oldText: 'Basil', newText: 'Eve', dryRun: false },
    }, ctx());
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('You are Basil.');
  });

  it('the compile seam still writes and revises a compiled node', async () => {
    const c = await compiled();
    await withCompileWrite(() => resolvers.Mutation.updateNode(null, { input: { ref: c.id, content: 'recompiled' } }, ctx()));
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('recompiled');
  });

  it('a worker session is refused every one of these too (the compiled refusal comes first)', async () => {
    const c = await compiled();
    const refused = (fn: () => Promise<unknown>) => asWorker(() => codeOf(fn()));
    expect(await refused(() => resolvers.Mutation.updateNode(null, { input: { ref: c.id, content: 'edit' } }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await refused(() => resolvers.Mutation.deleteNode(null, { nodeRef: c.id }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect(await refused(() => resolvers.Mutation.createNode(null, { input: { memoryRef: memory.id, loc: 'x:w', name: 'X', nodeType: 'system', role: COMPILED } }, ctx())))
      .toBe('BOOT_PROMPT_COMPILED_WRITE');
  });
});

describe('#5453 the database backstop', () => {
  it('refuses the retired node type on any row, whatever its role', async () => {
    const insert = (role: string | null) => db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `r:${generateId().slice(-6)}`, name: 'r', nodeType: 'compiled-boot-prompt', role } });
    await expect(insert('boot-prompt')).rejects.toThrow(/chk_nodes_compiled_boot_prompt_kind/);
    await expect(insert(COMPILED)).rejects.toThrow(/chk_nodes_compiled_boot_prompt_kind/);
    await expect(insert(null)).rejects.toThrow(/chk_nodes_compiled_boot_prompt_kind/);
  });

  it('keeps a compiled node type system: no other type may carry the compiled role', async () => {
    const c = await compiled();
    await expect(db.node.update({ where: { id: c.id }, data: { nodeType: 'info' } })).rejects.toThrow(/chk_nodes_compiled_boot_prompt_kind/);
    await expect(mk(memory.id, 'r:info', { nodeType: 'info', role: COMPILED })).rejects.toThrow(/chk_nodes_compiled_boot_prompt_kind/);
    // A source or a rule of another type is not the constraint's business.
    await mk(memory.id, 'r:source', { nodeType: 'info', role: SOURCE });
  });
});

describe('#5453 PR B (Ask 5): guard B is gone. PR A kept its reach (a boot prompt itself, never a rule); a worker session now writes both', () => {
  it('a worker session creates, edits, moves and deletes a prompt.boot.rule node, as it did a boot-prompt-rule one', async () => {
    const ok = (fn: () => Promise<unknown>) => asWorker(() => codeOf(fn()));
    expect(await ok(() => resolvers.Mutation.createNode(null, { input: { memoryRef: memory.id, loc: 'boot:rules:new', name: 'New', nodeType: 'system', role: RULE, content: 'a rule' } }, ctx()))).toBe('NO_ERROR');
    const rule = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'boot:rules:new' } });
    expect(await ok(() => resolvers.Mutation.updateNode(null, { input: { ref: rule.id, content: 'edited by the worker' } }, ctx()))).toBe('NO_ERROR');
    expect(await ok(() => resolvers.Mutation.moveNode(null, { sourceRef: rule.id, targetUrn: urn('boot:rules:moved') }, ctx()))).toBe('NO_ERROR');
    expect(await ok(() => resolvers.Mutation.deleteNode(null, { nodeRef: rule.id }, ctx()))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: rule.id } })).deletedAt).not.toBeNull();
  });

  it('a worker session edits and deletes a source, by leaf and by the bare role, creates one and turns a rule into one (each refused under PR A)', async () => {
    const admitted = (fn: () => Promise<unknown>) => asWorker(() => codeOf(fn()));
    const leaf = await mk(memory.id, 'boot:source', { nodeType: 'system', role: SOURCE });
    const bare = await mk(memory.id, 'boot:legacy', { role: 'boot-prompt' });
    const rule = await mk(memory.id, 'boot:rules:core', { nodeType: 'system', role: RULE });
    for (const n of [leaf, bare]) {
      expect(await admitted(() => resolvers.Mutation.updateNode(null, { input: { ref: n.id, content: 'edit' } }, ctx()))).toBe('NO_ERROR');
      expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).content).toBe('edit');
      expect(await admitted(() => resolvers.Mutation.deleteNode(null, { nodeRef: n.id }, ctx()))).toBe('NO_ERROR');
      expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).deletedAt).not.toBeNull();
    }
    expect(await admitted(() => resolvers.Mutation.createNode(null, { input: { memoryRef: memory.id, loc: 'b:2', name: 'B', role: SOURCE } }, ctx()))).toBe('NO_ERROR');
    expect(await admitted(() => resolvers.Mutation.updateNode(null, { input: { ref: rule.id, role: SOURCE } }, ctx()))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: rule.id } })).role).toBe(SOURCE);
    // What it still cannot do: turn either into a compiled node.
    expect(await admitted(() => resolvers.Mutation.updateNode(null, { input: { ref: rule.id, role: COMPILED } }, ctx()))).toBe('BOOT_PROMPT_COMPILED_WRITE');
  });

  it('a worker session replaces text in a rule and in a source; its clone of a memory holding either is not refused', async () => {
    const rule = await mk(memory.id, 'boot:rules:core', { nodeType: 'system', role: RULE });
    await asWorker(() => resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeRefs: [rule.id], fields: ['content'], oldText: 'Basil', newText: 'Eve', dryRun: false },
    }, ctx()));
    expect((await db.node.findUniqueOrThrow({ where: { id: rule.id } })).content).toBe('You are Eve.');
    expect(await asWorker(() => codeOf(resolvers.Mutation.cloneMemory(null, { ref: memory.id, targetUrn: `hrn:mem:${memory.urn}-wclone` }, ctx())))).toBe('NO_ERROR');
    const src = await mk(memory.id, 'boot:source', { nodeType: 'system', role: SOURCE });
    await asWorker(() => resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeRefs: [src.id], fields: ['content'], oldText: 'Basil', newText: 'Eve', dryRun: false },
    }, ctx()));
    expect((await db.node.findUniqueOrThrow({ where: { id: src.id } })).content).toBe('You are Eve.');
    expect(await asWorker(() => codeOf(resolvers.Mutation.cloneMemory(null, { ref: memory.id, targetUrn: `hrn:mem:${memory.urn}-wclone2` }, ctx()))))
      .toBe('NO_ERROR');
  });
});
