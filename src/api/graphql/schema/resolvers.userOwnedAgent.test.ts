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
import { canReadMemory, canWriteToMemory } from '../../../mcp/access-control.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';

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

  it('Query.memory: the owner reads the system memory; so does a platform admin (#1787 flips #676); another user does not', async () => {
    const agent = await makeUserOwnedAgent();
    const memId = agent.systemMemoryId!;

    const asOwner = await resolvers.Query.memory(null, { ref: memId }, ctx({ userId: ownerId, roles: ['READER'] }));
    expect(asOwner?.id).toBe(memId);

    // #1787 (cor:dmo:050:13): the definition is readable by a platform admin
    // who may manage the Agent — flipping #676's owner-only pin. Read-only:
    // the definition's editor stays the agent-ownership surface.
    const asAdmin = await resolvers.Query.memory(null, { ref: memId }, ctx({ userId: otherId, roles: ['ADMIN'] }));
    expect(asAdmin?.id).toBe(memId);

    await expect(
      resolvers.Query.memory(null, { ref: memId }, ctx({ userId: otherId, roles: ['READER'] })),
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

    // #1787 (cor:dmo:050:13): the admin can now OPEN the agent, so the
    // self-audit (cor:acl:060:01's 2026-09-26 amendment keys on openability)
    // answers with the manage grant instead of missing — and the audit
    // surface agrees with the gate. The subject's platform role is re-read
    // from the user row (#1731), so the fixture carries a real grant.
    await db.user.update({ where: { id: otherId }, data: { roles: ['ADMIN'] } });
    const asAdmin = await resolvers.Query.effectiveAccess(
      null,
      { user: otherId, resource: agentUrn },
      ctx({ userId: otherId, roles: ['ADMIN'] }),
    );
    expect(asAdmin.canRead).toBe(true);
    expect(asAdmin.canManage).toBe(true);

    // An ordinary user still cannot open it — the self-audit stays missing.
    await expect(
      resolvers.Query.effectiveAccess(
        null,
        { user: otherId, resource: agentUrn },
        ctx({ userId: otherId, roles: ['READER'] }),
      ),
    ).rejects.toThrow('Resource not found');
  });
});



// ── #1787 — platform admins manage user-owned Agents (cor:dmo:050:13) ──────

describe('#1787 — a platform admin manages a user-owned Agent (cor:dmo:050:13, ruling #8895)', () => {
  async function rogueAgent() {
    return resolvers.Mutation.createAgent(
      {}, { name: 'Rogue Helper' }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
  }
  const admin = () => ctx({ userId: otherId, roles: ['ADMIN'] });

  it('reads, updates and deletes a user-owned Agent it does not own', async () => {
    // Mutations re-read platform roles under the authority fence; the positive
    // fixture must persist its ADMIN grant rather than only claiming it in ctx.
    await db.user.update({ where: { id: otherId }, data: { roles: ['ADMIN'] } });
    const agent = await rogueAgent();

    const read = await resolvers.Query.agent(null, { ref: agent.id }, admin());
    expect(read?.id).toBe(agent.id);

    const updated = await resolvers.Mutation.updateAgent(
      null, { ref: agent.id, name: 'Shut down by admin' }, admin(),
    );
    expect(updated.name).toBe('Shut down by admin');
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).ownerUserId).toBe(ownerId);

    expect(await resolvers.Mutation.deleteAgent(null, { ref: agent.id }, admin())).toBe(true);
    expect(await db.agent.findFirst({ where: { id: agent.id, deletedAt: null } })).toBeNull();
    expect(await db.memory.findFirst({ where: { id: agent.systemMemoryId!, deletedAt: null } })).toBeNull();
  });

  it('an org-owned agent still reads for a platform admin through the wrapper (Emerson P3: delegation pin)', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'Org1787', urn: `org1787-${generateId().slice(0, 6)}.test` } });
    const orgAgent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `org1787.test:helper`, name: 'Org Helper', visibility: 'ORGANIZATION' },
    });
    // The wrapper must delegate org-owned agents unchanged: the platform-admin
    // arm fires only on the user-owned shape.
    expect((await resolvers.Query.agent(null, { ref: orgAgent.id }, admin()))?.id).toBe(orgAgent.id);
    // #1944: a non-member can't read it, so it reads as absent.
    expect(await resolvers.Query.agent(null, { ref: orgAgent.id }, ctx({ userId: otherId, roles: ['READER'] }))).toBeNull();
  });

  it('an ordinary non-owner is still refused everywhere', async () => {
    const agent = await rogueAgent();
    const ordinary = ctx({ userId: otherId, roles: ['READER'] });
    // #1944: refused as absent, since an ordinary non-owner can't read it.
    expect(await resolvers.Query.agent(null, { ref: agent.id }, ordinary)).toBeNull();
    await expect(resolvers.Mutation.updateAgent(null, { ref: agent.id, name: 'X' }, ordinary)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(resolvers.Mutation.deleteAgent(null, { ref: agent.id }, ordinary)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(resolvers.Query.memory(null, { ref: agent.systemMemoryId! }, ordinary)).resolves.toBeNull();
  });

  it("the decrypted AI key stays owner-only: agentAIConfig refuses the admin (#8075 split, manage yes / read the key no)", async () => {
    const agent = await rogueAgent();
    await db.aiServiceConfig.create({
      data: {
        id: generateId(), agentId: agent.id, name: 'default', provider: 'openai',
        apiKeyEncrypted: encryptToken('sk-live-1787'), model: 'gpt-test', createdBy: ownerId,
      },
    });
    await expect(resolvers.Query.agentAIConfig(null, { agentRef: agent.id }, admin())).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const ownerCfg = await resolvers.Query.agentAIConfig(
      null, { agentRef: agent.id }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(ownerCfg?.apiKey).toBe('sk-live-1787');
  });

  it('an impersonated platform-admin session gains nothing', async () => {
    const agent = await rogueAgent();
    const imp = { orgId: 'some-org', sessionId: 'imp-session', actorUserId: otherId };
    const impAdmin = ctx({ userId: otherId, roles: ['ADMIN'], impersonation: imp as never });
    // #1944: impersonation gains no read, so the Agent reads as absent.
    expect(await resolvers.Query.agent(null, { ref: agent.id }, impAdmin)).toBeNull();
    await expect(resolvers.Mutation.deleteAgent(null, { ref: agent.id }, impAdmin)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(resolvers.Query.memory(null, { ref: agent.systemMemoryId! }, impAdmin)).resolves.toBeNull();
  });

  it("the owner's personal memories and user secrets stay closed to the platform admin", async () => {
    const agent = await rogueAgent();
    const personal = await db.memory.create({
      data: {
        id: generateId(), class: 'personal', userId: ownerId,
        ownerUserId: ownerId, organizationId: null,
        urn: `owner-one:diary-${generateId().slice(0, 6)}`, name: 'Diary',
      },
    });
    await expect(resolvers.Query.memory(null, { ref: personal.id }, admin())).resolves.toBeNull();
    await db.secret.create({
      data: { ownerType: 'user', ownerId, name: 'api', kind: 'bearer', metadata: {}, valueEncrypted: encryptToken('sekret') },
    });
    const page = await resolvers.Query.secrets(
      null, { ownerType: 'user', ownerRef: ownerId }, admin(),
    );
    expect(page.items ?? []).toEqual([]);
  });

  it('MCP node content of the definition stays CLOSED to the platform admin (#1818 review, Chip #9695 / Rook P2-2)', async () => {
    const agent = await rogueAgent();
    const memId = agent.systemMemoryId!;
    // hadron_get_node / hadron_list_nodes gate through canReadMemory ->
    // canReadMemoryRow; the admin's definition reach is the RECORD read
    // (Query.memory) plus the audit surfaces, NOT node content — on either
    // surface. GraphQL's node gate was never widened; MCP's now matches.
    expect(await canReadMemory(db, { userId: otherId, roles: ['ADMIN'] } as never, memId)).toBe(false);
    expect(await canReadMemory(db, { userId: otherId, roles: ['READER'] } as never, memId)).toBe(false);
    // #2206 case 2 (cor:dmo:050:13; Vera's FIT on #2206, 6325610986): managing the Agent includes WRITING its system
    // memory, so the admin writes it. The write is never a content read: its response is concealed and move, merge
    // and search-replace refuse (src/mcp/systemMemoryWrite2206.test.ts). Content stays closed until #1734.
    expect(await canWriteToMemory(db, { userId: otherId, roles: ['ADMIN'] } as never, memId)).toBe(true);
    // The record read the ruling grants stays open over GraphQL.
    expect((await resolvers.Query.memory(null, { ref: memId }, admin()))?.id).toBe(memId);
  });

  it("the stored key cannot be moved: config set/update/test stay owner-only on a user-owned Agent (Rook P2-1)", async () => {
    // #1882: the clear rechecks live platform authority, not only the ctx claim.
    await db.user.update({ where: { id: otherId }, data: { roles: ['ADMIN'] } });
    const agent = await rogueAgent();
    const cfg = await db.aiServiceConfig.create({
      data: {
        id: generateId(), agentId: agent.id, name: 'default', provider: 'openai', model: 'gpt-test',
        apiKeyEncrypted: encryptToken('sk-owner-secret'), createdBy: ownerId,
      },
    });
    // The registry gate (update / test / delete) is owner-only for a user-owned
    // Agent: an update that keeps the key under a changed endpoint, or a test
    // with an override, would send the user's stored key to a caller-chosen
    // endpoint — exactly what cor:dmo:050:13 withholds (#8075).
    // The typed code each op actually carries on the wire (#1841): update and
    // delete refuse at the gate (FORBIDDEN); test CONCEALS the refusal as
    // AiServiceConfigNotFoundError (testAiServiceConfig.ts:360 — no oracle
    // over config ids). Each is the refusal — pinned per op, not assumed
    // uniform.
    await expect(resolvers.Mutation.updateAiServiceConfig(
      null, { id: cfg.id, endpoint: 'https://attacker.example' }, admin(),
    )).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(resolvers.Mutation.testAiServiceConfig(null, { id: cfg.id }, admin())).rejects.toMatchObject({ extensions: { code: 'AiServiceConfigNotFoundError' } });
    await expect(resolvers.Mutation.deleteAiServiceConfig(null, { id: cfg.id }, admin())).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    // The agentAIConfig upsert has the same kept-key shape — owner-only too.
    await expect(resolvers.Mutation.updateAgentAIConfig(
      null, { agentId: agent.id, provider: 'openai', model: 'gpt-x' }, admin(),
    )).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    // Clearing is pure deletion (no exfil): the admin arm holds, covering shutdown.
    expect(await resolvers.Mutation.clearAgentAIConfig(null, { agentId: agent.id }, admin())).not.toBeNull();
    // Owner control: set still works for the owner (with a key — the admin's
    // clear above removed the stored one). The test operation is not exercised
    // for the owner: it would call the real provider; its owner path is
    // unchanged by this diff and covered by the 036 suites.
    const set = await resolvers.Mutation.updateAgentAIConfig(
      null, { agentId: agent.id, provider: 'openai', model: 'gpt-x', apiKey: 'sk-owner-new' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(set).not.toBeNull();
    expect(await db.aiServiceConfig.findFirst({ where: { agentId: agent.id, name: 'default', apiKeyEncrypted: { not: null } } })).not.toBeNull();
  });

  it('first-attach of a system memory on a user-owned Agent is the owner\'s act (Emerson P2-C)', async () => {
    const agent = await rogueAgent();
    // An unattached user-owned memory of the SAME owner — the admin must not
    // be able to promote it to the agent's "definition" and thereby read it.
    const victimMemory = await db.memory.create({
      data: {
        id: generateId(), class: 'knowledge', ownerUserId: ownerId, organizationId: null,
        urn: `owner-one:notes-${generateId().slice(0, 6)}`, name: 'Owner notes',
      },
    });
    await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: null } });
    await expect(
      resolvers.Mutation.updateAgent(null, { ref: agent.id, systemMemoryId: victimMemory.id }, admin()),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const untouched = await db.memory.findUniqueOrThrow({ where: { id: victimMemory.id } });
    expect(untouched.class).toBe('knowledge');
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).systemMemoryId).toBeNull();
    // Owner control: the wizard-flow first-attach still works for the owner.
    const ownerAttach = await resolvers.Mutation.updateAgent(
      null, { ref: agent.id, systemMemoryId: victimMemory.id }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(ownerAttach.systemMemoryId).toBe(victimMemory.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: victimMemory.id } })).class).toBe('system');
  });

  it('the admin may update the definition through the revision surface (within "update it"; PR body corrected)', async () => {
    const agent = await rogueAgent();
    const revision = await resolvers.Mutation.createRevision(null, { agentId: agent.id, description: 'admin snapshot' }, admin());
    expect(revision).not.toBeNull();
  });

  it('the admin restores a definition revision too (#1841: the revision surface is pinned at both ends)', async () => {
    const agent = await rogueAgent();
    const revision = await resolvers.Mutation.createRevision(null, { agentId: agent.id, description: 'to restore' }, admin());
    expect(revision.revisionLoc).toMatch(/^revisions:/);
    const restored = await resolvers.Mutation.restoreRevision(null, { agentId: agent.id, revisionLoc: revision.revisionLoc }, admin());
    expect(restored).not.toBeNull();
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
