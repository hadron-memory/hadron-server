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
  if (e instanceof GraphQLError) {
    const { code, ...rest } = publicErrorExtensions(e.extensions ?? {});
    const extras = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return textResult([`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, ...extras].join('\n'), true);
  }
  if (e instanceof UrnNotQualifiedError) return textResult(`[bad_user_input] ${e.message}`, true);
  throw e;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** One signal as one line: ids, level, scope, target, setter, times. */
export function renderSignal(s: StopSignalView): string {
  const target = s.scope === 'HOST' ? `host ${s.targetHostId ?? '?'}` : `${s.scope.toLowerCase()} ${s.targetWorkerId ?? '?'}`;
  const setter = s.setByHostKey ? 'a host key' : `user ${s.setByUserId ?? '?'}`;
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

/** Register the stop-signal tools on one MCP server instance. `auth` is the connection's principal. */
export function registerStopSignalTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined,
    sessionId: (auth.requestSession ? auth.requestSession.sessionId : auth.sessionId) ?? undefined,
    sessionBindingRefused: auth.requestSession ? auth.requestSession.refused : auth.sessionBindingRefused,
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
      'HALT also interrupts. Scope WORKER (one worker), TEAM (a head and its whole reporting tree) or HOST (the workers a ' +
      'host registration lists). Whoever manages the App, any level and scope; a host key, a HALT on its own host only. ' +
      'Never replaces another signal.',
    {
      appRef,
      level: z.enum(['PAUSE_DISPATCH', 'PAUSE', 'HALT']),
      scope: z.enum(['WORKER', 'TEAM', 'HOST']),
      worker: z.string().optional().describe('WORKER / TEAM: the target worker (id, name or URN; a team by its head).'),
      host: z.string().optional().describe('HOST: the host id. A host key may omit it.'),
      until: z.string().optional().describe('ISO time it ends on its own; later than now. Omitted: until lifted.'),
      session: SESSION_WRITE,
    },
    async ({ session, ...input }) => write('hadron_stop_signal_set', session, async (ctx) =>
      renderSignal(await M.setTeamStopSignal({}, { input }, ctx))),
  );

  server.tool(
    'hadron_stop_signal_lift',
    'Lift a stop signal (cor:agt:090:05). Lifting one never ends another; lifting one that already ended changes nothing ' +
      'and tells nobody again. Whoever manages the App, any; a host key, a HALT on its own host.',
    { appRef, id: z.string().describe('The stop signal id.'), session: SESSION_WRITE },
    async ({ appRef: a, id, session }) => write('hadron_stop_signal_lift', session, async (ctx) => {
      const r = await M.liftTeamStopSignal({}, { appRef: a, id }, ctx);
      return `${r.changed ? 'lifted' : 'unchanged (already ended)'}\n${renderSignal(r.signal)}`;
    }),
  );

  server.tool(
    'hadron_stop_signal_list',
    'List an App\'s stop signals (cor:agt:090:07), oldest set first. A person in the App sees all of them; a worker\'s ' +
      'session sees the live ones covering it; a host key sees its own host\'s.',
    {
      appRef,
      worker: z.string().optional().describe('Only the signals covering this worker now.'),
      includeEnded: z.boolean().optional().describe('Add ended signals (not for a worker\'s session).'),
      first: z.number().int().optional().describe('Page size, default 50, at most 200.'),
      after: z.string().optional().describe('The endCursor of the previous page.'),
      session: SESSION_READ,
    },
    async ({ session, ...args }) => read(session, async (ctx) => {
      const page = await Q.teamStopSignals({}, args, ctx);
      const lines = page.signals.map(renderSignal);
      if (lines.length === 0) lines.push('No stop signals.');
      if (page.pageInfo.hasNextPage) lines.push(`more: after=${page.pageInfo.endCursor}`);
      return lines.join('\n');
    }),
  );
}
