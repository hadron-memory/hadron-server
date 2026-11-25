import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import * as nodeMutations from '../../../controller/operations/createNode.js';

// #3952 (rulings R11/R12): no memory gets a root node on create. The three paths that built one from the
// display name (createMemory, createAppMemory, createMemoryInApp) no longer do; the memory row, a group's
// owner row and a knowledge memory's agent grant are still written in the same transaction. A memory that
// already has a root keeps it (no migration, no data change).
afterEach(() => vi.restoreAllMocks());
const M = resolvers.Mutation as any;
let org: any, admin: any, app: any, agent: any;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });
const nodesOf = (memoryId: string) => db.node.findMany({ where: { memoryId } });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'No root', urn: 'noroot3952.test' } });
  admin = await db.user.create({ data: { githubId: 395200, githubUsername: 'u3952', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { name: 'Helper', urn: `${org.urn}:helper`, organizationId: org.id } });
  app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id, appAgents: { create: { agentId: agent.id } } } });
});

describe('#3952 a new memory has no root node', () => {
  it('createMemory (organization knowledge) creates the memory and no node', async () => {
    const made = await M.createMemory({}, { name: 'QA Specs', orgRef: org.id }, ctx());
    expect(await db.memory.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ name: 'QA Specs', organizationId: org.id });
    expect(await nodesOf(made.id)).toEqual([]);
  });
  it('createMemory (personal) creates the memory and no node', async () => {
    const made = await M.createMemory({}, { name: 'Mine3952', memoryClass: 'personal' }, ctx());
    expect(await db.memory.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ userId: admin.id });
    expect(await nodesOf(made.id)).toEqual([]);
  });
  it('createMemory (group) creates the memory and its owner row, and no node', async () => {
    const made = await M.createMemory({}, { name: 'Grp3952', orgRef: org.id, memoryClass: 'group' }, ctx());
    expect(await db.memoryMember.findMany({ where: { memoryId: made.id } })).toMatchObject([{ userId: admin.id, role: 'owner' }]);
    expect(await nodesOf(made.id)).toEqual([]);
  });
  it('createAppMemory creates the app memory and no node', async () => {
    const made = await M.createAppMemory({}, { appRef: app.id, name: 'App Notes' }, ctx());
    expect(await db.memory.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({ class: 'app', appId: app.id });
    expect(await nodesOf(made.id)).toEqual([]);
  });
  it('createMemoryInApp (knowledge) creates the memory and its agent grant, and no node', async () => {
    const made = await M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'AppKnow3952' }, ctx());
    expect(await db.agentMemoryItem.findMany({ where: { memoryId: made.id } })).toMatchObject([{ agentId: agent.id, role: 'read' }]);
    expect(await nodesOf(made.id)).toEqual([]);
  });
  it('createMemoryInApp (app class) creates the memory and no node', async () => {
    const made = await M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'AppClass3952' }, ctx());
    expect(await nodesOf(made.id)).toEqual([]);
  });
  it('no create path calls createNode', async () => {
    const spy = vi.spyOn(nodeMutations, 'createNode');
    await M.createMemory({}, { name: 'Spy3952', orgRef: org.id }, ctx());
    await M.createAppMemory({}, { appRef: app.id, name: 'SpyApp3952' }, ctx());
    await M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'SpyIn3952' }, ctx());
    expect(spy).not.toHaveBeenCalled();
  });
  it('a memory that already has a root keeps it, untouched', async () => {
    const made = await M.createMemory({}, { name: 'Old3952', orgRef: org.id }, ctx());
    const root = await db.node.create({ data: { memoryId: made.id, loc: 'Old 3952', name: 'Old 3952', description: 'Root node for this memory.' } });
    await M.updateMemory({}, { ref: made.id, description: 'edited' }, ctx());
    expect(await nodesOf(made.id)).toMatchObject([{ id: root.id, loc: 'Old 3952' }]);
  });
});
