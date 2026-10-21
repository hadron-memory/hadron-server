// Tickers — #1747 (Tickers S1, epic #1659; plan hrn:node:hadronmemory.com:hadron-server:design:named-heartbeats).
//
// An App owns TICKERS: named, cadenced wake schedules. Workers SUBSCRIBE to the
// ones they want (cor:agt:080:02). S1 is the data and the authority over it:
// the models, the CRUD, who may subscribe whom, the may-subscribe-workers
// grant and its announcement. Nothing READS a subscription until S2 (due wakes)
// and nobody is subscribed until S4's seed, so behaviour is unchanged.
//
// THE ACTOR is the agent-task actor (resolveTaskActor, #1705): a worker through
// its session, with a person behind the request, or a person as themselves. A
// bare App key is refused (it is concealed as "App not found"). EVERY WRITE
// re-gates inside its transaction (`inTaskWriteTx`): the authority anchors
// SHARED, the actor re-resolved on the transaction client, then the decision
// below on rows locked in that transaction. `managesApp` counts a person acting
// as themselves only.
//
// AUTHORIZATION (src/lib/tickers/policy.ts holds the pure matrix):
//   create          any App participant, or a session bound to a worker of the
//                   App, up to the App's live-ticker cap (cor:agt:080:18)
//   edit/delete     the owner, the holder of the owning worker, whoever manages
//   settings        whoever manages the App (080:19)
//   subscribe       its holder, whoever manages; the worker itself, only at or
//                   below the self-subscription cadence (R3); the grant holder
//                   for OTHER workers (N1), with a person behind it (N2) (080:20)
//   wake settings   the worker itself, its holder, whoever manages (080:21)
//   grant/revoke    whoever manages the App (080:24)
//
// CONCEALMENT: a ticker or App the caller cannot reach reads as TICKER_NOT_FOUND
// / APP_NOT_FOUND, never Forbidden — no existence oracle over ids.
//
// S2 (#1748) adds Ticker.nextTickAt/lastTickAt and WorkerWakeSettings.dormant
// (tick and dormancy are decided once, in src/lib/tickers). NOT BUILT: the owner
// succession of cor:agt:080:18 (Proposed).

import { s7Available } from '../../../lib/tickers/s7Availability.js';
import { GraphQLError } from 'graphql';
import { loadDeliverySettings, parseDeliverySettingsPatch, validateDeliverySettings, type DeliverySettings } from '../../../lib/tickers/deliverySettings.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context, getAccessibleMemoryIds } from './resolvers.helpers.js';
import {
  type TaskApp,
  type TaskActor,
  actorManagesApp,
  inTaskWriteTx,
  loadApp,
  requireWritable,
  resolveParticipatedApp,
  resolveTaskActor,
  taskError,
} from './resolvers.agentTask.js';
import { composeWorkerUrn, resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { WorkerNotFoundError } from '../../../lib/entityRef/errors.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { currentActor } from '../../../lib/requestActor.js';
import { mentionTokenOf } from '../../../lib/mentionToken.js';
import { normalizeUrnForLookup } from '../../../lib/urn.js';
import {
  APP_GRANT_NAMES,
  GRANT_ENUM_TO_NAME,
  GRANT_NAME_TO_ENUM,
  GRANT_SUBSCRIBE_WORKERS,
  MENTION_WAKE,
  TICKER_CAP_CEILING,
  TICKER_CHANNELS_MAX,
  TICKER_HARD_FLOOR_SECONDS,
  TICKER_MAX_CADENCE_SECONDS,
  TICKER_NAME_MAX,
  TICKER_RELEVANCE,
  type AppGrantName,
} from '../../../lib/tickers/bounds.js';
import { decideSubscribe, mayChangeWakeSettings, mayEditTicker, type PolicyActor } from '../../../lib/tickers/policy.js';
import { defaultWakeBudget } from '../../../lib/tickers/dueWakes.js';
import { validateQuietHours } from '../../../lib/tickers/quietHours.js';
import { currentTick, nextTickAfter, tickTime } from '../../../lib/tickers/ticks.js';
import { isWorkerDormant } from '../../../lib/sessionActivity.js';
import { loadWorkersActivity } from './resolvers.worker.js';
import { nextFreeTickerSlug } from '../../../lib/tickers/tickerSlug.js';
import { TickerNotFoundError, composeTickerUrn, resolveTickerRef } from '../../../lib/tickers/tickerRef.js';

// ── Errors ────────────────────────────────────────────────────────────────

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
const tickerNotFound = (ref: string): GraphQLError => taskError('TICKER_NOT_FOUND', 'Ticker not found.', { ref });
const workerNotFound = (ref: string): GraphQLError => taskError('WORKER_NOT_FOUND', 'Worker not found.', { ref });

// ── Rows ──────────────────────────────────────────────────────────────────

type TickerRow = Prisma.TickerGetPayload<Record<string, never>>;
type SubscriptionRow = Prisma.TickerSubscriptionGetPayload<Record<string, never>>;

const toPolicyActor = (a: TaskActor): PolicyActor =>
  a.kind === 'worker' ? { kind: 'worker', workerId: a.workerId, userId: a.userId } : { kind: 'user', userId: a.userId };

function stamp(ctx: Context) {
  const a = currentActor();
  return { by: ctx.userId ?? null, byWorkerId: a.workerId, byAgentId: a.agentId };
}
function createdStamp(ctx: Context) {
  const s = stamp(ctx);
  return {
    createdBy: s.by, createdByWorkerId: s.byWorkerId, createdByAgentId: s.byAgentId,
    updatedBy: s.by, updatedByWorkerId: s.byWorkerId, updatedByAgentId: s.byAgentId,
  };
}
function updatedStamp(ctx: Context) {
  const s = stamp(ctx);
  return { updatedBy: s.by, updatedByWorkerId: s.byWorkerId, updatedByAgentId: s.byAgentId };
}

/** Run a write on an App under the shared transaction gate; a refusal is concealed as `refused()`. */
async function writeInApp<T>(
  ctx: Context,
  app: TaskApp,
  actor: TaskActor,
  refused: () => GraphQLError,
  write: (tx: Prisma.TransactionClient, txCtx: Context, fresh: TaskApp, actor: TaskActor) => Promise<T>,
  options: { lockMode?: 'shared' | 'exclusive' } = {},
): Promise<T> {
  requireWritable(ctx, app);
  return inTaskWriteTx(ctx, app, actor, refused, (tx, txCtx, fresh) => write(tx, txCtx, fresh, actor), options);
}

// ── Validation ────────────────────────────────────────────────────────────

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') throw badInput('A ticker needs a name.');
  if (name.length > TICKER_NAME_MAX) throw badInput(`A ticker name is at most ${TICKER_NAME_MAX} characters.`);
  return name;
}

type TickerSettings = {
  tickerMinCadenceSeconds: number;
  tickerSelfSubscribeCadenceSeconds: number;
  tickerLiveCap: number;
  wakeDailyBudget: number | null;
};
const SETTINGS_SELECT = {
  tickerMinCadenceSeconds: true, tickerSelfSubscribeCadenceSeconds: true, tickerLiveCap: true, wakeDailyBudget: true,
  deliveryBusyDelaySeconds: true, deliveryStuckWindowSeconds: true, deliveryStandbyEnabled: true,
  deliveryCheckPeriodSeconds: true, deliveryFailedChecksToOverdue: true,
} as const;

function checkCadence(cadence: unknown, settings: TickerSettings): number {
  if (
    typeof cadence !== 'number' || !Number.isInteger(cadence) ||
    cadence < settings.tickerMinCadenceSeconds || cadence > TICKER_MAX_CADENCE_SECONDS
  ) {
    throw taskError(
      'TICKER_CADENCE_OUT_OF_RANGE',
      `A ticker's cadence is a whole number of seconds from ${settings.tickerMinCadenceSeconds} (this App's floor) to ${TICKER_MAX_CADENCE_SECONDS}.`,
      { min: settings.tickerMinCadenceSeconds, max: TICKER_MAX_CADENCE_SECONDS },
    );
  }
  return cadence;
}

function checkQuietHours(input: unknown): Prisma.InputJsonObject {
  const v = validateQuietHours(input);
  if (!v.ok) throw taskError('TICKER_QUIET_HOURS_INVALID', v.reason);
  return v.value as unknown as Prisma.InputJsonObject;
}

/** The closed set of ticker reasons (cor:agt:080:01). Stored kebab-case; the GraphQL enum spells them in capitals. */
export const TICKER_REASONS = ['read-team-channel', 'every-tick', 'live-check'] as const;
function checkReasons(list: unknown): string[] {
  if (!Array.isArray(list) || list.length === 0) throw badInput('reasons must name at least one reason: a ticker with none would never fire.');
  const out = new Set<string>();
  for (const x of list) {
    const k = typeof x === 'string' ? x.toLowerCase().replace(/_/g, '-') : '';
    if (!(TICKER_REASONS as readonly string[]).includes(k)) throw badInput(`reasons are from: ${TICKER_REASONS.join(', ')}.`);
    out.add(k);
  }
  return TICKER_REASONS.filter((k) => out.has(k));
}
const reasonEnum = (k: string) => k.toUpperCase().replace(/-/g, '_');

function checkRelevance(r: unknown): string {
  if (typeof r !== 'string' || !(TICKER_RELEVANCE as readonly string[]).includes(r)) {
    throw badInput(`relevance is one of ${TICKER_RELEVANCE.join(', ')}.`);
  }
  return r;
}

function parseDate(value: unknown, field: string): Date {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw badInput(`${field} is not a valid date-time.`);
  return d;
}

/**
 * Channels named by a ticker must exist and be ones the caller can read. The
 * list is NEVER a grant (cor:agt:080:01): a wake intersects it with the
 * subscriber's own read gate at computation time (S2). Checking the author here
 * keeps a ticker from being a probe for channel ids.
 */
async function checkChannels(ctx: Context, ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids)) throw badInput('channelIds is a list of channel ids.');
  const unique = [...new Set(ids.map((x) => String(x)))];
  if (unique.length > TICKER_CHANNELS_MAX) throw badInput(`At most ${TICKER_CHANNELS_MAX} channels.`);
  if (unique.length === 0) return [];
  const rows = await ctx.db.channel.findMany({
    where: { id: { in: unique.filter(isId) }, deletedAt: null },
    select: { id: true, memoryId: true },
  });
  const accessible = await getAccessibleMemoryIds(ctx);
  const ok = new Set(rows.filter((r) => accessible === null || accessible.includes(r.memoryId)).map((r) => r.id));
  if (unique.some((id) => !ok.has(id))) throw badInput('A channel in channelIds does not exist or is not readable by you.');
  return unique;
}

// ── Loading ───────────────────────────────────────────────────────────────

async function appOf(ctx: Context, appId: string): Promise<TaskApp> {
  const app = await loadApp(ctx, appId);
  if (!app) throw taskError('APP_NOT_FOUND', 'App not found.');
  return app;
}

/** A ticker the caller can reach, with its App and actor — or throws TICKER_NOT_FOUND. */
async function loadReachableTicker(
  ctx: Context,
  ref: string,
  opts: { allowDeleted?: boolean } = {},
): Promise<{ ticker: TickerRow; app: TaskApp; actor: TaskActor }> {
  let id: string;
  try {
    ({ id } = await resolveTickerRef(ctx.db, ref));
  } catch (e) {
    if (e instanceof TickerNotFoundError) throw tickerNotFound(ref);
    throw e;
  }
  const ticker = await ctx.db.ticker.findUnique({ where: { id } });
  if (!ticker || (ticker.deletedAt && !opts.allowDeleted)) throw tickerNotFound(ref);
  const app = await loadApp(ctx, ticker.appId);
  if (!app) throw tickerNotFound(ref);
  const actor = await resolveTaskActor(ctx, app);
  if (!actor) throw tickerNotFound(ref);
  return { ticker, app, actor };
}

/** A worker of `appId` by id or URN. Retired workers resolve. Anything else is WORKER_NOT_FOUND. */
async function loadWorkerOf(ctx: Context, appId: string, ref: string) {
  let id: string;
  try {
    ({ id } = await resolveWorkerRef(ctx.db, ref));
  } catch (e) {
    if (e instanceof WorkerNotFoundError) throw workerNotFound(ref);
    throw e;
  }
  const worker = await ctx.db.worker.findUnique({ where: { id } });
  if (!worker || worker.appId !== appId) throw workerNotFound(ref);
  return worker;
}

async function lockTicker(tx: Prisma.TransactionClient, id: string): Promise<TickerRow | null> {
  await tx.$queryRaw`SELECT id FROM tickers WHERE id = ${id} FOR UPDATE`;
  return tx.ticker.findUnique({ where: { id } });
}

async function lockWorker(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM workers WHERE id = ${id} FOR SHARE`;
  return tx.worker.findUnique({ where: { id } });
}

/** The actor's live may-subscribe-workers grant, read FOR SHARE so a revocation orders against the write (N2). */
async function liveGrantFor(tx: Prisma.TransactionClient, appId: string, actor: TaskActor): Promise<string | null> {
  if (actor.kind !== 'worker') return null;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM app_grants
    WHERE app_id = ${appId} AND grantee_worker_id = ${actor.workerId}
      AND name = ${GRANT_SUBSCRIBE_WORKERS} AND revoked_at IS NULL
    FOR SHARE`;
  return rows[0]?.id ?? null;
}

/**
 * Serialize ticker creation, renames, cadence edits and settings changes per App,
 * so the live cap, the slug mint, the live-name rule and the cadence floor cannot
 * race. Taken BEFORE the ticker row everywhere (create and settings hold no ticker
 * row; subscribe takes the ticker row and never this), so there is no cycle.
 */
async function lockAppTickers(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tickers:${appId}`}, 0))`;
}

async function assertNameFree(tx: Prisma.TransactionClient, appId: string, name: string, exceptId?: string): Promise<void> {
  const clash = await tx.ticker.findFirst({
    where: { appId, deletedAt: null, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw taskError('TICKER_NAME_TAKEN', `This App already has a live ticker named "${name}" (names ignore case).`);
}

// ── Ticker CRUD ───────────────────────────────────────────────────────────

type TickerInput = {
  name: string;
  cadenceSeconds: number;
  anchorAt?: Date | string | null;
  quietHours?: unknown;
  channelIds?: string[] | null;
  relevance?: string | null;
  reasons?: string[] | null;
  enabled?: boolean | null;
};
type TickerPatch = Partial<TickerInput> & { clearQuietHours?: boolean | null; clearChannels?: boolean | null };

export const tickerQueries = {
  tickers: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    const { app } = await resolveParticipatedApp(ctx, appRef);
    return ctx.db.ticker.findMany({ where: { appId: app.id, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  },

  ticker: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    try {
      return (await loadReachableTicker(ctx, ref)).ticker;
    } catch (e) {
      if (e instanceof GraphQLError && e.extensions?.code === 'TICKER_NOT_FOUND') return null;
      throw e;
    }
  },

  appTickerSettings: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    const { app } = await resolveParticipatedApp(ctx, appRef);
    return settingsOut(ctx.db, app.id);
  },

  workerWakeSettings: async (_: unknown, { workerRef }: { workerRef: string }, ctx: Context) => {
    const worker = await workerForRead(ctx, workerRef);
    const row = await ctx.db.workerWakeSettings.findUnique({ where: { workerId: worker.id } });
    return wakeSettingsOut(worker.id, row);
  },
};

/** Resolve a worker the caller may see: any worker of an App the caller participates in. */
async function workerForRead(ctx: Context, ref: string) {
  let id: string;
  try {
    ({ id } = await resolveWorkerRef(ctx.db, ref));
  } catch (e) {
    if (e instanceof WorkerNotFoundError) throw workerNotFound(ref);
    throw e;
  }
  const worker = await ctx.db.worker.findUnique({ where: { id } });
  if (!worker) throw workerNotFound(ref);
  const app = await loadApp(ctx, worker.appId);
  if (!app || !(await resolveTaskActor(ctx, app))) throw workerNotFound(ref);
  return worker;
}

const crudMutations = {
  createTicker: async (_: unknown, { appRef, input }: { appRef: string; input: TickerInput }, ctx: Context) => {
    const { app, actor } = await resolveParticipatedApp(ctx, appRef);
    // Shape that needs no row, checked before the transaction.
    const name = cleanName(input.name);
    const quiet = input.quietHours == null ? null : checkQuietHours(input.quietHours);
    const channelIds = input.channelIds == null ? [] : await checkChannels(ctx, input.channelIds);
    const relevance = input.relevance == null ? 'ALL' : checkRelevance(input.relevance);
    const reasons = input.reasons == null ? ['read-team-channel'] : checkReasons(input.reasons);
    const anchorAt = input.anchorAt == null ? new Date() : parseDate(input.anchorAt, 'anchorAt');
    return writeInApp(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
      await lockAppTickers(tx, fresh.id);
      const settings = await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: SETTINGS_SELECT });
      const cadence = checkCadence(input.cadenceSeconds, settings);
      const live = await tx.ticker.count({ where: { appId: fresh.id, deletedAt: null } });
      if (live >= settings.tickerLiveCap) {
        throw taskError(
          'TICKER_LIMIT_REACHED',
          `This App has ${live} live tickers, its limit. Delete one, or ask whoever manages the App to raise the limit.`,
          { liveCap: settings.tickerLiveCap },
        );
      }
      await assertNameFree(tx, fresh.id, name);
      const slug = await nextFreeTickerSlug(tx, fresh.id, name);
      return tx.ticker.create({
        data: {
          appId: fresh.id, name, slug, cadenceSeconds: cadence, anchorAt,
          quietHours: quiet ?? Prisma.DbNull, channelIds, relevance,
          reasons,
          enabled: input.enabled ?? true,
          // The owner is whoever made the call, never an argument (cor:agt:080:18).
          ownerWorkerId: actor.kind === 'worker' ? actor.workerId : null,
          ownerUserId: actor.kind === 'user' ? actor.userId : null,
          ...createdStamp(txCtx),
        },
      });
    });
  },

  updateTicker: async (_: unknown, { ref, input }: { ref: string; input: TickerPatch }, ctx: Context) => {
    const { ticker: seen, app, actor } = await loadReachableTicker(ctx, ref);
    const name = input.name == null ? undefined : cleanName(input.name);
    if (input.quietHours != null && input.clearQuietHours) throw badInput('Send quietHours or clearQuietHours, not both.');
    if (input.channelIds != null && input.clearChannels) throw badInput('Send channelIds or clearChannels, not both.');
    const quiet = input.quietHours == null ? undefined : checkQuietHours(input.quietHours);
    const channelIds = input.channelIds == null ? undefined : await checkChannels(ctx, input.channelIds);
    const relevance = input.relevance == null ? undefined : checkRelevance(input.relevance);
    const reasons = input.reasons == null ? undefined : checkReasons(input.reasons);
    const anchorAt = input.anchorAt == null ? undefined : parseDate(input.anchorAt, 'anchorAt');
    return writeInApp(ctx, app, actor, () => tickerNotFound(ref), async (tx, txCtx, fresh) => {
      // The App-wide lock first: a rename races a create or another rename for the
      // live name, and a cadence edit races a floor change.
      await lockAppTickers(tx, fresh.id);
      const t = await lockTicker(tx, seen.id);
      if (!t || t.deletedAt) throw tickerNotFound(ref);
      await requireMayEdit(tx, txCtx, fresh, actor, t, ref);
      const settings = await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: SETTINGS_SELECT });
      let cadence: number | undefined;
      if (input.cadenceSeconds != null) cadence = checkCadence(input.cadenceSeconds, settings);
      if (name !== undefined && name.toLowerCase() !== t.name.toLowerCase()) await assertNameFree(tx, fresh.id, name, t.id);
      // A faster cadence, or a wider relevance, spends more tokens for every live
      // subscriber. Each must be one the editor could subscribe at the new terms
      // (cor:agt:080:20, R3); otherwise the edit is a way round the subscribe rule.
      const faster = cadence !== undefined && cadence < t.cadenceSeconds;
      const wider = (relevance === 'ALL' && t.relevance !== 'ALL') || (reasons !== undefined && (['every-tick', 'live-check'] as const).some((r) => reasons.includes(r) && !t.reasons.includes(r)));
      if (faster || wider) {
        await requireSubscribersCovered(tx, txCtx, fresh, actor, t, cadence ?? t.cadenceSeconds, settings);
      }
      return tx.ticker.update({
        where: { id: t.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(cadence !== undefined ? { cadenceSeconds: cadence } : {}),
          ...(anchorAt !== undefined ? { anchorAt } : {}),
          ...(quiet !== undefined ? { quietHours: quiet } : input.clearQuietHours ? { quietHours: Prisma.DbNull } : {}),
          ...(channelIds !== undefined ? { channelIds } : input.clearChannels ? { channelIds: [] } : {}),
          ...(relevance !== undefined ? { relevance } : {}),
          ...(reasons !== undefined ? { reasons } : {}),
          ...(input.enabled != null ? { enabled: input.enabled } : {}),
          ...updatedStamp(txCtx),
        },
      });
    });
  },

  deleteTicker: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const { ticker: seen, app, actor } = await loadReachableTicker(ctx, ref);
    await writeInApp(ctx, app, actor, () => tickerNotFound(ref), async (tx, txCtx, fresh) => {
      const t = await lockTicker(tx, seen.id);
      if (!t || t.deletedAt) throw tickerNotFound(ref);
      await requireMayEdit(tx, txCtx, fresh, actor, t, ref);
      const now = new Date();
      const s = stamp(txCtx);
      await tx.ticker.update({
        where: { id: t.id },
        data: { deletedAt: now, deletedBy: s.by, deletedByWorkerId: s.byWorkerId, deletedByAgentId: s.byAgentId, ...updatedStamp(txCtx) },
      });
      // A deleted ticker ends its subscriptions; the rows stay as history.
      await tx.tickerSubscription.updateMany({
        where: { tickerId: t.id, endedAt: null },
        data: {
          endedAt: now, endedReason: 'TICKER_DELETED',
          endedBy: s.by, endedByWorkerId: s.byWorkerId, endedByAgentId: s.byAgentId,
        },
      });
    });
    return true;
  },

  setAppTickerSettings: async (
    _: unknown,
    { appRef, input }: { appRef: string; input: AppTickerSettingsPatch },
    ctx: Context,
  ) => (await writeAppSettings(ctx, appRef, input)).ticker,

};

/**
 * Every live subscriber must be one the editor could subscribe at `cadence`
 * (cor:agt:080:20 re-run, R3). The ticker row is already locked, so no subscribe
 * can add one meanwhile; worker rows are taken SHARED in id order, after the ticker
 * row, as `changeSubscription` does.
 */
async function requireSubscribersCovered(
  tx: Prisma.TransactionClient,
  txCtx: Context,
  app: TaskApp,
  actor: TaskActor,
  ticker: TickerRow,
  cadence: number,
  settings: TickerSettings,
): Promise<void> {
  const subs = await tx.tickerSubscription.findMany({
    where: { tickerId: ticker.id, endedAt: null },
    select: { workerId: true },
    orderBy: { workerId: 'asc' },
  });
  if (!subs.length) return;
  const manages = await actorManagesApp(txCtx, app, actor);
  // The grant does not count here (Rook, #1750 delta): it is for subscribing OTHER
  // workers, announced to their holders; a speed-up it paid for would not be.
  const hasGrant = false;
  const refused: string[] = [];
  for (const { workerId } of subs) {
    const w = await lockWorker(tx, workerId);
    if (!w) continue;
    const d = decideSubscribe({
      actor: toPolicyActor(actor), manages, op: 'subscribe',
      target: { id: w.id, heldByUserId: w.heldByUserId },
      tickerCadenceSeconds: cadence,
      selfSubscribeCadenceSeconds: settings.tickerSelfSubscribeCadenceSeconds,
      hasGrant,
    });
    if (!d.allow) refused.push(w.name);
  }
  if (refused.length) {
    throw taskError(
      'TICKER_CADENCE_NEEDS_CONSENT',
      `That change makes this ticker cost more for ${refused.join(', ')}, and you could not subscribe ${refused.length === 1 ? 'that worker' : 'those workers'} to it at the new terms. ` +
        'Ask whoever holds them, or whoever manages the App, to make the change or to unsubscribe them first.',
      { workers: refused },
    );
  }
}

/** The edit gate for a ticker, decided on the locked row inside the transaction. */
async function requireMayEdit(
  tx: Prisma.TransactionClient,
  txCtx: Context,
  app: TaskApp,
  actor: TaskActor,
  ticker: TickerRow,
  ref: string,
): Promise<void> {
  const manages = await actorManagesApp(txCtx, app, actor);
  // The owning worker's hold is read under a row lock: a release in flight either
  // commits first (and this edit is refused) or waits behind this write, so the
  // transaction never commits on holder authority already revoked.
  const holder = ticker.ownerWorkerId ? (await lockWorker(tx, ticker.ownerWorkerId))?.heldByUserId ?? null : null;
  if (!mayEditTicker({ actor: toPolicyActor(actor), manages, ticker, ownerWorkerHolderUserId: holder })) {
    // A participant who may SEE the ticker (080:18) is told why; the ref was already reachable.
    throw taskError('FORBIDDEN', 'Only the ticker\'s owner, its owning worker\'s holder, or whoever manages the App can change it.', { ref });
  }
}

type AppTickerSettingsPatch = {
  minCadenceSeconds?: number | null;
  selfSubscribeCadenceSeconds?: number | null;
  liveCap?: number | null;
  wakeDailyBudget?: number | null;
  clearWakeDailyBudget?: boolean | null;
};

/** #2025: both settings entry points use one manager/lock/validation/write transaction.
 * The App anchor is EXCLUSIVE before any other row, preserving existing ticker lock order.
 * Return the persisted projections while the deciding authority is still held.
 */
export async function writeAppSettings(
  ctx: Context, appRef: string, input: AppTickerSettingsPatch, rawDeliveryPatch?: unknown,
) {
  const { app, actor } = await resolveParticipatedApp(ctx, appRef);
  if (input.wakeDailyBudget != null && input.clearWakeDailyBudget) {
    throw badInput('Send wakeDailyBudget or clearWakeDailyBudget, not both.');
  }
  return writeInApp(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
    // cor:agt:080:19: whoever manages the App. Anyone else who can see the App is told so.
    if (!(await actorManagesApp(txCtx, fresh, actor))) {
      throw taskError('FORBIDDEN', 'Only whoever manages this App can change its settings.');
    }
    const patch = rawDeliveryPatch === undefined ? {} : parseDeliverySettingsPatch(rawDeliveryPatch);
    await lockAppTickers(tx, fresh.id);
    const cur = await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: SETTINGS_SELECT });
    const floor = patch.batchWindowSeconds ?? input.minCadenceSeconds ?? cur.tickerMinCadenceSeconds;
    const self = input.selfSubscribeCadenceSeconds ?? cur.tickerSelfSubscribeCadenceSeconds;
    const cap = input.liveCap ?? cur.tickerLiveCap;
    const budget = input.clearWakeDailyBudget ? null : input.wakeDailyBudget ?? cur.wakeDailyBudget;
    const out = (message: string) => taskError('TICKER_SETTINGS_OUT_OF_RANGE', message);
    const whole = (n: number) => Number.isInteger(n);
    if (!whole(floor) || floor < TICKER_HARD_FLOOR_SECONDS) {
      throw out(`The cadence floor is a whole number of seconds, at least ${TICKER_HARD_FLOOR_SECONDS}.`);
    }
    if (!whole(self) || self < floor || self > TICKER_MAX_CADENCE_SECONDS) {
      throw out(`The self-subscription cadence is between the floor (${floor}) and ${TICKER_MAX_CADENCE_SECONDS} seconds.`);
    }
    if (!whole(cap) || cap < 1 || cap > TICKER_CAP_CEILING) throw out(`The live-ticker cap is from 1 to ${TICKER_CAP_CEILING}.`);
    if (budget !== null && (!whole(budget) || budget < 0)) throw out('The daily wake budget is a whole number, 0 or more.');
    // Raising the floor above a live ticker's cadence is refused, naming the
    // tickers in the way, so none is ever silently out of bounds.
    if (floor > cur.tickerMinCadenceSeconds) {
      const inTheWay = await tx.ticker.findMany({
        where: { appId: fresh.id, deletedAt: null, cadenceSeconds: { lt: floor } },
        select: { name: true, slug: true, cadenceSeconds: true },
        orderBy: { name: 'asc' },
      });
      if (inTheWay.length) {
        throw taskError(
          'TICKER_SETTINGS_CONFLICT',
          `The floor ${floor}s is above the cadence of: ${inTheWay.map((t) => `${t.name} (${t.cadenceSeconds}s)`).join(', ')}. Slow or delete them first.`,
          { tickers: inTheWay.map((t) => t.slug) },
        );
      }
    }
    const delivery: DeliverySettings = {
      batchWindowSeconds: floor,
      busyDelaySeconds: patch.busyDelaySeconds ?? cur.deliveryBusyDelaySeconds,
      stuckWindowSeconds: patch.stuckWindowSeconds ?? cur.deliveryStuckWindowSeconds,
      standbyEnabled: patch.standbyEnabled ?? cur.deliveryStandbyEnabled,
      standbyEffective: false,
      checkPeriodSeconds: patch.checkPeriodSeconds ?? cur.deliveryCheckPeriodSeconds,
      failedChecksToOverdue: patch.failedChecksToOverdue ?? cur.deliveryFailedChecksToOverdue,
    };
    validateDeliverySettings(delivery, patch);
    await tx.app.update({
      where: { id: fresh.id },
      data: {
        tickerMinCadenceSeconds: floor, tickerSelfSubscribeCadenceSeconds: self,
        tickerLiveCap: cap, wakeDailyBudget: budget,
        deliveryBusyDelaySeconds: delivery.busyDelaySeconds,
        deliveryStuckWindowSeconds: delivery.stuckWindowSeconds,
        deliveryStandbyEnabled: delivery.standbyEnabled,
        deliveryCheckPeriodSeconds: delivery.checkPeriodSeconds,
        deliveryFailedChecksToOverdue: delivery.failedChecksToOverdue,
      },
    });
    return { ticker: await settingsOut(tx, fresh.id), delivery: await loadDeliverySettings(tx, fresh.id) };
  }, { lockMode: 'exclusive' });
}

/**
 * #2138 §3.6 — the TEAM pause: a flag on the App, separate from every worker's own `pausedUntil`. Whoever manages the App
 * sets or clears it; a worker (whose session is the acting principal) cannot lift it, and ending it never touches a
 * self-pause. Idempotent: pausing an already-paused team keeps the original time, clearing an unpaused team is a no-op.
 */
export async function writeTeamPause(ctx: Context, appRef: string, paused: boolean) {
  const { app, actor } = await resolveParticipatedApp(ctx, appRef);
  return writeInApp(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
    if (!(await actorManagesApp(txCtx, fresh, actor))) {
      throw taskError('FORBIDDEN', 'Only whoever manages this App can pause or resume the team.');
    }
    const cur = await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: { teamPausedAt: true } });
    if (paused && !cur.teamPausedAt) await tx.app.update({ where: { id: fresh.id }, data: { teamPausedAt: new Date() } });
    if (!paused && cur.teamPausedAt) await tx.app.update({ where: { id: fresh.id }, data: { teamPausedAt: null, teamResumedAt: new Date() } }); // the end restarts every worker's check clock
    return { teamPausedAt: (await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: { teamPausedAt: true } })).teamPausedAt };
  }, { lockMode: 'exclusive' });
}

// ── Settings projections ──────────────────────────────────────────────────

async function settingsOut(db: Pick<Context['db'], 'app' | 'worker'>, appId: string) {
  const s = await db.app.findUniqueOrThrow({ where: { id: appId }, select: SETTINGS_SELECT });
  let budget = s.wakeDailyBudget;
  const derived = budget === null;
  if (derived) {
    // cor:agt:080:05 (Decided, Q11): the roster (workers not retired) x (86,400 / self-subscribe cadence) x 2.
    // The same number the wake enforcement uses (src/lib/tickers/dueWakes.ts), so the settings never disagree with it.
    const roster = await db.worker.count({ where: { appId, retiredAt: null } });
    budget = defaultWakeBudget(roster, s.tickerSelfSubscribeCadenceSeconds);
  }
  return {
    minCadenceSeconds: s.tickerMinCadenceSeconds,
    selfSubscribeCadenceSeconds: s.tickerSelfSubscribeCadenceSeconds,
    liveCap: s.tickerLiveCap,
    dailyWakeBudget: budget as number,
    dailyWakeBudgetDerived: derived,
  };
}

type WakeSettingsRow = {
  mentions: string; pausedUntil: Date | null;
  isolatedUntil?: Date | null; isolatedAt?: Date | null; isolatedByUserId?: string | null;
};
function wakeSettingsOut(workerId: string, row: WakeSettingsRow | null) {
  return {
    workerId, mentions: row?.mentions ?? 'IMMEDIATE', pausedUntil: row?.pausedUntil ?? null,
    // Inert until S7b: a stored isolation projects as none, matching its (absent) effect.
    isolatedUntil: s7Available() ? row?.isolatedUntil ?? null : null, isolatedAt: s7Available() ? row?.isolatedAt ?? null : null,
    isolatedByUserId: s7Available() ? row?.isolatedByUserId ?? null : null,
  };
}

// ── Isolation (S7, #2023, R85) ─────────────────────────────────────────────

/** D-2026-10-16-005: the default; the maximum is an engineering bound (tunable), recorded in the S7 attach. */
export const ISOLATION_DEFAULT_MS = 2 * 3_600_000;
export const ISOLATION_MAX_MS = 7 * 24 * 3_600_000;
const isolationForbidden = () => taskError(
  'WORKER_ISOLATION_FORBIDDEN',
  'Only a person managing this App, or the person holding this worker, acting as themselves, can isolate it or lift its isolation.',
);

/**
 * The ONE isolation writer (GraphQL and MCP both reach it). Its only audience is a human acting as themselves who manages the
 * App or holds the worker: a worker session (even a manager's), an App key and an impersonation are refused, and the row
 * is unchanged. Never reads or writes paused_until: the worker's own pause is untouched (R85).
 */
async function writeWorkerIsolation(
  ctx: Context, workerRef: string, op: { kind: 'set'; until?: Date | string | null } | { kind: 'clear' },
) {
  const target = await workerForRead(ctx, workerRef);
  const app = await appOf(ctx, target.appId);
  const actor = await resolveTaskActor(ctx, app);
  if (!actor || actor.kind !== 'user') throw isolationForbidden();
  if (op.kind === 'set' && !s7Available()) {
    throw taskError('WORKER_ISOLATION_UNAVAILABLE', 'Isolating a worker is not available yet (S7b). Nothing was changed.');
  }
  const until = op.kind === 'set' && op.until != null ? parseDate(op.until, 'until') : null;
  const row = await writeInApp(ctx, app, actor, () => workerNotFound(workerRef), async (tx, txCtx, fresh) => {
    const w = await lockWorker(tx, target.id);
    if (!w || w.appId !== fresh.id || w.retiredAt) throw workerNotFound(workerRef);
    const manages = await actorManagesApp(txCtx, fresh, actor);
    if (!manages && w.heldByUserId !== actor.userId) throw isolationForbidden();
    const now = new Date();
    const stamp = updatedStamp(txCtx);
    if (op.kind === 'clear') {
      return tx.workerWakeSettings.upsert({
        where: { workerId: w.id },
        create: { workerId: w.id },
        update: { isolatedUntil: null, isolatedAt: null, isolatedByUserId: null },
      });
    }
    const end = until ?? new Date(now.getTime() + ISOLATION_DEFAULT_MS);
    if (end.getTime() <= now.getTime()) throw badInput('until must be in the future.');
    if (end.getTime() > now.getTime() + ISOLATION_MAX_MS) throw badInput(`until is at most ${ISOLATION_MAX_MS / 86_400_000} days ahead.`);
    const set = { isolatedUntil: end, isolatedAt: now, isolatedByUserId: actor.userId };
    return tx.workerWakeSettings.upsert({
      where: { workerId: w.id },
      create: { workerId: w.id, ...set, updatedBy: stamp.updatedBy, updatedByWorkerId: stamp.updatedByWorkerId, updatedByAgentId: stamp.updatedByAgentId },
      update: { ...set, updatedAt: now, updatedBy: stamp.updatedBy, updatedByWorkerId: stamp.updatedByWorkerId, updatedByAgentId: stamp.updatedByAgentId },
    });
  });
  return wakeSettingsOut(target.id, row);
}

// ── Subscriptions ─────────────────────────────────────────────────────────

type SubscribeOutcome = {
  subscription: SubscriptionRow;
  authority: 'manager' | 'holder' | 'self' | 'grant';
  changed: boolean;
  ticker: TickerRow;
  worker: { id: string; name: string; heldByUserId: string | null };
  grantee: { id: string; name: string; heldByUserId: string | null } | null;
};

async function changeSubscription(
  ctx: Context,
  tickerRef: string,
  workerRef: string,
  op: 'subscribe' | 'unsubscribe',
): Promise<{ subscription: SubscriptionRow; announcement: 'POSTED' | 'FAILED' | null }> {
  const { ticker: seen, app, actor } = await loadReachableTicker(ctx, tickerRef);
  const target = await loadWorkerOf(ctx, app.id, workerRef);
  const outcome = await writeInApp(ctx, app, actor, () => tickerNotFound(tickerRef), async (tx, txCtx, fresh): Promise<SubscribeOutcome> => {
    const t = await lockTicker(tx, seen.id);
    if (!t || t.deletedAt) throw tickerNotFound(tickerRef);
    const w = await lockWorker(tx, target.id);
    if (!w || w.appId !== fresh.id) throw workerNotFound(workerRef);
    const settings = await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: SETTINGS_SELECT });
    const manages = await actorManagesApp(txCtx, fresh, actor);
    // N2: the grant row is read FOR SHARE here, inside the write, so a revocation
    // that commits first is seen and one that comes later waits for this write.
    const grantId = await liveGrantFor(tx, fresh.id, actor);
    const grantee =
      grantId && actor.kind === 'worker'
        ? await tx.worker.findUnique({ where: { id: actor.workerId }, select: { id: true, name: true, heldByUserId: true } })
        : null;
    const decision = decideSubscribe({
      actor: toPolicyActor(actor), manages, op,
      target: { id: w.id, heldByUserId: w.heldByUserId },
      tickerCadenceSeconds: t.cadenceSeconds,
      selfSubscribeCadenceSeconds: settings.tickerSelfSubscribeCadenceSeconds,
      hasGrant: grantId !== null,
      actorHeldByUserId: grantee?.heldByUserId ?? null,
    });
    if (!decision.allow) {
      if (decision.code === 'SUBSCRIBE_CADENCE_NEEDS_HOLDER') {
        throw taskError(
          'SUBSCRIBE_CADENCE_NEEDS_HOLDER',
          `A worker may subscribe itself only to a ticker of ${settings.tickerSelfSubscribeCadenceSeconds} seconds or slower. ` +
            'Ask its holder, or whoever manages the App, to subscribe it to this one.',
          { tickerCadenceSeconds: t.cadenceSeconds, selfSubscribeCadenceSeconds: settings.tickerSelfSubscribeCadenceSeconds },
        );
      }
      throw taskError(
        'SUBSCRIBE_FORBIDDEN',
        w.heldByUserId
          ? 'Only this worker\'s holder, whoever manages the App, or a worker with the may-subscribe-workers grant can do that.'
          : 'This worker is held by nobody. Only whoever manages the App, or a worker with the may-subscribe-workers grant, can do that.',
        { held: w.heldByUserId !== null },
      );
    }
    const live = await tx.tickerSubscription.findFirst({ where: { tickerId: t.id, workerId: w.id, endedAt: null } });
    const s = stamp(txCtx);
    const viaGrant = decision.authority === 'grant';
    const person = viaGrant && actor.kind === 'worker' ? actor.userId : null;
    const worker = { id: w.id, name: w.name, heldByUserId: w.heldByUserId };
    if (op === 'subscribe') {
      if (w.retiredAt) throw taskError('WORKER_RETIRED', 'A retired worker cannot be subscribed.');
      if (live) return { subscription: live, authority: decision.authority, changed: false, ticker: t, worker, grantee };
      const created = await tx.tickerSubscription.create({
        data: {
          tickerId: t.id, workerId: w.id,
          createdBy: s.by, createdByWorkerId: s.byWorkerId, createdByAgentId: s.byAgentId,
          viaGrantId: viaGrant ? grantId : null, viaGrantPersonId: person,
        },
      });
      return { subscription: created, authority: decision.authority, changed: true, ticker: t, worker, grantee };
    }
    if (!live) throw taskError('SUBSCRIPTION_NOT_FOUND', 'That worker is not subscribed to this ticker.');
    const ended = await tx.tickerSubscription.update({
      where: { id: live.id },
      data: {
        endedAt: new Date(), endedReason: 'UNSUBSCRIBED',
        endedBy: s.by, endedByWorkerId: s.byWorkerId, endedByAgentId: s.byAgentId,
        endedViaGrantId: viaGrant ? grantId : null, endedViaGrantPersonId: person,
      },
    });
    return { subscription: ended, authority: decision.authority, changed: true, ticker: t, worker, grantee };
  });
  // Q14 (cor:agt:080:25): a grant use is announced; best-effort, after commit.
  let announcement: 'POSTED' | 'FAILED' | null = null;
  if (outcome.authority === 'grant' && outcome.changed) {
    announcement = await announceGrantUse(ctx, app, op, outcome);
  }
  return { subscription: outcome.subscription, announcement };
}

/**
 * Escape what would render as markup in a team-chat line and keep it on one line.
 * An `@` is REPLACED (with the full-width sign), not backslash-escaped: the mention
 * extractor does not interpret Markdown escapes, so `\@all` is still a mention.
 * Only the deliberate target mention in `announceGrantUse` may carry a real `@`.
 */
const plainly = (s: string): string =>
  s.replace(/[\r\n]+/g, ' ').replace(/@/g, '\uFF20').replace(/([\\`*_{}[\]()#+!|<>~])/g, '\\$1').trim();

async function announceGrantUse(
  ctx: Context,
  app: TaskApp,
  op: 'subscribe' | 'unsubscribe',
  o: SubscribeOutcome,
): Promise<'POSTED' | 'FAILED'> {
  try {
    // Lazy: resolvers.teamChat imports a long chain of resolvers; same move as releaseWorker.
    const { teamChatMutations } = await import('./resolvers.teamChat.js');
    // The holder is told by mentioning the worker's token, which is how a worker
    // name reaches its holder. An unheld worker (or an unaddressable name) is
    // named and mentions nobody (cor:agt:080:25, Proposed).
    const token = o.worker.heldByUserId ? mentionTokenOf(o.worker.name) : null;
    const who = token ? `@${token}` : `**${plainly(o.worker.name)}**`;
    const by = o.grantee ? `**${plainly(o.grantee.name)}**` : 'A worker';
    const verb = op === 'subscribe' ? 'subscribed' : 'unsubscribed';
    const prep = op === 'subscribe' ? 'to' : 'from';
    const body =
      `${by} used the may-subscribe-workers grant and ${verb} ${who} ${prep} the **${plainly(o.ticker.name)}** ticker ` +
      `(every ${o.ticker.cadenceSeconds}s).`;
    await teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq: null, sessionRef: null }, ctx);
    return 'POSTED';
  } catch (e) {
    console.warn('[tickers] grant announcement failed:', e instanceof Error ? e.message : e);
    return 'FAILED';
  }
}

const subscriptionMutations = {
  subscribeWorker: (_: unknown, a: { tickerRef: string; workerRef: string }, ctx: Context) =>
    changeSubscription(ctx, a.tickerRef, a.workerRef, 'subscribe'),
  unsubscribeWorker: (_: unknown, a: { tickerRef: string; workerRef: string }, ctx: Context) =>
    changeSubscription(ctx, a.tickerRef, a.workerRef, 'unsubscribe'),
};

// ── Wake settings ─────────────────────────────────────────────────────────

const wakeAndGrantMutations = {
  setWorkerWakeSettings: async (
    _: unknown,
    { workerRef, input }: { workerRef: string; input: { mentions?: string | null; pausedUntil?: Date | string | null; clearPause?: boolean | null } },
    ctx: Context,
  ) => {
    const target = await workerForRead(ctx, workerRef);
    const app = await appOf(ctx, target.appId);
    const actor = await resolveTaskActor(ctx, app);
    if (!actor) throw workerNotFound(workerRef);
    if (input.mentions != null && !(MENTION_WAKE as readonly string[]).includes(input.mentions)) {
      throw badInput(`mentions is one of ${MENTION_WAKE.join(', ')}.`);
    }
    if (input.pausedUntil != null && input.clearPause) throw badInput('Send pausedUntil or clearPause, not both.');
    const pausedUntil = input.pausedUntil == null ? undefined : parseDate(input.pausedUntil, 'pausedUntil');
    const row = await writeInApp(ctx, app, actor, () => workerNotFound(workerRef), async (tx, txCtx, fresh) => {
      const w = await lockWorker(tx, target.id);
      if (!w || w.appId !== fresh.id) throw workerNotFound(workerRef);
      const manages = await actorManagesApp(txCtx, fresh, actor);
      // N1: the grant is not consulted here, by construction.
      if (!mayChangeWakeSettings({ actor: toPolicyActor(actor), manages, target: { id: w.id, heldByUserId: w.heldByUserId } })) {
        throw taskError(
          'WAKE_SETTINGS_FORBIDDEN',
          'Only this worker, its holder, or whoever manages the App can change its wake settings.',
        );
      }
      const u = updatedStamp(txCtx);
      const change = {
        ...(input.mentions != null ? { mentions: input.mentions } : {}),
        ...(pausedUntil !== undefined ? { pausedUntil } : input.clearPause ? { pausedUntil: null } : {}),
      };
      return tx.workerWakeSettings.upsert({
        where: { workerId: w.id },
        create: { workerId: w.id, ...change, updatedBy: u.updatedBy, updatedByWorkerId: u.updatedByWorkerId, updatedByAgentId: u.updatedByAgentId },
        update: { ...change, updatedAt: new Date(), updatedBy: u.updatedBy, updatedByWorkerId: u.updatedByWorkerId, updatedByAgentId: u.updatedByAgentId },
      });
    });
    return wakeSettingsOut(target.id, row);
  },

  isolateWorker: (_: unknown, a: { workerRef: string; until?: Date | string | null }, ctx: Context) =>
    writeWorkerIsolation(ctx, a.workerRef, { kind: 'set', until: a.until }),
  clearWorkerIsolation: (_: unknown, a: { workerRef: string }, ctx: Context) =>
    writeWorkerIsolation(ctx, a.workerRef, { kind: 'clear' }),

  // ── The may-subscribe-workers grant (cor:agt:080:24) ──────────────────────

  grantApp: (_: unknown, a: { appRef: string; workerRef: string; name: string }, ctx: Context) => changeGrant(ctx, a, 'grant'),
  revokeAppGrant: (_: unknown, a: { appRef: string; workerRef: string; name: string }, ctx: Context) => changeGrant(ctx, a, 'revoke'),
};

export const tickerMutations = { ...crudMutations, ...subscriptionMutations, ...wakeAndGrantMutations };

async function changeGrant(
  ctx: Context,
  a: { appRef: string; workerRef: string; name: string },
  op: 'grant' | 'revoke',
) {
  const name: AppGrantName | undefined = GRANT_ENUM_TO_NAME[a.name];
  if (!name || !(APP_GRANT_NAMES as readonly string[]).includes(name)) throw badInput('Unknown grant name.');
  const { app, actor } = await resolveParticipatedApp(ctx, a.appRef);
  const target = await loadWorkerOf(ctx, app.id, a.workerRef);
  return writeInApp(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
    // Given and revoked only by whoever manages the App; no grant can give or take a grant.
    if (!(await actorManagesApp(txCtx, fresh, actor))) {
      throw taskError('APP_GRANT_FORBIDDEN', 'Only whoever manages this App can give or revoke a grant.');
    }
    const w = await lockWorker(tx, target.id);
    if (!w || w.appId !== fresh.id) throw workerNotFound(a.workerRef);
    // With no live row there is nothing for FOR UPDATE to lock, so two first grants
    // would both insert and one would get the unique index's error. Serialize on the
    // natural key instead; the second caller then finds the first's row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`grant:${fresh.id}:${w.id}:${name}`}, 0))`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app_grants
      WHERE app_id = ${fresh.id} AND grantee_worker_id = ${w.id} AND name = ${name} AND revoked_at IS NULL
      FOR UPDATE`;
    const liveId = rows[0]?.id ?? null;
    const by = txCtx.userId ?? null;
    if (op === 'grant') {
      if (w.retiredAt) throw taskError('WORKER_RETIRED', 'A grant is held by a worker that is not retired.');
      if (liveId) return tx.appGrant.findUniqueOrThrow({ where: { id: liveId } });
      return tx.appGrant.create({ data: { appId: fresh.id, granteeWorkerId: w.id, name, grantedBy: by } });
    }
    if (!liveId) throw taskError('APP_GRANT_NOT_FOUND', 'That worker does not hold this grant.');
    return tx.appGrant.update({ where: { id: liveId }, data: { revokedAt: new Date(), revokedBy: by } });
  });
}

// ── Field resolvers ───────────────────────────────────────────────────────

async function actorRef(ctx: Context, workerId: string | null, userId: string | null) {
  if (workerId) {
    const w = await ctx.db.worker.findUnique({ where: { id: workerId }, include: { app: { select: { urn: true } } } });
    if (!w) return null;
    let urn: string | null = null;
    try {
      urn = composeWorkerUrn(normalizeUrnForLookup(w.app.urn), w.slug);
    } catch {
      urn = null;
    }
    return { id: w.id, name: w.name, urn };
  }
  if (userId) {
    const u = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, handle: true } });
    return u ? { id: u.id, name: u.name ?? u.handle, urn: null } : null;
  }
  return null;
}

export const tickerFieldResolvers = {
  Ticker: {
    urn: async (t: TickerRow, _: unknown, ctx: Context) => {
      const app = await ctx.db.app.findUnique({ where: { id: t.appId }, select: { urn: true } });
      if (!app) return null;
      try {
        return composeTickerUrn(normalizeUrnForLookup(app.urn), t.slug);
      } catch {
        return null;
      }
    },
    app: (t: TickerRow, _: unknown, ctx: Context) => ctx.db.app.findUnique({ where: { id: t.appId } }),
    quietHours: (t: TickerRow) => t.quietHours ?? null,
    reasons: (t: TickerRow) => t.reasons.map(reasonEnum),
    nextTickAt: (t: TickerRow) => nextTickAfter(t, new Date()),
    lastTickAt: (t: TickerRow) => {
      const k = currentTick(t, new Date());
      return k === null ? null : tickTime(t, k);
    },
    channels: async (t: TickerRow, _: unknown, ctx: Context) => {
      if (!t.channelIds.length) return [];
      // The list is not a grant: show only the channels the reader can read.
      const accessible = await getAccessibleMemoryIds(ctx);
      const rows = await ctx.db.channel.findMany({ where: { id: { in: t.channelIds }, deletedAt: null } });
      return rows.filter((c) => accessible === null || accessible.includes(c.memoryId));
    },
    owner: (t: TickerRow, _: unknown, ctx: Context) => actorRef(ctx, t.ownerWorkerId, t.ownerUserId),
    subscribers: async (t: TickerRow, a: { first?: number | null; after?: string | null }, ctx: Context) => {
      const take = Math.min(Math.max(a.first ?? 50, 1), 200);
      const rows = await ctx.db.tickerSubscription.findMany({
        where: { tickerId: t.id, endedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: take + 1,
        ...(a.after ? { cursor: { id: a.after }, skip: 1 } : {}),
      });
      const page = rows.slice(0, take);
      return { items: page, hasNextPage: rows.length > take, endCursor: page.length ? page[page.length - 1]!.id : null };
    },
  },

  TickerSubscription: {
    ticker: (s: SubscriptionRow, _: unknown, ctx: Context) => ctx.db.ticker.findUnique({ where: { id: s.tickerId } }),
    worker: (s: SubscriptionRow, _: unknown, ctx: Context) => ctx.db.worker.findUnique({ where: { id: s.workerId } }),
    createdBy: (s: SubscriptionRow, _: unknown, ctx: Context) => actorRef(ctx, s.createdByWorkerId, s.createdBy),
    viaGrant: (s: SubscriptionRow) => s.viaGrantId !== null,
  },

  WorkerWakeSettings: {
    worker: (w: { workerId: string }, _: unknown, ctx: Context) => ctx.db.worker.findUnique({ where: { id: w.workerId } }),
    subscriptions: (w: { workerId: string }, _: unknown, ctx: Context) =>
      ctx.db.tickerSubscription.findMany({
        where: { workerId: w.workerId, endedAt: null, ticker: { deletedAt: null } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    // The fastest live subscription on an enabled ticker; null when there is none.
    effectiveCadenceSeconds: async (w: { workerId: string }, _: unknown, ctx: Context) => {
      const fastest = await ctx.db.ticker.aggregate({
        _min: { cadenceSeconds: true },
        where: { deletedAt: null, enabled: true, subscriptions: { some: { workerId: w.workerId, endedAt: null } } },
      });
      return fastest._min.cadenceSeconds ?? null;
    },
    isolated: (w: { isolatedUntil?: Date | null }) => s7Available() && !!w.isolatedUntil && w.isolatedUntil.getTime() > Date.now(),
    isolatedByHandle: async (w: { isolatedByUserId?: string | null }, _: unknown, ctx: Context) =>
      w.isolatedByUserId ? (await ctx.db.user.findUnique({ where: { id: w.isolatedByUserId }, select: { handle: true } }))?.handle ?? null : null,
    dormant: async (w: { workerId: string }, _: unknown, ctx: Context) => {
      const worker = await ctx.db.worker.findUnique({ where: { id: w.workerId }, select: { app: { select: { sessionDormancyDays: true } } } });
      if (!worker) return false;
      const now = new Date();
      const activity = await loadWorkersActivity(ctx, [w.workerId], now);
      return isWorkerDormant(activity.get(w.workerId)?.lastActiveAt, worker.app.sessionDormancyDays, now);
    },
  },

  AppGrant: {
    app: (g: { appId: string }, _: unknown, ctx: Context) => ctx.db.app.findUnique({ where: { id: g.appId } }),
    worker: (g: { granteeWorkerId: string }, _: unknown, ctx: Context) => ctx.db.worker.findUnique({ where: { id: g.granteeWorkerId } }),
    name: (g: { name: string }) => GRANT_NAME_TO_ENUM[g.name as AppGrantName] ?? null,
  },
};
