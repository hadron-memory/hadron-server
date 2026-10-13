/** #1807: keep the mapped record, subscription and audit gates aligned. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';
import { requireMemoryWriteAccess } from './resolvers.helpers.js';
import { systemMemoryReadGrants } from '../../../lib/auth/systemMemoryRead.js';
import { getMemoryAccess } from '../../../mcp/access-control.js';

let orgId: string, memoryId: string, agentId: string, appId: string;
let readerId: string, participantId: string, managerId: string, foreignId: string, foreignOrgId: string;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const record = (userId: string) => resolvers.Query.memory({}, { ref: memoryId }, ctx(userId));
const audit = (userId: string) => resolvers.Query.effectiveAccess({}, { user: userId, resource: 'hrn:mem:read1807.test:system' }, ctx(managerId));

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Read fixture', urn: 'read1807.test' } });
  orgId = org.id;
  foreignOrgId = (await db.organization.create({ data: { name: 'Foreign', urn: 'foreign1807.test' } })).id;
  const createUser = async (handle: string) => (await db.user.create({ data: { handle, roles: ['READER'] } })).id;
  readerId = await createUser('read1807-reader');
  participantId = await createUser('read1807-participant');
  managerId = await createUser('read1807-manager');
  foreignId = await createUser('read1807-foreign');
  for (const userId of [readerId, participantId]) await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: managerId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: foreignOrgId, userId: foreignId, role: 'READER' } });
  memoryId = (await db.memory.create({ data: { name: 'System fixture', urn: 'read1807.test:system', organizationId: orgId, class: 'system' } })).id;
  agentId = (await db.agent.create({ data: { name: 'Agent fixture', urn: 'read1807.test:agent', organizationId: orgId, systemMemoryId: memoryId } })).id;
  appId = (await db.app.create({ data: { name: 'App fixture', urn: 'read1807.test:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId: participantId, role: 'member' } });
});

describe('#1807 mapped read gates', () => {
  it('conceals the record from a nonparticipating org reader', async () => { expect(await record(readerId)).toBeNull(); });
  it('retains an installed and licensed participant record read', async () => { expect((await record(participantId))?.id).toBe(memoryId); });
  it('retains the owning Agent manager record read', async () => { expect((await record(managerId))?.id).toBe(memoryId); });
  it('stops the participant record read after uninstall', async () => {
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
    expect(await record(participantId)).toBeNull();
  });
  it('does not admit an invalid legacy system subscription on either shared surface', async () => {
    await db.memorySubscription.create({ data: { memoryId, organizationId: foreignOrgId, role: 'READER', activated: true } });
    expect(await getOrgReadableMemoryIds(db, foreignId)).not.toContain(memoryId);
    expect((await getMemoryAccess(db, { userId: foreignId, roles: ['READER'] })).has(memoryId)).toBe(false);
    const ordinary = await db.memory.create({ data: { name: 'Ordinary', urn: 'read1807.test:ordinary', organizationId: orgId, class: 'knowledge', visibility: 'PUBLIC' } });
    await db.memorySubscription.create({ data: { memoryId: ordinary.id, organizationId: foreignOrgId, role: 'READER', activated: true } });
    expect(await getOrgReadableMemoryIds(db, foreignId)).toContain(ordinary.id);
  });
  it('reports no public or other read grant for an unrelated reader', async () => {
    const result = await audit(readerId);
    expect(result.canRead).toBe(false);
    expect(result.grants).toEqual([]);
  });
  it('conceals the self-audit for a reader who cannot open the record', async () => {
    await expect(resolvers.Query.effectiveAccess({}, { user: readerId, resource: 'hrn:mem:read1807.test:system' }, ctx(readerId)))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
  it('reports the participant actual read grant without editing rights', async () => {
    const result = await audit(participantId);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
    expect(result.grants.some(g => g.source === 'APP_MEMBER')).toBe(true);
    expect(result.grants.some(g => g.source === 'PUBLIC_VISIBILITY')).toBe(false);
  });
  it('reports the Agent manager actual read grant', async () => {
    const result = await audit(managerId);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
    await expect(requireMemoryWriteAccess(ctx(managerId), memoryId)).resolves.toBeUndefined();
    expect(result.grants.some(g => g.source === 'ORG_ROLE')).toBe(true);
    expect(result.grants.some(g => g.source === 'PUBLIC_VISIBILITY')).toBe(false);
  });
  it('revoking an install licence removes cross-org participant access', async () => {
    const foreignApp = await db.app.create({ data: { name: 'Foreign app', urn: 'foreign1807.test:app', organizationId: foreignOrgId } });
    await db.appAgent.create({ data: { appId: foreignApp.id, agentId } });
    await db.appMember.create({ data: { appId: foreignApp.id, userId: foreignId, role: 'member' } });
    await db.agentOrgGrant.create({ data: { orgId: foreignOrgId, agentId, activatedAt: new Date() } });
    expect((await record(foreignId))?.id).toBe(memoryId);
    expect((await audit(foreignId)).canRead).toBe(true);
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: foreignOrgId, agentId } }, data: { revokedAt: new Date() } });
    expect(await record(foreignId)).toBeNull();
    expect((await audit(foreignId)).canRead).toBe(false);
  });

  it('revoked management membership gives no record or reported grant', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: managerId } }, data: { deletedAt: new Date() } });
    expect(await record(managerId)).toBeNull();
    // A still-authorized manager audits the former manager.
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: readerId } }, data: { role: 'ADMIN' } });
    const result = await resolvers.Query.effectiveAccess({}, { user: managerId, resource: 'hrn:mem:read1807.test:system' }, ctx(readerId));
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
    expect(result.grants).toEqual([]);
  });

  it('a retired Agent pointer gives no participant read', async () => {
    await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    expect(await record(participantId)).toBeNull();
  });

  it('retains a licensed App read within the impersonation scope', async () => {
    const scoped = { ...ctx(participantId), appId, impersonation: { orgId } } as Context;
    expect((await resolvers.Query.memory({}, { ref: memoryId }, scoped))?.id).toBe(memoryId);
  });

  it('reports the existing owner write caps for a user-owned Agent system memory', async () => {
    const owned = await db.memory.create({ data: { name: 'Owned system', urn: 'read1807.test:owned-system', ownerUserId: readerId, class: 'system' } });
    await db.agent.create({ data: { name: 'Owned Agent', urn: 'read1807.test:owned-agent', ownerUserId: readerId, systemMemoryId: owned.id } });
    await expect(requireMemoryWriteAccess(ctx(readerId), owned.id)).resolves.toBeUndefined();
    const result = await resolvers.Query.effectiveAccess({}, { user: readerId, resource: 'hrn:mem:read1807.test:owned-system' }, ctx(readerId));
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
    expect(result.grants.some(g => g.source === 'MEMORY_PRINCIPAL' && g.role === 'owner')).toBe(true);
    const denied = await resolvers.Query.effectiveAccess({}, { user: foreignId, resource: 'hrn:mem:read1807.test:owned-system' }, ctx(readerId));
    expect(denied.canRead).toBe(false);
    expect(denied.canWrite).toBe(false);
  });

  it('does not honor a legacy PUBLIC system row while ordinary PUBLIC reads remain available', async () => {
    const rollback = new Error('rollback legacy fixture');
    await expect(db.$transaction(async tx => {
      // CHECK-invalid historical state is confined to this rollback.
      await tx.$executeRawUnsafe('ALTER TABLE memories DROP CONSTRAINT chk_memory_visibility_class');
      await tx.memory.update({ where: { id: memoryId }, data: { visibility: 'PUBLIC' } });
      const ordinary = await tx.memory.create({ data: { name: 'Public control', urn: 'read1807.test:public-control', organizationId: orgId, class: 'knowledge', visibility: 'PUBLIC' } });
      const readable = await getOrgReadableMemoryIds(tx as unknown as typeof db, foreignId);
      expect(readable).not.toContain(memoryId);
      expect(readable).toContain(ordinary.id);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it('reports platform manager writes already allowed by the write gate', async () => {
    await db.user.update({ where: { id: foreignId }, data: { roles: ['ADMIN'] } });
    await expect(requireMemoryWriteAccess({ ...ctx(foreignId), roles: ['ADMIN'] }, memoryId)).resolves.toBeUndefined();
    const result = await audit(foreignId);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
    expect(result.grants.some(g => g.source === 'PLATFORM_ROLE')).toBe(true);
  });

  it('reports licensed App read grants under impersonation only inside its org', async () => {
    const scoped = { ...ctx(participantId), appId, impersonation: { orgId } } as Context;
    const result = await resolvers.Query.effectiveAccess({}, { user: participantId, resource: 'hrn:mem:read1807.test:system' }, scoped);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
    expect(result.grants.some(g => g.source === 'APP_MEMBER')).toBe(true);
    expect(await systemMemoryReadGrants(db, { userId: participantId, impersonation: { orgId: foreignOrgId } }, memoryId)).toEqual([]);
  });

  it('rejects a mismatched Agent tenant pointer', async () => {
    await db.agent.update({ where: { id: agentId }, data: { organizationId: foreignOrgId } });
    expect(await record(participantId)).toBeNull();
    expect(await systemMemoryReadGrants(db, ctx(managerId), memoryId)).toEqual([]);
  });

  it('rejects a deleted owning org even for a platform manager', async () => {
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    expect(await systemMemoryReadGrants(db, { userId: foreignId, roles: ['ADMIN'] }, memoryId)).toEqual([]);
  });

});
