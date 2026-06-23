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
    data: { githubId: 9311, githubUsername: 'urn-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
  });
});

// Regression: the portal settings form once mis-derived a memory's slug from
// its canonical `hrn:memory:<org>::<slug>` URN and sent `memory:<org>::<slug>`,
// which updateMemory composed into `<org>:memory:<org>::<slug>` and PERSISTED —
// corrupting the row and 500ing every memory-listing page. updateMemory must
// reject a non-bare slug before the write.
describe('updateMemory — rejects a non-bare URN slug (no corruption persisted)', () => {
  it('throws BAD_USER_INPUT and does NOT mutate the stored URN', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'experiments' },
      adminCtx(),
    );
    const before = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });

    await expect(
      resolvers.Mutation.updateMemory(
        {},
        { id: mem.id, urn: 'memory:org-a::experiments' },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    // The row is untouched — the bad value never reached the DB.
    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe(before.urn);
  });

  it('also rejects a scheme-prefixed slug and a `::`-bearing slug', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'exp2' },
      adminCtx(),
    );
    for (const bad of ['hrn:memory:org-a::exp2', 'foo::bar', 'agent:org-a::x']) {
      await expect(
        resolvers.Mutation.updateMemory({}, { id: mem.id, urn: bad }, adminCtx()),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
  });

  it('accepts a bare slug rename and persists `<org>:<slug>`', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'old-slug' },
      adminCtx(),
    );
    await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, urn: 'new-slug' },
      adminCtx(),
    );
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.urn).toBe('org-a:new-slug');
  });

  it('leaves the URN untouched on a metadata-only update (no urn arg)', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'keep-urn' },
      adminCtx(),
    );
    const before = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, description: 'just a description change' },
      adminCtx(),
    );
    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(after.urn).toBe(before.urn);
  });
});
