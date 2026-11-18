/** #1186: resulting collection state must be validated after the write lock.
 * The seam commits a concurrent writer after the preliminary probe and before
 * the authoritative read, following the #1198/#1200 race-test precedent.
 * Real PostgreSQL writes, revisions and rollback; no timing-dependent sleeps.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
const hook = vi.hoisted(() => ({ fire: null as null | (() => Promise<void>) }));
vi.mock('../../../lib/nodeSubtreeLock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/nodeSubtreeLock.js')>();
  return {
    ...real,
    lockLocForWrite: async (...args: Parameters<typeof real.lockLocForWrite>) => {
      const result = await real.lockLocForWrite(...args);
      const fire = hook.fire;
      hook.fire = null;
      if (fire) await fire();
      return result;
    },
  };
});

let userId: string;
let memoryId: string;
let memoryUrn: string;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'], clientId: `user:${userId}` });
const schema = { objectTypes: { item: { fields: {
  priority: { type: 'enum', values: ['low', 'high'], required: true },
} } } };

async function seed(loc = 'doc', extra: Record<string, unknown> = {}) {
  return resolvers.Mutation.createNode({}, { input: { memoryId, loc, name: 'before', ...extra } as never }, ctx());
}
async function snapshot(id: string) {
  // #2010: createNode starts a detached embedding enqueue. This test owns
  // schema/lock/write state, not that job's bookkeeping or its update clock.
  // Keep every other node column and the complete revision history checked;
  // leave the real enqueue running and allow its stamp at any point.
  const { updatedAt: _updatedAt, embeddingPendingAt: _embeddingPendingAt, ...node } =
    await db.node.findUniqueOrThrow({ where: { id } });
  return {
    node,
    revisions: await db.nodeRevision.findMany({ where: { nodeId: id }, orderBy: { revNo: 'asc' } }),
  };
}

beforeEach(async () => {
  hook.fire = null;
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'schema1186', urn: 'schema1186.test' } });
  const user = await db.user.create({ data: { id: generateId(), githubId: 11860, githubUsername: 'schema1186', roles: ['ADMIN'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'schema1186' }, ctx());
  memoryId = memory.id;
  memoryUrn = memory.urn;
  await db.memory.update({ where: { id: memoryId }, data: { schema } });
});

for (const surface of ['GraphQL', 'MCP'] as const) {
  describe(`${surface} #1186 locked resulting-state schema`, () => {
    async function write(mode: 'create' | 'update', fields: Record<string, unknown>) {
      if (surface === 'MCP') {
        return createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` })
          .callToolText(mode === 'create' ? 'hadron_create_node' : 'hadron_update_node', {
            urn: emitNodeUrnV2(memoryUrn, 'doc'), ...fields,
          });
      }
      return mode === 'create'
        ? resolvers.Mutation.createNode({}, { input: { memoryId, loc: 'doc', ...fields } as never }, ctx())
        : resolvers.Mutation.updateNode({}, { input: { memoryId, loc: 'doc', ...fields } } as never, ctx());
    }
    async function refused(action: Promise<unknown>) {
      if (surface === 'MCP') expect(await action).toContain('Schema violation');
      else await expect(action).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }

    it.each(['create', 'update'] as const)('%s rejects invalid preserved properties changed after the probe, with no revision/write side effect', async (mode) => {
      // Initially ordinary, so the unlocked precheck has nothing to validate.
      const node = await seed();
      if (mode === 'create') await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
      let concurrentState: Awaited<ReturnType<typeof snapshot>>;
      hook.fire = async () => {
        await db.node.updateMany({ where: { id: node.id }, data: { objectType: 'item', properties: { priority: 'urgent' } } });
        concurrentState = await snapshot(node.id);
      };
      await refused(write(mode, { name: 'must-not-land' }));
      expect(hook.fire).toBeNull();
      expect(await snapshot(node.id)).toEqual(concurrentState!);
    });

    it('create validates a tombstone introduced after an absent probe', async () => {
      let inserted: Awaited<ReturnType<typeof snapshot>>;
      hook.fire = async () => {
        const node = await db.node.create({ data: {
          id: generateId(), memoryId, loc: 'doc', name: 'late-tombstone', nodeType: 'info',
          objectType: 'item', properties: { priority: 'urgent' }, deletedAt: new Date(),
        } });
        inserted = await snapshot(node.id);
      };
      await refused(write('create', { name: 'must-not-land' }));
      expect(await snapshot(inserted!.node.id)).toEqual(inserted!);
    });

    it.each(['create', 'update'] as const)('%s accepts valid state changed after the probe and preserves omitted fields', async (mode) => {
      const node = await seed();
      if (mode === 'create') await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
      hook.fire = async () => {
        await db.node.updateMany({ where: { id: node.id }, data: { objectType: 'item', properties: { priority: 'high' } } });
      };
      const result = await write(mode, { name: 'after' });
      if (surface === 'MCP') expect(result).not.toContain('Schema violation');
      const after = (await snapshot(node.id)).node;
      expect(after).toMatchObject({ name: 'after', objectType: 'item', properties: { priority: 'high' }, deletedAt: null });
    });

    it('update validates current properties when the caller supplies only the collection', async () => {
      const node = await seed('doc', { properties: { priority: 'low' } });
      let concurrentState: Awaited<ReturnType<typeof snapshot>>;
      hook.fire = async () => {
        await db.node.updateMany({ where: { id: node.id }, data: { properties: { priority: 'urgent' } } });
        concurrentState = await snapshot(node.id);
      };
      await refused(write('update', { objectType: 'item' }));
      expect(await snapshot(node.id)).toEqual(concurrentState!);
    });

    it('update allows explicit collection clear instead of preserving an invalid collection', async () => {
      const node = await seed();
      hook.fire = async () => {
        await db.node.updateMany({ where: { id: node.id }, data: { objectType: 'item', properties: { priority: 'urgent' } } });
      };
      // Whitespace clears on both public surfaces; omission above preserves.
      await write('update', { objectType: ' ', name: 'cleared' });
      expect((await snapshot(node.id)).node).toMatchObject({ objectType: null, properties: { priority: 'urgent' }, name: 'cleared' });
    });
  });
}

describe('GraphQL #1186 replacement-at-address (Cedar #1200 test 4)', () => {
  it('refuses a replacement at the address (ruling A, #1200) without reconciling or editing either row', async () => {
    const original = await seed();
    const replacement = await seed('other', { objectType: 'item', properties: { priority: 'low' } });
    let originalState: Awaited<ReturnType<typeof snapshot>>;
    let replacementState: Awaited<ReturnType<typeof snapshot>>;
    hook.fire = async () => {
      await db.node.updateMany({ where: { id: original.id }, data: { loc: 'away' } });
      await db.node.updateMany({ where: { id: replacement.id }, data: { loc: 'doc' } });
      originalState = await snapshot(original.id);
      replacementState = await snapshot(replacement.id);
    };
    await expect(resolvers.Mutation.updateNode({}, { input: {
      memoryId, loc: 'doc', properties: { priority: 'urgent' },
    } } as never, ctx())).rejects.toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
    expect(await snapshot(original.id)).toEqual(originalState!);
    expect(await snapshot(replacement.id)).toEqual(replacementState!);
  });
});
