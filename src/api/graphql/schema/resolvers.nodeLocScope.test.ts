/**
 * #335 — Query.node(loc:) must not silently resolve a same-loc node from the
 * wrong memory.
 *
 * `loc` is unique only per (loc, memoryId), so the same loc commonly lives in
 * many memories (shared skill/task locs, system-memory scaffolds like
 * `conversations`). The old resolver did a global findMany across every
 * readable memory and returned `candidates[0]` — a silent false read.
 *
 * The fix:
 *   - optional `memory` arg (ID or URN) pins the lookup, intersected with the
 *     access filter so it can never widen visibility;
 *   - an unscoped read that collides across memories throws AMBIGUOUS_NODE_LOC
 *     rather than guessing;
 *   - a unique loc still resolves with no scope (backward compatible);
 *   - nodeById(id:) remains the unambiguous by-PK read.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;
let adminId: string;
let memAlpha: { id: string; urn: string };
let memBeta: { id: string };

function adminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminId };
}

beforeEach(async () => {
  await cleanDb(db);
  const orgUrn = `loc-scope-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } });
  orgId = org.id;
  const admin = await db.user.create({ data: { githubId: 7731, githubUsername: 'loc-scope-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  adminId = admin.id;

  const alphaId = generateId();
  const alphaUrn = `${orgUrn}:alpha`;
  await db.memory.create({ data: { id: alphaId, organizationId: orgId, urn: alphaUrn, name: 'alpha', class: 'knowledge' } });
  memAlpha = { id: alphaId, urn: alphaUrn };

  const betaId = generateId();
  await db.memory.create({ data: { id: betaId, organizationId: orgId, urn: `${orgUrn}:beta`, name: 'beta', class: 'knowledge' } });
  memBeta = { id: betaId };

  // Same loc in BOTH memories (the collision), plus a unique loc in alpha.
  const mkNode = (loc: string, memoryId: string, isRunnable: boolean | null) =>
    db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, tags: [], isRunnable } });
  await mkNode('tasks:post-asana-comment', alphaId, true);
  await mkNode('tasks:post-asana-comment', betaId, null);
  await mkNode('tasks:only-in-alpha', alphaId, true);
});

describe('Query.node(loc:) memory scoping (#335)', () => {
  it('throws AMBIGUOUS_NODE_LOC when an unscoped loc collides across memories', async () => {
    await expect(
      resolvers.Query.node({}, { loc: 'tasks:post-asana-comment' }, adminCtx()),
    ).rejects.toMatchObject({
      extensions: { code: 'AMBIGUOUS_NODE_LOC', loc: 'tasks:post-asana-comment' },
    });
  });

  it('lists the candidate memoryIds in the ambiguity error', async () => {
    try {
      await resolvers.Query.node({}, { loc: 'tasks:post-asana-comment' }, adminCtx());
      throw new Error('expected AMBIGUOUS_NODE_LOC');
    } catch (e: any) {
      const ids: string[] = e.extensions?.memoryIds ?? [];
      expect(new Set(ids)).toEqual(new Set([memAlpha.id, memBeta.id]));
    }
  });

  it('resolves the correct node when scoped by memory ID', async () => {
    const node = await resolvers.Query.node({}, { loc: 'tasks:post-asana-comment', memory: memAlpha.id }, adminCtx());
    expect(node?.memoryId).toBe(memAlpha.id);
    expect(node?.isRunnable).toBe(true);
  });

  it('resolves the correct node when scoped by memory URN', async () => {
    const node = await resolvers.Query.node({}, { loc: 'tasks:post-asana-comment', memory: memAlpha.urn }, adminCtx());
    expect(node?.memoryId).toBe(memAlpha.id);
    expect(node?.isRunnable).toBe(true);
  });

  it('returns the beta node (isRunnable null) when scoped to beta — proving scope selects the memory', async () => {
    const node = await resolvers.Query.node({}, { loc: 'tasks:post-asana-comment', memory: memBeta.id }, adminCtx());
    expect(node?.memoryId).toBe(memBeta.id);
    expect(node?.isRunnable).toBeNull();
  });

  it('still resolves a unique loc with no scope (backward compatible)', async () => {
    const node = await resolvers.Query.node({}, { loc: 'tasks:only-in-alpha' }, adminCtx());
    expect(node?.memoryId).toBe(memAlpha.id);
  });

  it('returns null for a scoped lookup whose loc does not exist in that memory', async () => {
    const node = await resolvers.Query.node({}, { loc: 'tasks:only-in-alpha', memory: memBeta.id }, adminCtx());
    expect(node).toBeNull();
  });
});
