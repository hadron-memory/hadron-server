/**
 * spec 047 — user-owned memory access (owner-only) at the PORTAL (JWT) layer.
 *
 * A user-owned memory (`ownerUserId` set, `organizationId` NULL) is STRICTLY
 * owner-only: the owner reads + writes it, and NOT even a platform ADMIN/OWNER
 * (parity with the personal/private strict-owner carve-out). These tests pin
 * the shared JWT gates — requireMemoryWriteAccess, getAccessibleMemoryIds, and
 * the effectiveAccess audit — so a widening of any of them can't silently admit
 * a non-owner to another user's user-owned memory.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { Context } from './resolvers.js';
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

  it('throws for a platform ADMIN (strict ownership — NO admin bypass)', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    await expect(
      requireMemoryWriteAccess(ctx({ userId: otherId, roles: ['ADMIN'] }), mem.id),
    ).rejects.toThrow('Forbidden');
  });

  it('throws for an App-keyed ADMIN caller (the App-path must not short-circuit)', async () => {
    // gemini #676: the App-keyed path previously returned early for ADMIN/OWNER
    // BEFORE canWriteToMemory, bypassing strict ownership. It must now delegate.
    const mem = await createUserOwnedKnowledge(ownerId);
    await expect(
      requireMemoryWriteAccess(ctx({ appId: 'some-app', userId: otherId, roles: ['ADMIN'] }), mem.id),
    ).rejects.toThrow('Forbidden');
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

  it('excludes another user’s user-owned memory even from a platform ADMIN', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const ids = await getAccessibleMemoryIds(ctx({ userId: otherId, roles: ['ADMIN'] }));
    // The ADMIN "see all" branch returns an explicit id list; it must NOT
    // contain another user's user-owned memory.
    expect(ids).not.toBeNull();
    expect(ids ?? []).not.toContain(mem.id);
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

  it('grants a platform ADMIN nothing (strict ownership)', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const res = await computeEffectiveAccess(
      db,
      { id: otherId, roles: ['ADMIN'] },
      { kind: 'memory', memory: mem as any },
    );
    expect(res.canRead).toBe(false);
    expect(res.canWrite).toBe(false);
  });
});
