/**
 * `Node.memory` field resolver coverage.
 *
 * The generic `nodes` query resolver does NOT `include` the memory
 * relation, and the Node type had no `memory` field resolver — so
 * `node { memory { urn } }` resolved to null. Clients that compose a
 * full node URN from `<memory.urn>::<loc>` (the portal node-list badge,
 * graph view) silently degraded to loc-only. The resolver added here
 * lazy-loads the memory by memoryId.
 *
 * #2193 / #474: it answers as Query.memory does for the caller, so it never
 * reuses a preloaded relation (appNodes' is truncated and authorizes
 * nothing); the record gate itself is pinned in
 * resolvers.nodeMemoryGate2193.test.ts.
 *
 * Integration test against the real hadron_test DB (pinned by
 * vitest.config.ts).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

let ctx: Context;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeMemory = (resolvers as any).Node.memory as (
  parent: { memoryId: string; memory?: unknown },
  args: unknown,
  ctx: Context,
) => Promise<{ urn: string } | null>;

describe('Node.memory field resolver', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  it('lazy-loads the memory by memoryId when the relation is not preloaded', async () => {
    const { graph } = await createDbOrgAndGraph(db, {
      orgName: 'micromentor.org',
      graphName: 'mmdata',
    });
    const node = await createDbNode(db, { loc: 'app', memoryId: graph.id });
    const reader = await db.user.create({ data: { handle: 'node-memory-reader', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: graph.organizationId!, userId: reader.id, role: 'READER' } });
    ctx = { db, userId: reader.id, roles: ['READER'] } as Context;

    // Mirrors the `nodes` query shape: no `memory` relation included.
    const resolved = await nodeMemory({ memoryId: node.memoryId }, {}, ctx);

    expect(resolved).not.toBeNull();
    expect(resolved!.urn).toBe(graph.urn); // 'micromentor.org:mmdata'
  });

  it('never reuses a preloaded relation: a preload names no readable record', async () => {
    const preloaded = { urn: 'micromentor.org:mmdata', id: 'mem-x' };
    const resolved = await nodeMemory({ memoryId: 'mem-x', memory: preloaded }, {}, { db } as unknown as Context);
    expect(resolved).toBeNull();
  });
});
