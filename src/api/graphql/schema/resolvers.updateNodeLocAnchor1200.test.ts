/**
 * #1200 (Holger's ruling A, 2026-10-24): `updateNode(memoryId:, loc:)` means
 * "the node I found there". The loc path anchors the write on the PROBED node's
 * id, exactly as the id path does, so when the probed node moves away and a
 * replacement takes its address between the probe and the write the write is
 * refused with NODE_WRITE_CONFLICT. Before, it landed on the replacement and
 * recorded a NodeRevision built from the original: a false history (cor:dmo:060:04
 * requires a revision to describe the node actually written).
 *
 * The interleaving is driven at the lock seam, as in resolvers.updateNodeToctou1198:
 * `lockLocForWrite` runs after the outer history fence. The hook simulates
 * uncooperative storage drift after the probe; another participating writer
 * cannot enter a nested transaction or pass the held history fence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

/**
 * The interleaving hook for case 2. Pass-through unless a test arms it, so
 * every other test in this file runs against the real lock helper.
 */
const onLock = { fire: null as null | (() => Promise<void>) };
vi.mock('../../../lib/nodeSubtreeLock.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    lockLocForWrite: async (...args: unknown[]) => {
      const r = await (real.lockLocForWrite as (...a: unknown[]) => Promise<unknown>)(...args);
      if (onLock.fire) {
        const fire = onLock.fire;
        onLock.fire = null;
        await fire();
      }
      return r;
    },
  };
});

let orgId: string;
let memoryId: string;
let adminId: string;

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });

async function seed(loc: string, name = 'before') {
  return resolvers.Mutation.createNode({}, { input: { memoryId, loc, name } as never }, ctx());
}

async function expectCode(p: Promise<unknown>, code: string): Promise<GraphQLError> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(GraphQLError);
  expect((caught as GraphQLError).extensions?.code).toBe(code);
  return caught as GraphQLError;
}

/** The update under test, reached at the core so both selector shapes are drivable. */
async function update(input: Record<string, unknown>, targetNodeId?: string) {
  const { writeNodeCore } = await import('./resolvers.mutation.node.js');
  return writeNodeCore(input as never, ctx(), 'update', targetNodeId ? { targetNodeId } : undefined);
}

beforeEach(async () => {
  await cleanDb(db);
  onLock.fire = null;
  const org = await db.organization.create({
    data: { id: generateId(), name: 'anchor-org', urn: 'anchor-org.test' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 12000, githubUsername: 'anchor-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  memoryId = (await resolvers.Mutation.createMemory({}, { orgId, name: 'anchormem' }, ctx())).id;
});


/** Move the probed node away and let a replacement take its address, at the lock. */
const replaceAtLock = (originalId: string, loc: string) => {
  const out = { replacementId: '' };
  onLock.fire = async () => {
    await db.node.update({ where: { id: originalId }, data: { loc: `${loc}:moved` } });
    // Like the direct move above, this is fixture-only storage drift. Calling
    // createNode here would nest a prepared history transaction, which refuses.
    const replacement = await db.node.create({
      data: { id: generateId(), memoryId, loc, name: 'replacement', nodeType: 'info' },
    });
    out.replacementId = replacement.id;
  };
  return out;
};

describe('#1200 the loc path anchors on the probed node (ruling A)', () => {
  it('REFUSES a write when a replacement takes the address, and writes nothing to either node', async () => {
    const original = await seed('doc:a', 'original');
    const originalRevisions = await db.nodeRevision.count({ where: { nodeId: original.id } });
    const replaced = replaceAtLock(original.id, 'doc:a');

    await expectCode(update({ memoryId, loc: 'doc:a', name: 'EDIT' }), 'NODE_WRITE_CONFLICT');

    const replacement = await db.node.findUniqueOrThrow({ where: { id: replaced.replacementId } });
    expect(replacement.name).toBe('replacement');
    const moved = await db.node.findUniqueOrThrow({ where: { id: original.id } });
    expect(moved.name).toBe('original');
    // The refused write recorded no revision for either node (the false history).
    expect(await db.nodeRevision.count({ where: { nodeId: original.id } })).toBe(originalRevisions);
    expect(await db.nodeRevision.count({ where: { nodeId: replaced.replacementId } })).toBe(0);
  });

  it('the id path is unchanged: same replacement window, same refusal', async () => {
    const original = await seed('doc:b', 'original');
    const replaced = replaceAtLock(original.id, 'doc:b');

    await expectCode(update({ memoryId, loc: 'doc:b', name: 'EDIT' }, original.id), 'NODE_WRITE_CONFLICT');

    expect((await db.node.findUniqueOrThrow({ where: { id: replaced.replacementId } })).name).toBe('replacement');
  });

  it('control: with no replacement the loc-path write still lands and snapshots the written node', async () => {
    const node = await seed('doc:c', 'original');
    await update({ memoryId, loc: 'doc:c', name: 'EDITED' });
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('EDITED');
  });

  it('control: a soft-delete in the window is still NODE_NOT_FOUND on the loc path', async () => {
    const node = await seed('doc:d', 'original');
    onLock.fire = async () => {
      await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date(), deletedBy: adminId } });
    };
    await expectCode(update({ memoryId, loc: 'doc:d', name: 'EDIT' }), 'NODE_NOT_FOUND');
  });
});
