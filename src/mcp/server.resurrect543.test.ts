/**
 * Regression coverage for issue #543 (MCP write-path soft-delete handling):
 *
 *   - hadron_create_node — writing to a loc that holds a SOFT-DELETED node
 *     RESURRECTS the row (clears deletedAt/deletedBy) while applying the new
 *     fields, matching the GraphQL createNode contract. Before the fix the
 *     upsert's update branch wrote the new fields but left deletedAt set —
 *     the row stayed invisible to every read/find/list path yet kept its
 *     content.
 *
 *   - hadron_update_node — a soft-deleted node is treated as not-found (a
 *     partial update is not a resurrect), mirroring GraphQL update mode and
 *     every read path.
 *
 * Test harness: `createTestableMcpServer` drives the real production closure
 * (auth + canWriteToMemory + Prisma) without an HTTP transport.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  admin: { id: string };
  memory: { id: string; urn: string };
  ghost: { id: string; loc: string };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'issue-543-org', urn: 'issue-543-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9801, githubUsername: 'issue-543-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'mutations' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );

  // A soft-deleted node holding stale content/data at `defaults`.
  const ghost = await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'defaults',
      name: 'Ghost',
      nodeType: 'data',
      tags: [],
      content: 'stale content',
      data: { chat_memory: 'old-value' },
      deletedAt: new Date(),
      deletedBy: admin.id,
    },
  });

  fx = { admin, memory, ghost };
});

describe('hadron_create_node — resurrects a soft-deleted node (#543)', () => {
  it('clears deletedAt/deletedBy and writes the new fields', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.ghost.loc}`,
      name: 'Reborn',
      nodeType: 'data',
      content: 'fresh content',
      data: { chat_memory: 'new-value' },
    });

    expect(text).toMatch(/Node saved/);

    const row = await db.node.findUnique({ where: { id: fx.ghost.id } });
    // Resurrected: no longer tombstoned.
    expect(row?.deletedAt).toBeNull();
    expect(row?.deletedBy).toBeNull();
    // New fields applied (same row — id is stable).
    expect(row?.name).toBe('Reborn');
    expect(row?.content).toBe('fresh content');
    expect(row?.data).toEqual({ chat_memory: 'new-value' });
  });

  it('leaves a live node untouched by the resurrect path (deletedAt stays null)', async () => {
    // Re-create the ghost as a LIVE node first, then re-write it: the
    // isResurrect branch must not fire (nothing to clear) and the row
    // stays live.
    await db.node.update({
      where: { id: fx.ghost.id },
      data: { deletedAt: null, deletedBy: null },
    });

    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.ghost.loc}`,
      name: 'Updated live',
      content: 'v2',
    });

    const row = await db.node.findUnique({ where: { id: fx.ghost.id } });
    expect(row?.deletedAt).toBeNull();
    expect(row?.name).toBe('Updated live');
  });
});

describe('hadron_update_node — soft-deleted node is not-found (#543)', () => {
  it('returns "not found" and leaves the row tombstoned', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_update_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.ghost.loc}`,
      name: 'Should not apply',
    });

    expect(text).toMatch(/not found/i);

    const row = await db.node.findUnique({ where: { id: fx.ghost.id } });
    // Untouched: still deleted, name unchanged.
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.name).toBe('Ghost');
  });
});
