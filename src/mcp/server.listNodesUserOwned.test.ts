/**
 * spec 047 (#676 codex P1) — hadron_list_nodes must not leak another user's
 * user-owned nodes to a platform ADMIN via the bare-parentRel path.
 *
 * getAccessibleMemoryIds returns `null` ("see all") for an ADMIN/OWNER. When a
 * bare parentRel resolves to a loc WITHOUT pinning a memoryId, the browse query
 * has no memory scope — so without an explicit carve-out it would list nodes
 * from EVERY memory at that loc prefix, including another user's user-owned
 * (and personal/private) memory, which the direct memoryUrn path denies via
 * canReadMemory. This pins the carve-out.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let adminId: string;
let ownerId: string;
let userOwnedMemoryId: string;

beforeEach(async () => {
  await cleanDb(db);
  const admin = await db.user.create({ data: { id: generateId(), name: 'admin', roles: ['ADMIN'] } });
  const owner = await db.user.create({ data: { id: generateId(), name: 'owner' } });
  adminId = admin.id;
  ownerId = owner.id;

  // A user-owned (org NULL, owner set) memory with a parent + a secret child.
  const mem = await db.memory.create({
    data: {
      id: generateId(),
      class: 'knowledge',
      name: 'uo-secret-mem',
      urn: `@${ownerId}:uo-secret-${generateId()}`,
      ownerUserId: ownerId,
    },
  });
  userOwnedMemoryId = mem.id;
  await createDbNode(db, { memoryId: mem.id, loc: 'uosecret', name: 'uo parent' });
  await createDbNode(db, { memoryId: mem.id, loc: 'uosecret:child', name: 'TOP-SECRET-CHILD' });
});

describe('#676 — hadron_list_nodes user-owned leak (ADMIN + bare parentRel)', () => {
  it('does NOT list another user’s user-owned child nodes for a platform ADMIN', async () => {
    const adminAuth: AuthContext = { userId: adminId, roles: ['ADMIN'] };
    const srv = createTestableMcpServer(adminAuth);
    // Bare parentRel 'uosecret' resolves to the loc without pinning a memoryId
    // (the loc only exists in the user-owned memory), so the browse query is
    // otherwise unscoped for an ADMIN.
    const text = await srv.callToolText('hadron_list_nodes', { parentRel: 'uosecret' });
    expect(text).not.toContain('TOP-SECRET-CHILD');
  });

  it('the direct memoryUrn path is also denied (parity control)', async () => {
    const adminAuth: AuthContext = { userId: adminId, roles: ['ADMIN'] };
    const srv = createTestableMcpServer(adminAuth);
    const mem = await db.memory.findUniqueOrThrow({ where: { id: userOwnedMemoryId }, select: { urn: true } });
    const text = await srv.callToolText('hadron_list_nodes', { memoryUrn: mem.urn });
    expect(text).not.toContain('TOP-SECRET-CHILD');
  });
});
