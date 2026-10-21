/**
 * #1885 slice 2 — reading an Agent's effective system memory on GraphQL
 * (cor:dmo:050:14, the S-cases and Holger's addressing ruling, team chat
 * #10929): an inherited node comes back under its own address, the base's
 * URN, marked as inherited and naming the base; the child's own node wins at a
 * shared loc; a base's boot prompts and overridden nodes never come through.
 *
 * The reader is a participant of an App that installs only `backend-engineer`:
 * they may read its system memory and hold no access to `engineer`'s, so every
 * engineer node they see came through the child (ruling 4).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const N = (resolvers as any).Node;

let n: number;
let org: { id: string; urn: string };
let reader: string;
let manager: string;
let engineer: { id: string; urn: string; mem: string; memUrn: string };
let backend: { id: string; urn: string; mem: string; memUrn: string };
let appId: string;
const ids: Record<string, string> = {};

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

async function agent(slug: string, base?: { id: string }) {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: memUrn } });
  const a = await db.agent.create({
    data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: base?.id ?? null },
  });
  return { id: a.id, urn: a.urn, mem: mem.id, memUrn };
}

async function node(key: string, memoryId: string, loc: string, data: { role?: string; isRunnable?: boolean } = {}) {
  ids[key] = (await db.node.create({ data: { memoryId, loc, name: key, content: key, role: data.role ?? null, isRunnable: data.isRunnable ?? null } })).id;
}

const hitIds = (res: { hits: Array<{ node: { id: string } }> }) => res.hits.map((h) => h.node.id).sort();
const find = (userId: string, filter: Record<string, unknown> = {}) =>
  Q.findNodes({}, { filter: { memoryIds: [backend.mem], ...filter } }, ctx(userId));

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Eff', urn: `effgql-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `eff-reader-${n}`, roles: ['READER'] } })).id;
  manager = (await db.user.create({ data: { handle: `eff-manager-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager, role: 'ADMIN' } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer);
  appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  await db.appAgent.create({ data: { appId, agentId: backend.id } });
  await db.appMember.create({ data: { appId, userId: reader, role: 'member' } });

  await node('engOpenPr', engineer.mem, 'tasks:open-pr', { isRunnable: true });
  await node('engRelease', engineer.mem, 'processes:release', { role: 'process.release' });
  await node('engShip', engineer.mem, 'tasks:ship', { isRunnable: true });
  await node('engBoot', engineer.mem, 'prompts:boot', { role: 'boot-prompt' });
  await node('backOpenPr', backend.mem, 'tasks:open-pr', { isRunnable: true });
  await node('backOwn', backend.mem, 'notes:own');
});

describe('the reader\'s footing', () => {
  it('reads backend-engineer\'s system memory and not engineer\'s', async () => {
    expect((await Q.memory({}, { ref: backend.mem }, ctx(reader)))?.id).toBe(backend.mem);
    expect(await Q.memory({}, { ref: engineer.mem }, ctx(reader))).toBeNull();
    expect(hitIds(await Q.findNodes({}, { filter: { memoryIds: [engineer.mem] } }, ctx(reader)))).toEqual([]);
  });
});

describe('S1 — findNodes over the child returns its effective memory', () => {
  it('the child\'s own nodes plus engineer\'s non-overridden ones, never engineer\'s tasks:open-pr or boot prompt', async () => {
    const res = await find(reader);
    expect(hitIds(res)).toEqual([ids.backOpenPr, ids.backOwn, ids.engRelease, ids.engShip].sort());
  });

  it('marks each inherited node with its base and keeps its own address', async () => {
    const res = await find(reader);
    const byId = new Map(res.hits.map((h: any) => [h.node.id, h.node]));
    const release = byId.get(ids.engRelease) as any;
    expect(N.inheritedFrom(release)).toEqual({ agentId: engineer.id, agentUrn: `hrn:agent:${engineer.urn}` });
    expect(await N.urn(release, {}, ctx(reader))).toBe(`hrn:node:${engineer.memUrn}:processes:release`);
    expect(N.inheritedFrom(byId.get(ids.backOwn))).toBeNull();
  });

  it('filters apply after the override: runnable tasks are the child\'s open-pr and engineer\'s ship', async () => {
    expect(hitIds(await find(reader, { isRunnable: true }))).toEqual([ids.backOpenPr, ids.engShip].sort());
    // A child override that fails the filter still hides the base's node.
    await db.node.update({ where: { id: ids.backOpenPr }, data: { isRunnable: false } });
    expect(hitIds(await find(reader, { isRunnable: true }))).toEqual([ids.engShip]);
  });

  it('a keyword query ranks over the same set', async () => {
    const res = await Q.findNodes({}, { filter: { memoryIds: [backend.mem] }, query: 'engOpenPr OR engRelease OR backOpenPr' }, ctx(reader));
    expect(hitIds(res)).toEqual([ids.backOpenPr, ids.engRelease].sort());
  });

  it('a manager who reads both memories sees engineer\'s own nodes unmarked when engineer is in the scope too', async () => {
    const res = await Q.findNodes({}, { filter: { memoryIds: [backend.mem, engineer.mem] } }, ctx(manager));
    expect(hitIds(res)).toContain(ids.engOpenPr);
    const engNode = res.hits.find((h: any) => h.node.id === ids.engOpenPr).node;
    expect(N.inheritedFrom(engNode)).toBeNull();
  });
});

describe('a bare loc read in the child\'s memory', () => {
  const read = (loc: string) => Q.node({}, { ref: loc, memoryRef: backend.mem }, ctx(reader));

  it('reads through to the base\'s node, under its own address, marked', async () => {
    const got = await read('processes:release');
    expect(got.id).toBe(ids.engRelease);
    expect(N.inheritedFrom(got)).toEqual({ agentId: engineer.id, agentUrn: `hrn:agent:${engineer.urn}` });
    expect(await N.urn(got, {}, ctx(reader))).toBe(`hrn:node:${engineer.memUrn}:processes:release`);
  });

  it('the child\'s own node wins, a base boot prompt is not there, and a missing loc is null', async () => {
    expect((await read('tasks:open-pr')).id).toBe(ids.backOpenPr);
    expect(await read('prompts:boot')).toBeNull();
    expect(await read('nowhere')).toBeNull();
  });

  it('the child deleting its override lets the base\'s show through (read live)', async () => {
    await db.node.update({ where: { id: ids.backOpenPr }, data: { deletedAt: new Date() } });
    expect((await read('tasks:open-pr')).id).toBe(ids.engOpenPr);
  });
});

describe('nodeBatch over a prefix of the child', () => {
  it('returns the child\'s effective tasks, inherited ones marked', async () => {
    const r = await Q.nodeBatch(null, { memory: backend.mem, locPrefix: 'tasks:' }, ctx(reader));
    const got = r.nodes.map((x: any) => x.id).sort();
    expect(got).toEqual([ids.backOpenPr, ids.engShip].sort());
    expect(N.inheritedFrom(r.nodes.find((x: any) => x.id === ids.engShip))?.agentId).toBe(engineer.id);
  });
});

describe('P2-3 (Diego, #1891) — nodeBatch explicit refs read through the child like node(ref:)', () => {
  it('a child URN reads the inherited node, marked; the base URN and base PK stay refused; a boot prompt is unavailable', async () => {
    const r = await Q.nodeBatch(null, {
      refs: [
        `hrn:node:${backend.memUrn}:processes:release`,
        `hrn:node:${backend.memUrn}:tasks:open-pr`,
        `hrn:node:${backend.memUrn}:prompts:boot`,
        `hrn:node:${engineer.memUrn}:tasks:ship`,
        ids.engOpenPr,
      ],
    }, ctx(reader));
    expect(r.nodes.map((x: any) => x.id)).toEqual([ids.engRelease, ids.backOpenPr]);
    expect(N.inheritedFrom(r.nodes[0])?.agentId).toBe(engineer.id);
    expect(N.inheritedFrom(r.nodes[1])).toBeNull();
    expect(r.unavailable).toEqual(expect.arrayContaining([
      `hrn:node:${backend.memUrn}:prompts:boot`, `hrn:node:${engineer.memUrn}:tasks:ship`, ids.engOpenPr,
    ]));
  });
});

describe('a full node URN in the child\'s memory', () => {
  it('reads through to the inherited node in the same order MCP does: own, then moved, then inherited', async () => {
    const got = await Q.node({}, { ref: `hrn:node:${backend.memUrn}:processes:release` }, ctx(reader));
    expect(got.id).toBe(ids.engRelease);
    expect(N.inheritedFrom(got)?.agentId).toBe(engineer.id);
    expect((await Q.node({}, { ref: `hrn:node:${backend.memUrn}:tasks:open-pr` }, ctx(reader))).id).toBe(ids.backOpenPr);
    expect(await Q.node({}, { ref: `hrn:node:${backend.memUrn}:prompts:boot` }, ctx(reader))).toBeNull();
  });

  it('a child URN the reader cannot read reads nothing', async () => {
    const outsider = (await db.user.create({ data: { handle: `eff-out-${n}`, roles: ['READER'] } })).id;
    expect(await Q.node({}, { ref: `hrn:node:${backend.memUrn}:processes:release` }, ctx(outsider))).toBeNull();
  });
});

describe('S7 — never a base\'s other content', () => {
  it('engineer\'s overridden tasks:open-pr is refused by its own URN', async () => {
    expect(await Q.node({}, { ref: `hrn:node:${engineer.memUrn}:tasks:open-pr` }, ctx(reader))).toBeNull();
  });

  it('the base\'s own URN of an inherited node is gated on the base memory until the A/B ruling', async () => {
    // Option (B) behaviour, the seam's current answer (team chat #10938/#10940).
    expect(await Q.node({}, { ref: `hrn:node:${engineer.memUrn}:processes:release` }, ctx(reader))).toBeNull();
  });
});

describe('appNodes over an App that installs the child', () => {
  it('lists the effective memory, marked', async () => {
    const res = await Q.appNodes({}, { appRef: appId }, ctx(reader));
    const got = res.map((r: any) => r.id);
    expect(got).toEqual(expect.arrayContaining([ids.backOpenPr, ids.backOwn, ids.engRelease, ids.engShip]));
    expect(got).not.toContain(ids.engOpenPr);
    expect(got).not.toContain(ids.engBoot);
    expect(N.inheritedFrom(res.find((r: any) => r.id === ids.engShip))?.agentId).toBe(engineer.id);
  });
});

describe('an inherited node shows its content and none of the base tenant\'s records', () => {
  it('edges never reach a base\'s overridden node (#1893 resolves them to the child\'s), no memory, no people', async () => {
    // engineer's release process links engineer's tasks:open-pr, which the child overrides.
    await db.edge.create({
      data: { memoryId: engineer.mem, sourceId: ids.engRelease, targetId: ids.engOpenPr, name: 'stage', loc: 'processes:release:stage:tasks:open-pr' },
    });
    const got = await Q.node({}, { ref: 'processes:release', memoryRef: backend.mem }, ctx(reader));
    expect(got.id).toBe(ids.engRelease);
    expect(got.outgoingEdges.map((e: any) => e.targetId)).toEqual([ids.engOpenPr]); // the raw row …
    const served = await N.outgoingEdges(got, {}, ctx(reader)); // … is never served raw:
    expect(served.map((e: any) => e.target.id)).toEqual([ids.backOpenPr]); // the child's override (#1893)
    expect(await N.incomingEdges(got, {}, ctx(reader))).toEqual([]);
    expect(await N.memory(got, {}, ctx(reader))).toBeNull();
    expect(await N.deletedAt(got, {}, ctx(reader))).toBeNull();
    expect(await N.authorship(got, {}, ctx(reader))).toBeNull();
    expect(await N.createdByWorker(got, {}, ctx(reader))).toBeNull();
    expect(await N.signingRequests(got, {}, ctx(reader))).toEqual([]);
    expect(await N.commentSummary(got, {}, ctx(reader))).toEqual({ openThreads: 0, resolvedThreads: 0, comments: 0, viewerOpenThreadId: null });
    const approval = await N.approvalStatus(got, {}, ctx(reader));
    expect(approval.approval).toBeNull();
    expect(typeof approval.state).toBe('string');
    const mint = await N.mintStatus(got, {}, ctx(reader));
    expect(mint.mintedBy).toBeNull();
    const sig = await N.signatureStatus(got, {}, ctx(reader));
    expect(sig.signatures).toEqual([]);
  });

  it('the same node read in its own memory, by its manager, keeps every field', async () => {
    await db.edge.create({
      data: { memoryId: engineer.mem, sourceId: ids.engRelease, targetId: ids.engOpenPr, name: 'stage', loc: 'processes:release:stage:tasks:open-pr' },
    });
    const got = await Q.node({}, { ref: 'processes:release', memoryRef: engineer.mem }, ctx(manager));
    expect(N.inheritedFrom(got)).toBeNull();
    expect((await N.outgoingEdges(got, {}, ctx(manager))).length).toBe(1);
    expect((await N.memory(got, {}, ctx(manager)))?.id).toBe(engineer.mem);
  });

  it('every Node field is either content or covered by the inherited projection (drift pin)', async () => {
    const { typeDefs } = await import('./typeDefs.js');
    const { INHERITED_PROJECTION_FIELDS } = await import('./resolvers.inheritedNode.js');
    const sdl = String((typeDefs as any).loc?.source?.body ?? typeDefs);
    const body = sdl.slice(sdl.indexOf('\n  type Node {'), sdl.indexOf('\n  }', sdl.indexOf('\n  type Node {')));
    const fields = [...body.matchAll(/^    ([a-zA-Z]+)[:(]/gm)].map((m) => m[1]);
    const CONTENT = [
      'id', 'revision', 'memoryId', 'nodeType', 'objectType', 'loc', 'urn', 'portalUrl', 'inheritedFrom',
      'isPlaceholder', 'isLink', 'name', 'alias', 'description', 'abstract', 'abstractOriginHash',
      'embeddingPendingAt', 'embeddingFailedAt', 'embeddingError', 'embeddingAttempts', 'content', 'tokens',
      'tags', 'properties', 'data', 'seq', 'ownerRepo', 'isRunnable', 'role', 'llmModel', 'aiAgent',
      'createdAt', 'updatedAt',
    ];
    const unclassified = fields.filter((f) => !CONTENT.includes(f) && !INHERITED_PROJECTION_FIELDS.includes(f));
    expect(unclassified).toEqual([]);
    expect(fields.length).toBeGreaterThan(40);
  });
});
