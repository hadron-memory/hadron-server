/** #2245: `cloneMemoryGraphInTx` runs in the caller's transaction and hands back the node id map. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import { cloneMemoryGraphInTx } from './cloneMemory.js';

let orgId: string;
let memId: string;
const ids = { a: generateId(), b: generateId(), gone: generateId() };

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cm-a', urn: 'cm-a' } })).id;
  memId = generateId();
  await db.memory.create({ data: { id: memId, organizationId: orgId, name: 'src', urn: 'cm-a:src', class: 'knowledge' } as never });
  const node = (id: string, loc: string, deletedAt?: Date) =>
    db.node.create({ data: { id, memoryId: memId, loc, name: loc, nodeType: 'page', ...(deletedAt ? { deletedAt } : {}) } as never });
  await node(ids.a, 'a');
  await node(ids.b, 'b');
  await node(ids.gone, 'gone', new Date());
  const edge = (to: string, loc: string) =>
    db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: ids.a, targetId: to, loc: deriveEdgeLoc('a', loc, loc), name: loc } as never });
  await edge(ids.b, 'b');
  await edge(ids.gone, 'gone');
});

describe('cloneMemoryGraphInTx', () => {
  it('returns the old->new node map and the skipped edge count', async () => {
    const result = await db.$transaction((tx) =>
      cloneMemoryGraphInTx(tx, {
        sourceMemoryId: memId, name: 'copy', newUrn: 'cm-a:copy', targetOrganizationId: orgId,
        ownerUserId: null, groupOwnerUserId: null, actorId: null, copierReadableMemoryIds: null,
      }),
    );
    expect([...result.nodeIdMap.keys()].sort()).toEqual([ids.a, ids.b].sort());
    expect(result.nodeCount).toBe(2);
    expect(result.edgeCount).toBe(1);
    expect(result.skippedEdgeCount).toBe(1);
    const copied = await db.node.findMany({ where: { memoryId: result.memoryId } });
    expect(copied.map((n) => n.id).sort()).toEqual([...result.nodeIdMap.values()].sort());
  });

  it('rolls everything back with the caller\'s transaction', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await cloneMemoryGraphInTx(tx, {
          sourceMemoryId: memId, name: 'copy', newUrn: 'cm-a:copy', targetOrganizationId: orgId,
          ownerUserId: null, groupOwnerUserId: null, actorId: null, copierReadableMemoryIds: null,
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await db.memory.count({ where: { urn: 'cm-a:copy' } })).toBe(0);
  });
});
