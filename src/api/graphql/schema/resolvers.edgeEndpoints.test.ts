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
let ctx: Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ee', urn: `ee-${Date.now()}` } });
  const member = await db.user.create({ data: { id: generateId(), githubId: 91201, githubUsername: 'ee-member' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  parent = await createDbNode(db, { loc: 'parent', memoryId: mem.id });
  ctx = { db, userId: member.id, roles: ['READER'] }; // can read `mem`
});

afterEach(() => vi.restoreAllMocks());

describe('Edge.source / Edge.target resolvers', () => {
  it('returns a preloaded (readable) endpoint without an endpoint DB fetch', async () => {
    const spy = vi.spyOn(db.node, 'findUnique');
    const preloaded = { id: parent.id, loc: 'parent', memoryId: mem.id };

    const out = await edge.source({ sourceId: parent.id, source: preloaded }, null, ctx);

    expect((out as { id: string }).id).toBe(parent.id);
    expect(spy).not.toHaveBeenCalled(); // gate uses the preloaded memoryId; no node fetch
  });

  it('lazily loads source by FK when it was not preloaded (the 500 fix)', async () => {
    const spy = vi.spyOn(db.node, 'findUnique');
    // e.g. an OUTGOING edge from nodeById: only `target` was included.
    const out = await edge.source({ sourceId: parent.id }, null, ctx);

    expect((out as { id: string }).id).toBe(parent.id);
    expect(spy).toHaveBeenCalledWith({ where: { id: parent.id } });
  });

  it('lazily loads target by FK when it was not preloaded', async () => {
    const spy = vi.spyOn(db.node, 'findUnique');
    const out = await edge.target({ targetId: parent.id }, null, ctx);

    expect((out as { id: string }).id).toBe(parent.id);
    expect(spy).toHaveBeenCalledWith({ where: { id: parent.id } });
  });

  it('memoizes per request: edges sharing an endpoint fetch it once (no N+1)', async () => {
    // The shape that motivated this: nodeById { outgoingEdges { source } } —
    // every outgoing edge's source is the same parent node.
    const spy = vi.spyOn(db.node, 'findUnique');

    const results = await Promise.all([
      edge.source({ sourceId: parent.id }, null, ctx),
      edge.source({ sourceId: parent.id }, null, ctx),
      edge.source({ sourceId: parent.id }, null, ctx),
    ]);

    expect(results.map((r) => (r as { id: string }).id)).toEqual([parent.id, parent.id, parent.id]);
    expect(spy).toHaveBeenCalledTimes(1); // one Context = one request → endpoint fetched once
  });
});
