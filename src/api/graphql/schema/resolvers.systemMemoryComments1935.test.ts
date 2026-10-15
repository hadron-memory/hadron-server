/**
 * #1935 — system memories are commentable (cor:dmo:110:02, Holger #11565), and
 * a comment there is never content (cor:dmo:110): it reaches no Agent list, no
 * agent retrieval and no inherited read.
 *
 * Fixture: `backend-engineer` extends `engineer`. The reader participates in
 * an App that installs only `backend-engineer`, so they read its system memory
 * (and engineer's nodes only as backend inherits them), never engineer's own.
 * The org admin comments on both Agents' task, index and process nodes through
 * the comment path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import {
  descendantMemoriesInheriting, effectiveScope, findEffectiveNodeIdByLoc, inheritedNodeIds, systemMemoryChain,
} from '../../../lib/effectiveSystemMemory.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const N = (resolvers as any).Node;

let n: number;
let org: { id: string; urn: string };
let reader: string;
let admin: string;
let engineer: { id: string; mem: string; memUrn: string };
let backend: { id: string; mem: string; memUrn: string };
const ids: Record<string, string> = {};
const comments: Record<string, string> = {};

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const mcp = (userId: string, tool: string, params: Record<string, unknown>) =>
  createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` }).callToolText(tool, params);
const hitIds = (res: { hits: Array<{ node: { id: string } }> }) => res.hits.map((h) => h.node.id);
const nodeUrn = (memUrn: string, loc: string) => `hrn:node:${memUrn}:${loc}`;

async function agent(slug: string, base?: { id: string }) {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: memUrn } });
  const a = await db.agent.create({
    data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: base?.id ?? null },
  });
  return { id: a.id, mem: mem.id, memUrn };
}

async function node(key: string, memoryId: string, loc: string, data: { role?: string; isRunnable?: boolean } = {}) {
  ids[key] = (await db.node.create({
    data: { memoryId, loc, name: key, content: `${key} body`, role: data.role ?? null, isRunnable: data.isRunnable ?? null },
  })).id;
}

let edgeN = 0;
async function edge(source: string, target: string, name: string) {
  const src = await db.node.findUniqueOrThrow({ where: { id: ids[source] } });
  await db.edge.create({ data: { memoryId: src.memoryId, sourceId: ids[source], targetId: ids[target], name, loc: `e${++edgeN}` } });
}

/** A comment through the comment path (the only way one is made, cor:dmo:110:04). */
async function comment(key: string, target: string) {
  const c = await M.createComment(null, { targetRef: ids[target], body: `DISCUSSION ${key}` }, { db, userId: admin, roles: [] });
  comments[key] = c.id;
}

const allComments = () => Object.values(comments);

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'SysComments', urn: `syscmt1935-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `sc-reader-${n}`, roles: ['READER'] } })).id;
  admin = (await db.user.create({ data: { handle: `sc-admin-${n}`, roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer);
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: backend.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader, role: 'member' } });

  await node('engIndex', engineer.mem, 'tasks');
  await node('engOpenPr', engineer.mem, 'tasks:open-pr', { isRunnable: true });
  await node('engBoot', engineer.mem, 'prompts:boot', { role: 'boot-prompt' });
  await edge('engOpenPr', 'engIndex', 'when a PR is ready');
  await db.agent.update({ where: { id: engineer.id }, data: { tasksIndexRef: ids.engIndex } });

  await node('beIndex', backend.mem, 'tasks');
  await node('beDeploy', backend.mem, 'tasks:deploy', { isRunnable: true });
  await node('beProcIndex', backend.mem, 'processes');
  await node('beRelease', backend.mem, 'processes:release', { role: 'process' });
  await node('beBoot', backend.mem, 'prompts:boot', { role: 'boot-prompt' });
  await edge('beDeploy', 'beIndex', 'when deploying');
  await edge('beRelease', 'beProcIndex', 'when I cut a release');
  await edge('beRelease', 'beDeploy', 'stage 1: deploy');
  await db.agent.update({ where: { id: backend.id }, data: { tasksIndexRef: ids.beIndex, processesIndexRef: ids.beProcIndex } });

  // Discussion everywhere an Agent list or an inherited read could pick it up.
  await comment('onEngIndex', 'engIndex');
  await comment('onEngOpenPr', 'engOpenPr');
  await comment('onEngBoot', 'engBoot');
  await comment('onBeIndex', 'beIndex');
  await comment('onBeDeploy', 'beDeploy');
  await comment('onBeProcIndex', 'beProcIndex');
  await comment('onBeRelease', 'beRelease');
  await comment('onBeBoot', 'beBoot');
});

describe('the comments exist where they were made (#1935)', () => {
  it('each lives in its target\'s system memory', async () => {
    const rows = await db.node.findMany({ where: { id: { in: allComments() } }, select: { memoryId: true, nodeType: true } });
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.nodeType === 'comment')).toBe(true);
    expect(rows.filter((r) => r.memoryId === engineer.mem)).toHaveLength(3);
  });
});

describe('the Agent task and process lists never list a comment (#1896)', () => {
  it('GraphQL agentTaskList / agentProcessList', async () => {
    const tasks = (await Q.agentTaskList({}, { ref: backend.id }, ctx(reader))) as Array<{ node: { id: string }; trigger: string | null }>;
    expect(tasks.map((t) => t.node.id).sort()).toEqual([ids.beDeploy, ids.engOpenPr].sort());
    expect(tasks.some((t) => t.trigger === 'comment-anchor')).toBe(false);
    const procs = (await Q.agentProcessList({}, { ref: backend.id }, ctx(reader))) as Array<{ node: { id: string } }>;
    expect(procs.map((p) => p.node.id)).toEqual([ids.beRelease]);
  });

  it('MCP hadron_agent_tasks / hadron_agent_processes', async () => {
    const tasks = await mcp(reader, 'hadron_agent_tasks', { agentRef: backend.id });
    const procs = await mcp(reader, 'hadron_agent_processes', { agentRef: backend.id });
    for (const text of [tasks, procs]) {
      expect(text).not.toMatch(/comments:|comment-anchor|DISCUSSION on/);
    }
    expect(tasks).toContain('tasks:deploy');
    expect(procs).toContain('processes:release');
  });
});

describe('a base\'s comment is never inherited (#1891/#1899)', () => {
  it('the effective-memory helpers never pass it down', async () => {
    const c = comments.onEngOpenPr;
    const loc = `comments:${c}`;
    const inherited = await inheritedNodeIds(db, await systemMemoryChain(db, backend.mem));
    expect(inherited.has(ids.engOpenPr)).toBe(true);
    for (const k of ['onEngIndex', 'onEngOpenPr', 'onEngBoot']) expect(inherited.has(comments[k])).toBe(false);
    const scope = await effectiveScope(db, [backend.mem]);
    expect(scope.memoryIds).toContain(engineer.mem);
    expect(scope.excludeNodeIds).toContain(c);
    expect(scope.excludeNodeIds).not.toContain(ids.engOpenPr);
    expect(await findEffectiveNodeIdByLoc(db, backend.mem, loc)).toBeNull();
    expect((await findEffectiveNodeIdByLoc(db, engineer.mem, loc))?.id).toBe(c);
    expect(await descendantMemoriesInheriting(db, { id: c, memoryId: engineer.mem, loc, role: null })).toEqual([]);
    expect(await descendantMemoriesInheriting(db, { id: ids.engOpenPr, memoryId: engineer.mem, loc: 'tasks:open-pr', role: null }))
      .toEqual([backend.mem]);
  });

  it('node(ref:) and hadron_get_node through the child do not resolve it', async () => {
    const engCommentLoc = `comments:${comments.onEngOpenPr}`;
    expect(await Q.node(null, { ref: nodeUrn(backend.memUrn, engCommentLoc) }, ctx(reader))).toBeNull();
    const text = await mcp(reader, 'hadron_get_node', { urn: nodeUrn(backend.memUrn, engCommentLoc) });
    expect(text).not.toMatch(/DISCUSSION on/);
    // Control: the child's own comment still reads through the same path.
    const own = await mcp(reader, 'hadron_get_node', { urn: nodeUrn(backend.memUrn, `comments:${comments.onBeDeploy}`) });
    expect(own).toContain('DISCUSSION onBeDeploy');
  });

  it('an inherited node\'s edges, read through the child, carry no comment', async () => {
    const inherited = await Q.node(null, { ref: nodeUrn(backend.memUrn, 'tasks:open-pr') }, ctx(reader));
    expect(inherited?.id).toBe(ids.engOpenPr);
    expect(N.inheritedFrom(inherited)?.agentId).toBe(engineer.id);
    const incoming = await N.incomingEdges(inherited, {}, ctx(reader));
    const outgoing = await N.outgoingEdges(inherited, {}, ctx(reader));
    const names = [...incoming, ...outgoing].map((e: { name: string | null }) => e.name);
    expect(names).not.toContain('comment-anchor');
    expect(names).not.toContain('comment-reply');
  });

  it('findNodes over the child with comments asked for returns only the child\'s own', async () => {
    for (const contentScope of ['COMMENTS', 'ALL'] as const) {
      const got = hitIds(await Q.findNodes({}, { filter: { memoryIds: [backend.mem], contentScope } }, ctx(reader)));
      for (const k of ['onEngIndex', 'onEngOpenPr', 'onEngBoot']) expect(got).not.toContain(comments[k]);
      for (const k of ['onBeIndex', 'onBeDeploy', 'onBeProcIndex', 'onBeRelease', 'onBeBoot']) expect(got).toContain(comments[k]);
    }
  });
});

describe('agent retrieval over the system memory shows content only (cor:dmo:110:08)', () => {
  it('findNodes by default, and the MCP list / find / search tools', async () => {
    const got = hitIds(await Q.findNodes({}, { filter: { memoryIds: [backend.mem] } }, ctx(reader)));
    expect(got).toContain(ids.beDeploy);
    expect(got).toContain(ids.engOpenPr);
    for (const id of allComments()) expect(got).not.toContain(id);

    const memoryUrn = `hrn:mem:${backend.memUrn}`;
    const listed = await mcp(reader, 'hadron_list_nodes', { memoryUrn, depth: 3 });
    const found = await mcp(reader, 'hadron_find_nodes', { memoryUrn, query: 'DISCUSSION' });
    const searched = await mcp(reader, 'hadron_search', { query: 'DISCUSSION' });
    for (const text of [listed, found, searched]) expect(text).not.toMatch(/DISCUSSION on|comments:/);
    expect(listed).toContain('tasks:deploy');
    expect(listed).toContain('tasks:open-pr');
    // Control: asking for comments by name finds the child's own, never the base's.
    const asked = await mcp(reader, 'hadron_find_nodes', { memoryUrn, query: 'DISCUSSION', nodeKind: 'COMMENTS' });
    expect(asked).toContain(`comments:${comments.onBeDeploy}`);
    expect(asked).not.toContain(`comments:${comments.onEngOpenPr}`);
  });
});
