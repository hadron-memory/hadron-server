/**
 * Unit tests for the Edge.source / Edge.target field resolvers — the lazy-load
 * + per-request memoization mechanics (#381), now under the #781 endpoint gate.
 *
 * Callers preload only the relevant endpoint per direction (nodeById does
 * `outgoingEdges: { include: { target: true } }`, `incomingEdges: { include:
 * { source: true } }`), so a client selecting the UNLOADED side would resolve
 * to null and (when the field was Node!) error the whole query — the portal
 * edge-detail 500. The resolvers lazily load the missing endpoint by FK and
 * memoize it per request. #781 additionally gates each endpoint on the caller's
 * read access to its memory (Edge.source/target are now nullable). These tests
 * exercise the mechanics with a real DB + a readable memory; the cross-memory
 * DENIAL behavior lives in resolvers.edgeEndpointGate.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const edge = resolvers.Edge as unknown as {
  source: (e: unknown, a: unknown, c: Context) => Promise<unknown>;
  target: (e: unknown, a: unknown, c: Context) => Promise<unknown>;
};

let mem: { id: string };
let parent: { id: string; loc: string };
let child: { id: string; loc: string };
let ctx: Context;

// A realistic same-memory edge — both endpoints AND the edge in `mem` (the gate
// leaves such endpoints ungated, so these tests exercise the lazy-load +
// memoization mechanics, not the cross-memory denial).
const sameMemEdge = () => ({ memoryId: mem.id, sourceId: parent.id, targetId: child.id });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ee', urn: `ee-${Date.now()}` } });
  const member = await db.user.create({ data: { id: generateId(), githubId: 91201, githubUsername: 'ee-member' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  parent = await createDbNode(db, { loc: 'parent', memoryId: mem.id });
  child = await createDbNode(db, { loc: 'child', memoryId: mem.id });
  ctx = { db, userId: member.id, roles: ['READER'] }; // can read `mem`
});

afterEach(() => vi.restoreAllMocks());

describe('Edge.source / Edge.target resolvers', () => {
  it('returns preloaded endpoints without any DB fetch (both sides preloaded)', async () => {
    const spy = vi.spyOn(db.node, 'findUnique');
    const source = { id: parent.id, loc: 'parent', memoryId: mem.id, deletedAt: null };
    const target = { id: child.id, loc: 'child', memoryId: mem.id, deletedAt: null };

    const out = await edge.source({ ...sameMemEdge(), source, target }, null, ctx);

    expect((out as { id: string }).id).toBe(parent.id);
    // Both endpoint memoryIds come from the preloaded relations — no node fetch.
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks deletion state when a partial preload omitted it', async () => {
    await db.node.update({ where: { id: parent.id }, data: { deletedAt: new Date() } });
    const source = { id: parent.id, loc: 'parent', memoryId: mem.id };
    expect(await edge.source({ ...sameMemEdge(), source }, null, ctx)).toBeNull();
  });

  it('lazily loads source by FK when it was not preloaded (the 500 fix)', async () => {
    const spy = vi.spyOn(db.node, 'findUnique');
    const out = await edge.source(sameMemEdge(), null, ctx);

    expect((out as { id: string }).id).toBe(parent.id);
    expect(spy).toHaveBeenCalledWith({ where: { id: parent.id } });
  });

  it('lazily loads target by FK when it was not preloaded', async () => {
    const spy = vi.spyOn(db.node, 'findUnique');
    const out = await edge.target(sameMemEdge(), null, ctx);

    expect((out as { id: string }).id).toBe(child.id);
    expect(spy).toHaveBeenCalledWith({ where: { id: child.id } });
  });

  it('memoizes endpoint fetches per request (no N+1 across edges sharing endpoints)', async () => {
    // Three edges over the same (parent → child) pair: the source and target
    // nodes must each be fetched at most once for the whole request, not per edge.
    const spy = vi.spyOn(db.node, 'findUnique');

    const results = await Promise.all([
      edge.source(sameMemEdge(), null, ctx),
      edge.source(sameMemEdge(), null, ctx),
      edge.source(sameMemEdge(), null, ctx),
    ]);

    expect(results.map((r) => (r as { id: string }).id)).toEqual([parent.id, parent.id, parent.id]);
    // parent (the resolved source) + child (loaded once to classify same-memory),
    // each memoized → 2 fetches total, not 3× that.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
