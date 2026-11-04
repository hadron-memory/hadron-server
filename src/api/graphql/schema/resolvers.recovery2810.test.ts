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
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;

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
    const raw = vi.spyOn(db, '$queryRaw');
    try {
      await Q.recoveryEdges({}, { memoryRef: memoryId, edgeIds: batchIds.slice(0, 3), limit: 3 }, ctx);
      // The masked statement is the one carrying the visibility scan (WITH tombs AS
      // MATERIALIZED — the tombstone set, endpoint identity, the masking predicate
      // and the window total); endpoint discovery interpolates edge subqueries but
      // computes no visibility, and is not the masked scan being pinned.
      const masked = raw.mock.calls.filter((call) => {
        const sql = (call[0] as Prisma.Sql)?.sql ?? '';
        return sql.includes('WITH tombs AS MATERIALIZED');
      });
      expect(masked).toHaveLength(1);
    } finally { raw.mockRestore(); }
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
    await edge(hub.id, goneEndpoint.id, 'hub:to:gone');
    const retained = await node('z');
    const visible = await edge(hub.id, retained.id, 'hub:to:z');
    for (const args of [{ limit: 200 }, { edgeIds: [visible.id, `e-${goneEndpoint.id}`], limit: 200 }] as const) {
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
});
