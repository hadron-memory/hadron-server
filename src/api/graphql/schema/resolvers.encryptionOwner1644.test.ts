/** #1644: encryption transitions retain strict ownership (cor:acl:010:02, DT). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateDataKey, parseDataKey } from '../../../lib/crypto.js';
import { isAuthenticatedStringEnvelope } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
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

  it('encrypted promotion cannot be used on a registered private holding', async () => {
    const agent = await db.agent.create({ data: { name: 'Registered agent', urn: 'enc-owner.test:registered-agent', organizationId: orgId } });
    await db.memory.update({ where: { id: memoryId }, data: { appId, userMemoryOfAgentId: agent.id } });
    const before = await snapshot();
    const usersBefore = await db.user.count();
    await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'new-user', dataKey: generateDataKey().raw.toString('base64') }, { db, appId, roles: [] }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await snapshot()).toEqual(before);
    expect(await db.user.count()).toBe(usersBefore);
  });

  it('anonymous encrypted promotion stays within its own App, not a sibling in the same org', async () => {
    const agent = await db.agent.create({ data: { name: 'Anonymous agent', urn: 'enc-owner.test:anon-agent', organizationId: orgId } });
    const anon = await db.memory.create({ data: { name: 'Anonymous', urn: 'enc-owner.test:anon', organizationId: orgId, appId, userMemoryOfAgentId: agent.id, class: 'app' } });
    const before = await db.memory.findUniqueOrThrow({ where: { id: anon.id } });
    const usersBefore = await db.user.count();
    await expect(resolvers.Mutation.linkMemoryToUser({}, { memoryId: anon.id, externalUserId: 'sibling-user', dataKey }, { db, appId: otherAppId, roles: [] }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.memory.findUniqueOrThrow({ where: { id: anon.id } })).toEqual(before);
    expect(await db.user.count()).toBe(usersBefore);
  });
});
