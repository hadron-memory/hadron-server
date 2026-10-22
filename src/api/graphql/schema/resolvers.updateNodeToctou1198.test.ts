/**
 * THREE time-of-check/time-of-use gaps on the single-node UPDATE path, all
 * found by review on PR #1198 and all PRE-EXISTING — the first two since
 * PR-460, the third for as long as `updateNodeData` has existed. The first two
 * are closed by a re-read under the address lock (`assertTargetStillWritable`)
 * PLUS the address/liveness terms now carried in the write's own predicate; the
 * third by anchoring an id-resolving caller on the PK.
 *
 * (This header said "two" while the file held three sections — the same stale
 * prose these tests exist to catch, so it is worth noting that it was.)
 *
 * The shared shape: `writeNodeCore`'s mode gate probes the target OUTSIDE any
 * transaction, everything that protects the write is decided from that probe,
 * and the UPDATE then runs inside a transaction whose `where` clause re-derived
 * nothing. Anything that commits in the gap was invisible to the decision and
 * still landed.
 *
 * WHICH HALF DOES WHAT, measured by neutralizing the re-check: the write's
 * PREDICATE is the correctness half — with the re-check disabled all four race
 * cases are still refused — and the RE-CHECK is the accurate-diagnostics half,
 * turning a bare NODE_NOT_FOUND into a NODE_WRITE_CONFLICT that says the target
 * moved. A check and the statement after it are not atomic against a relocator
 * that takes no lock (`mergeMemoryGraph` moves rows with a bulk updateMany),
 * which is why correctness cannot live in the check alone.
 *
 *   1. THE TARGET MOVED (@codex, P1) — id-selector path. `updateNode` resolves
 *      `id` → (memoryId, loc) before the transaction, and memory write access,
 *      the protected-loc gate and the memory's property schema are all checked
 *      against THAT address while the UPDATE keys on the immutable PK. A
 *      `moveNode` in between means the write is authorized against one memory
 *      and applied in another.
 *
 *   2. THE TARGET WAS SOFT-DELETED (@copilot) — BOTH selector paths, which is
 *      wider than the finding framed it. `tx.node.update` carries no
 *      `deletedAt` clause, so an edit is written straight through a tombstone.
 *      The mode gate's own comment claimed this was already covered via Prisma
 *      P2025 → NODE_NOT_FOUND; that holds for a HARD delete, and this repo
 *      soft-deletes, so P2025 never fires. That comment is corrected in place.
 *
 * WHY THESE ARE DRIVEN AT SEAMS RATHER THAN BY RACING TWO RESOLVERS. Both are
 * real races, and a timing-window test for either would be slow and flaky while
 * proving less. Each is pinned at the exact instant that matters instead:
 *
 *   - case 1 by constructing the POST-MOVE state, which is precisely what the
 *     race produces, and calling `writeNodeCore` with the address the caller
 *     had already resolved;
 *   - case 2 by hooking `lockLocForWrite` — the first statement inside the
 *     write transaction, and therefore the instant AFTER the probe saw a live
 *     row — and committing the delete from there. That IS the interleaving,
 *     deterministically.
 *
 * Each case asserts the refusal AND that the write did not land; a refusal that
 * still mutated the row would satisfy the first half alone.
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
    data: { id: generateId(), name: 'toctou-org', urn: 'toctou-org.test' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 11980, githubUsername: 'toctou-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  memoryId = (await resolvers.Mutation.createMemory({}, { orgId, name: 'toctoumem' }, ctx())).id;
});

describe('update TOCTOU 1: the target moved after it was read (@codex P1)', () => {
  it('REFUSES a write whose target moved to another memory', async () => {
    const dest = await resolvers.Mutation.createMemory({}, { orgId, name: 'toctou-dest' }, ctx());
    const node = await seed('doc:one');

    // The concurrent move, already committed — the state the race produces.
    await db.node.update({
      where: { id: node.id },
      data: { memoryId: dest.id, loc: 'moved:here' },
    });

    const err = await expectCode(
      update({ memoryId, loc: 'doc:one', name: 'AFTER-MOVE' }, node.id),
      'NODE_WRITE_CONFLICT',
    );
    // REDACTED across a memory boundary (@copilot round 4): the caller is told
    // the node moved, never WHERE — a loc in a memory they may not read, learned
    // through a write they were refused, is a disclosure and not a courtesy.
    expect(err.extensions?.movedMemory).toBe(true);
    expect(err.extensions?.currentLoc).toBeUndefined();
    expect(err.message).not.toContain('moved:here');
    expect(err.message).toContain('no longer in memory');

    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.name).toBe('before');
    expect(after.memoryId).toBe(dest.id);
  });

  it('REFUSES a same-memory rename too — loc is half the address', async () => {
    // A re-check comparing only the memory would pass here and write to
    // whatever now sits at the resolved address.
    const node = await seed('doc:two');
    await db.node.update({ where: { id: node.id }, data: { loc: 'doc:elsewhere' } });

    const err = await expectCode(
      update({ memoryId, loc: 'doc:two', name: 'AFTER-MOVE' }, node.id),
      'NODE_WRITE_CONFLICT',
    );

    // @copilot, PR #1198: the first version of this message said "in another
    // memory" unconditionally — a claim this very case disproves, in the file
    // that proves it. The wording is conditional now, and pinned in both
    // directions so it cannot regress to a constant string that happens to
    // satisfy the case above.
    // Within ONE memory the caller was already authorized against it, so the
    // new loc is reported — the redaction is a boundary rule, not a blanket one.
    expect(err.extensions?.movedMemory).toBe(false);
    expect(err.extensions?.currentLoc).toBe('doc:elsewhere');
    expect(err.message).not.toContain('no longer in memory');
    expect(err.message).toContain('doc:elsewhere');

    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('before');
  });

  it('still writes when the target has NOT moved — the refusal is not blanket', async () => {
    // The opposite failure: a re-check that refused everything would satisfy
    // both cases above and break every update in the product.
    const node = await seed('doc:three');
    await update({ memoryId, loc: 'doc:three', name: 'after' }, node.id);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('after');
  });
});

describe('update TOCTOU 2: the target was soft-deleted mid-write (@copilot)', () => {
  // Armed at the lock, i.e. after the unlocked mode gate has already seen a
  // LIVE row — the interleaving the gate's comment wrongly claimed was covered.
  const deleteAtLock = (id: string) => {
    onLock.fire = async () => {
      await db.node.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: adminId },
      });
    };
  };

  it('REFUSES on the id-selector path, and the tombstone keeps its content', async () => {
    const node = await seed('doc:pk');
    deleteAtLock(node.id);

    await expectCode(
      update({ memoryId, loc: 'doc:pk', name: 'AFTER-DELETE' }, node.id),
      'NODE_NOT_FOUND',
    );

    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.name).toBe('before');
    expect(after.deletedAt).not.toBeNull();
  });

  it('REFUSES on the loc-selector path too — the finding was wider than it was filed', async () => {
    // @copilot scoped this to the id path ("select deletedAt ... under the
    // lock"). Measured, the loc path wrote through the tombstone identically:
    // `tx.node.update` keys on (loc, memoryId) with no deletedAt clause either.
    // Fixing only the reported half would have left the generic surface —
    // `updateNode(memoryId:, loc:)`, which is what most callers use — exposed.
    const node = await seed('doc:loc');
    deleteAtLock(node.id);

    await expectCode(update({ memoryId, loc: 'doc:loc', name: 'AFTER-DELETE' }), 'NODE_NOT_FOUND');

    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.name).toBe('before');
    expect(after.deletedAt).not.toBeNull();
  });

  it('refuses with the SAME shape the unlocked mode gate uses', async () => {
    // From the caller's side "it was deleted" is one outcome, not two — the
    // race losing and the plain already-deleted case must be indistinguishable,
    // or a client learns to branch on a timing artifact.
    const raced = await seed('doc:raced');
    deleteAtLock(raced.id);
    const fromRace = await expectCode(
      update({ memoryId, loc: 'doc:raced', name: 'x' }, raced.id),
      'NODE_NOT_FOUND',
    );

    const plain = await seed('doc:plain');
    await db.node.update({ where: { id: plain.id }, data: { deletedAt: new Date() } });
    const fromGate = await expectCode(
      update({ memoryId, loc: 'doc:plain', name: 'x' }, plain.id),
      'NODE_NOT_FOUND',
    );

    expect(fromRace.message.replace('doc:raced', 'LOC')).toBe(
      fromGate.message.replace('doc:plain', 'LOC'),
    );
  });
});

describe('update TOCTOU 3: identity is anchored on the PK, not the address (@copilot)', () => {
  it('updateNodeData REFUSES rather than patching whatever took its address mid-write', async () => {
    // updateNodeData resolves a node REF, reads that node's CURRENT loc, and
    // then addressed the write by (memoryId, loc) with no identity anchor. The
    // window is between that read and the write, so the move and the squat have
    // to land INSIDE it — which is what the lock hook does.
    //
    // My first version of this test moved the node BEFORE calling the resolver.
    // That passes with or without the fix, because the resolver simply reads
    // the post-move loc: a careful measurement of the wrong thing, and the
    // mutation is what said so — removing the anchor left it green.
    //
    // The outcome is a REFUSAL, not a redirected patch. Anchoring on the PK
    // means the write carries both the id and the address it was authorized
    // against, so a target that moved mid-flight no longer matches and the
    // caller is told to re-read. What matters is the third assertion: the
    // innocent occupant of the freed address is not written. Before the anchor
    // it was, silently, with the caller's data.
    const target = await seed('doc:target', 'target');
    let squatterId = '';

    onLock.fire = async () => {
      await db.node.update({ where: { id: target.id }, data: { loc: 'doc:moved' } });
      // Stage the post-move DB state directly: a second real node writer
      // cannot enter a nested history fence inside this lock hook.
      squatterId = (await db.node.create({ data: { memoryId, loc: 'doc:target', name: 'squatter' } })).id;
    };

    await expectCode(
      resolvers.Mutation.updateNodeData(
        {},
        { nodeRef: target.id, data: { marker: 'mine' } },
        ctx(),
      ),
      'NODE_WRITE_CONFLICT',
    );

    // THE assertion: the node that merely happened to occupy the old address is
    // untouched. Without the PK anchor this row carries `{marker:'mine'}`.
    expect((await db.node.findUniqueOrThrow({ where: { id: squatterId } })).data).toBeNull();
    // And the named node is unchanged too — a refusal that still wrote would
    // satisfy the line above while being just as wrong.
    expect((await db.node.findUniqueOrThrow({ where: { id: target.id } })).data).toBeNull();
  });
});

// The remedy-wording suite that lived here tested the DECLARED arm of
// LocProtectedError — `Memory.protectedLocs`, which #1201 removed. Its Channel
// equivalents moved to resolvers.governedRole1201.test.ts rather than being
// dropped: the op-aware remedy is still live for the Channel source, and the
// lesson that produced it (a fixture cannot see which verb a caller hands the
// gate) is recorded there.

describe('classifyFailedUpdate — the zero-row discriminator (@copilot, round 5)', () => {
  // The RACE that reaches this in writeNodeCore is not deterministically
  // testable (it needs a relocation between two adjacent statements inside one
  // transaction, with no seam to hook). The DECISION is, and it is the half
  // that could be silently wrong — so it is extracted and pinned here rather
  // than left as a defensive branch nothing exercises.
  it('a live row at a different address is MOVED', async () => {
    const node = await seed('doc:classify-a');
    await db.node.update({ where: { id: node.id }, data: { loc: 'doc:moved-away' } });

    const { classifyFailedUpdate } = await import('./resolvers.mutation.node.js');
    expect(await classifyFailedUpdate(db, node.id)).toEqual({
      kind: 'moved',
      memoryId,
      loc: 'doc:moved-away',
    });
  });

  it('a soft-deleted row is DELETED', async () => {
    const node = await seed('doc:classify-b');
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });

    const { classifyFailedUpdate } = await import('./resolvers.mutation.node.js');
    expect(await classifyFailedUpdate(db, node.id)).toEqual({ kind: 'deleted' });
  });

  it('a row that is BOTH deleted and moved reports DELETED', async () => {
    // Order matters and is a real choice: the caller cannot act on a
    // tombstone's new address, and "it was deleted" is the outcome they need.
    // Without this case the two branches could be swapped undetectably.
    const node = await seed('doc:classify-c');
    await db.node.update({
      where: { id: node.id },
      data: { loc: 'doc:gone-elsewhere', deletedAt: new Date() },
    });

    const { classifyFailedUpdate } = await import('./resolvers.mutation.node.js');
    expect(await classifyFailedUpdate(db, node.id)).toEqual({ kind: 'deleted' });
  });

  it('no row at all is GONE', async () => {
    const node = await seed('doc:classify-d');
    await db.node.delete({ where: { id: node.id } });

    const { classifyFailedUpdate } = await import('./resolvers.mutation.node.js');
    expect(await classifyFailedUpdate(db, node.id)).toEqual({ kind: 'gone' });
  });
});
