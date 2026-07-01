/**
 * Regression test for #391: soft-deleted nodes must not leak into the
 * portal-facing read resolvers (nodes / nodeById / node(loc:) / nodeExport),
 * matching resolveUrn / the MCP find-list tools. A leak is what made a node
 * show in lists and open by PK while its URN 404s.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

const Q = resolvers.Query as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>;
const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: generateId() });

interface Fx {
  memoryId: string;
  liveId: string;
  liveLoc: string;
  deletedId: string;
  deletedLoc: string;
}

async function build(): Promise<Fx> {
  const org = await db.organization.create({ data: { id: generateId(), name: 'SoftDel', urn: 'softdel' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'softdel:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const live = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'tasks:add-platform-spec', name: 'Live', tags: [] },
  });
  const deleted = await db.node.create({
    data: {
      id: generateId(), memoryId: memory.id, loc: 'tasks:add-spec', name: 'Deleted',
      tags: [], deletedAt: new Date(), deletedBy: 'mcp',
    },
  });
  return { memoryId: memory.id, liveId: live.id, liveLoc: live.loc, deletedId: deleted.id, deletedLoc: deleted.loc };
}

describe('#391 soft-deleted nodes excluded from read resolvers', () => {
  let fx: Fx;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await build();
  });

  it('findNodes lists the live node but not the soft-deleted one', async () => {
    const res = (await Q.findNodes(
      null,
      { filter: { memoryIds: [fx.memoryId] } },
      adminCtx(),
    )) as { hits: Array<{ node: { id: string } }> };
    const ids = res.hits.map((h) => h.node.id);
    expect(ids).toContain(fx.liveId);
    expect(ids).not.toContain(fx.deletedId);
  });

  it('nodeById returns null for a soft-deleted node, the row for a live one', async () => {
    expect(await Q.nodeById(null, { id: fx.deletedId }, adminCtx())).toBeNull();
    expect(await Q.nodeById(null, { id: fx.liveId }, adminCtx())).not.toBeNull();
  });

  it('node(loc:) returns null for a soft-deleted loc, the node for a live one', async () => {
    expect(await Q.node(null, { loc: fx.deletedLoc, memory: fx.memoryId }, adminCtx())).toBeNull();
    expect(await Q.node(null, { loc: fx.liveLoc, memory: fx.memoryId }, adminCtx())).not.toBeNull();
  });

  it('nodeExport throws NOT_FOUND for a soft-deleted node', async () => {
    await expect(Q.nodeExport(null, { id: fx.deletedId, format: 'MD', full: true }, adminCtx())).rejects.toThrow(/not found/i);
    await expect(Q.nodeExport(null, { id: fx.liveId, format: 'MD', full: true }, adminCtx())).resolves.toBeTruthy();
  });
});
