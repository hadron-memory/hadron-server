/**
 * #5063 (PR 1 of the #1613 remainder) — pin the per-node re-key of the legacy
 * memory corpus columns BEFORE the readers move (red-first).
 *
 * The legacy columns `Memory.corpusDraft` / `corpusMintedAt` / `corpusMintedBy`
 * are vestigial since #1591: corpus state is derived per node (cor:dmo:120:00,
 * :08, :09 — a node's own `minted_at` is the mint record). PR 1 re-keys every
 * remaining reader off the columns and stops every writer; the columns stay in
 * the schema (no migration) until PR 2 drops them.
 *
 * PR 2 (#5063, migration 20261125030000_drop_memory_corpus_columns) dropped them: C1a and C1b now
 * assert the memory row has no such field at all (src/test/migrations/corpusColumnDrop5063.test.ts
 * pins the drop itself), and C2's "minted node, no stamp" state is the only state there is.
 *
 * Naming and numbering (#5088 F11): the file keeps its #1613 name because it was written against the #1613 remainder
 * and is cited by that name elsewhere; its pins belong to #5063 (PR 1 of that remainder). There is no C3 pin. The
 * numbers are kept as they are, because other comments cite C2, C2b, C4, C5 and C6 by number.
 *
 * The pins read the legacy columns by raw SQL, so they are red on main exactly
 * where main still writes them (C1) or keys behavior on them (C2), and green
 * where main already behaves correctly (C4–C6, controls):
 *
 * - C1a `createMemory(draftCorpus: true)` must leave `corpus_draft` false.
 * - C1b `mintMemoryNodes` must leave `corpus_minted_at`/`corpus_minted_by`
 *   null and mint the node records instead.
 * - C2  the first-spec-mark conflict probe (#1468/#1475) must key on "the
 *   memory holds a node with `minted_at` set (tombstones included)", not on
 *   the legacy stamp: a memory whose node is minted but whose stamp is null
 *   (the #1591-backfill shape) must still lose the race against a concurrent
 *   whole-corpus delete (NODE_WRITE_CONFLICT, nothing written). On main the
 *   probe reads the null stamp and the marking succeeds — red at the
 *   rejection; after the re-key it conflicts.
 * - C2b the unminted counterpart (a control, green on main): in a
 *   never-minted memory the probe must answer "not minted" and the guard
 *   must take NO memory lock — a first spec mark does not conflict with a
 *   concurrent whole-corpus delete. Kills the mutant that drops the probe's
 *   `AND minted_at IS NOT NULL` term (every node row would read as minted).
 * - C4  control: `Memory.corpusMintedAt` (the derived field) stays
 *   MAX(nodes.minted_at) over live nodes.
 * - C5  control: the dry-run spec-replace plan hash is byte-stable for a
 *   fixed fixture — the `corpusDraft: true` literal stays in the hashed input
 *   so pre-deploy dry-runs stay valid across the re-key (R3).
 * - C6  control: a mint still bumps `Memory.updatedAt` (R4a: the write
 *   remains, re-keyed to `{ updatedAt: now }`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb, createMintMarker } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { lockMintedSpecUnmarks } from './mintedSpecPermanence.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string; urn: string };
let admin: { id: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

/** The mint record a legal backfilled fixture carries: a plain timestamp, owner-info only. */
const MINT = new Date('2026-01-01T00:00:00.000Z');

async function specNode(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({
    data: {
      id: generateId(), memoryId, loc, name: loc,
      content: `Body of ${loc}.`, role: 'spec', nodeType: 'info', tags: ['spec'],
      ...extra,
    },
  });
}

/**
 * A tombstoned, minted, neutral (non-spec) node: the mint record stands on its
 * own. Shape is the one `chk_node_mint_complete` admits for a backfilled
 * marker: `minted_at` set, owner-info only, no mint revision/hash.
 */
function mintMarker(memoryId: string, loc: string) {
  return createMintMarker(db, memoryId, { loc, mintedAt: MINT, role: 'info', nodeType: 'info' });
}

/** The mint path the way a caller drives it: approve every node, then mint. */
const mint = (memoryRef: string) => resolvers.Mutation.mintMemoryNodes(null, { memoryRef, dryRun: false }, ctx());

const approveAll = (memoryRef: string) => resolvers.Mutation.approveMemoryNodes(null, { memoryRef }, ctx());

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Corpus Org', urn: 'corpus1613.example' } });
  admin = await db.user.create({ data: { githubId: 506301, githubUsername: 'corpus-admin', handle: 'corpus-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});

describe('#5063 C1 — nothing writes the legacy corpus columns', () => {
  it('C1a — createMemory(draftCorpus: true) is accepted and writes no corpus_draft', async () => {
    const m = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'c1a', draftCorpus: true }, ctx());
    // PR 2 (#5063) dropped the column: the argument is accepted and ignored, and the row has no such field.
    const [row] = await db.$queryRaw<Array<{ r: Record<string, unknown> }>>`
      SELECT to_jsonb(m) AS r FROM memories m WHERE id = ${m.id}`;
    expect(row.r.id).toBe(m.id);
    expect(row.r).not.toHaveProperty('corpus_draft');
  });

  it('C1b — mintMemoryNodes writes no memory stamp and mints the node records', async () => {
    const m = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'c1b' }, ctx());
    await specNode(m.id, 'c1b:010');
    await approveAll(m.id);
    await mint(m.id);
    // PR 2 (#5063) dropped the stamp columns: the row has neither, and the node records hold the mint.
    const [row] = await db.$queryRaw<Array<{ r: Record<string, unknown> }>>`
      SELECT to_jsonb(m) AS r FROM memories m WHERE id = ${m.id}`;
    expect(row.r.id).toBe(m.id);
    expect(row.r).not.toHaveProperty('corpus_minted_at');
    expect(row.r).not.toHaveProperty('corpus_minted_by');
    const n = await db.node.findFirstOrThrow({ where: { memoryId: m.id, mintedAt: { not: null } } });
    expect(n.mintedAt).toBeInstanceOf(Date);
  });
});

describe('#5063 C2 — the first-spec-mark conflict probe keys on the node mint, not the stamp (R1a)', () => {
  /** Run `writer` in a transaction held open until the returned release is called (the #1468 harness). */
  async function holdOpen(writer: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
    let release!: () => void;
    let written!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const isWritten = new Promise<void>((r) => { written = r; });
    let pid = 0;
    const done = db.$transaction(async (tx) => {
      [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await writer(tx); written(); await hold;
    }, { timeout: 20_000 });
    await isWritten;
    return { release, done, pid };
  }

  it('a memory whose node is minted but whose legacy stamp is null still conflicts with a concurrent delete', async () => {
    const m = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'c2' }, ctx());
    await mintMarker(m.id, 'c2:mint-marker');
    // Role null: the generic updateNode door refuses spec-family ROLES, and
    // #1468's marking races are driven through it — the marker is the TAG.
    const n = await db.node.create({
      data: {
        id: generateId(), memoryId: m.id, loc: 'c2:010', name: 'c2:010',
        content: 'draft spec', role: null, nodeType: 'info', tags: [],
      },
    });
    // The state PR 2 (#5063) leaves behind: the node is minted and the memory has no stamp column at all.

    // Stand-in for deleteMemory: the row FOR UPDATE and the tombstone, held open.
    const { release, done, pid: holderPid } = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${m.id} FOR UPDATE`;
      await tx.memory.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
    });
    // Settled at once into a value, so a failing waitFor below cannot leave an unhandled rejection behind.
    const marking = resolvers.Mutation.updateNode({}, { input: { id: n.id, tags: ['spec'] } } as never, ctx())
      .then(() => null as unknown, (e: unknown) => e);
    try {
      // A memory FOR SHARE wait appears while the delete holds the row (the
      // write door's own ownership FOR SHARE, and after the re-key the
      // guard's coordination lock too). The waitFor only pins the ordering —
      // on MAIN the pin is red further down: the guard's unlocked probe
      // reads the null legacy stamp, takes no interest, and the marking
      // SUCCEEDS; only the re-keyed probe (a minted node exists) makes the
      // marking lose this race.
      await vi.waitFor(async () => {
        // Any backend blocked by the stand-in delete's backend, by pid (not by matching SQL text). The holder only
        // touches the memory row, so what waits on it is the marking's memory FOR SHARE.
        const waits = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
        expect(waits.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally { release(); }
    await done;
    const outcome = await marking;
    expect(outcome).toBeInstanceOf(GraphQLError);
    expect((outcome as GraphQLError).extensions.code).toBe('NODE_WRITE_CONFLICT');
    expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ tags: [] });
  }, 20_000);

  it("C2b — a never-minted memory's first spec mark takes no memory lock (control)", async () => {
    const m = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'c2b' }, ctx());
    const n = await db.node.create({
      data: {
        id: generateId(), memoryId: m.id, loc: 'c2b:010', name: 'c2b:010',
        content: 'draft note', role: null, nodeType: 'info', tags: [],
      },
    });
    // No mint record anywhere in the memory, and no legacy stamp either (the
    // state PR 2 leaves behind). A stand-in whole-corpus delete holds the
    // memory row FOR UPDATE, as deleteMemory does before its tombstone.
    const { release, done } = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${m.id} FOR UPDATE`;
    });
    try {
      // The unlocked probe must answer "not minted" and the guard must return
      // WITHOUT the coordinating memory FOR SHARE. Under a short lock_timeout
      // that lock would abort (55P03) behind the stand-in delete, so finishing
      // fast and empty is the proof no lock was taken. Kills the mutant that
      // drops `AND minted_at IS NOT NULL` from the probe: with it, any memory
      // holding a node row reads as minted and the first spec mark waits on
      // the delete it must not care about.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        const guarded = await lockMintedSpecUnmarks(tx, m.id, [{ id: n.id, tags: ['spec'] }]);
        expect(guarded).toEqual([]);
      });
    } finally { release(); }
    await done;
    // The mark itself was not the pin's subject (the door's own locks own
    // that path); the guard's abstention is.
  }, 20_000);
});

describe('#5063 C4–C6 — controls, green on main by construction', () => {
  it('C4 — Memory.corpusMintedAt stays the latest live node mint', async () => {
    const m = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'c4' }, ctx());
    expect(await resolvers.Memory.corpusMintedAt({ id: m.id }, {}, ctx())).toBeNull();
    await specNode(m.id, 'c4:010');
    await approveAll(m.id);
    await mint(m.id);
    const latest = (
      await db.node.aggregate({ where: { memoryId: m.id, deletedAt: null }, _max: { mintedAt: true } })
    )._max.mintedAt;
    expect(latest).toBeInstanceOf(Date);
    expect(await resolvers.Memory.corpusMintedAt({ id: m.id }, {}, ctx())).toEqual(latest);
  });

  it('C6 — a mint still bumps Memory.updatedAt (R4a)', async () => {
    const m = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'c6' }, ctx());
    await specNode(m.id, 'c6:010');
    await approveAll(m.id);
    // Backdate by a minute (an explicit updatedAt wins over @updatedAt), so the bump is visible with no sleeping.
    // Assumes no DB trigger rewrites updated_at; the mint's bump is stamped by the app clock like this value, and a
    // minute covers any ordinary skew between the two.
    await db.memory.update({ where: { id: m.id }, data: { updatedAt: new Date(Date.now() - 60_000) } });
    const before = (await db.memory.findUniqueOrThrow({ where: { id: m.id } })).updatedAt;
    await mint(m.id);
    const after = (await db.memory.findUniqueOrThrow({ where: { id: m.id } })).updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe('#5063 C5 — the dry-run spec-replace plan hash is byte-stable (R3)', () => {
  // FIXED ids and content: the plan hash covers memoryId, the selected node
  // ids, and each node's revision state fingerprint, so the fixture must be
  // byte-identical across runs for the golden to mean anything.
  // cuid-shaped literals (`c` + 24 lowercase alnum): resolveMemoryRef /
  // resolveNodeRef dispatch on this exact shape, anything else reads as a
  // URN. Padded to length so the count cannot drift by hand.
  const cuidLiteral = (stem: string) => `c${stem.padEnd(24, '0')}`;
  const MEM_ID = cuidLiteral('1613c5memfixed');
  const N1_ID = cuidLiteral('1613c5node010');
  const N2_ID = cuidLiteral('1613c5node020');

  it('the plan for a fixed fixture equals the golden hex computed on main', async () => {
    const m = await db.memory.create({
      data: { id: MEM_ID, organizationId: org.id, class: 'knowledge', urn: `${org.urn}/c5-golden`, name: 'c5-golden' },
    });
    await db.node.create({ data: { id: N1_ID, memoryId: m.id, loc: 'c5:010', name: 'c5:010', content: 'alpha beta gamma', role: 'spec', nodeType: 'info', tags: ['spec'] } });
    await db.node.create({ data: { id: N2_ID, memoryId: m.id, loc: 'c5:020', name: 'c5:020', content: 'beta zeta', role: 'spec', nodeType: 'info', tags: ['spec'] } });
    const preview = await resolvers.Mutation.searchReplaceInSpecNodes(null, {
      input: { memoryRef: m.id, nodeIds: [N1_ID, N2_ID], oldText: 'beta', newText: 'delta', fields: ['content'], dryRun: true },
    } as never, ctx());
    expect(preview.plan).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.plan).toBe('b7b30519c7d3f1f7f5bb5dbc11eefaffa761b37af5d1fdbcef7811b8c0ac0972');
  });
});
