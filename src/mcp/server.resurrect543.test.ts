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
  viewer: { id: string };
  memory: { id: string; urn: string };
  ghost: { id: string; loc: string };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

function viewerAuth(): AuthContext {
  return { userId: fx.viewer.id, roles: [], clientId: `user:${fx.viewer.id}` };
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
  // A user with NO access to the memory — used to prove hadron_update_node
  // gates on write-access before it probes node existence (no membership
  // oracle).
  const viewer = await db.user.create({
    data: { githubId: 9802, githubUsername: 'issue-543-viewer', roles: [] },
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

  fx = { admin, viewer, memory, ghost };
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

  it('does not fire on a LIVE node — which is now refused outright (#1181)', async () => {
    // This case used to assert that writing over a live node overwrote it while
    // leaving `deletedAt` null (the isResurrect branch correctly not firing).
    // #1181 changed the contract that assertion rode on: a live loc is REFUSED,
    // matching the GraphQL createNode mutation and the runner tool. The
    // ORIGINAL intent — the resurrect branch must not fire when there is
    // nothing to clear — is preserved and in fact strengthened: the write never
    // happens at all, so the row is untouched rather than merely still-live.
    await db.node.update({
      where: { id: fx.ghost.id },
      data: { deletedAt: null, deletedBy: null },
    });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.ghost.loc}`,
      name: 'Updated live',
      content: 'v2',
    });

    expect(text).toMatch(/already exists/i);

    const row = await db.node.findUnique({ where: { id: fx.ghost.id } });
    expect(row?.deletedAt).toBeNull();
    // Untouched — the pre-#1181 contract would have made these 'Updated live' / 'v2'.
    expect(row?.name).toBe('Ghost');
    expect(row?.content).toBe('stale content');
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

  it('gates on write-access before probing existence (no membership oracle)', async () => {
    // A caller without write access must get the SAME response whether the
    // loc names an existing node or a missing one — otherwise the tool leaks
    // node existence in memories the caller cannot access (Gemini review).
    const srv = createTestableMcpServer(viewerAuth());

    const existingLoc = await srv.callToolText('hadron_update_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.ghost.loc}`,
      name: 'nope',
    });
    const missingLoc = await srv.callToolText('hadron_update_node', {
      urn: `urn:node:${fx.memory.urn}:does-not-exist`,
      name: 'nope',
    });

    expect(existingLoc).toMatch(/access denied/i);
    expect(existingLoc).not.toMatch(/not found/i);
    // Identical response for both — no existence signal.
    expect(missingLoc).toBe(existingLoc);
  });
});
