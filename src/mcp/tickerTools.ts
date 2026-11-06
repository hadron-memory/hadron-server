import { mcpRequestSessionContext } from './requestSession.js';
/**
 * #1747 — tickers on the MCP surface (cor:agt:080; plan
 * hrn:node:hadronmemory.com:hadron-server:design:named-heartbeats §6.2): list,
 * create, update and delete a ticker; subscribe or unsubscribe a worker; read
 * and set a worker's wake settings.
 *
 * Every tool is a thin call into the SAME resolvers GraphQL serves
 * (`resolvers.ticker.ts`): the actor, the participation gate, the §5 matrix,
 * the grant and its announcement, and the refusal codes are computed once.
 *
 * WHO ACTS. Every WRITE tool requires `session` and refuses without it, never
 * inferring one (the agent-task rule, #1697 / #1701): a worker passes its worker
 * session and acts as the worker; a person passes a plain session and acts as
 * themselves. Reads take an optional `session`. Setting wake settings is a write
 * and follows the write rule; calling `hadron_worker_wake_settings` with nothing
 * to set reads them.
 */
import { s7Available } from '../lib/tickers/s7Availability.js';
import { appKeyCaller } from '../lib/appKeyScopes/scopes.js';
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { publicErrorExtensions } from '../lib/errorDiagnostics.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { offTeamTool } from './disabledTools.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { reasonEnum, tickerFieldResolvers } from '../api/graphql/schema/resolvers.ticker.js';
import { agentTickerTemplateFieldResolvers } from '../api/graphql/schema/resolvers.agentTickerTemplate.js';
import { renderTaskWarnings } from '../api/graphql/schema/resolvers.taskWarnings.js';
import { type AuthContext, validateSessionBinding } from '../middleware/auth.js';
import { runAsActor } from '../lib/requestActor.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';

type Row = Record<string, any>;
type Resolver<A, R> = (parent: unknown, args: A, ctx: Context) => Promise<R>;
const Q = resolvers.Query as unknown as {
  appDeliverySettings: Resolver<{ appRef: string }, Row>;
  tickers: Resolver<{ appRef: string }, Row[]>;
  ticker: Resolver<{ ref: string }, Row | null>;
  workerWakeSettings: Resolver<{ workerRef: string }, Row>;
  agentTickerTemplates: Resolver<{ agentRef: string }, Row[]>;
  dueWakes: Resolver<{ appRef: string; workerRefs?: string[]; first?: number; after?: string; accepts?: string[] }, Row>;
  deliveryBatches: Resolver<{ appRef: string; workerRefs?: string[]; first?: number; after?: string }, Row>;
};
/**
 * #2169 (Uma's P3-5 on #2166): the notice line of a due wake, written for the agent that reads it. `interrupt` is the
 * platform's own flag, kept for clients, but nothing here sends an interrupt key (Holger's option A): the notice is text.
 */
const STOP_LINE_WHAT: Record<string, string> = {
  PAUSE_DISPATCH: 'no new work is assigned to the workers it covers',
  PAUSE: 'finish or stop at your next sub-task',
  HALT: 'save your work and write a hand-off now',
};
export function stopLine(stop: { level: string; notice: string }): string {
  return stop.notice === 'RESUME' ? `resume: ${stop.level} lifted` : `stop: ${stop.level} (${STOP_LINE_WHAT[stop.level] ?? 'see the stop signal'})`;
}

const M = resolvers.Mutation as unknown as {
  setAppDeliverySettings: Resolver<{ appRef: string; input: unknown }, Row>;
  setTeamPause: Resolver<{ appRef: string; paused: boolean }, Row>;
  createAgentTickerTemplate: Resolver<{ agentRef: string; input: Row }, Row>;
  updateAgentTickerTemplate: Resolver<{ id: string; expectedRevision: number; input: Row }, Row>;
  deleteAgentTickerTemplate: Resolver<{ id: string; expectedRevision: number }, boolean>;
  createTicker: Resolver<{ appRef: string; input: Row }, Row>;
  updateTicker: Resolver<{ ref: string; input: Row }, Row>;
  deleteTicker: Resolver<{ ref: string }, boolean>;
  subscribeWorker: Resolver<{ tickerRef: string; workerRef: string }, { subscription: Row; announcement: string | null }>;
  unsubscribeWorker: Resolver<{ tickerRef: string; workerRef: string }, { subscription: Row; announcement: string | null }>;
  setWorkerWakeSettings: Resolver<{ workerRef: string; input: Row }, Row>;
  isolateWorker: Resolver<{ workerRef: string; until?: string }, Row>;
  clearWorkerIsolation: Resolver<{ workerRef: string }, Row>;
  acknowledgeWakes: Resolver<{ proofs: string[] }, { acknowledged: number; unchanged: number }>;
  acknowledgeDeliveryBatches: Resolver<{ batchIds: string[]; through?: Array<{ channelId: string; seq: number }> }, { acknowledged: number; unchanged: number }>;
};
const FT = tickerFieldResolvers.Ticker;
const FW = tickerFieldResolvers.WorkerWakeSettings;

/** The write tools, for the caller-session gate's bookkeeping and tests. */
export const TICKER_WRITE_TOOLS = [
  'hadron_ticker_create', 'hadron_ticker_update', 'hadron_ticker_delete',
  'hadron_ticker_subscribe', 'hadron_ticker_unsubscribe', 'hadron_ack_wakes',
  'hadron_delivery_settings_set', 'hadron_set_team_pause', 'hadron_team_chat_inbox_ack',
  'hadron_isolate_worker', 'hadron_clear_worker_isolation',
] as const;
/**
 * Actor-neutral tools (listed in ACTOR_NEUTRAL_TOOLS): each takes its own
 * optional `session`. `hadron_worker_wake_settings` is a read until it is given
 * something to set, and then enforces the write rule itself.
 */
export const TICKER_READ_TOOLS = ['hadron_ticker_list', 'hadron_agent_ticker_template_list', 'hadron_worker_wake_settings', 'hadron_due_wakes', 'hadron_delivery_settings_get', 'hadron_team_chat_inbox'] as const;

function textResult(text: string, isError = false) {
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: 'text' as const, text }] };
}

/** A resolver refusal as `[<code>] <message>` plus its extensions; anything else is a server fault. */
function refusal(e: unknown) {
  if (e instanceof GraphQLError && isTrustedRefusal(e)) {
    const { code, ...rest } = publicErrorExtensions(e.extensions ?? {});
    const extras = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return textResult([`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, ...extras].join('\n'), true);
  }
  if (e instanceof UrnNotQualifiedError) return textResult(`[bad_user_input] ${e.message}`, true);
  throw e;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function renderTicker(t: Row, ctx: Context): Promise<string> {
  // Only channels the reader can read: the list is not a grant (the GraphQL field filters the same way).
  const [urn, owner, subs, readable, registerLoc] = await Promise.all([
    FT.urn(t as never, {}, ctx),
    FT.owner(t as never, {}, ctx),
    FT.subscribers(t as never, { first: 200 }, ctx),
    FT.channels(t as never, {}, ctx),
    FT.registerTaskLoc(t as never, {}, ctx),
  ]);
  const names: string[] = [];
  for (const s of subs.items) {
    const w = await tickerFieldResolvers.TickerSubscription.worker(s, {}, ctx);
    names.push(w ? w.name : s.workerId);
  }
  const quiet = t.quietHours ? `quiet hours ${t.quietHours.timezone} (${t.quietHours.windows.length} window${t.quietHours.windows.length === 1 ? '' : 's'})` : null;
  return [
    `- ${t.name} · ${urn ?? t.id} · every ${t.cadenceSeconds}s · ${t.enabled ? 'enabled' : 'disabled'} · relevance ${t.relevance}· reasons ${(t.reasons as string[]).map((x) => x.toLowerCase().replace(/_/g, '-')).join('+')}`,
    `  code ${t.tickCode} · ${registerLoc ? 'register task loc ' + registerLoc : 'no register entry you can read'}`,
    `  anchor ${iso(t.anchorAt)}${quiet ? ` · ${quiet}` : ''}${readable.length ? ` · ${readable.length} channel(s)` : ''}`,
    `  owner ${owner ? owner.name : 'unknown'} · subscribers: ${names.length ? names.join(', ') : 'none'}${subs.hasNextPage ? ' (more)' : ''}`,
  ].join('\n');
}

const SESSION_WRITE = z.string().optional().describe(
  'REQUIRED. Your session id: a worker passes its worker session (from hadron_start_session / hadron_whoami) and ' +
    'acts as the worker; a person passes a plain session (one bound to no worker) and acts as themselves. A write ' +
    'without it is refused, never inferred (#1697/#1701).',
);
const SESSION_READ = z.string().optional().describe('Optional session id: read as that session\'s worker.');
const ref = z.string().describe('The ticker: its id or hrn:ticker: URN.');
const workerRef = z.string().describe('The worker: its id or hrn:worker: URN.');
const quietHours = z.object({
  timezone: z.string().describe('An IANA time zone, e.g. America/Los_Angeles.'),
  windows: z.array(z.object({
    days: z.array(z.number().int()).describe('1 = Monday ... 7 = Sunday.'),
    from: z.string().describe('HH:MM, inclusive.'),
    to: z.string().describe('HH:MM, exclusive; earlier than from means overnight.'),
  })).describe('At most 14, none overlapping.'),
});

/** Register the ticker tools on one MCP server instance. `auth` is the connection's principal. */
export function registerTickerTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const off = offTeamTool(server); // #3082: every tool in this module is disabled (R1)
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    // #1868: the presented hdr_user_ key, so the shared authorized transaction
    // re-checks it is still unrevoked at the write (as #1864's signing tools do).
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined,
    ...mcpRequestSessionContext(auth),
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });

  /** Run a WRITE: refuse a missing or unvalidated session, then call the resolver and render the result. */
  async function write(tool: string, session: string | undefined, call: (ctx: Context) => Promise<string>) {
    if (!session) {
      return textResult(
        `[session_required] ${tool}: pass session. A worker passes its worker session; a person passes a plain ` +
          'session (hadron_start_session with no worker) to act as themselves. Nothing was written.',
        true,
      );
    }
    const valid = await validateSessionBinding(db, auth, session);
    if (!valid) {
      return textResult(
        `[session_not_bound] ${tool}: session "${session}" is not one of your open sessions (it may have ended, gone ` +
          'dormant, or belong to someone else). Nothing was written. hadron_whoami lists yours.',
        true,
      );
    }
    const ctx = ctxOf();
    try {
      // As the named session's actor, like `read` below: a tool that is actor-neutral
      // (hadron_worker_wake_settings, hadron_ack_wakes) is not wrapped by the server's
      // caller-session gate, and would otherwise act as the connection's ambient
      // worker, or as the person with their holder and manager authority.
      return textResult(await runAsActor(valid.actor, () => call(ctx)));
    } catch (e) {
      return refusal(e);
    }
  }

  /** Run a READ, as the named session's worker when one is given. */
  async function read(session: string | undefined, fn: (ctx: Context) => Promise<string>) {
    const ctx = ctxOf();
    try {
      if (!session) return textResult(await fn(ctx));
      const valid = await validateSessionBinding(db, auth, session);
      if (!valid) return textResult(`[session_not_bound] session "${session}" is not one of your open sessions.`, true);
      return textResult(await runAsActor(valid.actor, () => fn(ctx)));
    } catch (e) {
      return refusal(e);
    }
  }

  /**
   * A wake tool as an App key (#1749): it acts as itself, with no session, so a `session` argument is a session the
   * key carries and is refused, never ignored and never narrowed (#8097). Anyone else is served by `read`.
   */
  async function readWakes(session: string | undefined, fn: (ctx: Context) => Promise<string>) {
    const ctx = ctxOf();
    if (!appKeyCaller(ctx)) return read(session, fn);
    try {
      return textResult(await fn(session ? { ...ctx, sessionId: session } : ctx));
    } catch (e) {
      return refusal(e);
    }
  }

  // #2025: thin over the shared manager transaction; cadence/window changes affect tickers too.
  off(
    'hadron_set_team_pause',
    'Pause or resume the WHOLE TEAM of an App, as whoever manages it (#2138). Separate from each worker\'s own pause: a worker cannot lift it and ending it clears no self-pause. While paused no worker is nudged and every worker\'s check status is PENDING (TEAM_PAUSED). Idempotent.',
    SHAPE_HADRON_SET_TEAM_PAUSE,
    async ({ appRef, paused, session }) => write('hadron_set_team_pause', session, async (ctx) =>
      JSON.stringify(await M.setTeamPause({}, { appRef, paused }, ctx))),
  );
  off(
    'hadron_delivery_settings_get',
    'Read an App’s delivery settings as a participant (cor:agt:080:05). The batching window is also the ticker cadence floor. Standby is not effective until S7.',
    SHAPE_HADRON_DELIVERY_SETTINGS_GET,
    async ({ appRef, session }) => read(session, async (ctx) => JSON.stringify(await Q.appDeliverySettings({}, { appRef }, ctx))),
  );
  off(
    'hadron_delivery_settings_set',
    'Change delivery settings as the human App manager (cor:agt:080:19). Omitted preserves; null and unknown settings refuse atomically. The batching window changes ticker cadence too. Standby enabling is unavailable until S7.',
    SHAPE_HADRON_DELIVERY_SETTINGS_SET,
    async ({ appRef, input, session }) => write('hadron_delivery_settings_set', session, async (ctx) =>
      JSON.stringify(await M.setAppDeliverySettings({}, { appRef, input }, ctx))),
  );

  off(
    'hadron_ticker_list',
    'List the live tickers of a team App, with their cadence, owner and subscribers (cor:agt:080). A ticker is a named, ' +
      'cadenced wake schedule; workers subscribe to the ones they want. Shows the permanent tick code and the register entry loc you may read, without resolving a worker task. Readable by the App\'s participants.',
    SHAPE_HADRON_TICKER_LIST,
    async ({ appRef, session }) =>
      read(session, async (ctx) => {
        const rows = await Q.tickers({}, { appRef }, ctx);
        if (!rows.length) return 'No live tickers.';
        const lines = await Promise.all(rows.map((t) => renderTicker(t, ctx)));
        return `${rows.length} ticker${rows.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`;
      }),
  );

  off(
    'hadron_ticker_create',
    'Create a ticker in a team App (cor:agt:080:18). Any App participant, or a session bound to a worker of the App, up to ' +
      'the App\'s live-ticker cap (20 by default). You become its owner. Its slug, and so its URN, is derived from the name ' +
      'and permanent. So is its tick code. A code without a readable register entry produces a warn-only ticker.code.unmapped after success. The cadence is in seconds, from the App\'s floor (120 by default) to 86400.',
    SHAPE_HADRON_TICKER_CREATE,
    async ({ session, appRef, ...input }) =>
      write('hadron_ticker_create', session, async (ctx) => {
        const t = await M.createTicker({}, { appRef, input }, ctx);
        return `Created.\n\n${await renderTicker(t, ctx)}${renderTaskWarnings(ctx.taskWarnings)}`;
      }),
  );

  off(
    'hadron_ticker_update',
    'Change a ticker, or enable or disable it (cor:agt:080:18): its owner, the holder of its owning worker, or whoever manages ' +
      'the App. Absent fields stay as they are; clearQuietHours and clearChannels remove those. The slug never changes.',
    SHAPE_HADRON_TICKER_UPDATE,
    async ({ session, ref: r, ...input }) =>
      write('hadron_ticker_update', session, async (ctx) => {
        const t = await M.updateTicker({}, { ref: r, input }, ctx);
        return `Updated.\n\n${await renderTicker(t, ctx)}`;
      }),
  );

  off(
    'hadron_ticker_delete',
    'Delete a ticker (cor:agt:080:18): its owner, the holder of its owning worker, or whoever manages the App. Its ' +
      'subscriptions end (reason TICKER_DELETED); its name may be reused, its slug never.',
    SHAPE_HADRON_TICKER_DELETE,
    async ({ session, ref: r }) =>
      write('hadron_ticker_delete', session, async (ctx) => {
        await M.deleteTicker({}, { ref: r }, ctx);
        return `Deleted ${r}.`;
      }),
  );

  const subscribeText = (verb: string, r: { subscription: Row; announcement: string | null }) =>
    `${verb}.` +
    (r.announcement === 'POSTED' ? '\nThe use of the may-subscribe-workers grant was announced to the team chat.' : '') +
    (r.announcement === 'FAILED'
      ? '\nThe subscription stands, but the team-chat announcement of this grant use FAILED to post. Tell the worker\'s holder yourself.'
      : '');

  off(
    'hadron_ticker_subscribe',
    'Subscribe a worker to a ticker (cor:agt:080:20). Its holder and whoever manages the App, to any ticker. The worker ' +
      'itself only to a ticker at or slower than the App\'s self-subscription cadence (600s by default); faster is refused ' +
      'SUBSCRIBE_CADENCE_NEEDS_HOLDER. A worker holding the may-subscribe-workers grant, with a person behind the call, ' +
      'for OTHER workers (never itself); that use is announced to the team chat. A worker nobody holds: only a manager or the grant.',
    SHAPE_HADRON_TICKER_SUBSCRIBE,
    async ({ session, ref: r, workerRef: w }) =>
      write('hadron_ticker_subscribe', session, async (ctx) =>
        subscribeText('Subscribed', await M.subscribeWorker({}, { tickerRef: r, workerRef: w }, ctx))),
  );

  off(
    'hadron_ticker_unsubscribe',
    'End a worker\'s subscription to a ticker (cor:agt:080:20): the same callers as hadron_ticker_subscribe, and a worker ' +
      'may always unsubscribe itself.',
    SHAPE_HADRON_TICKER_UNSUBSCRIBE,
    async ({ session, ref: r, workerRef: w }) =>
      write('hadron_ticker_unsubscribe', session, async (ctx) =>
        subscribeText('Unsubscribed', await M.unsubscribeWorker({}, { tickerRef: r, workerRef: w }, ctx))),
  );

  off(
    'hadron_worker_wake_settings',
    'Read a worker\'s wake settings, or set them (cor:agt:080:03, :21). With nothing to set, reads: whether mentions wake ' +
      'it (IMMEDIATE or OFF), its pause, its subscriptions, its effective cadence and canManageIsolation (the caller\'s permission, independent of availability). With mentions, pausedUntil or ' +
      'clearPause, sets them (needs session): the worker itself, its holder, or whoever manages the App. The ' +
      'may-subscribe-workers grant never changes these. A pause belongs to the worker, not a session.',
    SHAPE_HADRON_WORKER_WAKE_SETTINGS,
    async ({ session, workerRef: w, ...input }) => {
      const render = async (ctx: Context, s: Row, verb: string | null) => {
        const [worker, subs, cadence] = await Promise.all([
          FW.worker(s as never, {}, ctx),
          FW.subscriptions(s as never, {}, ctx),
          FW.effectiveCadenceSeconds(s as never, {}, ctx),
        ]);
        const names: string[] = [];
        for (const sub of subs) {
          const t = await tickerFieldResolvers.TickerSubscription.ticker(sub, {}, ctx);
          names.push(t ? t.name : sub.tickerId);
        }
        return [
          `${verb ? `${verb}.\n` : ''}${worker ? worker.name : s.workerId}: mentions ${s.mentions}` +
            `${s.pausedUntil ? `, paused until ${iso(s.pausedUntil)}` : ', not paused'}` +
            `${FW.isolated(s as never) ? `, isolated by ${s.isolatedByUserId ? await FW.isolatedByHandle(s as never, {}, ctx) ?? 'unknown' : 'unknown'} until ${iso(s.isolatedUntil)}` : ''}`,
          `subscriptions: ${names.length ? names.join(', ') : 'none'} · effective cadence ${cadence ? `${cadence}s` : 'none'}`,
          `canManageIsolation: ${await FW.canManageIsolation(s as never, {}, ctx)}`,
        ].join('\n');
      };
      const sets = input.mentions != null || input.pausedUntil != null || input.clearPause != null;
      if (!sets) {
        return read(session, async (ctx) => render(ctx, await Q.workerWakeSettings({}, { workerRef: w }, ctx), null));
      }
      return write('hadron_worker_wake_settings', session, async (ctx) =>
        render(ctx, await M.setWorkerWakeSettings({}, { workerRef: w, input }, ctx), 'Updated'));
    },
  );
  const isolationText = (verb: string, s: Row) =>
    `${verb}. ${s7Available() && s.isolatedUntil && new Date(s.isolatedUntil).getTime() > Date.now() ? `Isolated until ${iso(s.isolatedUntil)}: no chat batches or ordinary wakes, and no task matching.` : 'Not isolated.'}`;
  off(
    'hadron_isolate_worker',
    'Isolate a worker (S7, #2023): until the time you give (default 2 hours, at most 7 days; a later time extends, an earlier one shortens). ' +
      'While isolated it gets no chat batches or ordinary wakes and is not matched for work; at the end everything held comes as one batch. ' +
      'Needs session. ONLY a person managing the App or holding the worker, acting as themselves with a plain session: a worker session ' +
      '(even a manager\'s), an App key or an impersonation is refused. The worker\'s own pause is untouched.',
    SHAPE_HADRON_ISOLATE_WORKER,
    async ({ session, workerRef: w, until }) =>
      write('hadron_isolate_worker', session, async (ctx) =>
        isolationText('Isolated', await M.isolateWorker({}, { workerRef: w, ...(until ? { until } : {}) }, ctx))),
  );
  off(
    'hadron_clear_worker_isolation',
    'Lift a worker\'s isolation (S7, #2023): the same audience as hadron_isolate_worker. Clearing when none is set changes nothing.',
    SHAPE_HADRON_CLEAR_WORKER_ISOLATION,
    async ({ session, workerRef: w }) =>
      write('hadron_clear_worker_isolation', session, async (ctx) =>
        isolationText('Cleared', await M.clearWorkerIsolation({}, { workerRef: w }, ctx))),
  );
  off(
    'hadron_due_wakes',
    'Which workers are due a wake right now (cor:agt:080:08-:12), for a router. Counts and message ranges only, never ' +
      'bodies, authors or mention text. Each wake merges every reason (a mention, or a ticker\'s tick) with one seq range per ' +
      'channel and a PROOF: deliver the nudge, then pass the proof to hadron_ack_wakes. Reading wakes never moves anyone\'s ' +
      'read position. Allowed for a worker\'s holder (their workers) and whoever manages the App (all). Never due: a retired, ' +
      'paused or dormant worker; an unavailable, unheld or session-less worker IS still due. `dormant` lists dormant workers ' +
      'with mentions waiting. A channel you cannot read is left out entirely. The server tick line names each readable role task, otherwise the code and guidance to resolve it yourself.',
    SHAPE_HADRON_DUE_WAKES,
    async ({ session, appRef, ...rest }) =>
      readWakes(session, async (ctx) => {
        const page = await Q.dueWakes({}, { appRef, ...rest }, ctx);
        const lines: string[] = [];
        for (const w of page.wakes) {
          const why = [w.tickText, ...(w.reasons as Row[])
            .filter(r => r.kind !== 'TICK' || !w.tickText)
            .map((r) => (r.kind === 'TICK' ? `tick ${r.ticker?.name ?? ''}${r.tickDueAt ? ` tickDueAt ${iso(r.tickDueAt)}` : ''}` : r.kind === 'STOP' ? stopLine(r.stop) : r.kind === 'TASK' ? `task ${r.task.handle} ${JSON.stringify(r.task.title)} (${r.task.ref})${r.task.standbyHeld ? ` — ${r.task.standbyHeld} message${r.task.standbyHeld === 1 ? ' was' : 's were'} held while you were on standby` : ''}` : 'mention'))].filter(Boolean)
            .join(' + ');
          const tickTimes = w.tickText ? (w.reasons as Row[]).filter(r => r.kind === 'TICK' && r.tickDueAt)
            .map(r => `tick ${r.ticker?.name ?? ''} tickDueAt ${iso(r.tickDueAt)}`).join(' · ') : '';
          const ch = (w.channels as Row[]).map((c) => `${c.channel.name} ${c.fromSeq}-${c.throughSeq}`).join(', ');
          lines.push(
            `- ${w.worker.name}: ${why} · ${w.unread} unread (${w.unreadMentions} mention${w.unreadMentions === 1 ? '' : 's'}) · ${ch}` +
              `${w.availability ? ` · ${w.availability.state}${w.availability.reason ? ` (${w.availability.reason})` : ''}` : ''}${tickTimes ? '\n  ' + tickTimes : ''}\n  anchor ${iso(w.anchorAt)} · deliverAfter ${iso(w.deliverAfter)} · busyDeadline ${iso(w.busyDeadline)}\n  proof: ${w.proof}`,
          );
        }
        const dormant = (page.dormant as Row[]).map((d) => `${d.worker.name} (${d.mentions})`);
        return [
          page.wakes.length ? `${page.wakes.length} due:\n${lines.join('\n')}` : 'Nothing is due.',
          page.status === 'WAKE_BUDGET_EXHAUSTED'
            ? `WAKE_BUDGET_EXHAUSTED: ${page.withheld} more wake(s) are due but held back by the App's daily budget; they stay due.`
            : null,
          dormant.length ? `Dormant, with mentions waiting: ${dormant.join(', ')}` : null,
          page.pageInfo.hasNextPage ? `More workers: after = ${page.pageInfo.endCursor}` : null,
        ].filter(Boolean).join('\n');
      }),
  );

  // #2017 (S1): thin over the same resolvers as GraphQL, so the text is byte-identical on every surface.
  off(
    'hadron_team_chat_inbox',
    'Ready delivery batches (cor:agt:080:22, :26): your own worker through its live session, or workers registered on YOUR host with an App key ' +
      'holding attention:deliver AND host:operate. Self also admits a same-App userless, non-host-launched session through an active key that never held host:operate; existing session/memory gates still apply. Returns JSON: each batch has `id` (a signed proof), `worker`, `text` (one line, ' +
      'written by the server: type it UNCHANGED), `deliverAfter`, `busyDeadline`, `ranges` and `overflow`. Reading moves nothing; ' +
      'Display the shared text, then call hadron_team_chat_inbox_ack separately within 15 minutes. A lost read response acknowledges nothing. ' +
      'The opaque proof is returned ONLY in batches[].id; never copy it into other output, errors or logs. No credentials are returned. ' +
      'Encrypted channels are omitted, even when unlocked.',
    SHAPE_HADRON_TEAM_CHAT_INBOX,
    async ({ session, ...rest }) =>
      readWakes(session, async (ctx) => {
        const page = await Q.deliveryBatches({}, rest, session ? { ...ctx, sessionId: session, sessionBindingRefused: false } : ctx);
        return JSON.stringify({
          batches: (page.batches as Row[]).map((b) => ({
            id: b.id,
            worker: b.worker.name,
            workerId: b.worker.id,
            text: b.text,
            deliverAfter: iso(b.deliverAfter),
            busyDeadline: iso(b.busyDeadline),
            interrupt: b.interrupt,
            overflow: b.overflow,
            ranges: (b.ranges as Row[]).map((r) => ({ channelId: r.channel.id, incarnation: r.incarnation, fromSeq: r.fromSeq, throughSeq: r.throughSeq, seqs: r.seqs })),
          })),
          pageInfo: page.pageInfo,
        });
      }),
  );
  off(
    'hadron_team_chat_inbox_ack',
    'Record that delivery batches were typed (cor:agt:080:16, :17). Pass the ids hadron_team_chat_inbox gave you. The delivered mark ' +
      'rises to the end of each rendered range; with `through` (ONE batch only) only the listed channels move, each to a rendered seq of ' +
      'its own. NEVER moves a read position. Only the receiving host key or own live session may acknowledge it, within 15 minutes; a stale, foreign or ' +
      'forged id is refused and nothing is written. A batch you do not acknowledge stays due. If the ack response is lost, retry the same ' +
      'batchIds: repeated/concurrent acknowledgements are idempotent. Never log or echo a proof in errors or other output.',
    SHAPE_HADRON_TEAM_CHAT_INBOX_ACK,
    async ({ session, batchIds, through }) => {
      const ack = async (ctx: Context) => {
        const r = await M.acknowledgeDeliveryBatches({}, { batchIds, through }, session ? { ...ctx, sessionId: session, sessionBindingRefused: false } : ctx);
        return `Acknowledged ${r.acknowledged}${r.unchanged ? ` (${r.unchanged} already delivered)` : ''}.`;
      };
      // A host key acts as itself and names no session; anyone else is a write and needs a session, like hadron_ack_wakes.
      if (appKeyCaller(ctxOf())) return readWakes(session, ack);
      return write('hadron_team_chat_inbox_ack', session, ack);
    },
  );

  // #2024 (S8): an Agent's ticker templates. Thin over the same resolvers GraphQL serves: reading is reading the
  // Agent, writing is editing it (the Agent ADMIN door), and an edit reaches only future casts. These are a person's
  // edits to an Agent, not a worker's acts, so they take no worker session of their own.
  const renderTemplate = (t: Row): string => {
    const quiet = t.quietHours ? ` · quiet hours ${t.quietHours.timezone} (${t.quietHours.windows.length} window${t.quietHours.windows.length === 1 ? '' : 's'})` : '';
    const reasons = (t.reasons as string[]).map((x) => x.toLowerCase().replace(/_/g, '-')).join('+');
    return `- ${t.name} · code ${agentTickerTemplateFieldResolvers.AgentTickerTemplate.tickCode(t as never)} · id ${t.id} · revision ${t.revision} · every ${t.cadenceSeconds}s (raised to the App floor at cast) · relevance ${t.relevance} · reasons ${reasons}${quiet}`;
  };
  async function plain(fn: (ctx: Context) => Promise<string>) {
    try {
      return textResult(await fn(ctxOf()));
    } catch (e) {
      return refusal(e);
    }
  }
  off(
    'hadron_agent_ticker_template_list',
    'List the ticker templates an Agent declares (#2024). Casting a worker from the Agent creates these tickers for the worker ' +
      'and subscribes it; a template edit reaches only FUTURE casts. Shows the code future copies receive from the current template name. Readable by anyone who can read the Agent.',
    SHAPE_HADRON_AGENT_TICKER_TEMPLATE_LIST,
    async ({ agentRef, session }) => read(session, async (ctx) => {
      const rows = await Q.agentTickerTemplates({}, { agentRef }, ctx);
      if (!rows.length) return 'No ticker templates.';
      return `${rows.length} template${rows.length === 1 ? '' : 's'}:\n\n${rows.map(renderTemplate).join('\n')}`;
    }),
  );
  off(
    'hadron_agent_ticker_template_create',
    'Declare a ticker on an Agent (#2024). Whoever may edit the Agent (ADMIN on it); an App manager is not thereby an Agent editor. ' +
      'Affects only future casts. The cast raises a cadence below the App floor to the floor; it never refuses for that.',
    SHAPE_HADRON_AGENT_TICKER_TEMPLATE_CREATE,
    async ({ agentRef, ...input }) => plain(async (ctx) => `Created.\n${renderTemplate(await M.createAgentTickerTemplate({}, { agentRef, input: toGraphqlTemplate(input) }, ctx))}`),
  );
  off(
    'hadron_agent_ticker_template_update',
    'Change an Agent ticker template (#2024). Omitted fields are unchanged. Pass expectedRevision from the list; a stale one is ' +
      'refused (ticker_template_revision_mismatch) and nothing is written. Affects only future casts.',
    SHAPE_HADRON_AGENT_TICKER_TEMPLATE_UPDATE,
    async ({ id, expectedRevision, ...input }) => plain(async (ctx) => `Updated.\n${renderTemplate(await M.updateAgentTickerTemplate({}, { id, expectedRevision, input: toGraphqlTemplate(input) }, ctx))}`),
  );
  off(
    'hadron_agent_ticker_template_delete',
    'Remove an Agent ticker template (#2024); it stays as history and its name may be reused. Pass expectedRevision from the list. ' +
      'Tickers already generated from it are untouched; only future casts omit it.',
    SHAPE_HADRON_AGENT_TICKER_TEMPLATE_DELETE,
    async ({ id, expectedRevision }) => plain(async (ctx) => {
      await M.deleteAgentTickerTemplate({}, { id, expectedRevision }, ctx);
      return 'Deleted.';
    }),
  );

  off(
    'hadron_ack_wakes',
    'Record that wakes were delivered (cor:agt:080:16, :17). Pass the proofs hadron_due_wakes gave you, after delivering the ' +
      'nudges. Raises each channel\'s delivered-through and records each tick; NEVER moves a read position. Only the requester ' +
      'named in a proof may acknowledge it, within 15 minutes; a stale, foreign or unknown-version proof is refused and ' +
      'nothing is written. A wake you do not acknowledge stays due.',
    SHAPE_HADRON_ACK_WAKES,
    async ({ session, proofs }) => {
      const ack = async (ctx: Context) => {
        const r = await M.acknowledgeWakes({}, { proofs }, ctx);
        return `Acknowledged ${r.acknowledged}${r.unchanged ? ` (${r.unchanged} already delivered)` : ''}.`;
      };
      // An App key (#1749) acts as itself and names no session; the resolver holds the scope and session rules.
      if (appKeyCaller(ctxOf())) return readWakes(session, ack);
      return write('hadron_ack_wakes', session, ack);
    },
  );
}

// ── #2260: parameter shapes, built ONCE per process ──────────────────────────
// A shape is pure data (no session state: moved here only because nothing in it resolves to a
// function- or block-scoped binding, so `tsc` rejects one that captures `auth` or any other
// per-session value). Every MCP session registers these same objects instead of rebuilding ~15 MB.

const SHAPE_HADRON_SET_TEAM_PAUSE = { appRef: z.string().describe('The App id or URN.'), paused: z.boolean().describe('true pauses the team, false resumes it.'), session: SESSION_WRITE };

const SHAPE_HADRON_DELIVERY_SETTINGS_GET = { appRef: z.string().describe('The App id or URN.'), session: SESSION_READ };

const SHAPE_HADRON_DELIVERY_SETTINGS_SET = {
  appRef: z.string().describe('The App id or URN.'),
  input: z.object({
    batchWindowSeconds: z.number().nullable().optional().describe('The shared cadence floor/window in seconds; existing ticker limits apply.'),
    busyDelaySeconds: z.number().nullable().optional().describe('Whole seconds 1..86400, Proposed bounds.'),
    stuckWindowSeconds: z.number().nullable().optional().describe('Whole seconds 1..604800 and greater than busy delay + window, Proposed bounds/relation.'),
    standbyEnabled: z.boolean().nullable().optional().describe('False clears; true is refused until S7 behavior ships.'),
    checkPeriodSeconds: z.number().nullable().optional().describe('#2138: whole seconds 60..86400; a worker with a task is expected to check its team channel this often. Set together with the team ticker cadence.'),
    failedChecksToOverdue: z.number().nullable().optional().describe('#2138: whole number 1..100; OVERDUE after this many missed periods + 5 minutes.'),
    darkAlarmWindowSeconds: z.number().nullable().optional().describe('#2755: whole seconds 300..86400, default 1800; a due wake unacknowledged this long raises the dark-worker alarm. Independent of stuckWindowSeconds.'),
  }).passthrough().describe('Atomic patch. Unknown fields are refused by the shared resolver, never silently removed.'),
  session: SESSION_WRITE,
};

const SHAPE_HADRON_TICKER_LIST = { appRef: z.string().describe('The team App (id or URN).'), session: SESSION_READ };

const SHAPE_HADRON_TICKER_CREATE = {
  appRef: z.string().describe('The team App (id or URN).'),
  name: z.string(),
  cadenceSeconds: z.number().int(),
  anchorAt: z.string().optional().describe('ISO date-time tick counting starts from. Defaults to now.'),
  quietHours: quietHours.optional(),
  channelIds: z.array(z.string()).optional().describe('Channels whose unread can wake a subscriber. Not a grant. Omit for every channel the subscriber watches.'),
  relevance: z.enum(['ALL', 'MENTIONS']).optional().describe('Default ALL.'),
  reasons: z.array(z.enum(['read-team-channel', 'every-tick', 'live-check'])).min(1).optional().describe('Why it fires (cor:agt:080:10). Default [read-team-channel]: only when there is relevant unread. every-tick fires on every tick; live-check fires when the worker has not checked its team channel within the cadence, whatever is unread, and never for a worker not expected to check; the floor, daily budget, pause and dormancy still apply. Never empty.'),
  enabled: z.boolean().optional().describe('Default true.'),
  session: SESSION_WRITE,
};

const SHAPE_HADRON_TICKER_UPDATE = {
  ref,
  name: z.string().optional(),
  cadenceSeconds: z.number().int().optional(),
  anchorAt: z.string().optional(),
  quietHours: quietHours.optional(),
  clearQuietHours: z.boolean().optional(),
  channelIds: z.array(z.string()).optional(),
  clearChannels: z.boolean().optional(),
  relevance: z.enum(['ALL', 'MENTIONS']).optional(),
  reasons: z.array(z.enum(['read-team-channel', 'every-tick', 'live-check'])).min(1).optional(),
  enabled: z.boolean().optional(),
  session: SESSION_WRITE,
};

const SHAPE_HADRON_TICKER_DELETE = { ref, session: SESSION_WRITE };

const SHAPE_HADRON_TICKER_SUBSCRIBE = { ref, workerRef, session: SESSION_WRITE };

const SHAPE_HADRON_TICKER_UNSUBSCRIBE = { ref, workerRef, session: SESSION_WRITE };

const SHAPE_HADRON_WORKER_WAKE_SETTINGS = {
  workerRef,
  mentions: z.enum(['IMMEDIATE', 'OFF']).optional(),
  pausedUntil: z.string().optional().describe('ISO date-time the worker is not woken before.'),
  clearPause: z.boolean().optional(),
  session: z.string().optional().describe('Optional to read; REQUIRED to set (acts as that session\'s worker or person).'),
};

const SHAPE_HADRON_ISOLATE_WORKER = { workerRef, until: z.string().optional().describe('ISO date-time the isolation ends. Default: two hours from now.'), session: SESSION_WRITE };

const SHAPE_HADRON_CLEAR_WORKER_ISOLATION = { workerRef, session: SESSION_WRITE };

const SHAPE_HADRON_DUE_WAKES = {
  appRef: z.string().describe('The team App (id or URN).'),
  workerRefs: z.array(z.string()).optional().describe('Only these workers. Omit for every worker you may read.'),
  first: z.number().int().optional().describe('Workers per page (default 20, max 200).'),
  after: z.string().optional().describe('The previous page\'s endCursor.'),
  accepts: z.array(z.enum(['MENTION', 'TICK', 'TASK', 'STOP'])).optional().describe(
    'The reason kinds you can deliver. Omit it and no stop notice is ever returned. Include STOP only if you type stop notices into the worker\'s terminal: ' +
      'you are then offered the worker\'s newest undelivered stop notice, and the lane you serve is recorded as taking them when you read it in one call from start to end (no workerRefs, no after, no next page: pass first: 200); setting a stop signal is refused until one is.'),
  session: SESSION_READ,
};

const SHAPE_HADRON_TEAM_CHAT_INBOX = {
  appRef: z.string().describe('The team App (id or URN).'),
  workerRefs: z.array(z.string()).optional().describe('Only these workers. Self mode: only your bound worker. Host mode: omit for workers registered on your host.'),
  first: z.number().int().optional().describe('Workers per page (default 20, max 200).'),
  after: z.string().optional().describe('The previous page\'s endCursor.'),
  session: z.string().optional().describe('Self: your own live bound worker session. Host key: omit session and use attention:deliver plus host:operate.'),
};

const SHAPE_HADRON_TEAM_CHAT_INBOX_ACK = {
  batchIds: z.array(z.string()).describe('Batch ids from hadron_team_chat_inbox.'),
  through: z.array(z.object({ channelId: z.string(), seq: z.number().int() })).optional().describe('Partial acknowledgement of a single batch.'),
  session: z.string().optional().describe('Self: required, the same live bound worker session that received the batch. Host key: omit session and use the receiving key.'),
};

const SHAPE_HADRON_AGENT_TICKER_TEMPLATE_LIST = { agentRef: z.string().describe('The Agent: its id or hrn:agent: URN.'), session: SESSION_READ };

const SHAPE_HADRON_AGENT_TICKER_TEMPLATE_CREATE = {
  agentRef: z.string().describe('The Agent: its id or hrn:agent: URN.'),
  name: z.string().describe('Unique among the Agent\'s live templates, ignoring case. A generated ticker is named "<this name> \u00b7 <worker name>".'),
  cadenceSeconds: z.number().int().describe('Requested cadence, 1..86400. The cast raises it to the App\'s own floor.'),
  quietHours: quietHours.optional(),
  relevance: z.enum(['ALL', 'MENTIONS']).optional().describe('Default ALL.'),
  reasons: z.array(z.enum(['read-team-channel', 'every-tick', 'live-check'])).min(1).optional().describe('Why it fires. Default [read-team-channel]. Never empty. A heartbeat is a second template with every-tick.'),
};

const SHAPE_HADRON_AGENT_TICKER_TEMPLATE_UPDATE = {
  id: z.string().describe('The template id (never its name).'),
  expectedRevision: z.number().int().describe('The revision you read; a stale one is refused and nothing is written.'),
  name: z.string().optional(),
  cadenceSeconds: z.number().int().optional(),
  quietHours: quietHours.optional(),
  clearQuietHours: z.boolean().optional(),
  relevance: z.enum(['ALL', 'MENTIONS']).optional(),
  reasons: z.array(z.enum(['read-team-channel', 'every-tick', 'live-check'])).min(1).optional(),
};

const SHAPE_HADRON_AGENT_TICKER_TEMPLATE_DELETE = {
  id: z.string().describe('The template id (never its name).'),
  expectedRevision: z.number().int().describe('The revision you read; a stale one is refused and nothing is written.'),
};

/** The tool spells reasons in kebab-case; GraphQL spells them in capitals. */
function toGraphqlTemplate(input: Row): Row {
  const { reasons, ...rest } = input;
  return reasons === undefined ? rest : { ...rest, reasons: (reasons as string[]).map((r) => reasonEnum(r)) };
}

const SHAPE_HADRON_ACK_WAKES = { proofs: z.array(z.string()).describe('Wake proofs from hadron_due_wakes.'), session: SESSION_WRITE };
