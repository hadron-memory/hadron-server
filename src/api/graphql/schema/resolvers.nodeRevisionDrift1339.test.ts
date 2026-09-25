/**
 * #1323 / PR #1339 review (@codex P1): an update that finds UNRECONCILED drift
 * (a raw writer changed tracked state without advancing revSeq) must
 * reconcile it as its OWN revision before the caller's guard and edit apply.
 *
 * Folding the drift into the edit's revision had two effects: a caller
 * guarding on the pre-drift revision N succeeded although the node changed
 * under it (an optimistic-concurrency bypass), and the drift transition and
 * the edit shared one revision, after which the refreshed fingerprint hid the
 * missed transition for good.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { type Context } from './resolvers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { resolvers } from './resolvers.js';
import { createNode as controllerCreateNode } from '../../../controller/operations/createNode.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let memoryId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'dr-org', urn: 'dr-org' } });
  admin = await db.user.create({ data: { githubId: 13390, githubUsername: 'dr-admin', handle: 'dr-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  })).id;
});

/** A node at live revision 1, then changed by a raw writer that never advances revSeq. */
async function driftedNode(loc: string) {
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: 'original' } });
  expect(node.revSeq).toBe(1);
  await db.node.update({ where: { id: node.id }, data: { content: 'changed by a raw writer' } });
  return node;
}

describe('#1339 review — drift is reconciled before the guard and the edit', () => {
  it('a write guarded on the pre-drift revision is REFUSED, and writes nothing', async () => {
    const node = await driftedNode('drift:guarded');
    const attempt = writeNodeCore({ memoryId, loc: node.loc, content: 'blind overwrite' }, ctx(), 'update', {
      guardRevSeq: 1,
    });
    await expect(attempt).rejects.toSatisfy(
      (e: unknown) => e instanceof GraphQLError && e.extensions.code === 'NODE_WRITE_CONFLICT',
    );
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.content).toBe('changed by a raw writer');
    // The refusal rolls back EVERYTHING, the drift reconcile included: a refused
    // write consumes no revision and leaves no history (@copilot, PR #1339).
    expect(after.revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it('an unguarded edit over drift yields TWO revisions: the reconcile, then the edit', async () => {
    const node = await driftedNode('drift:plain');
    const updated = await writeNodeCore({ memoryId, loc: node.loc, content: 'the edit' }, ctx(), 'update');
    expect(updated.revSeq).toBe(3);
    const history = await db.nodeRevision.findMany({ where: { nodeId: node.id }, orderBy: { revNo: 'asc' } });
    expect(history.map((r) => r.revNo)).toEqual([1, 2]);
    // r1: the server's own reconcile of the drifted state; r2: the editor's predecessor.
    expect(history[0]!.revLabel).toMatch(/Reconciled state changed outside a revisioned writer/);
    expect(history[0]!.editedBy).toBeNull();
    expect(history[1]!.editedBy).toBe(admin.id);
    expect(history[1]!.content).toBe('changed by a raw writer');
  });

  it('control: a guarded write at the current revision with no drift still succeeds', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:none', name: 'n', content: 'x' } });
    const updated = await writeNodeCore({ memoryId, loc: node.loc, content: 'y' }, ctx(), 'update', { guardRevSeq: 1 });
    expect(updated.revSeq).toBe(2);
  });
});

// Round 3 (@codex P1 / @copilot, PR #1339): the SAME rule on every other
// writer that snapshots a predecessor — reconcile drift first, never fold it.
describe('#1339 review — drift is reconciled first on upsert, controller create and restore', () => {
  const reconcileThenOwn = async (nodeId: string, ownLabel?: RegExp) => {
    const history = await db.nodeRevision.findMany({ where: { nodeId }, orderBy: { revNo: 'asc' } });
    expect(history.map((r) => r.revNo)).toEqual([1, 2]);
    expect(history[0]!.revLabel).toMatch(/Reconciled state changed outside a revisioned writer/);
    if (ownLabel) expect(history[1]!.revLabel ?? '').toMatch(ownLabel);
    expect(history[1]!.content).toBe('changed by a raw writer');
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).revSeq).toBe(3);
  };

  it('writeNodeCore upsert over an existing drifted row', async () => {
    const node = await driftedNode('drift:upsert');
    await writeNodeCore({ memoryId, loc: node.loc, name: node.name, content: 'upserted' }, ctx(), 'upsert');
    await reconcileThenOwn(node.id);
  });

  it('the legacy controller createNode over an existing drifted row', async () => {
    const node = await driftedNode('drift:controller');
    await controllerCreateNode({ memoryId, loc: node.loc, name: node.name, content: 'controller' });
    await reconcileThenOwn(node.id);
  });

  it('restoreNodeRevision over a drifted row', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:restore', name: 'r', content: 'v1' } });
    await writeNodeCore({ memoryId, loc: node.loc, content: 'v2' }, ctx(), 'update'); // r1 = v1, live 2
    const r1 = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: node.id, revNo: 1 } });
    await db.node.update({ where: { id: node.id }, data: { content: 'changed by a raw writer' } });
    await resolvers.Mutation.restoreNodeRevision({}, { revisionId: r1.id } as never, ctx());
    const history = await db.nodeRevision.findMany({ where: { nodeId: node.id }, orderBy: { revNo: 'asc' } });
    // r1 (v1), r2 = the reconcile of the raw write, r3 = restore's own pre-restore snapshot.
    expect(history.map((r) => r.revNo)).toEqual([1, 2, 3]);
    expect(history[1]!.revLabel).toMatch(/Reconciled state changed outside a revisioned writer/);
    expect(history[2]!.content).toBe('changed by a raw writer');
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.content).toBe('v1');
    expect(after.revSeq).toBe(4);
  });
});

// Round 4 (@codex P1 / @copilot, PR #1339): the multi-row writers reconcile
// every row they snapshot, under its row lock and in id order.
describe('#1339 review — multi-row writers reconcile drift before their snapshots', () => {
  const labels = async (nodeId: string) =>
    (await db.nodeRevision.findMany({ where: { nodeId }, orderBy: { revNo: 'asc' } })).map((r) => r.revLabel ?? '');
  const RECONCILE = /Reconciled state changed outside a revisioned writer/;

  it('searchReplaceInNodes over a drifted row', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:replace', name: 'n', content: 'hello world' } });
    await db.node.update({ where: { id: node.id }, data: { description: 'drifted' } });
    await resolvers.Mutation.searchReplaceInNodes({}, {
      input: { oldText: 'hello', newText: 'bye', nodeIds: [node.id], fields: ['content'] },
    } as never, ctx());
    const got = await labels(node.id);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(RECONCILE);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(3);
  });

  it('moveNode over a drifted row', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:move-me', name: 'n', content: 'x' } });
    await db.node.update({ where: { id: node.id }, data: { description: 'drifted' } });
    await resolvers.Mutation.moveNode({}, { sourceRef: node.id, targetUrn: 'hrn:node:dr-org:mem:drift:moved' } as never, ctx());
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.loc).toBe('drift:moved');
    const got = await labels(node.id);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(RECONCILE);
    expect(after.revSeq).toBe(3);
  });

  it('mergeNodes over a drifted target', async () => {
    const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:src', name: 's', content: 'from source' } });
    const target = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:tgt', name: 't', content: 'target' } });
    await db.node.update({ where: { id: target.id }, data: { description: 'drifted' } });
    await resolvers.Mutation.mergeNodes({}, {
      input: { source: source.id, target: target.id, include: ['CONTENT'] },
    } as never, ctx());
    const got = await labels(target.id);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(RECONCILE);
    expect((await db.node.findUniqueOrThrow({ where: { id: target.id } })).revSeq).toBe(3);
  });

  it('mergeMemories relocating a drifted row', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'dr-org' } });
    const dest = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'dr-org:dest', name: 'dest', class: 'knowledge' },
    });
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:relocate', name: 'n', content: 'x' } });
    await db.node.update({ where: { id: node.id }, data: { description: 'drifted' } });
    await resolvers.Mutation.mergeMemories({}, { input: { source: memoryId, target: dest.id } } as never, ctx());
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.memoryId).toBe(dest.id);
    const got = await labels(node.id);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(RECONCILE);
    expect(after.revSeq).toBe(3);
  });
});

// Round 5 (PR #1339 review).
describe('#1339 review round 5', () => {
  it('Node.revision never reconciles a row that left the parent memory (@codex P1)', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'dr-org' } });
    const other = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'dr-org:other-tenant', name: 'other', class: 'knowledge' },
    });
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:leaver', name: 'n', content: 'x' } });
    const parent = await db.node.findUniqueOrThrow({ where: { id: node.id } }); // read in memory A
    // An unrevisioned relocation into another memory, with drift, lands before the field resolves.
    await db.node.update({ where: { id: node.id }, data: { memoryId: other.id, content: 'drifted elsewhere' } });
    expect(await resolvers.Node.revision(parent as never, {}, ctx())).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(1);
  });

  it('an identical controller re-save takes no revision (@codex P2)', async () => {
    const first = await controllerCreateNode({ memoryId, loc: 'drift:idempotent', name: 'n', content: 'same' });
    await controllerCreateNode({ memoryId, loc: 'drift:idempotent', name: 'n', content: 'same' });
    expect((await db.node.findUniqueOrThrow({ where: { id: first.id } })).revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId: first.id } })).toBe(0);
  });

  it('searchReplaceInNodes refuses a row deleted after it was planned (@copilot)', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:deleted', name: 'n', content: 'hello' } });
    const original = db.$transaction.bind(db);
    let fired = false;
    vi.spyOn(db, '$transaction').mockImplementation((async (arg: unknown, opts?: unknown) => {
      if (!fired && typeof arg === 'function') {
        fired = true;
        await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
      }
      return (original as any)(arg, opts);
    }) as never);
    try {
      await expect(
        resolvers.Mutation.searchReplaceInNodes({}, {
          input: { oldText: 'hello', newText: 'bye', nodeIds: [node.id], fields: ['content'] },
        } as never, ctx()),
      ).rejects.toSatisfy((e: unknown) => e instanceof GraphQLError && e.extensions.code === 'NODE_WRITE_CONFLICT');
    } finally {
      vi.restoreAllMocks();
    }
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.content).toBe('hello');
    expect(after.deletedAt).not.toBeNull();
  });
});

describe('#1339 review round 6', () => {
  it('Node.revision never hands a stale parent the number of a newer edge-only write (@codex P1)', async () => {
    const anchor = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:anchor', name: 'a' } });
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:edgy', name: 'n', content: 'x' } });
    const parent = await db.node.findUniqueOrThrow({ where: { id: node.id } }); // revision 1, no edges
    await writeNodeCore(
      { memoryId, loc: node.loc, edges: [{ targetId: anchor.id, name: 'links-to' }] } as never,
      ctx(),
      'update',
    );
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(2);
    // The parent's fields still match (edges are not tracked fields), but its
    // edges are stale: its own number is the only self-consistent answer.
    expect(await resolvers.Node.revision(parent as never, {}, ctx())).toBe(1);
  });
});

describe('#1339 review round 7', () => {
  it('a no-op write with a STALE guard is refused and consumes nothing (@copilot)', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'drift:stale-guard', name: 'n', content: 'v1' } });
    await writeNodeCore({ memoryId, loc: node.loc, content: 'v2' }, ctx(), 'update'); // live revision 2
    const attempt = writeNodeCore({ memoryId, loc: node.loc, content: 'v2' }, ctx(), 'update', { guardRevSeq: 1 });
    await expect(attempt).rejects.toSatisfy(
      (e: unknown) => e instanceof GraphQLError && e.extensions.code === 'NODE_WRITE_CONFLICT',
    );
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(2);
    // Control: the same no-op at the CURRENT revision still succeeds, unchanged.
    const ok = await writeNodeCore({ memoryId, loc: node.loc, content: 'v2' }, ctx(), 'update', { guardRevSeq: 2 });
    expect(ok.revSeq).toBe(2);
  });
});

