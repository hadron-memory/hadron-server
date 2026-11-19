import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
type NestedApp = { id: string; keys: Array<{ keyPreview: string }>; members: Array<{ userId: string }>; description?: string | null };
type TestData = {
  app?: NestedApp | null;
  worker?: { id: string; app: NestedApp | null } | null;
  memory?: { id: string; app: NestedApp | null; organization?: { apps: NestedApp[]; policy?: unknown } | null; subscriptions?: Array<{ organization: { policy?: unknown } | null }> } | null;
  organization?: { id: string; policy?: unknown } | null;
  me?: { appMemberships: Array<{ app: NestedApp | null }> } | null;
  agent?: { apps: NestedApp[]; appAgents: Array<{ app: NestedApp | null }>; orgGrants?: Array<{ organization: { policy?: unknown } | null }> } | null;
};
const gql = async (userId: string | undefined, query: string, ref: string, roles: string[] = ['READER']) => {
  const result = await server.executeOperation(
    { query, variables: { ref } },
    { contextValue: { db, roles, ...(userId ? { userId } : {}) } as Context },
  );
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  return { ...result.body.singleResult, data: result.body.singleResult.data as TestData | null | undefined };
};

let app: { id: string };
let orgId: string;
let workerMemory: { id: string };
let worker: { id: string };
let publicMemory: { id: string };
let holder: { id: string };
let owner: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'synthetic-org', urn: 'synthetic-org', policy: { confidential: 'SYNTHETIC-ORG-POLICY' } } });
  orgId = org.id;
  owner = await db.user.create({ data: { githubId: 910001, githubUsername: 'synthetic-owner', roles: ['READER'] } });
  holder = await db.user.create({ data: { githubId: 910002, githubUsername: 'synthetic-holder', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Private App', urn: 'synthetic-org:private-app', description: 'SYNTHETIC-CONFIDENTIAL-APP-PROMPT' } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `hash-${generateId()}`, keyPreview: 'SYNTHETIC-KEY-PREVIEW' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'synthetic-org:worker-agent', name: 'Worker Agent', visibility: 'ORGANIZATION' } });
  workerMemory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, urn: 'synthetic-org:worker-memory', name: 'Worker Memory', class: 'app' } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, memoryId: workerMemory.id, name: 'Synthetic Worker', slug: 'synthetic-worker', role: 'engineer', heldByUserId: holder.id, heldAt: new Date() } });
  publicMemory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, urn: 'synthetic-org:public-knowledge', name: 'Public Knowledge', class: 'knowledge', visibility: 'PUBLIC' } });
});

const nested = `query($ref: ID!) { memory(ref: $ref) { id app { id description keys { keyPreview } members { userId } } } }`;
const direct = `query($ref: ID!) { app(ref: $ref) { id keys { keyPreview } members { userId } } }`;

describe('nested App read gates', () => {
  it('masks the linked App from an org-external Worker holder without hiding working memory', async () => {
    const appResult = await gql(holder.id, direct, app.id);
    expect(appResult.data?.app).toBeNull();
    expect(appResult.errors?.length).toBeGreaterThan(0);
    const workerResult = await gql(holder.id, `query($ref: ID!) { worker(ref: $ref) { id app { id } } }`, worker.id);
    expect(workerResult.data?.worker?.app).toBeNull();

    const result = await gql(holder.id, nested, workerMemory.id);
    expect(result.errors).toBeUndefined();
    expect(result.data?.memory?.id).toBe(workerMemory.id);
    expect(result.data?.memory?.app).toBeNull();

    const directOrg = await gql(holder.id, `query($ref: ID!) { organization(ref: $ref) { id policy } }`, orgId);
    expect(directOrg.data?.organization).toBeNull();
    expect(directOrg.errors?.length).toBeGreaterThan(0);
    const throughOrg = await gql(holder.id, `query($ref: ID!) { memory(ref: $ref) { organization { policy apps { id description keys { keyPreview } } } } }`, workerMemory.id);
    expect(throughOrg.errors).toBeUndefined();
    expect(throughOrg.data?.memory?.organization).toBeNull();

    // An eager relation must not bypass the App's own gate either.
    const eagerApp = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    expect(await resolvers.Memory.app(
      { id: workerMemory.id, appId: app.id, app: eagerApp } as { appId: string },
      {},
      { db, userId: holder.id, roles: ['READER'] } as Context,
    )).toBeNull();
    const holderCtx = { db, userId: holder.id, roles: ['READER'] } as Context;
    const eagerOrg = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(await resolvers.Memory.organization(
      { organizationId: orgId, organization: eagerOrg } as { organizationId: string },
      {}, holderCtx,
    )).toBeNull();
    // #1744: credential inventory now refuses at its own manager gate.
    await expect(resolvers.App.keys({ id: app.id, keys: [{ keyPreview: 'SYNTHETIC-KEY-PREVIEW' }] }, {}, holderCtx))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await resolvers.App.members({ id: app.id }, {}, holderCtx)).toEqual([]);
    expect(await resolvers.App.memberCount({ id: app.id }, {}, holderCtx)).toBe(0);
    expect(await resolvers.Organization.apps({ id: orgId, apps: [eagerApp] }, {}, holderCtx)).toEqual([]);
    // Eager rows can bypass the normal deletedAt SQL predicate.
    const ownerCtx = { db, userId: owner.id, roles: ['READER'] } as Context;
    expect(await resolvers.Organization.apps({
      id: orgId, apps: [{ ...eagerApp, deletedAt: new Date() }],
    }, {}, ownerCtx)).toEqual([]);
  });

  it('an anonymous caller cannot read an App-scoped PUBLIC knowledge memory', async () => {
    const appResult = await gql(undefined, direct, app.id);
    expect(appResult.data?.app).toBeNull();
    expect(appResult.errors?.length).toBeGreaterThan(0);

    const result = await gql(undefined, nested, publicMemory.id);
    expect(result.errors).toBeUndefined();
    expect(result.data?.memory).toBeNull();
  });

  it('masks the linked App from an org-external member reading App-scoped knowledge', async () => {
    const appResult = await gql(holder.id, direct, app.id);
    expect(appResult.data?.app).toBeNull();

    const result = await gql(holder.id, nested, publicMemory.id);
    expect(result.errors).toBeUndefined();
    expect(result.data?.memory?.id).toBe(publicMemory.id);
    expect(result.data?.memory?.app).toBeNull();
  });

  it('masks the App on an org-external member’s own membership row', async () => {
    const result = await gql(holder.id, `query { me { appMemberships { app { keys { keyPreview } members { userId } } } } }`, app.id);
    expect(result.errors).toBeUndefined();
    expect(result.data?.me?.appMemberships).toHaveLength(1);
    expect(result.data?.me?.appMemberships?.[0]?.app).toBeNull();
  });

  it('preserves App fields for the owning-org member through both paths', async () => {
    const memory = await gql(owner.id, nested, workerMemory.id);
    expect(memory.errors).toBeUndefined();
    expect(memory.data?.memory?.app?.keys).toEqual([{ keyPreview: 'SYNTHETIC-KEY-PREVIEW' }]);
    expect(memory.data?.memory?.app?.description).toBe('SYNTHETIC-CONFIDENTIAL-APP-PROMPT');
    expect(memory.data?.memory?.app?.members.map((m: { userId: string }) => m.userId)).toContain(owner.id);

    const membership = await gql(owner.id, `query { me { appMemberships { app { keys { keyPreview } } } } }`, app.id);
    expect(membership.errors).toBeUndefined();
    expect(membership.data?.me?.appMemberships?.[0]?.app?.keys).toEqual([{ keyPreview: 'SYNTHETIC-KEY-PREVIEW' }]);

    const throughOrg = await gql(owner.id, `query($ref: ID!) { memory(ref: $ref) { organization { apps { id } } } }`, workerMemory.id);
    expect(throughOrg.data?.memory?.organization?.apps.map((row: NestedApp) => row.id)).toContain(app.id);

    const platformAdmin = await gql(holder.id, `query($ref: ID!) { memory(ref: $ref) { organization { policy } } }`, workerMemory.id, ['ADMIN']);
    expect(platformAdmin.errors).toBeUndefined();
    expect(platformAdmin.data?.memory?.organization?.policy).toEqual({ confidential: 'SYNTHETIC-ORG-POLICY' });
  });

  it('keeps a platform admin from seeing another user’s App through a public Agent install', async () => {
    const publicAgent = await db.agent.create({ data: {
      id: generateId(), ownerUserId: owner.id, urn: '@synthetic-owner:public-agent',
      name: 'Public Agent', visibility: 'PUBLIC',
    } });
    const privateApp = await db.app.create({ data: {
      id: generateId(), ownerUserId: owner.id, urn: '@synthetic-owner:private-app',
      name: 'Personal App', description: 'PERSONAL-APP-PROMPT',
      appAgents: { create: { agentId: publicAgent.id } },
    } });
    await db.appMember.create({ data: { appId: privateApp.id, userId: owner.id, role: 'owner' } });
    await db.appKey.create({ data: {
      id: generateId(), appId: privateApp.id, keyHash: `hash-${generateId()}`,
      keyPreview: 'PRIVATE-USER-KEY-PREVIEW',
    } });

    const directResult = await gql(holder.id, direct, privateApp.id, ['ADMIN']);
    expect(directResult.data?.app).toBeNull();
    const nestedResult = await gql(holder.id, `query($ref: ID!) { agent(ref: $ref) { apps { id description keys { keyPreview } } appAgents { app { id description keys { keyPreview } } } } }`, publicAgent.id, ['ADMIN']);
    expect(nestedResult.errors).toBeUndefined();
    expect(nestedResult.data?.agent?.apps).toEqual([]);
    expect(nestedResult.data?.agent?.appAgents).toEqual([]);

    const adminCtx = { db, userId: holder.id, roles: ['ADMIN'] } as Context;
    expect(await resolvers.AppAgent.app({ appId: privateApp.id, app: privateApp } as { appId: string }, {}, adminCtx)).toBeNull();

    const ownerResult = await gql(owner.id, `query($ref: ID!) { agent(ref: $ref) { apps { id } appAgents { app { id } } } }`, publicAgent.id, ['ADMIN']);
    expect(ownerResult.errors).toBeUndefined();
    expect(ownerResult.data?.agent?.apps.map((row: NestedApp) => row.id)).toContain(privateApp.id);
    expect(ownerResult.data?.agent?.appAgents?.[0]?.app?.id).toBe(privateApp.id);
  });

  it('masks customer orgs reached through vendor Agent grants and PUBLIC Memory subscriptions', async () => {
    const customer = await db.organization.create({ data: {
      id: generateId(), name: 'synthetic-customer', urn: 'synthetic-customer',
      policy: { confidential: 'CUSTOMER-POLICY' },
    } });
    const vendorAgent = await db.agent.findFirstOrThrow({ where: { organizationId: orgId } });
    await db.agentOrgGrant.create({ data: { orgId: customer.id, agentId: vendorAgent.id } });
    const publicVendorMemory = await db.memory.create({ data: {
      id: generateId(), organizationId: orgId, urn: 'synthetic-org:public-vendor',
      name: 'Public Vendor Memory', class: 'knowledge', visibility: 'PUBLIC',
    } });
    await db.memorySubscription.create({ data: {
      id: generateId(), memoryId: publicVendorMemory.id, organizationId: customer.id,
    } });
    const stranger = await db.user.create({ data: {
      githubId: 910003, githubUsername: 'synthetic-stranger', roles: ['READER'],
    } });

    const ownerDirect = await gql(owner.id, `query($ref: ID!) { organization(ref: $ref) { policy } }`, customer.id);
    expect(ownerDirect.data?.organization).toBeNull();
    expect(ownerDirect.errors?.length).toBeGreaterThan(0);
    const grant = await gql(owner.id, `query($ref: ID!) { agent(ref: $ref) { orgGrants { organization { policy } } } }`, vendorAgent.id);
    expect(grant.errors).toBeUndefined();
    expect(grant.data?.agent?.orgGrants).toEqual([{ organization: null }]);

    const strangerDirect = await gql(stranger.id, `query($ref: ID!) { organization(ref: $ref) { policy } }`, customer.id);
    expect(strangerDirect.data?.organization).toBeNull();
    const subscription = await gql(stranger.id, `query($ref: ID!) { memory(ref: $ref) { id subscriptions { organization { policy } } } }`, publicVendorMemory.id);
    expect(subscription.errors).toBeUndefined();
    expect(subscription.data?.memory?.id).toBe(publicVendorMemory.id);
    expect(subscription.data?.memory?.subscriptions).toEqual([{ organization: null }]);

    // Eager includes from MEMORY_INCLUDE must not authorize the relation.
    const customerRow = await db.organization.findUniqueOrThrow({ where: { id: customer.id } });
    const strangerCtx = { db, userId: stranger.id, roles: ['READER'] } as Context;
    expect(await resolvers.MemorySubscription.organization(
      { organizationId: customer.id, organization: customerRow } as { organizationId: string },
      {}, strangerCtx,
    )).toBeNull();
    await db.orgMember.create({ data: { organizationId: customer.id, userId: stranger.id, role: 'READER' } });
    const positive = await gql(stranger.id, `query($ref: ID!) { memory(ref: $ref) { subscriptions { organization { policy } } } }`, publicVendorMemory.id);
    expect(positive.data?.memory?.subscriptions?.[0]?.organization?.policy).toEqual({ confidential: 'CUSTOMER-POLICY' });
  });
});
