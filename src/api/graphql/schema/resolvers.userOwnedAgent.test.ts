/**
 * spec 047 Phase 2c-2b — user-owned Agent creation + its read/audit surfaces.
 *
 * `createAgent` with NO `orgId` creates an agent owned by the caller
 * (`ownerUserId` set, `organizationId` NULL), namespaced under `@<handle>`, with
 * a user-owned system memory. Such an agent is STRICTLY owner-only in v1
 * (PERSONAL only, no sharing). These tests pin creation shape + that every read
 * / list / audit surface treats it owner-only — including the platform-admin
 * carve-outs (Query.memory blocker #676, Query.agents, effectiveAccess).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Prisma } from '../../../generated/prisma/index.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { emitEntityUrnV2 } from '../../../lib/urnEmit.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(over: Partial<Context> = {}): Context {
  return { db, ...over };
}

let ownerId: string;
let otherId: string;

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({
    data: { id: generateId(), name: 'Owner One', handle: 'owner-one', roles: ['READER'] },
  });
  const other = await db.user.create({
    data: { id: generateId(), name: 'Other', handle: 'other-two', roles: ['READER'] },
  });
  ownerId = owner.id;
  otherId = other.id;
});

describe('createAgent — user-owned (no orgId)', () => {
  it('creates a user-owned agent + user-owned system memory with BARE v2 handle URNs', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { name: 'My Helper' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(agent.organizationId).toBeNull();
    expect(agent.ownerUserId).toBe(ownerId);
    // #697 v2: the user-owned root is the BARE handle — no `@` sigil.
    expect(agent.urn).toBe('owner-one:my-helper');
    expect(agent.visibility).toBe('PERSONAL');
    // Round-trip (Codex P2, #720): the emitted v2 URN resolves back to this row.
    // A stored `@owner-one:...` would emit bare (sigil stripped) and then MISS.
    const emitted = emitEntityUrnV2('agent', agent.urn);
    expect(emitted).toBe('hrn:agent:owner-one:my-helper');
    expect(await resolveAgentRef(db, emitted)).toEqual({ id: agent.id });

    const sys = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } });
    expect(sys.class).toBe('system');
    expect(sys.organizationId).toBeNull();
    expect(sys.ownerUserId).toBe(ownerId);
    expect(sys.urn).toBe('owner-one:my-helper-system');
  });

  it('rejects a non-PERSONAL visibility for a user-owned agent', async () => {
    await expect(
      resolvers.Mutation.createAgent(
        {},
        { name: 'Public Me', visibility: 'PUBLIC' },
        ctx({ userId: ownerId, roles: ['READER'] }),
      ),
    ).rejects.toThrow(/PERSONAL|not supported/i);
  });

  it('requires an authenticated user', async () => {
    await expect(
      resolvers.Mutation.createAgent({}, { name: 'Nobody' }, ctx({})),
    ).rejects.toThrow(/authenticated/i);
  });

  it('rejects an empty-string orgId (must not silently route to personal)', async () => {
    await expect(
      resolvers.Mutation.createAgent(
        {},
        { orgId: '', name: 'Ambiguous' },
        ctx({ userId: ownerId, roles: ['READER'] }),
      ),
    ).rejects.toThrow(/non-empty organization/i);
  });

  it('updateAgent cannot publish a user-owned agent to PUBLIC (stays owner-only)', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { name: 'Stays Private' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { ref: agent.id, visibility: 'PUBLIC' },
        ctx({ userId: ownerId, roles: ['READER'] }),
      ),
    ).rejects.toThrow(/PERSONAL|not supported/i);
    const still = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(still.visibility).toBe('PERSONAL');
  });
});

describe('user-owned agent — read/list/audit surfaces are owner-only', () => {
  async function makeUserOwnedAgent() {
    return resolvers.Mutation.createAgent(
      {},
      { name: 'Secret Helper' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
  }

  it('Query.memory: the owner reads the system memory; a platform admin does NOT (blocker #676)', async () => {
    const agent = await makeUserOwnedAgent();
    const memId = agent.systemMemoryId!;

    const asOwner = await resolvers.Query.memory(null, { ref: memId }, ctx({ userId: ownerId, roles: ['READER'] }));
    expect(asOwner?.id).toBe(memId);

    await expect(
      resolvers.Query.memory(null, { ref: memId }, ctx({ userId: otherId, roles: ['ADMIN'] })),
    ).resolves.toBeNull();
  });

  it('Query.agents: the owner sees their user-owned agent; another user + admin-unscoped do not', async () => {
    const agent = await makeUserOwnedAgent();

    const ownerList = await resolvers.Query.agents(null, {}, ctx({ userId: ownerId, roles: ['READER'] }));
    expect(ownerList.items.map((a: { id: string }) => a.id)).toContain(agent.id);

    const otherList = await resolvers.Query.agents(null, {}, ctx({ userId: otherId, roles: ['READER'] }));
    expect(otherList.items.map((a: { id: string }) => a.id)).not.toContain(agent.id);

    // Platform admin, unscoped "see all" — must exclude another user's user-owned agent.
    const adminList = await resolvers.Query.agents(null, {}, ctx({ userId: otherId, roles: ['ADMIN'] }));
    expect(adminList.items.map((a: { id: string }) => a.id)).not.toContain(agent.id);
  });

  // #782 — the owner-only "My agents" slice: agents(filter: { ownedByMe: true })
  // returns ONLY the caller's own user-owned (org-less) agents, for every
  // caller including a platform admin (no fetch-everything-then-filter, no
  // admin cross-tenant reach).
  it('Query.agents(ownedByMe): returns only the caller’s own org-less agents, admin included', async () => {
    const mine = await makeUserOwnedAgent();
    // An org-owned agent the admin would otherwise see in the unscoped list.
    const org = await db.organization.create({
      data: { id: generateId(), name: 'SomeOrg', urn: `someorg-${generateId()}` },
    });
    const orgAgent = await db.agent.create({
      data: { id: generateId(), name: 'Org Agent', urn: `${org.urn}:org-agent`, organizationId: org.id, visibility: 'ORGANIZATION' },
    });
    // Another user's user-owned agent.
    const othersAgent = await resolvers.Mutation.createAgent(
      {}, { name: 'Others Helper' }, ctx({ userId: otherId, roles: ['READER'] }),
    );

    // Owner: sees only their own.
    const ownerList = await resolvers.Query.agents(
      null, { filter: { ownedByMe: true } }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const ownerIds = ownerList.items.map((a: { id: string }) => a.id);
    expect(ownerIds).toEqual([mine.id]);
    expect(ownerList.total).toBe(1);

    // Platform admin: ownedByMe collapses the fetch-everything list to the
    // admin's OWN org-less agents (here: just othersAgent, which otherId owns)
    // — NOT the whole agents table.
    const adminList = await resolvers.Query.agents(
      null, { filter: { ownedByMe: true } }, ctx({ userId: otherId, roles: ['ADMIN'] }),
    );
    const adminIds = adminList.items.map((a: { id: string }) => a.id);
    expect(adminIds).toContain(othersAgent.id); // the admin's OWN user-owned agent
    expect(adminIds).not.toContain(mine.id); // not another user's
    expect(adminIds).not.toContain(orgAgent.id); // not org-owned
  });

  it('Query.agents(ownedByMe): App-key caller (no user) gets an empty page', async () => {
    await makeUserOwnedAgent();
    const res = await resolvers.Query.agents(
      null, { filter: { ownedByMe: true } }, ctx({ appId: 'some-app', roles: ['READER'] }),
    );
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('effectiveAccess: owner has full access; a platform admin has none', async () => {
    const agent = await makeUserOwnedAgent();
    const agentUrn = `hrn:agent:${agent.urn}`;

    const asOwner = await resolvers.Query.effectiveAccess(
      null,
      { user: ownerId, resource: agentUrn },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(asOwner.canRead).toBe(true);
    expect(asOwner.canManage).toBe(true);

    // A platform admin auditing their OWN access to someone else's user-owned
    // agent: before #1381 this reported "no access"; since the 2026-09-26
    // amendment of cor:acl:060:01 a self-audit of a resource the caller cannot
    // OPEN answers as missing — and a user-owned agent is owner-only to open.
    await expect(
      resolvers.Query.effectiveAccess(
        null,
        { user: otherId, resource: agentUrn },
        ctx({ userId: otherId, roles: ['ADMIN'] }),
      ),
    ).rejects.toThrow('Resource not found');
  });
});


// DAR / #1687: this caller has NO organization or OrgMember rows. Exercise
// Apollo field rendering, not just createAgent's already-atomic core.
const personalAgentApi = new ApolloServer<Context>({ typeDefs, resolvers });
afterAll(async () => { await personalAgentApi.stop(); });
it('lets an org-less user create, view and use a personal agent through GraphQL', async () => {
  const contextValue = ctx({ userId: ownerId, roles: ['READER'] });
  expect(await db.orgMember.count({ where: { userId: ownerId } })).toBe(0);
  const execute = async (query: string, variables: Record<string, unknown> = {}) => {
    const response = await personalAgentApi.executeOperation({ query, variables }, { contextValue });
    expect(response.body.kind).toBe('single');
    if (response.body.kind !== 'single') throw new Error('Unexpected incremental response');
    expect(response.body.singleResult.errors).toBeUndefined();
    return response.body.singleResult.data as Record<string, any>;
  };
  const created = (await execute(`mutation {
    createAgent(name: "Orgless helper") { id urn organizationId systemMemoryId appCount orgGrants { organization { id } } }
  }`)).createAgent;
  expect(created).toMatchObject({ organizationId: null, appCount: 0, orgGrants: [] });
  const viewed = (await execute(`query($ref: ID!) {
    agent(ref: $ref) { id appCount orgGrants { organization { id } } systemMemoryId }
  }`, { ref: created.id })).agent;
  expect(viewed).toMatchObject({ id: created.id, appCount: 0, orgGrants: [], systemMemoryId: created.systemMemoryId });
  const task = await db.node.create({ data: {
    id: generateId(), memoryId: created.systemMemoryId, loc: 'tasks:hello', name: 'Hello', nodeType: 'task',
    content: 'Help {{person}} with this personal task.', data: {}, createdBy: ownerId,
  } });
  const used = await execute('mutation($ref: String!) { runTask(nodeRef: $ref, args: { person: "Rashmi fixture" }) }', { ref: task.id });
  expect(used.runTask).toContain('Help Rashmi fixture with this personal task.');
  expect(await db.agent.count({ where: { id: created.id } })).toBe(1);
  expect(await db.memory.count({ where: { id: created.systemMemoryId, ownerUserId: ownerId } })).toBe(1);
});

it('returns empty organization-derived fields for org-less agents even to a platform admin', async () => {
  const agent = await resolvers.Mutation.createAgent({}, { name: 'No org counters' }, ctx({ userId: ownerId, roles: ['READER'] }));
  for (const principal of [ctx({ userId: ownerId, roles: ['READER'] }), ctx({ userId: otherId, roles: ['ADMIN'] })]) {
    await expect(resolvers.Agent.appCount(agent, {}, principal)).resolves.toBe(0);
    await expect(resolvers.Agent.orgGrants(agent, {}, principal)).resolves.toEqual([]);
  }
});


it('conceals a response-rendering Prisma fault without rolling back the committed personal agent', async () => {
  const faultApi = new ApolloServer<Context>({
    typeDefs, formatError: formatGraphQLError,
    resolvers: { ...resolvers, Agent: { ...resolvers.Agent, appCount: () => {
      throw new Prisma.PrismaClientValidationError('orgMember.findFirst({ userId: "private-id", organizationId: null })', { clientVersion: 'test' });
    } } },
  });
  try {
    const response = await faultApi.executeOperation({ query: 'mutation { createAgent(name: "Committed response") { id appCount } }' },
      { contextValue: ctx({ userId: ownerId, roles: ['READER'] }) });
    expect(response.body.kind).toBe('single');
    if (response.body.kind !== 'single') throw new Error('Unexpected incremental response');
    expect(response.body.singleResult.errors).toHaveLength(1);
    expect(response.body.singleResult.errors![0]).toMatchObject({ message: 'Unable to complete this request. Please try again.', extensions: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(JSON.stringify(response.body.singleResult)).not.toMatch(/private-id|orgMember|stacktrace/);
    const committed = await db.agent.findUniqueOrThrow({ where: { urn: 'owner-one:committed-response' } });
    expect(committed.ownerUserId).toBe(ownerId);
    expect(await db.memory.findUnique({ where: { id: committed.systemMemoryId! } })).toMatchObject({ ownerUserId: ownerId, class: 'system' });
  } finally { await faultApi.stop(); }
});

// #1693 — a user-owned agent's owning tenant is its owner: they see its real
// adoption count, as an org agent's members do. Nobody else gains it.
it('shows the owner the adoption count of their own org-less agent, and nobody else', async () => {
  const agent = await resolvers.Mutation.createAgent({}, { name: 'Adopted helper' }, ctx({ userId: ownerId, roles: ['READER'] }));
  const personalApp = (urn: string, deletedAt: Date | null = null) =>
    db.app.create({ data: { id: generateId(), name: urn, urn: `owner-one:${urn}`, ownerUserId: ownerId, deletedAt } });
  for (const app of [await personalApp('one'), await personalApp('two'), await personalApp('gone', new Date())]) {
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  }

  // Two live installs; the deleted App does not count.
  await expect(resolvers.Agent.appCount(agent, {}, ctx({ userId: ownerId, roles: ['READER'] }))).resolves.toBe(2);
  // Through real GraphQL field rendering too (the agent page's path).
  const response = await personalAgentApi.executeOperation(
    { query: 'query($ref: ID!) { agent(ref: $ref) { appCount } }', variables: { ref: agent.id } },
    { contextValue: ctx({ userId: ownerId, roles: ['READER'] }) },
  );
  expect(response.body.kind === 'single' && response.body.singleResult).toMatchObject({ data: { agent: { appCount: 2 } } });

  for (const principal of [
    ctx({ userId: otherId, roles: ['READER'] }), // another user
    ctx({ userId: otherId, roles: ['ADMIN'] }), // a platform admin: #1692's null-org rule stands
    { ...ctx({ userId: ownerId, roles: ['READER'] }), impersonation: { orgId: generateId(), adminUserId: otherId } } as unknown as Context,
    ctx({ roles: [] }), // no user
  ]) {
    await expect(resolvers.Agent.appCount(agent, {}, principal)).resolves.toBe(0);
  }
});
