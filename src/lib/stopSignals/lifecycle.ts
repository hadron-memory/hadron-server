/**
 * #2022 (S6) — setting, lifting and expiring stop signals, and keeping the coverage ledger (cor:agt:090:01, :04, :05).
 *
 * Every function here runs inside the caller's transaction, which already holds the App's stop fence EXCLUSIVE
 * (`lockStopFence`) after its authority anchors; who may call them is the resolver's to decide (090:06). They sample no
 * clock of their own: `now` is the caller's, taken after its lock waits.
 *
 * `reconcileStopCoverage` brings the recorded state up to `now`: it records every expiry that has passed (an expiry is
 * already in effect at `until`; recording it is bookkeeping), then diffs live coverage against the open intervals of
 * the ledger, closing what no longer covers and opening what newly does, and sends each worker one notice for each
 * change of what applies to it (R95):
 *
 * - what applies to it changed (Vera's fit: notices follow the worker's EFFECTIVE level, CONFORMS to R95, #2166
 *   6302988619): it came under a `pause` or `halt` (free → pause, pause → halt; it joined the team or the host listed
 *   it), or the `halt` ended under a `pause` (the `pause` notice again, Vera's receipt §3, Proposed): that level's
 *   notice, interrupting only for a `halt`. A second signal at the level already in force, or a weaker one under it,
 *   sends none;
 * - nothing that stops its time covers it any more (it left the coverage, or the last such signal ended): one resume.
 *
 * `pause-dispatch` tells its coordinators when it is set and when it ends, and the workers it covers nothing
 * (D-2026-10-16-003); moving in or out of its coverage sends them nothing. While it is live its coordinators are
 * recomputed on every reconcile and the change is told (V20, #3045, `reconcileCoordinators`). Because the ledger is only ever written here,
 * under the exclusive fence, a second reconcile at the same state writes nothing: one transition, one notice per
 * recipient, whichever of a lift, an expiry sweep or a topology change gets there first.
 */

import { Prisma } from '../../generated/prisma/index.js';
import { appManagerUserIds } from '../auth/appManagement.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import {
  SIGNAL_COLUMNS, coveringSignals, levelRank, liveSql, stopsTime,
  type StopLevel, type StopScope, type StopSignal,
} from './state.js';
import {
  appendStopEndEvent, appendStopNotice, appendStopNoticeWithdrawn, appendStopSetEvent, pauseDispatchRecipients,
  STOP_NOTICE_EVENT, STOP_NOTICE_WITHDRAWN_EVENT,
  type StopActor,
} from './notices.js';

type Tx = Prisma.TransactionClient;

export type ReconcileResult = { entered: number; left: number; notices: number; expired: string[] };

/** The signal whose notice a worker gets for `level`: the earliest-set live one at that level (stable). */
function noticeSignal(list: StopSignal[], level: StopLevel): StopSignal {
  return list.filter((s) => s.level === level).sort((a, b) => a.setAt.getTime() - b.setAt.getTime() || a.id.localeCompare(b.id))[0]!;
}

/** The strongest time-stopping level among `list`, or null. */
function timeLevel(list: Array<Pick<StopSignal, 'level'>>): StopLevel | null {
  let best: StopLevel | null = null;
  for (const s of list) if (stopsTime(s.level) && (best === null || levelRank(s.level) > levelRank(best))) best = s.level;
  return best;
}

/** The App's live workers and their reporting lines, and its managers: the coordinator inputs. */
async function coordinatorInputs(tx: Tx, appId: string) {
  const [workers, app] = await Promise.all([
    tx.worker.findMany({ where: { appId, retiredAt: null }, select: { id: true, reportsToWorkerId: true }, orderBy: { id: 'asc' } }),
    tx.app.findUniqueOrThrow({ where: { id: appId }, select: { id: true, organizationId: true, ownerUserId: true } }),
  ]);
  return { workers, managers: await appManagerUserIds(tx, app) };
}

/**
 * Tell a `pause-dispatch`'s coordinators (090:04): at its end (`resume`), and at its set (`stop`). At set the reconcile
 * that just ran already told the worker coordinators (the same step that tells a coordinator who joins later, V20), so
 * the set passes `only: 'people'`: the managers' fallback, which has no worker lane and is not tracked afterwards.
 */
async function notifyCoordinators(
  tx: Tx, s: StopSignal, covered: ReadonlySet<string>, notice: 'stop' | 'resume', at: Date, only: 'all' | 'people' = 'all',
): Promise<number> {
  const { workers, managers } = await coordinatorInputs(tx, s.appId);
  const recipients = pauseDispatchRecipients(covered, workers, managers).filter((r) => only === 'all' || 'userId' in r);
  for (const recipient of recipients) {
    await appendStopNotice(tx, { appId: s.appId, recipient, signalId: s.id, level: s.level, notice, at });
  }
  return recipients.length;
}

/** The workers a signal's open ledger intervals name: who it covered, as last recorded. */
async function openCoverageOf(tx: Tx, signalId: string): Promise<Set<string>> {
  const rows = await tx.teamStopCoverage.findMany({ where: { signalId, leftAt: null }, select: { workerId: true } });
  return new Set(rows.map((r) => r.workerId));
}

/**
 * Bring the App's recorded stop state up to `now` (see the file header). The caller holds the stop fence exclusive.
 * Returns what changed; a reconcile at an unchanged state writes nothing.
 */
export async function reconcileStopCoverage(tx: Tx, appId: string, now: Date): Promise<ReconcileResult> {
  const nowNaive = toNaiveUtc(now);
  let notices = 0;
  // Nothing to do in an App with no unended signal and no open interval (every host poll and bind passes here).
  const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT (SELECT count(*) FROM team_stop_signals s WHERE s.app_id = ${appId} AND s.ended_at IS NULL)
         + (SELECT count(*) FROM team_stop_coverage c WHERE c.app_id = ${appId} AND c.left_at IS NULL) AS n`);
  if (Number(n) === 0) return { entered: 0, left: 0, notices: 0, expired: [] };

  // 1. Record every expiry that has passed (090:05), at its until: the signal ended then, whenever the sweep came.
  const expiredRows = await tx.$queryRaw<StopSignal[]>(Prisma.sql`
    SELECT ${SIGNAL_COLUMNS} FROM team_stop_signals s
    WHERE s.app_id = ${appId} AND s.ended_at IS NULL AND s.until IS NOT NULL AND s.until <= ${nowNaive}::timestamp
    ORDER BY s.until, s.id`);
  for (const s of expiredRows) {
    const n = await tx.$executeRaw`
      UPDATE team_stop_signals SET ended_at = until, end_kind = 'expired' WHERE id = ${s.id} AND ended_at IS NULL`;
    if (n === 0) continue;
    await appendStopEndEvent(tx, s, { kind: 'expired', at: s.until as Date });
    if (s.level === 'pause-dispatch') notices += await notifyCoordinators(tx, s, await openCoverageOf(tx, s.id), 'resume', now);
  }

  // 2. Live coverage now, against the open intervals as last recorded.
  const covering = await coveringSignals(tx, appId, null, now);
  const open = await tx.$queryRaw<Array<{ id: string; signalId: string; workerId: string; level: StopLevel; endedAt: Date | null; until: Date | null }>>(Prisma.sql`
    SELECT c.id, c.signal_id AS "signalId", c.worker_id AS "workerId", s.level, s.ended_at AS "endedAt", s.until
    FROM team_stop_coverage c JOIN team_stop_signals s ON s.id = c.signal_id
    WHERE c.app_id = ${appId} AND c.left_at IS NULL
    ORDER BY c.worker_id, c.signal_id`);

  const want = new Set<string>();
  for (const [w, list] of covering) for (const s of list) want.add(`${s.id}|${w}`);
  const have = new Set(open.map((o) => `${o.signalId}|${o.workerId}`));

  // What applied to each worker before (as last recorded) and after (live now): the notice inputs.
  const before = new Map<string, Array<{ level: StopLevel; signalId: string }>>();
  for (const o of open) before.set(o.workerId, [...(before.get(o.workerId) ?? []), { level: o.level, signalId: o.signalId }]);

  // 3. Close what no longer covers, at the earliest of now and its signal's end (a late sweep never lengthens one).
  let left = 0;
  for (const o of open) {
    if (want.has(`${o.signalId}|${o.workerId}`)) continue;
    const ends = [now, o.endedAt, o.until].filter((d): d is Date => d !== null).map((d) => d.getTime());
    const at = new Date(Math.min(...ends));
    await tx.teamStopCoverage.update({ where: { id: o.id }, data: { leftAt: at } });
    left++;
  }

  // 4. Open what newly covers.
  let entered = 0;
  for (const [w, list] of covering) {
    for (const s of list) {
      if (have.has(`${s.id}|${w}`)) continue;
      await tx.teamStopCoverage.create({ data: { id: generateId(), appId, signalId: s.id, workerId: w, enteredAt: now } });
      entered++;
    }
  }

  // 5. The workers' notices (pause-dispatch tells workers nothing), per the file header.
  const workers = new Set([...before.keys(), ...covering.keys()]);
  const retired = new Set((await tx.worker.findMany({
    where: { id: { in: [...workers] }, retiredAt: { not: null } }, select: { id: true },
  })).map((r) => r.id));
  for (const w of [...workers].sort()) {
    if (retired.has(w)) continue;
    const was = timeLevel(before.get(w) ?? []);
    const nowList = covering.get(w) ?? [];
    const is = timeLevel(nowList);
    if (is === null) {
      if (was === null) continue;
      // The resume names the strongest signal that stopped it as last recorded.
      const prior = (before.get(w) ?? []).filter((x) => x.level === was).sort((a, b) => a.signalId.localeCompare(b.signalId))[0]!;
      await appendStopNotice(tx, { appId, recipient: { workerId: w }, signalId: prior.signalId, level: was as StopLevel, notice: 'resume', at: now });
      notices++;
      continue;
    }
    // Only a change of what applies is told (Vera's fit, CONFORMS to R95, #2166 6302988619): a second signal at the
    // level already in force, or a weaker one under it, changes nothing the worker does.
    if (was === is) continue;
    const x = noticeSignal(nowList, is);
    await appendStopNotice(tx, { appId, recipient: { workerId: w }, signalId: x.id, level: is, notice: 'stop', at: now });
    notices++;
  }

  // 6. A live pause-dispatch's coordinators, as they are now (V20).
  notices += await reconcileCoordinators(tx, appId, now, covering);

  return { entered, left, notices, expired: expiredRows.map((s) => s.id) };
}

/**
 * cor:agt:090:04 V20: every live `pause-dispatch`'s coordinator set is recomputed on each reconcile (so on every change
 * that can move it: a reporting line, team membership, a host registration, a retirement), against who was last told
 * and not since released. The definition of who the coordinators are is `pauseDispatchRecipients`, unchanged (H24 is
 * Proposed). A worker newly named gets the signal's stop notice; one no longer named gets one resume, unless another
 * live `pause-dispatch` still names it: then none, and a notice of the signal it was never offered is withdrawn.
 * "Last told" is read off the signal's own notice events (the latest of its stop / resume / withdrawal per worker), so
 * nothing new is stored and a second reconcile at the same state writes nothing. A manager recipient (the fallback,
 * no worker lane) is told at the set and the end only.
 */
async function reconcileCoordinators(tx: Tx, appId: string, now: Date, covering: Map<string, StopSignal[]>): Promise<number> {
  const live = await tx.$queryRaw<StopSignal[]>(Prisma.sql`
    SELECT ${SIGNAL_COLUMNS} FROM team_stop_signals s
    WHERE s.app_id = ${appId} AND s.level = 'pause-dispatch' AND ${liveSql(now)} ORDER BY s.set_at, s.id`);
  if (live.length === 0) return 0;
  const { workers, managers } = await coordinatorInputs(tx, appId);
  const want = new Map<string, Set<string>>();
  for (const s of live) {
    const covered = new Set<string>();
    for (const [w, list] of covering) if (list.some((x) => x.id === s.id)) covered.add(w);
    const ids = pauseDispatchRecipients(covered, workers, managers).flatMap((r) => ('workerId' in r ? [r.workerId] : []));
    want.set(s.id, new Set(ids));
  }
  // Who each live signal last named, and whether the latest stop to them was delivered.
  const last = await tx.$queryRaw<Array<{ signalId: string; workerId: string; eventId: string; named: boolean }>>(Prisma.sql`
    SELECT DISTINCT ON (e.payload ->> 'signalId', e.subject_worker_id)
           e.payload ->> 'signalId' AS "signalId", e.subject_worker_id AS "workerId", e.id AS "eventId",
           (e.type = ${STOP_NOTICE_EVENT} AND e.payload ->> 'notice' = 'stop') AS named
    FROM agent_team_events e
    WHERE e.app_id = ${appId} AND e.type IN (${STOP_NOTICE_EVENT}, ${STOP_NOTICE_WITHDRAWN_EVENT}) AND e.subject_worker_id IS NOT NULL
      AND e.payload ->> 'signalId' IN (${Prisma.join(live.map((s) => s.id))})
    ORDER BY e.payload ->> 'signalId', e.subject_worker_id, e.created_at DESC, e.id DESC`);
  const retired = new Set((await tx.worker.findMany({ where: { appId, retiredAt: { not: null } }, select: { id: true } })).map((r) => r.id));
  let sent = 0;
  for (const s of live) {
    const now_ = want.get(s.id)!;
    const named = new Map(last.filter((l) => l.signalId === s.id && l.named).map((l) => [l.workerId, l.eventId] as const));
    for (const w of [...now_].sort()) {
      if (named.has(w)) continue;
      await appendStopNotice(tx, { appId, recipient: { workerId: w }, signalId: s.id, level: s.level, notice: 'stop', at: now });
      sent++;
    }
    for (const [w, noticeEventId] of [...named].sort(([a], [b]) => a.localeCompare(b))) {
      if (now_.has(w)) continue;
      if (live.some((o) => o.id !== s.id && want.get(o.id)!.has(w))) {
        await appendStopNoticeWithdrawn(tx, { appId, workerId: w, signalId: s.id, noticeEventId, at: now });
      } else if (!retired.has(w)) {
        await appendStopNotice(tx, { appId, recipient: { workerId: w }, signalId: s.id, level: s.level, notice: 'resume', at: now });
        sent++;
      }
    }
  }
  return sent;
}

export type SetStopSignalInput = {
  appId: string;
  level: StopLevel;
  scope: StopScope;
  targetWorkerId: string | null;
  targetHostRegistrationId: string | null;
  until: Date | null;
  by: StopActor;
};

/**
 * Set a signal (090:01) and apply it: its `stop.set` event, its coverage, its workers' notices and, for a
 * `pause-dispatch`, its coordinators' notice. Never replaces or changes another signal on the same target (R69). The
 * caller holds the stop fence exclusive and has validated the target inside the App and `until > now`.
 */
export async function setStopSignal(tx: Tx, input: SetStopSignalInput, now: Date): Promise<StopSignal> {
  const id = generateId();
  await tx.teamStopSignal.create({
    data: {
      id, appId: input.appId, level: input.level, scope: input.scope,
      targetWorkerId: input.targetWorkerId, targetHostRegistrationId: input.targetHostRegistrationId,
      setAt: now, until: input.until,
      setByUserId: 'userId' in input.by ? input.by.userId : null,
      setByAppKeyId: 'appKeyId' in input.by ? input.by.appKeyId : null,
    },
  });
  const signal = await readSignal(tx, id);
  await appendStopSetEvent(tx, signal, input.by);
  await reconcileStopCoverage(tx, input.appId, now);
  if (signal.level === 'pause-dispatch') await notifyCoordinators(tx, signal, await openCoverageOf(tx, id), 'stop', now, 'people');
  return signal;
}

/**
 * Lift a signal (090:05). `changed` is false when it had already ended (lifted or expired, at or before `now`): then
 * nothing is written and nobody gets a second notice. The caller holds the stop fence exclusive.
 */
export async function liftStopSignal(tx: Tx, signalId: string, by: StopActor, now: Date): Promise<{ signal: StopSignal; changed: boolean }> {
  // An expiry already past is recorded first, so a lift after it changes nothing (090:05 S3).
  const current = await readSignal(tx, signalId);
  await reconcileStopCoverage(tx, current.appId, now);
  const s = await readSignal(tx, signalId);
  if (s.endedAt !== null) return { signal: s, changed: false };
  const covered = await openCoverageOf(tx, signalId);
  const n = await tx.$executeRaw`
    UPDATE team_stop_signals SET ended_at = ${toNaiveUtc(now)}::timestamp, end_kind = 'lifted',
      ended_by_user_id = ${'userId' in by ? by.userId : null}, ended_by_app_key_id = ${'appKeyId' in by ? by.appKeyId : null}
    WHERE id = ${signalId} AND ended_at IS NULL`;
  if (n === 0) return { signal: await readSignal(tx, signalId), changed: false };
  await appendStopEndEvent(tx, s, { kind: 'lifted', by, at: now });
  if (s.level === 'pause-dispatch') await notifyCoordinators(tx, s, covered, 'resume', now);
  await reconcileStopCoverage(tx, s.appId, now);
  return { signal: await readSignal(tx, signalId), changed: true };
}

/** One signal by id, or throws (the caller resolved it inside its App). */
export async function readSignal(tx: Tx, id: string): Promise<StopSignal> {
  const [s] = await tx.$queryRaw<StopSignal[]>(Prisma.sql`SELECT ${SIGNAL_COLUMNS} FROM team_stop_signals s WHERE s.id = ${id}`);
  if (!s) throw new Error(`stop signal ${id} not found`);
  return s;
}
