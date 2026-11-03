/** #3278 / cor:dmo:050:09: an item limits reach; it never grants a userless run access. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { hadronReadNode, hadronCreateNode } from '../lib/runner/tools/nodeTools.js';
import { loadFlowNode } from '../lib/runner/loadFlowNode.js';
import { makeProdRunDeps } from '../jobs/appRunDeps.js';
import { hadronStoreFile } from '../lib/runner/tools/storeTools.js';
import { putObject } from '../integrations/r2/client.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import type { RunToolContext } from '../lib/runner/tools/types.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/r2/client.js', () => ({ putObject: vi.fn(), deleteObject: vi.fn() }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const LOC = 'docs:entry';
let f: Awaited<ReturnType<typeof fixture>>;
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
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, userId: null, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn } });
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
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

describe('#3278 userless run item admission', () => {
  it.each(['read', 'write'] as const)('RED: refuses runner read through a %s item exactly as with no item', async kind => {
    const m = f[kind];
    const withItem = await rejection(hadronReadNode.execute(f.tool, { urn: urn(m) }));
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: m.id } } });
    const without = await rejection(hadronReadNode.execute(f.tool, { urn: urn(m) }));
    expect(without).toMatchObject({ message: expect.stringContaining('not readable') });
    expect(withItem).toEqual(without);
  });
  it.each((['read', 'write'] as const).flatMap(kind =>
    (['mcp-list', 'graphql-ids', 'survey', 'keyword'] as const).map(door => ({ kind, door }))))('RED: excludes $kind item at $door', async ({ kind, door }) => {
    const id = f[kind].id;
    if (door === 'mcp-list') expect((await getMemoryAccess(db, f.principal)).has(id)).toBe(false);
    else if (door === 'graphql-ids') expect(await getAccessibleMemoryIds({ ...f.principal })).not.toContain(id);
    else {
      const args = { filter: { memoryIds: [id] }, limit: 10, ...(door === 'keyword' ? { query: 'needle3278', mode: 'keyword' } : {}) };
      const withItem = await Q.findNodes({}, args, { ...f.principal });
      await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: id } } });
      const without = await Q.findNodes({}, args, { ...f.principal });
      expect(without.hits).toEqual([]);
      expect(withItem.hits).toEqual(without.hits);
    }
  });
  it('RED: refuses item-only flow loads', async () => {
    expect(await rejection(loadFlowNode(db, urn(f.write), f.org.id, f.principal))).toMatchObject({ message: expect.stringContaining('not readable') });
  });
  it('refuses item-only writes exactly as without an item and publishes no node', async () => {
    const withItem = await rejection(hadronCreateNode.execute(f.tool, { urn: urn(f.write, 'docs:new'), name: 'new' }));
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: f.write.id } } });
    const without = await rejection(hadronCreateNode.execute(f.tool, { urn: urn(f.write, 'docs:new'), name: 'new' }));
    expect(without).not.toBeNull(); expect(withItem).toEqual(without);
    expect(await db.node.count({ where: { memoryId: f.write.id, loc: 'docs:new' } })).toBe(0);
  });
  it('PUBLIC knowledge stays readable but never writable through its read-write item', async () => {
    expect(await hadronReadNode.execute(f.tool, { urn: urn(f.publicMemory) })).toMatchObject({ content: 'secret public' });
    expect((await getPrincipalAppMemoryAccess(db, f.principal)).get(f.publicMemory.id)).toBe('READ_ONLY');
    expect(await canWriteToMemory(db, f.principal, f.publicMemory.id)).toBe(false);
    expect(await rejection(hadronCreateNode.execute(f.tool, { urn: urn(f.publicMemory, 'docs:no'), name: 'no' }))).not.toBeNull();
  });
  it('CONTROL: a live automation read grant reads an unlinked memory, never widens discovery', async () => {
    await M.setAutomationReadGrant({}, { appRef: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memoryRef: f.granted.id, prefix: 'docs' }, ctx(f.admin.id));
    expect(await hadronReadNode.execute(f.tool, { urn: urn(f.granted) })).toMatchObject({ content: 'secret granted' });
    expect(await canReadMemory(db, f.principal, f.granted.id)).toBe(false);
    expect((await getMemoryAccess(db, f.principal)).has(f.granted.id)).toBe(false);
  });
  it('CONTROL: explicit App write grant works without an item', async () => {
    await M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.granted.id, prefix: 'docs', registerNodeUrn: 'hrn:node:example.com:register:authority' }, ctx(f.admin.id));
    expect(await hadronCreateNode.execute(f.tool, { urn: urn(f.granted, 'docs:new'), name: 'new', content: 'granted write' })).toMatchObject({ created: true });
    expect(await db.node.findUnique({ where: { loc_memoryId: { memoryId: f.granted.id, loc: 'docs:new' } } })).toMatchObject({ content: 'granted write' });
  });
  it('CONTROL: both installed Agents system memories and App team space stay readable', async () => {
    for (const a of [f.agent, f.second]) {
      expect(await canReadMemory(db, f.principal, a.systemMemoryId)).toBe(true);
      expect((await getPrincipalAppMemoryAccess(db, f.principal)).get(a.systemMemoryId)).toBe('READ_ONLY');
    }
    expect(await canReadMemory(db, f.principal, f.team.id)).toBe(true);
  });
  it('#3280: on-behalf run refuses item-only reach while direct user+App is unchanged', async () => {
    // Ruling0105 A: an App member with NO independent org access loses item-only reach as a run;
    // the direct user session remains unchanged in this slice.
    const userOnly = { ...ctx(f.user.id) };
    const backedRun = await db.appRun.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, triggerKind: 'MANUAL', entryNodeUrn: f.run.entryNodeUrn } });
    const onBehalf = { db, ...runAuthContext(backedRun) } as Context;
    const selectedUser = { ...userOnly, appId: f.app.id };
    expect(await getAccessibleMemoryIds(userOnly, f.read.id, { excludeAppDerived: true })).not.toContain(f.read.id);
    expect(await canReadMemory(db, selectedUser, f.read.id)).toBe(true);
    expect((await getPrincipalAppMemoryAccess(db, selectedUser)).has(f.read.id)).toBe(true);
    expect(await canReadMemory(db, onBehalf, f.read.id)).toBe(false);
    expect((await getPrincipalAppMemoryAccess(db, onBehalf)).has(f.read.id)).toBe(false);
    expect(await rejection(hadronReadNode.execute({ ...f.tool, run: backedRun, principal: onBehalf }, { urn: urn(f.read) }))).toMatchObject({ message: expect.stringContaining('not readable') });
  });
  it('CONTROL: bare App keys still refuse non-PUBLIC items and retain PUBLIC read-only', async () => {
    const key = { appId: f.app.id, roles: [], clientId: 'app-key' };
    expect(await canReadMemory(db, key, f.read.id)).toBe(false);
    expect(await canReadMemory(db, key, f.write.id)).toBe(false);
    expect(await canReadMemory(db, key, f.publicMemory.id)).toBe(true);
    expect(await canWriteToMemory(db, key, f.publicMemory.id)).toBe(false);
  });
  it.each(['hadron_get_node', 'hadron_list_nodes', 'hadron_find_nodes', 'hadron_update_node'] as const)('refuses item-only reach at MCP %s just as with no item', async tool => {
    const mcp = createTestableMcpServer(f.principal);
    const args = tool === 'hadron_get_node' ? { urn: urn(f.write) }
      : tool === 'hadron_update_node' ? { urn: urn(f.write), content: 'unauthorized update' }
        : { memoryUrn: `hrn:mem:${f.write.urn}`, ...(tool === 'hadron_find_nodes' ? { query: 'needle3278', mode: 'keyword' } : {}) };
    const withItem = await mcp.callToolText(tool, args);
    await db.agentMemoryItem.delete({ where: { agentId_memoryId: { agentId: f.agent.id, memoryId: f.write.id } } });
    const without = await mcp.callToolText(tool, args);
    expect(withItem).toBe(without);
    expect(withItem).not.toContain('secret write');
    expect(await db.node.findUnique({ where: { loc_memoryId: { memoryId: f.write.id, loc: LOC } } })).toMatchObject({ content: 'secret write' });
  }, 20_000);
  it('refuses item-only stored-file writes before touching object storage', async () => {
    vi.mocked(putObject).mockClear();
    expect(await rejection(hadronStoreFile.execute(f.tool, { urn: urn(f.write, 'docs:asset'), filename: 'report.txt', content: 'no upload' }))).toMatchObject({ message: expect.stringContaining('write') });
    expect(putObject).not.toHaveBeenCalled();
  });
  it('refuses an item-only writeOutput destination while the PUBLIC flow remains readable', async () => {
    await db.node.update({ where: { loc_memoryId: { memoryId: f.publicMemory.id, loc: LOC } }, data: { data: { output: { writeTo: urn(f.write, 'docs:output') } } } });
    expect(await rejection(makeProdRunDeps(db).writeOutput(f.run, urn(f.publicMemory), 'must not publish'))).toMatchObject({ message: expect.stringContaining('not granted') });
    expect(await db.node.count({ where: { memoryId: f.write.id, loc: 'docs:output' } })).toBe(0);
  });
});
