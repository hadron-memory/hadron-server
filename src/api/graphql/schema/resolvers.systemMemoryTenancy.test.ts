/**
 * #949 — an Agent's class='system' memory must share the Agent's owner.
 *
 * A mismatch is a cross-tenant leak: access to a memory follows the MEMORY's
 * owner, so a foreign-owned system memory puts one tenant's Agent design (and
 * a Team Agent's `roles:<role>` definitions + name registers,
 * `cor:agt:020:01`) inside another tenant's read/write audience.
 *
 * Covered here:
 *   - the two write paths that can attach a system memory (createAgent's
 *     promote branch, updateAgent's first-attach branch) refuse a foreign
 *     owner — including the USER-owned case, where the pre-#949 comparison
 *     read `null !== null` and admitted another user's memory
 *     (findings:org-xor-owner-null-comparison-bypass);
 *   - the audit finds an already-broken row;
 *   - `repairAgentSystemMemory` re-owns it, is idempotent, and is platform-
 *     admin-only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import {
  sameOwner,
  findSystemMemoryOwnerMismatches,
} from '../../../lib/agentSystemMemory.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

function ctx(userId?: string, roles: string[] = ['READER']): Context {
  return { db, userId, roles } as Context;
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: { id: string };
let userA: { id: string; handle: string };
let userB: { id: string; handle: string };
let platformAdmin: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({
    data: { id: generateId(), name: 'org-a', urn: `org-a-${s}.com` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'org-b', urn: `org-b-${s}.com` },
  });
  adminA = await db.user.create({
    data: { id: generateId(), githubId: 94001, githubUsername: `sm-admin-${s}`, roles: ['READER'] },
  });
  userA = await db.user.create({
    data: { id: generateId(), githubId: 94002, githubUsername: `sm-ua-${s}`, handle: `sm-ua-${s}`, roles: ['READER'] },
  });
  userB = await db.user.create({
    data: { id: generateId(), githubId: 94003, githubUsername: `sm-ub-${s}`, handle: `sm-ub-${s}`, roles: ['READER'] },
  });
  platformAdmin = await db.user.create({
    data: { id: generateId(), githubId: 94004, githubUsername: `sm-pa-${s}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: adminA.id, role: 'ADMIN' },
  });
});

describe('sameOwner', () => {
  it('matches only within the same ownership class', () => {
    expect(sameOwner({ organizationId: 'o1', ownerUserId: null }, { organizationId: 'o1', ownerUserId: null })).toBe(true);
    expect(sameOwner({ organizationId: 'o1', ownerUserId: null }, { organizationId: 'o2', ownerUserId: null })).toBe(false);
    expect(sameOwner({ organizationId: null, ownerUserId: 'u1' }, { organizationId: null, ownerUserId: 'u1' })).toBe(true);
    // The bypass: two DIFFERENT users' rows both have organizationId null.
    expect(sameOwner({ organizationId: null, ownerUserId: 'u1' }, { organizationId: null, ownerUserId: 'u2' })).toBe(false);
    // Cross-class never matches, in either direction.
    expect(sameOwner({ organizationId: 'o1', ownerUserId: null }, { organizationId: null, ownerUserId: 'u1' })).toBe(false);
    expect(sameOwner({ organizationId: null, ownerUserId: 'u1' }, { organizationId: 'o1', ownerUserId: null })).toBe(false);
    // An ownerless row fails closed rather than matching another one.
    expect(sameOwner({ organizationId: null, ownerUserId: null }, { organizationId: null, ownerUserId: null })).toBe(false);
  });
});

describe('#949 — createAgent cannot promote a foreign-owned memory', () => {
  it('refuses a memory owned by another org', async () => {
    const foreign = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgB.id,
        urn: `${orgB.urn}:foreign-brain`,
        name: 'foreign brain',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await expectCode(
      M.createAgent(
        null,
        { orgId: orgA.id, name: 'Cross Org', systemMemoryId: foreign.id },
        ctx(adminA.id),
      ),
      'SYSTEM_MEMORY_OWNER_MISMATCH',
    );
    // Nothing was created, and the foreign memory keeps its class + owner.
    const after = await db.memory.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.class).toBe('knowledge');
    expect(after.organizationId).toBe(orgB.id);
  });

  it('refuses another USER\'s memory (both organizationId columns null)', async () => {
    const theirs = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: userB.id,
        urn: `${userB.handle}:their-brain`,
        name: 'their brain',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await expectCode(
      M.createAgent(null, { name: 'Mine', systemMemoryId: theirs.id }, ctx(userA.id)),
      'SYSTEM_MEMORY_OWNER_MISMATCH',
    );
  });

  it('auto-provisions a system memory with the agent\'s own owner', async () => {
    const agent = await M.createAgent(null, { orgId: orgA.id, name: 'Owned' }, ctx(adminA.id));
    const sys = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId } });
    expect(sys.organizationId).toBe(orgA.id);
    expect(sys.ownerUserId).toBeNull();
    expect(await findSystemMemoryOwnerMismatches(db)).toEqual([]);
  });
});

describe('#949 — updateAgent first-attach cannot attach a foreign-owned memory', () => {
  it('refuses another USER\'s memory on a user-owned agent', async () => {
    // A user-owned agent with NO system memory yet (the first-attach path).
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        ownerUserId: userA.id,
        urn: `${userA.handle}:brainless`,
        name: 'Brainless',
        visibility: 'PERSONAL',
      },
    });
    const theirs = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: userB.id,
        urn: `${userB.handle}:their-other-brain`,
        name: 'their other brain',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await expectCode(
      M.updateAgent(null, { ref: agent.id, systemMemoryId: theirs.id }, ctx(userA.id)),
      'SYSTEM_MEMORY_OWNER_MISMATCH',
    );
    const untouched = await db.memory.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(untouched.class).toBe('knowledge');
    const stillBrainless = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(stillBrainless.systemMemoryId).toBeNull();
  });

  it('accepts the owner\'s own memory', async () => {
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        ownerUserId: userA.id,
        urn: `${userA.handle}:brainless-2`,
        name: 'Brainless 2',
        visibility: 'PERSONAL',
      },
    });
    const mine = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: userA.id,
        urn: `${userA.handle}:my-brain`,
        name: 'my brain',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await M.updateAgent(null, { ref: agent.id, systemMemoryId: mine.id }, ctx(userA.id));
    const promoted = await db.memory.findUniqueOrThrow({ where: { id: mine.id } });
    expect(promoted.class).toBe('system');
  });
});

describe('#949 — audit + repair of an already-broken row', () => {
  /** Build the broken state the issue reports: agent in orgA, system memory in orgB. */
  async function makeMismatch() {
    const foreignSys = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgB.id,
        urn: `${orgB.urn}:agent-team-system`,
        name: 'Agent Team System',
        class: 'system',
        acceptsUploads: false,
      },
    });
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:agent-team`,
        name: 'Agent Team',
        visibility: 'ORGANIZATION',
        systemMemoryId: foreignSys.id,
      },
    });
    return { agent, foreignSys };
  }

  it('the audit reports the mismatch', async () => {
    const { agent, foreignSys } = await makeMismatch();
    const rows = await findSystemMemoryOwnerMismatches(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe(agent.id);
    expect(rows[0].agentOrganizationId).toBe(orgA.id);
    expect(rows[0].memoryId).toBe(foreignSys.id);
    expect(rows[0].memoryOrganizationId).toBe(orgB.id);
  });

  it('repairAgentSystemMemory re-owns the memory and re-derives its URN', async () => {
    const { agent, foreignSys } = await makeMismatch();
    await M.repairAgentSystemMemory(
      null,
      { agentRef: agent.id },
      ctx(platformAdmin.id, ['ADMIN']),
    );
    const fixed = await db.memory.findUniqueOrThrow({ where: { id: foreignSys.id } });
    expect(fixed.organizationId).toBe(orgA.id);
    expect(fixed.ownerUserId).toBeNull();
    expect(fixed.urn).toBe(`${orgA.urn}:agent-team-system`);
    expect(await findSystemMemoryOwnerMismatches(db)).toEqual([]);
  });

  it('#1468 — refuses to reclaim the derived URN from a deleted minted corpus that holds a spec', async () => {
    const { agent, foreignSys } = await makeMismatch();
    const corpus = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:agent-team-system`, name: 'corpus',
        class: 'knowledge', corpusDraft: false, corpusMintedAt: new Date(Date.now() - 60_000), deletedAt: new Date(),
      },
    });
    await db.node.create({ data: { id: generateId(), memoryId: corpus.id, loc: 'pas:010', name: 'pas:010', tags: ['spec'] } });
    await expectCode(
      M.repairAgentSystemMemory(null, { agentRef: agent.id }, ctx(platformAdmin.id, ['ADMIN'])),
      'SPEC_MINTED_PERMANENT',
    );
    expect(await db.memory.findUnique({ where: { id: corpus.id } })).not.toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: foreignSys.id } })).organizationId).toBe(orgB.id);
  });

  it('is idempotent — a consistent pair is a no-op', async () => {
    const { agent } = await makeMismatch();
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    await M.repairAgentSystemMemory(null, { agentRef: agent.id }, admin);
    const first = await db.memory.findFirstOrThrow({ where: { urn: `${orgA.urn}:agent-team-system` } });
    await M.repairAgentSystemMemory(null, { agentRef: agent.id }, admin);
    const second = await db.memory.findUniqueOrThrow({ where: { id: first.id } });
    expect(second.updatedAt).toEqual(first.updatedAt);
    expect(second.organizationId).toBe(orgA.id);
  });

  it('is platform-admin only — the agent\'s own org admin is refused', async () => {
    const { agent, foreignSys } = await makeMismatch();
    await expectCode(
      M.repairAgentSystemMemory(null, { agentRef: agent.id }, ctx(adminA.id)),
      'FORBIDDEN',
    );
    const untouched = await db.memory.findUniqueOrThrow({ where: { id: foreignSys.id } });
    expect(untouched.organizationId).toBe(orgB.id);
  });

  it('refuses an agent with no system memory', async () => {
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:no-brain`,
        name: 'No Brain',
        visibility: 'ORGANIZATION',
      },
    });
    await expectCode(
      M.repairAgentSystemMemory(null, { agentRef: agent.id }, ctx(platformAdmin.id, ['ADMIN'])),
      'AGENT_HAS_NO_SYSTEM_MEMORY',
    );
  });
});
