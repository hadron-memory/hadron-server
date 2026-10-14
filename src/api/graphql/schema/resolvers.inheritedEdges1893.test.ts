/**
 * #1893 (cor:dmo:050:14; Holger, team chat #10968 item 2) — an inherited
 * node's edges come through the child it is read through, resolved the way
 * bare-loc links are (#10932): an endpoint the child overrides resolves to
 * the child's node, an endpoint not in effect (a base boot prompt) drops the
 * edge, both directions alike. An endpoint outside the chain shows only when
 * the reader may read its own memory. S7 stays shut: no edge, at any depth,
 * hands a child-only reader a base node that is not in effect for the child.
 *
 * The reader is a participant of an App that installs only `backend-engineer`;
 * the manager reads `engineer` directly and sees its raw edges.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const N = (resolvers as any).Node;
const E = (resolvers as any).Edge;

let n: number;
let org: { id: string; urn: string };
let reader: string;
let manager: string;
let engineer: { id: string; mem: string; memUrn: string };
let backend: { id: string; mem: string; memUrn: string };
let openMem: { id: string; urn: string };
let closedMem: { id: string; urn: string };
const ids: Record<string, string> = {};

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const mcp = (tool: string, params: Record<string, unknown>) =>
  createTestableMcpServer({ userId: reader, roles: ['READER'], clientId: `user:${reader}` }).callToolText(tool, params);
const childUrn = (loc: string) => `hrn:node:${backend.memUrn}:${loc}`;
const baseUrn = (loc: string) => `hrn:node:${engineer.memUrn}:${loc}`;

async function agent(slug: string, baseId?: string) {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: slug, urn: memUrn } });
  const a = await db.agent.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: baseId ?? null } });
  return { id: a.id, mem: mem.id, memUrn };
}

async function node(key: string, memoryId: string, loc: string, role?: string) {
  ids[key] = (await db.node.create({ data: { memoryId, loc, name: key, content: `${key} body`, role: role ?? null } })).id;
}

async function edge(from: string, to: string, name: string, memoryId: string) {
  await db.edge.create({ data: { memoryId, sourceId: ids[from]!, targetId: ids[to]!, name, loc: `e:${from}:${to}` } });
}

/** Read processes:release through the child, as GraphQL serves it. */
const releaseThroughChild = () => Q.node({}, { ref: 'processes:release', memoryRef: backend.mem }, ctx(reader));
const targets = async (parent: any, c: Context) =>
  Promise.all((await N.outgoingEdges(parent, {}, c)).map(async (e: any) => ({ name: e.name, target: await E.target(e, {}, c) })));
const sources = async (parent: any, c: Context) =>
  Promise.all((await N.incomingEdges(parent, {}, c)).map(async (e: any) => ({ name: e.name, source: await E.source(e, {}, c) })));

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Edges', urn: `edges-${n}.example` }, select: { id: true, urn: true } });
  const otherOrg = await db.organization.create({ data: { name: 'Other', urn: `edges-other-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `edges-reader-${n}`, roles: ['READER'] } })).id;
  manager = (await db.user.create({ data: { handle: `edges-manager-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager, role: 'ADMIN' } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer.id);
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: backend.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader, role: 'member' } });
  openMem = await db.memory.create({ data: { class: 'knowledge', organizationId: org.id, name: 'Open', urn: `${org.urn}:open`, visibility: 'PUBLIC' }, select: { id: true, urn: true } });
  closedMem = await db.memory.create({ data: { class: 'knowledge', organizationId: otherOrg.id, name: 'Closed', urn: `${otherOrg.urn}:closed`, visibility: 'ORGANIZATION' }, select: { id: true, urn: true } });

  await node('release', engineer.mem, 'processes:release', 'process.release');
  await node('engOpenPr', engineer.mem, 'tasks:open-pr');
  await node('ship', engineer.mem, 'tasks:ship');
  await node('boot', engineer.mem, 'prompts:boot', 'boot-prompt');
  await node('backOpenPr', backend.mem, 'tasks:open-pr');
  await node('own', backend.mem, 'notes:own');
  await node('openDoc', openMem.id, 'docs:open');
  await node('closedDoc', closedMem.id, 'docs:closed');

  await edge('release', 'engOpenPr', 'stage 1', engineer.mem); // overridden endpoint → the child's node
  await edge('release', 'ship', 'stage 2', engineer.mem); // inherited endpoint → survives
  await edge('release', 'boot', 'boots', engineer.mem); // base boot prompt → dropped
  await edge('release', 'openDoc', 'cites', engineer.mem); // outside the chain, readable → kept
  await edge('release', 'closedDoc', 'cites-closed', engineer.mem); // outside, unreadable → dropped
  await edge('ship', 'release', 'part of', engineer.mem); // incoming from an inherited node
  await edge('engOpenPr', 'release', 'part of', engineer.mem); // incoming from an overridden node → the child's
  await edge('boot', 'release', 'mentions', engineer.mem); // incoming from a boot prompt → dropped
  await edge('own', 'release', 'uses', backend.mem); // incoming from the child's own node
});

describe('GraphQL — outgoing edges through the child', () => {
  it('an overridden endpoint resolves to the child\'s node; an inherited one survives, stamped; a boot prompt and an unreadable outsider are dropped', async () => {
    const release = await releaseThroughChild();
    const got = await targets(release, ctx(reader));
    const byName = new Map(got.map((g: any) => [g.name, g.target]));
    expect([...byName.keys()].sort()).toEqual(['cites', 'stage 1', 'stage 2']);
    expect(byName.get('stage 1').id).toBe(ids.backOpenPr);
    expect(N.inheritedFrom(byName.get('stage 1'))).toBeNull();
    expect(byName.get('stage 2').id).toBe(ids.ship);
    expect(N.inheritedFrom(byName.get('stage 2'))?.agentId).toBe(engineer.id);
    expect(await N.urn(byName.get('stage 2'), {}, ctx(reader))).toBe(baseUrn('tasks:ship'));
    expect(byName.get('cites').id).toBe(ids.openDoc);
    // S7: no edge hands over engineer's overridden node or its boot prompt.
    const allIds = got.map((g: any) => g.target?.id);
    expect(allIds).not.toContain(ids.engOpenPr);
    expect(allIds).not.toContain(ids.boot);
    expect(allIds).not.toContain(ids.closedDoc);
  });

  it('a resolved inherited endpoint is the sanitized projection, and its own edges resolve through the same child', async () => {
    const release = await releaseThroughChild();
    const ship = (await targets(release, ctx(reader))).find((g: any) => g.name === 'stage 2').target;
    expect(await N.memory(ship, {}, ctx(reader))).toBeNull();
    const back = await targets(ship, ctx(reader));
    expect(back.map((g: any) => g.target.id)).toEqual([ids.release]);
    expect(N.inheritedFrom(back[0].target)?.agentId).toBe(engineer.id);
  });
});

describe('GraphQL — incoming edges through the child', () => {
  it('from the child\'s own node, from an inherited node, from an overridden node as the child\'s; never from a boot prompt', async () => {
    const release = await releaseThroughChild();
    const got = await sources(release, ctx(reader));
    const srcIds = got.map((g: any) => g.source.id).sort();
    expect(srcIds).toEqual([ids.own, ids.ship, ids.backOpenPr].sort());
    expect(srcIds).not.toContain(ids.engOpenPr);
    expect(srcIds).not.toContain(ids.boot);
  });
});

describe('GraphQL — both ends of every served edge resolve for the child-only reader', () => {
  it('the inherited node\'s own end is never re-gated away, in either direction, cross-memory included', async () => {
    const release = await releaseThroughChild();
    for (const e of await N.outgoingEdges(release, {}, ctx(reader))) {
      expect((await E.source(e, {}, ctx(reader)))?.id).toBe(ids.release);
      expect(await E.target(e, {}, ctx(reader))).not.toBeNull();
    }
    for (const e of await N.incomingEdges(release, {}, ctx(reader))) {
      expect((await E.target(e, {}, ctx(reader)))?.id).toBe(ids.release);
      expect(await E.source(e, {}, ctx(reader))).not.toBeNull();
    }
  });
});

describe('GraphQL — every #1891 surface carries the child', () => {
  it('a findNodes hit and an appNodes row resolve their edges too', async () => {
    const hit = (await Q.findNodes({}, { filter: { memoryIds: [backend.mem] } }, ctx(reader))).hits
      .map((h: any) => h.node).find((x: any) => x.id === ids.release);
    expect((await targets(hit, ctx(reader))).map((g: any) => g.target.id).sort()).toEqual([ids.backOpenPr, ids.ship, ids.openDoc].sort());
    const app = await db.app.findFirstOrThrow({ where: { organizationId: org.id } });
    const row = (await Q.appNodes({}, { appRef: app.id }, ctx(reader))).find((x: any) => x.id === ids.release);
    expect((await targets(row, ctx(reader))).map((g: any) => g.target.id)).not.toContain(ids.engOpenPr);
  });

  it('nodeBatch, prefix and explicit, the same', async () => {
    const pre = (await Q.nodeBatch(null, { memory: backend.mem, locPrefix: 'processes:' }, ctx(reader))).nodes[0];
    const exp = (await Q.nodeBatch(null, { refs: [childUrn('processes:release')] }, ctx(reader))).nodes[0];
    for (const x of [pre, exp]) {
      expect(x.id).toBe(ids.release);
      expect((await targets(x, ctx(reader))).map((g: any) => g.target.id)).not.toContain(ids.engOpenPr);
    }
  });

  it('a reader of the base reads its node directly with its raw edges, unchanged', async () => {
    const release = await Q.node({}, { ref: 'processes:release', memoryRef: engineer.mem }, ctx(manager));
    expect(N.inheritedFrom(release)).toBeNull();
    const got = (await targets(release, ctx(manager))).map((g: any) => g.target?.id);
    expect(got).toEqual(expect.arrayContaining([ids.engOpenPr, ids.ship, ids.boot]));
  });
});

describe('MCP — the same edges', () => {
  it('hadron_get_node through the child: Related and Referenced by resolve through it', async () => {
    const out = await mcp('hadron_get_node', { urn: childUrn('processes:release') });
    expect(out).toContain('Related:');
    expect(out).toContain(childUrn('tasks:open-pr'));
    expect(out).toContain(baseUrn('tasks:ship'));
    expect(out).toContain(`hrn:node:${openMem.urn}:docs:open`);
    expect(out).not.toContain(baseUrn('tasks:open-pr'));
    expect(out).not.toContain(baseUrn('prompts:boot'));
    expect(out).not.toContain('docs:closed');
    expect(out).toContain('Referenced by:');
    expect(out).toContain(childUrn('notes:own'));
  });

  it('hadron_get_nodes (explicit and prefix) and hadron_find_nodes brief, the same', async () => {
    for (const out of [
      await mcp('hadron_get_nodes', { refs: [childUrn('processes:release')] }),
      await mcp('hadron_get_nodes', { memoryUrn: `hrn:mem:${backend.memUrn}`, locPrefix: 'processes:' }),
      await mcp('hadron_find_nodes', { query: '*', memoryUrn: `hrn:mem:${backend.memUrn}`, brief: true }),
    ]) {
      expect(out).toContain(childUrn('tasks:open-pr'));
      expect(out).toContain(baseUrn('tasks:ship'));
      expect(out).not.toContain(baseUrn('tasks:open-pr'));
      expect(out).not.toContain(baseUrn('prompts:boot'));
      expect(out).not.toContain('docs:closed');
    }
  });
});
