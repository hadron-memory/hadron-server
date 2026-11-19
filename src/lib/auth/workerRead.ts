/** #3332: unchanged worker read/Team Agent gates shared without the resolver cycle. */
import { GraphQLError } from 'graphql';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isAppParticipant } from './appParticipantRead.js';
import { listAppInstallations, resolveAppInstallation } from '../appInstallations.js';
import { resolveAgentRef } from '../entityRef/agentRef.js';
import { resolveAppRef } from '../entityRef/appRef.js';
import { AgentNotFoundError, AmbiguousLegacyUrnError, AppNotFoundError } from '../entityRef/errors.js';
import { isRunPrincipal } from './runPrincipal.js';
import { runMayReadTeam } from './runTeamRead.js';

/** Loc prefix of the role-definition branch in a Team Agent's system memory. */
export const ROLES_BRANCH_PREFIX = 'roles:';

export type AppRow = {
  id: string;
  name: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  uninstalledAt: Date | null;
  /** Honoured by requireWorkerReadAccess whenever the row carries it (#1347 review). */
  deletedAt?: Date | null;
};

/**
 * #3977 (ruling V58, cor:agt:020:04 / cor:dmo:050:11): the one answer for an App the caller cannot REACH. A
 * non-participant gets exactly what an absent App gets, so the refusal is no existence oracle: same code, same
 * message, no extensions beyond the code (an absent ref's `ref` extension and `APP_NOT_FOUND: <ref>` message
 * are replaced by this on the surfaces that use `resolveAppRefConcealed`). A caller who CAN reach the App but
 * lacks the role for the act keeps `forbidden()`.
 */
export const appNotFound = (): GraphQLError =>
  new GraphQLError('App not found.', { extensions: { code: 'APP_NOT_FOUND' } });

/**
 * `resolveAppRef` for the App-scoped team surfaces: an absent ref answers `appNotFound()`, the same bytes a
 * non-participant gets from the gates. Narrow: only the not-found and ambiguous-legacy-URN errors convert (an
 * ambiguous reference would otherwise tell an outsider that SOME App matches it, before any participation check);
 * a database failure propagates. A caller with an ambiguous legacy URN names the App by id instead.
 */
export async function resolveAppRefConcealed(db: Context['db'], appRef: string): Promise<{ id: string }> {
  try {
    return await resolveAppRef(db, appRef);
  } catch (e) {
    if (e instanceof AppNotFoundError || e instanceof AmbiguousLegacyUrnError) throw appNotFound();
    throw e;
  }
}

/**
 * Is `e` one of the refusals the App read gates (`requireWorkerReadAccess`, `requireTeamChatAccess`, the profile
 * gate) throw: the not-found answer for a non-participant, or FORBIDDEN from the profile gate's own arms? Callers
 * that collapse a gate refusal into their own "no match" catch exactly these and rethrow everything else.
 */
export const isAppGateRefusal = (e: unknown): boolean =>
  e instanceof GraphQLError && (e.extensions?.code === 'FORBIDDEN' || e.extensions?.code === 'APP_NOT_FOUND');

export const forbidden = (): GraphQLError =>
  new GraphQLError('You are not authorized to manage workers in this App.', {
    extensions: { code: 'FORBIDDEN' },
  });

/**
 * Read gate for the staff list (mirrors requireTeamChatAccess's 'read' mode —
 * cor:acl:030:01's audience): an AppMember at ANY role, org CONTRIBUTOR+, or
 * the owner of a user-owned App. A pure App-key principal may read its OWN
 * App's staff (team automation follows the roster); impersonation reads are
 * bounded to the support session's single org (#876 class).
 *
 * A userless RUN of the App is not the App's key (#3360,
 * hrn:node:hadronmemory.com:specs:cor:agt:050:23, rulings:0112): it reads its
 * own App's staff only while its automation holds a team snapshot grant
 * (`runMayReadTeam`, the arm the task reads use). Without one it is refused
 * exactly like another App's principal, so the refusal is no grant oracle.
 *
 * An UNINSTALLED App's staff stay readable (the roster remains legible); a
 * soft-DELETED App's do not. Every other reader already refused a deleted App
 * on its own, but `worker(ref)` and `releaseWorker` load the row by id with
 * `findUniqueOrThrow` and relied on this gate — so a participant could read a
 * deleted App's worker while its own field masks (`maySeeWorkerInternals`)
 * refused it. Found by the #1347 differential test; checked here, once.
 */
export async function requireWorkerReadAccess(ctx: Context, app: AppRow): Promise<void> {
  if (app.deletedAt) throw appNotFound();
  if (ctx.impersonation) {
    if (app.organizationId === null || app.organizationId !== ctx.impersonation.orgId) {
      throw appNotFound();
    }
  }
  if (!ctx.userId) {
    if (isRunPrincipal(ctx)) {
      if (await runMayReadTeam(ctx, app)) return;
      throw appNotFound();
    }
    if (ctx.appId && ctx.appId === app.id) return;
    throw appNotFound();
  }
  if (await isAppParticipant(ctx, app)) return;
  throw appNotFound();
}

type TeamAgentRow = {
  id: string;
  name: string;
  urn: string;
  systemMemoryId: string | null;
};

/**
 * Locate the Team Agent (#935 open question 1 — the marker default): with no
 * explicit teamAgentRef, the Team Agent is the SINGLE installed Agent whose
 * system memory carries a roles: branch — the marker makes the App
 * self-describing. Zero markers or two-plus markers are typed refusals, never
 * a guess. Also used by the team-chat and worklog bootstraps.
 */
export async function locateTeamAgent(
  ctx: Context,
  appId: string,
  teamAgentRef: string | null | undefined,
): Promise<TeamAgentRow> {
  if (teamAgentRef) {
    // The explicit ref must name an agent INSTALLED in this App — otherwise
    // the operation would read cast lists (and allocate against a register)
    // from an agent the team App never adopted. #1946 (ruling A): an absent
    // Agent gets the same answer as a not-installed one, and neither carries
    // the Agent's id, so an App reader learns only what is installed here.
    const notInstalled = () => new GraphQLError('teamAgentRef must name an Agent installed in this App.', {
      extensions: { code: 'TEAM_AGENT_NOT_INSTALLED', appId },
    });
    let id: string;
    try {
      ({ id } = await resolveAgentRef(ctx.db, teamAgentRef));
    } catch (e) {
      if (e instanceof AgentNotFoundError) throw notInstalled();
      throw e;
    }
    const row = await resolveAppInstallation(ctx.db, appId, id);
    if (!row) throw notInstalled();
    return row.agent;
  }
  const installed = await listAppInstallations(ctx.db, appId);
  const candidates: TeamAgentRow[] = [];
  for (const { agent } of installed) {
    if (!agent || agent.deletedAt || !agent.systemMemoryId) continue;
    const marker = await ctx.db.node.findFirst({
      // Memory-scoped by construction (findings:unscoped-loc-lookup-crosses-
      // memories): the loc match never leaves this agent's system memory.
      where: {
        memoryId: agent.systemMemoryId,
        deletedAt: null,
        OR: [{ loc: 'roles' }, { loc: { startsWith: ROLES_BRANCH_PREFIX } }],
      },
      select: { id: true },
    });
    if (marker) candidates.push(agent);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new GraphQLError(
      'No installed Agent in this App carries a roles: branch in its system memory, so the Team Agent cannot be inferred. Pass teamAgentRef explicitly, or add role definitions (roles:<role> nodes) to the Team Agent\'s system memory.',
      { extensions: { code: 'TEAM_AGENT_NOT_FOUND', appId } },
    );
  }
  throw new GraphQLError(
    `More than one installed Agent carries a roles: branch — pass teamAgentRef to pick one. Candidates: ${candidates
      .map((c) => `${c.name} (${c.urn})`)
      .join(', ')}.`,
    {
      extensions: {
        code: 'TEAM_AGENT_AMBIGUOUS',
        appId,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, urn: c.urn })),
      },
    },
  );
}

