/**
 * #796 — `usageActivity`: bucketing, window semantics, and scoping/auth.
 *
 * Real-DB integration (the resolvers.usageEvents.* pattern): resolvers are
 * called directly, so GraphQL's own arg validation is bypassed and the
 * resolver's defensive handling is reachable.
 *
 * Fixture mirrors resolvers.usageEvents.access.test.ts — two orgs so the
 * memory-scope gate has something to exclude, plus a SECOND readable memory so
 * the #805 union has two members to sum:
 *
 *   orgA: memA + memA2 (knowledge, org-readable)   orgB: memB (knowledge)
 *   member    — READER of orgA
 *   outsider  — member of neither
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let memA: { id: string; urn: string };
let memA2: { id: string; urn: string };
let memB: { id: string };
let member: { id: string };
let outsider: { id: string };

const asMember = (): Context => ({ db, userId: member.id, roles: ['READER'] }) as Context;
const asOutsider = (): Context => ({ db, userId: outsider.id, roles: ['READER'] }) as Context;
const asAppKey = (): Context => ({ db, appId: 'app-1', roles: [] }) as Context;

/** ISO string `days` before now. */
const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

/** Insert `count` events of `type` at an exact instant. */
const seed = async (opts: {
  count: number;
  type: 'read' | 'write' | 'action-run';
  at: Date;
  userId?: string;
  memoryId?: string;
}) => {
  await db.usageEvent.createMany({
    data: Array.from({ length: opts.count }, () => ({
      id: generateId(),
      type: opts.type,
      userId: opts.userId ?? null,
      memoryId: opts.memoryId ?? null,
      createdAt: opts.at,
    })),
  });
};

/** Sum reads/writes across every returned bucket. */
const totals = (buckets: Array<{ reads: number; writes: number }>) =>
  buckets.reduce((acc, b) => ({ reads: acc.reads + b.reads, writes: acc.writes + b.writes }), {
    reads: 0,
    writes: 0,
  });

beforeEach(async () => {
  await cleanDb(db);

  const orgA = await db.organization.create({
    data: { id: generateId(), name: 'ua-org-a', urn: `ua-org-a-${generateId().slice(-8)}` },
  });
  const orgB = await db.organization.create({
    data: { id: generateId(), name: 'ua-org-b', urn: `ua-org-b-${generateId().slice(-8)}` },
  });

  memA = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      urn: `${orgA.urn}:mem-a`,
      name: 'mem-a',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
  memA2 = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      urn: `${orgA.urn}:mem-a2`,
      name: 'mem-a2',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
  memB = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgB.id,
      urn: `${orgB.urn}:mem-b`,
      name: 'mem-b',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });

  member = await db.user.create({
    data: { id: generateId(), githubId: 8101, githubUsername: 'ua-member', roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 8102, githubUsername: 'ua-outsider', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'READER' },
  });
});

describe('usageActivity — bucketing', () => {
  it('groups events into per-day buckets and counts reads and writes separately', async () => {
    await seed({ count: 2, type: 'read', at: daysAgo(1), userId: member.id });
    await seed({ count: 1, type: 'write', at: daysAgo(1), userId: member.id });
    await seed({ count: 3, type: 'read', at: daysAgo(3), userId: member.id });

    const r = await Q.usageActivity(null, {}, asMember());
    expect(r).toHaveLength(2);
    // Ascending by date.
    expect(r[0].date < r[1].date).toBe(true);
    expect(totals(r)).toEqual({ reads: 5, writes: 1 });
    const recent = r[1];
    expect(recent).toMatchObject({ reads: 2, writes: 1 });
  });

  it('counts ONLY read and write events', async () => {
    await seed({ count: 1, type: 'read', at: daysAgo(1), userId: member.id });
    await seed({ count: 5, type: 'action-run', at: daysAgo(1), userId: member.id });

    const r = await Q.usageActivity(null, {}, asMember());
    expect(totals(r)).toEqual({ reads: 1, writes: 0 });
  });

  it('omits empty buckets entirely (the portal zero-fills)', async () => {
    await seed({ count: 1, type: 'read', at: daysAgo(1), userId: member.id });
    await seed({ count: 1, type: 'read', at: daysAgo(5), userId: member.id });

    // 7-day default window spans 7 days but only 2 have activity.
    const r = await Q.usageActivity(null, {}, asMember());
    expect(r).toHaveLength(2);
  });

  it('respects the time zone when deciding which day a bucket belongs to', async () => {
    // 2026-07-20T02:00Z is still 2026-07-19 in New York (UTC-4 in July). The
    // same instant must land in different buckets under different zones — the
    // case a naive date_trunc without AT TIME ZONE gets wrong.
    const at = new Date('2026-07-20T02:00:00.000Z');
    await seed({ count: 1, type: 'read', at, userId: member.id });

    const args = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };
    const utc = await Q.usageActivity(null, { ...args, timeZone: 'UTC' }, asMember());
    const ny = await Q.usageActivity(null, { ...args, timeZone: 'America/New_York' }, asMember());

    expect(utc).toHaveLength(1);
    expect(utc[0].date).toBe('2026-07-20');
    expect(ny).toHaveLength(1);
    expect(ny[0].date).toBe('2026-07-19');
  });

  it('truncates to the containing week and month for WEEK / MONTH', async () => {
    // Two days in the same ISO week (Postgres weeks start Monday) and month.
    await seed({ count: 1, type: 'read', at: new Date('2026-07-14T12:00:00Z'), userId: member.id });
    await seed({ count: 1, type: 'read', at: new Date('2026-07-16T12:00:00Z'), userId: member.id });
    const args = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };

    const byDay = await Q.usageActivity(null, { ...args, bucket: 'DAY' }, asMember());
    expect(byDay).toHaveLength(2);

    const byWeek = await Q.usageActivity(null, { ...args, bucket: 'WEEK' }, asMember());
    expect(byWeek).toHaveLength(1);
    expect(byWeek[0]).toMatchObject({ date: '2026-07-13', reads: 2 }); // Monday

    const byMonth = await Q.usageActivity(null, { ...args, bucket: 'MONTH' }, asMember());
    expect(byMonth).toHaveLength(1);
    expect(byMonth[0]).toMatchObject({ date: '2026-07-01', reads: 2 });
  });
});

describe('usageActivity — window semantics', () => {
  it('defaults to the last 7 days, excluding older events', async () => {
    await seed({ count: 1, type: 'read', at: daysAgo(2), userId: member.id });
    await seed({ count: 9, type: 'read', at: daysAgo(30), userId: member.id });

    const r = await Q.usageActivity(null, {}, asMember());
    expect(totals(r).reads).toBe(1);
  });

  it('treats `from` as inclusive and `to` as exclusive', async () => {
    const from = new Date('2026-07-10T00:00:00.000Z');
    const to = new Date('2026-07-12T00:00:00.000Z');
    await seed({ count: 1, type: 'read', at: from, userId: member.id }); // on `from` — counted
    await seed({ count: 1, type: 'read', at: to, userId: member.id }); // on `to` — excluded

    const r = await Q.usageActivity(
      null,
      { from: from.toISOString(), to: to.toISOString() },
      asMember(),
    );
    expect(totals(r).reads).toBe(1);
    expect(r[0].date).toBe('2026-07-10');
  });

  it('rejects an invalid time zone with BAD_USER_INPUT', async () => {
    await expect(
      Q.usageActivity(null, { timeZone: 'Mars/Olympus_Mons' }, asMember()),
    ).rejects.toThrow(/Unknown IANA time zone/);
  });

  it('rejects an inverted or unparseable window with BAD_USER_INPUT', async () => {
    await expect(
      Q.usageActivity(
        null,
        { from: '2026-07-10T00:00:00Z', to: '2026-07-01T00:00:00Z' },
        asMember(),
      ),
    ).rejects.toThrow(/Invalid window/);
    await expect(Q.usageActivity(null, { from: 'not-a-date' }, asMember())).rejects.toThrow(
      /Invalid window/,
    );
  });

  it('clamps an over-long window by moving `from` forward, keeping the recent end', async () => {
    await seed({ count: 1, type: 'read', at: daysAgo(2), userId: member.id });
    await seed({ count: 1, type: 'read', at: daysAgo(400), userId: member.id });

    const r = await Q.usageActivity(
      null,
      { from: daysAgo(5000).toISOString() },
      asMember(),
    );
    // 400 days back falls outside the 366-day clamp; the recent one survives.
    expect(totals(r).reads).toBe(1);
  });
});

describe('usageActivity — scoping and auth', () => {
  it('default scope counts only the caller OWN events', async () => {
    await seed({ count: 2, type: 'read', at: daysAgo(1), userId: member.id });
    await seed({ count: 7, type: 'read', at: daysAgo(1), userId: outsider.id });

    expect(totals(await Q.usageActivity(null, {}, asMember())).reads).toBe(2);
    expect(totals(await Q.usageActivity(null, {}, asOutsider())).reads).toBe(7);
  });

  it('default scope spans every memory the caller touched, and unattributed events', async () => {
    await seed({ count: 1, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    await seed({ count: 1, type: 'read', at: daysAgo(1), userId: member.id }); // no memory

    expect(totals(await Q.usageActivity(null, {}, asMember())).reads).toBe(2);
  });

  it('memoryRefs scope counts ALL users of that memory', async () => {
    await seed({ count: 2, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    await seed({ count: 3, type: 'read', at: daysAgo(1), userId: outsider.id, memoryId: memA.id });

    const r = await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember());
    expect(totals(r).reads).toBe(5);
  });

  it('memoryRefs scope excludes other memories', async () => {
    await seed({ count: 2, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    await seed({ count: 9, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memB.id });

    const r = await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember());
    expect(totals(r).reads).toBe(2);
  });

  it('accepts a memory URN as well as a PK', async () => {
    await seed({ count: 2, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    const r = await Q.usageActivity(null, { memoryRefs: [`hrn:memory:${memA.urn}`] }, asMember());
    expect(totals(r).reads).toBe(2);
  });

  it('returns [] for a memory the caller cannot read — same as one that does not exist', async () => {
    await seed({ count: 5, type: 'read', at: daysAgo(1), userId: outsider.id, memoryId: memB.id });

    // memB belongs to orgB; `member` is not a member of it.
    expect(await Q.usageActivity(null, { memoryRefs: [memB.id] }, asMember())).toEqual([]);
    // A PK that resolves to nothing is indistinguishable.
    expect(await Q.usageActivity(null, { memoryRefs: [generateId()] }, asMember())).toEqual([]);
  });

  it('returns [] for an App-key caller (no user, so no own activity)', async () => {
    await seed({ count: 3, type: 'read', at: daysAgo(1), userId: member.id });
    expect(await Q.usageActivity(null, {}, asAppKey())).toEqual([]);
  });
});

describe('usageActivity — multi-memory union (#805)', () => {
  it('counts the UNION of several memories — exactly the sum of their separate scopes', async () => {
    await seed({ count: 2, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    await seed({ count: 1, type: 'write', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    await seed({ count: 3, type: 'read', at: daysAgo(1), userId: outsider.id, memoryId: memA2.id });
    // A memory NOT in the list must not contribute.
    await seed({ count: 9, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memB.id });

    const a = totals(await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember()));
    const a2 = totals(await Q.usageActivity(null, { memoryRefs: [memA2.id] }, asMember()));
    const union = totals(await Q.usageActivity(null, { memoryRefs: [memA.id, memA2.id] }, asMember()));

    // No double-counting: every event carries exactly one memory_id, so the
    // union is the sum — the property the `IN` predicate has to preserve.
    expect(union).toEqual({ reads: a.reads + a2.reads, writes: a.writes + a2.writes });
    expect(union).toEqual({ reads: 5, writes: 1 });
  });

  it('merges the two memories into ONE series per bucket, not two rows per day', async () => {
    const at = new Date('2026-07-15T12:00:00.000Z');
    await seed({ count: 2, type: 'read', at, userId: member.id, memoryId: memA.id });
    await seed({ count: 3, type: 'read', at, userId: member.id, memoryId: memA2.id });

    const r = await Q.usageActivity(
      null,
      {
        memoryRefs: [memA.id, memA2.id],
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      },
      asMember(),
    );
    expect(r).toEqual([{ date: '2026-07-15', reads: 5, writes: 0 }]);
  });

  it('naming one memory twice (by PK and by URN) does not double-count it', async () => {
    await seed({ count: 4, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    const r = await Q.usageActivity(
      null,
      { memoryRefs: [memA.id, `hrn:memory:${memA.urn}`, memA.id] },
      asMember(),
    );
    expect(totals(r).reads).toBe(4);
  });

  it('silently DROPS an unreadable or unknown ref and still counts the readable ones', async () => {
    await seed({ count: 2, type: 'read', at: daysAgo(1), userId: member.id, memoryId: memA.id });
    await seed({ count: 7, type: 'read', at: daysAgo(1), userId: outsider.id, memoryId: memB.id });

    // memB is another org's; the third ref never existed. Both vanish from the
    // union rather than failing the query, so the caller can't use the outcome
    // to tell "foreign" from "nonexistent" from "readable but empty".
    const r = await Q.usageActivity(
      null,
      { memoryRefs: [memA.id, memB.id, generateId()] },
      asMember(),
    );
    expect(totals(r).reads).toBe(2);
    // Identical answer when the unreadable refs are simply absent.
    const readableOnly = await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember());
    expect(r).toEqual(readableOnly);
  });

  it('returns [] when EVERY ref drops out — never a fallback to own activity', async () => {
    // The caller has plenty of own activity; if the empty union silently fell
    // back to the user scope, this would report it as the memories' activity.
    await seed({ count: 5, type: 'read', at: daysAgo(1), userId: member.id });

    expect(await Q.usageActivity(null, { memoryRefs: [memB.id] }, asMember())).toEqual([]);
    expect(await Q.usageActivity(null, { memoryRefs: [generateId()] }, asMember())).toEqual([]);
    // An explicitly EMPTY list is the empty union for the same reason.
    expect(await Q.usageActivity(null, { memoryRefs: [] }, asMember())).toEqual([]);
    // Sanity: the own-activity scope (no memoryRefs at all) does see them.
    expect(totals(await Q.usageActivity(null, {}, asMember())).reads).toBe(5);
  });

  it('rejects a list longer than the 20-ref cap with BAD_USER_INPUT', async () => {
    const refs = Array.from({ length: 21 }, () => generateId());
    await expect(Q.usageActivity(null, { memoryRefs: refs }, asMember())).rejects.toThrow(
      /Too many memoryRefs/,
    );
    // Exactly at the cap is fine (all unknown ⇒ empty, but no error).
    expect(await Q.usageActivity(null, { memoryRefs: refs.slice(0, 20) }, asMember())).toEqual([]);
  });

  it('still throws on a MALFORMED ref — a shape error discloses nothing', async () => {
    // Unknown-vs-unreadable is silenced; a ref that cannot be parsed at all is
    // caller error and stays loud (the widget provider catches it per-placement).
    await expect(
      Q.usageActivity(null, { memoryRefs: [memA.id, 'hrn:memory:'] }, asMember()),
    ).rejects.toThrow();
  });
});

describe('usageActivity — events recorded through the API surface it (PR #799 review)', () => {
  it('counts a read recorded via the recordUsage mutation in the recorder own activity', async () => {
    // End-to-end through the WRITE path rather than a seeded row: recordUsage
    // set only the audit `createdBy` string and no `userId`, so a signed-in
    // user's events were invisible to the own-activity scope. Seeding rows
    // directly could never catch that.
    const node = await db.node.create({
      data: { id: generateId(), memoryId: memA.id, loc: 'recorded', name: 'recorded' },
    });

    await M.recordUsage(null, { event: { type: 'read', nodeLoc: 'recorded' } }, asMember());

    const written = await db.usageEvent.findFirstOrThrow({ where: { nodeLoc: 'recorded' } });
    expect(written.userId).toBe(member.id);
    expect(written.memoryId).toBe(memA.id);
    expect(written.nodeId).toBe(node.id);

    // Explicit `to` in the near future rather than the default "now". The
    // default window ends at the instant the resolver runs and `to` is
    // EXCLUSIVE, while created_at is timestamp(3) — so an event written in the
    // same millisecond as the read falls just outside its own window. That made
    // this the one flaky test in the file (~50% locally); the flake is in the
    // test's timing, not the aggregation, so widen the window rather than
    // loosen the assertion.
    const soon = { to: new Date(Date.now() + 60_000).toISOString() };
    // Visible in BOTH scopes without any direct row seeding.
    expect(totals(await Q.usageActivity(null, soon, asMember())).reads).toBe(1);
    expect(
      totals(await Q.usageActivity(null, { ...soon, memoryRefs: [memA.id] }, asMember())).reads,
    ).toBe(1);
    // And not in another user's own activity.
    expect(totals(await Q.usageActivity(null, soon, asOutsider())).reads).toBe(0);
  });
});

describe('usageActivity — attribution survives node deletion (#796)', () => {
  it('still counts a memory event after its node is deleted', async () => {
    const node = await db.node.create({
      data: { id: generateId(), memoryId: memA.id, loc: 'doomed', name: 'doomed' },
    });
    await db.usageEvent.create({
      data: {
        id: generateId(),
        type: 'read',
        nodeLoc: 'doomed',
        nodeId: node.id,
        memoryId: memA.id,
        userId: member.id,
        createdAt: daysAgo(1),
      },
    });

    expect(totals(await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember())).reads).toBe(1);

    // Hard-delete the node: `nodeId` goes NULL (SetNull), which used to erase
    // the event from every memory-scoped surface. The memoryId column is the
    // whole point — the history has to outlive the node.
    await db.node.delete({ where: { id: node.id } });
    const orphaned = await db.usageEvent.findFirst({ where: { nodeLoc: 'doomed' } });
    expect(orphaned?.nodeId).toBeNull();
    expect(orphaned?.memoryId).toBe(memA.id);

    expect(totals(await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember())).reads).toBe(1);
    // memoryUsageSummary moved onto the same column, so it agrees.
    const summary = await Q.memoryUsageSummary(null, { memoryRef: memA.id }, asMember());
    expect(summary).toEqual([{ nodeLoc: 'doomed', type: 'read', count: 1 }]);
  });
});
