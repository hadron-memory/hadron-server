/** #2046 P5: revision-owned provenance, through the compiled node's read gate. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

let memoryId: string, agentId: string, reader: string, outsider: string;
const ctx = (userId = reader): Context => ({ db, userId, roles: ['READER'] }) as Context;
const field = (parent: object, args = {}, context = ctx()) =>
  (resolvers.Node as any).compiledProvenance(parent, args, context);
const occurrence = (order: number) => ({ order, depth: order ? 1 : 0, parent: order ? 0 : null,
  kind: order ? 'include' : 'source', nodeId: `recorded-source-${order}`, revNo: 3, hash: sha256Hex('source'),
  selection: { rev: null, approved: true, signed: false } });
async function fixture(count = 2) {
  const n = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId,
    loc: 'boot:compiled', name: 'Compiled', nodeType: 'compiled-boot-prompt', role: 'boot-prompt', content: 'compiled' } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: n.id, compiledRevNo: 1,
    targetKind: 'AGENT', targetAgentId: agentId, contentHash: sha256Hex('compiled'),
    occurrenceCount: count, provenance: { version: 1, occurrences: Array.from({ length: count }, (_, i) => occurrence(i)) } } });
  return n;
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Provenance', urn: 'prov2046' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'System', urn: 'prov2046:sys', organizationId: org.id } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'prov2046:agent', organizationId: org.id, systemMemoryId: memoryId } })).id;
  reader = (await db.user.create({ data: { id: generateId(), name: 'reader' } })).id;
  outsider = (await db.user.create({ data: { id: generateId(), name: 'outsider' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'ADMIN' } });
});
describe('#2046 compiled provenance read', () => {
  it('returns recorded metadata without loading source nodes or their text', async () => {
    const n = await fixture();
    expect(await field(n)).toMatchObject({ revision: 1, contentHash: sha256Hex('compiled'), total: 2,
      items: [occurrence(0), occurrence(1)], hasMore: false });
  });
  it('exposes the typed field through the executable GraphQL schema', async () => {
    const n = await fixture();
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    try {
      const result = await server.executeOperation({ query: `query($ref: ID!) { node(ref: $ref) {
        compiledProvenance { revision total hasMore items { nodeId revNo hash pruned selection { rev approved signed } } }
      } }`, variables: { ref: n.id } }, { contextValue: ctx() });
      expect(result.body.kind).toBe('single');
      if (result.body.kind === 'single') {
        expect(result.body.singleResult.errors).toBeUndefined();
        expect(result.body.singleResult.data).toMatchObject({ node: { compiledProvenance: { revision: 1, total: 2 } } });
      }
    } finally { await server.stop(); }
  });
  it('reports a missing source revision as pruned without losing recorded metadata', async () => {
    const n = await fixture();
    expect((await field(n)).items[0]).toMatchObject({ ...occurrence(0), pruned: true });
    await db.node.create({ data: { id: 'recorded-source-0', memoryId, loc: 'source', name: 'Source', revSeq: 3 } });
    expect((await field(n)).items[0].pruned).toBe(false);
    await db.node.update({ where: { id: 'recorded-source-0' }, data: { revSeq: 4 } });
    await db.nodeRevision.create({ data: { nodeId: 'recorded-source-0', memoryId, loc: 'source', name: 'Source', revNo: 3, tags: [] } });
    expect((await field(n)).items[0].pruned).toBe(false);
    await db.nodeRevision.deleteMany({ where: { nodeId: 'recorded-source-0' } });
    expect((await field(n)).items[0].pruned).toBe(true);
  });
  it('conceals denied and nonexistent nodes identically, even with a forged parent memory', async () => {
    const n = await fixture();
    expect(await field(n, {}, ctx(outsider))).toBeNull();
    expect(await field({ id: generateId(), memoryId }, {}, ctx(outsider))).toBeNull();
  });
  it('never trusts a readable parent memory after the node moves', async () => {
    const n = await fixture();
    const foreign = await db.memory.create({ data: { id: generateId(), class: 'private', userId: outsider, ownerUserId: outsider, name: 'Private', urn: '@outsider:private' } });
    await withCompileWrite(() => db.node.update({ where: { id: n.id }, data: { memoryId: foreign.id } }));
    expect(await field(n)).toBeNull();
  });
  it('keeps old revision provenance after a recompile, without a retained text snapshot', async () => {
    const n = await fixture();
    await withCompileWrite(() => db.node.update({ where: { id: n.id }, data: { revSeq: 2, content: 'new' } }));
    await db.compiledPromptRevision.create({ data: { compiledNodeId: n.id, compiledRevNo: 2, targetKind: 'AGENT', targetAgentId: agentId,
      contentHash: sha256Hex('new'), occurrenceCount: 1, provenance: { version: 1, occurrences: [occurrence(0)] } } });
    expect(await field(n, { revision: 1 })).toMatchObject({ revision: 1, total: 2, contentHash: sha256Hex('compiled') });
    expect(await field(n)).toMatchObject({ revision: 2, total: 1, contentHash: sha256Hex('new') });
  });
  it('returns null for an ordinary node, absent revision or absent provenance; never fabricates history', async () => {
    const n = await fixture();
    expect(await field(n, { revision: 2 })).toBeNull();
    const plain = await db.node.create({ data: { id: generateId(), memoryId, loc: 'plain', name: 'Plain' } });
    expect(await field(plain)).toBeNull();
  });
  it('paginates with stable occurrence order, a real total, zero limit and cap 200', async () => {
    const n = await fixture(205);
    expect(await field(n, { limit: 2, offset: 2 })).toMatchObject({ total: 205, items: [occurrence(2), occurrence(3)], hasMore: true });
    expect((await field(n, { limit: 999 })).items).toHaveLength(200);
    expect(await field(n, { limit: 0 })).toMatchObject({ total: 205, items: [], hasMore: true });
  });
  it('suppresses provenance on inherited and concealed install parents', async () => {
    const n = await fixture();
    expect(await field({ ...n, inheritedFrom: { via: memoryId } })).toBeNull();
    expect(await field({ ...n, __installConcealed: true })).toBeNull();
  });
  it('does not expose records for a soft-deleted compiled node', async () => {
    const n = await fixture();
    await withCompileWrite(() => db.node.update({ where: { id: n.id }, data: { deletedAt: new Date() } }));
    expect(await field(n)).toBeNull();
  });
});
