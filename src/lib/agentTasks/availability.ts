/**
 * #1706 — availability for work (cor:agt:060:01–:03, :07).
 *
 * A worker is available for work unless its own record (`worker_availability`,
 * cor:agt:060:02) or its model family's record in the App
 * (`model_family_availability`, cor:agt:060:03) says unavailable. That predicate is
 * `isAvailableForWork`, the ONE derivation T3's matcher and T4's roster share;
 * a second copy would drift (the cor:agt:020:11 lesson).
 *
 * Interim readings, until Holger rules (each labelled where it applies):
 *   - an `until` that has passed reads as AVAILABLE, and the row is kept for
 *     history (cor:agt:060:02 open question);
 *   - a `stalled` record stops counting once the worker acts again
 *     (cor:agt:060:07, Proposed). The predicate applies that at read time, so
 *     a matcher never waits a minute for the evaluator; the evaluator also
 *     writes the change down (`clearStalledMarks`), so the event stream says
 *     when the worker came back.
 *
 * A worker's model family is T3's (`Worker.family`, set at session start).
 * Until then the caller passes the family it knows, or null.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { appendAvailabilityEvent, PLATFORM_ACTOR, type AvailabilityReason } from './events.js';

export const AVAILABILITY_REASONS: readonly AvailabilityReason[] = ['stalled', 'out-of-tokens', 'host-down', 'other'];

/** A model family is a lowercase token (cor:agt:060:04), as chk_model_family_availability_shape pins it. */
export const FAMILY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The fields of an availability record the predicate reads. */
export type AvailabilityRecord = {
  state: string;
  reason: string | null;
  until: Date | null;
  setAt: Date;
} | null;

/**
 * Does this record make its subject unavailable for work right now? No record,
 * an `available` record, a lapsed `until`, and a `stalled` mark the worker has
 * since acted past all read as no.
 */
export function recordInEffect(record: AvailabilityRecord, now: Date, lastActivityAt: Date | null = null): boolean {
  if (!record || record.state !== 'unavailable') return false;
  // #1706 interim (cor:agt:060:02 open question): a lapsed `until` reads as available.
  if (record.until && record.until.getTime() <= now.getTime()) return false;
  // cor:agt:060:07 (Proposed): the worker's next activity ends a stall mark.
  if (record.reason === 'stalled' && lastActivityAt && lastActivityAt.getTime() > record.setAt.getTime()) return false;
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
 * none (T3 supplies it).
 */
export async function loadAvailableForWork(
  db: PrismaClient | Prisma.TransactionClient,
  workers: { id: string; appId: string; family: string | null }[],
  now = new Date(),
): Promise<Map<string, boolean>> {
  if (workers.length === 0) return new Map();
  const ids = workers.map((w) => w.id);
  const [own, activity, families] = await Promise.all([
    db.workerAvailability.findMany({ where: { workerId: { in: ids } } }),
    loadWorkersActivity({ db } as unknown as Context, ids, now),
    workers.some((w) => w.family)
      ? db.modelFamilyAvailability.findMany({
          where: {
            OR: workers
              .filter((w) => w.family)
              .map((w) => ({ appId: w.appId, family: w.family as string })),
          },
        })
      : Promise.resolve([]),
  ]);
  const ownBy = new Map(own.map((r) => [r.workerId, r]));
  const familyBy = new Map(families.map((r) => [`${r.appId}\u0000${r.family}`, r]));
  return new Map(workers.map((w) => [
    w.id,
    isAvailableForWork({
      worker: ownBy.get(w.id) ?? null,
      family: w.family ? familyBy.get(`${w.appId}\u0000${w.family}`) ?? null : null,
      lastActivityAt: activity.get(w.id)?.lastActiveAt ?? null,
    }, now),
  ]));
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
        setByUserId: null, setByWorkerId: null, setByAgentId: null,
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
            setByUserId: null, setByWorkerId: null, setByAgentId: null,
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
