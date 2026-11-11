/** #3280 / ruling0105 A: user-backed runs intersect item reach with independent user authority. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { loadFlowNode } from '../lib/runner/loadFlowNode.js';
import { makeProdRunDeps } from '../jobs/appRunDeps.js';
import { hadronStoreFile } from '../lib/runner/tools/storeTools.js';
import { putObject } from '../integrations/r2/client.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { hadronReadNode, hadronCreateNode } from '../lib/runner/tools/nodeTools.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds, requireMemoryWriteAccess } from '../api/graphql/schema/resolvers.helpers.js';
import { getSubscribedWritableMemoryIds } from '../lib/auth/orgWritableMemory.js';
import { independentUserItemAccess } from '../lib/auth/independentUserItemAccess.js';
import type { RunToolContext } from '../lib/runner/tools/types.js';
import { testRunAgentId } from '../test/runAgent.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/r2/client.js', () => ({ putObject: vi.fn(), deleteObject: vi.fn() }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const LOC = 'docs:entry';
let f: Awaited<ReturnType<typeof fixture>>;
let backed: RunToolContext;
const ctx = (userId: string) => ({ db, userId, roles: ['READER'] }) as Context;

async function fixture() {
  const root = `items-${generateId().toLowerCase()}.example`;
  const org = await db.organization.create({ data: { name: 'Item boundary', urn: root } });
  const admin = await db.user.create({ data: { handle: `mgr-${generateId().toLowerCase()}` } });
  const user = await db.user.create({ data: { handle: `user-${generateId().toLowerCase()}` } });
  await db.orgMember.create({ data: { userId: admin.id, organizationId: org.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Primary' }, ctx(admin.id));
  const second = await M.createAgent({}, { orgId: org.id, name: 'Second' }, ctx(admin.id));
  const { app } = await createDbAppWithKey(db, 'items3278', org.id);
  for (const [i, a] of [agent, second].entries()) {
    await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdAt: new Date(1700000000000 + i * 1000) } });
  }
  await db.appMember.create({ data: { userId: user.id, appId: app.id, role: 'member' } });
  const memory = async (slug: string, visibility: 'ORGANIZATION' | 'PUBLIC' = 'ORGANIZATION') => {
    const m = await db.memory.create({ data: { name: slug, urn: `${root}:${slug}`, class: 'knowledge', visibility, organizationId: org.id } });
    await db.node.create({ data: { memoryId: m.id, loc: LOC, name: 'needle3278', content: `secret ${slug}`, nodeType: 'record' } });
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
const urn = (m: { urn: string }, loc = LOC) => `hrn:node:${m.urn}:${loc}`;
async function rejection(p: Promise<unknown>) {
  try { await p; return null; } catch (err) {
    return { message: (err as Error).message, code: (err as { extensions?: { code?: string } }).extensions?.code ?? null };
  }
}
beforeEach(async () => {
  await cleanDb(db); f = await fixture();
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, agentId: await testRunAgentId(db, f.org.id, f.app.id), userId: f.user.id, triggerKind: 'MANUAL', entryNodeUrn: f.run.entryNodeUrn } });
  backed = { db, run, principal: { db, ...runAuthContext(run) } as Context, log: () => undefined };
});


describe('#3280 independent user ceiling on item-folded run reach', () => {
  it.each(['read', 'write'] as const)('refuses item-only %s reads exactly as no item', async kind => {
    const m = f[kind];
    expect(await getAccessibleMemoryIds(ctx(f.user.id), m.id, { excludeAppDerived: true })).toEqual([]);
    const withItem = await rejection(hadronReadNode.execute(backed, { urn: urn(m) }));
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: m.id } } });
    const without = await rejection(hadronReadNode.execute(backed, { urn: urn(m) }));
    expect(without).toMatchObject({ message: expect.stringContaining('not readable') });
    expect(withItem).toEqual(without);
  });
  it.each((['read', 'write'] as const).flatMap(kind =>
    (['mcp-list', 'graphql-ids', 'survey', 'keyword'] as const).map(door => ({ kind, door }))))('excludes $kind item from $door without independent authority', async ({ kind, door }) => {
    const id = f[kind].id;
    if (door === 'mcp-list') expect((await getMemoryAccess(db, backed.principal)).has(id)).toBe(false);
    else if (door === 'graphql-ids') expect(await getAccessibleMemoryIds({ ...backed.principal })).not.toContain(id);
    else {
      const args = { filter: { memoryIds: [id] }, limit: 10, ...(door === 'keyword' ? { query: 'needle3278', mode: 'keyword' } : {}) };
      const withItem = await Q.findNodes({}, args, { ...backed.principal });
      await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: id } } });
      const without = await Q.findNodes({}, args, { ...backed.principal });
      expect(without.hits).toEqual([]); expect(withItem.hits).toEqual(without.hits);
    }
  });
  it('refuses item-only writes exactly as no item without creating a node', async () => {
    const args = { urn: urn(f.write, 'docs:new'), name: 'new' };
    const withItem = await rejection(hadronCreateNode.execute(backed, args));
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: f.write.id } } });
    const without = await rejection(hadronCreateNode.execute(backed, args));
    expect(without).not.toBeNull(); expect(withItem).toEqual(without);
    expect(await db.node.count({ where: { memoryId: f.write.id, loc: 'docs:new' } })).toBe(0);
  });
  it.each(['hadron_get_node', 'hadron_list_nodes', 'hadron_find_nodes', 'hadron_update_node'] as const)('same item/no-item refusal at MCP %s', async tool => {
    const mcp = createTestableMcpServer(backed.principal);
    const args = tool === 'hadron_get_node' ? { urn: urn(f.write) }
      : tool === 'hadron_update_node' ? { urn: urn(f.write), content: 'unauthorized' }
        : { memoryUrn: `hrn:mem:${f.write.urn}`, ...(tool === 'hadron_find_nodes' ? { query: 'needle3278', mode: 'keyword' } : {}) };
    const withItem = await mcp.callToolText(tool, args);
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: f.write.id } } });
    expect(withItem).toBe(await mcp.callToolText(tool, args));
    expect(withItem).not.toContain('secret write');
    expect(await db.node.findUnique({ where: { loc_memoryId: { memoryId: f.write.id, loc: LOC } } })).toMatchObject({ content: 'secret write' });
  }, 20000);
  it('independent READER plus read-write item reads but cannot write', async () => {
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: f.org.id, role: 'READER' } });
    expect(await hadronReadNode.execute(backed, { urn: urn(f.write) })).toMatchObject({ content: 'secret write' });
    expect((await getPrincipalAppMemoryAccess(db, backed.principal)).get(f.write.id)).toBe('READ_ONLY');
    expect(await canWriteToMemory(db, backed.principal, f.write.id)).toBe(false);
    expect(await rejection(hadronCreateNode.execute(backed, { urn: urn(f.write, 'docs:no'), name: 'no' }))).not.toBeNull();
  });
  it('independent CONTRIBUTOR plus read-write item keeps read and write', async () => {
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    expect(await hadronReadNode.execute(backed, { urn: urn(f.write) })).toMatchObject({ content: 'secret write' });
    expect(await hadronCreateNode.execute(backed, { urn: urn(f.write, 'docs:allowed'), name: 'allowed' })).toMatchObject({ created: true });
  });
  it('read item caps an independently writable user to read', async () => {
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    expect((await getPrincipalAppMemoryAccess(db, backed.principal)).get(f.read.id)).toBe('READ_ONLY');
    expect(await canWriteToMemory(db, backed.principal, f.read.id)).toBe(false);
  });
  it('PUBLIC item is independently readable but stays read-only for a non-org user', async () => {
    expect(await hadronReadNode.execute(backed, { urn: urn(f.publicMemory) })).toMatchObject({ content: 'secret public' });
    expect((await getPrincipalAppMemoryAccess(db, backed.principal)).get(f.publicMemory.id)).toBe('READ_ONLY');
    expect(await canWriteToMemory(db, backed.principal, f.publicMemory.id)).toBe(false);
  });
  it('installed systems and own App team read do not require independent item authority', async () => {
    for (const a of [f.agent, f.second]) expect(await canReadMemory(db, backed.principal, a.systemMemoryId)).toBe(true);
    expect(await canReadMemory(db, backed.principal, f.team.id)).toBe(true);
  });
  it('#3305: plain user session also refuses App-member-only item reach under0108', async () => {
    const user = { ...ctx(f.user.id), appId: f.app.id };
    expect(await canReadMemory(db, user, f.read.id)).toBe(false);
    expect(await canWriteToMemory(db, user, f.write.id)).toBe(false);
  });
  it('userless App key retains non-PUBLIC refusal and PUBLIC read-only', async () => {
    const key = { appId: f.app.id, roles: [], clientId: 'app-key' };
    expect(await canReadMemory(db, key, f.write.id)).toBe(false);
    expect(await canReadMemory(db, key, f.publicMemory.id)).toBe(true);
    expect(await canWriteToMemory(db, key, f.publicMemory.id)).toBe(false);
  });
  it.each(['reader', 'writer'] as const)('group membership %s supplies user authority but never revives an inadmissible Agent item', async role => {
    const m = await db.memory.create({ data: { name: 'group', urn: `${f.org.urn}:group`, class: 'group', visibility: 'GROUP', organizationId: f.org.id } });
    await db.agentMemoryItem.create({ data: { agentId: f.agent.id, memoryId: m.id, role: 'read-write' } });
    await db.memoryMember.create({ data: { memoryId: m.id, userId: f.user.id, role } });
    expect(await getAccessibleMemoryIds(ctx(f.user.id), m.id, { excludeAppDerived: true })).toContain(m.id);
    expect((await independentUserItemAccess(db, f.user.id)).get(m.id)).toBe(role === 'writer' ? 'READ_WRITE' : 'READ_ONLY');
    // The Agent tenant itself cannot hold group reach: preserve that pre-existing cap.
    expect((await getPrincipalAppMemoryAccess(db, backed.principal)).has(m.id)).toBe(false);
    await db.memoryMember.delete({ where: { memoryId_userId: { memoryId: m.id, userId: f.user.id } } });
    expect((await independentUserItemAccess(db, f.user.id)).has(m.id)).toBe(false);
  });
  it.each((['READER', 'CONTRIBUTOR'] as const).flatMap(role => (['READER', 'CONTRIBUTOR'] as const).map(userRole => ({ role, userRole }))))('subscription $role and user $userRole preserve their lower independent level and revocation', async ({ role, userRole }) => {
    const subscriber = await db.organization.create({ data: { name: 'subscriber', urn: `sub-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: subscriber.id, role: userRole } });
    const sub = await db.memorySubscription.create({ data: { id: generateId(), memoryId: f.write.id, organizationId: subscriber.id, role } });
    expect(await getAccessibleMemoryIds(ctx(f.user.id), f.write.id, { excludeAppDerived: true })).toContain(f.write.id);
    expect((await getPrincipalAppMemoryAccess(db, backed.principal)).get(f.write.id)).toBe(role === 'CONTRIBUTOR' && userRole === 'CONTRIBUTOR' ? 'READ_WRITE' : 'READ_ONLY');
    await db.memorySubscription.update({ where: { id: sub.id }, data: { deletedAt: new Date() } });
    expect((await getPrincipalAppMemoryAccess(db, backed.principal)).has(f.write.id)).toBe(false);
  });
  it('a subscription write grant on one memory does not authorize an unrelated target', async () => {
    const subscriber = await db.organization.create({ data: { name: 'subscriber', urn: `point-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: subscriber.id, role: 'CONTRIBUTOR' } });
    await db.memorySubscription.create({ data: { memoryId: f.read.id, organizationId: subscriber.id, role: 'CONTRIBUTOR' } });
    expect(await getSubscribedWritableMemoryIds(db, f.user.id, f.read.id)).toEqual([f.read.id]);
    expect(await getSubscribedWritableMemoryIds(db, f.user.id, f.write.id)).toEqual([]);
    await expect(requireMemoryWriteAccess(ctx(f.user.id), f.read.id)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx(f.user.id), f.write.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
  it.each(['app-scoped', 'user-owned', 'deleted', 'revoked', 'reader', 'non-member'] as const)('the independent subscription WRITE helper excludes %s authority', async shape => {
    const subscriber = await db.organization.create({ data: { name: 'subscriber', urn: `shape-${generateId().toLowerCase()}.example` } });
    if (shape !== 'non-member') await db.orgMember.create({ data: { userId: f.user.id, organizationId: subscriber.id, role: 'CONTRIBUTOR' } });
    await db.memorySubscription.create({ data: { memoryId: f.read.id, organizationId: subscriber.id, role: shape === 'reader' ? 'READER' : 'CONTRIBUTOR', deletedAt: shape === 'revoked' ? new Date() : null } });
    if (shape === 'app-scoped') await db.memory.update({ where: { id: f.read.id }, data: { appId: f.app.id } });
    if (shape === 'user-owned') await db.memory.update({ where: { id: f.read.id }, data: { organizationId: null, ownerUserId: f.admin.id } });
    if (shape === 'deleted') await db.memory.update({ where: { id: f.read.id }, data: { deletedAt: new Date() } });
    expect(await getSubscribedWritableMemoryIds(db, f.user.id, f.read.id)).toEqual([]);
    // GraphQL's legacy direct gate is unchanged in this slice; liveness is
    // judged by its callers, not newly imposed here through an extraction.
    if (shape !== 'deleted') await expect(requireMemoryWriteAccess(ctx(f.user.id), f.read.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
  it.each(['membership', 'organization'] as const)('a revoked subscriber %s cannot retain WRITE through a PUBLIC read', async revoked => {
    const subscriber = await db.organization.create({ data: { name: 'subscriber', urn: `live-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: subscriber.id, role: 'CONTRIBUTOR' } });
    await db.memorySubscription.create({ data: { memoryId: f.publicMemory.id, organizationId: subscriber.id, role: 'CONTRIBUTOR' } });
    expect((await independentUserItemAccess(db, f.user.id)).get(f.publicMemory.id)).toBe('READ_WRITE');
    expect(await canWriteToMemory(db, backed.principal, f.publicMemory.id)).toBe(true);
    if (revoked === 'membership') {
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: subscriber.id, userId: f.user.id } }, data: { deletedAt: new Date() } });
    } else {
      await db.organization.update({ where: { id: subscriber.id }, data: { deletedAt: new Date() } });
    }
    expect(await getSubscribedWritableMemoryIds(db, f.user.id, f.publicMemory.id)).toEqual([]);
    expect((await independentUserItemAccess(db, f.user.id)).get(f.publicMemory.id)).toBe('READ_ONLY');
    expect((await getPrincipalAppMemoryAccess(db, backed.principal)).get(f.publicMemory.id)).toBe('READ_ONLY');
    expect(await canWriteToMemory(db, backed.principal, f.publicMemory.id)).toBe(false);
    await expect(requireMemoryWriteAccess(ctx(f.user.id), f.publicMemory.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
  it('automation node-read grant is unchanged for an independently admitted user', async () => {
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: f.org.id, role: 'READER' } });
    await M.setAutomationReadGrant({}, { appRef: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memoryRef: f.granted.id, prefix: 'docs' }, ctx(f.admin.id));
    const run = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, agentId: await testRunAgentId(db, f.org.id, f.app.id), userId: f.user.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, entryNodeUrn: f.run.entryNodeUrn } });
    const tool = { ...backed, run, principal: { db, ...runAuthContext(run) } as Context };
    expect(await hadronReadNode.execute(tool, { urn: urn(f.granted) })).toMatchObject({ content: 'secret granted' });
  });
  it('explicit App write grant is unchanged at an unlinked node destination', async () => {
    // Userless grant authority is a separate path and must not be removed by the user ceiling.
    await M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.granted.id, prefix: 'docs', registerNodeUrn: 'hrn:node:example.com:register:authority' }, ctx(f.admin.id));
    expect(await hadronCreateNode.execute(f.tool, { urn: urn(f.granted, 'docs:granted'), name: 'granted' })).toMatchObject({ created: true });
  });

  it('ownership ceiling equals the independent-user read oracle for non-personal memory', async () => {
    const owned = await db.memory.create({ data: { name: 'owned', urn: `@${f.user.handle}:owned`, class: 'knowledge', ownerUserId: f.user.id } });
    expect(await getAccessibleMemoryIds(ctx(f.user.id), owned.id, { excludeAppDerived: true })).toContain(owned.id);
    expect((await independentUserItemAccess(db, f.user.id)).get(owned.id)).toBe('READ_WRITE');
    await db.memory.update({ where: { id: owned.id }, data: { deletedAt: new Date() } });
    expect((await independentUserItemAccess(db, f.user.id)).has(owned.id)).toBe(false);
  });

  it('item-only user-backed flow loading is refused', async () => {
    expect(await rejection(loadFlowNode(db, urn(f.read), f.org.id, backed.principal as Context))).toMatchObject({ message: expect.stringContaining('not readable') });
  });
  it('item-only user-backed file write is refused before object storage', async () => {
    vi.mocked(putObject).mockClear();
    expect(await rejection(hadronStoreFile.execute(backed, { urn: urn(f.write, 'docs:file'), filename: 'report.txt', content: 'no upload' }))).not.toBeNull();
    expect(putObject).not.toHaveBeenCalled();
  });
  it('user-backed output refuses an item-only destination with a readable PUBLIC flow', async () => {
    await db.node.update({ where: { loc_memoryId: { memoryId: f.publicMemory.id, loc: LOC } }, data: { data: { output: { writeTo: urn(f.write, 'docs:output') } } } });
    expect(await rejection(makeProdRunDeps(db).writeOutput(backed.run, urn(f.publicMemory), 'not published'))).not.toBeNull();
    expect(await db.node.count({ where: { memoryId: f.write.id, loc: 'docs:output' } })).toBe(0);
  });

});
