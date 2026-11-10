import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { moveNodeSubtree } from '../../../lib/nodeSubtreeMove.js';
import { isMemoryReadableCached } from './resolvers.helpers.js';

const M = resolvers.Mutation as any;
let ctx: Context;
let sourceMemoryId: string;
let destinationId: string;
let hiddenMemoryId: string;
beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { githubId: 5037, githubUsername: 'move-links' } });
  const own = await createDbOrgAndGraph(db, { orgName: 'links-own', graphName: 'source', visibility: 'ORGANIZATION' });
  await db.orgMember.create({ data: { organizationId: own.org.id, userId: user.id, role: 'ADMIN' } });
  sourceMemoryId = own.graph.id;
  destinationId = (await db.memory.create({ data: { organizationId: own.org.id, urn: 'links-own:destination', name: 'Destination', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  hiddenMemoryId = (await createDbOrgAndGraph(db, { orgName: 'links-other', graphName: 'hidden', visibility: 'ORGANIZATION' })).graph.id;
  ctx = { db, userId: user.id, roles: [] };
});

afterEach(() => vi.restoreAllMocks());

for (const operation of ['moveNode', 'mcp'] as const) {
  describe(operation, () => {
    async function warnings(target: string) {
      await createDbNode(db, { memoryId: sourceMemoryId, loc: target });
      const source = await createDbNode(db, { memoryId: sourceMemoryId, loc: 'moving', content: `[[${target}]]` });
      if (operation === 'mcp') {
        const server = createTestableMcpServer({ userId: ctx.userId, roles: [], clientId: `user:${ctx.userId}` },
          { sessionId: 'move-links-session', cachedAppResolution: { kind: 'multi-app' } });
        const result = await server.callTool('hadron_move_node', {
          urn: 'hrn:node:links-own:source:moving', targetUrn: 'hrn:node:links-own:destination:moving',
        });
        expect(result).not.toHaveProperty('isError', true);
        const text = result.content.map(c => 'text' in c ? c.text : '').join('\n');
        expect(text).toContain('Broken content links (1):');
        expect(text).toContain(`[[${target}]]`);
        const status = text.includes('ambiguous in destination') ? 'AMBIGUOUS'
          : text.includes('missing in destination') ? 'MISSING'
          : text.includes('points to a different node in destination') ? 'RETARGETED' : 'UNKNOWN';
        return [{ target, status }];
      }
      const result = await M[operation](null, { sourceRef: source.id, targetMemoryRef: destinationId }, ctx);
      return result.moveLinkWarnings;
    }
    it('treats unavailable ambiguous candidates like a missing reference', async () => {
      const target = 'links-other:hidden:old';
      for (const loc of ['one', 'two']) {
        const node = await createDbNode(db, { memoryId: hiddenMemoryId, loc });
        await db.urnAlias.create({ data: { entityType: 'NODE', entityId: node.id, urn: target, reason: 'RENAME' } });
      }
      await expect(resolvers.Query.node(null, { ref: 'hrn:node:links-other:hidden:one' }, ctx)).resolves.toBeNull();
      expect(await warnings(target)).toMatchObject([{ target, status: 'MISSING' }]);
    });
    it.each(['destination', 'source'] as const)('keeps ambiguity visible with a readable %s claimant', async readable => {
      const target = 'links-other:hidden:old';
      for (const [memoryId, loc] of [[hiddenMemoryId, 'hidden'], [readable === 'destination' ? destinationId : sourceMemoryId, 'visible']]) {
        const node = await createDbNode(db, { memoryId, loc });
        await db.urnAlias.create({ data: { entityType: 'NODE', entityId: node.id, urn: target, reason: 'RENAME' } });
      }
      expect(await warnings(target)).toMatchObject([{ target, status: 'AMBIGUOUS' }]);
    });
    it('refreshes reference readability inside the deciding transaction', async () => {
      const memory = await db.memory.findUniqueOrThrow({ where: { id: hiddenMemoryId } });
      const membership = await db.orgMember.create({ data: { organizationId: memory.organizationId!, userId: ctx.userId!, role: 'READER' } });
      const target = 'links-other:hidden:old';
      for (const loc of ['one', 'two']) {
        const node = await createDbNode(db, { memoryId: hiddenMemoryId, loc });
        await db.urnAlias.create({ data: { entityType: 'NODE', entityId: node.id, urn: target, reason: 'RENAME' } });
      }
      expect(await isMemoryReadableCached(ctx, hiddenMemoryId)).toBe(true);
      const transact = db.$transaction.bind(db);
      let changed = false;
      vi.spyOn(db, '$transaction').mockImplementation((async (work: any, options: any) => {
        if (!changed) {
          changed = true;
          await db.orgMember.delete({ where: { id: membership.id } });
        }
        return transact(work, options);
      }) as any);
      expect(await warnings(target)).toMatchObject([{ target, status: 'MISSING' }]);
      expect(changed).toBe(true);
    });
    it('does not retarget a single unrelated candidate', async () => {
      await createDbNode(db, { memoryId: hiddenMemoryId, loc: 'single' });
      const target = 'links-other:hidden:single';
      expect(await warnings(target)).toMatchObject([{ target, status: 'MISSING' }]);
    });
    it('treats an unavailable historical holder like a missing reference', async () => {
      await db.urnAlias.create({ data: { entityType: 'MEMORY', entityId: hiddenMemoryId, urn: 'links-own:destination', reason: 'RENAME' } });
      const target = 'links-own:destination:old';
      const hidden = await createDbNode(db, { memoryId: hiddenMemoryId, loc: 'old' });
      const alsoHidden = await createDbNode(db, { memoryId: hiddenMemoryId, loc: 'other' });
      await db.urnAlias.create({ data: { entityType: 'NODE', entityId: alsoHidden.id, urn: target, reason: 'RENAME' } });
      expect(hidden.id).not.toBe(alsoHidden.id);
      await expect(resolvers.Query.node(null, { ref: `hrn:node:links-other:hidden:old` }, ctx)).resolves.toBeNull();
      expect(await warnings(target)).toMatchObject([{ target, status: 'MISSING' }]);
    });
  });
}


describe('server-authored move reference fallback', () => {
  it('uses only the context memory without a caller predicate', async () => {
    const target = 'links-other:hidden:old';
    const root = await createDbNode(db, { memoryId: sourceMemoryId, loc: 'moving', content: `[[${target}]]` });
    await createDbNode(db, { memoryId: sourceMemoryId, loc: target });
    const hidden = await createDbNode(db, { memoryId: hiddenMemoryId, loc: 'one' });
    const visible = await createDbNode(db, { memoryId: destinationId, loc: 'two' });
    for (const node of [hidden, visible]) await db.urnAlias.create({ data: { entityType: 'NODE', entityId: node.id, urn: target, reason: 'RENAME' } });
    const result = await db.$transaction(tx => moveNodeSubtree(tx, {
      source: root, destLoc: 'moving', destMemoryId: destinationId, editor: { info: 'server' },
    }));
    expect(result.linkWarnings).toMatchObject([{ target, status: 'AMBIGUOUS' }]);
  });
  it('conceals candidates outside the context without a caller predicate', async () => {
    const target = 'links-other:hidden:old';
    const root = await createDbNode(db, { memoryId: sourceMemoryId, loc: 'moving', content: `[[${target}]]` });
    await createDbNode(db, { memoryId: sourceMemoryId, loc: target });
    for (const loc of ['one', 'two']) {
      const node = await createDbNode(db, { memoryId: hiddenMemoryId, loc });
      await db.urnAlias.create({ data: { entityType: 'NODE', entityId: node.id, urn: target, reason: 'RENAME' } });
    }
    const result = await db.$transaction(tx => moveNodeSubtree(tx, {
      source: root, destLoc: 'moving', destMemoryId: destinationId, editor: { info: 'server' },
    }));
    expect(result.linkWarnings).toMatchObject([{ target, status: 'MISSING' }]);
  });
});
