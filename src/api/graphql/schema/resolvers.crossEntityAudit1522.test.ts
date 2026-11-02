import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

describe('#1522 nested Agent read parity', () => {
  beforeEach(async () => cleanDb(db));

  it('keeps a pure App key on its own installed Agent, never another App install', async () => {
    const owner = await createDbOrgAndGraph(db, { orgName: 'nested-key-owner', graphName: 'owner-memory' });
    const agent = await db.agent.create({
      data: {
        organizationId: owner.org.id,
        urn: 'nested-key-owner:private-agent',
        name: 'Owner Agent',
        description: 'synthetic-owner-private-prompt',
        visibility: 'ORGANIZATION',
      },
    });
    const { app } = await createDbAppWithKey(db, 'nested-key-installed', owner.org.id);
    const { app: otherApp } = await createDbAppWithKey(db, 'nested-key-other', owner.org.id);
    await createDbAppAgent(db, app.id, agent.id);

    const query = '{ myApp { agent { id description } agents { id } appAgents { agent { id } } } }';
    const own = await server.executeOperation(
      { query },
      { contextValue: { db, appId: app.id, roles: [] } as Context },
    );
    expect(own.body.kind).toBe('single');
    if (own.body.kind !== 'single') return;
    expect(own.body.singleResult.errors).toBeUndefined();
    expect(own.body.singleResult.data?.myApp).toMatchObject({
      agent: { id: agent.id, description: 'synthetic-owner-private-prompt' },
      agents: [{ id: agent.id }],
      appAgents: [{ agent: { id: agent.id } }],
    });
    expect(await resolvers.AppRun.agent(
      { agentId: agent.id }, {}, { db, appId: app.id, roles: [] } as Context,
    )).toMatchObject({ id: agent.id });
    expect(await resolvers.AppRun.agent(
      { agentId: agent.id }, {}, { db, appId: otherApp.id, roles: [] } as Context,
    )).toBeNull();
  });

  it('hides a foreign non-public Agent through every App install relation, retaining authorized reads', async () => {
    const vendor = await createDbOrgAndGraph(db, { orgName: 'nested-agent-vendor', graphName: 'vendor-memory' });
    const customer = await createDbOrgAndGraph(db, { orgName: 'nested-agent-customer', graphName: 'customer-memory' });
    const customerUser = await db.user.create({
      data: { githubId: 9182201, githubUsername: 'nested-agent-customer', roles: ['READER'] },
    });
    const vendorCustomerUser = await db.user.create({
      data: { githubId: 9182204, githubUsername: 'nested-agent-co-member', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { organizationId: customer.org.id, userId: customerUser.id, role: 'READER' },
    });
    await db.orgMember.createMany({
      data: [
        { organizationId: vendor.org.id, userId: vendorCustomerUser.id, role: 'READER' },
        { organizationId: customer.org.id, userId: vendorCustomerUser.id, role: 'READER' },
      ],
    });
    const agent = await db.agent.create({
      data: {
        organizationId: vendor.org.id,
        urn: 'nested-agent-vendor:private-agent',
        name: 'Private vendor Agent',
        description: 'synthetic-vendor-private-prompt',
        visibility: 'ORGANIZATION',
      },
    });
    await db.agentOrgGrant.create({
      data: { orgId: customer.org.id, agentId: agent.id, activatedAt: new Date() },
    });
    const { app } = await createDbAppWithKey(db, 'nested-agent-customer-app', customer.org.id);
    await createDbAppAgent(db, app.id, agent.id);
    const publicChild = await db.agent.create({
      data: {
        organizationId: vendor.org.id,
        urn: 'nested-agent-vendor:public-child',
        name: 'Public child Agent',
        visibility: 'PUBLIC',
      },
    });
    await db.agentOrgGrant.create({
      data: { orgId: customer.org.id, agentId: publicChild.id, activatedAt: new Date() },
    });
    await db.agentImport.create({
      data: {
        parentAgentId: agent.id,
        importedAgentId: publicChild.id,
        agentOrgGrantOrgId: customer.org.id,
        agentOrgGrantAgentId: publicChild.id,
        position: 0,
      },
    });

    const contextValue = { db, userId: customerUser.id, roles: ['READER'] } as Context;
    const direct = await server.executeOperation(
      { query: 'query ($ref: ID!) { agent(ref: $ref) { id description } }', variables: { ref: agent.id } },
      { contextValue },
    );
    expect(direct.body.kind).toBe('single');
    if (direct.body.kind !== 'single') return;
    // #1944: a foreign non-public Agent reads as absent: null, no error.
    expect(direct.body.singleResult.errors).toBeUndefined();
    expect(direct.body.singleResult.data?.agent).toBeNull();

    const nested = await server.executeOperation(
      {
        query: 'query ($ref: ID!) { app(ref: $ref) { agent { id description } agents { id description } appAgents { agent { id description } } } }',
        variables: { ref: app.id },
      },
      { contextValue },
    );
    expect(nested.body.kind).toBe('single');
    if (nested.body.kind !== 'single') return;
    expect(nested.body.singleResult.data?.app).toEqual({
      agent: null,
      agents: [],
      appAgents: [{ agent: null }],
    });
    expect(await resolvers.AppRun.agent(
      { agentId: agent.id },
      {},
      { db, appId: app.id, roles: [] } as Context,
    )).toMatchObject({ id: agent.id, description: 'synthetic-vendor-private-prompt' });

    // An App credential executes its installed Agent, including a licensed
    // vendor Agent. That authority does not extend to customer-org users.
    const appKey = await server.executeOperation(
      { query: '{ myApp { agent { id description } agents { id } appAgents { agent { id } } } }' },
      { contextValue: { db, appId: app.id, roles: [] } as Context },
    );
    expect(appKey.body.kind).toBe('single');
    if (appKey.body.kind !== 'single') return;
    expect(appKey.body.singleResult.errors).toBeUndefined();
    expect(appKey.body.singleResult.data?.myApp).toMatchObject({
      agent: { id: agent.id, description: 'synthetic-vendor-private-prompt' },
      agents: [{ id: agent.id }],
      appAgents: [{ agent: { id: agent.id } }],
    });
    const importQuery = 'query ($ref: ID!) { agent(ref: $ref) { importedBy { parentAgent { description } } } }';
    const licensedImport = await server.executeOperation(
      { query: importQuery, variables: { ref: publicChild.id } },
      { contextValue: { db, appId: app.id, roles: [] } as Context },
    );
    expect(licensedImport.body.kind).toBe('single');
    if (licensedImport.body.kind !== 'single') return;
    expect(licensedImport.body.singleResult.data?.agent).toMatchObject({
      importedBy: [{ parentAgent: { description: 'synthetic-vendor-private-prompt' } }],
    });

    // The install row survives grant revocation; it is no longer authority
    // for the App key to read or execute the vendor Agent.
    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: customer.org.id, agentId: agent.id } },
      data: { revokedAt: new Date() },
    });
    const revokedKey = await server.executeOperation(
      { query: '{ myApp { agent { id description } agents { id } appAgents { agent { id } } } }' },
      { contextValue: { db, appId: app.id, roles: [] } as Context },
    );
    expect(revokedKey.body.kind).toBe('single');
    if (revokedKey.body.kind !== 'single') return;
    expect(revokedKey.body.singleResult.errors).toBeUndefined();
    expect(revokedKey.body.singleResult.data?.myApp).toEqual({
      agent: null,
      agents: [],
      appAgents: [{ agent: null }],
    });
    expect(await resolvers.AppRun.agent(
      { agentId: agent.id }, {}, { db, appId: app.id, roles: [] } as Context,
    )).toBeNull();
    const revokedImport = await server.executeOperation(
      { query: importQuery, variables: { ref: publicChild.id } },
      { contextValue: { db, appId: app.id, roles: [] } as Context },
    );
    expect(revokedImport.body.kind).toBe('single');
    if (revokedImport.body.kind !== 'single') return;
    expect(revokedImport.body.singleResult.data?.agent).toEqual({
      importedBy: [{ parentAgent: null }],
    });

    const authorized = await server.executeOperation(
      {
        query: 'query ($ref: ID!) { app(ref: $ref) { agent { id description } agents { id description } appAgents { agent { id description } } } }',
        variables: { ref: app.id },
      },
      { contextValue: { db, userId: vendorCustomerUser.id, roles: ['READER'] } as Context },
    );
    expect(authorized.body.kind).toBe('single');
    if (authorized.body.kind !== 'single') return;
    expect(authorized.body.singleResult.data?.app).toMatchObject({
      agent: { id: agent.id, description: 'synthetic-vendor-private-prompt' },
      agents: [{ id: agent.id, description: 'synthetic-vendor-private-prompt' }],
      appAgents: [{ agent: { id: agent.id, description: 'synthetic-vendor-private-prompt' } }],
    });

    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    const publicResult = await server.executeOperation(
      {
        query: 'query ($ref: ID!) { app(ref: $ref) { agent { id description } agents { id } appAgents { agent { id } } } }',
        variables: { ref: app.id },
      },
      { contextValue },
    );
    expect(publicResult.body.kind).toBe('single');
    if (publicResult.body.kind !== 'single') return;
    expect(publicResult.body.singleResult.data?.app).toMatchObject({
      agent: { id: agent.id, description: 'synthetic-vendor-private-prompt' },
      agents: [{ id: agent.id }],
      appAgents: [{ agent: { id: agent.id } }],
    });
  });

  it('does not turn licenses and imports into reads of a private Agent definition', async () => {
    const vendor = await createDbOrgAndGraph(db, { orgName: 'nested-license-vendor', graphName: 'vendor-memory' });
    const customer = await createDbOrgAndGraph(db, { orgName: 'nested-license-customer', graphName: 'customer-memory' });
    const reader = await db.user.create({
      data: { githubId: 9182205, githubUsername: 'nested-license-reader', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { organizationId: customer.org.id, userId: reader.id, role: 'ADMIN' },
    });
    const privateAgent = await db.agent.create({
      data: {
        organizationId: vendor.org.id,
        urn: 'nested-license-vendor:private-agent',
        name: 'Private vendor Agent',
        description: 'synthetic-license-private-prompt',
        visibility: 'ORGANIZATION',
      },
    });
    const publicParent = await db.agent.create({
      data: {
        organizationId: customer.org.id,
        urn: 'nested-license-customer:public-parent',
        name: 'Public parent Agent',
        visibility: 'PUBLIC',
      },
    });
    await db.agentOrgGrant.create({
      data: { orgId: customer.org.id, agentId: privateAgent.id, activatedAt: new Date() },
    });
    await db.agentSubscription.create({
      data: { userId: reader.id, agentId: privateAgent.id, activatedAt: new Date() },
    });
    await db.agentImport.create({
      data: {
        parentAgentId: publicParent.id,
        importedAgentId: privateAgent.id,
        agentOrgGrantOrgId: customer.org.id,
        agentOrgGrantAgentId: privateAgent.id,
        position: 100,
      },
    });
    const contextValue = { db, userId: reader.id, organizationId: customer.org.id, roles: ['READER'] } as Context;
    const result = await server.executeOperation(
      {
        query: `query ($org: ID!, $parent: ID!) {
          organization(ref: $org) { agentOrgGrants { agentId agent { id description } } }
          myAgentSubscriptions { agentId agent { id description } }
          agent(ref: $parent) { imports { importedAgentId importedAgent { id description } } }
        }`,
        variables: { org: customer.org.id, parent: publicParent.id },
      },
      { contextValue },
    );
    expect(result.body.kind).toBe('single');
    if (result.body.kind !== 'single') return;
    expect(result.body.singleResult.errors).toBeUndefined();
    expect(result.body.singleResult.data).toMatchObject({
      organization: { agentOrgGrants: [{ agentId: privateAgent.id, agent: null }] },
      myAgentSubscriptions: [{ agentId: privateAgent.id, agent: null }],
      agent: { imports: [{ importedAgentId: privateAgent.id, importedAgent: null }] },
    });
    // AppRun has a separate Agent loader. A run audit must not turn the
    // customer license into the vendor's full private Agent definition.
    expect(await resolvers.AppRun.agent({ agentId: privateAgent.id }, {}, contextValue)).toBeNull();
  });

  it('#1787 (cor:dmo:050:13): a platform admin reads a user-owned Agent definition (direct and nested); the owner control holds', async () => {
    const owner = await db.user.create({
      data: { githubId: 9182206, githubUsername: 'nested-agent-personal-owner', handle: 'nested-agent-owner' },
    });
    const admin = await db.user.create({
      data: { githubId: 9182207, githubUsername: 'nested-agent-platform-admin', roles: ['ADMIN'] },
    });
    const agent = await db.agent.create({
      data: {
        ownerUserId: owner.id,
        urn: 'nested-agent-owner:private-agent',
        name: 'Owner-only Agent',
        description: 'synthetic-owner-only-prompt',
      },
    });
    const adminCtx = { db, userId: admin.id, roles: ['ADMIN'] } as Context;
    // #1787 flips this file's original #1522 pin: the platform admin may
    // MANAGE a user-owned Agent, so it reads the definition and prompt —
    // the rogue-agent shutdown capability. The license/customer paths this
    // file polices (an unrelated READER riding an App's license) stay closed
    // in the tests above.
    const direct = await server.executeOperation(
      { query: 'query ($ref: ID!) { agent(ref: $ref) { description } }', variables: { ref: agent.id } },
      { contextValue: adminCtx },
    );
    expect(direct.body.kind).toBe('single');
    if (direct.body.kind !== 'single') return;
    expect(direct.body.singleResult.errors).toBeUndefined();
    expect(direct.body.singleResult.data?.agent).toMatchObject({ description: 'synthetic-owner-only-prompt' });
    expect(await resolvers.AppRun.agent({ agentId: agent.id }, {}, adminCtx))
      .toMatchObject({ id: agent.id, description: 'synthetic-owner-only-prompt' });
    expect(await resolvers.AppRun.agent(
      { agentId: agent.id },
      {},
      { db, userId: owner.id, roles: ['READER'] } as Context,
    )).toMatchObject({ id: agent.id, description: 'synthetic-owner-only-prompt' });
  });
});
