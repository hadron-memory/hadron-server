/**
 * Issue #1181 — MCP `hadron_create_node` REFUSES a live (loc, memoryId) rather
 * than overwriting it.
 *
 * Before this gate, one tool name had two opposite behaviours on the operation
 * that decides whether the node at an address is still the same node:
 *
 *   - GraphQL `createNode` (writeNodeCore mode 'create', spec 039 Phase 0 D1)  → refuses
 *   - runner `hadron_create_node` (src/lib/runner/tools/nodeTools.ts)          → refuses
 *   - MCP `hadron_create_node` (src/mcp/server.ts)                             → OVERWROTE
 *
 * ...and the overwriting one is the surface AGENTS drive. The content was
 * recoverable (#976 snapshots it), so the loss was never content — it was
 * IDENTITY: the node at that address became a different node and nothing
 * refused. That is what makes it the live half of #1178, where the address in
 * question is a permanent spec citation.
 *
 * What is pinned here, and why each case earns its place:
 *   1. a live loc refuses, and the row is byte-for-byte untouched
 *      (a refusal that still wrote half the fields would satisfy a
 *      message-only assertion — hence the row assertions)
 *   2. the refusal names the remedy the caller can actually perform
 *   3. a genuinely NEW loc still creates (the gate must not refuse everything —
 *      the failure mode an absence-assertion alone cannot see)
 *   4. a SOFT-DELETED loc still resurrects (#543 is not collateral damage)
 *   5. the refusal does not leak node existence to a caller without write
 *      access — the gate sits after canWriteToMemory, and this proves the
 *      ordering rather than trusting it
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
  outsider: { id: string };
  memory: { id: string; urn: string };
  live: { id: string; loc: string };
  ghost: { id: string; loc: string };
}

let fx: Fixture;

const adminAuth = (): AuthContext => ({
  userId: fx.admin.id,
  roles: ['ADMIN'],
  clientId: `user:${fx.admin.id}`,
});

const outsiderAuth = (): AuthContext => ({
  userId: fx.outsider.id,
  roles: [],
  clientId: `user:${fx.outsider.id}`,
});

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'issue-1181-org', urn: 'issue-1181-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 11810, githubUsername: 'issue-1181-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });

  // No membership anywhere — used for the existence-leak case.
  const outsider = await db.user.create({
    data: { githubId: 11811, githubUsername: 'issue-1181-outsider', roles: [] },
  });

  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'specs-ish' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );

  // Stand-in for a cited node: an address whose identity must not be reassigned.
  const live = await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'cor:api:010:01',
      name: 'The original rule',
      nodeType: 'info',
      tags: ['spec'],
      description: 'original description',
      content: 'the original rule text',
    },
  });

  const ghost = await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'cor:api:010:02',
      name: 'Ghost',
      nodeType: 'info',
      tags: [],
      content: 'stale content',
      deletedAt: new Date(),
      deletedBy: admin.id,
    },
  });

  fx = { admin, outsider, memory, live, ghost };
});

describe('hadron_create_node — a LIVE loc is refused, not overwritten (#1181)', () => {
  it('refuses, and leaves every field of the existing row untouched', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.live.loc}`,
      name: 'A DIFFERENT rule',
      description: 'hijacked',
      content: 'a completely different rule text',
      tags: ['spec', 'hijacked'],
    });

    expect(text).toMatch(/already exists/i);

    // The row assertions are the point: a gate that refused in the MESSAGE but
    // still ran the write would pass a message-only test.
    const row = await db.node.findUnique({ where: { id: fx.live.id } });
    expect(row?.name).toBe('The original rule');
    expect(row?.description).toBe('original description');
    expect(row?.content).toBe('the original rule text');
    expect(row?.tags).toEqual(['spec']);
    // No revision was cut either — nothing was overwritten to snapshot.
    expect(row?.revSeq).toBe(1);
  });

  it('names the remedy the caller can actually perform', async () => {
    // conventions:the-error-code-is-the-contract-the-prose-is-not — the refusal
    // states the condition and points at an act this caller can take. The
    // sibling runner tool words it identically, so all three surfaces read alike.
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.live.loc}`,
      name: 'nope',
    });

    expect(text).toMatch(/hadron_update_node/);
    expect(text).toContain(fx.live.loc);
  });

  it('still CREATES at a genuinely new loc', async () => {
    // The case an absence-assertion cannot see: a gate that refused everything
    // would satisfy "does not overwrite" perfectly.
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:cor:api:010:03`,
      name: 'A brand new rule',
      content: 'new text',
    });

    expect(text).not.toMatch(/already exists/i);

    const row = await db.node.findFirst({
      where: { memoryId: fx.memory.id, loc: 'cor:api:010:03' },
    });
    expect(row?.name).toBe('A brand new rule');
    expect(row?.deletedAt).toBeNull();
  });

  it('still RESURRECTS a soft-deleted loc (#543 is not collateral damage)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.ghost.loc}`,
      name: 'Reborn',
      content: 'fresh content',
    });

    expect(text).not.toMatch(/already exists/i);

    const row = await db.node.findUnique({ where: { id: fx.ghost.id } });
    expect(row?.deletedAt).toBeNull();
    expect(row?.deletedBy).toBeNull();
    expect(row?.name).toBe('Reborn');
    // Same row — the id is stable across a resurrect.
    expect(row?.id).toBe(fx.ghost.id);
  });

  it('does not leak node existence to a caller without write access', async () => {
    // The gate sits AFTER canWriteToMemory. If it were hoisted above that check
    // — the obvious "probe first" refactor — an unauthorized caller could map
    // which locs are occupied by diffing the two refusals. Same shape as the
    // #543 membership-oracle case on hadron_update_node.
    const srv = createTestableMcpServer(outsiderAuth());

    const occupied = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:${fx.live.loc}`,
      name: 'probe',
    });
    const free = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${fx.memory.urn}:cor:api:999:99`,
      name: 'probe',
    });

    // #1316: the outsider cannot read this memory, so the refusal is the
    // missing-memory answer rather than "Write access denied" — which would
    // itself confirm the memory exists.
    expect(occupied).toBe(`Memory not found: "${fx.memory.urn}".`);
    expect(occupied).not.toMatch(/already exists/i);
    // Byte-identical — no existence signal in either direction.
    expect(free).toBe(occupied);
  });
});
