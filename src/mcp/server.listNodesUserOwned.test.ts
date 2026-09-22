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

  it('lists a personal child for an ADMIN who is its strict owner despite a different tenant owner (#1217)', async () => {
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        class: 'personal',
        name: 'divergent-owner-memory',
        urn: `@${ownerId}:divergent-${generateId()}`,
        ownerUserId: ownerId,
        userId: adminId,
      },
    });
    await createDbNode(db, { memoryId: mem.id, loc: 'strictowner', name: 'strict owner parent' });
    await createDbNode(db, {
      memoryId: mem.id,
      loc: 'strictowner:child',
      name: 'STRICT-OWNER-CHILD',
    });

    const text = await createTestableMcpServer({
      userId: adminId,
      roles: ['ADMIN'],
    }).callToolText('hadron_list_nodes', { parentRel: 'strictowner' });

    expect(text).toContain('STRICT-OWNER-CHILD');
  });

  it('does NOT cross the selected App when an ADMIN owns the other App personal memory', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'app-isolation-org', urn: `app-isolation-${generateId()}` },
    });
    const appA = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'App A', urn: `${org.urn}:app-a` },
    });
    const appB = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'App B', urn: `${org.urn}:app-b` },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, name: 'Agent', urn: `${org.urn}:agent` },
    });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        class: 'personal',
        name: 'App B personal memory',
        urn: `${org.urn}:app-b-personal`,
        ownerUserId: ownerId,
        userId: adminId,
        appId: appB.id,
        userMemoryOfAgentId: agent.id,
      },
    });
    await createDbNode(db, { memoryId: mem.id, loc: 'crossapp', name: 'cross-App parent' });
    await createDbNode(db, {
      memoryId: mem.id,
      loc: 'crossapp:child',
      name: 'CROSS-APP-SECRET',
    });

    const text = await createTestableMcpServer({
      userId: adminId,
      roles: ['ADMIN'],
      appId: appA.id,
    }).callToolText('hadron_list_nodes', { parentRel: 'crossapp' });

    expect(text).not.toContain('CROSS-APP-SECRET');
  });
});
