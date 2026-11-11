/** #3305 / ruling0108: an App membership never grants item reach to a user session. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, canWriteToMemory, getAppMemoryAccess, getMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { independentUserItemAccess } from '../lib/auth/independentUserItemAccess.js';
import type { RunToolContext } from '../lib/runner/tools/types.js';
import { testRunAgentId } from '../test/runAgent.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const mutationResolvers = resolvers.Mutation as any;
const queryResolvers = resolvers.Query as any;
const LOC = 'docs:entry';
const ctx = (userId: string) => ({ db, userId, roles: ['READER'] }) as Context;
let fixtureState: Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const root = `items-${generateId().toLowerCase()}.example`;
  const org = await db.organization.create({ data: { name: 'Item boundary', urn: root } });
  const admin = await db.user.create({ data: { handle: `mgr-${generateId().toLowerCase()}` } });
  const user = await db.user.create({ data: { handle: `user-${generateId().toLowerCase()}` } });
  await db.orgMember.create({ data: { userId: admin.id, organizationId: org.id, role: 'ADMIN' } });
  const agent = await mutationResolvers.createAgent({}, { orgId: org.id, name: 'Primary' }, ctx(admin.id));
  const second = await mutationResolvers.createAgent({}, { orgId: org.id, name: 'Second' }, ctx(admin.id));
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
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, agentId: await testRunAgentId(db, org.id, app.id), userId: null, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn } });
  const principal = { db, ...runAuthContext(run) } as Context;
  const tool: RunToolContext = { db, run, principal, log: () => undefined };
  return { org, app, agent, second, admin, user, read, write, publicMemory, granted, team, schedule, run, principal, tool };
}

const urn = (memory: { urn: string }, loc = LOC) => `hrn:node:${memory.urn}:${loc}`;
const session = (selected: boolean): Context => ({ ...ctx(fixtureState.user.id), ...(selected ? { appId: fixtureState.app.id } : {}) });
async function result(call: () => Promise<unknown>) {
  try { return { value: await call() }; }
  catch (error) { const e = error as Error & { extensions?: { code?: string } }; return { error: { message: e.message, code: e.extensions?.code ?? null } }; }
}
beforeEach(async () => { await cleanDb(db); fixtureState = await fixture(); });

describe.each([false, true])('#3305 session selected=%s', selected => {
  it('App membership supplies no item-only read, write or discovery authority', async () => {
    const user = session(selected);
    expect(await canReadMemory(db, user, fixtureState.write.id)).toBe(false);
    expect(await canWriteToMemory(db, user, fixtureState.write.id)).toBe(false);
    expect((await getPrincipalAppMemoryAccess(db, user)).has(fixtureState.write.id)).toBe(false);
    expect((await getMemoryAccess(db, user)).has(fixtureState.write.id)).toBe(false);
    expect(await getAccessibleMemoryIds(user)).not.toContain(fixtureState.write.id);
  });
  it.each(['hadron_get_node', 'hadron_list_nodes', 'hadron_find_nodes', 'hadron_list_memories', 'hadron_create_node', 'hadron_update_node'] as const)('MCP %s matches item deletion and publishes nothing', async tool => {
    const mcp = createTestableMcpServer(session(selected));
    const args = tool === 'hadron_get_node' ? { urn: urn(fixtureState.write) }
      : tool === 'hadron_update_node' ? { urn: urn(fixtureState.write), content: 'unauthorized' }
      : tool === 'hadron_create_node' ? { urn: urn(fixtureState.write, 'docs:new'), name: 'unauthorized' }
      : tool === 'hadron_list_memories' ? {}
      : { memoryUrn: `hrn:mem:${fixtureState.write.urn}`, ...(tool === 'hadron_find_nodes' ? { query: 'needle3305', mode: 'keyword' } : {}) };
    const linked = await mcp.callToolText(tool, args);
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: fixtureState.agent.id, memoryId: fixtureState.write.id } } });
    expect(linked).toBe(await mcp.callToolText(tool, args));
    expect(linked).not.toContain('secret write');
    expect(await db.node.count({ where: { memoryId: fixtureState.write.id, loc: 'docs:new' } })).toBe(0);
    expect(await db.node.findUnique({ where: { loc_memoryId: { memoryId: fixtureState.write.id, loc: LOC } } })).toMatchObject({ content: 'secret write' });
  }, 20000);
  it.each(['memory', 'node', 'find', 'appNodes', 'create'] as const)('GraphQL %s matches item deletion', async door => {
    const user = session(selected);
    const call = () => door === 'memory' ? queryResolvers.memory({}, { ref: fixtureState.write.id }, user)
      : door === 'node' ? queryResolvers.node({}, { ref: urn(fixtureState.write) }, user)
      : door === 'find' ? queryResolvers.findNodes({}, { filter: { memoryIds: [fixtureState.write.id] }, query: 'needle3305', mode: 'keyword', limit: 10 }, user)
      : door === 'appNodes' ? queryResolvers.appNodes({}, { appRef: fixtureState.app.id }, user)
      : mutationResolvers.createNode({}, { input: { memoryId: fixtureState.write.id, loc: 'docs:gql-new', name: 'unauthorized' } }, user);
    const linked = await result(call);
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: fixtureState.agent.id, memoryId: fixtureState.write.id } } });
    const unlinked = await result(call);
    expect(linked).toEqual(unlinked);
    if (door === 'memory' || door === 'node') expect(unlinked).toEqual({ value: null });
    if (door === 'find') expect((unlinked as any).value.hits).toEqual([]);
    if (door === 'appNodes') expect((unlinked as any).value.some((node: { memoryId: string }) => node.memoryId === fixtureState.write.id)).toBe(false);
    if (door === 'create') {
      expect(unlinked).toHaveProperty('error');
      expect(await db.node.count({ where: { memoryId: fixtureState.write.id, loc: 'docs:gql-new' } })).toBe(0);
    }
  });
  it.each(['READER', 'CONTRIBUTOR'] as const)('independent org %s keeps its own level and the item ceiling agrees with runs', async role => {
    await db.orgMember.create({ data: { organizationId: fixtureState.org.id, userId: fixtureState.user.id, role } });
    const user = session(selected);
    const run = await db.appRun.create({ data: { id: generateId(), organizationId: fixtureState.org.id, appId: fixtureState.app.id, agentId: await testRunAgentId(db, fixtureState.org.id, fixtureState.app.id), userId: fixtureState.user.id, triggerKind: 'MANUAL', entryNodeUrn: fixtureState.run.entryNodeUrn } });
    const runPrincipal = runAuthContext(run);
    const sessionItems = await getPrincipalAppMemoryAccess(db, user);
    const runItems = await getPrincipalAppMemoryAccess(db, runPrincipal);
    const level = role === 'CONTRIBUTOR' ? 'READ_WRITE' : 'READ_ONLY';
    expect(sessionItems.get(fixtureState.write.id)).toBe(level);
    expect(runItems.get(fixtureState.write.id)).toBe(level);
    expect(sessionItems.get(fixtureState.read.id)).toBe('READ_ONLY');
    expect(runItems.get(fixtureState.read.id)).toBe('READ_ONLY');
    expect(await canReadMemory(db, user, fixtureState.write.id)).toBe(true);
    expect(await canWriteToMemory(db, user, fixtureState.write.id)).toBe(role === 'CONTRIBUTOR');
    // A session retains its own org writer grant independently of an item;
    // a run remains capped by the read item under0105.
    expect(await canWriteToMemory(db, user, fixtureState.read.id)).toBe(role === 'CONTRIBUTOR');
    expect(await canWriteToMemory(db, runPrincipal, fixtureState.read.id)).toBe(false);
  });
  it('PUBLIC items, both installed systems and App team/app-class space remain readable', async () => {
    const user = session(selected);
    expect(await canReadMemory(db, user, fixtureState.publicMemory.id)).toBe(true);
    expect(await canWriteToMemory(db, user, fixtureState.publicMemory.id)).toBe(false);
    for (const agent of [fixtureState.agent, fixtureState.second]) expect(await canReadMemory(db, user, agent.systemMemoryId)).toBe(true);
    expect(await canReadMemory(db, user, fixtureState.team.id)).toBe(true);
    expect(await canWriteToMemory(db, user, fixtureState.team.id)).toBe(true);
  });
  it('an inadmissible item on the same installed system memory cannot remove its independent read path', async () => {
    await db.agentMemoryItem.create({ data: { agentId: fixtureState.agent.id, memoryId: fixtureState.second.systemMemoryId, role: 'read-write' } });
    expect((await independentUserItemAccess(db, fixtureState.user.id)).has(fixtureState.second.systemMemoryId)).toBe(false);
    expect((await getPrincipalAppMemoryAccess(db, session(selected))).get(fixtureState.second.systemMemoryId)).toBe('READ_ONLY');
    expect(await canReadMemory(db, session(selected), fixtureState.second.systemMemoryId)).toBe(true);
  });
  it.each(['reader', 'writer'] as const)('personal share %s keeps its baseline direct GraphQL authority independently of an item', async role => {
    const memory = await db.memory.create({ data: { urn: `@${fixtureState.admin.handle}:share`, name: 'shared', class: 'personal', userId: fixtureState.admin.id, ownerUserId: fixtureState.admin.id } });
    await db.memoryShare.create({ data: { memoryId: memory.id, granteeId: fixtureState.user.id, grantorId: fixtureState.admin.id, role } });
    await db.agentMemoryItem.create({ data: { agentId: fixtureState.agent.id, memoryId: memory.id, role: 'read-write' } });
    expect(await queryResolvers.memory({}, { ref: memory.id }, session(selected))).toMatchObject({ id: memory.id });
    const written = await result(() => mutationResolvers.createNode({}, { input: { memoryId: memory.id, loc: 'shared:entry', name: 'shared' } }, session(selected)));
    if (role === 'writer' && !selected) expect(written).toHaveProperty('value');
    else expect(written).toMatchObject({ error: { code: 'FORBIDDEN' } });
    // Selected-App writer-share refusal is reproduced on base2eb466b2,
    // #3331 records this accepted baseline; #3305 preserves both outcomes.
  });
  it.each(['READER', 'CONTRIBUTOR'] as const)('subscription %s preserves exactly its user level', async role => {
    const subscriber = await db.organization.create({ data: { name: 'subscriber', urn: `sub-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: subscriber.id, userId: fixtureState.user.id, role: 'CONTRIBUTOR' } });
    await db.memorySubscription.create({ data: { memoryId: fixtureState.write.id, organizationId: subscriber.id, role } });
    expect((await getPrincipalAppMemoryAccess(db, session(selected))).get(fixtureState.write.id)).toBe(role === 'CONTRIBUTOR' ? 'READ_WRITE' : 'READ_ONLY');
    expect(await canWriteToMemory(db, session(selected), fixtureState.write.id)).toBe(role === 'CONTRIBUTOR');
  });
});

it.each(['none', 'READER', 'CONTRIBUTOR', 'subscription', 'owner'] as const)('#3305 differential independent item READ oracle: %s', async shape => {
  if (shape === 'READER' || shape === 'CONTRIBUTOR') await db.orgMember.create({ data: { organizationId: fixtureState.org.id, userId: fixtureState.user.id, role: shape } });
  if (shape === 'subscription') {
    const org = await db.organization.create({ data: { name: 'subscriber', urn: `oracle-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: fixtureState.user.id, role: 'READER' } });
    await db.memorySubscription.create({ data: { memoryId: fixtureState.write.id, organizationId: org.id, role: 'READER' } });
  }
  if (shape === 'owner') await db.memory.update({ where: { id: fixtureState.write.id }, data: { organizationId: null, ownerUserId: fixtureState.user.id } });
  const ids = [fixtureState.read.id, fixtureState.write.id, fixtureState.publicMemory.id];
  const actual = await independentUserItemAccess(db, fixtureState.user.id);
  const oracle = await getAccessibleMemoryIds(ctx(fixtureState.user.id), undefined, { excludeAppDerived: true });
  expect(ids.filter(id => actual.has(id)).sort()).toEqual(ids.filter(id => oracle?.includes(id)).sort());
});


it.each(['none', 'READER', 'CONTRIBUTOR'] as const)('known-user App access defaults to the independent item ceiling: %s', async role => {
  if (role !== 'none') await db.orgMember.create({ data: { organizationId: fixtureState.org.id, userId: fixtureState.user.id, role } });
  const access = await getAppMemoryAccess(db, fixtureState.app.id, { callerUserId: fixtureState.user.id, memberAdmitted: true });
  expect(access.get(fixtureState.write.id)).toBe(role === 'none' ? undefined : role === 'READER' ? 'READ_ONLY' : 'READ_WRITE');
  expect(access.get(fixtureState.read.id)).toBe(role === 'none' ? undefined : 'READ_ONLY');
  expect(access.get(fixtureState.agent.systemMemoryId)).toBe('READ_ONLY');
  expect(access.get(fixtureState.team.id)).toBe('READ_ONLY');
});


it('loads the independent ceiling only for a live licensed Agent carrying an item', async () => {
  await db.agentMemoryItem.deleteMany({ where: { agentId: fixtureState.agent.id } });
  const loadItemUserAccess = vi.fn(async () => new Map<string, string>());
  const opts = { callerUserId: fixtureState.user.id, loadItemUserAccess };
  const systemOnly = await getAppMemoryAccess(db, fixtureState.app.id, opts);
  expect(loadItemUserAccess).not.toHaveBeenCalled();
  expect(systemOnly.get(fixtureState.agent.systemMemoryId)).toBe('READ_ONLY');
  await db.agentMemoryItem.create({ data: { agentId: fixtureState.agent.id, memoryId: fixtureState.write.id, role: 'read-write' } });
  const withItem = await getAppMemoryAccess(db, fixtureState.app.id, opts);
  expect(loadItemUserAccess).toHaveBeenCalledTimes(1);
  expect(withItem.has(fixtureState.write.id)).toBe(false);
});
