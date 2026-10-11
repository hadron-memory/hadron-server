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
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { tickerFieldResolvers } from '../api/graphql/schema/resolvers.ticker.js';
import { type AuthContext, validateSessionBinding } from '../middleware/auth.js';
import { runAsActor } from '../lib/requestActor.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import type { PrismaClient } from '../generated/prisma/index.js';

type Row = Record<string, any>;
type Resolver<A, R> = (parent: unknown, args: A, ctx: Context) => Promise<R>;
const Q = resolvers.Query as unknown as {
  tickers: Resolver<{ appRef: string }, Row[]>;
  ticker: Resolver<{ ref: string }, Row | null>;
  workerWakeSettings: Resolver<{ workerRef: string }, Row>;
};
const M = resolvers.Mutation as unknown as {
  createTicker: Resolver<{ appRef: string; input: Row }, Row>;
  updateTicker: Resolver<{ ref: string; input: Row }, Row>;
  deleteTicker: Resolver<{ ref: string }, boolean>;
  subscribeWorker: Resolver<{ tickerRef: string; workerRef: string }, { subscription: Row; announcement: string | null }>;
  unsubscribeWorker: Resolver<{ tickerRef: string; workerRef: string }, { subscription: Row; announcement: string | null }>;
  setWorkerWakeSettings: Resolver<{ workerRef: string; input: Row }, Row>;
};
const FT = tickerFieldResolvers.Ticker;
const FW = tickerFieldResolvers.WorkerWakeSettings;

/** The write tools, for the caller-session gate's bookkeeping and tests. */
export const TICKER_WRITE_TOOLS = [
  'hadron_ticker_create', 'hadron_ticker_update', 'hadron_ticker_delete',
  'hadron_ticker_subscribe', 'hadron_ticker_unsubscribe',
] as const;
/**
 * Actor-neutral tools (listed in ACTOR_NEUTRAL_TOOLS): each takes its own
 * optional `session`. `hadron_worker_wake_settings` is a read until it is given
 * something to set, and then enforces the write rule itself.
 */
export const TICKER_READ_TOOLS = ['hadron_ticker_list', 'hadron_worker_wake_settings'] as const;

function textResult(text: string, isError = false) {
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: 'text' as const, text }] };
}

/** A resolver refusal as `[<code>] <message>` plus its extensions; anything else is a server fault. */
function refusal(e: unknown) {
  if (e instanceof GraphQLError) {
    const { code, ...rest } = e.extensions ?? {};
    const extras = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return textResult([`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, ...extras].join('\n'), true);
  }
  if (e instanceof UrnNotQualifiedError) return textResult(`[bad_user_input] ${e.message}`, true);
  throw e;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function renderTicker(t: Row, ctx: Context): Promise<string> {
  const [urn, owner, subs] = await Promise.all([
    FT.urn(t as never, {}, ctx),
    FT.owner(t as never, {}, ctx),
    FT.subscribers(t as never, { first: 200 }, ctx),
  ]);
  const names: string[] = [];
  for (const s of subs.items) {
    const w = await tickerFieldResolvers.TickerSubscription.worker(s, {}, ctx);
    names.push(w ? w.name : s.workerId);
  }
  const quiet = t.quietHours ? `quiet hours ${t.quietHours.timezone} (${t.quietHours.windows.length} window${t.quietHours.windows.length === 1 ? '' : 's'})` : null;
  return [
    `- ${t.name} · ${urn ?? t.id} · every ${t.cadenceSeconds}s · ${t.enabled ? 'enabled' : 'disabled'} · relevance ${t.relevance}`,
    `  anchor ${iso(t.anchorAt)}${quiet ? ` · ${quiet}` : ''}${t.channelIds.length ? ` · ${t.channelIds.length} channel(s)` : ''}`,
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
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
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
    if (!(await validateSessionBinding(db, auth, session))) {
      return textResult(
        `[session_not_bound] ${tool}: session "${session}" is not one of your open sessions (it may have ended, gone ` +
          'dormant, or belong to someone else). Nothing was written. hadron_whoami lists yours.',
        true,
      );
    }
    const ctx = ctxOf();
    try {
      return textResult(await call(ctx));
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

  server.tool(
    'hadron_ticker_list',
    'List the live tickers of a team App, with their cadence, owner and subscribers (cor:agt:080). A ticker is a named, ' +
      'cadenced wake schedule; workers subscribe to the ones they want. Readable by the App\'s participants.',
    { appRef: z.string().describe('The team App (id or URN).'), session: SESSION_READ },
    async ({ appRef, session }) =>
      read(session, async (ctx) => {
        const rows = await Q.tickers({}, { appRef }, ctx);
        if (!rows.length) return 'No live tickers.';
        const lines = await Promise.all(rows.map((t) => renderTicker(t, ctx)));
        return `${rows.length} ticker${rows.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`;
      }),
  );

  server.tool(
    'hadron_ticker_create',
    'Create a ticker in a team App (cor:agt:080:18). Any App participant, or a session bound to a worker of the App, up to ' +
      'the App\'s live-ticker cap (20 by default). You become its owner. Its slug, and so its URN, is derived from the name ' +
      'and permanent. The cadence is in seconds, from the App\'s floor (120 by default) to 86400.',
    {
      appRef: z.string().describe('The team App (id or URN).'),
      name: z.string(),
      cadenceSeconds: z.number().int(),
      anchorAt: z.string().optional().describe('ISO date-time tick counting starts from. Defaults to now.'),
      quietHours: quietHours.optional(),
      channelIds: z.array(z.string()).optional().describe('Channels whose unread can wake a subscriber. Not a grant. Omit for every channel the subscriber watches.'),
      relevance: z.enum(['ALL', 'MENTIONS']).optional().describe('Default ALL.'),
      enabled: z.boolean().optional().describe('Default true.'),
      session: SESSION_WRITE,
    },
    async ({ session, appRef, ...input }) =>
      write('hadron_ticker_create', session, async (ctx) => {
        const t = await M.createTicker({}, { appRef, input }, ctx);
        return `Created.\n\n${await renderTicker(t, ctx)}`;
      }),
  );

  server.tool(
    'hadron_ticker_update',
    'Change a ticker, or enable or disable it (cor:agt:080:18): its owner, the holder of its owning worker, or whoever manages ' +
      'the App. Absent fields stay as they are; clearQuietHours and clearChannels remove those. The slug never changes.',
    {
      ref,
      name: z.string().optional(),
      cadenceSeconds: z.number().int().optional(),
      anchorAt: z.string().optional(),
      quietHours: quietHours.optional(),
      clearQuietHours: z.boolean().optional(),
      channelIds: z.array(z.string()).optional(),
      clearChannels: z.boolean().optional(),
      relevance: z.enum(['ALL', 'MENTIONS']).optional(),
      enabled: z.boolean().optional(),
      session: SESSION_WRITE,
    },
    async ({ session, ref: r, ...input }) =>
      write('hadron_ticker_update', session, async (ctx) => {
        const t = await M.updateTicker({}, { ref: r, input }, ctx);
        return `Updated.\n\n${await renderTicker(t, ctx)}`;
      }),
  );

  server.tool(
    'hadron_ticker_delete',
    'Delete a ticker (cor:agt:080:18): its owner, the holder of its owning worker, or whoever manages the App. Its ' +
      'subscriptions end (reason TICKER_DELETED); its name may be reused, its slug never.',
    { ref, session: SESSION_WRITE },
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

  server.tool(
    'hadron_ticker_subscribe',
    'Subscribe a worker to a ticker (cor:agt:080:20). Its holder and whoever manages the App, to any ticker. The worker ' +
      'itself only to a ticker at or slower than the App\'s self-subscription cadence (600s by default); faster is refused ' +
      'SUBSCRIBE_CADENCE_NEEDS_HOLDER. A worker holding the may-subscribe-workers grant, with a person behind the call, ' +
      'for OTHER workers (never itself); that use is announced to the team chat. A worker nobody holds: only a manager or the grant.',
    { ref, workerRef, session: SESSION_WRITE },
    async ({ session, ref: r, workerRef: w }) =>
      write('hadron_ticker_subscribe', session, async (ctx) =>
        subscribeText('Subscribed', await M.subscribeWorker({}, { tickerRef: r, workerRef: w }, ctx))),
  );

  server.tool(
    'hadron_ticker_unsubscribe',
    'End a worker\'s subscription to a ticker (cor:agt:080:20): the same callers as hadron_ticker_subscribe, and a worker ' +
      'may always unsubscribe itself.',
    { ref, workerRef, session: SESSION_WRITE },
    async ({ session, ref: r, workerRef: w }) =>
      write('hadron_ticker_unsubscribe', session, async (ctx) =>
        subscribeText('Unsubscribed', await M.unsubscribeWorker({}, { tickerRef: r, workerRef: w }, ctx))),
  );

  server.tool(
    'hadron_worker_wake_settings',
    'Read a worker\'s wake settings, or set them (cor:agt:080:03, :21). With nothing to set, reads: whether mentions wake ' +
      'it (IMMEDIATE or OFF), its pause, its subscriptions and its effective cadence. With mentions, pausedUntil or ' +
      'clearPause, sets them (needs session): the worker itself, its holder, or whoever manages the App. The ' +
      'may-subscribe-workers grant never changes these. A pause belongs to the worker, not a session.',
    {
      workerRef,
      mentions: z.enum(['IMMEDIATE', 'OFF']).optional(),
      pausedUntil: z.string().optional().describe('ISO date-time the worker is not woken before.'),
      clearPause: z.boolean().optional(),
      session: z.string().optional().describe('Optional to read; REQUIRED to set (acts as that session\'s worker or person).'),
    },
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
            `${s.pausedUntil ? `, paused until ${iso(s.pausedUntil)}` : ', not paused'}`,
          `subscriptions: ${names.length ? names.join(', ') : 'none'} · effective cadence ${cadence ? `${cadence}s` : 'none'}`,
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
}
