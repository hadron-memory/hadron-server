import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
let installerOrg: { id: string; urn: string };
let vendorOrg: { id: string; urn: string };
let dependencyOrg: { id: string; urn: string };
let installerAdmin: { id: string };

function ctx(): Context {
  return { db, userId: installerAdmin.id, roles: ['READER'] };
}

async function agent(org: { id: string; urn: string }, slug: string, visibility: 'PUBLIC' | 'ORGANIZATION') {
  return db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`,
      name: slug, type: 'CHATBOT', surfaces: ['api'], visibility,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  installerOrg = await db.organization.create({ data: { id: generateId(), name: 'installer', urn: 'installer1580.example' } });
  vendorOrg = await db.organization.create({ data: { id: generateId(), name: 'vendor', urn: 'vendor1580.example' } });
  dependencyOrg = await db.organization.create({ data: { id: generateId(), name: 'dependency', urn: 'dependency1580.example' } });
  installerAdmin = await db.user.create({ data: { id: generateId(), githubId: 158001, githubUsername: 'installer1580', roles: [] } });
  await db.orgMember.create({ data: { organizationId: installerOrg.id, userId: installerAdmin.id, role: 'ADMIN' } });
});

describe('#1580 createApp AgentOrgGrant boundary', () => {
  it('conceals and refuses a foreign non-public Agent without minting a grant or App', async () => {
    const privateAgent = await agent(vendorOrg, 'private', 'ORGANIZATION');

    await expect(M.createApp(null, {
      orgRef: installerOrg.id, agentRef: privateAgent.id, name: 'Stolen',
    }, ctx())).rejects.toThrow(/AGENT_NOT_FOUND/);
    expect(await db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: installerOrg.id, agentId: privateAgent.id } },
    })).toBeNull();
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(0);
  });

  it('conceals an unlicensed private parent before resolving invalid optional refs', async () => {
    const privateAgent = await agent(vendorOrg, 'hidden-parent', 'ORGANIZATION');
    const optionalRef = generateId();
    const call = (agentRef: string) => M.createApp(null, {
      orgRef: installerOrg.id, agentRef, name: 'Probe', installOptional: [optionalRef],
    }, ctx());

    const hiddenError = await call(privateAgent.id).catch((error: Error) => error);
    const missingParentId = generateId();
    const missingError = await call(missingParentId).catch((error: Error) => error);
    expect(hiddenError.message).toBe(missingError.message.replace(missingParentId, privateAgent.id));
    expect(hiddenError.message).toContain('AGENT_NOT_FOUND');
    expect(hiddenError.message).not.toContain(optionalRef);
    expect(await db.agentOrgGrant.count({ where: { orgId: installerOrg.id } })).toBe(0);
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(0);
  });

  it('auto-provisions only the owning org and refuses an inactive own grant', async () => {
    const ownAgent = await agent(installerOrg, 'own', 'ORGANIZATION');
    const app = await M.createApp(null, { orgRef: installerOrg.id, agentRef: ownAgent.id, name: 'Own' }, ctx());
    expect(app.organizationId).toBe(installerOrg.id);
    const grant = await db.agentOrgGrant.findUniqueOrThrow({
      where: { orgId_agentId: { orgId: installerOrg.id, agentId: ownAgent.id } },
    });
    expect(grant.activatedAt).not.toBeNull();

    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: installerOrg.id, agentId: ownAgent.id } },
      data: { revokedAt: new Date() },
    });
    await expect(M.createApp(null, { orgRef: installerOrg.id, agentRef: ownAgent.id, name: 'Own Again' }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' } });
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(1);
  });

  it('requires an explicit active subscription for a PUBLIC foreign Agent', async () => {
    const publicAgent = await agent(vendorOrg, 'public', 'PUBLIC');
    await expect(M.createApp(null, { orgRef: installerOrg.id, agentRef: publicAgent.id, name: 'No License' }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_REQUIRED' } });
    expect(await db.agentOrgGrant.count({ where: { orgId: installerOrg.id } })).toBe(0);

    await M.createAgentOrgGrant(null, { orgRef: installerOrg.id, agentRef: publicAgent.id }, ctx());
    const app = await M.createApp(null, { orgRef: installerOrg.id, agentRef: publicAgent.id, name: 'Licensed' }, ctx());
    expect(app.organizationId).toBe(installerOrg.id);

    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: installerOrg.id, agentId: publicAgent.id } },
      data: { revokedAt: new Date() },
    });
    await expect(M.createApp(null, { orgRef: installerOrg.id, agentRef: publicAgent.id, name: 'Revoked' }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' } });
  });

  it('accepts an existing active foreign grant but never revives a revoked one', async () => {
    const privateAgent = await agent(vendorOrg, 'licensed-private', 'ORGANIZATION');
    await createDbAgentOrgGrant(db, installerOrg.id, privateAgent.id);
    const app = await M.createApp(null, { orgRef: installerOrg.id, agentRef: privateAgent.id, name: 'Licensed Private' }, ctx());
    expect(app.organizationId).toBe(installerOrg.id);

    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: installerOrg.id, agentId: privateAgent.id } },
      data: { revokedAt: new Date() },
    });
    await expect(M.createApp(null, { orgRef: installerOrg.id, agentRef: privateAgent.id, name: 'Revoked Private' }, ctx()))
      .rejects.toThrow(/AGENT_NOT_FOUND/);
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(1);
  });

  it('preflights selected dependencies before creating the parent App or any grant', async () => {
    const parent = await agent(vendorOrg, 'suite', 'PUBLIC');
    const dep = await agent(dependencyOrg, 'secret-dep', 'ORGANIZATION');
    await createDbAgentOrgGrant(db, vendorOrg.id, dep.id); // publisher may bundle it
    await createDbAgentImport(db, parent.id, dep.id, { required: true });
    await createDbAgentOrgGrant(db, installerOrg.id, parent.id); // installer has parent license only

    await expect(M.createApp(null, { orgRef: installerOrg.id, agentRef: parent.id, name: 'Suite' }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'AGENT_DEPENDENCY_UNAVAILABLE' } });
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(0);
    expect(await db.agentOrgGrant.count({ where: { orgId: installerOrg.id } })).toBe(1);

    await createDbAgentOrgGrant(db, installerOrg.id, dep.id);
    await M.createApp(null, { orgRef: installerOrg.id, agentRef: parent.id, name: 'Suite' }, ctx());
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(2);
  });

  it('does not mint a same-org parent grant when a selected dependency is inactive', async () => {
    const parent = await agent(installerOrg, 'own-suite', 'ORGANIZATION');
    const dep = await agent(vendorOrg, 'revoked-dep', 'PUBLIC');
    await createDbAgentOrgGrant(db, installerOrg.id, dep.id);
    await createDbAgentImport(db, parent.id, dep.id);
    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: installerOrg.id, agentId: dep.id } },
      data: { revokedAt: new Date() },
    });

    await expect(M.createApp(null, { orgRef: installerOrg.id, agentRef: parent.id, name: 'Own Suite' }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' } });
    expect(await db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: installerOrg.id, agentId: parent.id } },
    })).toBeNull();
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(0);
  });

  it('does not require a license for an optional dependency the caller did not select', async () => {
    const parent = await agent(vendorOrg, 'optional-suite', 'PUBLIC');
    const dep = await agent(dependencyOrg, 'optional-dep', 'ORGANIZATION');
    await createDbAgentOrgGrant(db, vendorOrg.id, dep.id);
    await createDbAgentImport(db, parent.id, dep.id, { required: false });
    await createDbAgentOrgGrant(db, installerOrg.id, parent.id);

    await expect(M.createApp(null, {
      orgRef: installerOrg.id, agentRef: parent.id, name: 'Selected Optional', installOptional: [dep.id],
    }, ctx())).rejects.toMatchObject({ extensions: { code: 'AGENT_DEPENDENCY_UNAVAILABLE' } });
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(0);

    await M.createApp(null, { orgRef: installerOrg.id, agentRef: parent.id, name: 'No Optional' }, ctx());
    expect(await db.app.count({ where: { organizationId: installerOrg.id } })).toBe(1);
    expect(await db.agentOrgGrant.count({ where: { orgId: installerOrg.id } })).toBe(1);
  });

  it('uses the same license gate when adding an Agent to an existing App', async () => {
    const ownAgent = await agent(installerOrg, 'host', 'ORGANIZATION');
    const app = await M.createApp(null, { orgRef: installerOrg.id, agentRef: ownAgent.id, name: 'Host' }, ctx());
    const privateAgent = await agent(vendorOrg, 'add-private', 'ORGANIZATION');
    const publicAgent = await agent(vendorOrg, 'add-public', 'PUBLIC');

    await expect(M.installAgentIntoApp(null, { appRef: app.id, agentRef: privateAgent.id }, ctx()))
      .rejects.toThrow(/AGENT_NOT_FOUND/);
    await expect(M.installAgentIntoApp(null, { appRef: app.id, agentRef: publicAgent.id }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_REQUIRED' } });
    expect(await db.agentOrgGrant.count({ where: { orgId: installerOrg.id } })).toBe(1);
    expect(await db.appAgent.count({ where: { appId: app.id } })).toBe(1);

    await M.createAgentOrgGrant(null, { orgRef: installerOrg.id, agentRef: publicAgent.id }, ctx());
    await M.installAgentIntoApp(null, { appRef: app.id, agentRef: publicAgent.id }, ctx());
    await createDbAgentOrgGrant(db, installerOrg.id, privateAgent.id);
    await M.installAgentIntoApp(null, { appRef: app.id, agentRef: privateAgent.id }, ctx());
    expect(await db.appAgent.count({ where: { appId: app.id } })).toBe(3);
  });
});
