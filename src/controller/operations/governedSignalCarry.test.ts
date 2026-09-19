/**
 * #1218 / #1210 / #1205 — the owning operations carry the governed signals.
 *
 * @Holger ruled `extractParentNodeGraph`, `cloneMemory` and git sync are all
 * OWNING OPERATIONS: they carry the governed signals (`role`, `isRunnable`)
 * across rather than dropping them, and the gate does not refuse them for doing
 * so.
 *
 * THE THREE DO NOT START FROM THE SAME PLACE, and #1218's table predates the
 * difference, so it is measured here rather than assumed:
 *
 *   - **clone** has no governed gate at all. It copies, and dropped `role`.
 *     That is the bug #1218 describes, and it is real.
 *   - **extract** consults `assertBatchMutable` since #1191, which calls
 *     `assertNoGovernedRows` — so on `main` it REFUSES a subtree containing a
 *     governed node outright. The copied-review-arrives-ungoverned defect
 *     (#1210) is therefore not reachable through it today: the copy never
 *     happens. Declaring extract owning means converting that refusal into a
 *     carry, which is a larger change than adding a field, and the ruling is
 *     explicit that the gate must not refuse an owning operation.
 *   - **git sync** preserves in place (its update payload omits both signals,
 *     and an omitted field in a Prisma update is left alone). Its defect is the
 *     round-trip: the signals cannot be expressed in the repo (#1205).
 *
 * The first `describe` below is a STATE PROBE rather than a requirement — it
 * pins what each operation does today so a reader can see why the three halves
 * of this change look different.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import {
  carryGovernedSignals,
  governedSignalsFromMirror,
  GOVERNED_SIGNAL_FIELDS,
} from '../../lib/governedSignals.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let srcMem: { id: string; urn: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

const mkNode = (memoryId: string, loc: string, fields: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...fields } });

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
  org = await db.organization.create({ data: { id: generateId(), name: 'gs', urn: `gs-${t}` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 66220, githubUsername: `gs-${t}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  srcMem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: `gs-src-${t}` }, ctx());
});

// ---------------------------------------------------------------------------
// The unit the whole change hangs on.
// ---------------------------------------------------------------------------

describe('governedSignals — the set is derived, not hand-listed', () => {
  it('covers every field the register keys on', () => {
    // The invariant: carry the signals the GATE reads. Deriving it from
    // GOVERNED_KINDS is what makes that provable — a fourth governed kind on a
    // new column extends this automatically, where a hand-written list would
    // drift silently, which is how `role` came to be missing in the first place.
    expect([...GOVERNED_SIGNAL_FIELDS].sort()).toEqual(['isRunnable', 'role']);
  });

  it('carryGovernedSignals preserves and never mints', () => {
    expect(carryGovernedSignals({ role: 'review', isRunnable: null })).toEqual({
      role: 'review',
      isRunnable: null,
    });
    // An ungoverned source must yield an ungoverned copy — a copy that invents
    // governance is as wrong as one that drops it.
    expect(carryGovernedSignals({})).toEqual({ role: null, isRunnable: null });
  });

  it('governedSignalsFromMirror distinguishes ABSENT from null — the whole point', () => {
    // Set: the repo speaking as source of truth.
    expect(governedSignalsFromMirror({ role: 'spec' })).toEqual({ role: 'spec' });
    // Absent: no opinion. The key must not appear, or a Prisma update clears
    // the column on every sync of every file that predates this change.
    expect(governedSignalsFromMirror({})).toEqual({});
    expect('role' in governedSignalsFromMirror({})).toBe(false);
    // Explicitly null: a deliberate un-govern, which the repo may express.
    expect(governedSignalsFromMirror({ role: null })).toEqual({ role: null });
    expect('role' in governedSignalsFromMirror({ role: null })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State probe — what each operation does on this branch.
// ---------------------------------------------------------------------------

describe('#1218 — clone is an owning operation', () => {
  it('CONTROL: a clone of an ungoverned memory still succeeds', async () => {
    await mkNode(srcMem.id, 'plain');
    const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const code = await codeOf(
      resolvers.Mutation.cloneMemory({}, { ref: srcMem.id, targetUrn: `${org.urn}::gs-clone-a-${t}` } as never, ctx()),
    );
    expect(code).toBe('OK');
  });

  it('carries role AND isRunnable onto the cloned rows', async () => {
    // Before this change clone copied `isRunnable` by hand and not `role`, so a
    // cloned task stayed governed and a cloned review did not — the asymmetry
    // that makes the bug invisible if you only test one kind. One fixture per
    // signal, therefore.
    await mkNode(srcMem.id, 'a-review', { role: 'review' });
    await mkNode(srcMem.id, 'a-task', { isRunnable: true });
    await mkNode(srcMem.id, 'a-plain');

    const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const clone = await resolvers.Mutation.cloneMemory(
      {},
      { ref: srcMem.id, targetUrn: `${org.urn}::gs-clone-${t}` } as never,
      ctx(),
    );

    const rows = await db.node.findMany({
      where: { memoryId: (clone as { id: string }).id, deletedAt: null },
      select: { loc: true, role: true, isRunnable: true },
      orderBy: { loc: 'asc' },
    });
    const byLoc = Object.fromEntries(rows.map((r) => [r.loc, r]));
    expect(byLoc['a-review']?.role).toBe('review');
    expect(byLoc['a-task']?.isRunnable).toBe(true);
    // …and the ungoverned node stays ungoverned: the carry preserves, it does
    // not stamp every copied row.
    expect(byLoc['a-plain']?.role).toBeNull();
    expect(byLoc['a-plain']?.isRunnable).not.toBe(true);
  });
});

describe('#1210 — extract, and what #1211 already did to it', () => {
  it('STATE: extract REFUSES a governed subtree on main (so #1210 is not reachable through it)', async () => {
    // Recorded as a measurement, not endorsed as a requirement. #1191 gave
    // extract `assertBatchMutable`, which calls `assertNoGovernedRows` — so the
    // copy that #1210 says loses `role` never happens. #1218 rules that an
    // owning operation must not be refused, which makes converting this
    // refusal into a carry a DECISION rather than a field addition, and it is
    // flagged rather than taken unilaterally.
    const parent = await mkNode(srcMem.id, 'parent');
    await mkNode(srcMem.id, 'parent:child', { role: 'review' });
    const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const code = await codeOf(
      resolvers.Mutation.extractParentNodeToMemory(
        {},
        { parentRef: parent.id, targetUrn: `${org.urn}::gs-x-${t}`, move: false } as never,
        ctx(),
      ),
    );
    expect(code).toBe('ROLE_GOVERNED');
  });

  it('CONTROL: an UNGOVERNED subtree extracts, and the carry does not stamp it', async () => {
    // The control matters here for the usual reason: a gate that refused
    // everything would satisfy the case above.
    const parent = await mkNode(srcMem.id, 'p2');
    await mkNode(srcMem.id, 'p2:kid');
    const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const targetUrn = `${org.urn}::gs-y-${t}`;
    // Taken from the mutation's own return rather than looked up: extract
    // REBASES the subtree onto a new root loc, so a query keyed on the source
    // loc finds nothing and the test would fail for a reason unrelated to the
    // carry.
    const mem = (await resolvers.Mutation.extractParentNodeToMemory(
      {},
      { parentRef: parent.id, targetUrn, move: false } as never,
      ctx(),
    )) as { id: string };
    const rows = await db.node.findMany({
      where: { memoryId: mem.id, deletedAt: null },
      select: { role: true, isRunnable: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.role).toBeNull();
      expect(r.isRunnable).not.toBe(true);
    }
  });
});
