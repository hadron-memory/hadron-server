/**
 * #2022 (S6) — stop signals on the wire (cor:agt:090): `setTeamStopSignal`, `liftTeamStopSignal`, `teamStopSignals`.
 * The MCP twins (`src/mcp/stopSignalTools.ts`) call these resolvers, so the gates and refusals are one.
 *
 * Who may (cor:agt:090:06, Holger plan r2 R1; Vera's receipt §2):
 * - **Whoever manages the App** (`managesApp`, through `actorManagesApp`): any level at any scope, and lift any signal.
 *   A person acting as themselves only: impersonation never manages.
 * - **A host key** (`host:operate`, cor:agt:070:04): a `halt` on its OWN host only, the host taken from the key's
 *   binding and never from the request (a named host that isn't the key's refuses); and lift a `halt` on its own
 *   host (Proposed). Every call is recorded as a host-key use with action `stop`, refusals included (cor:agt:070:07).
 * - **Not yet (#2173, R95):** until the stop-notice lane is in effect, setting ANY signal answers STOP_SIGNAL_UNAVAILABLE.
 * - **A worker's session** acts with the worker's own rights, never its holder's (H26 reading A, Proposed): refused.
 *
 * Who may see (090:07, Proposed): a person who participates in the App sees every signal; a worker through its own
 * session sees the live signals that cover it; a host key sees the signals on its own host. An absent signal and one
 * the caller may not see answer the same STOP_SIGNAL_NOT_FOUND.
 *
 * Each write runs in one transaction: authority anchors, then the App's stop fence EXCLUSIVE (before the reportsTo
 * graph lock: `inTaskWriteTx`'s `stopFence`), then the rights re-checked under them, so a manager demoted or a key
 * revoked a moment before is refused. After the commit, matching runs for the App (090:05: what a signal stopped
 * resumes; cor:agt:060:10, Proposed), and its failure never fails the write.
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import {
  actorManagesApp, inTaskWriteTx, resolveParticipatedApp, resolveTaskActor, resolveTaskWorkerId, taskError,
  type TaskActor, type TaskApp,
} from './resolvers.agentTask.js';
import { hostKeyEntry, recordingRefusal } from './resolvers.hostOperation.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { eventActor } from '../../../lib/agentTasks/events.js';
import { matchAfterChange } from '../../../lib/agentTasks/matcher.js';
import { keyHostId, recordHostKeyUse } from '../../../lib/hostOperations/hostKey.js';
import { currentActor } from '../../../lib/requestActor.js';
import { lockStopFence, isLive, coveringSignals, SIGNAL_COLUMNS, type StopLevel, type StopScope, type StopSignal } from '../../../lib/stopSignals/state.js';
import { liftStopSignal, setStopSignal } from '../../../lib/stopSignals/lifecycle.js';
import { s6NoticesAvailable } from '../../../lib/stopSignals/delivery.js';
import type { StopActor } from '../../../lib/stopSignals/notices.js';
import { Prisma as P } from '../../../generated/prisma/index.js';

const LEVEL_IN: Record<string, StopLevel> = { PAUSE_DISPATCH: 'pause-dispatch', PAUSE: 'pause', HALT: 'halt' };
const LEVEL_OUT: Record<StopLevel, string> = { 'pause-dispatch': 'PAUSE_DISPATCH', pause: 'PAUSE', halt: 'HALT' };
const SCOPE_IN: Record<string, StopScope> = { WORKER: 'worker', TEAM: 'team', HOST: 'host' };

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
/**
 * #2173 (S6d, R95): a stop signal must not take effect before a consumer can tell the worker. Enforcement is live while
 * the notice lane is dark (#2166), so setting ANY signal (every level, every scope, a person or a host key) is refused
 * until the lane is in effect, behind the SAME switch the notice delivery reads (`s6NoticesAvailable`): the change that
 * turns #2169 on lifts this refusal with it. Lifting and listing are unaffected, and a signal recorded before is untouched.
 * Placed AFTER the caller's own gates (manager, host scope), so only a caller who could have set one learns the lane state.
 */
const stopSignalUnavailable = (): GraphQLError =>
  taskError(
    'STOP_SIGNAL_UNAVAILABLE',
    'Stop signals cannot be set yet: a stopped worker would not be told (R95), because the stop-notice lane is not in effect (hadron-server#2169). ' +
      'The refusal lifts when the notice lane is turned on. Lifting a signal and listing signals still work.',
  );
const requireNoticeLane = (): void => { if (!s6NoticesAvailable()) throw stopSignalUnavailable(); };

const notFound = (): GraphQLError => taskError('STOP_SIGNAL_NOT_FOUND', 'No stop signal with that id in this App.');
const targetNotFound = (): GraphQLError => taskError('STOP_SIGNAL_NOT_FOUND', 'No such worker or host in this App.');
const managerRequired = (): GraphQLError =>
  taskError('APP_MANAGER_REQUIRED', 'Only whoever manages this App sets or lifts a stop signal.', { right: 'manage-app' });
const hostScopeRequired = (): GraphQLError =>
  taskError('HOST_SCOPE_REQUIRED', "A host key sets or lifts a stop signal only on its own host, taken from the key's binding. Omit host: this key's host is used.", { right: 'own-host' });
const scopeForbidden = (): GraphQLError =>
  taskError('STOP_SIGNAL_SCOPE_FORBIDDEN', 'A host key sets or lifts only a HALT, on its own host: no other level, and no WORKER or TEAM scope.', { right: 'host-halt-only' });
const workerSession = (): GraphQLError =>
  taskError('APP_MANAGER_REQUIRED', "A worker's session acts with the worker's own rights, which don't include stop signals. Retry with a plain session (hadron_start_session with no worker) as a person who manages the App.", { right: 'manage-app' });

export type SetTeamStopSignalInput = {
  appRef: string;
  level: string;
  scope: string;
  worker?: string | null;
  host?: string | null;
  until?: Date | string | null;
};

/** The scalar view: ids, levels, times. No nested App, key or host object (Dara's attach; #552). */
export type StopSignalView = {
  id: string;
  level: string;
  scope: string;
  targetWorkerId: string | null;
  targetHostId: string | null;
  setAt: Date;
  until: Date | null;
  setByUserId: string | null;
  setByHostKey: boolean;
  live: boolean;
  endedAt: Date | null;
  endKind: string | null;
  endedByUserId: string | null;
  endedByHostKey: boolean;
};

async function viewOf(db: Pick<Prisma.TransactionClient, 'hostRegistration'>, s: StopSignal, now: Date): Promise<StopSignalView> {
  const host = s.targetHostRegistrationId
    ? (await db.hostRegistration.findUnique({ where: { id: s.targetHostRegistrationId }, select: { hostId: true } }))?.hostId ?? null
    : null;
  return {
    id: s.id,
    level: LEVEL_OUT[s.level],
    scope: s.scope.toUpperCase(),
    targetWorkerId: s.targetWorkerId,
    targetHostId: host,
    setAt: s.setAt,
    until: s.until,
    setByUserId: s.setByUserId,
    setByHostKey: s.setByAppKeyId !== null,
    live: isLive(s, now),
    endedAt: s.endedAt ?? (s.until && s.until.getTime() <= now.getTime() ? s.until : null),
    endKind: s.endKind ? s.endKind.toUpperCase() : (s.until && s.until.getTime() <= now.getTime() ? 'EXPIRED' : null),
    endedByUserId: s.endedByUserId,
    endedByHostKey: s.endedByAppKeyId !== null,
  };
}

function parseLevel(raw: unknown): StopLevel {
  const l = typeof raw === 'string' ? LEVEL_IN[raw] : undefined;
  if (!l) throw badInput('level is one of PAUSE_DISPATCH, PAUSE, HALT.');
  return l;
}

function parseScope(raw: unknown): StopScope {
  const s = typeof raw === 'string' ? SCOPE_IN[raw] : undefined;
  if (!s) throw badInput('scope is one of WORKER, TEAM, HOST.');
  return s;
}

/** The until, when given: a valid time later than `now` (090:01, Proposed). */
function parseUntil(raw: unknown, now: Date): Date | null {
  if (raw === undefined || raw === null) return null;
  const d = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) throw badInput('until must be an ISO 8601 date-time.');
  if (d.getTime() <= now.getTime()) throw badInput('until must be later than now.');
  return d;
}

const trimmed = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A worker of THIS App that isn't retired, by ref, read on the transaction client; else not found. */
async function targetWorker(txCtx: Context, appId: string, ref: string): Promise<string> {
  const id = await resolveTaskWorkerId(txCtx, appId, ref);
  if (!id) throw targetNotFound();
  const row = await txCtx.db.worker.findUnique({ where: { id }, select: { appId: true, retiredAt: true } });
  if (!row || row.appId !== appId || row.retiredAt) throw targetNotFound();
  return id;
}

/** The App's registration of `hostId`, or not found. */
async function targetHost(tx: Prisma.TransactionClient, appId: string, hostId: string): Promise<string> {
  const reg = await tx.hostRegistration.findUnique({ where: { appId_hostId: { appId, hostId } }, select: { id: true } });
  if (!reg) throw targetNotFound();
  return reg.id;
}

/** The person path's gate: a person in the App, never a worker's session (H26 A). */
async function personEntry(ctx: Context, appRef: string): Promise<{ app: TaskApp; actor: Extract<TaskActor, { kind: 'user' }> }> {
  const { app, actor } = await resolveParticipatedApp(ctx, appRef);
  if (actor.kind !== 'user' || currentActor().workerId) throw workerSession();
  return { app, actor };
}

async function afterCommit(ctx: Context, appId: string): Promise<void> {
  await matchAfterChange(ctx.db as never, appId);
}

export const stopSignalMutations = {
  /** cor:agt:090:01, :06 — set a stop signal. Refusals: see the file header. */
  setTeamStopSignal: (_: unknown, a: { input: SetTeamStopSignalInput }, ctx: Context): Promise<StopSignalView> =>
    keyRecorded(ctx, 'stop', () => setSignal(a.input, ctx)),
  liftTeamStopSignal: (_: unknown, a: { appRef: string; id: string }, ctx: Context): Promise<{ signal: StopSignalView; changed: boolean }> =>
    keyRecorded(ctx, 'stop', () => liftSignal(a.appRef, a.id, ctx)),
};

/**
 * #2022 (Ralion #2166 §10 P2-1, cor:agt:070:07): every call by a host key is recorded, its refusals included. The
 * WHOLE call runs inside the recording, input validation too, so a malformed host-key call is a recorded refusal.
 */
function keyRecorded<T>(ctx: Context, action: 'stop' | 'read', fn: () => Promise<T>): Promise<T> {
  return appKeyCaller(ctx) ? recordingRefusal(ctx, action, null, fn) : fn();
}

/** cor:agt:090:01, :06 — set a stop signal. Refusals: see the file header. */
async function setSignal(input: SetTeamStopSignalInput, ctx: Context): Promise<StopSignalView> {
  const level = parseLevel(input?.level);
  const scope = parseScope(input?.scope);
  const workerRef = trimmed(input?.worker);
  const hostRef = trimmed(input?.host);
  if (scope === 'host' && workerRef) throw badInput('A host signal names a host, not a worker.');
  if (scope !== 'host' && hostRef) throw badInput('A worker or team signal names a worker, not a host.');

  if (appKeyCaller(ctx)) {
    return (async () => {
      const { app, host, authorize } = await hostKeyEntry(ctx, input.appRef);
      if (level !== 'halt' || scope !== 'host') throw scopeForbidden();
      if (hostRef && hostRef !== host.hostId) throw hostScopeRequired();
      requireNoticeLane(); // #2173: after the key's own gates, inside the recorded call, so the refusal is a recorded stop use
      const view = await ctx.db.$transaction(async (tx) => {
        await authorize(tx);
        await lockStopFence(tx, app.id, 'exclusive');
        const now = new Date();
        const until = parseUntil(input.until, now);
        const regId = await targetHost(tx, app.id, host.hostId);
        await recordHostKeyUse(tx, host, 'stop', { count: 1 });
        const s = await setStopSignal(tx, {
          appId: app.id, level, scope, targetWorkerId: null, targetHostRegistrationId: regId, until,
          by: { appKeyId: host.appKeyId },
        }, now);
        return viewOf(tx, s, now);
      });
      await afterCommit(ctx, app.id);
      return view;
    })();
  }

  if (scope === 'host' ? !hostRef : !workerRef) {
    throw badInput(scope === 'host' ? 'A host signal names its host.' : 'A worker or team signal names its worker.');
  }
  const { app, actor } = await personEntry(ctx, input.appRef);
  const view = await inTaskWriteTx(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
    if (!(await actorManagesApp(txCtx, fresh, actor))) throw managerRequired();
    requireNoticeLane(); // #2173: after the manager gate, before anything is read or written
    const now = new Date();
    const until = parseUntil(input.until, now);
    const targetWorkerId = scope === 'host' ? null : await targetWorker(txCtx, fresh.id, workerRef as string);
    const targetHostRegistrationId = scope === 'host' ? await targetHost(tx, fresh.id, hostRef as string) : null;
    const by: StopActor = { userId: actor.userId, actor: eventActor(actor.userId) };
    const s = await setStopSignal(tx, { appId: fresh.id, level, scope, targetWorkerId, targetHostRegistrationId, until, by }, now);
    return viewOf(tx, s, now);
  }, { stopFence: 'exclusive' });
  await afterCommit(ctx, app.id);
  return view;
}

/**
 * cor:agt:090:05, :06 — lift a signal. `changed` is false when it had already ended: nothing is written and nobody
 * gets a second notice. Lifting one signal never ends another (R69).
 */
async function liftSignal(appRef: string, id: string, ctx: Context): Promise<{ signal: StopSignalView; changed: boolean }> {
  if (typeof id !== 'string' || !id.trim()) throw badInput('id is required.');
  if (appKeyCaller(ctx)) {
    return (async () => {
      const { app, host, authorize } = await hostKeyEntry(ctx, appRef);
      const out = await ctx.db.$transaction(async (tx) => {
        await authorize(tx);
        await lockStopFence(tx, app.id, 'exclusive');
        const s = await signalInApp(tx, app.id, id);
        // Its own host's halt only; any other signal is not the key's to see, so it is "not found".
        const own = s && s.scope === 'host' && s.targetHostRegistrationId === (await targetHostOrNull(tx, app.id, host.hostId));
        if (!s || !own) throw notFound();
        if (s.level !== 'halt') throw scopeForbidden();
        await recordHostKeyUse(tx, host, 'stop', { count: 1 });
        const now = new Date();
        const r = await liftStopSignal(tx, s.id, { appKeyId: host.appKeyId }, now);
        return { signal: await viewOf(tx, r.signal, now), changed: r.changed };
      });
      if (out.changed) await afterCommit(ctx, app.id);
      return out;
    })();
  }
  const { app, actor } = await personEntry(ctx, appRef);
  const out = await inTaskWriteTx(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
    const s = await signalInApp(tx, fresh.id, id);
    if (!s) throw notFound();
    if (!(await actorManagesApp(txCtx, fresh, actor))) throw managerRequired();
    const now = new Date();
    const r = await liftStopSignal(tx, s.id, { userId: actor.userId, actor: eventActor(actor.userId) }, now);
    return { signal: await viewOf(tx, r.signal, now), changed: r.changed };
  }, { stopFence: 'exclusive' });
  if (out.changed) await afterCommit(ctx, app.id);
  return out;
}

async function signalInApp(tx: Prisma.TransactionClient, appId: string, id: string): Promise<StopSignal | null> {
  const [s] = await tx.$queryRaw<StopSignal[]>(P.sql`SELECT ${SIGNAL_COLUMNS} FROM team_stop_signals s WHERE s.id = ${id} AND s.app_id = ${appId}`);
  return s ?? null;
}

async function targetHostOrNull(tx: Prisma.TransactionClient, appId: string, hostId: string): Promise<string | null> {
  return (await tx.hostRegistration.findUnique({ where: { appId_hostId: { appId, hostId } }, select: { id: true } }))?.id ?? null;
}

type ListArgs = { appRef: string; worker?: string | null; includeEnded?: boolean | null; first?: number | null; after?: string | null };

function decodeCursor(after: string | null | undefined): { setAt: Date; id: string } | null {
  if (!after) return null;
  try {
    const [t, id] = Buffer.from(after, 'base64url').toString('utf8').split('|');
    const setAt = new Date(t ?? '');
    if (!id || Number.isNaN(setAt.getTime())) throw new Error('bad');
    return { setAt, id };
  } catch {
    throw badInput('after is not a cursor this list issued.');
  }
}

const encodeCursor = (s: { setAt: Date; id: string }): string => Buffer.from(`${s.setAt.toISOString()}|${s.id}`).toString('base64url');

export const stopSignalQueries = {
  /**
   * cor:agt:090:07 — an App's stop signals, oldest set first, a page at a time. A person in the App sees all of them
   * (`worker` narrows to the signals covering that worker now); a worker's session sees the live ones covering it; a
   * host key sees its own host's. `includeEnded` adds ended signals for people and host keys.
   */
  teamStopSignals: (_: unknown, args: ListArgs, ctx: Context) => keyRecorded(ctx, 'read', () => listSignals(args, ctx)),
};

async function listSignals(args: ListArgs, ctx: Context) {
  const take = Math.min(Math.max(args.first ?? PAGE_DEFAULT, 1), PAGE_MAX);
  const cursor = decodeCursor(args.after);
  const now = new Date();

  let appId: string;
  let filter: P.Sql;
  const key = appKeyCaller(ctx);
  let db: Prisma.TransactionClient | Context['db'] = ctx.db;
  if (key) {
    const { app, host, authorize } = await hostKeyEntry(ctx, args.appRef);
    appId = app.id;
    return ctx.db.$transaction(async (tx) => {
      await authorize(tx);
      const hostId = await keyHostId(tx, key);
      const reg = hostId ? await targetHostOrNull(tx, app.id, hostId) : null;
      const f = reg ? P.sql`s.scope = 'host' AND s.target_host_registration_id = ${reg}` : P.sql`false`;
      const out = await page(tx, appId, f, args.includeEnded === true, take, cursor, now);
      // cor:agt:070:07: a host key's read is a use too, recorded in the read's own transaction.
      await recordHostKeyUse(tx, host, 'read', { count: out.signals.length });
      return out;
    });
  }
  const { app } = await resolveParticipatedApp(ctx, args.appRef);
  appId = app.id;
  const actor = await resolveTaskActor(ctx, app);
  const selfWorker = currentActor().workerId;
  if (actor?.kind === 'worker' || selfWorker) {
    // A worker sees what covers it, live, never another worker's signals (090:07).
    const me = (actor?.kind === 'worker' ? actor.workerId : selfWorker) as string;
    const covering = (await coveringSignals(db, app.id, [me], now)).get(me) ?? [];
    const ids = covering.map((s) => s.id);
    filter = ids.length ? P.sql`s.id IN (${P.join(ids)})` : P.sql`false`;
    return page(db, appId, filter, false, take, cursor, now);
  }
  filter = P.sql`true`;
  if (trimmed(args.worker)) {
    const wid = await resolveTaskWorkerId(ctx, app.id, trimmed(args.worker) as string);
    const covering = wid ? (await coveringSignals(db, app.id, [wid], now)).get(wid) ?? [] : [];
    const ids = covering.map((s) => s.id);
    filter = ids.length ? P.sql`s.id IN (${P.join(ids)})` : P.sql`false`;
  }
  return page(db, appId, filter, args.includeEnded === true, take, cursor, now);
}

async function page(
  db: Prisma.TransactionClient | Context['db'],
  appId: string,
  filter: P.Sql,
  includeEnded: boolean,
  take: number,
  cursor: { setAt: Date; id: string } | null,
  now: Date,
) {
  const live = includeEnded ? P.sql`true` : P.sql`s.ended_at IS NULL AND (s.until IS NULL OR s.until > ${now.toISOString().replace('Z', '')}::timestamp)`;
  const after = cursor ? P.sql`(s.set_at, s.id) > (${cursor.setAt.toISOString().replace('Z', '')}::timestamp, ${cursor.id})` : P.sql`true`;
  const rows = await (db as Prisma.TransactionClient).$queryRaw<StopSignal[]>(P.sql`
    SELECT ${SIGNAL_COLUMNS} FROM team_stop_signals s
    WHERE s.app_id = ${appId} AND ${filter} AND ${live} AND ${after}
    ORDER BY s.set_at, s.id LIMIT ${take + 1}`);
  const more = rows.length > take;
  const list = rows.slice(0, take);
  const signals = [];
  for (const s of list) signals.push(await viewOf(db as Prisma.TransactionClient, s, now));
  const last = list[list.length - 1];
  return { signals, pageInfo: { hasNextPage: more, endCursor: last ? encodeCursor(last) : null } };
}
