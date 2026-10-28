/** #2046 P5: revision-owned, bounded provenance through the compiled node read gate. */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { typeDefs } from './typeDefs.js';
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
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
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

  it('executes the public SDL with nested selection and nullable tag fields', async () => {
    const response = await graphql({ schema: buildSchema(typeDefs),
      source: 'query($ref:ID!){compiledPromptProvenance(nodeRef:$ref,revNo:2,limit:1){nodeId revNo version contentHash pruned total hasMore items{order depth parent kind nodeId revNo hash replacesNodeId position{line column} selection{rev approved signed} pruned}}}',
      variableValues: { ref: nodeId }, contextValue: ctx,
      fieldResolver: (parent, args, context, info) => {
        const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
        const fn = fields?.[info.fieldName];
        return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
      },
    });
    expect(response.errors).toBeUndefined();
    expect(response.data?.compiledPromptProvenance).toMatchObject({ nodeId, total: 2, hasMore: true, version: 1,
      items: [{ kind: 'source', parent: null, replacesNodeId: null, position: null }] });
  });

  it('rechecks revoked membership even after an earlier allowed read on the same context', async () => {
    expect(await query({ nodeRef: nodeId, revNo: 2 }, ctx)).not.toBeNull();
    await db.orgMember.updateMany({ where: { userId: ctx.userId }, data: { deletedAt: new Date() } });
    expect(await query({ nodeRef: nodeId, revNo: 2 }, ctx)).toBeNull();
  });

  it('retained source history is not pruned, even after the source advances', async () => {
    await db.nodeRevision.create({ data: { nodeId: sourceId, memoryId, loc: 'source', name: 'source', content: 'source text', revNo: 1 } });
    await db.node.update({ where: { id: sourceId }, data: { revSeq: 2 } });
    expect((await query({ nodeRef: nodeId, revNo: 2 }, ctx)).items[0].pruned).toBe(false);
    await db.nodeRevision.create({ data: { nodeId, memoryId, loc: 'boot:compiled', name: 'compiled', content: 'compiled', revNo: 1 } });
    expect((await query({ nodeRef: nodeId, revNo: 1 }, ctx)).pruned).toBe(false);
  });

  it('bounds default and negative paging without changing total or order', async () => {
    await record(3, 25);
    await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { revSeq: 3 } }));
    expect((await query({ nodeRef: nodeId, revNo: 3 }, ctx)).items).toHaveLength(20);
    expect(await query({ nodeRef: nodeId, revNo: 3, limit: -1, offset: -5 }, ctx)).toMatchObject({ items: [], total: 25, hasMore: true });
    expect(await query({ nodeRef: nodeId, revNo: 3, offset: 500 }, ctx)).toMatchObject({ items: [], total: 25, hasMore: false });
  });


  it('exposes recorded identities under the compiled gate without admitting foreign source content', async () => {
    const org = await db.organization.create({ data: { name: 'foreign', urn: 'foreign' } });
    const memory = await db.memory.create({ data: { name: 'foreign', urn: 'foreign:private-source', organizationId: org.id, class: 'knowledge' } });
    await db.node.update({ where: { id: sourceId }, data: { memoryId: memory.id } });
    expect(await resolvers.Query.node(null, { ref: sourceId }, ctx)).toBeNull();
    expect((await query({ nodeRef: nodeId, revNo: 2 }, ctx)).items[0]).toMatchObject({ nodeId: sourceId, revNo: 1, pruned: false });
  });

  it('fails closed on malformed stored provenance rather than substituting another revision', async () => {
    await db.compiledPromptRevision.create({ data: {
      compiledNodeId: nodeId, compiledRevNo: 3, contentHash: sha256Hex('compiled'), targetKind: 'AGENT', targetAgentId: agentId,
      occurrenceCount: 1, provenance: { version: 999, occurrences: [] },
    } });
    await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { revSeq: 3 } }));
    await expect(query({ nodeRef: nodeId, revNo: 3 }, ctx)).rejects.toThrow(/valid provenance/i);
  });

});
