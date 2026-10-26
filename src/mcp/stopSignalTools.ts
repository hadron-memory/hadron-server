import { mcpRequestSessionContext } from './requestSession.js';
/**
 * #2022 (S6) — stop signals on the MCP surface (cor:agt:090): set, lift and list. Each tool is a thin call into the
 * SAME resolvers GraphQL serves (`resolvers.stopSignal.ts`), so the gates and refusal codes are one.
 *
 * WHO ACTS. Setting and lifting are writes. A person passes a plain session (one bound to no worker) and acts as
 * themselves; a write without a session is refused, never inferred (#1697 / #1701). A worker's session is accepted
 * as a session but refused by the resolver (a worker's session doesn't manage the App, H26 reading A). A host key acts
 * as itself and carries NO session (a session it names is refused, #8097). The list is a read with an optional session.
 */
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { publicErrorExtensions } from '../lib/errorDiagnostics.js';
import { appKeyCaller } from '../lib/appKeyScopes/scopes.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { type AuthContext, validateSessionBinding } from '../middleware/auth.js';
import { runAsActor } from '../lib/requestActor.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { StopSignalView } from '../api/graphql/schema/resolvers.stopSignal.js';
import { resolveAppRef } from '../lib/entityRef/appRef.js';
import { stopNames } from '../lib/stopSignals/names.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';

type Row = Record<string, any>;
type Resolver<A, R> = (parent: unknown, args: A, ctx: Context) => Promise<R>;
const Q = resolvers.Query as unknown as {
  teamStopSignals: Resolver<{ appRef: string; worker?: string; includeEnded?: boolean; first?: number; after?: string }, { signals: StopSignalView[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>;
};
const M = resolvers.Mutation as unknown as {
  setTeamStopSignal: Resolver<{ input: Row }, StopSignalView>;
  liftTeamStopSignal: Resolver<{ appRef: string; id: string }, { signal: StopSignalView; changed: boolean }>;
};

/** The write tools: gated by the caller-session gate. */
export const STOP_SIGNAL_WRITE_TOOLS = ['hadron_stop_signal_set', 'hadron_stop_signal_lift'] as const;
/** The read tool: actor-neutral (listed in ACTOR_NEUTRAL_TOOLS), with its own optional session. */
export const STOP_SIGNAL_READ_TOOLS = ['hadron_stop_signal_list'] as const;

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

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The public names a line shows beside the ids (Uma #2166 P2-2): worker name and URN, setter handle, host label. */
type Names = { worker: (id: string | null) => { name: string; urn: string | null } | null; user: (id: string | null) => string | null; hostLabel: (hostId: string | null) => string | null };
const NO_NAMES: Names = { worker: () => null, user: () => null, hostLabel: () => null };

/** One signal as one line: ids with their names, level, scope, target, setter, times. */
export function renderSignal(s: StopSignalView, n: Names = NO_NAMES): string {
  const w = n.worker(s.targetWorkerId);
  const label = n.hostLabel(s.targetHostId);
  const target = s.scope === 'HOST'
    ? `host ${s.targetHostId ?? '?'}${label ? ` (${label})` : ''}`
    : `${s.scope.toLowerCase()} ${w ? `${w.name} (${w.urn ?? s.targetWorkerId})` : s.targetWorkerId ?? '?'}`;
  const handle = n.user(s.setByUserId);
  const setter = s.setByHostKey ? 'a host key' : handle ? `@${handle}` : `user ${s.setByUserId ?? '?'}`;
  const end = s.live
    ? (s.until ? `until ${iso(s.until)}` : 'until lifted')
    : `${(s.endKind ?? 'ENDED').toLowerCase()} ${iso(s.endedAt)}`;
  return `- ${s.id} · ${s.level} · ${target} · set ${iso(s.setAt)} by ${setter} · ${s.live ? 'LIVE' : 'ended'} · ${end}`;
}

const SESSION_WRITE = z.string().optional().describe(
  'A person: REQUIRED, a plain session (one bound to no worker; hadron_start_session with no worker). A worker\'s session ' +
    'is refused: a worker does not set stop signals. A host key: omit it (a key carries no session).',
);
const SESSION_READ = z.string().optional().describe('Optional session id: read as that session\'s worker (the signals covering it).');
const appRef = z.string().describe('The App id or URN.');

/** Look the names up for `signals`, inside their App only. Any failure renders the ids alone. */
async function namesFor(db: PrismaClient, appRef: string, signals: StopSignalView[]): Promise<Names> {
  try {
    const { id: appId } = await resolveAppRef(db, appRef);
    const hostIds = [...new Set(signals.map((s) => s.targetHostId).filter((h): h is string => !!h))];
    const [n, hosts] = await Promise.all([
      stopNames(db, appId, { workerIds: signals.map((s) => s.targetWorkerId), userIds: signals.map((s) => s.setByUserId) }),
      hostIds.length ? db.hostRegistration.findMany({ where: { appId, hostId: { in: hostIds } }, select: { hostId: true, label: true } }) : [],
    ]);
    const labels = new Map(hosts.map((h) => [h.hostId, h.label]));
    return { worker: n.worker, user: n.user, hostLabel: (h) => (h ? labels.get(h) ?? null : null) };
  } catch {
    return NO_NAMES;
  }
}

/** Register the stop-signal tools on one MCP server instance. `auth` is the connection's principal. */
export function registerStopSignalTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined,
    ...mcpRequestSessionContext(auth),
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });

  /** A write: a host key as itself (no session); anyone else needs a validated session, and acts as its actor. */
  async function write(tool: string, session: string | undefined, call: (ctx: Context) => Promise<string>) {
    const ctx = ctxOf();
    if (appKeyCaller(ctx)) {
      try {
        return textResult(await call(session ? { ...ctx, sessionId: session } : ctx));
      } catch (e) {
        return refusal(e);
      }
    }
    if (!session) {
      return textResult(`[session_required] ${tool}: pass session, a plain session (hadron_start_session with no worker). Nothing was written.`, true);
    }
    const valid = await validateSessionBinding(db, auth, session);
    if (!valid) {
      return textResult(`[session_not_bound] ${tool}: session "${session}" is not one of your open sessions. Nothing was written. hadron_whoami lists yours.`, true);
    }
    try {
      return textResult(await runAsActor(valid.actor, () => call(ctx)));
    } catch (e) {
      return refusal(e);
    }
  }

  async function read(session: string | undefined, fn: (ctx: Context) => Promise<string>) {
    const ctx = ctxOf();
    try {
      if (appKeyCaller(ctx)) return textResult(await fn(session ? { ...ctx, sessionId: session } : ctx));
      if (!session) return textResult(await fn(ctx));
      const valid = await validateSessionBinding(db, auth, session);
      if (!valid) return textResult(`[session_not_bound] session "${session}" is not one of your open sessions.`, true);
      return textResult(await runAsActor(valid.actor, () => fn(ctx)));
    } catch (e) {
      return refusal(e);
    }
  }

  server.tool(
    'hadron_stop_signal_set',
    'Set a STOP SIGNAL on an App (cor:agt:090): PAUSE_DISPATCH stops assignment; PAUSE also stops ticks and stall time; ' +
      'HALT also tells the worker to save its work and write a hand-off now (typed as an ordinary notice into a verified-empty input; no interrupt key is sent). Scope WORKER (one worker), TEAM (a head and its whole reporting tree) or HOST (the workers a ' +
      'host registration lists). Whoever manages the App, any level and scope; a host key, a HALT on its own host only. ' +
      'Never replaces another signal. Refused with STOP_SIGNAL_UNAVAILABLE (R95, #2173/#2169) while a worker it would cover is on a lane no stop-notice consumer ' +
      'has declared fresh (a consumer declares by polling hadron_due_wakes with accepts including STOP), because a stopped worker would not be told; lifting and listing still work.',
    SHAPE_HADRON_STOP_SIGNAL_SET,
    async ({ session, ...input }) => write('hadron_stop_signal_set', session, async (ctx) => {
      const s = await M.setTeamStopSignal({}, { input }, ctx);
      return renderSignal(s, await namesFor(db, input.appRef, [s]));
    }),
  );

  server.tool(
    'hadron_stop_signal_lift',
    'Lift a stop signal (cor:agt:090:05). Lifting one never ends another; lifting one that already ended changes nothing ' +
      'and tells nobody again. Whoever manages the App, any; a host key, a HALT on its own host.',
    SHAPE_HADRON_STOP_SIGNAL_LIFT,
    async ({ appRef: a, id, session }) => write('hadron_stop_signal_lift', session, async (ctx) => {
      const r = await M.liftTeamStopSignal({}, { appRef: a, id }, ctx);
      return `${r.changed ? 'lifted' : 'unchanged (already ended)'}\n${renderSignal(r.signal, await namesFor(db, a, [r.signal]))}`;
    }),
  );

  server.tool(
    'hadron_stop_signal_list',
    'List an App\'s stop signals (cor:agt:090:07), oldest set first. A person in the App sees all of them; a worker\'s ' +
      'session sees the live ones covering it; a host key sees its own host\'s.',
    SHAPE_HADRON_STOP_SIGNAL_LIST,
    async ({ session, ...args }) => read(session, async (ctx) => {
      const page = await Q.teamStopSignals({}, args, ctx);
      const names = await namesFor(db, args.appRef, page.signals);
      const lines = page.signals.map((s) => renderSignal(s, names));
      if (lines.length === 0) lines.push('No stop signals.');
      if (page.pageInfo.hasNextPage) lines.push(`more: after=${page.pageInfo.endCursor}`);
      return lines.join('\n');
    }),
  );
}

// ── #2260: parameter shapes, built ONCE per process ──────────────────────────
// A shape is pure data (no session state: moved here only because nothing in it resolves to a
// function- or block-scoped binding, so `tsc` rejects one that captures `auth` or any other
// per-session value). Every MCP session registers these same objects instead of rebuilding ~15 MB.

const SHAPE_HADRON_STOP_SIGNAL_SET = {
  appRef,
  level: z.enum(['PAUSE_DISPATCH', 'PAUSE', 'HALT']),
  scope: z.enum(['WORKER', 'TEAM', 'HOST']),
  worker: z.string().optional().describe('WORKER / TEAM: the target worker (id, name or URN; a team by its head).'),
  host: z.string().optional().describe('HOST: the host id. A host key may omit it.'),
  until: z.string().optional().describe('ISO time it ends on its own; later than now. Omitted: until lifted.'),
  session: SESSION_WRITE,
};

const SHAPE_HADRON_STOP_SIGNAL_LIFT = { appRef, id: z.string().describe('The stop signal id.'), session: SESSION_WRITE };

const SHAPE_HADRON_STOP_SIGNAL_LIST = {
  appRef,
  worker: z.string().optional().describe('Only the signals covering this worker now.'),
  includeEnded: z.boolean().optional().describe('Add ended signals (not for a worker\'s session).'),
  first: z.number().int().optional().describe('Page size, default 20, at most 200.'),
  after: z.string().optional().describe('The endCursor of the previous page.'),
  session: SESSION_READ,
};
