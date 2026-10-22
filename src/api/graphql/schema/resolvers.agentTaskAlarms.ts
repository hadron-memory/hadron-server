// Agent task alarms and availability — #1706 (Task Management slice T2, epic #1704).
//
// The stall evaluator (src/jobs/taskStallEvaluator.ts, src/lib/agentTasks/
// stall.ts) raises alarms; this file is their human and worker surface:
// acknowledging an alarm (cor:agt:050:20), setting a worker's or a model
// family's availability for work (cor:agt:060:08 / :09), and an App's stall
// windows. Every gate is T1's (resolvers.agentTask.ts): the same actor
// resolution, participation predicate, strict App-manager predicate,
// concealment, and in-transaction re-gate under shared authority anchors
// (`inTaskWriteTx`). Nothing here hand-rolls a second gate.
//
// AUTHORIZATION (plan design:agent-tasks §10):
//   acknowledge an alarm   any owner in its chain, or whoever manages the App
//                           (050:24, #1762), and nobody else (050:20, Proposed)
//   set worker availability   the worker itself (only to unavailable); the
//                           person holding its name; whoever manages the App;
//                           the worker it reports to DIRECTLY, only to clear a
//                           mark the stall rule set (060:08, Proposed; 060:11;
//                           #1759). The stall rule sets it from the evaluator;
//                           the host arm is T6 (#1709).
//   set model-family availability  whoever manages the App (060:09, Proposed)
//   set the stall schedule  whoever manages the App (#1706); with it the host
//                           lapse count (cor:agt:070:01, #1763)
//   read all of the above  the App's task audience: every participant and the
//                           App's own key, read-only (050:21, 060:02, :03; #1767)
// "Whoever manages the App" stays T1's INTERIM reading: a person acting as
// themselves, never a worker acting through its session (team chat #7508).
//
// ACKNOWLEDGEMENT (Rook, #1713 §10 review P3-2, carried on #1706). The
// append-only trigger lets an alarm be acknowledged once, but cannot check who
// or when. So the mutation locks the alarm row FOR UPDATE, checks the caller
// against the CHAIN ON THAT LOCKED ROW, and stamps `acknowledgedAt` with the
// server's clock — there is no client-supplied time to accept. The evaluator's
// escalation holds the alarm FOR SHARE while it wakes the next owner, so an
// acknowledgement and a wake never interleave.

import { familySpellings, normalizeFamily } from '../../../lib/agentTasks/family.js';
import {
  HOST_REPORT_TIMEOUT_DEFAULT_MINUTES,
  HOST_REPORT_TIMEOUT_MAX_MINUTES,
  HOST_REPORT_TIMEOUT_MIN_MINUTES,
} from '../../../lib/hostOperations/settle.js';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import { type Context } from './resolvers.helpers.js';
import {
  actorManagesApp,
  inTaskWriteTx,
  loadApp,
  partyView,
  requireWritable,
  resolveParticipatedApp,
  withReadableApp,
  resolveTaskActor,
  resolveTaskWorkerId,
  taskError,
  type TaskActor,
  type TaskApp,
} from './resolvers.agentTask.js';
import { loadWorkersActivity } from './resolvers.worker.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { currentActor } from '../../../lib/requestActor.js';
import {
  appendAvailabilityEvent,
  eventActor,
  type AvailabilityReason,
  type AvailabilitySetter,
} from '../../../lib/agentTasks/events.js';
import { recordInEffect } from '../../../lib/agentTasks/availability.js';
import { effectiveWindows, STALL_WINDOW_DEFAULTS, type StallWindows } from '../../../lib/agentTasks/stall.js';
import { matchAfterChange } from '../../../lib/agentTasks/matcher.js';
import {
  HOST_LAPSE_CHECK_INS_DEFAULT,
  HOST_LAPSE_CHECK_INS_MAX,
  HOST_LAPSE_CHECK_INS_MIN,
  lockAppHostLapse,
} from '../../../lib/agentTasks/hosts.js';
import {
  SESSION_END_GRACE_DEFAULT_MINUTES,
  SESSION_END_GRACE_MAX_MINUTES,
  SESSION_END_GRACE_MIN_MINUTES,
} from '../../../lib/hostOperations/sessionEnd.js';

// ── Errors and parsing ────────────────────────────────────────────────────

const alarmNotFound = (eventId: string): GraphQLError =>
  taskError('ALARM_NOT_FOUND', 'Alarm not found.', { eventId });
const workerNotFound = (ref: string): GraphQLError =>
  taskError('WORKER_NOT_FOUND', 'Worker not found.', { ref });
const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
const notPermitted = (message: string): GraphQLError => taskError('AVAILABILITY_NOT_PERMITTED', message);

const STATE_FROM_GQL: Record<string, 'available' | 'unavailable'> = { AVAILABLE: 'available', UNAVAILABLE: 'unavailable' };
const REASON_FROM_GQL: Record<string, AvailabilityReason> = {
  STALLED: 'stalled', OUT_OF_TOKENS: 'out-of-tokens', HOST_DOWN: 'host-down', OTHER: 'other',
};
const toGqlWord = (s: string): string => s.toUpperCase().replace(/-/g, '_');

function parseDate(value: unknown, field: string): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw badInput(`${field} is not a valid date-time.`);
  return d;
}

export type AvailabilityInput = { state: string; reason?: string | null; until?: unknown };

/** cor:agt:060:02 shape: a reason (from the closed set) exactly when unavailable; an `until` only then, in the future. */
export function normalizeAvailability(input: AvailabilityInput, now: Date) {
  const state = STATE_FROM_GQL[input.state];
  if (!state) throw badInput('state is AVAILABLE or UNAVAILABLE.');
  const reason = input.reason == null ? null : REASON_FROM_GQL[input.reason] ?? null;
  if (input.reason != null && !reason) throw badInput('reason is STALLED, OUT_OF_TOKENS, HOST_DOWN or OTHER.');
  const until = parseDate(input.until, 'until');
  if (state === 'available') {
    if (reason || until) throw badInput('Only an unavailable record carries a reason or an until.');
    return { state, reason: null, until: null };
  }
  if (!reason) throw badInput('An unavailable record needs a reason.');
  if (until && until.getTime() <= now.getTime()) throw badInput('until must be in the future.');
  return { state, reason, until };
}

function setByColumns(ctx: Context) {
  const a = currentActor();
  return { setByUserId: ctx.userId ?? null, setByWorkerId: a.workerId, setByAgentId: a.agentId };
}

/**
 * Is the actor this chain entry? A person never matches a worker entry, nor the reverse (T1's `actorIs`). An entry
 * marked `via: 'manager'` (#1761) is NOT an owner: it stands for "managed the App when the alarm was raised", so it
 * grants nothing here, and a manager acknowledges through the live `managesApp` check instead (Diego P2, #1816).
 */
function inChain(actor: TaskActor, chain: unknown): boolean {
  if (!Array.isArray(chain)) return false;
  return chain.some((entry) => {
    const e = (entry ?? {}) as { workerId?: unknown; userId?: unknown; via?: unknown };
    if (e.via === 'manager') return false;
    return actor.kind === 'worker'
      ? typeof e.workerId === 'string' && e.workerId === actor.workerId
      : e.workerId == null && typeof e.userId === 'string' && e.userId === actor.userId;
  });
}

// ── Rows ──────────────────────────────────────────────────────────────────

type WorkerAvailabilityRow = Prisma.WorkerAvailabilityGetPayload<Record<string, never>> & { __inEffect?: boolean };
type ModelFamilyAvailabilityRow = Prisma.ModelFamilyAvailabilityGetPayload<Record<string, never>> & { __inEffect?: boolean };

/** Resolve the worker an availability write names, within an App the caller participates in — or WORKER_NOT_FOUND. */
async function resolveAvailabilityWorker(
  ctx: Context,
  ref: string,
  appRef: string | null | undefined,
): Promise<{ workerId: string; app: TaskApp; actor: TaskActor }> {
  const r = (ref ?? '').trim();
  if (!r) throw badInput('Name the worker.');
  if (appRef) {
    const { app, actor } = await resolveParticipatedApp(ctx, appRef);
    const workerId = await resolveTaskWorkerId(ctx, app.id, r);
    const row = workerId ? await ctx.db.worker.findUnique({ where: { id: workerId }, select: { appId: true } }) : null;
    if (!workerId || !row || row.appId !== app.id) throw workerNotFound(r);
    return { workerId, app, actor };
  }
  if (!isId(r) && !r.startsWith('hrn:')) throw badInput('Name the worker by id or URN, or pass appRef with its name.');
  const workerId = await resolveTaskWorkerId(ctx, '', r);
  const row = workerId ? await ctx.db.worker.findUnique({ where: { id: workerId }, select: { appId: true } }) : null;
  const app = row ? await loadApp(ctx, row.appId) : null;
  const actor = app ? await resolveTaskActor(ctx, app) : null;
  if (!workerId || !app || !actor) throw workerNotFound(r);
  return { workerId, app, actor };
}

/**
 * cor:agt:060:11 (#1759) — may the worker a target reports to DIRECTLY make this
 * write? Only to set it available, and only when the target's current record is
 * a mark the stall rule set (cor:agt:060:07: unavailable, `stalled`, set by
 * `stall-rule`). A mark anyone else set stays for them, whatever its reason
 * (Victor, team chat #10324). The record is locked FOR UPDATE, so the stall
 * evaluator's clearance or a holder's write cannot slip in between this check
 * and the upsert. Throws AVAILABILITY_NOT_PERMITTED otherwise.
 */
async function authorizeReportsToClear(tx: Prisma.TransactionClient, workerId: string, state: 'available' | 'unavailable'): Promise<void> {
  if (state !== 'available') {
    throw notPermitted('The worker another reports to may only clear its stall, never mark it unavailable.');
  }
  const [cur] = await tx.$queryRaw<{ state: string; reason: string | null; setBy: string }[]>`
    SELECT state, reason, set_by AS "setBy" FROM worker_availability WHERE worker_id = ${workerId} FOR UPDATE`;
  if (!cur || cur.state !== 'unavailable' || cur.reason !== 'stalled' || cur.setBy !== 'stall-rule') {
    throw notPermitted(
      'The worker another reports to may clear only a mark the stall rule set; this record is for its holder or whoever manages the App.',
    );
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────

export const agentTaskAlarmMutations = {
  /**
   * cor:agt:050:20 — acknowledge an alarm: stops it waking higher owners; does
   * not end the stall episode. Any owner in the alarm's chain, or whoever
   * manages the App (cor:agt:050:24), and nobody else. A second acknowledgement is refused and the first stands
   * (050:20 edge case, Proposed).
   */
  acknowledgeAlarm: async (_: unknown, { eventId }: { eventId: string }, ctx: Context) => {
    const id = typeof eventId === 'string' ? eventId.trim() : '';
    const found = isId(id)
      ? await ctx.db.agentTeamEvent.findUnique({ where: { id }, select: { appId: true } })
      : null;
    const app = found ? await loadApp(ctx, found.appId) : null;
    const actor = app ? await resolveTaskActor(ctx, app) : null;
    // An event of an App the caller does not participate in reads as missing.
    if (!app || !actor) throw alarmNotFound(id);
    requireWritable(ctx, app);
    await inTaskWriteTx(ctx, app, actor, () => alarmNotFound(id), async (tx, txCtx, freshApp) => {
      const [row] = await tx.$queryRaw<{ appId: string; severity: string | null; chain: unknown; acknowledgedAt: Date | null }[]>`
        SELECT app_id AS "appId", severity, chain, acknowledged_at AS "acknowledgedAt"
        FROM agent_team_events WHERE id = ${id} FOR UPDATE`;
      if (!row || row.appId !== freshApp.id) throw alarmNotFound(id);
      if (row.severity !== 'alarm') {
        throw taskError('NOT_AN_ALARM', 'This event is not an alarm; only an alarm is acknowledged.', { eventId: id });
      }
      // Membership is checked against the chain ON THE LOCKED ROW (Rook P3-2).
      // cor:agt:050:24 (#1762): an owner in the chain, or whoever manages the App, for any alarm in it.
      if (!inChain(actor, row.chain) && !(await actorManagesApp(txCtx, freshApp, actor))) {
        throw taskError(
          'ALARM_NOT_IN_CHAIN',
          "Only an owner in the alarm's chain, or whoever manages the App, acknowledges it (cor:agt:050:24).",
          { eventId: id },
        );
      }
      if (row.acknowledgedAt) {
        throw taskError('ALARM_ALREADY_ACKNOWLEDGED', 'This alarm is already acknowledged; the first acknowledgement stands.', { eventId: id });
      }
      // The server's clock, never a client value (Rook P3-2).
      await tx.agentTeamEvent.update({
        where: { id },
        data: {
          acknowledgedAt: new Date(),
          acknowledgedByUserId: ctx.userId ?? null,
          acknowledgedByWorkerId: actor.kind === 'worker' ? actor.workerId : null,
        },
      });
    });
    return ctx.db.agentTeamEvent.findUniqueOrThrow({ where: { id } });
  },

  /**
   * cor:agt:060:08 — set a worker's availability for work: the worker itself
   * (only to unavailable), the person holding its name, or whoever manages the
   * App. Another worker may only when the target reports to it directly, and
   * then only to clear a stall (cor:agt:060:11, #1759): see
   * {@link authorizeReportsToClear}. Writes `availability.changed`.
   */
  setWorkerAvailability: async (
    _: unknown,
    { input }: { input: AvailabilityInput & { worker: string; appRef?: string | null } },
    ctx: Context,
  ) => {
    if (!input) throw badInput('input is required.');
    const now = new Date();
    const value = normalizeAvailability(input, now);
    const { workerId, app, actor } = await resolveAvailabilityWorker(ctx, input.worker, input.appRef);
    requireWritable(ctx, app);
    await inTaskWriteTx(ctx, app, actor, () => workerNotFound(input.worker), async (tx, txCtx, freshApp) => {
      // The holder and retirement are read under a lock: releaseWorker and
      // retireWorker update this row. Who it reports to is read under the
      // App's reportsTo graph lock, which inTaskWriteTx holds SHARED, so no
      // writer can move the line before this commits (#1726 lock protocol).
      const [target] = await tx.$queryRaw<{
        appId: string; heldByUserId: string | null; retiredAt: Date | null; reportsToWorkerId: string | null;
      }[]>`
        SELECT app_id AS "appId", held_by_user_id AS "heldByUserId", retired_at AS "retiredAt",
               reports_to_worker_id AS "reportsToWorkerId"
        FROM workers WHERE id = ${workerId} FOR SHARE`;
      if (!target || target.appId !== freshApp.id) throw workerNotFound(input.worker);
      if (target.retiredAt) throw taskError('WORKER_RETIRED', 'This worker is retired.', { workerId });
      let setBy: AvailabilitySetter;
      if (actor.kind === 'worker') {
        if (actor.workerId !== workerId) {
          if (target.reportsToWorkerId !== actor.workerId) {
            throw notPermitted(
              "A worker sets only its own availability; another worker's is set by its holder, whoever manages the App, " +
                'or, to clear a stall, the worker it reports to.',
            );
          }
          await authorizeReportsToClear(tx, workerId, value.state);
          setBy = 'reports-to';
        } else {
          if (value.state !== 'unavailable') {
            throw notPermitted('A worker may mark itself unavailable, never available: its holder or whoever manages the App does that.');
          }
          setBy = 'worker';
        }
      } else if (target.heldByUserId !== null && target.heldByUserId === actor.userId) {
        setBy = 'holder';
      } else if (await actorManagesApp(txCtx, freshApp, actor)) {
        setBy = 'app-manager';
      } else {
        throw notPermitted("Only the worker itself, the person holding its name, or whoever manages the App sets a worker's availability.");
      }
      // #1709: a person's or a worker's write replaces a host's mark, and no longer names the host.
      const data = { ...value, setAt: now, setBy, ...setByColumns(ctx), setByHostId: null };
      await tx.workerAvailability.upsert({
        where: { workerId },
        create: { workerId, ...data },
        update: data,
      });
      await appendAvailabilityEvent(tx, {
        appId: freshApp.id,
        actor: eventActor(ctx.userId),
        event: { kind: 'worker', workerId, state: value.state, reason: value.reason, until: value.until, setBy },
      });
    });
    // #1707: availability changed, so a queued task may now match (cor:agt:060:06).
    await matchAfterChange(ctx.db, app.id);
    return ctx.db.workerAvailability.findUniqueOrThrow({ where: { workerId } });
  },

  /** cor:agt:060:09 — set a model family's availability in an App: whoever manages the App only. */
  setModelFamilyAvailability: async (
    _: unknown,
    { input }: { input: AvailabilityInput & { appRef: string; family: string } },
    ctx: Context,
  ) => {
    if (!input) throw badInput('input is required.');
    const now = new Date();
    const value = normalizeAvailability(input, now);
    const family = normalizeFamily(input.family);
    if (!family) {
      throw badInput('family is a lowercase token (letters, digits, ".", "_" or "-"; up to 64 characters), e.g. claude or codex.');
    }
    const { app, actor } = await resolveParticipatedApp(ctx, input.appRef);
    requireWritable(ctx, app);
    await inTaskWriteTx(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.', { appRef: input.appRef }), async (tx, txCtx, freshApp) => {
      if (!(await actorManagesApp(txCtx, freshApp, actor))) {
        throw notPermitted("Only whoever manages the App sets a model family's availability.");
      }
      const data = { ...value, setAt: now, ...setByColumns(ctx) };
      // Existing aliases are the same availability key. A deliberate setter
      // updates these records too; historical events remain untouched.
      await tx.modelFamilyAvailability.updateMany({
        where: { appId: freshApp.id, family: { in: familySpellings(family) } }, data,
      });
      await tx.modelFamilyAvailability.upsert({
        where: { appId_family: { appId: freshApp.id, family } },
        create: { appId: freshApp.id, family, ...data },
        update: data,
      });
      await appendAvailabilityEvent(tx, {
        appId: freshApp.id,
        actor: eventActor(ctx.userId),
        event: { kind: 'family', family, state: value.state, reason: value.reason, until: value.until },
      });
    });
    // #1707: availability changed, so a queued task may now match (cor:agt:060:06).
    await matchAfterChange(ctx.db, app.id);
    return ctx.db.modelFamilyAvailability.findUniqueOrThrow({ where: { appId_family: { appId: app.id, family } } });
  },

  /**
   * #1706 — an App's stall windows, in minutes (cor:agt:050:14–:17 "What Can
   * Change"), and (#1763) its host-registration lapse in check-ins
   * (cor:agt:070:01, 2 to 10), and (#1709) the grace before the platform ends
   * a finished task's session (cor:agt:050:10, 1 to 1440 minutes): whoever
   * manages the App. An omitted field keeps its value; null returns it to the
   * platform default.
   */
  setAgentTaskStallSchedule: async (
    _: unknown,
    { appRef, input }: { appRef: string; input: Partial<Record<keyof StallWindows | 'hostLapseCheckIns' | 'sessionEndGraceMinutes' | 'hostReportTimeoutMinutes', number | null>> },
    ctx: Context,
  ) => {
    if (!input) throw badInput('input is required.');
    const data: Partial<Record<keyof StallWindows | 'hostLapseCheckIns' | 'sessionEndGraceMinutes' | 'hostReportTimeoutMinutes', number | null>> = {};
    for (const key of Object.keys(STALL_WINDOW_DEFAULTS) as (keyof StallWindows)[]) {
      if (!(key in input)) continue;
      const v = input[key];
      if (v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10_080)) {
        throw badInput(`${key} is a whole number of minutes from 1 to 10080 (a week), or null for the default.`);
      }
      data[key] = v ?? null;
    }
    // cor:agt:070:01 (#1763): the host-registration lapse, in check-ins.
    if ('hostLapseCheckIns' in input) {
      const v = input.hostLapseCheckIns;
      if (v != null && (!Number.isInteger(v) || v < HOST_LAPSE_CHECK_INS_MIN || v > HOST_LAPSE_CHECK_INS_MAX)) {
        throw badInput(
          `hostLapseCheckIns is a whole number of check-ins from ${HOST_LAPSE_CHECK_INS_MIN} to ${HOST_LAPSE_CHECK_INS_MAX}, ` +
            `or null for the default (${HOST_LAPSE_CHECK_INS_DEFAULT}).`,
        );
      }
      data.hostLapseCheckIns = v ?? null;
    }
    // cor:agt:050:10 (#1709): the session-end grace, in minutes.
    if ('sessionEndGraceMinutes' in input) {
      const v = input.sessionEndGraceMinutes;
      if (v != null && (!Number.isInteger(v) || v < SESSION_END_GRACE_MIN_MINUTES || v > SESSION_END_GRACE_MAX_MINUTES)) {
        throw badInput(
          `sessionEndGraceMinutes is a whole number of minutes from ${SESSION_END_GRACE_MIN_MINUTES} to ${SESSION_END_GRACE_MAX_MINUTES}, ` +
            `or null for the default (${SESSION_END_GRACE_DEFAULT_MINUTES}).`,
        );
      }
      data.sessionEndGraceMinutes = v ?? null;
    }
    // cor:agt:070:02 (#1881): the time a host has to report an operation it collected, in minutes.
    if ('hostReportTimeoutMinutes' in input) {
      const v = input.hostReportTimeoutMinutes;
      if (v != null && (!Number.isInteger(v) || v < HOST_REPORT_TIMEOUT_MIN_MINUTES || v > HOST_REPORT_TIMEOUT_MAX_MINUTES)) {
        throw badInput(
          `hostReportTimeoutMinutes is a whole number of minutes from ${HOST_REPORT_TIMEOUT_MIN_MINUTES} to ${HOST_REPORT_TIMEOUT_MAX_MINUTES}, ` +
            `or null for the default (${HOST_REPORT_TIMEOUT_DEFAULT_MINUTES}).`,
        );
      }
      data.hostReportTimeoutMinutes = v ?? null;
    }
    const { app, actor } = await resolveParticipatedApp(ctx, appRef);
    requireWritable(ctx, app);
    await inTaskWriteTx(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.', { appRef }), async (tx, txCtx, freshApp) => {
      if (!(await actorManagesApp(txCtx, freshApp, actor))) {
        throw taskError('APP_MANAGER_REQUIRED', "Only whoever manages the App sets its stall windows.");
      }
      // #1863: a lapse decision in flight either finishes under the old count or waits for this one.
      // #1881: so is a report-timeout decision, which reads the timeout under the same lock shared.
      if ('hostLapseCheckIns' in data || 'hostReportTimeoutMinutes' in data) await lockAppHostLapse(tx, freshApp.id, 'exclusive');
      await tx.agentTaskStallSchedule.upsert({
        where: { appId: freshApp.id },
        create: { appId: freshApp.id, ...data, updatedBy: ctx.userId ?? null },
        update: { ...data, updatedBy: ctx.userId ?? null },
      });
    });
    return stallWindowsView(ctx, app.id);
  },
};

async function stallWindowsView(ctx: Context, appId: string) {
  const row = await ctx.db.agentTaskStallSchedule.findUnique({ where: { appId } });
  return {
    appId,
    ...effectiveWindows(row),
    hostLapseCheckIns: row?.hostLapseCheckIns ?? HOST_LAPSE_CHECK_INS_DEFAULT,
    sessionEndGraceMinutes: row?.sessionEndGraceMinutes ?? SESSION_END_GRACE_DEFAULT_MINUTES,
    hostReportTimeoutMinutes: row?.hostReportTimeoutMinutes ?? HOST_REPORT_TIMEOUT_DEFAULT_MINUTES,
    updatedAt: row?.updatedAt ?? null,
  };
}

// ── Queries ───────────────────────────────────────────────────────────────

export const agentTaskAlarmQueries = {
  /** An App's effective stall windows, for its task audience (cor:agt:050:21). */
  agentTaskStallSchedule: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    const { app } = await resolveParticipatedApp(ctx, appRef);
    return stallWindowsView(ctx, app.id);
  },

  /**
   * Every availability record in an App — its workers' and its model
   * families' — for every App participant and the App's own key, read-only
   * (cor:agt:060:02, :03; the tasks audience, cor:agt:050:23; #1767). Each says
   * whether it is in effect right now.
   */
  teamAvailability: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) =>
    withReadableApp(ctx, appRef, async (c, app) => {
      const now = new Date();
      const [workers, families] = await Promise.all([
        c.db.workerAvailability.findMany({ where: { worker: { appId: app.id } }, orderBy: { workerId: 'asc' } }),
        c.db.modelFamilyAvailability.findMany({ where: { appId: app.id }, orderBy: { family: 'asc' } }),
      ]);
      const activity = await loadWorkersActivity(c, workers.map((w) => w.workerId), now);
      return {
        workers: workers.map((w) => ({
          ...w,
          __inEffect: recordInEffect(w, now, activity.get(w.workerId)?.lastActiveAt ?? null),
        })),
        families: families.map((f) => ({ ...f, __inEffect: recordInEffect(f, now) })),
      };
    }),
};

// ── Field resolvers ───────────────────────────────────────────────────────

export const agentTaskAlarmFieldResolvers = {
  /** Merged into T1's AgentTeamEvent block in resolvers.ts. */
  AgentTeamEvent: {
    /** cor:agt:050:19 — who this alarm wakes and when; null for an ordinary event. */
    wakes: async (e: { id: string; severity: string | null; chain: unknown }, _: unknown, ctx: Context) => {
      if (e.severity !== 'alarm') return null;
      const rows = await ctx.db.agentTeamAlarmSchedule.findMany({ where: { eventId: e.id }, orderBy: { chainIndex: 'asc' } });
      const chain = Array.isArray(e.chain) ? (e.chain as { workerId?: string; userId?: string }[]) : [];
      return rows.map((w) => ({ ...w, __party: chain[w.chainIndex] ?? null }));
    },
  },
  AgentTeamAlarmSchedule: {
    owner: (w: { __party: { workerId?: string; userId?: string } | null }, _: unknown, ctx: Context) =>
      w.__party ? partyView(ctx, w.__party.workerId ?? null, w.__party.workerId ? null : w.__party.userId ?? null) : null,
  },
  WorkerAvailability: {
    worker: (r: WorkerAvailabilityRow, _: unknown, ctx: Context) => partyView(ctx, r.workerId, null),
    state: (r: WorkerAvailabilityRow) => toGqlWord(r.state),
    reason: (r: WorkerAvailabilityRow) => (r.reason ? toGqlWord(r.reason) : null),
    setBy: (r: WorkerAvailabilityRow) => toGqlWord(r.setBy),
    setByParty: (r: WorkerAvailabilityRow, _: unknown, ctx: Context) =>
      partyView(ctx, r.setByWorkerId, r.setByWorkerId ? null : r.setByUserId),
    inEffect: async (r: WorkerAvailabilityRow, _: unknown, ctx: Context) => {
      if (r.__inEffect !== undefined) return r.__inEffect;
      const now = new Date();
      const activity = await loadWorkersActivity(ctx, [r.workerId], now);
      return recordInEffect(r, now, activity.get(r.workerId)?.lastActiveAt ?? null);
    },
  },
  ModelFamilyAvailability: {
    state: (r: ModelFamilyAvailabilityRow) => toGqlWord(r.state),
    reason: (r: ModelFamilyAvailabilityRow) => (r.reason ? toGqlWord(r.reason) : null),
    setBy: (r: ModelFamilyAvailabilityRow, _: unknown, ctx: Context) =>
      partyView(ctx, r.setByWorkerId, r.setByWorkerId ? null : r.setByUserId),
    inEffect: (r: ModelFamilyAvailabilityRow) => r.__inEffect ?? recordInEffect(r, new Date()),
  },
};
