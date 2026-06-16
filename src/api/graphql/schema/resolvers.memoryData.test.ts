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
    data: { githubId: 9201, githubUsername: 'data-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
  });
});

// ---------------------------------------------------------------------------
// Memory.data — free-form JSON metadata bag (GraphQL read/write exposure)
// ---------------------------------------------------------------------------

describe('Memory.data JSON field', () => {
  it('defaults to null when createMemory omits it', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'no-data' },
      adminCtx(),
    );
    expect(mem.data).toBeNull();
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.data).toBeNull();
  });

  it('persists a JSON object passed to createMemory and reads it back', async () => {
    const payload = { color: 'blue', counts: [1, 2, 3], nested: { ok: true } };
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'with-data', data: payload },
      adminCtx(),
    );
    expect(mem.data).toEqual(payload);
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.data).toEqual(payload);
  });

  it('updateMemory sets data on a memory created without it', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'set-later' },
      adminCtx(),
    );
    const updated = await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, data: { theme: 'dark' } },
      adminCtx(),
    );
    expect(updated.data).toEqual({ theme: 'dark' });
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.data).toEqual({ theme: 'dark' });
  });

  it('updateMemory replaces an existing data value wholesale', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'replace-data', data: { a: 1, b: 2 } },
      adminCtx(),
    );
    const updated = await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, data: { c: 3 } },
      adminCtx(),
    );
    // JSON columns are replaced as a whole, not deep-merged.
    expect(updated.data).toEqual({ c: 3 });
  });

  it('updateMemory with data: null CLEARS the stored value', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'clear-data', data: { keep: false } },
      adminCtx(),
    );
    const updated = await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, data: null },
      adminCtx(),
    );
    expect(updated.data).toBeNull();
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.data).toBeNull();
  });

  it('updateMemory leaves data untouched when the arg is omitted', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: orgA.id, name: 'untouched-data', data: { stable: 'yes' } },
      adminCtx(),
    );
    // An unrelated update (no `data` key) must not disturb the stored bag.
    const updated = await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, description: 'changed description' },
      adminCtx(),
    );
    expect(updated.data).toEqual({ stable: 'yes' });
    const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect(row.data).toEqual({ stable: 'yes' });
  });
});
