/** #1644: encryption transitions retain strict ownership (cor:acl:010:02, DT). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateDataKey, parseDataKey } from '../../../lib/crypto.js';
import { makeKeyVerifier } from '../../../lib/memoryUnlock.js';
import { isAuthenticatedStringEnvelope } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { memoryMutations } from './resolvers.mutation.memory.js';
import { generateId } from '../../../lib/id.js';

let orgId: string;
let ownerId: string;
let otherId: string;
let appId: string;
let otherAppId: string;
let memoryId: string;
let nodeId: string;
let sessionId: string;
const dataKey = Buffer.alloc(32, 17).toString('base64');

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { name: 'Encryption owner', urn: 'enc-owner.test' } });
  orgId = org.id;
  const owner = await db.user.create({ data: { handle: 'enc-owner', roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: 'enc-admin', roles: ['READER'] } });
  ownerId = owner.id;
  otherId = other.id;
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: ownerId, role: 'READER' },
    { organizationId: org.id, userId: otherId, role: 'ADMIN' },
  ] });
  const app = await db.app.create({ data: { name: 'Owner App', urn: 'enc-owner.test:app', organizationId: org.id } });
  appId = app.id;
  const otherApp = await db.app.create({ data: { name: 'Sibling App', urn: 'enc-owner.test:sibling', organizationId: org.id } });
  otherAppId = otherApp.id;
  await db.appMember.create({ data: { appId, userId: otherId, role: 'member' } });
  const memory = await db.memory.create({ data: { name: 'Private', urn: 'enc-owner.test:private', class: 'private', organizationId: org.id, userId: ownerId } });
  memoryId = memory.id;
  const node = await db.node.create({ data: { memoryId, loc: 'note', name: 'Note', content: 'current private note', abstract: 'private abstract', data: { value: 'private data' } } });
  nodeId = node.id;
  await db.nodeRevision.create({ data: { nodeId, memoryId, loc: 'note', name: 'Note', content: 'historical private note' } });
  const session = await db.session.create({ data: { id: generateId(), appId, userId: ownerId, memoryId } });
  sessionId = session.id;
});

/** Ciphertext and key metadata must stay unchanged when authority is refused. */
async function snapshot() {
  return {
    memory: await db.memory.findUniqueOrThrow({ where: { id: memoryId } }),
    node: await db.node.findUniqueOrThrow({ where: { id: nodeId } }),
    revisions: await db.nodeRevision.findMany({ where: { nodeId }, orderBy: { id: 'asc' } }),
  };
}

const ownerCtx = (overrides: Partial<Context> = {}): Context => ({ db, userId: ownerId, roles: ['READER'], ...overrides });

describe('#1644 encryption authority', () => {
  it.each(['same-org App key', 'bound App key', 'sibling App key', 'org admin', 'platform admin', 'App member', 'impersonated owner'])('%s cannot convert a registered private memory', async kind => {
    const callers: Record<string, Context> = {
      'same-org App key': { db, appId, roles: [] },
      'bound App key': { db, appId, sessionId, roles: [] },
      'sibling App key': { db, appId: otherAppId, roles: [] },
      'org admin': { db, userId: otherId, roles: ['READER'] },
      'platform admin': { db, userId: otherId, roles: ['ADMIN'] },
      'App member': { db, userId: otherId, appId, roles: ['READER'] },
      'impersonated owner': ownerCtx({ impersonation: { orgId, actorUserId: otherId } as Context['impersonation'] }),
    };
    const before = await snapshot();
    await expect(resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, callers[kind]))
      .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await snapshot()).toEqual(before);
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });

  it.each(['plain owner', 'owner with App selection', 'owner with platform role'])('%s can encrypt and complete history under the same key', async kind => {
    const ctx = ownerCtx(kind === 'owner with App selection' ? { appId: otherAppId } : kind === 'owner with platform role' ? { roles: ['ADMIN'] } : {});
    const result = await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ctx);
    expect(result).toMatchObject({ userId: ownerId, isEncrypted: true });
    const key = parseDataKey(dataKey);
    const after = await snapshot();
    expect(isAuthenticatedStringEnvelope(after.node.content, key)).toBe(true);
    expect(isAuthenticatedStringEnvelope(after.node.abstract, key)).toBe(true);
    for (const revision of after.revisions) expect(isAuthenticatedStringEnvelope(revision.content, key)).toBe(true);
    const beforeCompletion = await snapshot();
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ctx);
    expect(await snapshot()).toEqual(beforeCompletion);
  });

  it('an App key cannot complete registered encrypted history, even with the correct key', async () => {
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    const before = await snapshot();
    await expect(resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, { db, appId, roles: [] }))
      .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await snapshot()).toEqual(before);
  });

  it.each([false, true])('owner changes after preflight; locked encryption recheck refuses (already encrypted=%s)', async encrypted => {
    if (encrypted) await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    const before = await snapshot();
    const original = db.memory.findUniqueOrThrow.bind(db.memory);
    let changed = false;
    const read = vi.spyOn(db.memory, 'findUniqueOrThrow').mockImplementation((async (args: any) => {
      const row = await original(args);
      if (!changed && args.where.id === memoryId) {
        changed = true;
        await db.memory.update({ where: { id: memoryId }, data: { userId: otherId } });
      }
      return row;
    }) as typeof db.memory.findUniqueOrThrow);
    try {
      await expect(resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx())).rejects.toThrow();
    } finally { read.mockRestore(); }
    expect(changed).toBe(true);
    const after = await snapshot();
    expect(after.memory).toMatchObject({ userId: otherId, isEncrypted: before.memory.isEncrypted, keyVerifier: before.memory.keyVerifier, kdfSalt: before.memory.kdfSalt, kdfParams: before.memory.kdfParams });
    expect(after.node).toEqual(before.node);
    expect(after.revisions).toEqual(before.revisions);
  });

  it.each([undefined, dataKey])('promotion cannot be used on a registered private holding (key=%s)', async promotionKey => {
    const agent = await db.agent.create({ data: { name: 'Registered agent', urn: 'enc-owner.test:registered-agent', organizationId: orgId } });
    await db.memory.update({ where: { id: memoryId }, data: { appId, userMemoryOfAgentId: agent.id } });
    const before = await snapshot();
    const usersBefore = await db.user.count();
    await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'new-user', dataKey: promotionKey }, { db, appId, roles: [] }))
      .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await snapshot()).toEqual(before);
    expect(await db.user.count()).toBe(usersBefore);
  });

  it.each([undefined, dataKey])('anonymous promotion stays within its own App (key=%s)', async promotionKey => {
    const agent = await db.agent.create({ data: { name: 'Anonymous agent', urn: 'enc-owner.test:anon-agent', organizationId: orgId } });
    const anon = await db.memory.create({ data: { name: 'Anonymous', urn: 'enc-owner.test:anon', organizationId: orgId, appId, userMemoryOfAgentId: agent.id, anonymousExpiresAt: new Date(Date.now() + 86400000), class: 'app' } });
    const before = await db.memory.findUniqueOrThrow({ where: { id: anon.id } });
    const usersBefore = await db.user.count();
    await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId: anon.id, externalUserId: 'sibling-user', dataKey: promotionKey }, { db, appId: otherAppId, roles: [] }))
      .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await db.memory.findUniqueOrThrow({ where: { id: anon.id } })).toEqual(before);
    expect(await db.user.count()).toBe(usersBefore);
  });
  it.each(['owner', 'key'])('conversion refuses a changed %s before writing enumerated nodes', async change => {
    await db.memory.update({ where: { id: memoryId }, data: {
      isEncrypted: true, keyVerifier: makeKeyVerifier(parseDataKey(dataKey)),
    } });
    const before = await snapshot();
    const original = db.node.findMany.bind(db.node);
    let changed = false;
    const scan = vi.spyOn(db.node, 'findMany').mockImplementation((async (args: any) => {
      const rows = await original(args);
      if (!changed && args.where.memoryId === memoryId) {
        changed = true;
        await db.memory.update({ where: { id: memoryId }, data: change === 'owner'
          ? { userId: otherId } : { keyVerifier: makeKeyVerifier(generateDataKey()) } });
      }
      return rows;
    }) as typeof db.node.findMany);
    try {
      await expect(resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx())).rejects.toThrow();
    } finally { scan.mockRestore(); }
    expect(changed).toBe(true);
    const after = await snapshot();
    if (change === 'owner') expect(after.memory.userId).toBe(otherId);
    else expect(after.memory.keyVerifier).not.toBe(before.memory.keyVerifier);
    expect(after.node).toEqual(before.node);
    expect(after.revisions).toEqual(before.revisions);
  });

  it.each([[undefined, 'app'], [dataKey, 'app'], [undefined, 'expiry'], [dataKey, 'expiry']] as const)('promotion rechecks anonymous scope under its transaction lock (key=%s, change=%s)', async (promotionKey, change) => {
    const agent = await db.agent.create({ data: { name: 'Race agent', urn: 'enc-owner.test:race-agent', organizationId: orgId } });
    const anon = await db.memory.create({ data: { name: 'Race anonymous', urn: 'enc-owner.test:race', organizationId: orgId, appId, userMemoryOfAgentId: agent.id, anonymousExpiresAt: new Date(Date.now() + 86400000), class: 'app' } });
    const original = db.memory.findUniqueOrThrow.bind(db.memory);
    let changed = false;
    const read = vi.spyOn(db.memory, 'findUniqueOrThrow').mockImplementation((async (args: any) => {
      const row = await original(args);
      if (!changed && args.where.id === anon.id) {
        changed = true;
        await db.memory.update({ where: { id: anon.id }, data: change === 'app' ? { appId: otherAppId } : { anonymousExpiresAt: null } });
      }
      return row;
    }) as typeof db.memory.findUniqueOrThrow);
    try {
      await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId: anon.id, externalUserId: 'race-user', dataKey: promotionKey }, { db, appId, roles: [] }))
        .rejects.toMatchObject({ extensions: { code: 'MEMORY_WRITE_CONFLICT' } });
    } finally { read.mockRestore(); }
    expect(await db.memory.findUniqueOrThrow({ where: { id: anon.id } })).toMatchObject({
      urn: anon.urn, appId: change === 'app' ? otherAppId : appId,
      anonymousExpiresAt: change === 'expiry' ? null : anon.anonymousExpiresAt,
      userId: null, isEncrypted: false, keyVerifier: null,
    });
  });

  it('an ownerless anonymous memory never grants public encryption to an App key', async () => {
    const anon = await db.memory.create({ data: { name: 'Ownerless', urn: 'enc-owner.test:ownerless', organizationId: orgId, appId, class: 'app' } });
    await expect(resolvers.Mutation.encryptMemory({}, { memoryId: anon.id, dataKey }, { db, appId, roles: [] }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.memory.findUniqueOrThrow({ where: { id: anon.id } })).toEqual(anon);
  });

  it('a committed promotion requires owner-authenticated recovery after interrupted completion', async () => {
    const agent = await db.agent.create({ data: { name: 'Recovery agent', urn: 'enc-owner.test:recovery-agent', organizationId: orgId } });
    await db.memory.update({ where: { id: memoryId }, data: { class: 'app', userId: null, appId, userMemoryOfAgentId: agent.id, anonymousExpiresAt: new Date(Date.now() + 86400000) } });
    const completion = vi.spyOn(memoryMutations, 'encryptMemory').mockRejectedValueOnce(new Error('ENCRYPTION_INCOMPLETE'));
    try {
      await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'recovery-owner', dataKey }, { db, appId, roles: [] }))
        .rejects.toThrow('ENCRYPTION_INCOMPLETE');
    } finally { completion.mockRestore(); }
    const claimed = await snapshot();
    expect(claimed.memory.isEncrypted).toBe(true);
    expect(claimed.memory.userId).toBeTruthy();
    await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'recovery-owner', dataKey }, { db, appId, roles: [] }))
      .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await snapshot()).toEqual(claimed);
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx({ userId: claimed.memory.userId! }));
    const recovered = await snapshot();
    for (const revision of recovered.revisions) expect(isAuthenticatedStringEnvelope(revision.content, parseDataKey(dataKey))).toBe(true);
  });

  it('a plaintext-linked holding cannot be linked again to another external user', async () => {
    const agent = await db.agent.create({ data: { name: 'Link once agent', urn: 'enc-owner.test:link-once', organizationId: orgId } });
    await db.memory.update({ where: { id: memoryId }, data: {
      class: 'app', userId: null, appId, userMemoryOfAgentId: agent.id,
      anonymousExpiresAt: new Date(Date.now() + 86400000),
    } });
    const linked = await resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'first-owner' }, { db, appId, roles: [] });
    const firstUser = await db.user.findFirstOrThrow({ where: { externalAppId: appId, externalId: 'first-owner' } });
    expect(linked).toMatchObject({ createdBy: firstUser.id, anonymousExpiresAt: null, class: 'app', userId: null });
    const before = await snapshot();
    const usersBefore = await db.user.count();
    await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'second-owner' }, { db, appId, roles: [] }))
      .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await snapshot()).toEqual(before);
    expect(await db.user.count()).toBe(usersBefore);
  });

});
