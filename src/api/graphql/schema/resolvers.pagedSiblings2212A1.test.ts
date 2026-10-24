/**
 * #2212 slice A1 — the additive page siblings `nodeRevisionsPage`, `sessionsPage` and
 * `usageEventsPage`, built on #2213 S1's `pageArgs` / `pageEnvelope`.
 *
 * What this file pins, per field:
 *   - `{ items, total, hasMore }`, size edges, ties under the order key never dropped or duplicated.
 *   - `total` and the pages count only rows the caller may read: adding unreadable rows never moves
 *     `total`, and nothing unreadable appears in `items`.
 *   - Admission and collapses match the old field (a miss, an unreadable node, a blank `workerRef`
 *     are an empty page; an out-of-scope caller sees nothing).
 *   - `nodeRevisionsPage` does not under-return near the limit when unreadable snapshots sit at the
 *     top of the order (the old field does, and stays exactly as it was).
 *   - The page query carries take/skip (spied on the Prisma call): no JS slice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let memA: { id: string };
let memB: { id: string };
let member: { id: string };
let outsider: { id: string };

const asUser = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'pg-a', urn: `pg-a-${sfx}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'pg-b', urn: `pg-b-${sfx}` } });
  member = await db.user.create({ data: { id: generateId(), handle: `pgm-${sfx}`, roles: ['READER'] }, select: { id: true } });
  outsider = await db.user.create({ data: { id: generateId(), handle: `pgo-${sfx}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: member.id, role: 'READER' } });
  memA = await db.memory.create({ data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:mem-a`, name: 'mem-a', class: 'knowledge' } });
  memB = await db.memory.create({ data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:mem-b`, name: 'mem-b', class: 'knowledge' } });
});

// ── nodeRevisionsPage ──────────────────────────────────────────────────────

describe('nodeRevisionsPage', () => {
  let node: { id: string };
  const rev = (memoryId: string | null, n: number, at: Date) => ({
    id: generateId(), nodeId: node.id, memoryId, loc: 'n', name: 'n', tags: [], changes: [], revNo: n, content: `c${n}`, createdAt: at,
  });
  const T = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i));

  beforeEach(async () => {
    node = await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: 'n', name: 'n' } });
  });

  it('pages the readable snapshots in order; concatenated pages equal the old field; no drops or duplicates', async () => {
    await db.nodeRevision.createMany({ data: Array.from({ length: 45 }, (_, i) => rev(memA.id, i, T(i))) });
    const c = asUser(member.id);
    const old = await Q.nodeRevisions({}, { nodeRef: node.id, limit: 200 }, c);
    expect(old).toHaveLength(45);
    const seen: string[] = [];
    for (let offset = 0; offset < 45; offset += 20) {
      const p = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 20, offset }, c);
      expect(p.total).toBe(45);
      expect(p.hasMore).toBe(offset + p.items.length < 45);
      seen.push(...ids(p.items));
    }
    expect(seen).toEqual(ids(old));
    expect(new Set(seen).size).toBe(45);
  });

  it('ties under createdAt never drop or duplicate across pages (id tiebreak)', async () => {
    await db.nodeRevision.createMany({ data: Array.from({ length: 30 }, (_, i) => rev(memA.id, i, T(0))) });
    const seen: string[] = [];
    for (let offset = 0; offset < 30; offset += 7) {
      seen.push(...ids((await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 7, offset }, asUser(member.id))).items));
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('size edges: omitted 20, 0 count-only, negative 0, over-cap 200, past the end empty', async () => {
    await db.nodeRevision.createMany({ data: Array.from({ length: 230 }, (_, i) => rev(memA.id, i, T(i))) });
    const c = asUser(member.id);
    expect((await Q.nodeRevisionsPage({}, { nodeRef: node.id }, c)).items).toHaveLength(20);
    const zero = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 0 }, c);
    expect([zero.items.length, zero.total, zero.hasMore]).toEqual([0, 230, true]);
    expect((await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: -4 }, c)).items).toHaveLength(0);
    expect((await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 9999 }, c)).items).toHaveLength(200);
    const past = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 20, offset: 500 }, c);
    expect([past.items.length, past.total, past.hasMore]).toEqual([0, 230, false]);
  });

  it('total counts only readable snapshots; unreadable-memory snapshots never move it and never appear', async () => {
    await db.nodeRevision.createMany({ data: Array.from({ length: 6 }, (_, i) => rev(memA.id, i, T(i))) });
    const c = asUser(member.id);
    const before = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 50 }, c);
    // The node was MOVED across memories: older snapshots belong to a memory the caller cannot read.
    const foreign = Array.from({ length: 9 }, (_, i) => rev(memB.id, 100 + i, T(100 + i)));
    await db.nodeRevision.createMany({ data: foreign });
    const after = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 50 }, c);
    expect(after.total).toBe(before.total);
    expect(after.total).toBe(6);
    expect(ids(after.items)).toEqual(ids(before.items));
    for (const f of foreign) expect(ids(after.items)).not.toContain(f.id);
  });

  it('does not under-return when unreadable snapshots sit at the top of the order (the old field does)', async () => {
    await db.nodeRevision.createMany({ data: Array.from({ length: 6 }, (_, i) => rev(memA.id, i, T(i))) });
    await db.nodeRevision.createMany({ data: Array.from({ length: 9 }, (_, i) => rev(memB.id, 100 + i, T(100 + i))) });
    const c = asUser(member.id);
    const old = await Q.nodeRevisions({}, { nodeRef: node.id, limit: 5 }, c);
    expect(old).toHaveLength(0); // all five newest are in the unreadable memory: dropped after take
    const page = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 5 }, c);
    expect(page.items).toHaveLength(5);
    expect(page.total).toBe(6);
    expect(page.hasMore).toBe(true);
  });

  it('legacy NULL-memoryId snapshots fall back to the node memory and are counted', async () => {
    await db.nodeRevision.createMany({ data: [rev(null, 1, T(1)), rev(null, 2, T(2)), rev(memA.id, 3, T(3))] });
    const p = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 10 }, asUser(member.id));
    expect(p.total).toBe(3);
    expect(p.items).toHaveLength(3);
  });

  it('an unreadable node, a missing node and a non-member all collapse to the empty page', async () => {
    await db.nodeRevision.createMany({ data: [rev(memA.id, 1, T(1))] });
    const empty = { items: [], total: 0, hasMore: false };
    expect(await Q.nodeRevisionsPage({}, { nodeRef: node.id }, asUser(outsider.id))).toEqual(empty);
    expect(await Q.nodeRevisionsPage({}, { nodeRef: generateId() }, asUser(member.id))).toEqual(empty);
  });

  it('the old nodeRevisions is unchanged (still returns the readable snapshots up to its limit)', async () => {
    await db.nodeRevision.createMany({ data: Array.from({ length: 60 }, (_, i) => rev(memA.id, i, T(i))) });
    const old = await Q.nodeRevisions({}, { nodeRef: node.id }, asUser(member.id));
    expect(old).toHaveLength(20);
  });

  it('count and rows are database-side: the page query carries take/skip', async () => {
    await db.nodeRevision.createMany({ data: Array.from({ length: 12 }, (_, i) => rev(memA.id, i, T(i))) });
    const seen: any[] = [];
    const spied = new Proxy(db, {
      get(t, k, r) {
        if (k === 'nodeRevision') {
          return new Proxy(t.nodeRevision, {
            get(m, f) {
              const v = (m as any)[f];
              return f === 'findMany' ? (a: any) => (seen.push(a), v.call(m, a)) : typeof v === 'function' ? v.bind(m) : v;
            },
          });
        }
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const page = await Q.nodeRevisionsPage({}, { nodeRef: node.id, limit: 5, offset: 3 }, { ...asUser(member.id), db: spied });
    expect(page.items).toHaveLength(5);
    expect(seen.find((a) => a?.take === 5)).toMatchObject({ take: 5, skip: 3 });
  });
});

// ── sessionsPage ───────────────────────────────────────────────────────────

describe('sessionsPage', () => {
  const seedSessions = async (userId: string, n: number, over: Record<string, unknown> = {}) => {
    const startedAt = new Date('2026-02-01T00:00:00Z');
    await db.session.createMany({
      data: Array.from({ length: n }, () => ({ id: generateId(), userId, type: 'DEVELOPER', startedAt, ...over })) as never,
    });
  };

  it('pages the same sessions, in the same order, as the old field; ties never drop or duplicate', async () => {
    await seedSessions(member.id, 45);
    const c = asUser(member.id);
    const old = await Q.sessions({}, { limit: 200 }, c);
    expect(old).toHaveLength(45);
    const seen: string[] = [];
    for (let offset = 0; offset < 45; offset += 20) {
      const p = await Q.sessionsPage({}, { limit: 20, offset }, c);
      expect(p.total).toBe(45);
      expect(p.hasMore).toBe(offset + p.items.length < 45);
      seen.push(...ids(p.items));
    }
    expect(new Set(seen).size).toBe(45);
    expect([...seen].sort()).toEqual(ids(old).sort());
  });

  it("total counts only the caller's session scope: another user's sessions never move it", async () => {
    await seedSessions(member.id, 4);
    const c = asUser(member.id);
    const before = await Q.sessionsPage({}, { limit: 50 }, c);
    await seedSessions(outsider.id, 11);
    const after = await Q.sessionsPage({}, { limit: 50 }, c);
    expect(after.total).toBe(4);
    expect(ids(after.items)).toEqual(ids(before.items));
    expect((await Q.sessionsPage({}, { limit: 50 }, asUser(outsider.id))).total).toBe(11);
  });

  it('filters match the old field; a blank or unresolvable workerRef is an empty page, never wider', async () => {
    await seedSessions(member.id, 3, { repo: 'r1' });
    await seedSessions(member.id, 2, { repo: 'r2' });
    const c = asUser(member.id);
    expect((await Q.sessionsPage({}, { repo: 'r1' }, c)).total).toBe(3);
    expect(await Q.sessionsPage({}, { workerRef: '   ' }, c)).toEqual({ items: [], total: 0, hasMore: false });
    expect(await Q.sessionsPage({}, { workerRef: 'hrn:worker:nope.example:none:none' }, c)).toEqual({ items: [], total: 0, hasMore: false });
    expect(await Q.sessions({}, { workerRef: '   ' }, c)).toEqual([]);
  });

  it('size edges and count-only', async () => {
    await seedSessions(member.id, 230);
    const c = asUser(member.id);
    expect((await Q.sessionsPage({}, {}, c)).items).toHaveLength(20);
    const zero = await Q.sessionsPage({}, { limit: 0 }, c);
    expect([zero.items.length, zero.total]).toEqual([0, 230]);
    expect((await Q.sessionsPage({}, { limit: 1000 }, c)).items).toHaveLength(200);
    expect((await Q.sessionsPage({}, { limit: 20, offset: 999 }, c)).items).toHaveLength(0);
  });
});

// ── usageEventsPage ────────────────────────────────────────────────────────

describe('usageEventsPage', () => {
  const seedEvents = async (memoryId: string, n: number, over: Record<string, unknown> = {}) => {
    const createdAt = new Date('2026-03-01T00:00:00Z');
    await db.usageEvent.createMany({
      data: Array.from({ length: n }, () => ({ id: generateId(), type: 'read', nodeLoc: 'shared', memoryId, createdAt, ...over })),
    });
  };

  it('pages the same events as the old field; ties never drop or duplicate', async () => {
    await seedEvents(memA.id, 45);
    const c = asUser(member.id);
    const old = await Q.usageEvents({}, { limit: 200 }, c);
    expect(old).toHaveLength(45);
    const seen: string[] = [];
    for (let offset = 0; offset < 45; offset += 20) {
      const p = await Q.usageEventsPage({}, { limit: 20, offset }, c);
      expect(p.total).toBe(45);
      expect(p.hasMore).toBe(offset + p.items.length < 45);
      seen.push(...ids(p.items));
    }
    expect(new Set(seen).size).toBe(45);
    expect([...seen].sort()).toEqual(ids(old).sort());
  });

  it('total counts only events in readable memories; another memory never moves it', async () => {
    await seedEvents(memA.id, 5);
    const c = asUser(member.id);
    const before = await Q.usageEventsPage({}, { limit: 50 }, c);
    await seedEvents(memB.id, 8);
    const after = await Q.usageEventsPage({}, { limit: 50 }, c);
    expect(after.total).toBe(5);
    expect(ids(after.items)).toEqual(ids(before.items));
    // asking for the unreadable memory answers exactly as the old field does
    const oldErr = await Q.usageEvents({}, { memoryId: memB.id }, c).catch((e: any) => e);
    const newErr = await Q.usageEventsPage({}, { memoryId: memB.id }, c).catch((e: any) => e);
    expect(newErr).toBeInstanceOf(Error);
    expect(newErr.extensions?.code).toBe(oldErr.extensions?.code);
  });

  it('loc and nodeId together are refused as the old field refuses', async () => {
    const c = asUser(member.id);
    const err = await Q.usageEventsPage({}, { loc: 'x', nodeId: 'y' }, c).catch((e: any) => e);
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('type and loc filters narrow the count the same way as the old field', async () => {
    await seedEvents(memA.id, 3, { type: 'read', nodeLoc: 'one' });
    await seedEvents(memA.id, 2, { type: 'write', nodeLoc: 'two' });
    const c = asUser(member.id);
    expect((await Q.usageEventsPage({}, { type: 'write' }, c)).total).toBe(2);
    expect((await Q.usageEventsPage({}, { loc: 'one' }, c)).total).toBe(3);
    expect(await Q.usageEvents({}, { loc: 'one' }, c)).toHaveLength(3);
  });

  it('a non-member sees an empty page; size edges hold', async () => {
    await seedEvents(memA.id, 230);
    expect((await Q.usageEventsPage({}, {}, asUser(outsider.id))).total).toBe(0);
    const c = asUser(member.id);
    expect((await Q.usageEventsPage({}, {}, c)).items).toHaveLength(20);
    const zero = await Q.usageEventsPage({}, { limit: 0 }, c);
    expect([zero.items.length, zero.total]).toEqual([0, 230]);
    expect((await Q.usageEventsPage({}, { limit: 5000 }, c)).items).toHaveLength(200);
  });
});

describe('nodeRevisionsPage guards pinned by the §10 review', () => {
  it('legacy NULL-memoryId snapshots of an unreadable node never appear on the page', async () => {
    const hidden = await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: 'h', name: 'h' } });
    await db.nodeRevision.createMany({ data: [
      { id: generateId(), nodeId: hidden.id, memoryId: null, loc: 'h', name: 'h', tags: [], changes: [], revNo: 1, content: 'legacy-secret' },
    ] });
    const p = await Q.nodeRevisionsPage({}, { nodeRef: hidden.id }, asUser(member.id));
    expect(p).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('a locked encrypted memory page conceals content and approval fields', async () => {
    const enc = await db.memory.create({ data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:enc`, name: 'enc', class: 'knowledge', isEncrypted: true } });
    const en = await db.node.create({ data: { id: generateId(), memoryId: enc.id, loc: 'e', name: 'e' } });
    await db.nodeRevision.createMany({ data: [
      { id: generateId(), nodeId: en.id, memoryId: enc.id, loc: 'e', name: 'e', tags: [], changes: [], revNo: 1, content: 'plain-leftover', approvedAt: new Date() },
    ] });
    const p = await Q.nodeRevisionsPage({}, { nodeRef: en.id }, asUser(member.id));
    expect(p.total).toBe(1);
    expect(p.items[0].content).toBeNull();
    expect(p.items[0].approvedAt).toBeNull();
  });
});
