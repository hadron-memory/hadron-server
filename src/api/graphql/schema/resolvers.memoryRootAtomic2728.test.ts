import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';
import * as orgDefaults from './resolvers.memoryConfigOrgDefault.js';

// #2728, restated by #3952 (R11): a new memory has no root node, so the atomicity point is now "a failure
// after the Memory row is written leaves no Memory row (and no group owner row), and a retry mints exactly
// one". The failure is injected at the last step of createMemory's transaction, the org-default application.
afterEach(() => vi.restoreAllMocks());
const M = resolvers.Mutation as any;
let org: any, admin: any;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });
const inject = () => vi.spyOn(orgDefaults, 'applyOrgDefaultsAtCreation').mockRejectedValueOnce(new Error('injected failure'));
const createMemory = () => M.createMemory({}, { name: 'Notes2728', orgRef: org.id }, ctx());
const counts = async () => ({ memories: await db.memory.count(), nodes: await db.node.count() });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Root atomic', urn: 'root2728.test' } });
  admin = await db.user.create({ data: { githubId: 272800, githubUsername: 'u2728', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});

describe('#2728 / #3952 createMemory', () => {
  it('rolls the memory back when a later step fails, and a retry mints exactly one', async () => {
    inject();
    await expect(createMemory()).rejects.toThrow('injected failure');
    expect(await counts()).toEqual({ memories: 0, nodes: 0 });
    const made = await createMemory();
    expect(await counts()).toEqual({ memories: 1, nodes: 0 });
    expect(await db.memory.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ name: 'Notes2728', organizationId: org.id });
  });
});

it('createMemory with class group keeps its owner row and rolls it back with the memory', async () => {
  inject();
  await expect(M.createMemory({}, { name: 'Grp2728', orgRef: org.id, memoryClass: 'group' }, ctx())).rejects.toThrow('injected failure');
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
