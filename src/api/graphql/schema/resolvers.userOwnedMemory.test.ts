/** #1734: user-owned non-strict memories admit platform admins; ordinary users and App keys retain their boundaries. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import {
  requireMemoryWriteAccess,
  getAccessibleMemoryIds,
} from './resolvers.helpers.js';
import { computeEffectiveAccess } from '../../../lib/auth/effectiveAccess.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

let ownerId: string;
let otherId: string;

/** A user-owned, non-personal (knowledge) memory: org NULL, owner set. */
async function createUserOwnedKnowledge(ownerUserId: string, label = 'uo') {
  return db.memory.create({
    data: {
      id: generateId(),
      class: 'knowledge',
      name: label,
      urn: `@${ownerUserId}:${label}-${generateId()}`,
      ownerUserId,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({ data: { githubId: 9001, githubUsername: 'uo-owner', roles: ['READER'] } });
  const other = await db.user.create({ data: { githubId: 9002, githubUsername: 'uo-other', roles: ['READER'] } });
  ownerId = owner.id;
  otherId = other.id;
});

describe('requireMemoryWriteAccess — user-owned memory', () => {
  it('resolves for the owner', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    await expect(
      requireMemoryWriteAccess(ctx({ userId: ownerId, roles: ['READER'] }), mem.id),
    ).resolves.toBeUndefined();
  });

  it('throws for a different user', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    await expect(
      requireMemoryWriteAccess(ctx({ userId: otherId, roles: ['READER'] }), mem.id),
    ).rejects.toThrow('Forbidden');
  });

  it('admits a platform ADMIN to a non-strict memory (#1734)', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    await expect(
      requireMemoryWriteAccess(ctx({ userId: otherId, roles: ['ADMIN'] }), mem.id),
    ).resolves.toBeUndefined();
  });

  it('admits a platform ADMIN user with an active App selection (#1734)', async () => {
    // A user with an App selection is a user principal, not a pure App key.
    const mem = await createUserOwnedKnowledge(ownerId);
    await expect(
      requireMemoryWriteAccess(ctx({ appId: 'some-app', userId: otherId, roles: ['ADMIN'] }), mem.id),
    ).resolves.toBeUndefined();
  });
});

describe('getAccessibleMemoryIds — user-owned memory', () => {
  it('includes the memory for its owner', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ userId: ownerId, roles: ['READER'] }));
    expect(ids).toContain(mem.id);
  });

  it('excludes it for a different user', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ userId: otherId, roles: ['READER'] }));
    expect(ids ?? []).not.toContain(mem.id);
  });

  it('includes another user’s non-strict memory for a platform ADMIN', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ userId: otherId, roles: ['ADMIN'] }));
    // Admin discovery is broad, while still retaining an explicit privacy-filtered set.
    expect(ids).not.toBeNull();
    expect(ids ?? []).toContain(mem.id);
  });

  it('DOES include a platform ADMIN’s OWN user-owned memory', async () => {
    const mem = await createUserOwnedKnowledge(otherId); // otherId is the ADMIN below
    const ids = await getAccessibleMemoryIds(ctx({ userId: otherId, roles: ['ADMIN'] }));
    expect(ids ?? []).toContain(mem.id);
  });
});

describe('computeEffectiveAccess — user-owned memory grants', () => {
  it('grants the owner read + write', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const res = await computeEffectiveAccess(
      db,
      { id: ownerId, roles: ['READER'] },
      { kind: 'memory', memory: mem as any },
    );
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(true);
  });

  it('grants a platform ADMIN full access to a non-strict memory', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const res = await computeEffectiveAccess(
      db,
      { id: otherId, roles: ['ADMIN'] },
      { kind: 'memory', memory: mem as any },
    );
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(true);
  });
});

/**
 * #758 — the same strict-ownership invariant, but for a user-owned memory whose
 * VISIBILITY is PUBLIC. The `orgReadableMemory` PUBLIC clause matched on
 * class/appId/userMemoryOfAgentId only, so a user-owned knowledge or group
 * memory set PUBLIC would enter every tenant's readable set — the list/search
 * side (getAccessibleMemoryIds + MCP getMemoryAccess both build on it). The
 * per-memory point reads were already safe via their ownerUserId early-returns.
 *
 * Latent when filed: nothing sets `ownerUserId` on a non-system memory yet
 * (createMemory/cloneMemory set the strict `userId` column). These tests build
 * the row directly so the guard is pinned BEFORE free-standing user-owned
 * creation lands and makes it reachable.
 */
describe('user-owned memory set PUBLIC stays owner-only (#758)', () => {
  // knowledge-class only: `chk_memory_group_visibility` forbids a group memory
  // from being PUBLIC, so knowledge is the whole reachable surface here.
  async function createPublicUserOwned(ownerUserId: string) {
    return db.memory.create({
      data: {
        id: generateId(),
        class: 'knowledge',
        name: 'pub-uo',
        urn: `@${ownerUserId}:pub-uo-${generateId()}`,
        ownerUserId,
        visibility: 'PUBLIC',
      },
    });
  }

  it('is excluded from another user’s accessible set', async () => {
    const mem = await createPublicUserOwned(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ userId: otherId, roles: ['READER'] }));
    expect(ids).not.toContain(mem.id);
  });

  it('is excluded from an ANONYMOUS caller’s accessible set', async () => {
    const mem = await createPublicUserOwned(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ roles: ['READER'] }));
    expect(ids).not.toContain(mem.id);
  });

  it('is included in a platform ADMIN’s set (#1734)', async () => {
    const mem = await createPublicUserOwned(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ userId: otherId, roles: ['ADMIN'] }));
    expect(ids).toContain(mem.id);
  });

  it('the OWNER still reads their own PUBLIC user-owned memory', async () => {
    const mem = await createPublicUserOwned(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ userId: ownerId, roles: ['READER'] }));
    expect(ids).toContain(mem.id);
  });

  it('an ORG-owned PUBLIC memory is still world-readable (no regression)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'uo-org', urn: `uo-org-${generateId()}` },
    });
    const orgPub = await db.memory.create({
      data: {
        id: generateId(), class: 'knowledge', name: 'org-pub',
        urn: `${org.urn}:org-pub`, organizationId: org.id, visibility: 'PUBLIC',
      },
    });
    const ids = await getAccessibleMemoryIds(ctx({ userId: otherId, roles: ['READER'] }));
    expect(ids).toContain(orgPub.id);
  });
});

/**
 * #758 review (Codex P1) — `Query.memories(filter: { visibility: PUBLIC })` is
 * the MARKETPLACE branch, and it RETURNS EARLY, ahead of both the App-key fold
 * and the JWT union. Guarding the other listing surfaces left this one open:
 * any caller passing the visibility filter still got the user-owned row back in
 * full. This is the fourth copy of the PUBLIC predicate, and it needs its own
 * `ownerUserId: null`.
 *
 * One case per PRINCIPAL SHAPE — each reaches this branch differently, and the
 * anonymous/App-key shapes are the ones that get skipped.
 */
describe('Query.memories(visibility: PUBLIC) excludes user-owned rows (#758)', () => {
  async function seedPublicUserOwned() {
    return db.memory.create({
      data: {
        id: generateId(), class: 'knowledge', name: 'pub-uo-marketplace',
        urn: `@${ownerId}:pub-uo-mkt-${generateId()}`,
        ownerUserId: ownerId, visibility: 'PUBLIC',
      },
    });
  }
  const list = (over: Partial<Context>) =>
    resolvers.Query.memories(null, { filter: { visibility: 'PUBLIC' } }, ctx(over));

  it('a foreign JWT caller does not see it', async () => {
    const mem = await seedPublicUserOwned();
    const page = await list({ userId: otherId, roles: ['READER'] });
    expect(page.items.map((m: { id: string }) => m.id)).not.toContain(mem.id);
  });

  it('an ANONYMOUS caller does not see it', async () => {
    const mem = await seedPublicUserOwned();
    const page = await list({ roles: ['READER'] });
    expect(page.items.map((m: { id: string }) => m.id)).not.toContain(mem.id);
  });

  it('a platform ADMIN does not see it (strict ownership, no bypass)', async () => {
    const mem = await seedPublicUserOwned();
    const page = await list({ userId: otherId, roles: ['ADMIN'] });
    expect(page.items.map((m: { id: string }) => m.id)).not.toContain(mem.id);
  });

  it('an App-key caller does not see it', async () => {
    const mem = await seedPublicUserOwned();
    const app = await db.app.create({
      data: { id: generateId(), name: 'MKT App', urn: `mkt-app-${generateId()}`, ownerUserId: otherId },
    });
    const page = await list({ appId: app.id, roles: ['READER'] });
    expect(page.items.map((m: { id: string }) => m.id)).not.toContain(mem.id);
  });

  it('an ORG-owned PUBLIC memory is still listed (marketplace not broken)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'mkt-org', urn: `mkt-org-${generateId()}` },
    });
    const orgPub = await db.memory.create({
      data: {
        id: generateId(), class: 'knowledge', name: 'org-pub-mkt',
        urn: `${org.urn}:org-pub-mkt`, organizationId: org.id, visibility: 'PUBLIC',
      },
    });
    const page = await list({ userId: otherId, roles: ['READER'] });
    expect(page.items.map((m: { id: string }) => m.id)).toContain(orgPub.id);
  });
});
