/**
 * #4233 (S10 of the Team on Orca epic, #4229) — sweep observability: the per-run record, the one summary post, and the
 * stale-sweep alarm. Proposed spec wording is drafted by Vera; nothing here mints a citation.
 *
 * RECORD. A host's sweep (every minute, `hadron team host up --apply`) reports each run once through `recordHostSweepRun`:
 * its own run token, start and end, mode (OBSERVE or APPLY), the counts planned/applied/skipped/failed, and at most 50
 * per-worker lines, each a worker token, an outcome and a reason CODE. No free text is accepted anywhere, so a host key can
 * put nothing but tokens and numbers into a record that reaches a team chat. The whole report is validated before anything
 * is written; a malformed one stores nothing. A replay of the same run token is the same row and changes nothing.
 *
 * ONE POST. A run that APPLIED or FAILED something produces one summary line in the App's team chat, from the platform's
 * system author (the #4041 notice pattern, cor:agt:070:01; never the host key, a worker or a person). A run that changed
 * nothing posts nothing. The post is one append however many fixes the run made, so a run with 25 fixes is one message
 * under the 10-a-minute cap (cor:agt:020:14). Its marker (`posted_at`) is claimed inside the post's own transaction, so
 * a replay or a second instance posts nothing more.
 *
 * ONE ALARM. A host of an App whose sweep mode is OBSERVE or APPLY whose newest run was recorded more than five minutes ago
 * raises ONE `alarm.stale-sweep` per episode, to the App's managers (the chain with no reporting line: `appManagerUserIds`).
 * The episode (`host_sweep_episodes`) de-duplicates it and ends when the host records its next run, or when the mode goes
 * OFF. A host that never ran is judged from the later of its registration and the last change of the mode, so switching
 * the mode on does not alarm in the same minute.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { appManagerUserIds } from '../auth/appManagement.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { isSerializationFailure } from './stall.js';

export const STALE_SWEEP_EVENT_TYPE = 'alarm.stale-sweep';
/** A host's sweep is stale when the server last recorded a run for it this long ago (the server's clock, never the host's). */
export const STALE_SWEEP_WINDOW_MINUTES = 5;
/** The most per-worker lines a run record keeps. */
export const SWEEP_RUN_MAX_LINES = 50;
/** How far ahead of the server clock a host's run end may be (clock skew), and the longest a run may take. */
export const SWEEP_RUN_MAX_SKEW_MS = 2 * 60_000;
export const SWEEP_RUN_MAX_DURATION_MS = 60 * 60_000;
/** The lines a summary post names before it says "and N more". */
const SUMMARY_LINES = 10;
const COUNT_MAX = 1_000_000;

export type SweepOutcome = 'APPLIED' | 'SKIPPED' | 'FAILED';
const OUTCOMES: readonly SweepOutcome[] = ['APPLIED', 'SKIPPED', 'FAILED'];

export type SweepRunLine = { worker: string; outcome: SweepOutcome; reason: string };
export type SweepRunInput = {
  runId: string;
  /** The DateTime scalar hands a resolver an ISO string; a Date is accepted for direct callers. */
  startedAt: Date | string;
  endedAt: Date | string;
  mode: string;
  planned: number;
  applied: number;
  skipped: number;
  failed: number;
  lines?: { worker: string; outcome: string; reason: string }[] | null;
};
export type CheckedSweepRun = {
  runKey: string;
  startedAt: Date;
  endedAt: Date;
  mode: 'OBSERVE' | 'APPLY';
  planned: number;
  applied: number;
  skipped: number;
  failed: number;
  lines: SweepRunLine[];
};

const RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const WORKER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Validate a run report as a whole. Returns the cleaned run, or the one message that says what is wrong. */
export function validateSweepRun(input: SweepRunInput, now: Date): { ok: true; run: CheckedSweepRun } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  if (!input || typeof input.runId !== 'string' || !RUN_KEY.test(input.runId)) return fail('runId is a token of 1 to 64 letters, digits and . _ : -.');
  if (input.mode !== 'OBSERVE' && input.mode !== 'APPLY') return fail('mode is OBSERVE or APPLY: a sweep in mode OFF acts on nothing and records nothing.');
  const toDate = (v: unknown): Date | null => {
    const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const startedAt = toDate(input.startedAt);
  const endedAt = toDate(input.endedAt);
  if (!startedAt || !endedAt) return fail('startedAt and endedAt are required timestamps.');
  if (endedAt.getTime() < startedAt.getTime()) return fail('endedAt is not before startedAt.');
  if (endedAt.getTime() - startedAt.getTime() > SWEEP_RUN_MAX_DURATION_MS) return fail('A run lasts at most one hour.');
  if (endedAt.getTime() > now.getTime() + SWEEP_RUN_MAX_SKEW_MS) return fail('endedAt is more than two minutes ahead of the server.');
  const counts = {} as Record<'planned' | 'applied' | 'skipped' | 'failed', number>;
  for (const k of ['planned', 'applied', 'skipped', 'failed'] as const) {
    const v = input[k];
    if (!Number.isInteger(v) || v < 0 || v > COUNT_MAX) return fail(`${k} is a whole number from 0 to ${COUNT_MAX}.`);
    counts[k] = v;
  }
  const raw = input.lines ?? [];
  if (!Array.isArray(raw)) return fail('lines is a list.');
  if (raw.length > SWEEP_RUN_MAX_LINES) return fail(`A run carries at most ${SWEEP_RUN_MAX_LINES} worker lines.`);
  const lines: SweepRunLine[] = [];
  for (const l of raw) {
    if (!l || typeof l.worker !== 'string' || !WORKER_TOKEN.test(l.worker)) return fail('A line names its worker as a token.');
    if (!OUTCOMES.includes(l.outcome as SweepOutcome)) return fail('A line outcome is APPLIED, SKIPPED or FAILED.');
    if (typeof l.reason !== 'string' || !REASON_CODE.test(l.reason)) return fail('A line reason is a code: capital letters, digits and underscores.');
    lines.push({ worker: l.worker, outcome: l.outcome as SweepOutcome, reason: l.reason });
  }
  return { ok: true, run: { runKey: input.runId, startedAt, endedAt, mode: input.mode, ...counts, lines } };
}

/** Does this run need a summary post? Only a run that applied or failed something does: nothing changed, nothing said. */
export const needsSummary = (r: Pick<CheckedSweepRun, 'applied' | 'failed'>): boolean => r.applied + r.failed > 0;

/** Strip markdown syntax from a token a host key supplied before it reaches a platform-authored line. */
const plain = (s: string): string => s.replace(/[\[\]()<>`*_~|\\@]/g, ' ').replace(/\s+/g, ' ').trim();

/** The one line a run posts. Plain text; tokens only. Names at most {@link SUMMARY_LINES} worker lines, then the rest as a count. */
export function summaryBody(args: { hostLabel: string; run: Pick<CheckedSweepRun, 'mode' | 'applied' | 'failed' | 'skipped' | 'planned' | 'lines'> }): string {
  const { run } = args;
  const head = `Sweep on ${plain(args.hostLabel)} (${run.mode.toLowerCase()}): ${run.applied} fixed${run.failed ? `, ${run.failed} failed` : ''}, ${run.skipped} skipped, ${run.planned} planned.`;
  const acted = run.lines.filter((l) => l.outcome !== 'SKIPPED');
  if (acted.length === 0) return head;
  const shown = acted.slice(0, SUMMARY_LINES).map((l) => `${plain(l.worker)} ${l.outcome.toLowerCase()} (${l.reason})`);
  const more = acted.length - shown.length;
  return `${head} ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}

export type RecordedRun = { id: string; created: boolean };

/**
 * Store a run inside the caller's transaction (the host-key gate has run). A replayed run token is the existing row. Ends the
 * host's open stale-sweep episode: the host has swept. Returns whether this call created the row.
 */
export async function insertSweepRun(tx: Prisma.TransactionClient, appId: string, hostId: string, run: CheckedSweepRun): Promise<RecordedRun> {
  // Shares the registration row with the stale-sweep raise (which holds it FOR UPDATE while it re-reads and opens the episode):
  // a run either commits before the raise re-reads, so it is seen, or waits for the raise and then ends the episode (#4255 Braxton P3-2).
  await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${appId} AND host_id = ${hostId} FOR SHARE`;
  const id = generateId();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO host_sweep_runs (id, app_id, host_id, run_key, started_at, ended_at, mode, planned, applied, skipped, failed, lines, recorded_at)
    VALUES (${id}, ${appId}, ${hostId}, ${run.runKey}, ${toNaiveUtc(run.startedAt)}::timestamp, ${toNaiveUtc(run.endedAt)}::timestamp,
            ${run.mode}::"SweepMode", ${run.planned}, ${run.applied}, ${run.skipped}, ${run.failed}, ${JSON.stringify(run.lines)}::jsonb, (now() AT TIME ZONE 'UTC'))
    ON CONFLICT (app_id, host_id, run_key) DO NOTHING
    RETURNING id`;
  if (rows.length === 0) {
    const [existing] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM host_sweep_runs WHERE app_id = ${appId} AND host_id = ${hostId} AND run_key = ${run.runKey}`;
    return { id: existing!.id, created: false };
  }
  // The host has swept: its stale-sweep episode, if any, is over (on the database clock, which `opened_at` was written on).
  await tx.$executeRaw`UPDATE host_sweep_episodes SET ended_at = GREATEST(opened_at, (now() AT TIME ZONE 'UTC')) WHERE app_id = ${appId} AND host_id = ${hostId} AND ended_at IS NULL`;
  return { id, created: true };
}

const pending = new Set<Promise<void>>();

/** At most one summary post per host in this window (#4255 Braxton P2-2): a host key cannot flood the team chat as the platform. */
export const SUMMARY_MIN_GAP_SECONDS = 60;
/** A run whose post has not landed is retried by the stall tick for this long after it was recorded, then left as a record only. */
export const SUMMARY_RETRY_MINUTES = 10;
/** A run is not retried until it is this old: the deferred post of the request itself is still in flight. */
const SUMMARY_RETRY_GRACE_SECONDS = 20;
/** The hosts a retry pass looks at, and the posts it may make. */
const SUMMARY_RETRY_SCAN = 500;
const SUMMARY_RETRY_POSTS = 50;

/** Post a run's summary off the request path: the host key's answer never waits on a chat append. A failed post leaves the marker unclaimed; {@link postPendingSweepSummaries} retries it. */
export function postSweepSummaryDeferred(db: PrismaClient, appId: string, runId: string): void {
  const p: Promise<void> = postSweepSummary(db, appId, runId).then(() => undefined).catch((err) => {
    console.error('[sweep-summary] posting failed:', err);
  }).finally(() => { pending.delete(p); });
  pending.add(p);
}

/** Resolves when every deferred post has finished. For tests and shutdown. */
export async function settleSweepSummaries(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/**
 * Post one run's summary, built from the PERSISTED row (never from a caller's payload), as the system author. False when the
 * run needs none, is already posted, is throttled by the host's previous post, or the App has no chat. The marker is claimed in
 * the post's own append transaction, under a per-host lock so two posts of one host cannot both pass the gap check.
 */
export async function postSweepSummary(db: PrismaClient, appId: string, runId: string): Promise<boolean> {
  const row = await db.hostSweepRun.findFirst({ where: { id: runId, appId, postedAt: null } });
  if (!row || row.applied + row.failed <= 0) return false;
  const reg = await db.hostRegistration.findFirst({ where: { appId, hostId: row.hostId }, select: { label: true } });
  const body = summaryBody({
    hostLabel: reg?.label ?? row.hostId,
    run: { mode: row.mode as 'OBSERVE' | 'APPLY', applied: row.applied, failed: row.failed, skipped: row.skipped, planned: row.planned, lines: (Array.isArray(row.lines) ? row.lines : []) as SweepRunLine[] },
  });
  const { postSystemNotice } = await import('../../api/graphql/schema/resolvers.teamChat.js');
  return postSystemNotice(db, appId, body, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'sweep-summary:' + appId + ':' + row.hostId}))`;
    return (await tx.$executeRaw`
      UPDATE host_sweep_runs SET posted_at = (now() AT TIME ZONE 'UTC')
      WHERE id = ${runId} AND app_id = ${appId} AND posted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM host_sweep_runs o WHERE o.app_id = ${appId} AND o.host_id = ${row.hostId}
                        AND o.posted_at > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${SUMMARY_MIN_GAP_SECONDS}))`) > 0;
  });
}

/**
 * Durable recovery of the deferred post (#4255 Clark F1): the runs with something to say whose marker is still unclaimed (the
 * append failed, the process stopped after the commit, or the host's previous post was inside the gap), oldest first, within
 * {@link SUMMARY_RETRY_MINUTES} of being recorded. Runs from the stall tick; each post keeps the atomic claim and the gap.
 */
export async function postPendingSweepSummaries(db: PrismaClient, now = new Date()): Promise<number> {
  const from = toNaiveUtc(new Date(now.getTime() - SUMMARY_RETRY_MINUTES * 60_000));
  const to = toNaiveUtc(new Date(now.getTime() - SUMMARY_RETRY_GRACE_SECONDS * 1000));
  // One candidate per HOST (its oldest unposted run: the host gap lets only one post per minute anyway), taken round-robin
  // across Apps: every App's oldest candidate is considered before any App's second. A tenant whose runs cannot post (no chat)
  // therefore holds one slot per round, not the scan, however many hosts it names (#4255 Clark F4). Every candidate is tried each
  // tick, and the number of posts, not of attempts, is what is capped.
  const due = await db.$queryRaw<{ id: string; appId: string }[]>`
    SELECT d.id, d."appId" FROM (
      SELECT h.id, h."appId", h.recorded_at, row_number() OVER (PARTITION BY h."appId" ORDER BY h.recorded_at, h.id) AS round
      FROM (
        SELECT DISTINCT ON (r.app_id, r.host_id) r.id, r.app_id AS "appId", r.recorded_at
        FROM host_sweep_runs r
        WHERE r.posted_at IS NULL AND r.applied + r.failed > 0 AND r.recorded_at > ${from}::timestamp AND r.recorded_at <= ${to}::timestamp
        ORDER BY r.app_id, r.host_id, r.recorded_at, r.id) h) d
    ORDER BY d.round, d.recorded_at, d.id LIMIT ${SUMMARY_RETRY_SCAN}`;
  let posted = 0;
  for (const r of due) {
    if (posted >= SUMMARY_RETRY_POSTS) break;
    try {
      if (await postSweepSummary(db, r.appId, r.id)) posted++;
    } catch (err) {
      console.error(`[sweep-summary] retrying run ${r.id} failed:`, err);
    }
  }
  return posted;
}

/** Open one episode and raise its alarm, in one transaction. Null when the host already has an open episode or is no longer stale. */
async function raise(db: PrismaClient, app: { id: string; organizationId: string | null; ownerUserId: string | null }, hostId: string, now: Date): Promise<string | null> {
  try {
    return await db.$transaction(async (tx): Promise<string | null> => {
      const [live] = await tx.$queryRaw<{ mode: string }[]>`
        SELECT sweep_mode::text AS mode FROM apps WHERE id = ${app.id} AND deleted_at IS NULL AND uninstalled_at IS NULL FOR SHARE`;
      if (!live || live.mode === 'OFF') return null;
      await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${app.id} AND host_id = ${hostId} FOR UPDATE`;
      // Judged again here, in the transaction that opens the episode: a run recorded since the pass read is seen now.
      const last = await lastActivity(tx as unknown as PrismaClient, app.id, hostId);
      if (!last || now.getTime() - last.at.getTime() <= STALE_SWEEP_WINDOW_MINUTES * 60_000) return null;
      const managers = await appManagerUserIds(tx, app);
      const chainJson = managers.map((userId) => ({ userId, via: 'manager' }));
      const eventId = generateId();
      const payload: Prisma.InputJsonObject = {
        reason: 'stale-sweep',
        hostId,
        mode: live.mode,
        windowMinutes: STALE_SWEEP_WINDOW_MINUTES,
        lastRunAt: last.run ? last.at.toISOString() : null,
      };
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${app.id}, ${STALE_SWEEP_EVENT_TYPE}, NULL, NULL, 'alarm', ${JSON.stringify(chainJson)}::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${toNaiveUtc(now)}::timestamp, NULL)`;
      // The one-open-episode-per-host index decides a race: the loser's insert fails and this transaction rolls back.
      await tx.hostSweepEpisode.create({ data: { appId: app.id, hostId, eventId, openedAt: now } });
      const windowMs = STALE_SWEEP_WINDOW_MINUTES * 60_000;
      await tx.agentTeamAlarmSchedule.createMany({
        data: managers.map((_, i) => ({ eventId, chainIndex: i, dueAt: new Date(now.getTime() + i * windowMs), wokenAt: i === 0 ? now : null })),
      });
      return eventId;
    // READ COMMITTED on purpose (#4255 Braxton P3-2): the registration lock above is the fence against a run committing now, and a
    // snapshot taken before its wait would not see that run. The one-open-episode index decides a duplicate race.
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (err) {
    if (isSerializationFailure(err)) return null;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/**
 * The clock a host's staleness runs from: when the server last RECORDED a run for it (the host's own `ended_at` is its clock, which may be wrong: #4255 Braxton P2-1); with no run, the later of its registration and the App's
 * latest sweep-mode change. `run` says which. Null when the host has no registration.
 */
async function lastActivity(db: PrismaClient, appId: string, hostId: string): Promise<{ at: Date; run: boolean } | null> {
  const [row] = await db.$queryRaw<{ lastRun: Date | null; registeredAt: Date | null; modeChangedAt: Date | null }[]>`
    SELECT (SELECT MAX(recorded_at) FROM host_sweep_runs WHERE app_id = ${appId} AND host_id = ${hostId}) AS "lastRun",
           (SELECT registered_at FROM host_registrations WHERE app_id = ${appId} AND host_id = ${hostId}) AS "registeredAt",
           (SELECT MAX(created_at) FROM agent_team_events WHERE app_id = ${appId} AND type = 'team.sweep-mode-changed') AS "modeChangedAt"`;
  if (!row) return null;
  // The latest of the last recorded run and the last change of the App's sweep mode: a host that ran yesterday, whose App went
  // OFF and was switched on again now, gets the grace of a fresh switch-on and not an alarm in the same minute (#4255 Diego).
  // A host that never ran counts from its registration instead.
  const base = row.lastRun ?? row.registeredAt;
  if (!base) return null;
  return { at: new Date(Math.max(base.getTime(), row.modeChangedAt?.getTime() ?? 0)), run: row.lastRun !== null };
}

/**
 * One pass. Ends the open episodes whose App went OFF or whose host swept since, then opens one for each host of an
 * OBSERVE or APPLY App that is stale and has none. Returns the ids of the alarms this pass raised.
 */
export async function evaluateStaleSweeps(db: PrismaClient, now = new Date()): Promise<string[]> {
  const raised: string[] = [];
  const nowNaive = toNaiveUtc(now);
  // An App whose mode went OFF (or that is gone from the live set) no longer has a sweep to go stale.
  await db.$executeRaw`
    UPDATE host_sweep_episodes e SET ended_at = GREATEST(e.opened_at, ${nowNaive}::timestamp)
    WHERE e.ended_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM apps a WHERE a.id = e.app_id AND a.sweep_mode <> 'OFF' AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL)`;
  // A host that swept since the episode opened (a run recorded in another instance's transaction, say).
  await db.$executeRaw`
    UPDATE host_sweep_episodes e SET ended_at = GREATEST(e.opened_at, ${nowNaive}::timestamp)
    WHERE e.ended_at IS NULL AND EXISTS (
      SELECT 1 FROM host_sweep_runs r WHERE r.app_id = e.app_id AND r.host_id = e.host_id AND r.recorded_at > e.opened_at)`;
  const apps = await db.app.findMany({
    where: { deletedAt: null, uninstalledAt: null, sweepMode: { in: ['OBSERVE', 'APPLY'] } },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  for (const app of apps) {
    try {
      const hosts = await db.hostRegistration.findMany({ where: { appId: app.id }, select: { hostId: true } });
      const open = new Set((await db.hostSweepEpisode.findMany({ where: { appId: app.id, endedAt: null }, select: { hostId: true } })).map((e) => e.hostId));
      for (const { hostId } of hosts) {
        if (open.has(hostId)) continue;
        try {
          const last = await lastActivity(db, app.id, hostId);
          if (!last || now.getTime() - last.at.getTime() <= STALE_SWEEP_WINDOW_MINUTES * 60_000) continue;
          const id = await raise(db, app, hostId, now);
          if (id) raised.push(id);
        } catch (err) {
          console.error(`[stale-sweep] raising the alarm for host ${hostId} failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[stale-sweep] evaluating App ${app.id} failed:`, err);
    }
  }
  return raised;
}
