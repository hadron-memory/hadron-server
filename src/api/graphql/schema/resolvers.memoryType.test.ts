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

describe('createMemory with type', () => {
  it('defaults to KNOWLEDGE', async () => {
    const m = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'my-knowledge' },
      adminCtx(),
    );
    expect(m.type).toBe('KNOWLEDGE');
  });

  it('accepts AGENT_SYSTEM', async () => {
    const m = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system', type: 'AGENT_SYSTEM' },
      adminCtx(),
    );
    expect(m.type).toBe('AGENT_SYSTEM');
  });
});

// ---------------------------------------------------------------------------
// First-attach flow: updateAgent sets systemMemoryId → memory becomes AGENT_SYSTEM
// ---------------------------------------------------------------------------

describe('updateAgent first-attach of systemMemoryId', () => {
  it('marks the target memory as AGENT_SYSTEM and renames it', async () => {
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
    expect(updated.type).toBe('AGENT_SYSTEM');
    expect(updated.name).toBe('juno System');
    expect(updated.visibility).toBe('ORGANIZATION');
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

  it('syncs visibility when the agent is updated', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'juno', visibility: 'PRIVATE' },
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
    expect(synced.visibility).toBe('ORGANIZATION');
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

  it('myMemories includes AGENT_SYSTEM when requested', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    const list = await resolvers.Query.myMemories(
      {},
      { includeAgentSystem: true },
      adminCtx(),
    );
    const ids = list.map((m: { id: string }) => m.id);
    expect(ids).toContain(knowledge.id);
    expect(ids).toContain(sys.id);
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
      { id: updated.id, type: updated.type },
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
      { id: m.id, type: m.type },
      {},
      { db } as Context,
    );
    expect(resolved).toBeNull();
  });
});
