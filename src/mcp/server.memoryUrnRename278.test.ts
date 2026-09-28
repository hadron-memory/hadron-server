/** #278: MCP renderers must see a Memory rename without a process restart. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let adminId: string;
let memoryId: string;
let edgeId: string;
let server: ReturnType<typeof createTestableMcpServer>;

const oldPrefix = 'rename278.example:before';
const newPrefix = 'rename278.example:after';
const nodeUrn = (prefix: string, loc: string) => `hrn:node:${prefix}:${loc}`;
const graphCtx = (): Context => ({ db, userId: adminId, roles: ['ADMIN'] });
const adminAuth = (): AuthContext => ({
  userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}`,
});
const render = (tool: string, args: Record<string, unknown>) => server.callToolText(tool, args);

beforeEach(async () => {
  await cleanDb(db);
  process.env.FRONTEND_URL = 'https://hadronmemory.com';
  const org = await db.organization.create({
    data: { id: generateId(), urn: 'rename278.example', name: 'Rename fixture' },
  });
  const admin = await db.user.create({
    data: { githubId: 278001, githubUsername: 'rename278-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const memory = await resolvers.Mutation.createMemory(
    {}, { orgId: org.id, name: 'before' }, graphCtx(),
  );
  memoryId = memory.id;
  const action = await db.node.create({
    data: { id: generateId(), memoryId, loc: 'tasks:run', name: 'Run', content: 'Run body', isRunnable: true },
  });
  const target = await db.node.create({
    data: { id: generateId(), memoryId, loc: 'docs:target', name: 'Target', content: 'Target body' },
  });
  const edge = await db.edge.create({
    data: {
      id: generateId(), memoryId, loc: 'tasks:run:depends-on:docs:target',
      sourceId: action.id, targetId: target.id, name: 'depends-on',
    },
  });
  edgeId = edge.id;
  server = createTestableMcpServer(adminAuth());
});

afterEach(() => { process.env.FRONTEND_URL = ''; });

describe('#278 fresh MCP memory URNs', () => {
  it('re-renders node, neighbour, edge, portal link, and run dependency after GraphQL rename', async () => {
    const beforeRead = await render('hadron_get_node', { urn: nodeUrn(oldPrefix, 'tasks:run') });
    const beforeEdge = await render('hadron_update_edge', { edgeRef: edgeId, description: 'before' });
    const beforeBundle = await render('hadron_run_action', { urn: nodeUrn(oldPrefix, 'tasks:run') });
    expect(beforeRead).toContain(nodeUrn(oldPrefix, 'docs:target'));
    expect(beforeEdge).toContain(`hrn:edge:${oldPrefix}:${'tasks:run:depends-on:docs:target'}`);
    expect(beforeBundle).toContain(nodeUrn(oldPrefix, 'docs:target'));

    await resolvers.Mutation.updateMemory({}, { id: memoryId, urn: 'after' }, graphCtx());
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).urn).toBe(newPrefix);

    const afterRead = await render('hadron_get_node', { urn: nodeUrn(newPrefix, 'tasks:run') });
    expect(afterRead).toContain(nodeUrn(newPrefix, 'tasks:run'));
    expect(afterRead).toContain(nodeUrn(newPrefix, 'docs:target'));
    expect(afterRead).toContain(`URL: https://hadronmemory.com/app/u/${nodeUrn(newPrefix, 'tasks:run')}`);
    expect(afterRead).not.toContain(oldPrefix);
    const batch = await render('hadron_get_nodes', { refs: [nodeUrn(newPrefix, 'tasks:run')] });
    expect(batch).toContain(nodeUrn(newPrefix, 'tasks:run'));
    expect(batch).not.toContain(oldPrefix);
    const list = await render('hadron_list_nodes', { memoryUrn: `hrn:mem:${newPrefix}`, depth: 2 });
    expect(list).toContain(nodeUrn(newPrefix, 'tasks:run'));
    expect(list).not.toContain(oldPrefix);
    const search = await render('hadron_find_nodes', { query: '*', memoryUrn: `hrn:mem:${newPrefix}` });
    expect(search).toContain(nodeUrn(newPrefix, 'tasks:run'));
    expect(search).not.toContain(oldPrefix);

    const afterEdge = await render('hadron_update_edge', { edgeRef: edgeId, description: 'after' });
    expect(afterEdge).toContain(`hrn:edge:${newPrefix}:tasks:run:depends-on:docs:target`);
    expect(afterEdge).not.toContain(oldPrefix);

    const afterBundle = await render('hadron_run_action', { urn: nodeUrn(newPrefix, 'tasks:run') });
    expect(afterBundle).toContain(nodeUrn(newPrefix, 'docs:target'));
    expect(afterBundle).not.toContain(oldPrefix);
  });

  it('keeps unchanged memory URNs and the corrupt-loc portal-link refusal', async () => {
    const first = await render('hadron_get_node', { urn: nodeUrn(oldPrefix, 'tasks:run') });
    const second = await render('hadron_get_node', { urn: nodeUrn(oldPrefix, 'tasks:run') });
    expect(second).toContain(nodeUrn(oldPrefix, 'tasks:run'));
    expect(second).toContain(`URL: https://hadronmemory.com/app/u/${nodeUrn(oldPrefix, 'tasks:run')}`);
    expect(second).toBe(first);

    await db.node.create({
      data: { id: generateId(), memoryId, loc: 'broken:', name: 'Broken loc' },
    });
    const broken = await render('hadron_get_node', { urn: 'rename278.example::before::broken:' });
    expect(broken).toContain('Broken loc');
    expect(broken).not.toContain('URL:');
  });
});
