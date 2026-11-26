/**
 * Reusing a soft-deleted memory's URN at the doors outside createMemory/cloneMemory/extract (hadron-internal#75; the
 * rule of hadron-internal#70, cor:dmo:010:04, cor:acl:010:02): another user's personal or private tombstone is never
 * removed, and the door answers as it does for a live holder. The caller's own tombstone and an org-shared one (the
 * door's own gate) are reused as before. Account merge: a tombstone of either merged account is reused; any other
 * holder is minted past and left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { repairAgentSystemMemoryOwner } from './agentSystemMemory.js';
import { mergeOwnerNamespacedUrns } from './mergeOwnerNamespacedUrns.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const orgUrn = 'reuse-owner-75';
let orgId: string;
let admin: string;
let victim: string;
const as = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { message: String(e.message), code: e.extensions?.code };
  }
  throw new Error('expected a refusal');
};

async function tombstone(urn: string, data: Record<string, unknown>) {
  const id = generateId();
  await db.memory.create({ data: { id, name: 'Old', urn, deletedAt: new Date(), ...data } as any });
  await db.node.create({ data: { id: generateId(), memoryId: id, loc: 'entry', name: 'Entry', content: 'kept' } });
  return id;
}
const personalTombstone = (urn: string, userId: string) =>
  tombstone(urn, { organizationId: orgId, class: 'personal', userId });
const survives = async (id: string) => ({
  memory: await db.memory.count({ where: { id } }),
  nodes: await db.node.count({ where: { memoryId: id } }),
});

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } })).id;
  admin = (await db.user.create({ data: { githubId: 75001, githubUsername: 'admin75', handle: 'admin75' } })).id;
  victim = (await db.user.create({ data: { githubId: 75002, githubUsername: 'victim75', handle: 'victim75' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: victim, role: 'CONTRIBUTOR' } });
});

const createAgent = (slug: string) => M.createAgent({}, { orgRef: orgId, name: 'Helper', slug }, as(admin));

describe('createAgent with a supplied slug (F2b)', () => {
  it("an org ADMIN is refused over another member's personal tombstone at <agent>-system; it survives", async () => {
    const id = await personalTombstone(`${orgUrn}:x-system`, victim);
    const r = await refusal(createAgent('x'));
    expect(r.code).toBe('AGENT_URN_TAKEN');
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
    expect(await db.agent.count({ where: { urn: `${orgUrn}:x` } })).toBe(0);
  });
  it('the refusal is the one a live holder of the URN gets', async () => {
    await personalTombstone(`${orgUrn}:x-system`, victim);
    await db.memory.create({ data: { id: generateId(), name: 'Live', urn: `${orgUrn}:y-system`, organizationId: orgId, class: 'knowledge' } });
    const dead = await refusal(createAgent('x'));
    const live = await refusal(createAgent('y'));
    expect(dead.code).toBe(live.code);
    expect(dead.message.replace('x-system', 'Z')).toBe(live.message.replace('y-system', 'Z'));
  });
  it("controls: the caller's own personal tombstone and an org-shared one are reused", async () => {
    const own = await personalTombstone(`${orgUrn}:x-system`, admin);
    await createAgent('x');
    expect(await survives(own)).toEqual({ memory: 0, nodes: 0 });
    const shared = await tombstone(`${orgUrn}:z-system`, { organizationId: orgId, class: 'knowledge' });
    await createAgent('z');
    expect(await survives(shared)).toEqual({ memory: 0, nodes: 0 });
  });
});

describe('cloneAgent with a supplied slug', () => {
  it("an org ADMIN is refused over another member's personal tombstone at <agent>-system; it survives", async () => {
    const source = await createAgent('source');
    const id = await personalTombstone(`${orgUrn}:copy-system`, victim);
    const r = await refusal(M.cloneAgent(null, { source: source.urn, target: orgUrn, slug: 'copy' }, as(admin)));
    expect(r.code).toBe('AGENT_URN_TAKEN');
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });
  it("control: the caller's own personal tombstone is reused", async () => {
    const source = await createAgent('source');
    const id = await personalTombstone(`${orgUrn}:copy-system`, admin);
    await M.cloneAgent(null, { source: source.urn, target: orgUrn, slug: 'copy' }, as(admin));
    expect(await survives(id)).toEqual({ memory: 0, nodes: 0 });
  });
});

describe('createMemoryInApp, class app (F2a)', () => {
  it("an org ADMIN's create never removes another member's personal tombstone holding the name", async () => {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: `${orgUrn}:coach`, organizationId: orgId } });
    const app = (await createDbAppWithKey(db, 'tutor75', orgId)).app;
    await createDbAppAgent(db, app.id, agent.id);
    const id = await personalTombstone(`${orgUrn}:notes`, victim);
    const made = await M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'notes' }, as(admin));
    expect(made.urn).not.toBe(`${orgUrn}:notes`);
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });
});

describe('repairAgentSystemMemoryOwner', () => {
  async function misOwnedAgent() {
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Fix', urn: `${orgUrn}:fix`, organizationId: orgId } });
    const mem = await db.memory.create({ data: { id: generateId(), name: 'Fix System', urn: 'elsewhere:fix-system', ownerUserId: admin, class: 'system', acceptsUploads: false } });
    await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: mem.id } });
    return agent.id;
  }
  it("leaves another member's personal tombstone at the derived URN alone and keeps the URN", async () => {
    const agentId = await misOwnedAgent();
    const id = await personalTombstone(`${orgUrn}:fix-system`, victim);
    const r = await repairAgentSystemMemoryOwner(db, agentId, { actorId: admin });
    expect(r.urn).toBe('elsewhere:fix-system');
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });
  it('control: an org-shared tombstone at the derived URN is reused', async () => {
    const agentId = await misOwnedAgent();
    const id = await tombstone(`${orgUrn}:fix-system`, { organizationId: orgId, class: 'knowledge' });
    const r = await repairAgentSystemMemoryOwner(db, agentId, { actorId: admin });
    expect(r.urn).toBe(`${orgUrn}:fix-system`);
    expect(await survives(id)).toEqual({ memory: 0, nodes: 0 });
  });
});

describe('mergeOwnerNamespacedUrns', () => {
  async function merge(sourceUserId: string, targetUserId: string) {
    await db.$transaction((tx) => mergeOwnerNamespacedUrns(tx, { sourceUserId, targetUserId, targetHandle: 'victim75', sourceHandle: 'admin75' }));
  }
  const liveOwned = async (userId: string) => {
    const id = generateId();
    await db.memory.create({ data: { id, name: 'Notes', urn: 'admin75:notes', ownerUserId: userId, class: 'personal', userId } });
    return id;
  };
  it("a third user's tombstone at the target URN is minted past and survives", async () => {
    const third = (await db.user.create({ data: { githubId: 75003, githubUsername: 'third75', handle: 'third75' } })).id;
    const moved = await liveOwned(admin);
    const id = await tombstone('victim75:notes', { ownerUserId: third, class: 'personal', userId: third });
    await merge(admin, victim);
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
    const after = await db.memory.findUniqueOrThrow({ where: { id: moved } });
    expect(after.urn).not.toBe('victim75:notes');
    expect(after.urn.startsWith('victim75:')).toBe(true);
  });
  for (const holder of ['source', 'target'] as const) {
    it(`control: the ${holder} account's own tombstone at the target URN is reused`, async () => {
      const moved = await liveOwned(admin);
      const owner = holder === 'source' ? admin : victim;
      const id = await tombstone('victim75:notes', { ownerUserId: owner, class: 'personal', userId: owner });
      await merge(admin, victim);
      expect(await survives(id)).toEqual({ memory: 0, nodes: 0 });
      expect((await db.memory.findUniqueOrThrow({ where: { id: moved } })).urn).toBe('victim75:notes');
    });
  }
});
