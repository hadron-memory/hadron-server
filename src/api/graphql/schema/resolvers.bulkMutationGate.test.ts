/**
 * #1191 — `mergeMemories` and `extractParentNodeToMemory` consult the two write
 * gates every per-node surface already consults: the protected-loc gate (a
 * Channel owns its address, spec 049 §2 S4) and the governed-role gate (a spec,
 * review or task node is written through its own door, #1201/#1203).
 *
 * Counted on `main` before this change — calls to `assertLocWritable`, the lock
 * helpers, or `partitionProtected` inside each operation:
 *
 *     mergeMemoryGraph              0
 *     extractParentNodeGraph(move)  0
 *
 * So an authorized merge or extract could relocate, rewrite or delete the nodes
 * under a Channel's address with no `LOC_PROTECTED` refusal — the case that gate
 * exists to prevent, reached through a door nobody checked. The Channel half is
 * a shipped SECURITY boundary rather than a guardrail: chat authorship is
 * derived by the owning operation precisely because it was otherwise forgeable
 * and not tamper-evident.
 *
 * Every refusal here ships with its CONTROL — the same operation on a clean
 * memory or a clean subtree, which must SUCCEED. A gate that refuses everything
 * passes every refusal test ever written.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let srcMem: { id: string; urn: string };
let tgtMem: { id: string; urn: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

const mkNode = (memoryId: string, loc: string, fields: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...fields } });

const merge = (input: Record<string, unknown>) =>
  resolvers.Mutation.mergeMemories({}, { input } as never, ctx());

const extract = (parentRef: string, targetUrn: string, move: boolean) =>
  resolvers.Mutation.extractParentNodeToMemory({}, { parentRef, targetUrn, move } as never, ctx());

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return String((e as { extensions?: { code?: string } }).extensions?.code ?? 'UNKNOWN');
  }
}

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'bg', urn: `bg-${t}` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 66120, githubUsername: `bg-${t}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  srcMem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: `bg-src-${t}` }, ctx());
  tgtMem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: `bg-tgt-${t}` }, ctx());
});

describe('mergeMemories consults both gates (#1191)', () => {
  it('CONTROL: a merge of two clean memories still succeeds', async () => {
    // Without this, every refusal below is satisfied by a gate that refuses
    // unconditionally.
    await mkNode(srcMem.id, 'a');
    await mkNode(tgtMem.id, 'b');
    expect(await codeOf(merge({ source: srcMem.id, target: tgtMem.id }))).toBe('OK');
    const moved = await db.node.findFirst({ where: { memoryId: tgtMem.id, loc: 'a', deletedAt: null } });
    expect(moved).not.toBeNull();
  });

  it('refuses when the SOURCE holds a Channel', async () => {
    // Every source node relocates or folds, so a Channel here would have its
    // root moved out from under `Channel.memoryId`/`loc` — the reservation
    // would point at a memory the root no longer lives in.
    await ensureChannelWithRoot(db, { memoryId: srcMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    expect(await codeOf(merge({ source: srcMem.id, target: tgtMem.id }))).toBe('LOC_PROTECTED');
  });

  it('refuses when the TARGET holds a Channel', async () => {
    // Both endpoints, because a fold OVERWRITES its target counterpart — a
    // gate on the source alone would leave the write half open.
    await ensureChannelWithRoot(db, { memoryId: tgtMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    await mkNode(srcMem.id, 'a');
    expect(await codeOf(merge({ source: srcMem.id, target: tgtMem.id }))).toBe('LOC_PROTECTED');
  });

  it('refuses when either side holds a GOVERNED node', async () => {
    const review = await mkNode(srcMem.id, 'review:x', { role: 'review' });
    expect(await codeOf(merge({ source: srcMem.id, target: tgtMem.id }))).toBe('ROLE_GOVERNED');

    // …and on the target side, keyed on the capability rather than the label:
    // a task is governed by `isRunnable`, not by a role string.
    await db.node.delete({ where: { id: review.id } });
    await mkNode(srcMem.id, 'a');
    await mkNode(tgtMem.id, 'tasks:y', { isRunnable: true });
    expect(await codeOf(merge({ source: srcMem.id, target: tgtMem.id }))).toBe('ROLE_GOVERNED');
  });

  it('refuses BEFORE relocating anything — no partial merge', async () => {
    // A merge commits per page, so a refusal discovered mid-run would leave
    // earlier pages already moved. The preflight runs before Phase 1.
    await mkNode(srcMem.id, 'a');
    await mkNode(srcMem.id, 'b');
    await ensureChannelWithRoot(db, { memoryId: srcMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });

    expect(await codeOf(merge({ source: srcMem.id, target: tgtMem.id }))).toBe('LOC_PROTECTED');
    // Asserted on the SOURCE rows, not on a target count: `createMemory` seeds
    // the target, so "the target is empty" was never the claim this test makes.
    // The claim is that nothing MOVED.
    const stillHome = await db.node.findMany({
      where: { memoryId: srcMem.id, loc: { in: ['a', 'b'] }, deletedAt: null },
      select: { loc: true },
    });
    expect(stillHome.map((n) => n.loc).sort()).toEqual(['a', 'b']);
    expect(await db.node.count({ where: { memoryId: tgtMem.id, loc: { in: ['a', 'b'] } } })).toBe(0);
  });
});

describe('extractParentNodeToMemory consults both gates (#1191)', () => {
  const target = () => `${org.urn}::bg-extracted-${Math.floor(Math.random() * 1e6)}`;

  it('CONTROL: extracting a clean subtree still succeeds', async () => {
    const parent = await mkNode(srcMem.id, 'topic');
    await mkNode(srcMem.id, 'topic:child');
    await mkNode(srcMem.id, 'keep');
    expect(await codeOf(extract(parent.id, target(), true))).toBe('OK');
  });

  it('refuses a MOVE of a subtree containing a Channel', async () => {
    await mkNode(srcMem.id, 'keep');
    await ensureChannelWithRoot(db, { memoryId: srcMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    const parent = await db.node.findFirstOrThrow({ where: { memoryId: srcMem.id, loc: 'chats' } });
    expect(await codeOf(extract(parent.id, target(), true))).toBe('LOC_PROTECTED');
  });

  it('refuses a COPY that would MINT a governed task in the new memory', async () => {
    // #1191 names only `move: true`. The COPY needs the gate for a different
    // reason: the copied rows carry `isRunnable`, so extracting a subtree with
    // a task node produces a governed task node in a brand-new memory through
    // a generic surface — "a create is not always a create".
    const parent = await mkNode(srcMem.id, 'topic');
    await mkNode(srcMem.id, 'topic:runme', { isRunnable: true });
    await mkNode(srcMem.id, 'keep');
    expect(await codeOf(extract(parent.id, target(), false))).toBe('ROLE_GOVERNED');
  });

  it('a Channel OUTSIDE the extracted subtree does not refuse it', async () => {
    // The scoping half. A whole-memory refusal here would be wrong — only the
    // subtree is touched — and a test that only ever refuses cannot show the
    // difference.
    await ensureChannelWithRoot(db, { memoryId: srcMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    const parent = await mkNode(srcMem.id, 'topic');
    await mkNode(srcMem.id, 'topic:child');
    expect(await codeOf(extract(parent.id, target(), true))).toBe('OK');
  });
});

describe('the gate is AUTHORITATIVE, not a point-in-time read (@codex + @copilot P1)', () => {
  it('assertBatchMutable refuses under the Channel-memory LOCK, not from a stale read', async () => {
    // The TOCTOU both bots found: a merge is paged across SEPARATE
    // transactions, so a preflight before Phase 1 cannot see a Channel adopted
    // between pages. `assertBatchMutable` is the answer and runs inside each
    // writing transaction.
    //
    // Asserted at the HELPER, deterministically, and that is a deliberate
    // choice rather than a shortcut. A merge-level version has to create the
    // Channel in the window between the preflight and a later page — real
    // concurrency, with no seam to force the interleaving. I wrote that test
    // first: it passed in isolation and failed under parallel load, because it
    // was measuring timing rather than the gate. A flaky test asserting a
    // security property is worse than none.
    //
    // What IS deterministic, and is the whole mechanism: the helper takes the
    // key `ensureChannelWithRoot` holds while it creates a Channel, re-reads
    // the protected set under it, and refuses on the batch's own rows.
    await ensureChannelWithRoot(db, {
      memoryId: srcMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id,
    });
    const { assertBatchMutable } = await import('../../../lib/bulkMutationGate.js');

    await expect(
      db.$transaction((tx) =>
        assertBatchMutable(tx, [srcMem.id], [{ loc: 'chats:team' }], 'merge'),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'LOC_PROTECTED' } });

    // CONTROL — a row outside every protected address passes, so the refusal
    // above is about the address and not about the helper refusing everything.
    await expect(
      db.$transaction((tx) => assertBatchMutable(tx, [srcMem.id], [{ loc: 'elsewhere' }], 'merge')),
    ).resolves.toBeUndefined();
  });

  it('the merge calls it per BATCH — a fold-time Channel in the target refuses', async () => {
    // The batch-level path, driven through the real operation. The target's
    // Channel is present from the start (so the preflight would also catch it),
    // but with the preflight removed this still refuses — which is what pins
    // the per-batch call rather than the preflight.
    await mkNode(srcMem.id, 'shared');
    await mkNode(tgtMem.id, 'shared');
    await ensureChannelWithRoot(db, {
      memoryId: tgtMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id,
    });
    expect(await codeOf(merge({ source: srcMem.id, target: tgtMem.id }))).toBe('LOC_PROTECTED');
  });

  it('names the offending LOC, not just the kind', async () => {
    // @copilot: the helper's contract promised the loc and the code delivered
    // only the kind. A merge refused over one row among thousands is
    // unactionable without it (#1099).
    await mkNode(srcMem.id, 'reviews:auth-gate', { role: 'review' });
    try {
      await merge({ source: srcMem.id, target: tgtMem.id });
      throw new Error('expected a refusal');
    } catch (e) {
      const err = e as { message: string; extensions?: { loc?: string } };
      expect(err.extensions?.loc).toBe('reviews:auth-gate');
      expect(err.message).toContain('reviews:auth-gate');
    }
  });
});

describe('round 2 — the paths the gate still did not reach (@copilot)', () => {
  it('deleteSourceMem is refused by a Channel in the source', async () => {
    // The per-batch gates release `channel-host:<source>` when their
    // transactions end, so the final `memory.update({ deletedAt })` ran
    // unlocked and unchecked — a merge could soft-delete a memory that hosts a
    // Channel. Staged with the Channel present from the start, which the
    // earlier gates also catch; what this pins is that the FINAL step now
    // takes the lock and re-checks, which the mutation below proves.
    await ensureChannelWithRoot(db, {
      memoryId: srcMem.id, loc: 'chats:team', name: 'team', createdBy: admin.id,
    });
    expect(
      await codeOf(merge({ source: srcMem.id, target: tgtMem.id, deleteSourceMem: true })),
    ).toBe('LOC_PROTECTED');
    const still = await db.memory.findUniqueOrThrow({ where: { id: srcMem.id } });
    expect(still.deletedAt).toBeNull();
  });

  it('the governed check is re-read under the NODE keys, not taken from the caller\'s snapshot', async () => {
    // The kind doors coordinate on `lockLocForWrite(memoryId, loc)` — a NODE
    // key — so the memory lock alone left a door free to promote a row between
    // the caller's snapshot and the write. `assertBatchMutable` now takes the
    // per-row keys and RE-READS under them.
    //
    // Driven by handing the helper a STALE snapshot: the row says ungoverned,
    // the database says otherwise, and the re-read is the only thing that can
    // tell the difference.
    await mkNode(srcMem.id, 'tasks:promoted', { isRunnable: true });
    const { assertBatchMutable } = await import('../../../lib/bulkMutationGate.js');

    await expect(
      db.$transaction((tx) =>
        // The caller's view: not governed. The database disagrees.
        assertBatchMutable(tx, [srcMem.id], [{ loc: 'tasks:promoted', isRunnable: false }], 'merge'),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED', loc: 'tasks:promoted' } });
  });
});
