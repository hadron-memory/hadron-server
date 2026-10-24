/** DV-B / DX-C: an App cascade must preserve another user's strict-owner data. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers } from './resolvers.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { makeKeyVerifier } from '../../../lib/memoryUnlock.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { detachAppOwnerMemories } from '../../../controller/operations/detachAppOwnerMemories.js';

vi.mock('../../../lib/asset/purge.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/asset/purge.js')>();
  return { ...actual, purgeCollectedAssetObjects: vi.fn(async () => undefined) };
});
import { purgeCollectedAssetObjects } from '../../../lib/asset/purge.js';

beforeEach(async () => { await cleanDb(db); vi.clearAllMocks(); });

async function fixture(personalApp = false, userTenant = false, encryptedPrivate = false) {
  const actor = await db.user.create({ data: { handle: 'app-delete-actor', roles: ['ADMIN'] } });
  const owner = await db.user.create({ data: { handle: 'app-delete-owner', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Retention', urn: 'retention.test' } });
  await db.orgMember.create({ data: { userId: actor.id, organizationId: org.id, role: 'OWNER' } });
  const agent = await db.agent.create({ data: { name: 'Retention agent', urn: 'retention.test:agent', organizationId: org.id } });
  const app = await db.app.create({ data: {
    name: 'Retention App', urn: personalApp ? 'app-delete-actor:retention' : 'retention.test:retention',
    ...(personalApp ? { ownerUserId: actor.id } : { organizationId: org.id }),
    deletedAt: personalApp ? null : new Date(),
  } });
  const memories = [];
  const key = parseDataKey(Buffer.alloc(32, 9).toString('base64'));
  const content = (text: string, encrypted: boolean) => encrypted ? encryptNodeFieldsWithKey({ content: text }, key).content! : text;
  for (const memoryClass of ['personal', 'private'] as const) {
    const memory = await db.memory.create({ data: {
      name: memoryClass, urn: `${userTenant ? actor.handle : org.urn}:${memoryClass}`,
      ...(userTenant ? { ownerUserId: actor.id } : { organizationId: org.id }),
      appId: app.id, userId: owner.id, userMemoryOfAgentId: agent.id, class: memoryClass,
      ...(encryptedPrivate && memoryClass === 'private' ? { isEncrypted: true, keyVerifier: makeKeyVerifier(key) } : {}),
    } });
    const node = await db.node.create({ data: { memoryId: memory.id, loc: 'note', name: 'Note', content: content('retained content', encryptedPrivate && memoryClass === 'private') } });
    const revision = await db.nodeRevision.create({ data: { nodeId: node.id, memoryId: memory.id, loc: 'note', name: 'Note', content: content('retained history', encryptedPrivate && memoryClass === 'private') } });
    const asset = await db.asset.create({ data: { memoryId: memory.id, filename: 'retained.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: `retained/${memory.id}` } });
    memories.push({ memory, node, revision, asset });
  }
  const scratch = await db.memory.create({ data: { name: 'Scratch', urn: 'retention.test:scratch', organizationId: org.id, appId: app.id, class: 'app' } });
  return { actor, owner, org, agent, app, memories, scratch };
}

async function assertPreserved(f: Awaited<ReturnType<typeof fixture>>) {
  for (const { memory, node, revision, asset } of f.memories) {
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toEqual({ ...memory, appId: null, userMemoryOfAgentId: null, updatedAt: expect.any(Date) });
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toEqual(node);
    expect(await db.nodeRevision.findUniqueOrThrow({ where: { id: revision.id } })).toEqual(revision);
    expect(await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).toEqual(asset);
    for (const ref of [memory.id, memory.urn]) {
      const read = await resolvers.Query.memory({}, { ref }, { db, userId: f.owner.id, roles: ['READER'] });
      expect(read?.id).toBe(memory.id);
    }
  }
  expect(await db.app.findUnique({ where: { id: f.app.id } })).toBeNull();
  expect(await db.memory.findUnique({ where: { id: f.scratch.id } })).toBeNull();
}

describe('App hard-delete retention', () => {
  it.each([false, true])('reclaim preserves foreign holdings (encrypted private=%s) and permits replacement', async encrypted => {
    const f = await fixture(false, false, encrypted);
    const replacement = await resolvers.Mutation.createApp({}, {
      orgRef: f.org.id, agentRef: f.agent.id, name: f.app.name, urn: 'retention',
    }, { db, userId: f.actor.id, roles: ['ADMIN'] });
    expect(replacement.id).not.toBe(f.app.id);
    expect(replacement.urn).toBe(f.app.urn);
    await assertPreserved(f);
  });

  it('dependency App reclaim preserves its strict-owner holdings', async () => {
    const f = await fixture();
    const dependency = await db.agent.create({ data: { name: 'Dependency', urn: 'retention.test:retention', organizationId: f.org.id } });
    await db.agentOrgGrant.create({ data: { orgId: f.org.id, agentId: dependency.id, activatedAt: new Date() } });
    await db.agentImport.create({ data: { parentAgentId: f.agent.id, importedAgentId: dependency.id, required: true, position: 0, agentOrgGrantOrgId: f.org.id, agentOrgGrantAgentId: dependency.id } });
    await resolvers.Mutation.createApp({}, { orgRef: f.org.id, agentRef: f.agent.id, name: 'Parent', urn: 'parent' }, { db, userId: f.actor.id, roles: ['ADMIN'] });
    await assertPreserved(f);
    expect(await db.app.findFirst({ where: { urn: f.app.urn, deletedAt: null } })).not.toBeNull();
  });

  it('a transaction rollback restores detached scope and prevents a partial deletion', async () => {
    const f = await fixture();
    await expect(db.$transaction(async tx => {
      await detachAppOwnerMemories(tx, [f.app.id]);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    for (const { memory } of f.memories) expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toEqual(memory);
    expect(await db.app.findUnique({ where: { id: f.app.id } })).not.toBeNull();
  });

  it.each([['self', false], ['platform admin', false], ['self', true], ['platform admin', true]] as const)('account deletion (%s, user tenant=%s) preserves foreign holdings in owned Apps', async (kind, userTenant) => {
    const f = await fixture(true, userTenant);
    const own = await db.memory.create({ data: { name: 'Own', urn: 'retention.test:own', organizationId: f.org.id, appId: f.app.id, userMemoryOfAgentId: f.agent.id, userId: f.actor.id, class: 'private' } });
    const admin = kind === 'self' ? f.actor : await db.user.create({ data: { handle: 'deleter-admin', roles: ['ADMIN'] } });
    await resolvers.Mutation.deleteUser({}, { userRef: f.actor.id, reason: 'test erasure' }, { db, userId: admin.id, roles: ['ADMIN'] });
    await assertPreserved(f);
    expect(purgeCollectedAssetObjects).toHaveBeenCalled();
    for (const [collected] of vi.mocked(purgeCollectedAssetObjects).mock.calls) {
      for (const { asset } of f.memories) expect(collected.keys).not.toContain(asset.storageKey);
    }
    expect(await db.memory.findUnique({ where: { id: own.id } })).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: f.actor.id } })).deletedAt).not.toBeNull();
  });
});

it('dependency reclamation rechecks the key before detaching or deleting retained data', async () => {
  const f = await fixture();
  const dependency = await db.agent.create({ data: { name: 'Dependency', urn: 'retention.test:retention', organizationId: f.org.id } });
  await db.agentOrgGrant.create({ data: { orgId: f.org.id, agentId: dependency.id, activatedAt: new Date() } });
  await db.agentImport.create({ data: { parentAgentId: f.agent.id, importedAgentId: dependency.id, required: true, position: 0, agentOrgGrantOrgId: f.org.id, agentOrgGrantAgentId: dependency.id } });
  const node = await db.node.create({ data: { memoryId: f.scratch.id, loc: 'retained', name: 'Retained', content: 'Retained source' } });
  const revision = await db.nodeRevision.create({ data: { nodeId: node.id, memoryId: f.scratch.id, loc: node.loc, name: node.name, content: 'Retained history', revNo: 0 } });
  const key = await db.userApiKey.create({ data: { userId: f.actor.id, keyHash: 'dependency-reclaim-key', keyPreview: 'test', oauthScopes: [] } });
  const original = db.app.findFirst.bind(db.app);
  let revoked = false;
  const lookup = vi.spyOn(db.app, 'findFirst').mockImplementation((async (args: any) => {
    const row = await original(args);
    if (!revoked && args?.where?.urn === f.app.urn && row?.id === f.app.id) {
      revoked = true;
      await resolvers.Mutation.revokeUserApiKey(null, { id: key.id }, { db, userId: f.actor.id, roles: ['ADMIN'] });
    }
    return row;
  }) as typeof db.app.findFirst);
  try {
    await expect(resolvers.Mutation.createApp({}, { orgRef: f.org.id, agentRef: f.agent.id, name: 'Parent', urn: 'parent' }, { db, userId: f.actor.id, roles: ['ADMIN'], apiKeyId: key.id }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  } finally { lookup.mockRestore(); }
  expect(revoked).toBe(true);
  expect(await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).toEqual(f.app);
  expect(await db.memory.findUniqueOrThrow({ where: { id: f.scratch.id } })).toEqual(f.scratch);
  expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toEqual(node);
  expect(await db.nodeRevision.findUniqueOrThrow({ where: { id: revision.id } })).toEqual(revision);
  for (const { memory } of f.memories) expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toEqual(memory);
});
