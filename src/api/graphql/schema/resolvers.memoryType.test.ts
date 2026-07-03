import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

// Prevent git writes
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgA: { id: string; urn: string };
let adminUser: { id: string };

function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: adminUser.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'org-a', urn: 'org-a' },
  });
  adminUser = await db.user.create({
    data: { githubId: 9001, githubUsername: 'admin-user', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
  });
});

// ---------------------------------------------------------------------------
// createMemory with type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// #281 — knowledge-class memories default to a usable semantic index:
// vectorIndexEnabled=true, embeddingSource=contentChunks (so any node with
// content is retrievable immediately, no abstract authoring needed).
// ---------------------------------------------------------------------------

describe('createMemory vector-index defaults (#281)', () => {
  it('defaults a knowledge memory to vectorIndexEnabled + contentChunks', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'kb' },
      adminCtx(),
    );
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.class).toBe('knowledge');
    expect(row.vectorIndexEnabled).toBe(true);
    expect(row.embeddingSource).toBe('contentChunks');
  });

  it('keeps the column defaults (off / abstract) for a non-knowledge class', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'team', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(),
    );
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.class).toBe('group');
    expect(row.vectorIndexEnabled).toBe(false);
    expect(row.embeddingSource).toBe('abstract');
  });

  it('honors explicit caller-provided values over the knowledge default', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      {
        orgId: orgA.id,
        name: 'kb-explicit',
        vectorIndexEnabled: false,
        embeddingSource: 'abstract',
      },
      adminCtx(),
    );
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.vectorIndexEnabled).toBe(false);
    expect(row.embeddingSource).toBe('abstract');
  });

  it('treats an explicit null as unspecified (falls back to the knowledge default)', async () => {
    // Both fields are nullable in the GraphQL schema, so a client can send
    // `null`. We coalesce that to the class default rather than forwarding it
    // to Prisma (the column is non-nullable — null would be a runtime error).
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'kb-null', vectorIndexEnabled: null, embeddingSource: null },
      adminCtx(),
    );
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.vectorIndexEnabled).toBe(true);
    expect(row.embeddingSource).toBe('contentChunks');
  });

  it('honors an explicit opt-in on a non-knowledge class', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      {
        orgId: orgA.id,
        name: 'team-indexed',
        memoryClass: 'group',
        visibility: 'GROUP',
        vectorIndexEnabled: true,
        embeddingSource: 'both',
      },
      adminCtx(),
    );
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.vectorIndexEnabled).toBe(true);
    expect(row.embeddingSource).toBe('both');
  });
});

// ---------------------------------------------------------------------------
// First-attach flow: updateAgent sets systemMemoryId → memory becomes
// class='system'. 035-visibility-enum-cleanup removed the `type` column;
// `class` is authoritative, and the attach clears the memory's visibility.
// ---------------------------------------------------------------------------

describe('updateAgent first-attach of systemMemoryId', () => {
  it('marks the target memory as class=system, renames it, clears visibility', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno', visibility: 'ORGANIZATION' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );

    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );

    const updated = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(updated.class).toBe('system');
    expect(updated.name).toBe('juno System');
    // 035: agent visibility no longer syncs onto the system memory — it is
    // always NULL (chk_memory_visibility_class).
    expect(updated.visibility).toBeNull();
  });

  it('refuses a memory from a different org', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'org-b', urn: 'org-b' },
    });
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const foreign = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        urn: 'org-b:foreign',
        name: 'foreign',
            class: 'knowledge',
      },
    });
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { id: agent.id, systemMemoryId: foreign.id },
        adminCtx(),
      ),
    ).rejects.toThrow(/same organization/);
  });

  it('refuses a memory already attached to another agent', async () => {
    const agent1 = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const agent2 = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'other' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'shared-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent1.id, systemMemoryId: mem.id },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { id: agent2.id, systemMemoryId: mem.id },
        adminCtx(),
      ),
    ).rejects.toThrow(/another agent/);
  });
});

// ---------------------------------------------------------------------------
// updateAgent: cannot unset or change an existing systemMemoryId
// ---------------------------------------------------------------------------

describe('updateAgent lock on existing systemMemoryId', () => {
  async function agentWithSystem() {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );
    return { agent, mem };
  }

  it('refuses to unset systemMemoryId', async () => {
    const { agent } = await agentWithSystem();
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { id: agent.id, systemMemoryId: '' },
        adminCtx(),
      ),
    ).rejects.toThrow(/unset or change/);
  });

  it('refuses to change systemMemoryId to a different memory', async () => {
    const { agent } = await agentWithSystem();
    const other = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'other-brain' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { id: agent.id, systemMemoryId: other.id },
        adminCtx(),
      ),
    ).rejects.toThrow(/unset or change/);
  });
});

// ---------------------------------------------------------------------------
// Name + visibility sync
// ---------------------------------------------------------------------------

describe('agent → system memory sync', () => {
  it('renames the system memory when the agent is renamed', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );

    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, name: 'juno2' },
      adminCtx(),
    );

    const synced = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(synced.name).toBe('juno2 System');
  });

  // 035-visibility-enum-cleanup: agent visibility NO LONGER syncs onto the
  // system memory — a system memory's visibility is always NULL. This is the
  // inverse of the old "syncs visibility" behavior.
  it('does not propagate agent visibility onto the system memory', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno', visibility: 'PERSONAL' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );

    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, visibility: 'ORGANIZATION' },
      adminCtx(),
    );

    const synced = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(synced.visibility).toBeNull();
    // The agent itself still tracks the update.
    const reloaded = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(reloaded.visibility).toBe('ORGANIZATION');
  });
});

// ---------------------------------------------------------------------------
// Guards on addMemoryToAgent and deleteMemory
// ---------------------------------------------------------------------------

describe('AGENT_SYSTEM memory guards', () => {
  it('refuses to attach an AGENT_SYSTEM memory via addMemoryToAgent', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );

    const other = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'other' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.addMemoryToAgent(
        {},
        { agentId: other.id, memoryId: mem.id, role: 'read' },
        adminCtx(),
      ),
    ).rejects.toThrow(/systemMemoryId/);
  });

  it('refuses to delete an AGENT_SYSTEM memory directly', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );

    await expect(
      resolvers.Mutation.deleteMemory({}, { id: mem.id }, adminCtx()),
    ).rejects.toThrow(/system memory/);
  });

  // 007-entity-id-or-urn: addMemoryToAgent / updateAgentMemoryRole /
  // removeMemoryFromAgent now accept ID or URN for both agentId and
  // memoryId arguments. Paired tests below exercise both input shapes.

  it('addMemoryToAgent accepts URN for both agentId and memoryId', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'agent-urn-input' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'mem-urn-input' },
      adminCtx(),
    );
    await resolvers.Mutation.addMemoryToAgent(
      {},
      { agentId: agent.urn, memoryId: mem.urn, role: 'read' },
      adminCtx(),
    );
    const items = await db.agentMemoryItem.findMany({
      where: { agentId: agent.id, memoryId: mem.id },
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.role).toBe('read');
  });

  it('updateAgentMemoryRole accepts URN for both agentId and memoryId', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'agent-update-urn' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'mem-update-urn' },
      adminCtx(),
    );
    await resolvers.Mutation.addMemoryToAgent(
      {},
      { agentId: agent.id, memoryId: mem.id, role: 'read' },
      adminCtx(),
    );
    // Update by URN.
    await resolvers.Mutation.updateAgentMemoryRole(
      {},
      { agentId: agent.urn, memoryId: mem.urn, role: 'read-write' },
      adminCtx(),
    );
    const item = await db.agentMemoryItem.findUniqueOrThrow({
      where: { agentId_memoryId: { agentId: agent.id, memoryId: mem.id } },
    });
    expect(item.role).toBe('read-write');
  });

  it('removeMemoryFromAgent accepts URN for both agentId and memoryId', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'agent-remove-urn' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'mem-remove-urn' },
      adminCtx(),
    );
    await resolvers.Mutation.addMemoryToAgent(
      {},
      { agentId: agent.id, memoryId: mem.id, role: 'read' },
      adminCtx(),
    );
    await resolvers.Mutation.removeMemoryFromAgent(
      {},
      { agentId: agent.urn, memoryId: mem.urn },
      adminCtx(),
    );
    const items = await db.agentMemoryItem.findMany({
      where: { agentId: agent.id, memoryId: mem.id },
    });
    expect(items).toHaveLength(0);
  });

  it('cascades system memory deletion when the agent is deleted', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );

    await resolvers.Mutation.deleteAgent({}, { id: agent.id }, adminCtx());

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.deletedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Listing filters
// ---------------------------------------------------------------------------

describe('memory list filtering', () => {
  async function setupTwoMemories() {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const sys = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: sys.id },
      adminCtx(),
    );
    const knowledge = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'knowledge' },
      adminCtx(),
    );
    return { sys, knowledge };
  }

  it('org.memories excludes AGENT_SYSTEM by default', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    const org = await resolvers.Query.organization(
      {},
      { id: orgA.id },
      adminCtx(),
    );
    const urns = org?.memories.map((m: { id: string }) => m.id) ?? [];
    expect(urns).toContain(knowledge.id);
    expect(urns).not.toContain(sys.id);
  });

  it('myMemories hides AGENT_SYSTEM by default', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    const list = await resolvers.Query.myMemories({}, {}, adminCtx());
    const ids = list.map((m: { id: string }) => m.id);
    expect(ids).toContain(knowledge.id);
    expect(ids).not.toContain(sys.id);
  });

  it('myMemories(memoryClasses:) including system surfaces AGENT_SYSTEM', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    const list = await resolvers.Query.myMemories(
      {},
      { memoryClasses: ['system', 'knowledge'] },
      adminCtx(),
    );
    const ids = list.map((m: { id: string }) => m.id);
    expect(ids).toContain(knowledge.id);
    expect(ids).toContain(sys.id);
  });

  it('myMemories(memoryClasses:) restricts to exactly the listed classes', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    // Only system → the knowledge memory is excluded.
    const onlySystem = await resolvers.Query.myMemories({}, { memoryClasses: ['system'] }, adminCtx());
    const sysIds = onlySystem.map((m: { id: string }) => m.id);
    expect(sysIds).toContain(sys.id);
    expect(sysIds).not.toContain(knowledge.id);
    // Only knowledge → the system memory is excluded (same as the default).
    const onlyKnowledge = await resolvers.Query.myMemories({}, { memoryClasses: ['knowledge'] }, adminCtx());
    const kIds = onlyKnowledge.map((m: { id: string }) => m.id);
    expect(kIds).toContain(knowledge.id);
    expect(kIds).not.toContain(sys.id);
  });
});

// ---------------------------------------------------------------------------
// Memory.agent derived field
// ---------------------------------------------------------------------------

describe('Memory.agent derived field', () => {
  it('returns the owning agent for an AGENT_SYSTEM memory', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno' },
      adminCtx(),
    );
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { id: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );
    const updated = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });

    const resolved = await resolvers.Memory.agent(
      { id: updated.id, class: updated.class },
      {},
      { db } as Context,
    );
    expect(resolved?.id).toBe(agent.id);
  });

  it('returns null for a regular knowledge memory', async () => {
    const m = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'knowledge' },
      adminCtx(),
    );
    const resolved = await resolvers.Memory.agent(
      { id: m.id, class: m.class },
      {},
      { db } as Context,
    );
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spec 013-soft-delete-memory — class-aware authz + idempotency on
// deleteMemory. The pre-existing AGENT_SYSTEM-guard test above (line ~299)
// is the regression we intentionally do NOT duplicate here.
// ---------------------------------------------------------------------------

describe('deleteMemory (spec 013)', () => {
  it('admin can soft-delete a knowledge-class memory and sets deletedAt', async () => {
    const m = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'doomed' },
      adminCtx(),
    );
    const result = await resolvers.Mutation.deleteMemory(
      {},
      { id: m.id },
      adminCtx(),
    );
    expect(result).toBe(true);
    const after = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.deletedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: re-delete preserves the original deletedAt', async () => {
    const m = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'doomed-twice' },
      adminCtx(),
    );
    await resolvers.Mutation.deleteMemory({}, { id: m.id }, adminCtx());
    const firstSnapshot = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(firstSnapshot.deletedAt).toBeInstanceOf(Date);
    const firstTs = firstSnapshot.deletedAt!.getTime();

    // Tiny pause so a wrongly-overwritten timestamp would be detectably newer.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondResult = await resolvers.Mutation.deleteMemory(
      {},
      { id: m.id },
      adminCtx(),
    );
    expect(secondResult).toBe(true);
    const secondSnapshot = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(secondSnapshot.deletedAt!.getTime()).toBe(firstTs);
  });

  describe('personal-class authz', () => {
    let owner: { id: string };
    let nonOwner: { id: string };
    let app: { id: string; urn: string };
    let agent: { id: string };
    let personalMemory: { id: string };

    beforeEach(async () => {
      owner = await db.user.create({
        data: { githubId: 9101, githubUsername: 'personal-owner' },
      });
      nonOwner = await db.user.create({
        data: { githubId: 9102, githubUsername: 'random-user' },
      });
      // Both users are members of orgA so the test can verify org-membership
      // alone does NOT confer delete authority on personal-class memories.
      await db.orgMember.create({
        data: { organizationId: orgA.id, userId: owner.id, role: 'CONTRIBUTOR' },
      });
      await db.orgMember.create({
        data: { organizationId: orgA.id, userId: nonOwner.id, role: 'CONTRIBUTOR' },
      });
      // Personal-class memories require an App (chk_memory_class_app_id) and
      // an Agent pivot (chk_memory_personal_agent_id, 023 FR-004/FR-032).
      agent = await db.agent.create({
        data: {
          id: generateId(),
          name: 'test-agent',
          urn: `${orgA.urn}:test-agent`,
          organizationId: orgA.id,
        },
      });
      app = await db.app.create({
        data: {
          id: generateId(),
          name: 'test-app',
          urn: `${orgA.urn}:test-app`,
          organizationId: orgA.id,
        },
      });
      const m = await db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgA.id,
          urn: `${app.urn}:owner-personal`,
          name: 'Owner personal memory',
          class: 'personal',
          userId: owner.id,
          appId: app.id,
          userMemoryOfAgentId: agent.id,
        },
      });
      personalMemory = { id: m.id };
    });

    it('owner can delete', async () => {
      const result = await resolvers.Mutation.deleteMemory(
        {},
        { id: personalMemory.id },
        { db, userId: owner.id },
      );
      expect(result).toBe(true);
      const after = await db.memory.findUniqueOrThrow({
        where: { id: personalMemory.id },
      });
      expect(after.deletedAt).toBeInstanceOf(Date);
    });

    it('org admin (non-owner) cannot delete', async () => {
      // adminUser is an ADMIN of orgA but is NOT the owner of personalMemory.
      // The personal-class branch must reject regardless of org role.
      await expect(
        resolvers.Mutation.deleteMemory({}, { id: personalMemory.id }, adminCtx()),
      ).rejects.toThrow(/only the owner can delete a personal memory/);
      const after = await db.memory.findUniqueOrThrow({
        where: { id: personalMemory.id },
      });
      expect(after.deletedAt).toBeNull();
    });

    it('non-owner non-admin user cannot delete', async () => {
      await expect(
        resolvers.Mutation.deleteMemory(
          {},
          { id: personalMemory.id },
          { db, userId: nonOwner.id },
        ),
      ).rejects.toThrow(/only the owner can delete a personal memory/);
      const after = await db.memory.findUniqueOrThrow({
        where: { id: personalMemory.id },
      });
      expect(after.deletedAt).toBeNull();
    });

    it('unauthenticated caller cannot delete', async () => {
      await expect(
        resolvers.Mutation.deleteMemory(
          {},
          { id: personalMemory.id },
          { db },
        ),
      ).rejects.toThrow(/only the owner can delete a personal memory/);
    });

    it('personal-class authz is idempotent for the owner', async () => {
      await resolvers.Mutation.deleteMemory(
        {},
        { id: personalMemory.id },
        { db, userId: owner.id },
      );
      const first = await db.memory.findUniqueOrThrow({
        where: { id: personalMemory.id },
      });
      const firstTs = first.deletedAt!.getTime();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const secondResult = await resolvers.Mutation.deleteMemory(
        {},
        { id: personalMemory.id },
        { db, userId: owner.id },
      );
      expect(secondResult).toBe(true);
      const second = await db.memory.findUniqueOrThrow({
        where: { id: personalMemory.id },
      });
      expect(second.deletedAt!.getTime()).toBe(firstTs);
    });
  });

  // T010 (US2 regression): myMemories must filter out soft-deleted memories.
  // Live, the resolver at resolvers.ts:1607 explicitly applies
  // `deletedAt: null` (line 1651). This test pins that behavior so a
  // future refactor can't silently drop the filter.
  it('myMemories does not include a soft-deleted memory', async () => {
    const live = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'still-here' },
      adminCtx(),
    );
    const doomed = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'gone-soon' },
      adminCtx(),
    );
    await resolvers.Mutation.deleteMemory({}, { id: doomed.id }, adminCtx());
    const list = await resolvers.Query.myMemories({}, {}, adminCtx());
    const ids = (list as { id: string }[]).map((m) => m.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(doomed.id);
  });
});
