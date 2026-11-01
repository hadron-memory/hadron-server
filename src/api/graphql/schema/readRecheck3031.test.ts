/** #3031: deciding read checks retain the preflight audience after an authority change. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import * as helpers from './resolvers.helpers.js';
import type { Context } from './resolvers.helpers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
const context = (userId: string, roles: Context['roles'] = []): Context => ({ db, userId, roles, clientId: `user:${userId}` });
beforeEach(async () => { await cleanDb(db); });
afterEach(() => vi.restoreAllMocks());

// The callback commits real DB changes after pooled preflight, before the deciding transaction starts.
// It changes no gate result or transaction client: every authorization check still executes against PostgreSQL.
function beforeTransaction(ctx: Context, change: () => Promise<void>) {
  let crossed = false;
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return async (work: any, options: any) => {
      expect(crossed).toBe(false);
      crossed = true;
      await change();
      return target.$transaction(work, options);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ctx: { ...ctx, db: wrapped }, crossed: () => crossed };
}
async function state(memoryIds: string[]) {
  return {
    nodes: await db.node.findMany({ where: { memoryId: { in: memoryIds } }, orderBy: { id: 'asc' } }),
    edges: await db.edge.findMany({ where: { memoryId: { in: memoryIds } }, orderBy: { id: 'asc' } }),
    revisions: await db.nodeRevision.findMany({ where: { memoryId: { in: memoryIds } }, orderBy: { id: 'asc' } }),
  };
}
async function ownedSystem() {
  const actor = await db.user.create({ data: { name: 'fixture-admin', roles: ['ADMIN'] } });
  const next = await db.user.create({ data: { name: 'fixture-new-owner' } });
  const memory = await db.memory.create({ data: { name: 'fixture-brain', urn: `fixture.test:brain-${generateId()}`, class: 'system', ownerUserId: actor.id } });
  const agent = await db.agent.create({ data: { name: 'fixture-agent', urn: `fixture.test:agent-${generateId()}`, ownerUserId: actor.id, systemMemoryId: memory.id } });
  const ctx = context(actor.id, ['ADMIN']);
  const node = await M.createNode({}, { input: { memoryId: memory.id, loc: 'source', name: 'Source', content: 'before' } }, ctx);
  const destination = await db.memory.create({ data: { name: 'fixture-destination', urn: `fixture.test:dest-${generateId()}`, class: 'private', userId: actor.id, ownerUserId: actor.id } });
  const removeRead = () => db.$transaction(async tx => {
    await tx.agent.update({ where: { id: agent.id }, data: { ownerUserId: next.id } });
    await tx.memory.update({ where: { id: memory.id }, data: { ownerUserId: next.id } });
  });
  return { actor, memory, agent, node, destination, ctx, removeRead };
}
for (const door of ['moveNode', 'searchReplaceInNodes'] as const) {
  const call = (f: Awaited<ReturnType<typeof ownedSystem>>, ctx: Context) => door === 'moveNode'
    ? M.moveNode({}, { sourceRef: f.node.id, targetMemoryRef: f.destination.id }, ctx)
    : M.searchReplaceInNodes({}, { input: { nodeIds: [f.node.id], oldText: 'before', newText: 'after', fields: ['content'] } }, ctx);
  describe(`#3031 ${door} user-owned system read boundary`, () => {
    it('allows the reader and persists the change', async () => {
      const f = await ownedSystem();
      await call(f, f.ctx);
      const node = await db.node.findUniqueOrThrow({ where: { id: f.node.id } });
      if (door === 'moveNode') expect(node.memoryId).toBe(f.destination.id);
      else expect(node.content).toBe('after');
    });
    it('refuses a write-only manager at preflight without changing nodes, edges or history', async () => {
      const f = await ownedSystem(); await f.removeRead();
      const before = await state([f.memory.id, f.destination.id]);
      await expect(call(f, f.ctx)).rejects.toThrow();
      expect(await state([f.memory.id, f.destination.id])).toEqual(before);
    });
    it('rechecks read reach after preflight while platform-manager write remains', async () => {
      const f = await ownedSystem(); const before = await state([f.memory.id, f.destination.id]);
      const seam = beforeTransaction(f.ctx, f.removeRead);
      await expect(call(f, seam.ctx)).rejects.toMatchObject(door === 'moveNode'
        ? { extensions: { code: 'NODE_NOT_FOUND', ref: f.node.id } }
        : { name: 'MemoryNotFoundError' });
      expect(seam.crossed()).toBe(true);
      expect(await state([f.memory.id, f.destination.id])).toEqual(before);
      // The independently retained platform role is not what refused the operation.
      await helpers.requireMemoryWriteAccess({ ...f.ctx, installWritePreflight: true }, f.memory.id);
    });
  });
}
async function installFixture() {
  const org = await db.organization.create({ data: { name: 'fixture-org', urn: `fixture-${generateId()}.test` } });
  // A platform manager outside this org: App membership supplies read independently of management.
  const actor = await db.user.create({ data: { name: 'fixture-platform-manager', roles: ['ADMIN'] } });
  const agent = await db.agent.create({ data: { name: 'fixture-installed', urn: `${org.urn}:agent`, organizationId: org.id } });
  const ctx = context(actor.id, ['ADMIN']);
  const create = async (slug: string) => {
    const { app } = await createDbAppWithKey(db, slug, org.id);
    await createDbAppAgent(db, app.id, agent.id); await createDbAppMember(db, app.id, actor.id, 'member');
    const node = await M.createNode({}, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'source', name: 'Source', content: 'before' } }, ctx);
    return { app, node };
  };
  const current = await create('fixture-current'); const provenance = await create('fixture-provenance');
  const revision = await db.nodeRevision.create({ data: { nodeId: current.node.id, memoryId: provenance.node.memoryId, loc: 'source', name: 'Prior', content: 'prior', tags: [], changes: [], revNo: 0 } });
  return { actor, ctx, current, provenance, revision };
}
describe('#3031 restore current and provenance readability independently', () => {
  it('allows a reader of both memories', async () => {
    const f = await installFixture();
    await M.restoreNodeRevision({}, { revisionId: f.revision.id }, f.ctx);
    expect((await db.node.findUniqueOrThrow({ where: { id: f.current.node.id } })).content).toBe('prior');
  });
  for (const side of ['current', 'provenance'] as const) {
    for (const interleave of [false, true]) {
      it(`refuses missing ${side} read (${interleave ? 'after preflight' : 'write-only manager'}) and preserves state`, async () => {
        const f = await installFixture();
        const removeRead = async () => { await db.appMember.delete({ where: { appId_userId: { appId: f[side].app.id, userId: f.actor.id } } }); };
        const before = await state([f.current.node.memoryId, f.provenance.node.memoryId]);
        let ctx = f.ctx; let crossed = () => false;
        if (interleave) { const seam = beforeTransaction(ctx, removeRead); ctx = seam.ctx; crossed = seam.crossed; }
        else await removeRead();
        await expect(M.restoreNodeRevision({}, { revisionId: f.revision.id }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND', revisionId: f.revision.id } });
        expect(crossed()).toBe(interleave);
        expect(await state([f.current.node.memoryId, f.provenance.node.memoryId])).toEqual(before);
      });
    }
  }
});

it.each(['moveNode', 'searchReplaceInNodes', 'restoreNodeRevision', 'deleteNode'] as const)('#3031 %s single-memory install authority precedes entry to the deciding write gate', async door => {
  const f = await installFixture(); let observed = false;
  // Same-memory restore and move: this pin distinguishes first acquisition from a later in-gate re-entry.
  await db.nodeRevision.update({ where: { id: f.revision.id }, data: { memoryId: f.current.node.memoryId } });
  const original = helpers.requireMemoryWriteAccess;
  vi.spyOn(helpers, 'requireMemoryWriteAccess').mockImplementation(async (ctx, memoryId) => {
    if (memoryId === f.current.node.memoryId && typeof (ctx.db as any).$transaction !== 'function') {
      const rows = await db.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('authorization:app'), hashtext(${f.current.app.id})) AS acquired`;
      expect(rows[0]?.acquired).toBe(false);
      observed = true;
    }
    return original(ctx, memoryId);
  });
  if (door === 'moveNode') await M.moveNode({}, { sourceRef: f.current.node.id, targetUrn: `hrn:node:${(await db.memory.findUniqueOrThrow({ where: { id: f.current.node.memoryId } })).urn}:moved` }, f.ctx);
  else if (door === 'searchReplaceInNodes') await M.searchReplaceInNodes({}, { input: { nodeIds: [f.current.node.id], oldText: 'before', newText: 'after', fields: ['content'] } }, f.ctx);
  else if (door === 'restoreNodeRevision') await M.restoreNodeRevision({}, { revisionId: f.revision.id }, f.ctx);
  else await M.deleteNode({}, { nodeRef: f.current.node.id }, f.ctx);
  expect(observed).toBe(true);
});
