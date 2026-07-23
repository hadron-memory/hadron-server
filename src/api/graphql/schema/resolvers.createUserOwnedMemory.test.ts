/**
 * Spec 047 (Memory slice) — user-owned memory CREATION + the URN-shape
 * guardrail. (Access gates for user-owned memories live in
 * resolvers.userOwnedMemory.test.ts.)
 *
 * `createMemory` with NO `orgId` creates a memory owned by the authenticated
 * caller in their own handle namespace: `organizationId` NULL, `ownerUserId` =
 * caller, and a BARE handle-rooted URN (`<handle>:<slug>`) — never the
 * `hrn:mem:`-prefixed display form. This is the path that removes the need to
 * hand-edit the DB to get an `@handle` memory (the Jens incident); the
 * `chk_memory_urn_not_prefixed` CHECK is the backstop against the double-prefix
 * footgun even for raw-SQL writes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

let handled: { id: string }; // user WITH a handle already set
let handleless: { id: string }; // user with NO handle (needs generation)

beforeEach(async () => {
  await cleanDb(db);
  handled = await db.user.create({
    data: { githubId: 7101, githubUsername: 'dana', handle: 'dana', roles: ['READER'] },
  });
  handleless = await db.user.create({
    data: { githubId: 7102, githubUsername: 'jens-son', name: 'Jens Junior', roles: ['READER'] },
  });
});

const asHandled = () => ctx({ userId: handled.id, roles: ['READER'] });
const asHandleless = () => ctx({ userId: handleless.id, roles: ['READER'] });

describe('createMemory — user-owned (no orgId)', () => {
  it('creates a personal memory owned by the caller in their handle namespace', async () => {
    const mem = await resolvers.Mutation.createMemory(
      null,
      { name: 'Jens', memoryClass: 'personal' } as any,
      asHandled(),
    );
    expect(mem.class).toBe('personal');
    expect(mem.organizationId).toBeNull();
    expect(mem.ownerUserId).toBe(handled.id); // tenant owner
    expect(mem.userId).toBe(handled.id); // strict personal owner
    // BARE, handle-rooted, single-colon — NOT the hrn:mem: display form.
    expect(mem.urn).toBe('dana:jens');
    expect(mem.urn.startsWith('hrn:')).toBe(false);
  });

  it('supports the private class too', async () => {
    const mem = await resolvers.Mutation.createMemory(
      null,
      { name: 'secrets', memoryClass: 'private' } as any,
      asHandled(),
    );
    expect(mem.class).toBe('private');
    expect(mem.organizationId).toBeNull();
    expect(mem.ownerUserId).toBe(handled.id);
    expect(mem.urn).toBe('dana:secrets');
  });

  it('auto-generates + persists a handle when the owner has none, and roots the URN on it', async () => {
    const mem = await resolvers.Mutation.createMemory(
      null,
      { name: 'notes', memoryClass: 'personal' } as any,
      asHandleless(),
    );
    const user = await db.user.findUniqueOrThrow({ where: { id: handleless.id } });
    expect(user.handle).toBeTruthy(); // generated + persisted
    expect(mem.ownerUserId).toBe(handleless.id);
    expect(mem.urn).toBe(`${user.handle}:notes`);
    expect(mem.urn.startsWith('hrn:')).toBe(false);
  });

  it('rejects org-shared classes on the org-less path (knowledge needs an org)', async () => {
    await expect(
      resolvers.Mutation.createMemory(
        null,
        { name: 'shared-kb', memoryClass: 'knowledge' } as any,
        asHandled(),
      ),
    ).rejects.toThrow(/must be class 'personal' or 'private'/);
  });

  it('requires authentication (no anonymous user-owned create)', async () => {
    await expect(
      resolvers.Mutation.createMemory(null, { name: 'anon', memoryClass: 'personal' } as any, ctx()),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it('still creates org-owned memories when orgId is supplied (ownerUserId stays NULL — no regression)', async () => {
    const { org } = await createDbOrgAndGraph(db, {
      orgName: 'acme',
      graphName: 'acme/repo',
      visibility: 'ORGANIZATION',
    });
    await db.orgMember.create({ data: { organizationId: org.id, userId: handled.id, role: 'READER' } });
    const mem = await resolvers.Mutation.createMemory(
      null,
      { orgId: org.id, name: 'kb', memoryClass: 'personal' } as any,
      asHandled(),
    );
    expect(mem.organizationId).toBe(org.id);
    expect(mem.ownerUserId).toBeNull(); // org path must NOT set the user tenant owner
    expect(mem.userId).toBe(handled.id); // strict personal owner still set
    expect(mem.urn.startsWith('hrn:')).toBe(false);
  });
});

describe('chk_memory_urn_not_prefixed guardrail', () => {
  it('rejects a raw UPDATE that stores the hrn:mem: display form (the double-prefix footgun)', async () => {
    const mem = await resolvers.Mutation.createMemory(
      null,
      { name: 'guarded', memoryClass: 'personal' } as any,
      asHandled(),
    );
    // The exact class of write that broke the Jens memory: storing the already-
    // rendered display URN instead of the bare form.
    await expect(
      db.$executeRawUnsafe(`UPDATE memories SET urn = 'hrn:mem:dana:guarded' WHERE id = $1`, mem.id),
    ).rejects.toThrow(/chk_memory_urn_not_prefixed/);
    // A correct bare-form update is still allowed.
    await expect(
      db.$executeRawUnsafe(`UPDATE memories SET urn = 'dana:renamed' WHERE id = $1`, mem.id),
    ).resolves.toBeGreaterThanOrEqual(1);
  });
});
