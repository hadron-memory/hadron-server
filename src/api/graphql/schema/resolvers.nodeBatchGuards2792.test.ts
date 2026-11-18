import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import * as effectiveMemory from '../../../lib/effectiveSystemMemory.js';
import { resolvers, type Context } from './resolvers.js';
import { chargeBatchReadEdges } from './resolvers.nodeBatchEdges.js';

beforeEach(async () => { await cleanDb(db); });
afterEach(() => vi.restoreAllMocks());

async function fixture(direction: 'out' | 'in', count = 1) {
  const { org } = await createDbOrgAndGraph(db, { orgName: 'guards2792.example', graphName: 'home' });
  const user = await db.user.create({ data: { handle: 'guards2792' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const make = async (name: string, extendsAgentId?: string) => {
    const memory = await db.memory.create({ data: { organizationId: org.id, class: 'system', name, urn: `guards2792.example:${name}` } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name, urn: `guards2792.example:${name}`, visibility: 'ORGANIZATION', systemMemoryId: memory.id, extendsAgentId } });
    return { memory, agent };
  };
  const base = await make('base');
  const child = await make('child', base.agent.id);
  const external = await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'external', urn: 'guards2792.example:external' } });
  const node = await createDbNode(db, { memoryId: base.memory.id, loc: 'inherited', content: 'BASE' });
  const endpoint = await createDbNode(db, { memoryId: external.id, loc: 'outside', content: 'EXTERNAL' });
  await db.edge.createMany({ data: Array.from({ length: count }, (_, i) => ({ id: generateId(), memoryId: base.memory.id, loc: `edge:${i}`, sourceId: direction === 'out' ? node.id : endpoint.id, targetId: direction === 'out' ? endpoint.id : node.id })) });
  const ctx: Context = { db, userId: user.id, roles: ['READER'] };
  const batch = await (resolvers.Query as any).nodeBatch({}, { refs: [`hrn:node:${child.memory.urn}:inherited`] }, ctx);
  expect(batch.nodes).toHaveLength(1);
  const parent = batch.nodes[0];
  expect(parent.inheritedFrom).toMatchObject({ via: child.memory.id });
  return { parent, endpoint, ctx };
}

for (const direction of ['out', 'in'] as const) {
  for (const change of ['unchanged', 'deleted', 'renamed'] as const) {
    it(`lazy inherited ${direction} external endpoint rechecks ${change} after metadata admission`, async () => {
      const { parent, endpoint, ctx } = await fixture(direction);
      const field = direction === 'out' ? 'outgoingEdges' : 'incomingEdges';
      const side = direction === 'out' ? 'target' : 'source';
      const edges = await (resolvers.Node as any)[field](parent, {}, ctx);
      expect(edges).toHaveLength(1);
      // The far endpoint is outside the effective chain. Its live/address guard
      // must decide this race, rather than a second effective-chain lookup.
      if (change === 'deleted') await db.node.update({ where: { id: endpoint.id }, data: { deletedAt: new Date() } });
      if (change === 'renamed') await db.node.update({ where: { id: endpoint.id }, data: { loc: 'moved' } });
      const selected = await (resolvers.Edge as any)[side](edges[0], {}, ctx);
      if (change === 'unchanged') expect(selected).toMatchObject({ id: endpoint.id, content: 'EXTERNAL' });
      else expect(selected).toBeNull();
    });
  }
}

it('forwards only the remaining shared edge budget into the inherited loader', async () => {
  const { parent, ctx } = await fixture('out', 3);
  chargeBatchReadEdges(parent, 1999);
  const loader = vi.spyOn(effectiveMemory, 'resolveInheritedEdges');
  await expect((resolvers.Node as any).outgoingEdges(parent, {}, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  expect(loader).toHaveBeenCalledTimes(1);
  expect(loader.mock.calls[0][1]).toMatchObject({ maxResults: 1, identityOnly: true });
});
