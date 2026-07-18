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

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
        { id: agent.id, visibility: 'PUBLIC' },
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
    ).rejects.toThrow('Forbidden');
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

    // A platform admin auditing the owner's access to their OWN agent still
    // reports the owner's grants (the caller-audit is allowed for admins), but
    // auditing the ADMIN's OWN access must show nothing (strict ownership).
    const adminSelf = await resolvers.Query.effectiveAccess(
      null,
      { user: otherId, resource: agentUrn },
      ctx({ userId: otherId, roles: ['ADMIN'] }),
    );
    expect(adminSelf.canRead).toBe(false);
    expect(adminSelf.canManage).toBe(false);
  });
});
