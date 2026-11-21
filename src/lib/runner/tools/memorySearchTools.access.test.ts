/** #632: real shared-engine access matrix, adapter org/encryption fences and bounded projection. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolvers } from '../../../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../../../api/graphql/schema/resolvers.helpers.js';
import { emitNodeUrnV2 } from '../../urnEmit.js';
import { hadronFindNodes } from './memorySearchTools.js';
import { hadronReadNode } from './nodeTools.js';
import type { RunToolContext } from './types.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const Q = resolvers.Query as unknown as { findNodes: (...args: any[]) => Promise<any> };
let orgId: string, otherOrgId: string, userId: string, otherUserId: string, appId: string, agentId: string;
let memories: Record<string, { id: string; urn: string }>;
const queryText = 'orchard';
type Hit = { urn: string; name: string; description: string | null; snippet: string; score: number | null };
async function context(withUser: boolean): Promise<RunToolContext> {
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId,
    userId: withUser ? userId : null, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:search632-a.example:attached:flow', status: 'RUNNING' } });
  return { db, run, principal: runContext(db, run), log: vi.fn() };
}
async function call(c: RunToolContext, args: Record<string, unknown> = {}) {
  return hadronFindNodes.execute(c, { query: queryText, ...args }) as Promise<{ hits: Hit[]; truncated?: true }>;
}
async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: `orchard ${loc}`, content: 'orchard body', ...extra } });
}
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'search632 A', urn: 'search632-a.example' } })).id;
  otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'search632 B', urn: 'search632-b.example' } })).id;
  userId = (await db.user.create({ data: { id: generateId(), githubId: 63201, githubUsername: 'search632-reader', handle: 'search632-reader', roles: ['READER'] } })).id;
  otherUserId = (await db.user.create({ data: { id: generateId(), githubId: 63202, githubUsername: 'search632-other', handle: 'search632-other', roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'READER' } });
  appId = (await db.app.create({ data: { id: generateId(), name: 'Search632', urn: 'search632-a.example:app', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Search632', urn: 'search632-a.example:agent', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  memories = {};
  const shapes = [
    ['app', { class: 'app', appId, visibility: null }], ['attached', {}], ['org-only', {}], ['encrypted', { isEncrypted: true }],
    ['mine', { class: 'personal', visibility: null, userId }], ['others', { class: 'personal', visibility: null, userId: otherUserId }],
    ['private-other', { class: 'private', visibility: null, userId: otherUserId }],
    ['subscribed', { organizationId: otherOrgId }], ['foreign-public', { organizationId: otherOrgId, visibility: 'PUBLIC' }],
    ['own-public', { visibility: 'PUBLIC' }], ['no-org', { class: 'personal', visibility: null, userId, organizationId: null, ownerUserId: userId }],
    ['deleted', { deletedAt: new Date() }],
  ] as const;
  for (const [name, shape] of shapes) {
    const memory = await db.memory.create({ data: { id: generateId(), urn: `${name === 'no-org' ? 'search632-reader' : 'search632-a.example'}:${name}`, name,
      organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', ...shape } });
    memories[name] = memory;
    await node(memory.id, name);
  }
  for (const label of ['attached', 'encrypted', 'others', 'private-other']) {
    await db.agentMemoryItem.create({ data: { agentId, memoryId: memories[label].id, role: 'read' } });
  }
  await db.memorySubscription.create({ data: { memoryId: memories.subscribed.id, organizationId: orgId, activated: true, role: 'READER' } });
});

describe('#632 real principal access matrix', () => {
  it.each([false, true])('equals the shared engine’s readable org/cleartext set (on-behalf-of user=%s)', async withUser => {
    const c = await context(withUser);
    const readable = await getAccessibleMemoryIds(c.principal);
    const eligible = await db.memory.findMany({ where: { id: { in: readable }, organizationId: orgId, isEncrypted: false, deletedAt: null }, select: { id: true } });
    const ids = eligible.map(m => m.id);
    const engine = ids.length ? await Q.findNodes({}, { query: queryText, mode: 'keyword', filter: { memoryIds: ids }, limit: 20, expand: 0 }, c.principal) : { hits: [] };
    const expected = engine.hits.map((h: any) => emitNodeUrnV2(h.node.memory.urn, h.node.loc)).sort();
    const actual = await call(c, { limit: 20 });
    expect(actual.hits.map(h => h.urn).sort()).toEqual(expected);
    expect(actual.hits.map(h => h.urn)).toContain(emitNodeUrnV2(memories.app.urn, 'app'));
    for (const label of ['encrypted', 'subscribed', 'foreign-public', 'others', 'private-other', 'no-org', 'deleted']) {
      expect(actual.hits.map(h => h.urn), label).not.toContain(emitNodeUrnV2(memories[label].urn, label));
    }
    if (withUser) {
      expect(actual.hits.map(h => h.urn)).toContain(emitNodeUrnV2(memories['org-only'].urn, 'org-only'));
      expect(actual.hits.map(h => h.urn)).toContain(emitNodeUrnV2(memories.mine.urn, 'mine'));
      const broad = await Q.findNodes({}, { query: queryText, mode: 'keyword', limit: 30 }, c.principal);
      expect(broad.hits.some((h: any) => h.node.memoryId === memories.subscribed.id)).toBe(true);
      expect(broad.hits.some((h: any) => h.node.memoryId === memories['foreign-public'].id)).toBe(true);
    } else {
      expect(actual.hits.map(h => h.urn)).not.toContain(emitNodeUrnV2(memories['org-only'].urn, 'org-only'));
      expect(actual.hits.map(h => h.urn)).not.toContain(emitNodeUrnV2(memories.attached.urn, 'attached')); // an item is a limit, never a grant (#1376)
    }
    for (const hit of actual.hits) await expect(hadronReadNode.execute(c, { urn: hit.urn })).resolves.toHaveProperty('name');
  });

  it.each(['missing', 'encrypted', 'subscribed', 'foreign-public', 'others', 'private-other', 'no-org', 'deleted'])('named %s scope is empty without an existence/error oracle', async label => {
    const c = await context(true);
    const urn = label === 'missing' ? 'hrn:mem:search632-a.example:absent' : `hrn:mem:${memories[label].urn}`;
    const spy = vi.spyOn(Q, 'findNodes');
    try { await expect(call(c, { memoryUrn: urn })).resolves.toEqual({ hits: [] }); expect(spy).not.toHaveBeenCalled(); }
    finally { spy.mockRestore(); }
  });

  it('supports the canonical named PUBLIC point-read exception without enumerating PUBLIC memories for a userless broad search', async () => {
    const c = await context(false);
    expect((await call(c)).hits.map(h => h.urn)).not.toContain(emitNodeUrnV2(memories['own-public'].urn, 'own-public'));
    expect((await call(c, { memoryUrn: `hrn:mem:${memories['own-public'].urn}` })).hits.map(h => h.urn))
      .toEqual([emitNodeUrnV2(memories['own-public'].urn, 'own-public')]);
  });

  it('narrows to the optional memory, uses only the shared keyword engine and never logs the query or hit text', async () => {
    const c = await context(true);
    const spy = vi.spyOn(Q, 'findNodes');
    try {
      const out = await call(c, { query: '  orchard  ', memoryUrn: `hrn:mem:${memories.attached.urn}` });
      expect(out.hits.map(h => h.urn)).toEqual([emitNodeUrnV2(memories.attached.urn, 'attached')]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toMatchObject({ query: 'orchard', mode: 'keyword', filter: { memoryIds: [memories.attached.id] }, limit: 10, expand: 0, includeTotal: false });
      expect(spy.mock.calls[0][2]).toMatchObject({ clientId: c.principal.clientId, appId, userId });
      expect(c.log).toHaveBeenCalledTimes(1);
      expect(c.log).toHaveBeenCalledWith('hadron_find_nodes (1 results)');
    } finally { spy.mockRestore(); }
  });

  it('defaults to ten, clamps to twenty and returns a bounded projection, never full bodies/data', async () => {
    const c = await context(false);
    for (let i = 0; i < 29; i++) await node(memories.app.id, `limit-${i}`, { content: 'orchard '.repeat(1000), description: 'd'.repeat(2000), abstract: 's'.repeat(1500), data: { secret: 'never returned' } });
    await node(memories.app.id, 'wide', { name: 'wide632 ' + 'n'.repeat(1000), description: 'd'.repeat(2000), abstract: 's'.repeat(1500), data: { secret: 'never returned' } });
    const wide = await call(c, { memoryUrn: memories.app.urn, query: 'wide632' });
    expect(wide.hits).toHaveLength(1);
    expect(wide.hits[0].name).toHaveLength(300); expect(wide.hits[0].description).toHaveLength(500); expect(wide.hits[0].snippet).toHaveLength(500);
    await node(memories.app.id, 'fallback', { name: 'fallback632', content: 'fallback-body '.repeat(1000) });
    const fallback = await call(c, { memoryUrn: memories.app.urn, query: 'fallback632' });
    expect(fallback.hits[0].snippet).toHaveLength(500); expect(fallback.hits[0].snippet).toMatch(/^fallback-body /);
    const ten = await call(c, { memoryUrn: memories.app.urn });
    const twenty = await call(c, { memoryUrn: memories.app.urn, limit: 999 });
    const one = await call(c, { memoryUrn: memories.app.urn, limit: 0 });
    expect(ten.hits).toHaveLength(10); expect(twenty.hits).toHaveLength(20); expect(one.hits).toHaveLength(1);
    for (const hit of twenty.hits) {
      expect(Object.keys(hit).sort()).toEqual(['description', 'name', 'score', 'snippet', 'urn']);
      expect(hit.name.length).toBeLessThanOrEqual(300); expect((hit.description ?? '').length).toBeLessThanOrEqual(500); expect(hit.snippet.length).toBeLessThanOrEqual(500);
    }
  });
});

it('retains an owner’s readable memory even without org membership (no extra org-catalogue gate)', async () => {
  const c = await context(true);
  await db.orgMember.delete({ where: { organizationId_userId: { organizationId: orgId, userId } } });
  await expect(hadronReadNode.execute(c, { urn: emitNodeUrnV2(memories.mine.urn, 'mine') })).resolves.toHaveProperty('name');
  expect((await call(c, { memoryUrn: memories.mine.urn })).hits.map(h => h.urn)).toEqual([emitNodeUrnV2(memories.mine.urn, 'mine')]);
});

it.each(['foreign', 'encrypted', 'own'] as const)('does not let effective inheritance reintroduce a %s base after initial scoping', async kind => {
  const parentOrg = kind === 'foreign' ? otherOrgId : orgId;
  const parentRoot = kind === 'foreign' ? 'search632-b.example' : 'search632-a.example';
  const base = await db.memory.create({ data: { id: generateId(), urn: `${parentRoot}:base`, name: 'base', class: 'system', organizationId: parentOrg, isEncrypted: kind === 'encrypted' } });
  const child = await db.memory.create({ data: { id: generateId(), urn: 'search632-a.example:child', name: 'child', class: 'system', organizationId: orgId } });
  const parent = await db.agent.create({ data: { id: generateId(), urn: `${parentRoot}:base-agent`, name: 'base agent', organizationId: parentOrg, visibility: 'PUBLIC', systemMemoryId: base.id } });
  await db.agent.update({ where: { id: agentId }, data: { extendsAgentId: parent.id, systemMemoryId: child.id } });
  const secret = await node(base.id, 'base-must-not-escape');
  const local = await node(child.id, 'child-local');
  const c = await context(false);
  const engine = await Q.findNodes({}, { query: queryText, mode: 'keyword', filter: { memoryIds: [child.id] }, limit: 20 }, c.principal);
  expect(engine.hits.map((h: any) => h.node.id), 'control: the shared engine really widens to this base').toContain(secret.id);
  const out = await call(c, { memoryUrn: `hrn:mem:${child.urn}`, limit: 20 });
  expect(out.hits.map(h => h.urn)).toEqual([emitNodeUrnV2(child.urn, local.loc)]);
  expect(JSON.stringify(out)).not.toContain('base-must-not-escape');
});

it.each(['encrypted', 'foreign', 'deleted', 'moved', 'relocated', 'node-deleted'] as const)('suppresses a hit whose %s fence changes after the engine read', async kind => {
  const c = await context(true);
  const target = await db.node.findFirstOrThrow({ where: { memoryId: memories.attached.id } });
  const original = Q.findNodes;
  const spy = vi.spyOn(Q, 'findNodes').mockImplementation(async (...args: any[]) => {
    const found = await original(...args);
    expect(found.hits.map((h: any) => h.node.id)).toContain(target.id);
    if (kind === 'moved') await db.node.update({ where: { id: target.id }, data: { memoryId: memories.subscribed.id } });
    else if (kind === 'relocated') await db.node.update({ where: { id: target.id }, data: { loc: 'relocated-after-ranking' } });
    else if (kind === 'node-deleted') await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    else await db.memory.update({ where: { id: memories.attached.id }, data: kind === 'encrypted' ? { isEncrypted: true }
      : kind === 'foreign' ? { organizationId: otherOrgId } : { deletedAt: new Date() } });
    return found;
  });
  try { await expect(call(c, { memoryUrn: memories.attached.urn })).resolves.toEqual({ hits: [] }); }
  finally { spy.mockRestore(); }
});

it('discards an already-ranked node moved inside the allowed set instead of relabeling stale text under a different URN', async () => {
  const c = await context(true);
  const target = await db.node.findFirstOrThrow({ where: { memoryId: memories.attached.id } });
  await db.node.update({ where: { id: target.id }, data: { name: 'move632' } });
  const original = Q.findNodes;
  const spy = vi.spyOn(Q, 'findNodes').mockImplementation(async (...args: any[]) => {
    const found = await original(...args); expect(found.hits.map((h: any) => h.node.id)).toEqual([target.id]);
    await db.node.update({ where: { id: target.id }, data: { memoryId: memories.app.id, loc: 'moved-readable' } });
    return found;
  });
  try { await expect(call(c, { query: 'move632', limit: 20 })).resolves.toEqual({ hits: [] }); }
  finally { spy.mockRestore(); }
});

it.each([[25, 1], [225, 1], [25, 15], [225, 15]])('returns requested child matches after %i inherited hits (child count=%i)', async (baseCount, childCount) => {
  const base = await db.memory.create({ data: { id: generateId(), urn: 'search632-b.example:crowd-base', name: 'base', class: 'system', organizationId: otherOrgId } });
  const child = await db.memory.create({ data: { id: generateId(), urn: 'search632-a.example:crowd-child', name: 'child', class: 'system', organizationId: orgId } });
  const parent = await db.agent.create({ data: { id: generateId(), urn: 'search632-b.example:crowd-agent', name: 'base agent', organizationId: otherOrgId, visibility: 'PUBLIC', systemMemoryId: base.id } });
  await db.agent.update({ where: { id: agentId }, data: { extendsAgentId: parent.id, systemMemoryId: child.id } });
  const locals: Array<{ id: string; loc: string }> = [];
  for (let i = 0; i < childCount; i++) locals.push(await node(child.id, `weak-child-${i}`, { name: 'weak child', content: 'crowd632', description: null, abstract: null }));
  for (let i = 0; i < baseCount; i++) await node(base.id, `strong-${i}`, { name: 'crowd632 '.repeat(20), content: 'crowd632 '.repeat(100), description: null, abstract: null });
  const c = await context(false);
  const first = await Q.findNodes({}, { query: 'crowd632', mode: 'keyword', filter: { memoryIds: [child.id] }, limit: 10 }, c.principal);
  expect(first.hits).toHaveLength(10);
  expect(first.hits.some((h: any) => locals.some(local => local.id === h.node.id)), 'control: inherited hits crowd out every child on the first page').toBe(false);
  const spy = vi.spyOn(Q, 'findNodes');
  try {
    const out = await call(c, { query: 'crowd632', memoryUrn: child.urn, limit: 10 });
    expect(out.hits).toHaveLength(Math.min(10, childCount));
    for (const hit of out.hits) expect(locals.map(local => emitNodeUrnV2(child.urn, local.loc))).toContain(hit.urn);
    expect(JSON.stringify(out)).not.toContain('strong-');
    expect(spy.mock.calls.map(args => args[1].offset)).toEqual(baseCount > 200 ? [0, 10, 210] : [0, 10]);
  } finally { spy.mockRestore(); }
});


it('caps inherited-page scanning at five engine calls and signals an incomplete result', async () => {
  const c = await context(false);
  const local = await db.node.findFirstOrThrow({ where: { memoryId: memories.app.id } });
  const excluded = await db.node.findFirstOrThrow({ where: { memoryId: memories.others.id } });
  const spy = vi.spyOn(Q, 'findNodes').mockImplementation(async (_root, args) => ({
    hits: Array.from({ length: args.offset > 603 ? 0 : args.limit }, (_, i) => ({ node: args.offset === 0 && i === 0 ? local : excluded, score: 1 })),
  }));
  try {
    const out = await call(c, { limit: 3 });
    expect(out.hits.map(hit => hit.urn)).toEqual([emitNodeUrnV2(memories.app.urn, local.loc)]);
    expect(out.truncated).toBe(true);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(spy.mock.calls.map(args => args[1].offset)).toEqual([0, 3, 203, 403, 603]);
  } finally { spy.mockRestore(); }
});

it('preserves already-fenced hits with an incomplete signal if a later engine page rejects', async () => {
  const c = await context(false);
  const local = await db.node.findFirstOrThrow({ where: { memoryId: memories.app.id } });
  const excluded = await db.node.findFirstOrThrow({ where: { memoryId: memories.others.id } });
  const spy = vi.spyOn(Q, 'findNodes')
    .mockResolvedValueOnce({ hits: [{ node: local, score: 1 }, { node: excluded, score: 1 }] })
    .mockRejectedValue(new Error('private late-page failure'));
  try {
    const out = await call(c, { limit: 2 });
    expect(out).toMatchObject({ truncated: true, hits: [{ urn: emitNodeUrnV2(memories.app.urn, local.loc) }] });
    expect(JSON.stringify(out)).not.toContain('private late-page failure');
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); }
});

it('does not turn a first-page engine refusal into an empty successful result', async () => {
  const c = await context(false);
  const refusal = new Error('first-page refusal');
  const spy = vi.spyOn(Q, 'findNodes').mockRejectedValue(refusal);
  try { await expect(call(c)).rejects.toBe(refusal); expect(spy).toHaveBeenCalledTimes(1); }
  finally { spy.mockRestore(); }
});


it('deduplicates a repeated cross-page id without consuming the output limit', async () => {
  const c = await context(false);
  const local = await db.node.findFirstOrThrow({ where: { memoryId: memories.app.id } });
  const otherLocal = await node(memories.app.id, 'second-local');
  const excluded = await db.node.findFirstOrThrow({ where: { memoryId: memories.others.id } });
  const spy = vi.spyOn(Q, 'findNodes')
    .mockResolvedValueOnce({ hits: [local, excluded, excluded].map(node => ({ node, score: 1 })) })
    .mockResolvedValueOnce({ hits: [local, otherLocal].map(node => ({ node, score: 1 })) });
  try {
    const out = await call(c, { limit: 3 });
    expect(out).toEqual({ hits: [
      expect.objectContaining({ urn: emitNodeUrnV2(memories.app.urn, local.loc) }),
      expect.objectContaining({ urn: emitNodeUrnV2(memories.app.urn, otherLocal.loc) }),
    ] });
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); }
});
