/**
 * Integration tests for AgentOrgGrant lifecycle mutations (#649, #651).
 *
 * The mutations are the explicit marketplace "subscribe/unsubscribe
 * organization to Agent" steps; they update AgentOrgGrant without also
 * installing or deleting App state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildSchema, isNonNullType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

const M = resolvers.Mutation as any;

let ownerOrg: { id: string; urn: string };
let subscriberOrg: { id: string; urn: string };
let unrelatedOrg: { id: string; urn: string };
let publicAgent: { id: string; urn: string };
let privateAgent: { id: string; urn: string };
let ownerAdmin: { id: string };
let ownerOwner: { id: string };
let ownerContributor: { id: string };
let subscriberAdmin: { id: string };
let subscriberOwner: { id: string };
let subscriberContributor: { id: string };
let subscriberReader: { id: string };
let unrelatedAdmin: { id: string };

function ctx(userId?: string): Context {
  return { db, userId, roles: ['READER'] };
}

beforeEach(async () => {
  await cleanDb(db);

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  ownerOrg = await db.organization.create({
    data: { id: generateId(), name: 'grant-owner', urn: `grant-owner-${suffix}` },
  });
  subscriberOrg = await db.organization.create({
    data: { id: generateId(), name: 'grant-subscriber', urn: `grant-subscriber-${suffix}` },
  });
  unrelatedOrg = await db.organization.create({
    data: { id: generateId(), name: 'grant-unrelated', urn: `grant-unrelated-${suffix}` },
  });

  ownerAdmin = await db.user.create({
    data: { id: generateId(), githubId: 65101, githubUsername: `grant-owner-admin-${suffix}`, roles: ['READER'] },
  });
  ownerOwner = await db.user.create({
    data: { id: generateId(), githubId: 65102, githubUsername: `grant-owner-owner-${suffix}`, roles: ['READER'] },
  });
  ownerContributor = await db.user.create({
    data: { id: generateId(), githubId: 65103, githubUsername: `grant-owner-contrib-${suffix}`, roles: ['READER'] },
  });
  subscriberAdmin = await db.user.create({
    data: { id: generateId(), githubId: 64901, githubUsername: `grant-admin-${suffix}`, roles: ['READER'] },
  });
  subscriberOwner = await db.user.create({
    data: { id: generateId(), githubId: 64902, githubUsername: `grant-owner-${suffix}`, roles: ['READER'] },
  });
  subscriberReader = await db.user.create({
    data: { id: generateId(), githubId: 64903, githubUsername: `grant-reader-${suffix}`, roles: ['READER'] },
  });
  subscriberContributor = await db.user.create({
    data: { id: generateId(), githubId: 64905, githubUsername: `grant-contrib-${suffix}`, roles: ['READER'] },
  });
  unrelatedAdmin = await db.user.create({
    data: { id: generateId(), githubId: 65104, githubUsername: `grant-unrelated-admin-${suffix}`, roles: ['READER'] },
  });

  await db.orgMember.create({
    data: { id: generateId(), organizationId: ownerOrg.id, userId: ownerAdmin.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: ownerOrg.id, userId: ownerOwner.id, role: 'OWNER' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: ownerOrg.id, userId: ownerContributor.id, role: 'CONTRIBUTOR' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: subscriberOrg.id, userId: subscriberAdmin.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: subscriberOrg.id, userId: subscriberOwner.id, role: 'OWNER' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: subscriberOrg.id, userId: subscriberReader.id, role: 'READER' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: subscriberOrg.id, userId: subscriberContributor.id, role: 'CONTRIBUTOR' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: unrelatedOrg.id, userId: unrelatedAdmin.id, role: 'ADMIN' },
  });

  publicAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: ownerOrg.id,
      urn: `${ownerOrg.urn}:public-agent`,
      name: 'Public Agent',
      visibility: 'PUBLIC',
    },
  });
  privateAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: ownerOrg.id,
      urn: `${ownerOrg.urn}:private-agent`,
      name: 'Private Agent',
      visibility: 'ORGANIZATION',
    },
  });
});

describe('#1551 AgentOrgGrant revocation fence', () => {
  it('revoke waits for an in-flight grant, then deactivates it', async () => {
    let release!: () => void;
    let held!: () => void;
    const holdGate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ${publicAgent.id} FOR UPDATE`;
      held();
      await holdGate;
    }, { timeout: 20_000 });
    await locked;

    const grant = M.createAgentOrgGrant(null, {
      agentRef: publicAgent.id, orgRef: subscriberOrg.id,
    }, ctx(subscriberAdmin.id));
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      let revoked = false;
      const revoke = M.revokeAgentOrgGrant(null, {
        agentRef: publicAgent.id, orgRef: subscriberOrg.id,
      }, ctx(subscriberOwner.id)).then((value: unknown) => { revoked = true; return value; });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(revoked).toBe(false);
      release();
      await holder;
      await grant;
      await revoke;
      expect((await db.agentOrgGrant.findUniqueOrThrow({ where: {
        orgId_agentId: { orgId: subscriberOrg.id, agentId: publicAgent.id },
      } })).revokedAt).not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, grant]);
    }
  });
});

describe('Mutation.createAgentOrgGrant', () => {
  it('is exposed in SDL with ref-style entity arguments', () => {
    const field = buildSchema(typeDefs).getMutationType()?.getFields().createAgentOrgGrant;
    expect(field).toBeDefined();
    expect(field?.args.map((arg) => arg.name)).toEqual(['agentRef', 'orgRef']);
    expect(field?.args.every((arg) => isNonNullType(arg.type))).toBe(true);
  });

  it('subscriber-org ADMIN can subscribe to a foreign PUBLIC Agent', async () => {
    const grant = await M.createAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(subscriberAdmin.id),
    );

    expect(grant.agentId).toBe(publicAgent.id);
    expect(grant.orgId).toBe(subscriberOrg.id);
    expect(grant.activatedAt).toBeInstanceOf(Date);
    expect(grant.revokedAt).toBeNull();
    expect(grant.createdBy).toBe(subscriberAdmin.id);
  });

  it('admits OWNER through the existing role hierarchy', async () => {
    const grant = await M.createAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(subscriberOwner.id),
    );
    expect(grant.agentId).toBe(publicAgent.id);
  });

  it('rejects CONTRIBUTOR, READER, and unauthenticated callers', async () => {
    await expect(
      M.createAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberContributor.id)),
    ).rejects.toThrow('Forbidden');

    await expect(
      M.createAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberReader.id)),
    ).rejects.toThrow('Forbidden');

    await expect(
      M.createAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx()),
    ).rejects.toThrow('Forbidden');
  });

  it('rejects foreign non-public Agents', async () => {
    // #1946: one the subscriber's admin can't read answers as absent (no
    // AGENT_NOT_PUBLIC, no agentId); AGENT_NOT_PUBLIC stays for a reader.
    await expect(
      M.createAgentOrgGrant(null, { agentRef: privateAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  it('rejects the owning org self-subscribe path', async () => {
    const ownerAdmin = await db.user.create({
      data: { id: generateId(), githubId: 64904, githubUsername: 'grant-owner-admin', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: ownerOrg.id, userId: ownerAdmin.id, role: 'ADMIN' },
    });

    await expect(
      M.createAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: ownerOrg.id }, ctx(ownerAdmin.id)),
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'SELF_AGENT_ORG_GRANT' }),
    });
  });

  it('accepts bare URNs and prefixed URNs for both refs', async () => {
    const byBareUrns = await M.createAgentOrgGrant(
      null,
      { agentRef: publicAgent.urn, orgRef: subscriberOrg.urn },
      ctx(subscriberAdmin.id),
    );
    expect(byBareUrns.agentId).toBe(publicAgent.id);

    await db.agentOrgGrant.delete({
      where: { orgId_agentId: { orgId: subscriberOrg.id, agentId: publicAgent.id } },
    });

    const byLegacyPrefixes = await M.createAgentOrgGrant(
      null,
      { agentRef: `urn:agent:${publicAgent.urn}`, orgRef: `urn:org:${subscriberOrg.urn}` },
      ctx(subscriberAdmin.id),
    );
    expect(byLegacyPrefixes.orgId).toBe(subscriberOrg.id);

    await db.agentOrgGrant.delete({
      where: { orgId_agentId: { orgId: subscriberOrg.id, agentId: publicAgent.id } },
    });

    const byCanonicalPrefixes = await M.createAgentOrgGrant(
      null,
      { agentRef: `hrn:agent:${publicAgent.urn}`, orgRef: `hrn:org:${subscriberOrg.urn}` },
      ctx(subscriberAdmin.id),
    );
    expect(byCanonicalPrefixes.agentId).toBe(publicAgent.id);
  });

  it('duplicate concurrent requests produce one grant', async () => {
    const grants = await Promise.all(
      Array.from({ length: 8 }, () =>
        M.createAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
      ),
    );

    expect(grants.every((g) => g.agentId === publicAgent.id && g.orgId === subscriberOrg.id)).toBe(true);
    expect(await db.agentOrgGrant.count({
      where: { orgId: subscriberOrg.id, agentId: publicAgent.id },
    })).toBe(1);
  });

  it('does not silently reactivate a revoked grant', async () => {
    const revokedAt = new Date('2026-07-01T00:00:00.000Z');
    await db.agentOrgGrant.create({
      data: {
        orgId: subscriberOrg.id,
        agentId: publicAgent.id,
        activatedAt: new Date('2026-06-01T00:00:00.000Z'),
        revokedAt,
      },
    });

    await expect(
      M.createAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'AGENT_ORG_GRANT_INACTIVE' }),
    });

    const stored = await db.agentOrgGrant.findUniqueOrThrow({
      where: { orgId_agentId: { orgId: subscriberOrg.id, agentId: publicAgent.id } },
    });
    expect(stored.revokedAt?.toISOString()).toBe(revokedAt.toISOString());
  });

  it('creates no App, AppMember, AppKey, or AppAgent installation state', async () => {
    await M.createAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(subscriberAdmin.id),
    );

    expect(await db.app.count()).toBe(0);
    expect(await db.appMember.count()).toBe(0);
    expect(await db.appKey.count()).toBe(0);
    expect(await db.appAgent.count()).toBe(0);
  });

  it('uses existing typed not-found behavior for unknown and deleted refs', async () => {
    await expect(
      M.createAgentOrgGrant(null, { agentRef: 'cnonexistentnonexistent12', orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
    ).rejects.toThrow(/AGENT_NOT_FOUND/);

    await db.agent.update({ where: { id: publicAgent.id }, data: { deletedAt: new Date() } });
    await expect(
      M.createAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
    ).rejects.toThrow(/AGENT_NOT_FOUND/);

    await expect(
      M.createAgentOrgGrant(null, { agentRef: privateAgent.id, orgRef: 'no-such-org' }, ctx(subscriberAdmin.id)),
    ).rejects.toThrow(/ORGANIZATION_NOT_FOUND/);
  });
});

describe('Mutation.revokeAgentOrgGrant', () => {
  async function createGrant() {
    return db.agentOrgGrant.create({
      data: {
        orgId: subscriberOrg.id,
        agentId: publicAgent.id,
        activatedAt: new Date('2026-07-01T00:00:00.000Z'),
        createdBy: subscriberAdmin.id,
      },
    });
  }

  it('is exposed in SDL with ref-style entity arguments', () => {
    const field = buildSchema(typeDefs).getMutationType()?.getFields().revokeAgentOrgGrant;
    expect(field).toBeDefined();
    expect(field?.args.map((arg) => arg.name)).toEqual(['agentRef', 'orgRef']);
    expect(field?.args.every((arg) => isNonNullType(arg.type))).toBe(true);
  });

  it('subscriber-org ADMIN can revoke its organization grant', async () => {
    await createGrant();

    const grant = await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(subscriberAdmin.id),
    );

    expect(grant.agentId).toBe(publicAgent.id);
    expect(grant.orgId).toBe(subscriberOrg.id);
    expect(grant.revokedAt).toBeInstanceOf(Date);
    expect(grant.revokedBy).toBe(subscriberAdmin.id);
    expect(grant.updatedBy).toBe(subscriberAdmin.id);
  });

  it('subscriber-org OWNER can revoke through the existing role hierarchy', async () => {
    await createGrant();

    const grant = await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(subscriberOwner.id),
    );

    expect(grant.revokedBy).toBe(subscriberOwner.id);
  });

  it('agent-owner-org ADMIN and OWNER can revoke another organization grant', async () => {
    await createGrant();
    const byAdmin = await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(ownerAdmin.id),
    );
    expect(byAdmin.revokedBy).toBe(ownerAdmin.id);

    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: subscriberOrg.id, agentId: publicAgent.id } },
      data: { revokedAt: null, revokedBy: null },
    });

    const byOwner = await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(ownerOwner.id),
    );
    expect(byOwner.revokedBy).toBe(ownerOwner.id);
  });

  it('rejects lower-role members, unrelated org admins, and unauthenticated callers', async () => {
    await createGrant();

    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberContributor.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberReader.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(ownerContributor.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(unrelatedAdmin.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx()),
    ).rejects.toThrow('Forbidden');
  });

  it('accepts bare URNs and prefixed URNs for both refs', async () => {
    await createGrant();

    const byBareUrns = await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.urn, orgRef: subscriberOrg.urn },
      ctx(subscriberAdmin.id),
    );
    expect(byBareUrns.revokedBy).toBe(subscriberAdmin.id);

    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: subscriberOrg.id, agentId: publicAgent.id } },
      data: { revokedAt: null, revokedBy: null },
    });

    const byLegacyPrefixes = await M.revokeAgentOrgGrant(
      null,
      { agentRef: `urn:agent:${publicAgent.urn}`, orgRef: `urn:org:${subscriberOrg.urn}` },
      ctx(subscriberAdmin.id),
    );
    expect(byLegacyPrefixes.revokedAt).toBeInstanceOf(Date);

    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: subscriberOrg.id, agentId: publicAgent.id } },
      data: { revokedAt: null, revokedBy: null },
    });

    const byCanonicalPrefixes = await M.revokeAgentOrgGrant(
      null,
      { agentRef: `hrn:agent:${publicAgent.urn}`, orgRef: `hrn:org:${subscriberOrg.urn}` },
      ctx(subscriberAdmin.id),
    );
    expect(byCanonicalPrefixes.agentId).toBe(publicAgent.id);
  });

  it('is idempotent and preserves the original revoke audit fields', async () => {
    await createGrant();

    const first = await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(subscriberAdmin.id),
    );
    const second = await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(ownerAdmin.id),
    );

    expect(second.revokedAt?.toISOString()).toBe(first.revokedAt?.toISOString());
    expect(second.revokedBy).toBe(subscriberAdmin.id);
  });

  it('uses typed not-found behavior for missing grant and unknown/deleted refs', async () => {
    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'AGENT_ORG_GRANT_NOT_FOUND' }),
    });

    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: 'cnonexistentnonexistent12', orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
    ).rejects.toThrow(/AGENT_NOT_FOUND/);

    await db.agent.update({ where: { id: publicAgent.id }, data: { deletedAt: new Date() } });
    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: publicAgent.id, orgRef: subscriberOrg.id }, ctx(subscriberAdmin.id)),
    ).rejects.toThrow(/AGENT_NOT_FOUND/);

    await expect(
      M.revokeAgentOrgGrant(null, { agentRef: privateAgent.id, orgRef: 'no-such-org' }, ctx(subscriberAdmin.id)),
    ).rejects.toThrow(/ORGANIZATION_NOT_FOUND/);
  });

  it('does not delete AgentImport rows as a side effect', async () => {
    await createGrant();
    const parentAgent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: subscriberOrg.id,
        urn: `${subscriberOrg.urn}:parent-agent`,
        name: 'Parent Agent',
        visibility: 'ORGANIZATION',
      },
    });
    const agentImport = await createDbAgentImport(db, parentAgent.id, publicAgent.id);

    await M.revokeAgentOrgGrant(
      null,
      { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
      ctx(subscriberAdmin.id),
    );

    expect(await db.agentImport.findUnique({
      where: {
        parentAgentId_importedAgentId: {
          parentAgentId: agentImport.parentAgentId,
          importedAgentId: agentImport.importedAgentId,
        },
      },
    })).not.toBeNull();
  });
});
