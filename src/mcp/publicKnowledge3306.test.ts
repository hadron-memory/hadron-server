/**
 * #3306 / ruling 0104 (cor:acl:010:01, cor:dmo:050:09): a principal with no user (an App key,
 * session-bound or not, or an AppRun with no on-behalf user) reads PUBLIC knowledge with `app_id` null read-only, with
 * no item. Everything else keeps today's rules. Discovery choice: point reads and node searches admit it; memory
 * listing (`hadron_list_memories`, the access map) never enumerates it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { createTestableMcpServer } from './server.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { hadronReadNode, hadronCreateNode } from '../lib/runner/tools/nodeTools.js';
import { canReadMemory, canWriteToMemory, filterReadableMemoryIds, getMemoryAccess, EXPLICIT_REF } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { publicKnowledgeAmong, readsPublicKnowledgeWithoutUser } from '../lib/auth/publicKnowledgeRead.js';
import type { RunToolContext } from '../lib/runner/tools/types.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any;
const LOC = 'docs:entry';
let f: Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const suffix = generateId().toLowerCase();
  const orgA = await db.organization.create({ data: { name: 'Reader org', urn: `reader-${suffix}.example` } });
  const orgB = await db.organization.create({ data: { name: 'Owner org', urn: `owner-${suffix}.example` } });
  const { app, appKey } = await createDbAppWithKey(db, 'reader3306', orgA.id);
  const { app: otherApp } = await createDbAppWithKey(db, 'other3306', orgB.id);
  const memory = async (slug: string, extra: Record<string, unknown> = {}) => {
    const m = await db.memory.create({
      data: { name: slug, urn: `${orgB.urn}:${slug}`, class: 'knowledge', visibility: 'PUBLIC', organizationId: orgB.id, ...extra },
    });
    await db.node.create({ data: { memoryId: m.id, loc: LOC, name: `needle3306 ${slug}`, content: `secret ${slug}`, nodeType: 'record' } });
    return m;
  };
  const pub = await memory('pub');
  const orgVisible = await memory('orgvis', { visibility: 'ORGANIZATION' });
  const appScoped = await memory('appscoped', { appId: otherApp.id });
  const ownAppScoped = await memory('ownappscoped', { appId: app.id });
  const group = await memory('group', { class: 'group', visibility: 'GROUP' });
  const deleted = await memory('deleted', { deletedAt: new Date() });
  const schedule = await db.agentSchedule.create({
    data: { id: generateId(), organizationId: orgA.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: `hrn:node:${pub.urn}:${LOC}` },
  });
  const run = await db.appRun.create({
    data: { id: generateId(), organizationId: orgA.id, appId: app.id, userId: null, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn },
  });
  const runPrincipal = { db, ...runAuthContext(run) } as Context;
  const keyPrincipal = { db, appId: app.id, appKeyId: appKey.id, roles: [] } as unknown as Context;
  const tool: RunToolContext = { db, run, principal: runPrincipal, log: () => undefined };
  const session = await db.session.create({ data: { id: generateId(), appId: app.id } });
  const confined = { db, appId: app.id, sessionId: session.id, roles: [] } as unknown as Context;
  return { orgA, orgB, app, otherApp, pub, orgVisible, appScoped, ownAppScoped, group, deleted, run, runPrincipal, keyPrincipal, tool, confined };
}
const urn = (m: { urn: string }, loc = LOC) => `hrn:node:${m.urn}:${loc}`;
async function rejection(p: Promise<unknown>) {
  try { await p; return null; } catch (err) {
    return { message: (err as Error).message, code: (err as { extensions?: { code?: string } }).extensions?.code ?? null };
  }
}
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

describe('#3306 PUBLIC knowledge for a principal with no user', () => {
  it('RED: an App key reads a node of another org\'s PUBLIC knowledge with no item (GraphQL node read)', async () => {
    const node = await Q.node({}, { ref: urn(f.pub) }, f.keyPrincipal);
    expect(node).toMatchObject({ content: 'secret pub' });
  });
  it('RED: a userless run reads it through hadron_read_node', async () => {
    expect(await hadronReadNode.execute(f.tool, { urn: urn(f.pub) })).toMatchObject({ content: 'secret pub' });
  });
  it.each(['key', 'run'] as const)('RED: the MCP point gate admits it for the %s principal, read-only', async who => {
    const principal = who === 'key' ? f.keyPrincipal : f.runPrincipal;
    expect(await canReadMemory(db, principal as never, f.pub.id)).toBe(true);
    expect(await canWriteToMemory(db, principal as never, f.pub.id)).toBe(false);
    expect([...(await filterReadableMemoryIds(db, principal as never, [f.pub.id, f.orgVisible.id]))]).toEqual([f.pub.id]);
  });
  it.each(['key', 'run'] as const)('RED: a node search naming the memory finds it for the %s principal', async who => {
    const principal = who === 'key' ? f.keyPrincipal : f.runPrincipal;
    const out = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 10, filter: { memoryIds: [f.pub.id] } }, { ...principal });
    expect(out.hits.map((h: { node: { memoryId: string } }) => h.node.memoryId)).toEqual([f.pub.id]);
  });

  it.each(['key', 'run'] as const)('writes stay refused, with and without a read-write item (%s)', async who => {
    const principal = who === 'key' ? f.keyPrincipal : f.runPrincipal;
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: f.orgA.id, urn: `${f.orgA.urn}:ag-${who}`, name: 'Ag' } });
    await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
    const attempt = () => rejection(hadronCreateNode.execute({ ...f.tool, principal: principal as never }, { urn: urn(f.pub, 'docs:new'), name: 'new' }));
    const before = await attempt();
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: f.pub.id, role: 'read-write' } });
    const withItem = await attempt();
    expect(before).not.toBeNull();
    expect(withItem).toEqual(before);
    expect(await canWriteToMemory(db, principal as never, f.pub.id)).toBe(false);
    expect(await db.node.count({ where: { memoryId: f.pub.id, loc: 'docs:new' } })).toBe(0);
  });

  describe('controls: nothing else widens', () => {
    it.each(['orgVisible', 'appScoped', 'group', 'deleted'] as const)('%s stays refused, byte-identically to an unknown memory (key)', async name => {
      const memory = f[name];
      const unknownUrn = `hrn:node:${f.orgB.urn}:nosuchmemory:${LOC}`;
      const refused = await rejection(Q.node({}, { ref: urn(memory) }, f.keyPrincipal).then((n: unknown) => { if (n) throw new Error('readable'); return n; }));
      expect(refused).toBeNull(); // GraphQL node read answers null, like a missing node
      expect(await Q.node({}, { ref: unknownUrn }, f.keyPrincipal)).toBeNull();
      expect(await canReadMemory(db, f.keyPrincipal as never, memory.id)).toBe(false);
    });
    it.each(['orgVisible', 'appScoped', 'group', 'deleted'] as const)('%s stays refused to a userless run exactly like an unknown memory', async name => {
      const memory = f[name];
      const bad = await rejection(hadronReadNode.execute(f.tool, { urn: urn(memory) }));
      const unknown = await rejection(hadronReadNode.execute(f.tool, { urn: `hrn:node:${f.orgB.urn}:nosuchmemory:${LOC}` }));
      expect(bad).not.toBeNull();
      expect(bad!.message.replace(memory.urn, 'X')).toBe(unknown!.message.replace(`${f.orgB.urn}:nosuchmemory`, 'X'));
    });
    it('an App-scoped PUBLIC memory of the principal\'s OWN App is not opened by this rule either', async () => {
      expect(await canReadMemory(db, f.keyPrincipal as never, f.ownAppScoped.id)).toBe(false);
    });
    it('RED 0114B: session-bound App keys read named PUBLIC knowledge outside the session read-only', async () => {
      expect(await canReadMemory(db, f.confined as never, f.pub.id)).toBe(true);
      expect(await canWriteToMemory(db, f.confined as never, f.pub.id)).toBe(false);
      expect(await Q.node({}, { ref: urn(f.pub) }, f.confined)).toMatchObject({ content: 'secret pub' });
      expect(await getAccessibleMemoryIds(f.confined)).not.toContain(f.pub.id);
      expect(await getAccessibleMemoryIds(f.confined, f.pub.id)).toEqual([f.pub.id]);
      const out = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 10, filter: { memoryIds: [f.pub.id] } }, { ...f.confined });
      expect(out.hits.map((h: { node: { memoryId: string } }) => h.node.memoryId)).toEqual([f.pub.id]);
      expect(await filterReadableMemoryIds(db, f.confined as never, [f.pub.id, f.orgVisible.id])).toEqual(new Set([f.pub.id]));
    });
    it.each(['hadron_get_node', 'hadron_find_nodes', 'hadron_list_nodes'] as const)('RED 0114B: MCP %s accepts a named PUBLIC target inside a session', async tool => {
      const mcp = createTestableMcpServer(f.confined as never);
      const args = tool === 'hadron_get_node' ? { urn: urn(f.pub) }
        : { memoryUrn: `hrn:mem:${f.pub.urn}`, ...(tool === 'hadron_find_nodes' ? { query: 'needle3306', mode: 'keyword' } : { depth: 2 }) };
      expect(await mcp.callToolText(tool, args)).toContain(tool === 'hadron_get_node' ? 'secret pub' : 'needle3306 pub');
    }, 20_000);
    it.each(['hadron_find_nodes', 'hadron_list_nodes'] as const)('0114B: %s parent selectors use the same named PUBLIC gate', async tool => {
      const mcp = createTestableMcpServer(f.confined as never);
      const text = await mcp.callToolText(tool, { parentRel: urn(f.pub, 'docs'), depth: 2, ...(tool === 'hadron_find_nodes' ? { query: 'needle3306', mode: 'keyword' } : {}) });
      expect(text).toContain('needle3306 pub');
    }, 20_000);
    it('0114B: MCP named-memory sets admit PUBLIC targets without relaxing mixed-set refusals', async () => {
      const mcp = createTestableMcpServer(f.confined as never);
      const args = { query: 'needle3306', mode: 'keyword', memoryUrns: [`hrn:mem:${f.pub.urn}`] };
      expect(await mcp.callToolText('hadron_find_nodes', args)).toContain('needle3306 pub');
      const refused = await mcp.callToolText('hadron_find_nodes', { ...args, memoryUrns: [...args.memoryUrns, `hrn:mem:${f.orgVisible.urn}`] });
      expect(refused).toContain('Memory not found');
      expect(refused).not.toContain('needle3306 pub');
    }, 20_000);
    it('0114B never permits an MCP write, even with a read-write item', async () => {
      const mcp = createTestableMcpServer(f.confined as never);
      const before = await mcp.callToolText('hadron_update_node', { urn: urn(f.pub), content: 'changed' });
      const agent = await db.agent.create({ data: { id: generateId(), organizationId: f.orgA.id, urn: `${f.orgA.urn}:session-item`, name: 'Session item' } });
      await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
      await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: f.pub.id, role: 'read-write' } });
      expect(await mcp.callToolText('hadron_update_node', { urn: urn(f.pub), content: 'changed' })).toBe(before);
      expect(await db.node.findFirst({ where: { memoryId: f.pub.id, loc: LOC } })).toMatchObject({ content: 'secret pub' });
    }, 20_000);
    it('RED: a PUBLIC node does not lend the session-less App reach to its cross-memory asset', async () => {
      const team = await db.memory.create({ data: { name: 'asset team', urn: `${f.orgA.urn}:asset-team`, class: 'app', appId: f.app.id, organizationId: f.orgA.id } });
      const asset = await db.asset.create({ data: { memoryId: team.id, filename: 'hidden.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: `private/${team.id}` } });
      await db.node.update({ where: { loc_memoryId: { memoryId: f.pub.id, loc: LOC } }, data: { data: { asset: { id: asset.id } } } });
      const node = await Q.node({}, { ref: urn(f.pub) }, f.confined);
      expect(node).not.toBeNull();
      expect(await canReadMemory(db, f.confined as never, team.id)).toBe(false);
      expect(await (resolvers.Node as any).asset(node, {}, f.confined)).toBeNull();
      // An asset in another PUBLIC knowledge memory is independently readable.
      const publicChild = await db.memory.create({ data: { name: 'public child', urn: `${f.orgB.urn}:public-child`, class: 'knowledge', visibility: 'PUBLIC', organizationId: f.orgB.id } });
      await db.asset.update({ where: { id: asset.id }, data: { memoryId: publicChild.id } });
      expect(await (resolvers.Node as any).asset(node, {}, f.confined)).toMatchObject({ id: asset.id });
    });
    it('0114B does not hand a session-bound key its own App team space', async () => {
      const team = await db.memory.create({ data: { name: 'team', urn: `${f.orgA.urn}:team`, class: 'app', appId: f.app.id, organizationId: f.orgA.id } });
      await db.node.create({ data: { memoryId: team.id, loc: LOC, name: 'team private', content: 'not public', nodeType: 'record' } });
      expect(await canReadMemory(db, f.confined as never, team.id)).toBe(false);
      expect(await Q.node({}, { ref: urn(team) }, f.confined)).toBeNull();
      expect(await getAccessibleMemoryIds(f.confined, team.id)).toEqual([]);
      expect(await canWriteToMemory(db, f.confined as never, team.id)).toBe(false);
    });
    it.each(['orgVisible', 'appScoped', 'group', 'deleted'] as const)('0114B keeps %s outside-session reads concealed and writes refused', async name => {
      expect(await canReadMemory(db, f.confined as never, f[name].id)).toBe(false);
      expect(await Q.node({}, { ref: urn(f[name]) }, f.confined)).toBeNull();
      const mcp = createTestableMcpServer(f.confined as never);
      const hidden = await mcp.callToolText('hadron_get_node', { urn: urn(f[name]) });
      const missing = await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${f.orgB.urn}:nosuchmemory:${LOC}` });
      expect(hidden.replaceAll(f[name].urn, 'X')).toBe(missing.replaceAll(`${f.orgB.urn}:nosuchmemory`, 'X'));
      expect(await canWriteToMemory(db, f.confined as never, f[name].id)).toBe(false);
    }, 20_000);

  });

  describe('session selectors retain the canonical negative matrix', () => {
    it.each([
      ['hadron_find_nodes', 'memoryUrn'],
      ['hadron_find_nodes', 'memoryUrns'],
      ['hadron_find_nodes', 'parentRel'],
      ['hadron_list_nodes', 'memoryUrn'],
      ['hadron_list_nodes', 'parentRel'],
    ] as const)('%s via %s conceals every non-PUBLIC exception exactly like a missing memory', async (tool, selector) => {
      const owner = await db.user.create({ data: { id: generateId(), email: `selector-${generateId().toLowerCase()}@example.test` } as never });
      const ownerMemory = await db.memory.create({ data: { name: 'owner', urn: `${f.orgA.urn}:owner`, class: 'private', userId: owner.id, ownerUserId: owner.id } });
      const team = await db.memory.create({ data: { name: 'team', urn: `${f.orgA.urn}:team`, class: 'app', appId: f.app.id, organizationId: f.orgA.id } });
      for (const m of [ownerMemory, team]) await db.node.create({ data: { memoryId: m.id, loc: LOC, name: 'needle3306 denied', content: 'hidden', nodeType: 'record' } });
      const mcp = createTestableMcpServer(f.confined as never);
      const args = (memoryUrn: string) => ({
        ...(tool === 'hadron_find_nodes' ? { query: 'needle3306', mode: 'keyword' } : { depth: 2 }),
        ...(selector === 'parentRel' ? { parentRel: `hrn:node:${memoryUrn}:docs` } : selector === 'memoryUrns' ? { memoryUrns: [`hrn:mem:${memoryUrn}`] } : { memoryUrn: `hrn:mem:${memoryUrn}` }),
      });
      const missingUrn = `${f.orgB.urn}:missing-selector`;
      const missing = await mcp.callToolText(tool, args(missingUrn));
      for (const m of [f.orgVisible, f.appScoped, f.ownAppScoped, f.group, f.deleted, ownerMemory, team]) {
        expect(await canReadMemory(db, f.confined as never, m.id, EXPLICIT_REF)).toBe(false);
        const hidden = await mcp.callToolText(tool, args(m.urn));
        expect(hidden.replaceAll(m.urn, 'X')).toBe(missing.replaceAll(missingUrn, 'X'));
        expect(hidden).not.toContain('needle3306 denied');
      }
      expect(await mcp.callToolText(tool, args(f.pub.urn))).toContain('needle3306 pub');
    }, 30_000);
  });

  describe('discovery: PUBLIC memories are not enumerated', () => {
    it('the access map and GraphQL id list never enumerate PUBLIC knowledge for keys, runs or session keys', async () => {
      for (const principal of [f.keyPrincipal, f.runPrincipal, f.confined]) {
        expect((await getMemoryAccess(db, principal as never)).has(f.pub.id)).toBe(false);
        expect(await getAccessibleMemoryIds(principal as Context)).not.toContain(f.pub.id);
        expect(await getAccessibleMemoryIds(principal as Context, f.pub.id)).toEqual([f.pub.id]);
        expect(await getAccessibleMemoryIds(principal as Context, undefined, { publicTargetIds: [f.pub.id, f.orgVisible.id] })).toContain(f.pub.id);
        expect(await getAccessibleMemoryIds(principal as Context, undefined, { publicTargetIds: [f.orgVisible.id, f.appScoped.id] })).not.toContain(f.orgVisible.id);
      }
    });
    it('session discovery stays closed over GraphQL, MCP search and MCP memory listing', async () => {
      const mcp = createTestableMcpServer(f.confined as never);
      const gql = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 50 }, { ...f.confined });
      expect(gql.hits).toEqual([]);
      const search = await mcp.callToolText('hadron_find_nodes', { query: 'needle3306', mode: 'keyword' });
      expect(search).not.toContain('needle3306 pub');
      const listing = await mcp.callToolText('hadron_list_memories', {});
      expect(listing).not.toContain(f.pub.urn);
      expect((await getMemoryAccess(db, f.confined as never)).has(f.pub.id)).toBe(false);
      expect(await mcp.callToolText('hadron_find_nodes', { query: 'needle3306', mode: 'keyword', memoryUrn: `hrn:mem:${f.pub.urn}` })).toContain('needle3306 pub');
    }, 20_000);
    it('a user-backed run keeps its identity at a cross-memory private asset gate', async () => {
      const owner = await db.user.create({ data: { id: generateId(), email: `asset-${generateId().toLowerCase()}@example.test` } as never });
      const privateMemory = await db.memory.create({ data: { name: 'private asset', urn: `${f.orgA.urn}:private-asset`, class: 'private', userId: owner.id, ownerUserId: owner.id } });
      const asset = await db.asset.create({ data: { memoryId: privateMemory.id, filename: 'private.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: `test/${privateMemory.id}` } });
      const parentMemory = await db.memory.create({ data: { name: 'personal parent', urn: `${f.orgA.urn}:personal-parent`, class: 'personal', userId: owner.id, ownerUserId: owner.id } });
      const parent = await db.node.create({ data: { memoryId: parentMemory.id, loc: LOC, name: 'personal parent', nodeType: 'record', data: { asset: { id: asset.id } } } });
      const run = { ...f.run, userId: owner.id };
      const principal = { db, ...runAuthContext(run) } as Context;
      expect(await canReadMemory(db, principal as never, parentMemory.id)).toBe(true);
      expect(await canReadMemory(db, principal as never, privateMemory.id)).toBe(false);
      expect(await (resolvers.Node as any).asset(parent, {}, principal)).toBeNull();
      const person = { ...principal, clientId: undefined };
      expect(await canReadMemory(db, person as never, privateMemory.id)).toBe(true);
      expect(await (resolvers.Node as any).asset(parent, {}, person)).toMatchObject({ id: asset.id });
    });
    it('an unscoped node search still returns item-linked PUBLIC knowledge exactly as before (only the item-less sweep goes)', async () => {
    const linked = await db.memory.create({ data: { name: 'linked', urn: `${f.orgB.urn}:linked`, class: 'knowledge', visibility: 'PUBLIC', organizationId: f.orgB.id } });
    await db.node.create({ data: { memoryId: linked.id, loc: LOC, name: 'needle3306 linked', content: 'x', nodeType: 'record' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: f.orgA.id, urn: `${f.orgA.urn}:ag-linked`, name: 'Linked' } });
    await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: linked.id, role: 'read' } });
    for (const principal of [f.keyPrincipal, f.runPrincipal]) {
      const out = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 50 }, { ...principal });
      const ids = out.hits.map((h: { node: { memoryId: string } }) => h.node.memoryId);
      expect(ids).toContain(linked.id);
      expect(ids).not.toContain(f.pub.id);
    }
  });
  it.each(['key', 'run'] as const)('node(ref) reads null by id and by URN for every memory the predicate refuses (%s)', async who => {
    const principal = (who === 'key' ? f.keyPrincipal : f.runPrincipal) as Context;
    const user = await db.user.create({ data: { id: generateId(), email: `n-${generateId().toLowerCase()}@example.test` } as never });
    const refused: Array<{ id: string; urn: string }> = [f.orgVisible, f.appScoped, f.ownAppScoped, f.group, f.deleted];
    for (const [slug, extra] of [['nodeowner', { ownerUserId: user.id }], ['nodeinstall', { isInstallMemory: true }]] as const) {
      const row = await db.memory.create({
        data: { name: slug, urn: `${f.orgB.urn}:${slug}`, class: 'knowledge', visibility: 'PUBLIC', organizationId: slug === 'nodeowner' ? null : f.orgB.id, ...extra },
      }).catch((err: unknown) => {
        if (!/check constraint|chk_memory/i.test(String((err as Error)?.message))) throw err;
        return null;
      });
      if (slug === 'nodeowner') expect(row).not.toBeNull();
      if (row) {
        await db.node.create({ data: { memoryId: row.id, loc: LOC, name: `needle3306 ${slug}`, content: `secret ${slug}`, nodeType: 'record' } });
        refused.push(row);
      }
    }
    for (const m of refused) {
      const node = await db.node.findFirst({ where: { memoryId: m.id, loc: LOC } });
      expect(node).not.toBeNull();
      expect(await Q.node({}, { ref: node!.id }, principal)).toBeNull();
      expect(await Q.node({}, { ref: urn(m) }, principal)).toBeNull();
    }
    // the one admitted row still reads, so the null above is the predicate and not a broken fixture
    expect(await Q.node({}, { ref: urn(f.pub) }, principal)).toMatchObject({ content: 'secret pub' });
  });
  it('a user-backed caller with an App gains no foreign non-PUBLIC read through node(ref)', async () => {
    const user = await db.user.create({ data: { id: generateId(), email: `u-${generateId().toLowerCase()}@example.test` } as never });
    const userCaller = { db, userId: user.id, appId: f.app.id, roles: [] } as unknown as Context;
    const node = await db.node.findFirst({ where: { memoryId: f.orgVisible.id, loc: LOC } });
    expect(await Q.node({}, { ref: node!.id }, userCaller)).toBeNull();
    expect(await Q.node({}, { ref: urn(f.orgVisible) }, userCaller)).toBeNull();
  });
  it('a PUBLIC knowledge row with an owner, a per-user agent holding or an install flag is not admitted', async () => {
    const user = await db.user.create({ data: { id: generateId(), email: `o-${generateId().toLowerCase()}@example.test` } as never });
    for (const [slug, extra] of [['ownerx', { ownerUserId: user.id }], ['installx', { isInstallMemory: true }]] as const) {
      const row = await db.memory.create({
        data: { name: slug, urn: `${f.orgB.urn}:${slug}`, class: 'knowledge', visibility: 'PUBLIC', organizationId: slug === 'ownerx' ? null : f.orgB.id, ...extra },
      }).catch((err: unknown) => {
        if (!/check constraint|chk_memory/i.test(String((err as Error)?.message))) throw err;
        return null;
      });
      if (slug === 'ownerx') expect(row).not.toBeNull();
      if (!row) continue; // only the install shape can be excluded by its validated CHECK
      expect((await publicKnowledgeAmong(db, [row.id])).has(row.id)).toBe(false);
      await db.node.create({ data: { memoryId: row.id, loc: LOC, name: 'owned PUBLIC', content: 'owner only', nodeType: 'record' } });
      for (const principal of [f.keyPrincipal, f.runPrincipal, f.confined]) {
        expect(await getAccessibleMemoryIds(principal, row.id)).not.toContain(row.id);
        expect(await Q.node({}, { ref: urn(row) }, principal)).toBeNull();
        expect(await canReadMemory(db, principal as never, row.id, EXPLICIT_REF)).toBe(false);
      }
    }
  });
  it('an unscoped node search never surfaces a non-PUBLIC or App-scoped memory', async () => {
      const out = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 50 }, { ...f.keyPrincipal });
      const ids = out.hits.map((h: { node: { memoryId: string } }) => h.node.memoryId);
      for (const hidden of [f.orgVisible, f.appScoped, f.ownAppScoped, f.group, f.deleted]) expect(ids).not.toContain(hidden.id);
    });
  });
});

describe('#3306 the shared predicate itself', () => {
  it('names a credential with an App and no user or impersonation, with or without a session', () => {
    expect(readsPublicKnowledgeWithoutUser({ appId: 'a' })).toBe(true);
    expect(readsPublicKnowledgeWithoutUser({ appId: 'a', userId: 'u' })).toBe(false);
    expect(readsPublicKnowledgeWithoutUser({ appId: 'a', sessionId: 's' })).toBe(true);
    expect(readsPublicKnowledgeWithoutUser({ appId: 'a', impersonation: { orgId: 'o' } })).toBe(false);
    expect(readsPublicKnowledgeWithoutUser({})).toBe(false);
  });
  it('a PUBLIC memory of a class other than knowledge is not admitted', async () => {
    for (const [slug, cls] of [['pubsys', 'system'], ['pubapp', 'app']] as const) {
      const row = await db.memory.create({
        data: { name: slug, urn: `${f.orgB.urn}:${slug}`, class: cls, visibility: 'PUBLIC', organizationId: f.orgB.id },
      }).catch((err: unknown) => {
        // Only a CHECK refusal means the shape cannot exist; anything else is a broken fixture and must fail.
        if (!/check constraint|chk_memory/i.test(String((err as Error)?.message))) throw err;
        return null;
      });
      if (!row) continue; // a CHECK already refuses the shape; nothing to admit
      expect((await publicKnowledgeAmong(db, [row.id])).has(row.id)).toBe(false);
      expect(await canReadMemory(db, f.keyPrincipal as never, row.id)).toBe(false);
    }
  });
  it.each(['key', 'run', 'session'] as const)('named discovery is capped at 200 and pages the 201st node (%s)', async who => {
    await db.node.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ memoryId: f.pub.id, loc: `cap:${String(i).padStart(3, '0')}`, name: 'needle3306 cap', content: 'cap', nodeType: 'record' })) });
    const principal = who === 'key' ? f.keyPrincipal : who === 'run' ? f.runPrincipal : f.confined;
    const page = (limit: number, offset = 0) => Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit, offset, filter: { memoryIds: [f.pub.id, f.orgVisible.id, f.appScoped.id] } }, { ...principal });
    const at = await page(200);
    const over = await page(201);
    const next = await page(200, 200);
    expect(at.hits).toHaveLength(200);
    expect(over.hits.map((h: any) => h.node.id)).toEqual(at.hits.map((h: any) => h.node.id));
    expect(next.hits).toHaveLength(1);
    expect(new Set([...at.hits, ...next.hits].map((h: any) => h.node.id)).size).toBe(201);
    expect([...at.hits, ...next.hits].every((h: any) => h.node.memoryId === f.pub.id)).toBe(true);
  });
  it.each(['key', 'run', 'session'] as const)('a %s search names PUBLIC targets without an id-less lookup', async who => {
    const principal = who === 'key' ? f.keyPrincipal : who === 'run' ? f.runPrincipal : f.confined;
    const extra: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await db.memory.create({ data: { name: `p${i}`, urn: `${f.orgB.urn}:extra${i}`, class: 'knowledge', visibility: 'PUBLIC', organizationId: f.orgB.id } });
      await db.node.create({ data: { memoryId: m.id, loc: LOC, name: 'needle3306 extra', content: 'x', nodeType: 'record' } });
      extra.push(m.id);
    }
    const seen: unknown[] = [];
    const orig = db.memory.findMany.bind(db.memory);
    const spy = vi.spyOn(db.memory, 'findMany').mockImplementation(((args: { where?: { visibility?: string; id?: unknown } }) => {
      if (args?.where?.visibility === 'PUBLIC') seen.push(args.where.id);
      return orig(args as never);
    }) as never);
    try {
      // Unscoped: no PUBLIC memory is named, so none is looked up and none surfaces.
      const unscoped = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 50 }, { ...principal });
      expect(unscoped.hits.map((h: { node: { memoryId: string } }) => h.node.memoryId)).not.toContain(extra[0]);
      expect(seen).toHaveLength(0);
      // Named: exactly the named ids are looked up (cap and cap+1 on the node page still hold).
      const named = { memoryIds: extra };
      const atCap = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 3, filter: named }, { ...principal });
      expect(atCap.hits).toHaveLength(3);
      const over = await Q.findNodes({}, { query: 'needle3306', mode: 'keyword', limit: 4, filter: named }, { ...principal });
      expect(over.hits).toHaveLength(4);
      expect(seen.length).toBeGreaterThan(0);
      for (const w of seen) expect(w).toEqual({ in: extra });
    } finally {
      spy.mockRestore();
    }
  });
});
