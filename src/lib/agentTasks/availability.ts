/**
 * #1706 — availability for work (cor:agt:060:01–:03, :07).
 *
 * A worker is available for work unless its own record (`worker_availability`,
 * cor:agt:060:02) or its model family's record in the App
 * (`model_family_availability`, cor:agt:060:03) says unavailable. That predicate is
 * `isAvailableForWork`, the ONE derivation T3's matcher and T4's roster share;
 * a second copy would drift (the cor:agt:020:11 lesson).
 *
 * An `until` that has passed reads as AVAILABLE at once (cor:agt:060:02), and
 * the matcher's sweep writes the lapse down (`recordLapsedAvailability`, #1766):
 * the record becomes `available`, set by `lapse`, with exactly one
 * `availability.changed` event.
 *
 * Interim reading, until Holger rules:
 *   - a `stalled` record stops counting once the worker acts again
 *     (cor:agt:060:07, Proposed). The predicate applies that at read time, so
 *     a matcher never waits a minute for the evaluator; the evaluator also
 *     writes the change down (`clearStalledMarks`), so the event stream says
 *     when the worker came back.
 *
 * A worker's model family is its live session's, or one a live host can launch
 * it as (#1707, src/lib/agentTasks/family.ts); callers pass the family or
 * families they know.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { appendAvailabilityEvent, PLATFORM_ACTOR, type AvailabilityReason } from './events.js';
import { familySpellings, normalizeFamily } from './family.js';

export const AVAILABILITY_REASONS: readonly AvailabilityReason[] = ['stalled', 'out-of-tokens', 'host-down', 'other'];

/** A model family is a lowercase token (cor:agt:060:04), as chk_model_family_availability_shape pins it. */
export { FAMILY_PATTERN } from './family.js';

/** The fields of an availability record the predicate reads. */
export type AvailabilityRecord = {
  state: string;
  reason: string | null;
  until: Date | null;
  setAt: Date;
  /** #2162: a `resetting` mark's stop instant; activity after it ends the mark. Absent reads as null. */
  clearsOnActivityAfter?: Date | null;
} | null;

/**
 * Does this record make its subject unavailable for work right now? No record,
 * an `available` record, a lapsed `until`, and a `stalled` mark the worker has
 * since acted past all read as no.
 */
export function recordInEffect(record: AvailabilityRecord, now: Date, lastActivityAt: Date | null = null): boolean {
  if (!record || record.state !== 'unavailable') return false;
  // cor:agt:060:02: a passed `until` reads as available, before the sweep records the lapse (#1766).
  if (record.until && record.until.getTime() <= now.getTime()) return false;
  // cor:agt:060:07 (Proposed): the worker's next activity ends a stall mark.
  if (record.reason === 'stalled' && lastActivityAt && lastActivityAt.getTime() > record.setAt.getTime()) return false;
  // #2162 (cor:agt:050:27): the relaunched agent's first activity ends a `resetting` mark. Only activity AFTER the host
  // reported the old agent stopped counts, never after the mark was set: the old agent's own last calls, between the
  // claim and the stop, must not lift it.
  if (record.reason === 'resetting' && record.clearsOnActivityAfter && lastActivityAt
      && lastActivityAt.getTime() > record.clearsOnActivityAfter.getTime()) return false;
  return true;
}

/**
 * cor:agt:060:01 — available for work: neither the worker's own record nor its
 * model family's record in the App says unavailable.
 */
export function isAvailableForWork(
  args: { worker: AvailabilityRecord; family: AvailabilityRecord; lastActivityAt: Date | null },
  now: Date,
): boolean {
  return !recordInEffect(args.worker, now, args.lastActivityAt) && !recordInEffect(args.family, now);
}

/**
 * Available for work, for several workers of possibly several Apps, in three
 * queries. `family` is the worker's current model family, or null when it has
 * none.
 */
export async function loadAvailableForWork(
  db: PrismaClient | Prisma.TransactionClient,
  workers: { id: string; appId: string; family: string | null }[],
  now = new Date(),
): Promise<Map<string, boolean>> {
  const by = await loadAvailabilityByFamily(
    db, workers.map((w) => ({ id: w.id, appId: w.appId, families: w.family ? [w.family] : [] })), now,
  );
  return new Map(workers.map((w) => {
    const a = by.get(w.id) as WorkerAvailabilityView;
    return [w.id, !a.ownInEffect && (w.family ? a.familyAvailable.get(w.family) === true : true)];
  }));
}

/** One worker's availability inputs, resolved: its own record, and each family it could run as. */
export type WorkerAvailabilityView = {
  /** The worker's own record (cor:agt:060:02), when it makes the worker unavailable now. */
  ownInEffect: boolean;
  own: AvailabilityRecord;
  /** Per family: whether the App's record for it (cor:agt:060:03) leaves it available now. */
  familyAvailable: Map<string, boolean>;
};

/**
 * #1707 — availability for work per (worker, family): an unbound worker may be
 * launchable as several families (cor:agt:060:04, :05), and a family's own
 * availability decides which of them count. The same three queries and the
 * same `recordInEffect` as `loadAvailableForWork`; cor:agt:060:01 is
 * `!ownInEffect && familyAvailable.get(family)`.
 */
export async function loadAvailabilityByFamily(
  db: PrismaClient | Prisma.TransactionClient,
  workers: { id: string; appId: string; families: string[] }[],
  now = new Date(),
): Promise<Map<string, WorkerAvailabilityView>> {
  if (workers.length === 0) return new Map();
  const ids = workers.map((w) => w.id);
  const pairs = workers.flatMap((w) => w.families.flatMap((family) => familySpellings(family).map((f) => ({ appId: w.appId, family: f }))));
  const [own, activity, families] = await Promise.all([
    db.workerAvailability.findMany({ where: { workerId: { in: ids } } }),
    loadWorkersActivity({ db } as unknown as Context, ids, now),
    pairs.length ? db.modelFamilyAvailability.findMany({ where: { OR: pairs } }) : Promise.resolve([]),
  ]);
  const ownBy = new Map(own.map((r) => [r.workerId, r]));
  // Legacy aliases may coexist: an effective refusal under either spelling
  // still applies. Never make an old unavailable mark disappear on rollout.
  const unavailable = new Set(families.filter((r) => recordInEffect(r, now)).map((r) => `${r.appId}\u0000${normalizeFamily(r.family)}`));
  return new Map(workers.map((w) => {
    const record = ownBy.get(w.id) ?? null;
    return [w.id, {
      own: record,
      ownInEffect: !isAvailableForWork({ worker: record, family: null, lastActivityAt: activity.get(w.id)?.lastActiveAt ?? null }, now),
      familyAvailable: new Map(w.families.map((f) => [f, !unavailable.has(`${w.appId}\u0000${normalizeFamily(f)}`)])),
    }];
  }));
}

/**
 * cor:agt:060:07 — a not-started or no-progress alarm marks its worker
 * assignee unavailable, reason `stalled`. Runs in the alarm's transaction.
 *
 * It never overwrites a record that is in effect for another reason: a worker
 * already out of tokens until 18:00 stays out of tokens, rather than becoming
 * "stalled" and coming back at its next call. An `available` or lapsed record
 * is replaced, with an `availability.changed` event. A `stalled` record is
 * refreshed — a new stall restarts what the next activity must postdate — and
 * that writes no event, since nothing a reader sees changed. Returns whether
 * the worker is marked stalled by this alarm.
 */
export async function markStalled(
  tx: Prisma.TransactionClient,
  args: { workerId: string; appId: string; alarmEventId: string; now: Date },
): Promise<boolean> {
  const now = toNaiveUtc(args.now);
  const inserted = await tx.$queryRaw<{ workerId: string }[]>`
    INSERT INTO worker_availability (worker_id, state, reason, until, set_at, set_by)
    VALUES (${args.workerId}, 'unavailable', 'stalled', NULL, ${now}::timestamp, 'stall-rule')
    ON CONFLICT (worker_id) DO NOTHING
    RETURNING worker_id AS "workerId"`;
  let changed = inserted.length > 0;
  if (!changed) {
    const [cur] = await tx.$queryRaw<{ state: string; reason: string | null; until: Date | null; setAt: Date }[]>`
      SELECT state, reason, until, set_at AS "setAt" FROM worker_availability
      WHERE worker_id = ${args.workerId} FOR UPDATE`;
    const stalled = cur.state === 'unavailable' && cur.reason === 'stalled';
    if (!stalled && recordInEffect(cur, args.now)) return false;
    await tx.workerAvailability.update({
      where: { workerId: args.workerId },
      data: {
        state: 'unavailable', reason: 'stalled', until: null, setAt: args.now, setBy: 'stall-rule',
        setByUserId: null, setByWorkerId: null, setByAgentId: null, setByHostId: null, clearsOnActivityAfter: null,
      },
    });
    changed = !stalled;
  }
  if (changed) {
    await appendAvailabilityEvent(tx, {
      appId: args.appId,
      actor: PLATFORM_ACTOR,
      event: {
        kind: 'worker', workerId: args.workerId, state: 'unavailable', reason: 'stalled', until: null,
        setBy: 'stall-rule', alarmEventId: args.alarmEventId,
      },
      createdAt: args.now,
    });
  }
  return true;
}

/**
 * cor:agt:060:07 (Proposed) — write down that a stalled worker acted again:
 * every `stalled` record whose worker has activity after it was set becomes
 * `available`, with an `availability.changed` event. The predicate already
 * reads such a record as available; this makes the change a recorded fact.
 *
 * Each clearance is a conditional update on the record as read (state,
 * reason and set_at unchanged), so a concurrent pass, or a person setting the
 * record in between, wins cleanly. Returns how many it cleared.
 */
export async function clearStalledMarks(db: PrismaClient, now: Date): Promise<number> {
  let cleared = 0;
  // Page through EVERY stalled record by a stable cursor (#1720 review, Diego
  // P3): a first page of workers who stay idle must not hide a later worker
  // who has acted again.
  let after: string | null = null;
  for (;;) {
    const stalled: { workerId: string; setAt: Date; worker: { appId: string } }[] = await db.workerAvailability.findMany({
      where: { state: 'unavailable', reason: 'stalled', ...(after ? { workerId: { gt: after } } : {}) },
      select: { workerId: true, setAt: true, worker: { select: { appId: true } } },
      orderBy: { workerId: 'asc' },
      take: CLEAR_PAGE,
    });
    if (stalled.length === 0) break;
    after = stalled[stalled.length - 1].workerId;
    const activity = await loadWorkersActivity({ db } as unknown as Context, stalled.map((r) => r.workerId), now);
    for (const r of stalled) {
      const at = activity.get(r.workerId)?.lastActiveAt;
      if (!at || at.getTime() <= r.setAt.getTime()) continue;
      const done = await db.$transaction(async (tx) => {
        const n = await tx.workerAvailability.updateMany({
          where: { workerId: r.workerId, state: 'unavailable', reason: 'stalled', setAt: r.setAt },
          data: {
            state: 'available', reason: null, until: null, setAt: now, setBy: 'stall-rule',
            setByUserId: null, setByWorkerId: null, setByAgentId: null, setByHostId: null,
          },
        });
        if (n.count === 0) return false;
        await appendAvailabilityEvent(tx, {
          appId: r.worker.appId,
          actor: PLATFORM_ACTOR,
          event: { kind: 'worker', workerId: r.workerId, state: 'available', reason: null, until: null, setBy: 'stall-rule' },
          createdAt: now,
        });
        return true;
      });
      if (done) cleared += 1;
    }
    if (stalled.length < CLEAR_PAGE) break;
  }
  return cleared;
}

/** Stalled records per page of `clearStalledMarks`. */
const CLEAR_PAGE = 500;

/**
 * #1766 (cor:agt:060:02) — write down every worker availability record whose
 * `until` has passed: the record becomes `available`, set by `lapse` at the
 * instant it lapsed, and exactly one `availability.changed` event records it
 * (`setBy: 'lapse'`, `lapsedAt` = the passed `until`, written at `now` by the
 * platform). The predicate already reads such a record as available; this
 * makes the change a recorded fact, as `clearStalledMarks` does for a stall.
 *
 * Exactly once: each rewrite is a conditional update on the record as read
 * (unavailable, same `until`, same `setAt`), so a second pass, a second
 * instance, or a person re-marking the worker in between finds no row to
 * change and writes no event. A record with no `until` (a stall mark among
 * them) never lapses. Model-family records (cor:agt:060:03) are not swept
 * here. Returns how many it recorded.
 */
export async function recordLapsedAvailability(db: PrismaClient, now: Date): Promise<number> {
  let recorded = 0;
  // A stable cursor: a record lost to a concurrent pass stays out of the
  // predicate, but one re-marked in between could still match it.
  let after: string | null = null;
  for (;;) {
    const lapsed = await readLapsed(db, now, after);
    if (lapsed.length === 0) break;
    after = lapsed[lapsed.length - 1].workerId;
    for (const r of lapsed) {
      if (await recordLapse(db, r, now)) recorded += 1;
    }
    if (lapsed.length < CLEAR_PAGE) break;
  }
  return recorded;
}

/** A worker availability record whose `until` has passed, as the sweep read it. */
type LapsedRecord = { workerId: string; until: Date; setAt: Date; appId: string };

/** One page of records whose `until` has passed, after the `after` cursor. */
async function readLapsed(db: PrismaClient, now: Date, after: string | null): Promise<LapsedRecord[]> {
  const rows = await db.workerAvailability.findMany({
    where: { state: 'unavailable', until: { lte: now }, ...(after ? { workerId: { gt: after } } : {}) },
    select: { workerId: true, until: true, setAt: true, worker: { select: { appId: true } } },
    orderBy: { workerId: 'asc' },
    take: CLEAR_PAGE,
  });
  return rows.map((r) => ({ workerId: r.workerId, until: r.until as Date, setAt: r.setAt, appId: r.worker.appId }));
}

/**
 * Record one lapse: rewrite the record only if it is still exactly as read
 * (the guarded update), and write its event in the same transaction. Returns
 * whether this call recorded it.
 */
async function recordLapse(db: PrismaClient, r: LapsedRecord, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const n = await tx.workerAvailability.updateMany({
      where: { workerId: r.workerId, state: 'unavailable', until: r.until, setAt: r.setAt },
      data: {
        state: 'available', reason: null, until: null, setAt: r.until, setBy: 'lapse',
        setByUserId: null, setByWorkerId: null, setByAgentId: null, setByHostId: null, clearsOnActivityAfter: null,
      },
    });
    if (n.count === 0) return false;
    await appendAvailabilityEvent(tx, {
      appId: r.appId,
      actor: PLATFORM_ACTOR,
      event: { kind: 'worker', workerId: r.workerId, state: 'available', reason: null, until: null, setBy: 'lapse', lapsedAt: r.until },
      createdAt: now,
    });
    return true;
  });
}

/** Test seam (#1851 review): the sweep's read and its per-record write, so a test can act between them. */
export const __lapseTesting = { readLapsed, recordLapse };
