/**
 * #1562 — page-monitor watches on the MCP surface: list and cancel. Each tool
 * is a thin call into the SAME resolvers GraphQL serves (`resolvers.webPoll.ts`),
 * so the org ADMIN gate, the `tool.web_poll` policy check, the org scoping and
 * the refusal codes are computed once.
 *
 * WHO ACTS. Both tools act as the connection's user. The list is a read, listed
 * in ACTOR_NEUTRAL_TOOLS. The cancel is a write and takes the caller-session
 * gate's optional `session` (#1701) like any other writer.
 */
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { publicErrorExtensions } from '../lib/errorDiagnostics.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { OrgWebPoll } from '../lib/webPolls.js';

type Resolver<A, R> = (parent: unknown, args: A, ctx: Context) => Promise<R>;
const Q = resolvers.Query as unknown as { webPolls: Resolver<{ orgRef: string }, OrgWebPoll[]> };
const M = resolvers.Mutation as unknown as {
  cancelWebPoll: Resolver<{ orgRef: string; jobId: string }, { jobId: string; cancelled: true; alreadyCancelled: boolean }>;
};

/** The write tool, for the caller-session gate's bookkeeping and tests. */
export const WEB_POLL_WRITE_TOOLS = ['hadron_web_poll_cancel'] as const;
/** The read tool: actor-neutral (listed in ACTOR_NEUTRAL_TOOLS). */
export const WEB_POLL_READ_TOOLS = ['hadron_web_poll_list'] as const;

function textResult(text: string, isError = false) {
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: 'text' as const, text }] };
}

/** A resolver refusal as `[<code>] <message>`; anything else is a server fault. */
function refusal(e: unknown) {
  if (e instanceof GraphQLError) {
    const { code } = publicErrorExtensions(e.extensions ?? {});
    return textResult(`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, true);
  }
  if (e instanceof UrnNotQualifiedError) return textResult(`[bad_user_input] ${e.message}`, true);
  throw e;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** One watch as one line: id, state, URL, App, schedule and counters. No credential material exists to show. */
export function renderWebPoll(p: OrgWebPoll): string {
  return [
    `- ${p.jobId} · ${p.status} · ${p.url} · app ${p.appId} · run ${p.sourceRunId}`,
    `  started ${iso(p.createdAt)} · expires ${iso(p.expiresAt)} · next ${iso(p.nextRunAt) ?? 'none'}`,
    `  last checked ${iso(p.lastCheckedAt) ?? 'never'} · last triggered ${iso(p.lastTriggeredAt) ?? 'never'}` +
      ` · triggered ${p.triggerCount}x · ${p.consecutiveFailures} consecutive failure(s)`,
  ].join('\n');
}

/** Register the web-poll tools on one MCP server instance. `auth` is the connection's principal. */
export function registerWebPollTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined,
    sessionId: (auth.requestSession ? auth.requestSession.sessionId : auth.sessionId) ?? undefined,
    sessionBindingRefused: auth.requestSession ? auth.requestSession.refused : auth.sessionBindingRefused,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });
  const orgOf = (given: string | undefined) => given ?? auth.organizationId ?? undefined;
  const noOrg = () => textResult('[bad_user_input] Pass orgRef, or select an organization with hadron_set_active_org.', true);

  server.tool(
    'hadron_web_poll_list',
    'List an organization\'s active page-monitor watches (the web_poll_start jobs): id, state, the query-free URL, the App ' +
      'and run that started it, schedule and trigger counters. No credential material is returned. Org ADMIN/OWNER only, ' +
      'and the org, user and App policy must allow tool.web_poll.',
    SHAPE_HADRON_WEB_POLL_LIST,
    async (args: { orgRef?: string }) => {
      const ref = orgOf(args.orgRef);
      if (!ref) return noOrg();
      try {
        const polls = await Q.webPolls({}, { orgRef: ref }, ctxOf());
        return textResult(polls.length ? `${polls.length} watch(es):\n\n${polls.map(renderWebPoll).join('\n')}` : 'No active watches.');
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.tool(
    'hadron_web_poll_cancel',
    'Stop a page-monitor watch by jobId (from hadron_web_poll_list). Same gate as the list. A job id from another ' +
      'organization answers not_found, like a missing one. Cancelling a stopped watch succeeds and says so.',
    SHAPE_HADRON_WEB_POLL_CANCEL,
    async (args: { orgRef?: string; jobId: string }) => {
      const ref = orgOf(args.orgRef);
      if (!ref) return noOrg();
      try {
        const r = await M.cancelWebPoll({}, { orgRef: ref, jobId: args.jobId }, ctxOf());
        return textResult(r.alreadyCancelled ? `Watch ${r.jobId} was already cancelled.` : `Cancelled watch ${r.jobId}.`);
      } catch (e) {
        return refusal(e);
      }
    },
  );
}

// Parameter shapes live at module scope so every MCP server instance shares them (#2260).
const orgRef = z.string().optional().describe('The organization id or URN. Defaults to the active organization.');
const SHAPE_HADRON_WEB_POLL_LIST = { orgRef };
const SHAPE_HADRON_WEB_POLL_CANCEL = {
  orgRef,
  jobId: z.string().describe('The watch\'s jobId, as hadron_web_poll_list prints it.'),
};
