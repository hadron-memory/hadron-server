/**
 * Issue #1183 — `createNode`'s create-only gate must survive concurrency.
 *
 * Spec 039 Phase 0 D1 says a live node at (loc, memoryId) rejects with
 * NodeLocConflictError. Until this fix that held only SEQUENTIALLY, which is
 * why every existing test passed: `resolvers.createUpdateNode.test.ts:109`
 * pins the refusal with a sequential pair, and the defect is invisible to it.
 *
 * Three separate things were wrong in `writeNodeCore`, all in the shared path
 * used by the GraphQL API, the runner's hadron_create_node tool, and the
 * importer:
 *
 *   1. the mode gate read `existing` BEFORE the transaction, so two callers
 *      both saw no row and both passed it;
 *   2. the create path took only `lockAncestorsForCreate` — no loc lock — and
 *      wrote with `tx.node.upsert`, so the loser did not collide on the
 *      (loc, memory_id) unique, it took the upsert's UPDATE branch and
 *      overwrote the winner's live row;
 *   3. the revision snapshot ran on `ctx.db` (not the transaction) from that
 *      same stale `existing`, so a raced overwrite was recorded NOWHERE — and
 *      a failed write could leave an orphan revision behind.
 *
 * Measured before the fix: 40 concurrent pairs, 40 double-successes, ZERO
 * refusals. The overwrite was the norm under overlap, not a narrow window.
 *
 * This is the same trio #976/#977 fixed for the MCP surface, never applied
 * here; #1182 then matched MCP's gate to this path's DOCUMENTED contract while
 * that contract was itself unenforced under load.
 *
 * These tests are deterministic AFTER the fix, not races hoping to catch
 * something: the loc write lock serializes the two calls, so the second always
 * observes the first's committed row. Before the fix they fail every run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { lockLocForWrite } from '../../../lib/nodeSubtreeLock.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let memoryId: string;
let adminId: string;

function gqlCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
}

/** Fire createNode, flattening success/refusal into a comparable token. */
async function create(loc: string, content: string): Promise<string> {
  try {
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId, loc, name: 'N', content } as never },
      gqlCtx(),
    );
    return 'OK';
  } catch (e) {
    const code = (e as { extensions?: { code?: string } }).extensions?.code;
    return `ERR:${code ?? 'unknown'}`;
  }
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'race-1183-org', urn: 'race-1183-org' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { githubId: 11830, githubUsername: 'race-1183-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });

  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId, name: 'racemem' },
    gqlCtx(),
  );
  memoryId = memory.id;
});

describe('createNode is create-only under concurrency (#1183)', () => {
  it('two concurrent creates at one free loc: exactly one wins, the other is refused', async () => {
    const results = await Promise.all([
      create('cor:api:010:01', 'from A'),
      create('cor:api:010:01', 'from B'),
    ]);

    // Before the fix this was ["OK","OK"] on every run.
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'ERR:NodeLocConflictError')).toHaveLength(1);

    const rows = await db.node.findMany({
      where: { memoryId, loc: 'cor:api:010:01' },
    });
    expect(rows).toHaveLength(1);
  });

  it('the surviving row belongs to the ONE caller that was told it succeeded', async () => {
    // The assertion that makes this about IDENTITY rather than counting: one
    // row could survive while holding the LOSER's content, which is exactly
    // the pre-fix behaviour — the second call's upsert update branch replaced
    // the first's row while both callers were told "OK".
    //
    // The single-winner assertion has to be IN this test rather than borrowed
    // from the one above: with two successes "the winner" is ambiguous, and an
    // earlier draft of this test picked results.indexOf('OK') — which passed
    // pre-fix whenever A happened to commit last. It was green for the wrong
    // reason on a defect it was written to catch.
    const contents = ['from A', 'from B'];
    const results = await Promise.all(contents.map((c) => create('cor:api:010:02', c)));

    const winners = results.filter((r) => r === 'OK');
    expect(winners).toHaveLength(1);

    const winnerContent = contents[results.indexOf('OK')];
    const [row] = await db.node.findMany({ where: { memoryId, loc: 'cor:api:010:02' } });
    expect(row.content).toBe(winnerContent);
  });

  it('no revision is cut, because nothing was ever overwritten', async () => {
    // Pre-fix, the raced overwrite produced no revision EITHER — but for the
    // opposite reason: the snapshot was driven by the stale pre-transaction
    // read, which saw no row. So "zero revisions" alone cannot tell the two
    // worlds apart; it is only meaningful next to the content assertion above
    // and the refusal assertion in the first test.
    await Promise.all([
      create('cor:api:010:03', 'from A'),
      create('cor:api:010:03', 'from B'),
    ]);

    const [row] = await db.node.findMany({ where: { memoryId, loc: 'cor:api:010:03' } });
    expect(row.revSeq).toBe(0);
    expect(await db.nodeRevision.count({ where: { nodeId: row.id } })).toBe(0);
  });

  it('holds at a NESTED loc too, where the ancestor lock is also taken', async () => {
    // A nested loc takes lockAncestorsForCreate as well as the loc lock, in
    // root→leaf order. Pinned separately because the pre-fix path took ONLY
    // the ancestor lock — so this is the case where a reader might assume the
    // existing locking already covered it.
    await create('cor', 'root');
    await create('cor:api', 'branch');

    const results = await Promise.all([
      create('cor:api:020:01', 'from A'),
      create('cor:api:020:01', 'from B'),
    ]);

    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'ERR:NodeLocConflictError')).toHaveLength(1);
  });

  it('a sequential create at a taken loc still refuses (the pre-existing contract)', async () => {
    // Guards the opposite failure: a fix that refused EVERYTHING, or that broke
    // the ordinary path, would satisfy every assertion above.
    expect(await create('cor:api:030:01', 'first')).toBe('OK');
    expect(await create('cor:api:030:01', 'second')).toBe('ERR:NodeLocConflictError');

    const [row] = await db.node.findMany({ where: { memoryId, loc: 'cor:api:030:01' } });
    expect(row.content).toBe('first');
  });

  it('holds at a ROOT-LEVEL loc, which has NO ancestor lock to hide behind', async () => {
    // This is the case that actually pins `lockLocForWrite`, and it exists
    // because a mutation exposed that the others do not.
    //
    // Removing the loc lock left every other test in this file green, which
    // looked like the lock was redundant. It is not — `lockAncestorsForCreate`
    // takes advisory locks on the ancestor path, so any NESTED loc already
    // serializes on its ancestors, and the in-transaction re-read alone is
    // enough to refuse. A ROOT-LEVEL loc has no ancestor, so that helper takes
    // nothing and the loc lock is the ONLY thing serializing two creates.
    //
    // Without it, the two transactions both re-read an empty slot and both
    // reach the upsert, where Prisma's upsert is not race-safe
    // (findings:prisma-upsert-not-race-safe) — so the loser surfaces a raw
    // P2002 rather than the typed NodeLocConflictError this contract promises,
    // and the outer catch only maps P2025.
    const results = await Promise.all([create('rootloc', 'from A'), create('rootloc', 'from B')]);

    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'ERR:NodeLocConflictError')).toHaveLength(1);

    const rows = await db.node.findMany({ where: { memoryId, loc: 'rootloc' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(results[0] === 'OK' ? 'from A' : 'from B');
  });

  it('still RESURRECTS a soft-deleted loc, and snapshots the tombstone first', async () => {
    // Added because a mutation found this UNCOVERED, not because the fix
    // needed it. Dropping `!authoritative.deletedAt` from the new gate — so a
    // tombstone is refused like a live row — broke nothing: spec 039 D1 says
    // "a soft-deleted one is resurrected", `resolvers.createUpdateNode.test.ts`
    // says so in its own docblock, and no test anywhere asserted it on this
    // path. A documented contract with no coverage, on the exact branch this
    // change rewrites.
    //
    // The revision half is the other thing a mutation found unguarded: the
    // create/upsert snapshot moved INSIDE the transaction and onto the
    // authoritative row, and nothing failed when it was disabled.
    const ghost = await db.node.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'cor:api:050:01',
        name: 'Ghost',
        nodeType: 'info',
        tags: [],
        content: 'tombstoned content',
        deletedAt: new Date(),
        deletedBy: adminId,
      },
    });

    expect(await create('cor:api:050:01', 'reborn content')).toBe('OK');

    const row = await db.node.findUnique({ where: { id: ghost.id } });
    expect(row?.deletedAt).toBeNull();
    expect(row?.deletedBy).toBeNull();
    expect(row?.content).toBe('reborn content');
    // Same row — the id is stable across a resurrect (it is the same address).
    expect(row?.id).toBe(ghost.id);

    // The tombstone's content was real content; losing it silently was #976.
    const revisions = await db.nodeRevision.findMany({ where: { nodeId: ghost.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].content).toBe('tombstoned content');
  });

  it('resurrects a tombstone that appeared AFTER the pre-transaction probe', async () => {
    // @copilot on PR #1184. The gate lets a tombstone through by design, but
    // `updateExtras` (which clears deletedAt/deletedBy) was built from the
    // STALE probe. If that probe saw nothing while another caller created and
    // soft-deleted the loc before we took the lock, the upsert would write the
    // new fields and leave the row flagged deleted — the "worst of both
    // worlds" #543 exists to prevent, reachable again through the very window
    // this transaction was added to close.
    //
    // Forced, not hoped for: a holder transaction takes the loc's advisory
    // lock FIRST, so the createNode below runs its probe (seeing nothing) and
    // then blocks at the lock. The tombstone is inserted while it waits, and
    // released; createNode then proceeds with authoritative = tombstone and
    // existing = null, which is exactly the window.
    const loc = 'cor:api:060:01';

    let signalHeld!: () => void;
    const lockIsHeld = new Promise<void>((r) => {
      signalHeld = r;
    });
    let signalRelease!: () => void;
    const mayRelease = new Promise<void>((r) => {
      signalRelease = r;
    });

    const holder = db.$transaction(
      async (tx) => {
        await lockLocForWrite(tx, memoryId, loc);
        signalHeld();
        await mayRelease;
        // Inserted INSIDE the holder, so the tombstone commits as the lock drops.
        await tx.node.create({
          data: {
            id: generateId(),
            memoryId,
            loc,
            name: 'Ghost',
            nodeType: 'info',
            tags: [],
            content: 'tombstoned content',
            deletedAt: new Date(),
            deletedBy: adminId,
          },
        });
      },
      { timeout: 20_000 },
    );

    await lockIsHeld;
    // createNode runs its probe (sees nothing) and then blocks at the lock.
    const creating = create(loc, 'reborn content');
    await new Promise((r) => setTimeout(r, 200));
    signalRelease();
    await holder;

    expect(await creating).toBe('OK');

    const row = await db.node.findFirst({ where: { memoryId, loc } });
    // The whole point: NOT still flagged deleted.
    expect(row?.deletedAt).toBeNull();
    expect(row?.deletedBy).toBeNull();
    expect(row?.content).toBe('reborn content');
  });

  it('a genuinely free loc still creates, concurrently with an unrelated one', async () => {
    // Two DIFFERENT locs must not serialize into a refusal — the loc lock is
    // per-loc, and a gate keyed too broadly would refuse one of these.
    const results = await Promise.all([
      create('cor:api:040:01', 'A'),
      create('cor:api:040:02', 'B'),
    ]);

    expect(results).toEqual(['OK', 'OK']);
    expect(await db.node.count({ where: { memoryId, loc: { startsWith: 'cor:api:040:' } } })).toBe(2);
  });
});
