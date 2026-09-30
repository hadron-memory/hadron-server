import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

let owner: { id: string };
let receiver: { id: string };
let outsider: { id: string };
let org: { id: string; urn: string };
let memory: { id: string; urn: string };
let node: { id: string; loc: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const transfer = (input: Record<string, unknown>, userId = owner.id) =>
  resolvers.Mutation.transferMemoryOwnership(null, input as never, ctx(userId));

beforeEach(async () => {
  await cleanDb(db);
  owner = await db.user.create({ data: { id: generateId(), githubId: 147601, githubUsername: 'transfer-owner', handle: 'transfer-owner', roles: ['READER'] } });
  receiver = await db.user.create({ data: { id: generateId(), githubId: 147602, githubUsername: 'transfer-receiver', handle: 'transfer-receiver', roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 147603, githubUsername: 'transfer-outsider', handle: 'transfer-outsider', roles: ['READER'] } });
  org = await db.organization.create({ data: { id: generateId(), name: 'Transfer Org', urn: 'transfer-org' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  memory = await db.memory.create({ data: {
    id: generateId(), ownerUserId: owner.id, userId: owner.id,
    urn: 'transfer-owner:specs', name: 'Specs', class: 'private', corpusDraft: false,
  } });
  node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'cor:spc:020:01', name: 'Rule', content: 'Permanent citation', tags: [] } });
});

describe('transferMemoryOwnership', () => {
  it('previews without writes, then moves a minted corpus and preserves old citations and an audit log', async () => {
    const input = { memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' };
    const preview = await transfer({ ...input, dryRun: true });
    expect(preview).toMatchObject({
      oldUrn: memory.urn, newUrn: `${org.urn}:specs`, targetClass: 'knowledge',
      canApply: true, applied: false,
    });
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).urn).toBe(memory.urn);
    expect(await db.memoryLogEntry.count({ where: { memoryId: memory.id } })).toBe(0);

    const result = await transfer({ ...input, expectedNewUrn: preview.newUrn });
    expect(result.applied).toBe(true);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: null, organizationId: org.id, userId: null,
      class: 'knowledge', visibility: 'ORGANIZATION', urn: `${org.urn}:specs`, legacyUrn: memory.urn,
    });
    expect((await resolveMemoryRef(db, `hrn:mem:${memory.urn}`)).id).toBe(memory.id);
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
    expect(await db.memoryLogEntry.findFirst({ where: { memoryId: memory.id, eventType: 'OTHER' } })).toMatchObject({
      detail: expect.objectContaining({ oldUrn: memory.urn, newUrn: `${org.urn}:specs`, fromOwner: owner.id, toOwner: org.id, actorId: owner.id }),
    });
  });

  it('requires source access before revealing destination or dependent details', async () => {
    const input = { memoryRef: memory.id, orgRef: 'nonexistent-org', targetClass: 'knowledge', dryRun: true };
    await expect(transfer(input, outsider.id)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    const oldUrn = memory.urn;
    await expect(transfer({ ...input, memoryRef: `hrn:mem:${oldUrn}` }, outsider.id)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
  });

  it('requires administration of the destination and a class conversion', async () => {
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, dryRun: true })).resolves.toMatchObject({
      canApply: false, blockers: expect.arrayContaining([expect.objectContaining({ code: 'MEMORY_TRANSFER_CLASS_REQUIRED' })]),
    });
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: owner.id } });
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toThrow('Forbidden');
  });

  it('refuses encrypted and attached memories with typed preview blockers', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ENCRYPTED_MEMORY_TRANSFER_UNSUPPORTED' })]));
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toMatchObject({ extensions: { code: 'ENCRYPTED_MEMORY_TRANSFER_UNSUPPORTED' } });
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: false } });
    await db.memoryShare.create({ data: { memoryId: memory.id, granteeId: receiver.id, grantorId: owner.id, role: 'reader' } });
    const attached = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(attached.dependents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Memory shares', count: 1, handling: 'REFUSE' })]));
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_DEPENDENTS' } });
  });

  it('re-roots on collision and rejects a stale preview', async () => {
    await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:specs`, name: 'Existing', class: 'knowledge', visibility: 'ORGANIZATION' } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(preview.newUrn).not.toBe(`${org.urn}:specs`);
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', expectedNewUrn: `${org.urn}:specs` })).rejects.toMatchObject({ extensions: { code: 'STALE_TRANSFER_PREVIEW' } });
    const result = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', expectedNewUrn: preview.newUrn });
    expect(result.newUrn).toBe(preview.newUrn);
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
  });

  it('preserves a prior legacy spelling when transferring an already renamed memory', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { legacyUrn: 'transfer-owner:old-specs' } });
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    expect((await resolveNodeRef(db, `hrn:node:transfer-owner:old-specs:${node.loc}`)).id).toBe(node.id);
  });

  it('allows a platform admin to move a private memory to another user', async () => {
    const result = await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, userRef: receiver.id,
    }, { db, userId: outsider.id, roles: ['ADMIN'] });
    expect(result.newUrn).toBe('transfer-receiver:specs');
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: receiver.id, organizationId: null, userId: receiver.id, class: 'private',
    });
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
  });

  it('can move org ownership back to a user while preserving both former roots', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, userRef: receiver.id, targetClass: 'private',
    }, { db, userId: outsider.id, roles: ['ADMIN'] });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: receiver.id, organizationId: null, userId: receiver.id,
      urn: 'transfer-receiver:specs', class: 'private',
    });
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
    expect((await resolveNodeRef(db, `hrn:node:${org.urn}:specs:${node.loc}`)).id).toBe(node.id);
  });

  it('lets account erasure finish after an owned corpus is handed to a surviving org', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: receiver.id, role: 'OWNER' } });
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    await resolvers.Mutation.deleteUser(null, {}, ctx(owner.id));
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).organizationId).toBe(org.id);
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
  });

  it('bootstraps the receiving group owner when converting an unshared memory', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ class: 'group', visibility: 'GROUP' });
    expect(await db.memoryMember.findUniqueOrThrow({ where: { memoryId_userId: { memoryId: memory.id, userId: owner.id } } })).toMatchObject({ role: 'owner' });
  });

  it('requires an explicit member reset to transfer a valid group memory', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    await db.memoryMember.create({ data: { memoryId: memory.id, userId: receiver.id, role: 'reader' } });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Next', urn: 'next-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: nextOrg.id, userId: owner.id, role: 'ADMIN' } });
    // A group owner-member left behind after org departure is not an org
    // administrator and cannot rehome the org's memory.
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: owner.id } });
    const input = { memoryRef: memory.id, orgRef: nextOrg.id };
    await expect(transfer({ ...input, resetGroupMembers: true })).rejects.toThrow('Forbidden');
    await expect(transfer({
      memoryRef: memory.id, userRef: owner.id, targetClass: 'private', resetGroupMembers: true,
    })).rejects.toThrow('Forbidden');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
    const blocked = await transfer({ ...input, dryRun: true });
    expect(blocked.canApply).toBe(false);
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MEMORY_TRANSFER_DEPENDENTS', message: expect.stringContaining('resetGroupMembers') }),
    ]));
    const preview = await transfer({ ...input, resetGroupMembers: true, dryRun: true });
    expect(preview.canApply).toBe(true);
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Memory members', count: 2, handling: 'REMOVE' }),
      expect.objectContaining({ kind: 'Receiving group owner', count: 1, handling: 'CREATE' }),
    ]));
    await transfer({ ...input, resetGroupMembers: true, expectedNewUrn: preview.newUrn });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      organizationId: nextOrg.id, urn: `${nextOrg.urn}:specs`, class: 'group', visibility: 'GROUP',
    });
    expect(await db.memoryMember.findMany({ where: { memoryId: memory.id } })).toMatchObject([
      { userId: owner.id, role: 'owner' },
    ]);
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
  });

  it('honors a live memory.delete grant for the source org, but never a revoked membership', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Grant Target', urn: 'grant-target' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: nextOrg.id, userId: owner.id, role: 'ADMIN' } });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: owner.id }, data: { role: 'CONTRIBUTOR' } });
    const grant = await db.principalGrant.create({ data: {
      id: generateId(), principalType: 'USER', principalId: owner.id,
      organizationId: org.id, actions: ['memory.delete'],
    } });
    const input = { memoryRef: memory.id, orgRef: nextOrg.id, dryRun: true };
    await expect(transfer(input)).resolves.toMatchObject({ canApply: true });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: owner.id }, data: { deletedAt: new Date() } });
    await expect(transfer(input)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: owner.id }, data: { deletedAt: null } });
    await db.principalGrant.update({ where: { id: grant.id }, data: { deletedAt: new Date() } });
    await expect(transfer(input)).rejects.toThrow('Forbidden');
  });

  it('revokes group members when converting a group to a user-owned private memory', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    await db.memoryMember.create({ data: { memoryId: memory.id, userId: receiver.id, role: 'reader' } });
    const result = await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, userRef: receiver.id, targetClass: 'private', resetGroupMembers: true,
    }, { db, userId: outsider.id, roles: ['ADMIN'] });
    expect(result.applied).toBe(true);
    expect(await db.memoryMember.count({ where: { memoryId: memory.id } })).toBe(0);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      organizationId: null, ownerUserId: receiver.id, userId: receiver.id, class: 'private', visibility: null,
    });
  });

  it('refuses to carry git provenance into a new owner', async () => {
    await db.node.update({ where: { id: node.id }, data: { ownerRepo: 'old-owner/specs' } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Node mirror provenance', count: 1, handling: 'REFUSE' }),
    ]));
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_DEPENDENTS' } });
  });

  it('reports durable trigger URNs as dependents before changing their owner scope', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Next', urn: 'next-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: nextOrg.id, userId: owner.id, role: 'ADMIN' } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'App' } });
    const olderUrn = 'transfer-owner:older-specs';
    await recordUrnRename(db, { entityType: 'MEMORY', entityId: memory.id, oldUrn: olderUrn, newUrn: `${org.urn}:specs` });
    await db.agentSchedule.create({ data: {
      id: generateId(), organizationId: org.id, appId: app.id, name: 'Nightly',
      runAt: new Date('2030-01-01T00:00:00Z'), entryNodeUrn: `hrn:node:${olderUrn}:${node.loc}`, enabled: false,
    } });
    const foreignApp = await db.app.create({ data: { id: generateId(), organizationId: nextOrg.id, urn: `${nextOrg.urn}:app`, name: 'Foreign App' } });
    await db.agentSchedule.create({ data: {
      id: generateId(), organizationId: nextOrg.id, appId: foreignApp.id, name: 'Foreign',
      runAt: new Date('2030-01-01T00:00:00Z'), entryNodeUrn: `hrn:node:${olderUrn}:${node.loc}`,
    } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: nextOrg.id, dryRun: true });
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Schedules', count: 1, handling: 'REFUSE' }),
    ]));
  });

  it('closes updateMemory’s original org-to-org owner-change path', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'Other', urn: 'other-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: owner.id, role: 'ADMIN' } });
    await expect(resolvers.Mutation.updateMemory(null, { id: memory.id, organizationId: otherOrg.id }, ctx(owner.id))).rejects.toMatchObject({ extensions: { code: 'USE_TRANSFER_MEMORY_OWNERSHIP' } });
  });

  it('rejects owner change through updateMemory', async () => {
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'Other', urn: 'other-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: owner.id, role: 'ADMIN' } });
    await expect(resolvers.Mutation.updateMemory(null, { id: memory.id, organizationId: otherOrg.id }, ctx(owner.id))).rejects.toMatchObject({ extensions: { code: 'USE_TRANSFER_MEMORY_OWNERSHIP' } });
  });
});
