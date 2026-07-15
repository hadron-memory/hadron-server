/**
 * spec 047 — user-owned memory access (owner-only) at the MCP access-control
 * layer.
 *
 * A user-owned memory (`ownerUserId` set, `organizationId` NULL — the org-XOR-
 * owner model) is STRICTLY owner-only: only its owner can read or write it, and
 * NOT even a platform admin (parity with the personal/private strict-owner
 * carve-out, cor:acl:010:02). These tests pin that no other principal — a
 * different user, a platform ADMIN, or an App-Key caller — ever reaches a
 * user-owned memory, and that the owner discovers it over the listing surfaces.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import {
  canReadMemory,
  canWriteToMemory,
  getAccessibleMemoryIds,
  getMemoryAccess,
} from './access-control.js';

let ownerId: string;
let otherUserId: string;

/** A user-owned, non-personal (knowledge) memory: org NULL, owner set. */
async function createUserOwnedKnowledge(ownerUserId: string, label = 'uo') {
  return db.memory.create({
    data: {
      id: generateId(),
      class: 'knowledge',
      name: label,
      urn: `@${ownerUserId}:${label}-${generateId()}`,
      ownerUserId,
      // organizationId omitted (NULL) — satisfies chk_memory_owner_xor.
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({ data: { id: generateId(), name: 'owner' } });
  const other = await db.user.create({ data: { id: generateId(), name: 'other' } });
  ownerId = owner.id;
  otherUserId = other.id;
});

describe('user-owned memory — canReadMemory / canWriteToMemory', () => {
  it('grants the owner read + write', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const auth: AuthContext = { userId: ownerId };
    expect(await canReadMemory(db, auth, mem.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(true);
  });

  it('denies a different user read + write', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const auth: AuthContext = { userId: otherUserId };
    expect(await canReadMemory(db, auth, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(false);
  });

  it('denies a platform ADMIN read + write (strict ownership — NO admin bypass)', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const auth: AuthContext = { userId: otherUserId, roles: ['ADMIN'] };
    expect(await canReadMemory(db, auth, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(false);
  });

  it('denies an App-Key caller (no userId)', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const org = await db.organization.create({
      data: { id: generateId(), name: 'uo-appkey-org', urn: `uo-appkey-org-${generateId()}` },
    });
    const { app } = await createDbAppWithKey(db, 'uo-appkey', org.id);
    const auth: AuthContext = { appId: app.id };
    expect(await canReadMemory(db, auth, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(false);
  });
});

describe('user-owned memory — getMemoryAccess (discovery)', () => {
  it('folds the owner’s user-owned memory in as READ_WRITE', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const access = await getMemoryAccess(db, { userId: ownerId });
    expect(access.get(mem.id)).toBe('READ_WRITE');
  });

  it('never surfaces another user’s user-owned memory', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const access = await getMemoryAccess(db, { userId: otherUserId });
    expect(access.has(mem.id)).toBe(false);
  });

  it('never surfaces a user-owned memory to a platform ADMIN via the map', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const access = await getMemoryAccess(db, { userId: otherUserId, roles: ['ADMIN'] });
    expect(access.has(mem.id)).toBe(false);
  });
});

describe('user-owned memory — getAccessibleMemoryIds (list mode)', () => {
  it('includes the owner’s user-owned memory', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const ids = await getAccessibleMemoryIds(db, { userId: ownerId });
    expect(ids).not.toBeNull();
    expect(ids).toContain(mem.id);
  });

  it('excludes it for a different user', async () => {
    const mem = await createUserOwnedKnowledge(ownerId);
    const ids = await getAccessibleMemoryIds(db, { userId: otherUserId });
    expect(ids ?? []).not.toContain(mem.id);
  });
});
