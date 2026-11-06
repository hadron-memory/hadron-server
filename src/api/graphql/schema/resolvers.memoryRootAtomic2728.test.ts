import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';
import * as rootFs from '../../../integrations/localFs/saveNodeToFs.js';

// #2728: createMemory and createMemoryInApp create the root node INSIDE the Memory's transaction (the #2670
// capability), so a root failure rolls the Memory back and a retry cannot mint a second one.
afterEach(() => vi.restoreAllMocks());
const M = resolvers.Mutation as any;
let org: any, admin: any, app: any, agent: any;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });
const inject = () => vi.spyOn(rootFs, 'saveNodeToFs').mockResolvedValueOnce({ error: 'injected root failure' });
const createMemory = () => M.createMemory({}, { name: 'Notes2728', orgId: org.id }, ctx());
const inApp = () => M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'AppNotes2728' }, ctx());
const counts = async () => ({ memories: await db.memory.count(), nodes: await db.node.count() });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Root atomic', urn: 'root2728.test' } });
  admin = await db.user.create({ data: { githubId: 272800, githubUsername: 'u2728', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { name: 'Helper', urn: `${org.urn}:helper`, organizationId: org.id } });
  app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id, appAgents: { create: { agentId: agent.id } } } });
});

describe.each([
  ['createMemory', createMemory],
  ['createMemoryInApp', inApp],
])('#2728 %s', (_name, create) => {
  it('rolls the memory back when creating its root fails, and a retry mints exactly one', async () => {
    inject();
    await expect(create()).rejects.toThrow('injected root failure');
    expect(await counts()).toEqual({ memories: 0, nodes: 0 });
    const made = await create();
    expect(await counts()).toEqual({ memories: 1, nodes: 1 });
    expect(await db.node.findFirstOrThrow({ where: { memoryId: made.id } })).toMatchObject({ description: 'Root node for this memory.' });
  });
  it('still creates the memory and its root on success', async () => {
    const made = await create();
    expect(await db.memory.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ name: expect.stringContaining('2728') });
    expect(await db.node.count({ where: { memoryId: made.id } })).toBe(1);
  });
});

it('createMemory with class group keeps its owner row and rolls it back with the memory', async () => {
  inject();
  await expect(M.createMemory({}, { name: 'Grp2728', orgId: org.id, memoryClass: 'group' }, ctx())).rejects.toThrow('injected root failure');
  expect(await db.memory.count()).toBe(0);
  expect(await db.memoryMember.count()).toBe(0);
});

it('the MCP hadron_create_memory door inherits the rollback', async () => {
  inject();
  const auth = { userId: admin.id, roles: ['READER'] as any[], clientId: `user:${admin.id}` };
  const text = await createTestableMcpServer(auth).callToolText('hadron_create_memory', { name: 'Mcp2728', org: org.id });
  expect(text).toMatch(/internal_server_error/i); // the boundary redacts the message
  expect(await counts()).toEqual({ memories: 0, nodes: 0 });
});
