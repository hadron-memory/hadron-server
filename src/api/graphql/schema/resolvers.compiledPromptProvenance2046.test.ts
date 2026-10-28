/** #2046 P5: revision-owned, bounded provenance through the compiled node read gate. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';

const query = (args: Record<string, unknown>, ctx: Context) =>
  (resolvers.Query as any).compiledPromptProvenance(null, args, ctx);
let ctx: Context;
let nodeId: string;
let sourceId: string;
let memoryId: string;
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'provenance', urn: 'provenance' } });
  const user = await db.user.create({ data: { name: 'reader' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
  memoryId = (await db.memory.create({ data: { name: 'system', urn: 'provenance:system', class: 'system', organizationId: org.id } })).id;
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: 'provenance:agent', organizationId: org.id, systemMemoryId: memoryId } })).id;
  sourceId = (await db.node.create({ data: { memoryId, loc: 'source', name: 'Secret source name', content: 'source text' } })).id;
  nodeId = (await withCompileWrite(() => db.node.create({ data: {
    memoryId, loc: 'boot:compiled', name: 'Compiled', nodeType: 'compiled-boot-prompt', role: 'boot-prompt', content: 'compiled', revSeq: 2,
  } }))).id;
  ctx = { db, userId: user.id, roles: ['READER'] } as Context;
  await record(1, 1);
  await record(2, 2);
});

async function record(revNo: number, count: number) {
  await db.compiledPromptRevision.create({ data: {
    compiledNodeId: nodeId, compiledRevNo: revNo, contentHash: sha256Hex('compiled'), targetKind: 'AGENT', targetAgentId: agentId,
    occurrenceCount: count, provenance: { version: 1, occurrences: Array.from({ length: count }, (_, order) => ({
      order, depth: order ? 1 : 0, parent: order ? 0 : null, kind: order ? 'include' : 'source', nodeId: sourceId,
      revNo: 1, hash: sha256Hex('source text'), selection: { rev: null, approved: true, signed: false },
    })) },
  } });
}

describe('compiledPromptProvenance', () => {
  it('reads exactly the requested revision, including pruned compiled history, never the latest edge', async () => {
    const old = await query({ nodeRef: nodeId, revNo: 1 }, ctx);
    expect(old).toMatchObject({ nodeId, revNo: 1, pruned: true, total: 1, hasMore: false });
    expect(old.items[0]).toMatchObject({ order: 0, nodeId: sourceId, revNo: 1, pruned: false, selection: { rev: null, approved: true, signed: false } });
    expect(await query({ nodeRef: 'hrn:node:provenance:system:boot:compiled', revNo: 2 }, ctx)).toMatchObject({ revNo: 2, pruned: false, total: 2 });
    expect(JSON.stringify(old)).not.toContain('Secret source name');
    expect(old).not.toHaveProperty('content');
    expect(old.items[0]).not.toHaveProperty('content');
  });

  it('conceals denied, missing, ordinary and deleted nodes before provenance access', async () => {
    const outsider = await db.user.create({ data: { name: 'outsider' } });
    expect(await query({ nodeRef: nodeId, revNo: 1 }, { ...ctx, userId: outsider.id })).toBeNull();
    expect(await query({ nodeRef: generateId(), revNo: 1 }, ctx)).toBeNull();
    expect(await query({ nodeRef: sourceId, revNo: 1 }, ctx)).toBeNull();
    await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } }));
    expect(await query({ nodeRef: nodeId, revNo: 1 }, ctx)).toBeNull();
  });

  it('paginates occurrences without losing their recorded order and clamps at 100', async () => {
    await record(3, 103);
    await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { revSeq: 3 } }));
    const first = await query({ nodeRef: nodeId, revNo: 3, limit: 999 }, ctx);
    expect(first.items).toHaveLength(100);
    expect(first).toMatchObject({ total: 103, hasMore: true });
    const tail = await query({ nodeRef: nodeId, revNo: 3, offset: 100 }, ctx);
    expect(tail.items.map((x: any) => x.order)).toEqual([100, 101, 102]);
    expect(tail.hasMore).toBe(false);
    expect(await query({ nodeRef: nodeId, revNo: 3, limit: 0 }, ctx)).toMatchObject({ items: [], total: 103, hasMore: true });
  });

  it('reports source revision pruning without substituting its current revision', async () => {
    await db.node.update({ where: { id: sourceId }, data: { revSeq: 2, content: 'new source' } });
    const result = await query({ nodeRef: nodeId, revNo: 2 }, ctx);
    expect(result.items[0]).toMatchObject({ revNo: 1, hash: sha256Hex('source text'), pruned: true });
  });

  it('does not invent empty provenance for a missing row or accept nonexistent revisions', async () => {
    expect(await query({ nodeRef: nodeId, revNo: 4 }, ctx)).toBeNull();
    expect(await query({ nodeRef: nodeId, revNo: 0 }, ctx)).toBeNull();
    await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { revSeq: 3 } }));
    await expect(query({ nodeRef: nodeId, revNo: 3 }, ctx)).rejects.toThrow(/provenance/i);
  });
});
