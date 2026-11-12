/**
 * #2810 second slice: recoveryEdges' work must be bounded by what the call names,
 * not by the memory's size. Pins, red on main at b6ca89ce47's shape:
 *  - the whole-memory page takes 1591-1882ms at 20k nodes / 40k edges (per-edge-side
 *    visibility evaluation — the ancestor subplan ran once per edge × side);
 *  - a restricted (edgeIds) call whose 200 edges fan out over 152 endpoint memories
 *    takes 2620ms (sequential per-memory authorization cascade), and the portal pays
 *    it per batch request — a fresh context per call, like a request;
 *  - count and page are two masked statements (endpoint discovery is a third,
 *    unmasked), so every call pays the masked edge scan twice.
 * Budget fixture sizes are the local repro scale; the production trace calibrates
 * the reported page's own scale (gate: Xabat 2026-11-04, deliverable 3).
 *
 * #3454 (review dispositions): the masking-exactness describe carries the R4 pin
 * (a deleted-comment endpoint in a write-gated memory) and the real hidden-edge id
 * in the restricted soft-deleted-memory case; the snapshot describe pins the two
 * review P1s — every statement of a call reads ONE RepeatableRead snapshot, so a
 * tombstone, endpoint or memory delete committing between discovery and the masked
 * page cannot tear the answer.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds } from './resolvers.helpers.js';

const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;

/** Median-of-N wall clock: robust to a single slow run on a shared CI box. */
async function medianMs(times: number, fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const start = Date.now();
    await fn();
    samples.push(Date.now() - start);
  }
  return samples.sort((a, b) => a - b)[Math.floor(times / 2)];
}

/**
 * The #3454 snapshot seam. The resolver's only test surface is its ctx.db: wrap it so
 * every raw statement — on the client itself, or inside the ONE interactive transaction
 * the resolver opens — is forwarded verbatim and, once it resolves, reported to
 * `afterStatement` with its SQL text. No production hook exists.
 */
function seamDb(afterStatement: (sql: string) => Promise<void> | void): typeof db {
  const wrap = (client: any): any => new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction') return (arg: any, ...opts: any[]) =>
        typeof arg === 'function'
          ? target.$transaction(async (tx: any) => arg(wrap(tx)), ...opts)
          : target.$transaction(arg, ...opts);
      if (prop === '$queryRaw') return async (sql: any, ...rest: any[]) => {
        const out = await target.$queryRaw(sql, ...rest);
        await afterStatement(String(sql?.sql ?? sql));
        return out;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return wrap(db);
}

/** A prod-scale-shaped corpus: deep locs, tombstones, cross-memory endpoints, edge fan-out. */
async function seedScale(orgId: string, memoryId: string, opts: { nodes: number; edges: number; fanout: number }, t?: (l: string) => void) {
  if (opts.fanout > 0) {
    // Endpoints spread across many same-org memories: the authz-cascade shape.
    const fans = await db.memory.createManyAndReturn({ data: Array.from({ length: opts.fanout }, (_, i) => ({
      organizationId: orgId, class: 'knowledge', name: `Fan${i}`, urn: `scale2810.example:fan${i}`,
    })) });
    await db.node.createMany({ data: fans.map((m, i) => ({
      id: `fan-node-${i}`, memoryId: m.id, loc: 'f', name: `fan-node-${i}`, content: 'x', nodeType: 'info',
    })) });
  }
  t?.('fanout done');
  const CHUNK = 2_000;
  for (let i = 0; i < opts.nodes; i += CHUNK) {
    const rows = [];
    for (let j = i; j < Math.min(i + CHUNK, opts.nodes); j++) {
      const depth = 3 + (j % 3);
      rows.push({
        id: `n-${j}`, memoryId, loc: Array.from({ length: depth }, (_, k) => `s${j}d${k}`).join(':'),
        name: `node-${j}`, content: 'x', nodeType: 'info', deletedAt: j < opts.nodes / 20 ? new Date('2026-01-01') : null,
      });
    }
    await db.node.createMany({ data: rows });
  }
  t?.('nodes done');
  for (let i = 0; i < opts.edges; i += CHUNK) {
    const rows = [];
    for (let j = i; j < Math.min(i + CHUNK, opts.edges); j++) {
      const fanTarget = j < 150 && opts.fanout > 0 ? `fan-node-${j % opts.fanout}` : `n-${(j * 104729 + 12345) % opts.nodes}`;
      rows.push({ id: `e-${j}`, memoryId, sourceId: `n-${(j * 7919) % opts.nodes}`, targetId: fanTarget, loc: `edge:${j}` });
    }
    await db.edge.createMany({ data: rows });
  }
  t?.('edges done');
}

describe('recoveryEdges bounded work (#2810)', () => {
  let memoryId: string, writerId: string, ctx: Context, batchIds: string[];
  /** A per-REQUEST context: every portal batch request pays the authz caches cold. */
  const freshCtx = (): Context => ({ db, userId: writerId, roles: [] });
  beforeAll(async () => {
    const seedT0 = Date.now();
    const t = (label: string) => console.log(`[seed2810] ${label} +${Date.now() - seedT0}ms`);
    await cleanDb(db); t('cleanDb');
    const org = await db.organization.create({ data: { name: 'Scale2810', urn: 'scale2810.example' } });
    writerId = (await db.user.create({ data: { handle: 'scale2810-writer' } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: writerId, role: 'CONTRIBUTOR' } });
    memoryId = (await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'Scale', urn: 'scale2810.example:corpus' } })).id;
    ctx = { db, userId: writerId, roles: [] };
    await seedScale(org.id, memoryId, { nodes: 20_000, edges: 40_000, fanout: 150 }, t);
    // A fresh clone inherits the template's empty-table statistics, and the
    // planner then picks catastrophic plans for any real fixture (measured: a
    // 13s+ count on this very fixture until autoanalyze catches up). ANALYZE
    // pins the steady-state plan, which is what the budget asserts.
    await db.$executeRawUnsafe('ANALYZE nodes, edges, memories, organizations');
    t('analyze');
    // The portal's batch shape: 200 named ids, limit = batch size, no offset.
    // e-0..e-199: the first 150 are seeded onto fan-out endpoints (152 distinct
    // endpoint memories incl. the corpus), so the fan-out pin's batch fans out.
    batchIds = (await db.edge.findMany({
      where: { memoryId, id: { in: Array.from({ length: 200 }, (_, j) => `e-${j}`) } },
      select: { id: true },
    })).map((e) => e.id);
    t('batch select');
    // Warm every cold path (Prisma client, connections, plan caches) before timing.
    await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: [batchIds[0]], limit: 1 }, ctx); t('warm restricted');
    await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 20 }, ctx); t('warm full');
  }, 540_000);

  it('answers a whole-memory page within the page budget', async () => {
    const ms = await medianMs(3, () => Q.recoveryEdges({}, { memoryRef: memoryId, limit: 20 }, freshCtx()));
    // Calibrated #1779-style: fixed code measures ~300ms quiet / ~920ms with the host at
    // 137% CPU oversubscription (other suites' vitest workers); main measured 1591-1882ms
    // under the same conditions. 1200ms keeps ~4x quiet headroom and stays >25% below red.
    expect(ms).toBeLessThan(1200);
  }, 120_000);

  it('answers a fan-out restricted batch (150 endpoint memories) within the page budget', async () => {
    const ms = await medianMs(3, () => Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: batchIds, limit: 200 }, freshCtx()));
    // Fixed code: ~60-94ms quiet / ~570ms under the same pathological contention (the
    // per-request authz cascade is one shared-gate query now); main measured 2620ms.
    expect(ms).toBeLessThan(800);
  }, 120_000);

  it('derives the page and its total from ONE masked statement', async () => {
    // Observed through the #3454 seam: the masked statement now runs inside the
    // resolver's one interactive transaction, so a ctx.db spy would see nothing.
    const statements: string[] = [];
    await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: batchIds.slice(0, 3), limit: 3 },
      { ...ctx, db: seamDb((sql) => { statements.push(sql); }) });
    // The masked statement is the one carrying the visibility predicate and the window
    // total (WITH page AS — endpoints joined by primary key with the masking predicate as
    // a filter, count(*) OVER () riding the page); endpoint identity is fetched by plain
    // key-lookup statements that compute no visibility, and are not the masked scan.
    const masked = statements.filter((sql) => sql.includes('WITH page AS'));
    expect(masked).toHaveLength(1);
  });
});

describe('recoveryEdges masking stays exact (#2810)', () => {
  let memoryId: string, writerId: string;
  const ctx = (userId = writerId): Context => ({ db, userId, roles: [] });
  beforeEach(async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { name: 'Exact2810', urn: 'exact2810.example' } });
    writerId = (await db.user.create({ data: { handle: 'exact2810-writer' } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: writerId, role: 'CONTRIBUTOR' } });
    memoryId = (await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'Exact', urn: 'exact2810.example:corpus' } })).id;
  });
  const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: {
    id: `x-${loc.replace(/[^a-z0-9]/gi, '-')}`, memoryId, loc, name: loc, content: 'x', deletedAt: new Date('2026-01-01'), ...extra } });
  const edge = (sourceId: string, targetId: string, loc: string) =>
    db.edge.create({ data: { memoryId, sourceId, targetId, loc } });

  it('keeps an edge into a soft-deleted endpoint memory absent, items and total, both shapes', async () => {
    const hub = await node('hub', { deletedAt: null });
    const goneMemory = await db.memory.create({ data: { class: 'knowledge', name: 'Gone', urn: 'exact2810.example:gone', organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId, deletedAt: new Date() } });
    const goneEndpoint = await db.node.create({ data: { memoryId: goneMemory.id, loc: 'p', name: 'P', content: 'x', nodeType: 'info' } });
    // #3454 review P3: name the HIDDEN edge's own id — a fabricated id probed nothing.
    const hidden = await edge(hub.id, goneEndpoint.id, 'hub:to:gone');
    const retained = await node('z');
    const visible = await edge(hub.id, retained.id, 'hub:to:z');
    for (const args of [{ limit: 200 }, { edgeIds: [visible.id, hidden.id], limit: 200 }] as const) {
      const page = await Q.recoveryEdges({}, { memoryRef: memoryId, ...args }, ctx());
      expect(page.total).toBe(1);
      expect(page.items.map((item: any) => item.id)).toEqual([visible.id]);
    }
  });

  it('counts the whole masked set, not the page, on an unrestricted paged call', async () => {
    const hub = await node('hub', { deletedAt: null });
    const targets = [await node('a'), await node('b'), await node('c')];
    for (const t of targets) await edge(hub.id, t.id, `hub:to:${t.loc}`);
    const ordered = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    const middle = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 1, offset: 1 }, ctx());
    expect(middle.total).toBe(3);
    expect(middle.items).toEqual(ordered.items.slice(1, 2));
    // A drain consumer's last ask can land past the end: no row carries the window
    // total there, and the exact total must still be reported (#2810 slice 2).
    const pastEnd = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 1, offset: 3 }, ctx());
    expect(pastEnd).toEqual({ total: 3, items: [] });
  });

  // #3454 pin (Ralion §10 P3-1, mutant R4): with NO ordinary tombstone in the memory,
  // a deleted-comment endpoint is hidden by the readable/recoverable narrowing alone and
  // the comment exclusion in ok()'s deleted-endpoint branch goes unproven — that mutant
  // survived 62/62 at 28c28243 while main killed it. ONE ordinary (non-comment) tombstone
  // in the same memory arms the gate (the memory holds a recoverable endpoint), so only
  // the node_type <> 'comment' check keeps the deleted comment out of the edge list.
  it('keeps an independently deleted comment endpoint out of recoveryEdges in a write-gated memory', async () => {
    // A canonical id: the comment path resolves targetRef, which rejects loc-shaped ids.
    const hub = await node('hub', { deletedAt: null, id: generateId() });
    const ordinary = await node('ordinary', { nodeType: 'info' });
    // A comment through the real comment path — the schema's COMMENT_INVARIANT trigger
    // forbids raw comment-shaped node rows (only the comment path creates them).
    const comment = await M.createComment({}, { targetRef: hub.id, body: 'removed feedback' }, ctx());
    await M.deleteComment({}, { commentRef: comment.id, expectedRevision: 1 }, ctx());
    const visible = await edge(hub.id, ordinary.id, 'hub:to:ordinary');
    await edge(hub.id, comment.id, 'hub:to:note');
    const page = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(page.total).toBe(1);
    expect(page.items.map((item: any) => item.id)).toEqual([visible.id]);
    expect(page.items[0].target.deletedAt).toBeTruthy();
  });
});

describe('recoveryEdges answers ONE snapshot (#3454 review P1s)', () => {
  let memoryId: string, writerId: string;
  const ctx = (): Context => ({ db, userId: writerId, roles: [] });
  beforeEach(async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { name: 'Snap2810', urn: 'snap2810.example' } });
    writerId = (await db.user.create({ data: { handle: 'snap2810-writer' } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: writerId, role: 'CONTRIBUTOR' } });
    memoryId = (await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'Snap', urn: 'snap2810.example:corpus' } })).id;
  });
  const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: {
    id: `s-${loc.replace(/[^a-z0-9]/gi, '-')}`, memoryId, loc, name: loc, content: 'x', deletedAt: null, ...extra } });
  const edge = (sourceId: string, targetId: string, loc: string) =>
    db.edge.create({ data: { memoryId, sourceId, targetId, loc } });

  /**
   * Runs one recoveryEdges call while `mutate` commits on another connection the moment
   * the tombstone statement resolves — the exact window the two review P1s lived in
   * (between endpoint/tombstone discovery and the masked page). `fired` proves the window
   * was entered; a run that silently skipped the interleave would otherwise read as a pass.
   * Asserts one-snapshot semantics: the in-flight call answers the state it started from,
   * never a mixture of pre- and post-commit views.
   */
  async function inFlight(mutate: () => Promise<unknown>) {
    let fired = false;
    const seam = seamDb(async (sql) => {
      if (!fired && sql.includes('deleted_at IS NOT NULL AND memory_id = ANY')) {
        fired = true;
        await mutate();
      }
    });
    const page = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, { ...ctx(), db: seam });
    return { page, fired };
  }

  it('does not tear the page when an endpoint is tombstoned mid-call', async () => {
    const hub = await node('hub');
    const victim = await node('victim');
    const kept = await node('kept');
    const eVictim = await edge(hub.id, victim.id, 'hub:to:victim');
    const eKept = await edge(hub.id, kept.id, 'hub:to:kept');
    const before = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(before.total).toBe(2);
    // Pre-#3454 this interleaving produced a MIXTURE: the masked page saw the fresh
    // tombstone while the verdict sets were stale, so the edge vanished mid-call — an
    // answer no consistent snapshot ever exhibited. One snapshot keeps it whole.
    const { page, fired } = await inFlight(() => db.node.update({ where: { id: victim.id }, data: { deletedAt: new Date() } }));
    expect(fired).toBe(true);
    expect(page.total).toBe(2);
    expect(page.items.map((item: any) => item.id).sort()).toEqual([eKept, eVictim].map((e) => e.id).sort());
    expect(page.items.find((item: any) => item.id === eVictim.id)!.target.deletedAt).toBe(null);
    // The delete did land: a fresh call reports the endpoint as deleted — listed, because
    // the memory is write-gated for the caller (an ordinary tombstone arms recoverable).
    const after = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(after.total).toBe(2);
    expect(after.items.find((item: any) => item.id === eVictim.id)!.target.deletedAt).toBeTruthy();
  });

  it('does not change the in-flight page when an ancestor is tombstoned mid-call', async () => {
    const hub = await node('hub');
    const anc = await node('anc');
    const child = await node('anc:child');
    const eAnc = await edge(hub.id, anc.id, 'hub:to:anc');
    await edge(hub.id, child.id, 'hub:to:child');
    const before = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(before.total).toBe(2);
    // The ancestor half of the review P1: badIds and the page must come from ONE
    // snapshot, so a tombstone committing between them cannot produce a page that is
    // neither the pre- nor the post-commit view.
    const { page, fired } = await inFlight(() => db.node.update({ where: { id: anc.id }, data: { deletedAt: new Date() } }));
    expect(fired).toBe(true);
    expect(page).toEqual(before);
    // Fresh calls apply the ancestor mask: the live child under the tombstoned ancestor
    // disappears; the tombstoned ancestor itself is listed as a deleted endpoint.
    const after = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(after.total).toBe(1);
    expect(after.items[0].id).toBe(eAnc.id);
    expect(after.items[0].target.deletedAt).toBeTruthy();
  });

  it('does not change the in-flight page when an endpoint memory is deleted mid-call', async () => {
    const hub = await node('hub');
    const kept = await node('kept');
    const other = await db.memory.create({ data: { class: 'knowledge', name: 'Other', urn: 'snap2810.example:other', organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId } });
    const endpoint = await db.node.create({ data: { memoryId: other.id, loc: 'p', name: 'P', content: 'x', nodeType: 'info' } });
    await edge(hub.id, endpoint.id, 'hub:to:other');
    const eKept = await edge(hub.id, kept.id, 'hub:to:kept');
    const before = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(before.total).toBe(2);
    // The memory half of the review P1: the endpoint memory's liveness is read at the
    // same snapshot as the page, so a delete committing between the readable verdicts
    // and the masked scan cannot tear the answer.
    const { page, fired } = await inFlight(() => db.memory.update({ where: { id: other.id }, data: { deletedAt: new Date() } }));
    expect(fired).toBe(true);
    expect(page).toEqual(before);
    // Fresh calls conceal the deleted memory's endpoints entirely (the shared gate
    // excludes soft-deleted memories, so readable never admits it again).
    const after = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, ctx());
    expect(after.total).toBe(1);
    expect(after.items.map((item: any) => item.id)).toEqual([eKept.id]);
  });

  // #3454 review-delta pin (Ralion P2, Anne P2 — the #1360 class): every query the
  // resolver runs inside its transaction rides the transaction's own connection. The
  // tombstone fixture ARMS the write-verdict fan-out (a readable memory holding a
  // non-comment tombstone), so a verdict asked of ctx.db mid-transaction would wait for
  // a second connection — on a 1-connection pool that is a P2024 deadlock (verified red
  // at 06ea4cbe); all-on-the-tx answers normally.
  it('answers on a 1-connection pool with the write-verdict fan-out armed', async () => {
    const hub = await node('hub');
    const ordinary = await node('ordinary', { nodeType: 'info', deletedAt: new Date('2026-01-01') });
    const kept = await node('kept');
    const hidden = await edge(hub.id, ordinary.id, 'hub:to:ordinary');
    const eKept = await edge(hub.id, kept.id, 'hub:to:kept');
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '5');
    const one = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const page = await Q.recoveryEdges({}, { memoryRef: memoryId, limit: 200 }, { db: one as unknown as Context['db'], userId: writerId, roles: [] });
      // The tombstoned endpoint is listed (deleted branch; the fan-out armed and ran).
      expect(page.total).toBe(2);
      expect(page.items.map((item: any) => item.id).sort()).toEqual([eKept.id, hidden.id].sort());
      expect(page.items.find((item: any) => item.id === hidden.id)!.target.deletedAt).toBeTruthy();
    } finally {
      await one.$disconnect();
    }
  }, 30_000);

  // #3454 review P3 (Anne, carried through the delta): recoveryEdges bases `readable`
  // on ONE unscoped getAccessibleMemoryIds call instead of per-memory scoped calls. The
  // equivalence this rests on is pinned here, not argued: for the supported principals
  // (a direct user, a platform admin), unscoped ∩ {id} must equal the scoped answer for
  // every memory in reach — accessible through the org, PUBLIC, or out of reach entirely.
  it('unscoped gate membership equals the scoped answer across principals and unrelated memories', async () => {
    const org = await db.organization.create({ data: { name: 'EqOrg', urn: 'eq2810.example:org' } });
    const other = await db.organization.create({ data: { name: 'EqOther', urn: 'eq2810.example:other' } });
    const member = (await db.user.create({ data: { handle: 'eq2810-member' } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: member, role: 'READER' } });
    const stranger = (await db.user.create({ data: { handle: 'eq2810-stranger' } })).id;
    const mem = (data: Record<string, unknown>) => db.memory.create({ data: { class: 'knowledge', name: 'M', ...data } as any });
    const inOrg = (await mem({ organizationId: org.id, urn: 'eq2810.example:a' })).id;
    const secondOrg = (await mem({ organizationId: org.id, urn: 'eq2810.example:b' })).id;
    // The PUBLIC branch is the widening one: this memory sits in an org the member does
    // NOT belong to, so only its PUBLIC visibility can carry it into the accessible set.
    const publicMemory = (await mem({ organizationId: other.id, urn: 'eq2810.example:pub', visibility: 'PUBLIC' })).id;
    const foreignOrg = (await mem({ organizationId: other.id, urn: 'eq2810.example:foreign' })).id;
    const personal = (await mem({ urn: 'eq2810.example:own', class: 'personal', userId: stranger, ownerUserId: stranger })).id;
    const ids = [inOrg, secondOrg, publicMemory, foreignOrg, personal];
    for (const ctx of [{ db, userId: member, roles: [] }, { db, userId: member, roles: ['ADMIN'] }] as Context[]) {
      const unscoped = await getAccessibleMemoryIds(ctx);
      const unscopedSet = new Set(unscoped);
      for (const id of ids) {
        const scoped = await getAccessibleMemoryIds(ctx, id);
        expect([id, scoped.includes(id)]).toEqual([id, unscopedSet.has(id)]);
      }
    }
  });
});
