import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import * as nodeMutations from '../../../controller/operations/createNode.js';

// #3952 (rulings R11/R12): no memory gets a root node on create. The three paths that built one from the
// display name (createMemory, createAppMemory, createMemoryInApp) no longer do; the memory row, a group's
// owner row and a knowledge memory's agent grant are still written in the same transaction. A memory that
// already has a root keeps it (no migration, no data change).
// Isolation: every vitest worker runs against its own database clone (CLAUDE.md, "Common commands"), so a trigger
// here cannot fail another file's inserts. A run that died between CREATE and DROP leaves the trigger in that clone
// only, and the clones are dropped at teardown; beforeAll still drops any leftover so a rerun starts clean.
let failingTable: string | null = null;
/** A real database failure on the next insert into `table`, so a step AFTER the memory row can be made to fail. */
const failInsertsInto = async (table: string) => {
  failingTable = table;
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_insert_3952() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure 3952'; END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER fail_insert_3952 BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION fail_insert_3952()`);
};
const stopFailing = async () => {
  if (!failingTable) return;
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_insert_3952 ON "${failingTable}"`);
  failingTable = null;
};
beforeAll(async () => {
  for (const table of ['agent_memory_items', 'memory_members']) await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_insert_3952 ON "${table}"`);
});
afterEach(async () => { vi.restoreAllMocks(); await stopFailing(); });
afterAll(async () => { await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_insert_3952() CASCADE'); });
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

  it('a memory that already has a root keeps it through a rename, and through a mint dry run', async () => {
    const made = await M.createMemory({}, { name: 'Old2 3952', orgRef: org.id }, ctx());
    const root = await db.node.create({ data: { memoryId: made.id, loc: 'Old2 3952', name: 'Old2 3952', description: 'Root node for this memory.' } });
    await M.updateMemory({}, { ref: made.id, name: 'Renamed3952' }, ctx());
    await M.mintMemoryNodes({}, { memoryRef: made.id, dryRun: true }, ctx());
    expect(await nodesOf(made.id)).toMatchObject([{ id: root.id, loc: 'Old2 3952', deletedAt: null }]);
  });
});

// Blind review P2s on #5129: with the root gone, the failure that proves atomicity must come from a step that still
// runs AFTER the memory row is written. createAppMemory and createMemory (personal) have no such step (the memory
// row is their only write), so there is nothing to roll back there; createMemory (group owner row) and
// createMemoryInApp (knowledge agent grant) do.
describe('#3952 a failure after the memory row rolls everything back, is a server fault, and a retry mints one', () => {
  it('createMemoryInApp (knowledge): the agent grant fails', async () => {
    await failInsertsInto('agent_memory_items');
    const err = await M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'Atomic3952' }, ctx()).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.extensions?.code).not.toBe('BAD_USER_INPUT');
    expect(await db.memory.count()).toBe(0);
    expect(await db.node.count()).toBe(0);
    await stopFailing();
    const made = await M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'Atomic3952' }, ctx());
    expect(await db.memory.count()).toBe(1);
    expect(await db.agentMemoryItem.count({ where: { memoryId: made.id } })).toBe(1);
  });
  it('createMemory (group): the owner row fails', async () => {
    await failInsertsInto('memory_members');
    const err = await M.createMemory({}, { name: 'AtomicGrp3952', orgRef: org.id, memoryClass: 'group' }, ctx()).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.extensions?.code).not.toBe('BAD_USER_INPUT');
    expect(await db.memory.count()).toBe(0);
    await stopFailing();
    const made = await M.createMemory({}, { name: 'AtomicGrp3952', orgRef: org.id, memoryClass: 'group' }, ctx());
    expect(await db.memory.count()).toBe(1);
    expect(await db.memoryMember.count({ where: { memoryId: made.id } })).toBe(1);
  });
});

// Ruled by the team lead on #5129 (N4): with no root node to survive, extractParentNodeToMemory(move: true) of a
// memory's only subtree is refused as emptying the source. Before #3952 the root kept the source non-empty and the
// same move succeeded. The refusal stays (it fails safe, workaround cloneMemory + deleteMemory); whether an emptied
// source should be allowed is #5148.
describe('#3952 extractParentNodeToMemory(move) of a rootless memory\'s only subtree is refused', () => {
  const extract = (parentId: string, slug: string) =>
    M.extractParentNodeToMemory({}, { parentRef: parentId, targetUrn: `hrn:mem:${org.urn}:${slug}`, move: true }, ctx());
  const live = (memoryId: string) => db.node.count({ where: { memoryId, deletedAt: null } });
  async function sourceWithOneSubtree() {
    const src = await M.createMemory({}, { name: 'Src3952', orgRef: org.id }, ctx());
    expect(await nodesOf(src.id)).toEqual([]);
    const parent = await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'p', name: 'p', tags: [] } });
    await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'p:c', name: 'c', tags: [] } });
    return { src, parent };
  }
  it('refuses BAD_USER_INPUT, moves no node and creates no target memory', async () => {
    const { src, parent } = await sourceWithOneSubtree();
    const err = await extract(parent.id, 'out3952a').catch((e: any) => e);
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toContain('would empty the source memory');
    expect(await live(src.id)).toBe(2);
    expect(await db.memory.count({ where: { urn: `${org.urn}:out3952a` } })).toBe(0);
  });
  it('the same move succeeds once a node outside the subtree remains (the survivor is what the guard needs)', async () => {
    const { src, parent } = await sourceWithOneSubtree();
    await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'keep', name: 'keep', tags: [] } });
    await extract(parent.id, 'out3952b');
    expect(await live(src.id)).toBe(1);
    expect(await db.memory.count({ where: { urn: `${org.urn}:out3952b` } })).toBe(1);
  });
});
