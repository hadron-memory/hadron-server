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
// Helpers for the system-memory tests.
//
// createAgent now auto-provisions a class='system' memory for every agent
// (regardless of the legacy ASSISTANT/CHATBOT type), so most tests can read the
// owned system memory straight off `agent.systemMemoryId`. The updateAgent
// first-attach path only ever fires for LEGACY agents (systemMemoryId=null),
// which we build via a raw db.agent.create that bypasses the resolver.
// ---------------------------------------------------------------------------

/** Create an agent through the resolver and return it plus its auto-provisioned system memory. */
async function createAgentWithSystem(name: string, extra: Record<string, unknown> = {}) {
  const agent = await resolvers.Mutation.createAgent(
    {},
    { orgId: orgA.id, name, ...extra },
    adminCtx(),
  );
  const sys = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } });
  return { agent, sys };
}

/** Create a legacy agent (no system memory) directly, to exercise the first-attach path. */
async function createLegacyAgent(name: string) {
  return db.agent.create({
    data: { id: generateId(), name, urn: `${orgA.urn}:${name}`, organizationId: orgA.id },
  });
}

// ---------------------------------------------------------------------------
// Auto-provisioning: every agent owns a class='system' memory from birth
// (cor:dmo:050:01, GH #518). Regardless of type, no caller-supplied
// systemMemoryId required.
// ---------------------------------------------------------------------------

describe('createAgent auto-provisions a system memory', () => {
  it('creates and attaches a class=system memory (URN derived from the agent, name synced, visibility NULL)', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'solo' },
      adminCtx(),
    );
    expect(agent.systemMemoryId).toBeTruthy();
    const sys = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } });
    expect(sys.class).toBe('system');
    expect(sys.urn).toBe(`${agent.urn}-system`);
    expect(sys.name).toBe('solo System');
    // chk_memory_visibility_class forbids a non-null visibility on class='system'.
    expect(sys.visibility).toBeNull();
  });

  it('provisions a system memory even for an ASSISTANT (no systemMemoryId supplied)', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'assistant-1', type: 'ASSISTANT' },
      adminCtx(),
    );
    expect(agent.type).toBe('ASSISTANT');
    expect(agent.systemMemoryId).toBeTruthy();
    const sys = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } });
    expect(sys.class).toBe('system');
  });

  it('promotes a caller-supplied systemMemoryId instead of provisioning a new one', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'byo-brain' },
      adminCtx(),
    );
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'wizard-agent', systemMemoryId: mem.id },
      adminCtx(),
    );
    expect(agent.systemMemoryId).toBe(mem.id);
    const promoted = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(promoted.class).toBe('system');
    expect(promoted.name).toBe('wizard-agent System');
    // system-class memories must opt out of uploads (schema.prisma) — the
    // promote path forces it even though createMemory defaulted it true.
    expect(promoted.acceptsUploads).toBe(false);
  });

  // #519 review (P2): a system memory holds conversation design, not assets —
  // the auto-provisioned one must opt out of uploads (DB default is true).
  it('opts the auto-provisioned system memory out of uploads', async () => {
    const { sys } = await createAgentWithSystem('no-uploads');
    expect(sys.acceptsUploads).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #519 review (P2): the auto-provisioned system memory's URN is derived from
// the agent URN, so a rename must move it in lockstep — otherwise the old
// `${slug}-system` memory keeps the old slug reserved and blocks re-creating
// an agent at that slug.
// ---------------------------------------------------------------------------

describe('updateAgent syncs the derived system-memory URN on rename', () => {
  it('moves `${slug}-system` in lockstep with the agent URN', async () => {
    const { agent, sys } = await createAgentWithSystem('renamer');
    expect(sys.urn).toBe(`${orgA.urn}:renamer-system`);

    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, urn: 'renamed' },
      adminCtx(),
    );

    const movedSys = await db.memory.findUniqueOrThrow({ where: { id: sys.id } });
    expect(movedSys.urn).toBe(`${orgA.urn}:renamed-system`);
  });

  it('frees the old slug so a new agent can be created there', async () => {
    const { agent } = await createAgentWithSystem('reuse-me');
    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, urn: 'moved-away' },
      adminCtx(),
    );

    // Re-creating an agent at the vacated slug must succeed (previously the
    // stale `reuse-me-system` memory blocked it on the URN-reclaim check).
    const fresh = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'reuse-me' },
      adminCtx(),
    );
    expect(fresh.systemMemoryId).toBeTruthy();
    const freshSys = await db.memory.findUniqueOrThrow({ where: { id: fresh.systemMemoryId! } });
    expect(freshSys.urn).toBe(`${orgA.urn}:reuse-me-system`);
  });

  it('leaves a wizard-supplied (non-derived) system-memory URN untouched on rename', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'custom-brain' },
      adminCtx(),
    );
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'wiz', systemMemoryId: mem.id },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, urn: 'wiz-renamed' },
      adminCtx(),
    );
    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe(`${orgA.urn}:custom-brain`);
  });
});

// ---------------------------------------------------------------------------
// First-attach flow (LEGACY agents only): updateAgent sets systemMemoryId on
// an agent that has none → memory becomes class='system'.
// 035-visibility-enum-cleanup removed the `type` column; `class` is
// authoritative, and the attach clears the memory's visibility.
// ---------------------------------------------------------------------------

describe('updateAgent first-attach of systemMemoryId (legacy agents)', () => {
  it('marks the target memory as class=system, renames it, clears visibility', async () => {
    const agent = await createLegacyAgent('juno');
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'juno-system' },
      adminCtx(),
    );

    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, systemMemoryId: mem.id },
      adminCtx(),
    );

    const updated = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(updated.class).toBe('system');
    expect(updated.name).toBe('juno System');
    // 035: agent visibility no longer syncs onto the system memory — it is
    // always NULL (chk_memory_visibility_class).
    expect(updated.visibility).toBeNull();
    // system-class memories must opt out of uploads (schema.prisma).
    expect(updated.acceptsUploads).toBe(false);
  });

  it('refuses a memory from a different org', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'org-b', urn: 'org-b' },
    });
    const agent = await createLegacyAgent('juno');
    const foreign = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        urn: 'org-b:foreign',
        name: 'foreign',
            class: 'knowledge',
      },
    });
    // #949: the refusal is now the shared, typed owner assertion (it also
    // covers the user-owned case the org comparison could not express).
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { ref: agent.id, systemMemoryId: foreign.id },
        adminCtx(),
      ),
    ).rejects.toThrow(/same owner as its agent/);
  });

  it('refuses a memory already attached to another agent', async () => {
    const agent1 = await createLegacyAgent('juno');
    const agent2 = await createLegacyAgent('other');
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'shared-system' },
      adminCtx(),
    );
    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent1.id, systemMemoryId: mem.id },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { ref: agent2.id, systemMemoryId: mem.id },
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
    // Auto-provisioning gives every agent a system memory at birth, so the
    // lock is already armed straight out of createAgent — no attach needed.
    const { agent, sys: mem } = await createAgentWithSystem('juno');
    return { agent, mem };
  }

  it('refuses to unset systemMemoryId', async () => {
    const { agent } = await agentWithSystem();
    await expect(
      resolvers.Mutation.updateAgent(
        {},
        { ref: agent.id, systemMemoryId: '' },
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
        { ref: agent.id, systemMemoryId: other.id },
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
    const { agent, sys: mem } = await createAgentWithSystem('juno');

    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, name: 'juno2' },
      adminCtx(),
    );

    const synced = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(synced.name).toBe('juno2 System');
  });

  // 035-visibility-enum-cleanup: agent visibility NO LONGER syncs onto the
  // system memory — a system memory's visibility is always NULL. This is the
  // inverse of the old "syncs visibility" behavior.
  it('does not propagate agent visibility onto the system memory', async () => {
    const { agent, sys: mem } = await createAgentWithSystem('juno', { visibility: 'PERSONAL' });

    await resolvers.Mutation.updateAgent(
      {},
      { ref: agent.id, visibility: 'ORGANIZATION' },
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
    const { sys: mem } = await createAgentWithSystem('juno');

    const other = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'other' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.addMemoryToAgent(
        {},
        { agentRef: other.id, memoryRef: mem.id, role: 'read' },
        adminCtx(),
      ),
    ).rejects.toThrow(/systemMemoryId/);
  });

  // -------------------------------------------------------------------------
  // #1101 — strict-owner classes are not attachable either.
  //
  // The gate rejected exactly ONE class (`system`), so `personal` and `private`
  // passed. That matters because `AgentMemoryItem` is a fold INPUT: an attached
  // memory lands in `getAppMemoryAccess`, which the MCP access map and (since
  // #1092) the GraphQL enumeration gate both build on — and that map is
  // DOCUMENTED personal-free, with `getAccessibleMemoryIds` consumers told to
  // rely on it. Nothing enforced the claim. Measured before this fix, a pure
  // App key's accessible set returned another user's personal memory while
  // MCP's `canReadMemory` refused the same principal the same row.
  //
  // #1102 made the read gate filter these rows itself; this is the front door
  // it was defending against. Both stay — a read gate should not depend on a
  // write gate having done its job, and pre-existing rows are unaffected by a
  // refusal added today.
  // -------------------------------------------------------------------------
  for (const klass of ['personal', 'private'] as const) {
    it(`refuses to attach a ${klass}-class memory via addMemoryToAgent (#1101)`, async () => {
      const agent = await resolvers.Mutation.createAgent(
        {},
        { orgId: orgA.id, name: `attach-${klass}` },
        adminCtx(),
      );
      const owner = await db.user.create({
        data: {
          id: generateId(),
          githubId: klass === 'personal' ? 91011 : 91012,
          githubUsername: `attach-owner-${klass}-${generateId().slice(-8)}`,
          roles: ['READER'],
        },
      });
      // #1349: the class message is only REACHABLE by a principal who can both
      // read the memory and administer the agent — otherwise an earlier gate
      // answers first. The owner as org ADMIN is that principal, and is the
      // realistic one: someone attaching their OWN personal memory.
      await db.orgMember.create({
        data: { organizationId: orgA.id, userId: owner.id, role: 'ADMIN' },
      });
      const secret = await db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgA.id,
          urn: `${orgA.urn}:secret-${klass}`,
          name: `secret-${klass}`,
          class: klass,
          userId: owner.id,
        },
      });

      // An org ADMIN is the principal that could do this — and note they cannot
      // READ this memory (`cor:acl:010:02`: the ADMIN bypass stops at
      // personal/private), so the attach was a grant they had no standing to
      // make.
      //
      // #1349 SPLIT THIS BY PRINCIPAL. The class-specific message below is
      // addressed to someone who knows this memory exists; saying it to a
      // NON-READER discloses both its existence and its class, which is the
      // #1316 oracle (memory URNs are guessable). So the org ADMIN — who
      // cannot read it — now gets the same answer a missing memory gives,
      // while the OWNER, the actor the remedy actually names, still gets every
      // word of it. Nothing about the message's wording is relaxed; it just no
      // longer goes to a principal with no standing to hear it.
      const concealed = await resolvers.Mutation
        .addMemoryToAgent({}, { agentRef: agent.id, memoryRef: secret.id, role: 'read' }, adminCtx())
        .catch((e: Error) => e);
      const missingRef = generateId();
      const missing = await resolvers.Mutation
        .addMemoryToAgent({}, { agentRef: agent.id, memoryRef: missingRef, role: 'read' }, adminCtx())
        .catch((e: Error) => e);
      // Paired: identical once each caller's OWN ref is substituted. Echoing
      // back the ref the caller supplied discloses nothing they did not send.
      expect((concealed as { name?: string }).name).toBe('MemoryNotFoundError');
      expect((concealed as Error).message.split(secret.id).join('<REF>')).toBe(
        (missing as Error).message.split(missingRef).join('<REF>'),
      );
      expect((concealed as Error).message).not.toMatch(new RegExp(`${klass}-class`, 'i'));

      const ownerCtx = () => ({ db, userId: owner.id, roles: [] }) as unknown as Context;
      await expect(
        resolvers.Mutation.addMemoryToAgent(
          {},
          { agentRef: agent.id, memoryRef: secret.id, role: 'read' },
          ownerCtx(),
        ),
      ).rejects.toThrow(new RegExp(`${klass}-class memory`, 'i'));

      // The remedy must be ACTIONABLE for this class, not merely present
      // (PR #1106 review, @copilot): a shared message with a conditional tail
      // told `private` to use a share that class cannot have, and described
      // `personal` as owner-only when a MemoryShare grantee reads it — the
      // subject of #1104, merged the day before.
      const err = await resolvers.Mutation
        .addMemoryToAgent({}, { agentRef: agent.id, memoryRef: secret.id, role: 'read' }, ownerCtx())
        .catch((e: Error) => e);
      const message = (err as Error).message;
      if (klass === 'private') {
        expect(message).toMatch(/never shareable/i);
        // Must NOT point at a share: this class has no such path, for anyone.
        expect(message).not.toMatch(/createMemoryShare/);
      } else {
        expect(message).toMatch(/createMemoryShare/);
        // It must NOT describe the read audience at all. Three review rounds
        // produced three different wrong descriptions of it — "owner only"
        // ignores share grantees (#1104), and "owner plus grantees" is false
        // for an AGENT-SCOPED personal row, where the share is excluded outright
        // and an active AgentSubscription is additionally required. The refusal
        // rests on "this class has no audience to grant to", which needs no
        // claim about who currently reads it. Assert the ABSENCE, so the next
        // person to helpfully add one reds here.
        expect(message).not.toMatch(/readable (only )?by/i);
        expect(message).toMatch(/no audience to grant/i);
        // The remedy must name the ACTOR who can perform it (#1106 review,
        // @codex P2). `createMemoryShare` gates on `isMemorySharePrincipal` —
        // a bare owner check with no admin path — so telling the org ADMIN who
        // reaches this refusal to "use createMemoryShare" sent them into a
        // guaranteed FORBIDDEN. Two correct gates composing into a dead end,
        // catchable only by asking whether the actor the message ADDRESSES can
        // do the thing it names.
        expect(message).toMatch(/only the OWNER|ask them/i);
      }

      // …and nothing was written: a refusal that half-applies is worse than none.
      const items = await db.agentMemoryItem.findMany({ where: { agentId: agent.id } });
      expect(items.map((i) => i.memoryId)).not.toContain(secret.id);
    });
  }

  it('still attaches an ordinary knowledge memory (#1101 narrowing control)', async () => {
    // The control: a refusal that denies everything passes any test that only
    // checks the denial. `knowledge` is the class this mutation exists for.
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'attach-knowledge' },
      adminCtx(),
    );
    const ok = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:attachable`,
        name: 'attachable',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await resolvers.Mutation.addMemoryToAgent(
      {},
      { agentRef: agent.id, memoryRef: ok.id, role: 'read' },
      adminCtx(),
    );
    const items = await db.agentMemoryItem.findMany({ where: { agentId: agent.id } });
    expect(items.map((i) => i.memoryId)).toContain(ok.id);
  });

  it('refuses to delete an AGENT_SYSTEM memory directly', async () => {
    const { sys: mem } = await createAgentWithSystem('juno');

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
      { agentRef: agent.urn, memoryRef: mem.urn, role: 'read' },
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
      { agentRef: agent.id, memoryRef: mem.id, role: 'read' },
      adminCtx(),
    );
    // Update by URN.
    await resolvers.Mutation.updateAgentMemoryRole(
      {},
      { agentRef: agent.urn, memoryRef: mem.urn, role: 'read-write' },
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
      { agentRef: agent.id, memoryRef: mem.id, role: 'read' },
      adminCtx(),
    );
    await resolvers.Mutation.removeMemoryFromAgent(
      {},
      { agentRef: agent.urn, memoryRef: mem.urn },
      adminCtx(),
    );
    const items = await db.agentMemoryItem.findMany({
      where: { agentId: agent.id, memoryId: mem.id },
    });
    expect(items).toHaveLength(0);
  });

  it('cascades system memory deletion when the agent is deleted', async () => {
    const { agent, sys: mem } = await createAgentWithSystem('juno');

    await resolvers.Mutation.deleteAgent({}, { ref: agent.id }, adminCtx());

    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.deletedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Listing filters
// ---------------------------------------------------------------------------

describe('memory list filtering', () => {
  async function setupTwoMemories() {
    const { sys } = await createAgentWithSystem('juno');
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
      { ref: orgA.id },
      adminCtx(),
    );
    const urns = org?.memories.map((m: { id: string }) => m.id) ?? [];
    expect(urns).toContain(knowledge.id);
    expect(urns).not.toContain(sys.id);
  });

  it('memories hides AGENT_SYSTEM by default', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    const list = (await resolvers.Query.memories({}, {}, adminCtx())).items;
    const ids = list.map((m: { id: string }) => m.id);
    expect(ids).toContain(knowledge.id);
    expect(ids).not.toContain(sys.id);
  });

  it('memories(filter.memoryClasses:) including system surfaces AGENT_SYSTEM', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    const list = (await resolvers.Query.memories(
      {},
      { filter: { memoryClasses: ['system', 'knowledge'] } },
      adminCtx(),
    )).items;
    const ids = list.map((m: { id: string }) => m.id);
    expect(ids).toContain(knowledge.id);
    expect(ids).toContain(sys.id);
  });

  it('memories(filter.memoryClasses:) restricts to exactly the listed classes', async () => {
    const { sys, knowledge } = await setupTwoMemories();
    // Only system → the knowledge memory is excluded.
    const onlySystem = (await resolvers.Query.memories({}, { filter: { memoryClasses: ['system'] } }, adminCtx())).items;
    const sysIds = onlySystem.map((m: { id: string }) => m.id);
    expect(sysIds).toContain(sys.id);
    expect(sysIds).not.toContain(knowledge.id);
    // Only knowledge → the system memory is excluded (same as the default).
    const onlyKnowledge = (await resolvers.Query.memories({}, { filter: { memoryClasses: ['knowledge'] } }, adminCtx())).items;
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
    const { agent, sys: updated } = await createAgentWithSystem('juno');

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
    const list = (await resolvers.Query.memories({}, {}, adminCtx())).items;
    const ids = (list as { id: string }[]).map((m) => m.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(doomed.id);
  });
});
