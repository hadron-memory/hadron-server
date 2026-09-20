/**
 * #1210 / @codex P1 on PR #1230 — extract must copy the governed signals the
 * GATE read under its lock, not the ones its own earlier query returned.
 *
 * `resolvers.bulkMutationGate.test.ts` pins that the gate re-reads and hands
 * the fresh values back. This pins the other half — that extract actually USES
 * them — which is a wiring question and invisible to every other test, because
 * in the ordinary case the stale rows and the fresh ones agree.
 *
 * It buys that by faking the gate's answer: the database says one thing, the
 * gate is made to say another, and the copied rows must follow the GATE.
 * What it therefore proves is narrow and worth stating: that the carry reads
 * from the gate's snapshot. It proves nothing about the gate itself, which is
 * the other file's job, and the fake means the protected-loc half does not run
 * here either.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

// The gate, with its verdict replaced. `assertNoProtectedReach` and the lock
// are intentionally out of the picture: this file is about one wire.
const fakeSnapshot = new Map<string, { role: string | null; isRunnable: boolean | null }>();
vi.mock('../../lib/bulkMutationGate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/bulkMutationGate.js')>();
  return { ...real, assertBatchMutable: vi.fn(async () => fakeSnapshot) };
});

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const { resolvers } = await import('../../api/graphql/schema/resolvers.js');
type Context = Parameters<typeof resolvers.Mutation.createMemory>[2];

let org: { id: string; urn: string };
let admin: { id: string };
let srcMem: { id: string; urn: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

const mkNode = (memoryId: string, loc: string, fields: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...fields } });

beforeEach(async () => {
  await cleanDb(db);
  fakeSnapshot.clear();
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'xf', urn: `xf-${t}` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 66221, githubUsername: `xf-${t}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  srcMem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: `xf-src-${t}` }, ctx());
});

async function extractAndRead(parentId: string): Promise<Record<string, { role: string | null; isRunnable: boolean | null }>> {
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const res = await resolvers.Mutation.extractParentNodeToMemory(
    {},
    { parentRef: parentId, targetUrn: `${org.urn}::xf-out-${t}`, move: false } as never,
    ctx(),
  );
  const rows = await db.node.findMany({
    where: { memoryId: (res as { id: string }).id, deletedAt: null },
    select: { loc: true, role: true, isRunnable: true },
  });
  return Object.fromEntries(rows.map((r) => [r.loc.split(':').pop()!, { role: r.role, isRunnable: r.isRunnable }]));
}

describe('extract copies the GATE\'s signals, not its own snapshot (#1210)', () => {
  it('carries a PROMOTION the gate saw and the operation\'s own read missed', async () => {
    // The database row is ungoverned — as extract's own `findMany` would see
    // it — while the gate reports the promotion that committed in between.
    const parent = await mkNode(srcMem.id, 'p');
    await mkNode(srcMem.id, 'p:kid');
    fakeSnapshot.set('p', { role: null, isRunnable: null });
    fakeSnapshot.set('p:kid', { role: 'review', isRunnable: null });

    const byTail = await extractAndRead(parent.id);

    // Following the stale row would have produced `role: null` here — an
    // ungoverned duplicate of a governed node.
    expect(byTail['kid'].role).toBe('review');
  });

  it('drops a DEMOTION the same way — preserve, never mint', async () => {
    // The inverse, and the one that keeps this from being "always prefer
    // whichever value is governed": the row still carries the marker, the gate
    // says it is gone, and the copy must follow the gate.
    const parent = await mkNode(srcMem.id, 'q');
    await mkNode(srcMem.id, 'q:kid', { role: 'review' });
    fakeSnapshot.set('q', { role: null, isRunnable: null });
    fakeSnapshot.set('q:kid', { role: null, isRunnable: null });

    const byTail = await extractAndRead(parent.id);

    expect(byTail['kid'].role).toBeNull();
  });

  it('falls back to the row when the gate reports no entry for it', async () => {
    // The `?? n` arm. An empty map must not silently strip governance from
    // every copied row — that would be the original #1210 defect restored by
    // the fix for its race.
    const parent = await mkNode(srcMem.id, 'r');
    await mkNode(srcMem.id, 'r:kid', { role: 'review' });
    // fakeSnapshot deliberately left empty.

    const byTail = await extractAndRead(parent.id);

    expect(byTail['kid'].role).toBe('review');
  });
});
