/** #3305 / ruling0108: an App membership never grants item reach to a user session. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { independentUserItemAccess } from '../lib/auth/independentUserItemAccess.js';
import type { RunToolContext } from '../lib/runner/tools/types.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const LOC = 'docs:entry';
const ctx = (userId: string) => ({ db, userId, roles: ['READER'] }) as Context;
let f: Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const root = `items-${generateId().toLowerCase()}.example`;
  const org = await db.organization.create({ data: { name: 'Item boundary', urn: root } });
  const admin = await db.user.create({ data: { handle: `mgr-${generateId().toLowerCase()}` } });
  const user = await db.user.create({ data: { handle: `user-${generateId().toLowerCase()}` } });
  await db.orgMember.create({ data: { userId: admin.id, organizationId: org.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Primary' }, ctx(admin.id));
  const second = await M.createAgent({}, { orgId: org.id, name: 'Second' }, ctx(admin.id));
  const { app } = await createDbAppWithKey(db, 'items3305', org.id);
  for (const [i, a] of [agent, second].entries()) {
    await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdAt: new Date(1700000000000 + i * 1000) } });
  }
  await db.appMember.create({ data: { userId: user.id, appId: app.id, role: 'member' } });
  const memory = async (slug: string, visibility: 'ORGANIZATION' | 'PUBLIC' = 'ORGANIZATION') => {
    const m = await db.memory.create({ data: { name: slug, urn: `${root}:${slug}`, class: 'knowledge', visibility, organizationId: org.id } });
    await db.node.create({ data: { memoryId: m.id, loc: LOC, name: 'needle3305', content: `secret ${slug}`, nodeType: 'record' } });
    return m;
  };
  const read = await memory('read'); const write = await memory('write');
  const publicMemory = await memory('public', 'PUBLIC'); const granted = await memory('granted');
  for (const [m, role] of [[read, 'read'], [write, 'read-write'], [publicMemory, 'read-write']] as const) {
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: m.id, role } });
  }
  const team = await db.memory.create({ data: { name: 'team', urn: `${root}:team`, class: 'app', appId: app.id, organizationId: org.id } });
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: `hrn:node:${publicMemory.urn}:${LOC}` } });
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, userId: null, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn } });
  const principal = { db, ...runAuthContext(run) } as Context;
  const tool: RunToolContext = { db, run, principal, log: () => undefined };
  return { org, app, agent, second, admin, user, read, write, publicMemory, granted, team, schedule, run, principal, tool };
}

const urn = (memory: { urn: string }, loc = LOC) => `hrn:node:${memory.urn}:${loc}`;
const session = (selected: boolean): Context => ({ ...ctx(f.user.id), ...(selected ? { appId: f.app.id } : {}) });
async function result(call: () => Promise<unknown>) {
  try { return { value: await call() }; }
  catch (error) { const e = error as Error & { extensions?: { code?: string } }; return { error: { message: e.message, code: e.extensions?.code ?? null } }; }
}
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

describe.each([false, true])('#3305 session selected=%s', selected => {
  it('App membership supplies no item-only read, write or discovery authority', async () => {
    const user = session(selected);
    expect(await canReadMemory(db, user, f.write.id)).toBe(false);
    expect(await canWriteToMemory(db, user, f.write.id)).toBe(false);
    expect((await getPrincipalAppMemoryAccess(db, user)).has(f.write.id)).toBe(false);
    expect((await getMemoryAccess(db, user)).has(f.write.id)).toBe(false);
    expect(await getAccessibleMemoryIds(user)).not.toContain(f.write.id);
  });
  it.each(['hadron_get_node', 'hadron_list_nodes', 'hadron_find_nodes', 'hadron_list_memories', 'hadron_create_node', 'hadron_update_node'] as const)('MCP %s matches item deletion and publishes nothing', async tool => {
    const mcp = createTestableMcpServer(session(selected));
    const args = tool === 'hadron_get_node' ? { urn: urn(f.write) }
      : tool === 'hadron_update_node' ? { urn: urn(f.write), content: 'unauthorized' }
      : tool === 'hadron_create_node' ? { urn: urn(f.write, 'docs:new'), name: 'unauthorized' }
      : tool === 'hadron_list_memories' ? {}
      : { memoryUrn: `hrn:mem:${f.write.urn}`, ...(tool === 'hadron_find_nodes' ? { query: 'needle3305', mode: 'keyword' } : {}) };
    const linked = await mcp.callToolText(tool, args);
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: f.write.id } } });
    expect(linked).toBe(await mcp.callToolText(tool, args));
    expect(linked).not.toContain('secret write');
    expect(await db.node.count({ where: { memoryId: f.write.id, loc: 'docs:new' } })).toBe(0);
    expect(await db.node.findUnique({ where: { loc_memoryId: { memoryId: f.write.id, loc: LOC } } })).toMatchObject({ content: 'secret write' });
  }, 20000);
  it.each(['memory', 'node', 'find', 'create'] as const)('GraphQL %s matches item deletion', async door => {
    const user = session(selected);
    const call = () => door === 'memory' ? Q.memory({}, { ref: f.write.id }, user)
      : door === 'node' ? Q.node({}, { ref: urn(f.write) }, user)
      : door === 'find' ? Q.findNodes({}, { filter: { memoryIds: [f.write.id] }, query: 'needle3305', mode: 'keyword', limit: 10 }, user)
      : M.createNode({}, { input: { memoryId: f.write.id, loc: 'docs:gql-new', name: 'unauthorized' } }, user);
    const linked = await result(call);
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: f.write.id } } });
    const unlinked = await result(call);
    expect(linked).toEqual(unlinked);
    if (door === 'memory' || door === 'node') expect(unlinked).toEqual({ value: null });
    if (door === 'find') expect((unlinked as any).value.hits).toEqual([]);
    if (door === 'create') {
      expect(unlinked).toHaveProperty('error');
      expect(await db.node.count({ where: { memoryId: f.write.id, loc: 'docs:gql-new' } })).toBe(0);
    }
  });
  it.each(['READER', 'CONTRIBUTOR'] as const)('independent org %s keeps its own level and the item ceiling agrees with runs', async role => {
    await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.user.id, role } });
    const user = session(selected);
    const run = await db.appRun.create({ data: { organizationId: f.org.id, appId: f.app.id, userId: f.user.id, triggerKind: 'MANUAL', entryNodeUrn: f.run.entryNodeUrn } });
    const runPrincipal = runAuthContext(run);
    const sessionItems = await getPrincipalAppMemoryAccess(db, user);
    const runItems = await getPrincipalAppMemoryAccess(db, runPrincipal);
    const level = role === 'CONTRIBUTOR' ? 'READ_WRITE' : 'READ_ONLY';
    expect(sessionItems.get(f.write.id)).toBe(level);
    expect(runItems.get(f.write.id)).toBe(level);
    expect(sessionItems.get(f.read.id)).toBe('READ_ONLY');
    expect(runItems.get(f.read.id)).toBe('READ_ONLY');
    expect(await canReadMemory(db, user, f.write.id)).toBe(true);
    expect(await canWriteToMemory(db, user, f.write.id)).toBe(role === 'CONTRIBUTOR');
    // A session retains its own org writer grant independently of an item;
    // a run remains capped by the read item under0105.
    expect(await canWriteToMemory(db, user, f.read.id)).toBe(role === 'CONTRIBUTOR');
    expect(await canWriteToMemory(db, runPrincipal, f.read.id)).toBe(false);
  });
  it('PUBLIC items, both installed systems and App team/app-class space remain readable', async () => {
    const user = session(selected);
    expect(await canReadMemory(db, user, f.publicMemory.id)).toBe(true);
    expect(await canWriteToMemory(db, user, f.publicMemory.id)).toBe(false);
    for (const agent of [f.agent, f.second]) expect(await canReadMemory(db, user, agent.systemMemoryId)).toBe(true);
    expect(await canReadMemory(db, user, f.team.id)).toBe(true);
    expect(await canWriteToMemory(db, user, f.team.id)).toBe(true);
  });
  it.each(['READER', 'CONTRIBUTOR'] as const)('subscription %s preserves exactly its user level', async role => {
    const subscriber = await db.organization.create({ data: { name: 'subscriber', urn: `sub-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: subscriber.id, userId: f.user.id, role: 'CONTRIBUTOR' } });
    await db.memorySubscription.create({ data: { memoryId: f.write.id, organizationId: subscriber.id, role } });
    expect((await getPrincipalAppMemoryAccess(db, session(selected))).get(f.write.id)).toBe(role === 'CONTRIBUTOR' ? 'READ_WRITE' : 'READ_ONLY');
    expect(await canWriteToMemory(db, session(selected), f.write.id)).toBe(role === 'CONTRIBUTOR');
  });
});

it.each(['none', 'READER', 'CONTRIBUTOR', 'subscription', 'owner'] as const)('#3305 differential independent item READ oracle: %s', async shape => {
  if (shape === 'READER' || shape === 'CONTRIBUTOR') await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.user.id, role: shape } });
  if (shape === 'subscription') {
    const org = await db.organization.create({ data: { name: 'subscriber', urn: `oracle-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: f.user.id, role: 'READER' } });
    await db.memorySubscription.create({ data: { memoryId: f.write.id, organizationId: org.id, role: 'READER' } });
  }
  if (shape === 'owner') await db.memory.update({ where: { id: f.write.id }, data: { organizationId: null, ownerUserId: f.user.id } });
  const ids = [f.read.id, f.write.id, f.publicMemory.id];
  const actual = await independentUserItemAccess(db, f.user.id);
  const oracle = await getAccessibleMemoryIds(ctx(f.user.id), undefined, { excludeAppDerived: true });
  expect(ids.filter(id => actual.has(id)).sort()).toEqual(ids.filter(id => oracle?.includes(id)).sort());
});
