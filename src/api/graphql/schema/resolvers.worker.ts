// Workers — #974 (re-cut): the named casting of an installed Agent into an
// App (cor:dmo:050:11, cor:agt:020:01/:02). A persona is universal DRESSING on
// an Agent (`personaRole` + the `systemPrompt` template); the Worker is the
// local named identity ("Iris") that does attributable work. `castWorker`
// supersedes `createTeamPersona`'s minting semantics: it no longer mints an
// Agent at all — it casts an EXISTING installed agent under a name, allocating
// that name against the `workers_app_name_uniq` constraint (the allocation
// primitive; cor:agt:020:02). #1677 adds a serialized Unicode confusable
// check at casting; it creates no lease and preserves existing identities.
//
// Cast lists stay ergonomics, never gates (cor:agt:020:01): role definitions
// and name registers remain CONTENT in the Team Agent's system memory
// (`roles:<role>` nodes, `data.names`), read at CASTING time — and only when
// the caller names no explicit worker name. Casting with an explicit name
// needs no Team Agent at all.
import { normalizeFamily, tierOf } from '../../../lib/agentTasks/family.js';
import { lockStopFence } from '../../../lib/stopSignals/state.js';
import { reconcileStopCoverage } from '../../../lib/stopSignals/lifecycle.js';
import { generateId } from '../../../lib/id.js';
import { s7Available } from '../../../lib/tickers/s7Availability.js';
import { GraphQLError } from 'graphql';
import { WORKER_SIGNATURE_DEFAULTS, normalizeWorkerSignature, withWorkerSignatures } from '../../../lib/workerSignature.js';
import { assertWorkerNameNotConfusable, lockWorkerNames } from '../../../lib/workerName.js';
import {
  GeneratedNameTooLongError, GeneratedTickerLimitError, GeneratedTickerNameTakenError,
  endGeneratedTickersForWorker, instantiateAgentTickerTemplates, planGeneratedTickers,
  GeneratedAgentNotInstalledError, lockAgentTemplates,
} from '../../../lib/tickers/agentTickerTemplates.js';
import { lockAppTickers, reasonEnum } from './resolvers.ticker.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import {
  AgentNotFoundError, WorkerNotFoundError,
  AmbiguousUserRefError,
  UserNotFoundError,
} from '../../../lib/entityRef/errors.js';
import { isEmailUserRef, resolveUserRefOrEmail } from '../../../lib/entityRef/userRef.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import { normalizeUrnForLookup, hasSchemePrefix } from '../../../lib/urn.js';
import { BROADCAST_MENTION_TOKENS, mentionTokenOf } from '../../../lib/mentionToken.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { nextFreeWorkerSlug } from '../../../lib/workerSlug.js';
import {
  resolveWorkerRef as resolveWorkerRefId,
  composeWorkerUrn,
} from '../../../lib/entityRef/workerRef.js';
import {
  getMemoryEncryptionInfo,
  decryptNodeFields,
} from '../../../lib/nodeCrypto.js';
import { applyPlatformVariables, templateBindsName, type PlatformVariableValues } from '../../../lib/personaDescription.js';
// Spec 049 Phase 6 — the register block, derived data through one composition point.
import { renderDerivedBlocks, resolveRegister } from '../../../lib/resolveRegister.js';
import {
  newestHandoff,
  handoffSessionId,
  continuityStatusOf,
} from '../../../lib/workerHandoff.js';
import { resolveMemoryRoot } from './chat-scope.js';
import { idleCutoffs, toNaiveUtc } from '../../../lib/sessionActivity.js';
import { loadWorkerCheckStatuses, type WorkerCheckStatus } from '../../../lib/workerCheckStatus.js';
import { userUrn } from '../../../lib/userHandle.js';
import { canSeeUserPersonalFields } from '../../../lib/auth/userVisibility.js';
import { participantAppWhere } from '../../../lib/auth/appParticipation.js';
import { castTeamChoice, teamPlacement, type CastTeamArgs } from '../../../lib/workerTeamChoice.js';
import { lockAppReportsTo, writeReportsTo } from '../../../lib/workerReportsTo.js';
import { deletePristineGeneratedTickers, miscastHasReferences } from '../../../lib/workerMiscastRepair.js';
import { currentActor } from '../../../lib/requestActor.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { resolveTaskActor, type TaskApp } from './resolvers.agentTask.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { appendWorkerCastingEvent, eventActor } from '../../../lib/agentTasks/events.js';
import { assertCastable, workerAgentNotInstalled } from '../../../lib/workerCasting.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import {
  type Context,
  requireOrgRole,
  requireAgentAccess,
  requireOwnerOrOrgRole,
  isNonReaderAppMember,
  isAppParticipant,
  isPlatformAdmin,
  clampListTake,
  safeCanonicalUrn,
  isMemoryReadableCached,
} from './resolvers.helpers.js';

/** Loc prefix of the role-definition branch in a Team Agent's system memory. */
export const ROLES_BRANCH_PREFIX = 'roles:';

/**
 * Backstop on slug-race retries in `castWorker` (#991). Not an allocation
 * budget — see `createWithSlug` for why it must sit far above any plausible
 * concurrent-cast count rather than at a handful.
 */
const SLUG_RACE_RETRY_LIMIT = 50;

type AppRow = {
  id: string;
  name: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  uninstalledAt: Date | null;
  /** Honoured by requireWorkerReadAccess whenever the row carries it (#1347 review). */
  deletedAt?: Date | null;
};

const forbidden = (): GraphQLError =>
  new GraphQLError('You are not authorized to manage workers in this App.', {
    extensions: { code: 'FORBIDDEN' },
  });

/**
 * Staffing gate (inherited from #935's persona-mint lean): casting, retiring,
 * and hard-deleting a Worker are everyday team acts, so the bar sits below
 * org ADMIN. May staff:
 *   - an org member with CONTRIBUTOR+ on the App's org,
 *   - an AppMember of the App whose role is not (case-insensitively)
 *     'reader' (#952's shared predicate), or
 *   - the owner of a user-owned App (strictly owner-only, spec 047).
 *
 * Principal shapes (findings:auth-appid-credential-vs-selection): a PURE
 * App-key principal (appId, no userId) is DENIED — staffing is a human act.
 * A hybrid user+selection principal is judged solely on the USER's own
 * rights. Impersonation sessions are read-only support views — never staff.
 */
async function requireWorkerStaffAccess(ctx: Context, app: AppRow): Promise<void> {
  if (ctx.impersonation) throw forbidden();
  if (!ctx.userId) throw forbidden();
  if (app.ownerUserId !== null) {
    // spec 047: user-owned entities are strictly owner-only —
    // findings:org-xor-owner-null-comparison-bypass: branch on the ownership
    // class BEFORE comparing owner columns.
    if (ctx.userId === app.ownerUserId) return;
    throw forbidden();
  }
  if (app.organizationId !== null) {
    try {
      await requireOrgRole(ctx, app.organizationId, 'CONTRIBUTOR');
      return;
    } catch (e) {
      // requireOrgRole signals denial with a FORBIDDEN GraphQLError whose message
      // is 'Forbidden' (#1493), which this match still catches; anything
      // else (a DB failure inside the membership lookup) must propagate rather
      // than read as "not a member" (review:narrow-catch-blocks).
      if (!(e instanceof Error && e.message === 'Forbidden')) throw e;
      // fall through to the AppMember path
    }
    if (await isNonReaderAppMember(ctx, app)) return;
  }
  throw forbidden();
}

/**
 * Read gate for the staff list (mirrors requireTeamChatAccess's 'read' mode —
 * cor:acl:030:01's audience): an AppMember at ANY role, org CONTRIBUTOR+, or
 * the owner of a user-owned App. A pure App-key principal may read its OWN
 * App's staff (team automation follows the roster); impersonation reads are
 * bounded to the support session's single org (#876 class).
 *
 * An UNINSTALLED App's staff stay readable (the roster remains legible); a
 * soft-DELETED App's do not. Every other reader already refused a deleted App
 * on its own, but `worker(ref)` and `releaseWorker` load the row by id with
 * `findUniqueOrThrow` and relied on this gate — so a participant could read a
 * deleted App's worker while its own field masks (`maySeeWorkerInternals`)
 * refused it. Found by the #1347 differential test; checked here, once.
 */
export async function requireWorkerReadAccess(ctx: Context, app: AppRow): Promise<void> {
  if (app.deletedAt) throw forbidden();
  if (ctx.impersonation) {
    if (app.organizationId === null || app.organizationId !== ctx.impersonation.orgId) {
      throw forbidden();
    }
  }
  if (!ctx.userId) {
    if (ctx.appId && ctx.appId === app.id) return;
    throw forbidden();
  }
  if (await isAppParticipant(ctx, app)) return;
  throw forbidden();
}

/**
 * Batch form of the worker-read audience, as a `where` over workers. Ordinary
 * user principals delegate to the shared App-participation predicate
 * (`participantAppWhere`, the builder `participantAppIds` itself runs) rather
 * than spelling its AppMember / org-CONTRIBUTOR / user-owner arms again.
 * The two caller-specific arms stay here: a pure App key reaches only itself,
 * while a platform admin reaches every org App plus their own user-owned Apps.
 *
 * Every arm is a RELATION filter, not an id list (#1347 review): as id lists
 * the platform arm materialized every org App on the server, and an org
 * CONTRIBUTOR's every App of the org, into `appId IN (…)`. The differential test in
 * resolvers.worker.test.ts pins every arm to `requireWorkerReadAccess`.
 */
async function workerReadableWhere(ctx: Context): Promise<Prisma.WorkerWhereInput> {
  if (!ctx.userId) {
    return { appId: { in: ctx.appId ? [ctx.appId] : [] } };
  }
  if (!isPlatformAdmin(ctx)) {
    const apps = await participantAppWhere(ctx.db, ctx, {
      includeMemberships: true,
      // Worker history remains legible after uninstall; this surface lists
      // current holds from that retained roster too.
      includeUninstalled: true,
    });
    return apps ? { app: { is: apps } } : { id: { in: [] } };
  }
  // `participantAppIds` deliberately omits the platform-role arm because its
  // existing consumers answer admins above their fold. Supply that caller arm
  // here while preserving strict ownership for user-owned Apps.
  return {
    app: {
      is: {
        OR: [
          ...(ctx.impersonation ? [] : [{ ownerUserId: ctx.userId }]),
          ctx.impersonation
            ? { organizationId: ctx.impersonation.orgId }
            : { organizationId: { not: null } },
        ],
      },
    },
  };
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
    const row = await ctx.db.appAgent.findUnique({
      where: { appId_agentId: { appId, agentId: id } },
      select: { agent: { select: { id: true, name: true, urn: true, systemMemoryId: true } } },
    });
    if (!row) throw notInstalled();
    return row.agent;
  }
  const installed = await ctx.db.appAgent.findMany({
    where: { appId },
    orderBy: { createdAt: 'asc' },
    select: { agent: { select: { id: true, name: true, urn: true, systemMemoryId: true, deletedAt: true } } },
  });
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

type WorkerRow = {
  id: string;
  appId: string;
  agentId: string;
  name: string;
  slug: string;
  role: string | null;
  promptOverride: string | null;
  signature: string;
  trailer: string;
  memoryId: string | null;
  retiredAt: Date | null;
  /** #1050 — the human holding this name, and since when. */
  heldByUserId: string | null;
  heldAt: Date | null;
};

/**
 * Resolve a workerRef to its row — a Worker id or an
 * `hrn:worker:<root>:<app-slug>:<worker-slug>` URN (#991), via the shared
 * `resolve<Entity>Ref` helper (cor:api:140) so the ref grammar has ONE
 * definition rather than a per-resolver copy that drifts.
 *
 * Identity only, and never exported: callers go through
 * `resolveReadableWorkerRef`, which adds the App read gate with denial and
 * absence collapsed (#1742).
 */
async function resolveWorkerRefRow(ctx: Context, workerRef: string): Promise<WorkerRow> {
  let id: string;
  try {
    ({ id } = await resolveWorkerRefId(ctx.db, workerRef));
  } catch {
    // A malformed URN, an unresolvable App, and an absent worker collapse to
    // one refusal — no existence oracle.
    throw workerNotFound(workerRef);
  }
  const worker = await ctx.db.worker.findUnique({
    where: { id },
    select: {
      id: true,
      appId: true,
      agentId: true,
      name: true,
      slug: true,
      role: true,
      promptOverride: true,
      signature: true,
      trailer: true,
      memoryId: true,
      retiredAt: true,
      heldByUserId: true,
      heldAt: true,
    },
  });
  if (!worker) throw workerNotFound(workerRef);
  return worker;
}

/**
 * The one refusal for a worker the caller may not know about: absent, or in an
 * App they cannot read (#1742). Exported so other workerRef surfaces (#1937,
 * session start) answer with this exact envelope instead of a second copy.
 */
export function workerNotFound(workerRef: string): GraphQLError {
  return new GraphQLError('Worker not found.', {
    extensions: { code: 'WORKER_NOT_FOUND', workerRef },
  });
}

/**
 * #1742 — resolve a workerRef AND gate the worker's App for reading, with a
 * denial answered exactly like an absent worker (same code, message and
 * extensions, from `workerNotFound`).
 *
 * Resolving first and gating second is safe only if the two refusals are
 * indistinguishable. Before this, each caller gated the resolved row's App on
 * its own and refused FORBIDDEN, so an outsider could guess
 * `hrn:worker:<org>:<app>:<name>` and read existence off the error code. Every
 * workerRef surface in this module now comes through here, so there is one
 * collapse rather than one per resolver.
 *
 * What a caller gets past this gate, it may refuse however it likes: a reader
 * of the App already sees the roster, so a staff mutation's FORBIDDEN tells
 * them nothing new.
 *
 * NARROW catch, the #1019 convention (`resolveWorkerIdByNameGated` above):
 * only the gate's expected FORBIDDEN collapses. A database failure inside the
 * participation lookup propagates, because reporting an outage as a missing
 * worker misleads exactly the caller who needs the truth.
 */
export async function resolveReadableWorkerRef(
  ctx: Context,
  workerRef: string,
): Promise<{ worker: WorkerRow; app: AppRow }> {
  const worker = await resolveWorkerRefRow(ctx, workerRef);
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: worker.appId } });
  try {
    await requireWorkerReadAccess(ctx, app);
  } catch (e) {
    if (!(e instanceof GraphQLError && e.extensions?.code === 'FORBIDDEN')) throw e;
    throw workerNotFound(workerRef);
  }
  return { worker, app };
}

/**
 * Which of `names` are TAKEN in the App — judged by the DATABASE's `lower()`,
 * the exact expression `workers_app_name_uniq` indexes (`(app_id,
 * lower(name))`, post-push.sql), never ECMAScript `toLowerCase()` (#985
 * review, Codex P2: the two diverge under locale-sensitive case folding —
 * dotted capital I and friends — so a JS-folded set can call a name free
 * that the very next cast refuses with WORKER_NAME_TAKEN, no race involved).
 * Returns input spellings → holding worker id; retirement never frees a name,
 * so retired workers count. ONE definition — the preview and the teamRoles
 * free/taken column both consult it, so no verdict can disagree with the
 * constraint.
 */
export async function takenWorkersByName(
  db: Pick<Context['db'], '$queryRaw'>,
  appId: string,
  names: string[],
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const rows = await db.$queryRaw<{ cname: string; wid: string }[]>`
    SELECT c.name AS cname, w.id AS wid
    FROM unnest(${names}::text[]) AS c(name)
    JOIN workers w ON w.app_id = ${appId} AND lower(w.name) = lower(c.name)`;
  return new Map(rows.map((r) => [r.cname, r.wid]));
}

/**
 * Resolve a worker NAME to its id within one App (#990) — the ergonomic handle
 * a human already knows ("Iris"), for surfaces that carry App context.
 *
 * Judged with the DATABASE's `lower()`, the exact expression
 * `workers_app_name_uniq` indexes — never ECMAScript `toLowerCase()`, whose
 * locale-sensitive folding diverges on dotted capital I and friends, so a
 * JS-folded lookup could miss the very row the constraint says owns the name
 * (the `takenWorkersByName` rule, #985 review).
 *
 * Ambiguity is impossible: the name is unique per App, case-insensitively. A
 * RETIRED worker resolves here — its name stays reserved (cor:agt:020:02), so
 * the honest answer for "Iris" is that row; the caller then refuses the
 * BINDING with the specific `WORKER_RETIRED`, which is far more useful than
 * "not found" for a name the user can see in the roster.
 *
 * Identity only. This function answers "does this App have an Iris?", which is
 * a fact about the roster — so every caller MUST apply the staff read gate
 * (`requireWorkerReadAccess`) BEFORE calling it, or it becomes an existence
 * oracle over another tenant's staff.
 */
export async function resolveWorkerIdByName(
  db: Context['db'],
  appId: string,
  name: string,
): Promise<string | null> {
  const trimmed = name.trim();
  if (trimmed === '') return null; // blank is absent (cor:agt:020:02)
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM workers
    WHERE app_id = ${appId} AND lower(name) = lower(${trimmed})
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** #1597: authorized, live-App NAME discovery for a bind with no App context.
 * Reuses the participation set and point gate (hrn:node:hadronmemory.com:specs:cor:agt:020:00).
 * No name query runs for a denied App; hold/liveness decisions remain with startSession.
 */
export async function resolveWorkerBindCandidatesByName(ctx: Context, name: string) {
  if (!ctx.userId || ctx.impersonation || isRunPrincipal(ctx)) return [];
  const participant = await participantAppWhere(ctx.db, ctx, { includeMemberships: true });
  // The existing point gate admits platform administrators to live org Apps,
  // never to another person's user-owned App merely by platform role.
  const apps = await ctx.db.app.findMany({
    where: {
      deletedAt: null, uninstalledAt: null,
      OR: [
        ...(participant ? [participant] : []),
        ...(isPlatformAdmin(ctx) ? [{ organizationId: { not: null }, organization: { is: { deletedAt: null } } }] : []),
      ],
    },
    select: { id: true, name: true, urn: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
    orderBy: [{ urn: 'asc' }, { id: 'asc' }],
  });
  // #2346: one set-oriented query narrows the reachable Apps to those with a
  // live worker of this name, judged by the database's lower() (the expression
  // `workers_app_name_uniq` indexes, as `resolveWorkerIdByName`). This is an
  // internal discovery step only: the read gate below still runs for every App
  // that matched before anything is returned, so a denied App stays
  // indistinguishable from an absent name and nothing is capped or sampled.
  const trimmed = name.trim();
  if (trimmed === '' || apps.length === 0) return [];
  const matched = await ctx.db.$queryRaw<{ app_id: string }[]>`
    SELECT app_id FROM workers
    WHERE app_id = ANY(${apps.map((a) => a.id)}::text[])
      AND lower(name) = lower(${trimmed})
      AND retired_at IS NULL`;
  const matchedAppIds = new Set(matched.map((r) => r.app_id));
  const candidates = [];
  for (const app of apps) {
    if (!matchedAppIds.has(app.id)) continue;
    try {
      await requireWorkerReadAccess(ctx, app);
    } catch (e) {
      if (!(e instanceof GraphQLError && e.extensions.code === 'FORBIDDEN')) throw e;
      continue;
    }
    const id = await resolveWorkerIdByName(ctx.db, app.id, name);
    if (!id) continue;
    const row = await ctx.db.worker.findFirst({
      where: { id, appId: app.id, retiredAt: null },
      select: { id: true, name: true, slug: true, role: true,
        heldBy: { select: { id: true, handle: true, githubUsername: true } } },
    });
    if (!row) continue;
    // #1764 restricts taking an unheld name, not rebinding one already held
    // by this caller. Holds survive role changes: omitting that identity could
    // silently choose and claim a different same-name worker (#1597 P2-1).
    if (app.ownerUserId !== null && app.ownerUserId !== ctx.userId &&
        row.heldBy?.id !== ctx.userId && !(await managesApp(ctx, app))) continue;
    let urn: string | null = null;
    try { urn = composeWorkerUrn(normalizeUrnForLookup(app.urn), row.slug); } catch { /* legacy unaddressable App: use worker id */ }
    candidates.push({ id: row.id, name: row.name, urn, role: row.role,
      app: { id: app.id, name: app.name, urn: safeCanonicalUrn('app', app.urn) }, holder: row.heldBy });
  }
  return candidates;
}

/**
 * Resolve a worker NAME within an App, with the staff read gate applied FIRST
 * (#990's ordering, extracted in #1015 so it has ONE definition).
 *
 * Returns the worker id, or `null` for every failure shape — App absent, App
 * soft-deleted, caller not admitted, no such name. Collapsing them is the
 * contract, not laziness: resolving a name answers "does this App have an
 * Iris?", a fact about the roster that the id/URN forms never have to disclose.
 * Gating AFTER the lookup, or distinguishing "forbidden" from "no such worker",
 * would leak roster membership to anyone who can guess a name. Callers map
 * `null` onto their own refusal, which must be the same one they emit for an
 * absent worker.
 *
 * Extracted because `startSession` and `Query.worker` both need it and a
 * hand-rolled copy in either would drift — the failure the first authorization
 * invariant names. What deliberately stays with the CALLER is the App LIFECYCLE
 * posture: starting a session in an uninstalled App is refused
 * (`APP_UNINSTALLED`), while READING a worker there is not — Worker rows outlive
 * their App's uninstall (cor:agt:020:02), so the roster stays legible.
 */
export async function resolveWorkerIdByNameGated(
  ctx: Context,
  appId: string,
  name: string,
): Promise<string | null> {
  const app = await ctx.db.app.findUnique({
    where: { id: appId },
    select: {
      id: true, name: true, urn: true, organizationId: true,
      ownerUserId: true, uninstalledAt: true, deletedAt: true,
    },
  });
  if (!app || app.deletedAt) return null;
  try {
    await requireWorkerReadAccess(ctx, app);
  } catch (e) {
    // NARROW catch (PR #1019 review, Copilot; review:narrow-catch-blocks, the
    // convention requireWorkerStaffAccess above already follows): collapse ONLY
    // the expected denial. `requireWorkerReadAccess` evaluates its shared App
    // predicate in the database, so a blanket catch turns a connection failure
    // inside that lookup into "no such worker" — an outage reported as a missing row,
    // on the exact surface whose whole contract is that absence and denial look
    // identical. Deliberately opposite reasoning to the collapse this function
    // exists for: hiding WHY a caller was refused is the point; hiding THAT the
    // database is down never is.
    if (!(e instanceof GraphQLError && e.extensions?.code === 'FORBIDDEN')) throw e;
    return null;
  }
  return resolveWorkerIdByName(ctx.db, appId, name);
}

/**
 * #1726 — resolve a `reportsTo` target WITHIN the subject worker's App: its
 * id, URN or name. A worker of any other App answers exactly like a missing
 * one, WORKER_NOT_FOUND with no id, so the setter and the bind are never an
 * existence oracle across tenants (#1737 QA, Chip's P2). The caller has
 * already passed the App's worker read gate, which lists every worker here.
 */
export async function resolveReportsToTarget(ctx: Context, appId: string, ref: string): Promise<string> {
  const trimmed = ref.trim();
  let id: string | null = null;
  if (isId(trimmed) || hasSchemePrefix(trimmed)) {
    try {
      const resolved = (await resolveWorkerRefId(ctx.db, trimmed)).id;
      const row = await ctx.db.worker.findUnique({ where: { id: resolved }, select: { appId: true } });
      id = row?.appId === appId ? resolved : null;
    } catch {
      // A malformed URN, an unresolvable App and an absent worker collapse to
      // one refusal, as resolveWorkerRefRow does.
    }
  } else {
    id = await resolveWorkerIdByNameGated(ctx, appId, trimmed);
  }
  if (!id) throw new GraphQLError(`Worker not found in this App: "${trimmed}"`, { extensions: { code: 'WORKER_NOT_FOUND' } });
  return id;
}

/** Cast-only fixed envelope; infrastructure failures are never absence. */
async function resolveCastReportingHead(ctx: Context, appId: string, ref: string): Promise<string> {
  const absent = () => new GraphQLError('Worker not found in this App.', { extensions: { code: 'WORKER_NOT_FOUND' } });
  if (isId(ref) || hasSchemePrefix(ref)) {
    try { return (await resolveWorkerRefId(ctx.db, ref, { scope: { appId } })).id; }
    catch (e) { if (e instanceof WorkerNotFoundError) throw absent(); throw e; }
  }
  const id = await resolveWorkerIdByNameGated(ctx, appId, ref);
  if (!id) throw absent();
  return id;
}

/** True when the refusal is the per-App name unique (`workers_app_name_uniq`). */
function isNameTaken(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2002' &&
    !isSlugTaken(e) &&
    /workers_app_name_uniq|app_id.*name|name/i.test(String(e.meta?.target ?? e.message))
  );
}

/**
 * True when the refusal is the per-App SLUG unique (`workers_app_slug_uniq`,
 * #991) — a lost race between two casts that derived the same base slug.
 *
 * Checked BEFORE `isNameTaken`, whose pattern is loose enough (`.../name/i`)
 * to also match a slug target: the slug column is derived from the name, so
 * Prisma's target string mentions neither reliably. Getting the order wrong
 * would report a private race as WORKER_NAME_TAKEN and make a caller abandon a
 * name that is in fact free.
 */
function isSlugTaken(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2002' &&
    /workers_app_slug_uniq|slug/i.test(String(e.meta?.target ?? e.message))
  );
}

/**
 * The typed `WORKER_HOLD_STALE` refusal (#1073) — the hold is not what the
 * caller asserted, so the release it described is not the release it would
 * perform.
 *
 * Carries the holder found NOW, because that is the fact a caller needs to
 * re-prompt with. Naming it discloses nothing new: the caller has already
 * passed `requireWorkerReadAccess`, through which `Worker.heldByUserId` is
 * readable anyway — the masking rule for that field applies to callers who fail
 * that gate, and they never reach here.
 *
 * `heldByUserId: null` means the name is unheld now.
 *
 * The wording states the FACT and stops there — it does not say the holder is
 * "someone else", nor that a release would be a force-release (PR #1084 review,
 * Copilot). Neither is knowable here: this throws before the holder is compared
 * to the caller, and the account now holding the name may well BE the caller —
 * a caller asserting `expectUnheld` who turns out to hold it themselves is the
 * plain case. Releasing then posts nothing and is not a force-release, so a
 * message claiming otherwise would send them to a confirmation they do not owe.
 * The client can decide the relationship itself; `heldByUserId` is right there
 * in the extensions and the caller knows its own id.
 */
const holdStale = (workerId: string, heldByUserId: string | null): GraphQLError =>
  new GraphQLError(
    heldByUserId
      ? 'The hold is not what you asserted: this name is currently held. Re-read the worker and decide again — the release you described is not the release this would perform.'
      : 'The hold is not what you asserted: this name is currently held by nobody, so there is nothing to release.',
    { extensions: { code: 'WORKER_HOLD_STALE', workerId, heldByUserId } },
  );

/** The typed WORKER_NAME_TAKEN refusal — the allocation contract's advance
 *  signal (cor:agt:020:02). */
function nameTaken(name: string, appId: string): GraphQLError {
  return new GraphQLError(
    `Worker name ${JSON.stringify(name)} is already taken in this App — a name binds to one casting forever, so pick another.`,
    { extensions: { code: 'WORKER_NAME_TAKEN', name, appId } },
  );
}

/**
 * App-scoped critical section for role-definition writes. The transaction is
 * a LOCK BRACKET: `fn` runs on other pool connections, so its node writes must
 * not wait on a row lock held here. A memory-row NO KEY UPDATE bracket worked
 * while the nested writes only needed FK KEY SHARE, but the encryption-flip
 * fence now takes FOR SHARE on that row. Use a dedicated advisory key to
 * serialize role writes without blocking their own Memory fence.
 *
 * #1050 — renamed from `withRegisterLock`. It no longer guards a name
 * register (there is none); what it still guards is a role DEFINITION write:
 * two concurrent creates of the same role would otherwise both pass the
 * TEAM_ROLE_EXISTS check and both write. Casting takes it in no mode at all
 * now — `workers_app_name_uniq` arbitrates a name atomically on its own.
 */
export async function withRoleWriteLock<T>(
  ctx: Context,
  systemMemoryId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx.db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'role-write:' + systemMemoryId}))`;
      return fn();
    },
    // Generous: the bracket spans a full node write including the git mirror.
    { timeout: 30_000 },
  );
}


const MINT_RETRY_LIMIT = 3;

/**
 * Provision the Worker's casting-scoped working memory in the App's container
 * (cor:agt:020:01) — best-effort AFTER the casting exists: a failed provision
 * leaves `Worker.memoryId` null (the spec allows lazy provisioning) rather
 * than failing or compensating the cast. Identity is the `Worker.memoryId`
 * COLUMN, never the URN string (#723 / findings:shared-memory-identity-is-a-
 * column), so the urn is minted FLAT (`<root>:<app-slug>-<worker-slug>`,
 * aliased on collision) like every other memory — a multi-atom slug would
 * break node-URN round-tripping and 404 every portal link (the #723 lesson;
 * the slug convention is tunable per cor:agt:020:01).
 */
export async function provisionWorkerMemory(
  ctx: Context,
  app: AppRow,
  worker: { id: string; name: string; slug: string },
): Promise<string | null> {
  try {
    const appSlug = normalizeUrnForLookup(app.urn).split(':').pop() ?? app.urn;
    // #991: the STORED slug, not a re-derivation. Re-deriving would throw for a
    // name that slugifies to nothing (losing the working memory for a legally
    // cast worker), and could drift from the URN atom if the derivation ever
    // changes.
    const workerSlug = worker.slug;
    const root = await resolveMemoryRoot(ctx.db, {
      organizationId: app.organizationId,
      ownerUserId: app.ownerUserId,
      appUrn: app.urn,
    });
    for (let attempt = 0; ; attempt++) {
      const urn = await mintMemoryUrnV2(ctx.db, {
        root,
        desiredSlug: `${appSlug}-${workerSlug}`,
        authorRoot: worker.id.slice(0, 8),
      });
      try {
        // Memory create + Worker.memoryId attach in ONE transaction (PR #978
        // review — Copilot): a concurrent deleteWorker can observe
        // `memoryId: null`, hard-delete the never-used casting, and land the
        // worker.update on a vanished row — the rollback then takes the
        // just-created memory with it instead of leaving a permanent orphan.
        return await ctx.db.$transaction(async (tx) => {
          const created = await tx.memory.create({
            data: {
              organizationId: app.organizationId,
              // Owner XOR (`chk_memory_owner_xor`): follows the App's owner.
              ownerUserId: app.organizationId === null ? app.ownerUserId : null,
              urn,
              name: `${app.name} — ${worker.name} — working memory`,
              class: 'app',
              // 035-visibility-enum-cleanup: app-class visibility is NULL.
              visibility: null,
              appId: app.id,
              userId: null,
              createdBy: ctx.userId ?? null,
            },
            select: { id: true },
          });
          await tx.worker.update({
            where: { id: worker.id },
            data: { memoryId: created.id },
          });
          return created.id;
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
          throw err;
        }
        // A urn clash — mint again and alias around the winner. Bounded so a
        // genuinely unwinnable clash surfaces rather than spinning.
        if (attempt >= MINT_RETRY_LIMIT) throw err;
      }
    }
  } catch (err) {
    console.warn(
      `[castWorker] working-memory provisioning failed for worker ${worker.id} — left for lazy provisioning:`,
      err,
    );
    return null;
  }
}

/** Argument shape shared by castWorker and its preview (#964). */
type CastArgs = CastTeamArgs & {
  appRef: string;
  agentRef?: string | null;
  role?: string | null;
  name?: string | null;
  promptOverride?: string | null;
};

type CastTarget = {
  appId: string;
  app: AppRow & { deletedAt: Date | null };
  agent: { id: string; name: string; personaRole: string | null; systemPrompt: string | null };
  workerRole: string | null;
  /** The role the caller passed (trimmed), or null: the cast re-checks it against the agent read in its transaction. */
  requestedRole: string | null;
  requestedName: string | null;
  override: string | null;
  choice: ReturnType<typeof castTeamChoice>;
  reportingHeadId: string | null;
};

/** R222 (cor:dmo:050:11): a cast takes the role of the agent it names; `role` may only repeat it. */
const roleOverrideRefused = (appId: string, agentRole: string | null, requested: string) => new GraphQLError(
  `A cast takes the role of the agent it names ("${agentRole ?? ''}"); it cannot be overridden. Omit role, or cast the agent that answers "${requested}".`,
  { extensions: { code: 'WORKER_ROLE_OVERRIDE_REFUSED', appId, agentRole } },
);

/**
 * The shared resolution HALF of casting (#964 — "single implementation" as a
 * server-code property): normalize the request, resolve + gate the App
 * (`requireWorkerStaffAccess` — the preview deliberately takes the SAME mint
 * gate, since a preview reveals a name the caller could mint anyway), and
 * resolve the agent being cast (explicit agentRef must be installed; else the
 * role picks the single installed agent whose `personaRole` matches — zero or
 * two-plus are typed refusals, never a guess). Everything after this —
 * allocation vs. projection — is the caller's half, so every typed refusal up
 * to allocation behaves identically under preview and cast.
 */
async function resolveCastTarget(ctx: Context, args: CastArgs): Promise<CastTarget> {
  const { appRef, agentRef, role, name, promptOverride } = args;
  const choice = castTeamChoice(args);
  const roleNorm = (role ?? '').trim() || null;
  if (roleNorm !== null && roleNorm.includes(':')) {
    throw new GraphQLError('role must be a single loc atom (no ":").', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  // cor:agt:020:02 blank-is-absent: a whitespace-only name is no name.
  const requestedName = (name ?? '').trim() || null;
  const override = (promptOverride ?? '').trim() === '' ? null : (promptOverride as string);
  // #1870 (Holger, 2026-10-13, #10579): a worker whose MENTION TOKEN is a
  // broadcast word would wake every registered destination on a reply to it,
  // so casting refuses such names — by token (Vera #10580), not raw name:
  // All, TEAM and All! all slug to 'all'/'team' and are refused, while a name
  // that merely contains the word ("teamster") is not. A validation refusal
  // like WORKER_NAME_REQUIRED; a worker already so named keeps the narrow
  // reply-exception of #1867 instead (cor:agt:020:04).
  const token = requestedName != null ? mentionTokenOf(requestedName) : null;
  if (token != null && (BROADCAST_MENTION_TOKENS as readonly string[]).includes(token)) {
    throw new GraphQLError(
      `A worker named ${JSON.stringify(requestedName)} would mention-broadcast: its token @${token} routes a reply to every registered destination. Choose another name.`,
      { extensions: { code: 'WORKER_NAME_RESERVED', token } },
    );
  }

  // 1. Resolve the App (cor:api:140 — PK or URN) and gate.
  const { id: appId } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
  if (app.uninstalledAt) {
    throw new GraphQLError('Cannot cast a worker in an uninstalled App.', {
      extensions: { code: 'APP_UNINSTALLED', appId },
    });
  }
  await requireWorkerStaffAccess(ctx, app);
  let reportingHeadId: string | null = null;
  if (choice.kind === 'REPORTS_TO') {
    if (!(await managesApp(ctx, app))) throw new GraphQLError('Only whoever manages the App may name a reporting head at cast.', { extensions: { code: 'WORKER_REPORTS_TO_FORBIDDEN' } });
    // Ada36559 supersedes the dropped push-model S5/S7 dependency (#2138r4/#2130).
    // A future pull-shaped standby activation MUST initialize coverage for existing reports
    // before removing this guard and admitting new reports atomically under its common bracket.
    if (s7Available()) throw new GraphQLError('Casting with a reporting head is not available while standby integration is incomplete.', { extensions: { code: 'WORKER_REPORTING_CAST_UNAVAILABLE' } });
    reportingHeadId = await resolveCastReportingHead(ctx, appId, choice.ref);
    const head = await ctx.db.worker.findUniqueOrThrow({ where: { id: reportingHeadId }, select: { retiredAt: true } });
    if (head.retiredAt) throw new GraphQLError('A worker cannot report to a retired worker.', { extensions: { code: 'WORKER_REPORTS_TO_RETIRED', reportsTo: reportingHeadId } });
  }

  // 2. Resolve the agent being cast — installed in this App at cast time.
  let agent: CastTarget['agent'];
  if (agentRef && agentRef.trim() !== '') {
    // #1946 (ruling A): an absent Agent and one not installed here are ONE
    // answer, WORKER_AGENT_NOT_INSTALLED with no agentId, so the App's staff
    // learn only what is installed in their own App.
    const notInstalled = () => new GraphQLError(
      'agentRef must name an Agent installed in this App — casting requires the agent on the roster at cast time.',
      { extensions: { code: 'WORKER_AGENT_NOT_INSTALLED', appId } },
    );
    let id: string;
    try {
      ({ id } = await resolveAgentRef(ctx.db, agentRef.trim()));
    } catch (e) {
      if (e instanceof AgentNotFoundError) throw notInstalled();
      throw e;
    }
    const row = await ctx.db.appAgent.findUnique({
      where: { appId_agentId: { appId, agentId: id } },
      select: {
        agent: {
          select: { id: true, name: true, personaRole: true, systemPrompt: true, deletedAt: true },
        },
      },
    });
    if (!row || row.agent.deletedAt) throw notInstalled();
    agent = row.agent;
  } else {
    if (!roleNorm) {
      throw new GraphQLError('Pass agentRef, or a role that identifies the installed agent to cast.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    const installed = await ctx.db.appAgent.findMany({
      where: { appId },
      orderBy: { createdAt: 'asc' },
      select: {
        agent: {
          select: { id: true, name: true, urn: true, personaRole: true, systemPrompt: true, deletedAt: true },
        },
      },
    });
    // In-memory case-insensitive equality — never a LIKE-backed filter
    // (findings:prisma-string-filters-are-unescaped-like).
    const matches = installed
      .map((r) => r.agent)
      .filter(
        (a) => a && !a.deletedAt && (a.personaRole ?? '').toLowerCase() === roleNorm.toLowerCase(),
      );
    if (matches.length === 0) {
      throw new GraphQLError(
        `No installed Agent carries personaRole "${roleNorm}" — install the role-agent first, or pass agentRef.`,
        { extensions: { code: 'WORKER_AGENT_NOT_FOUND', appId, role: roleNorm } },
      );
    }
    if (matches.length > 1) {
      throw new GraphQLError(
        `More than one installed Agent carries personaRole "${roleNorm}" — pass agentRef to pick one. Candidates: ${matches
          .map((a) => `${a.name} (${a.urn})`)
          .join(', ')}.`,
        {
          extensions: {
            code: 'WORKER_AGENT_AMBIGUOUS',
            appId,
            role: roleNorm,
            candidates: matches.map((a) => ({ id: a.id, name: a.name, urn: a.urn })),
          },
        },
      );
    }
    agent = matches[0];
  }
  // #2458 / R222: a cast takes its Agent's role; role selects, never overrides.
  if (agentRef && agentRef.trim() !== '' && roleNorm !== null && roleNorm.toLowerCase() !== (agent.personaRole ?? '').toLowerCase()) {
    throw roleOverrideRefused(appId, agent.personaRole ?? null, roleNorm);
  }
  await assertCastable(ctx.db, app, agent.id);
  const workerRole = agent.personaRole ?? null;
  return { appId, app: app as CastTarget['app'], agent, workerRole, requestedRole: roleNorm, requestedName, override, choice, reportingHeadId };
}

/** The typed refusal for a failure while a cast generates its tickers (#2024); anything else is not ours. */
function generatedTickerRefusal(e: unknown): GraphQLError | null {
  if (e instanceof GeneratedTickerLimitError) {
    return new GraphQLError(
      `${e.message} Delete a ticker, or ask whoever manages the App to raise the limit; nothing was cast.`,
      { extensions: { code: 'TICKER_LIMIT_REACHED', liveCap: e.liveCap, live: e.live, adding: e.adding } },
    );
  }
  if (e instanceof GeneratedAgentNotInstalledError) {
    return new GraphQLError(`${e.message}`, { extensions: { code: 'WORKER_AGENT_NOT_INSTALLED', appId: e.appId } });
  }
  if (e instanceof GeneratedTickerNameTakenError) {
    return new GraphQLError(`${e.message} Nothing was cast.`, { extensions: { code: 'TICKER_NAME_TAKEN', name: e.name } });
  }
  if (e instanceof GeneratedNameTooLongError) {
    return new GraphQLError(`${e.message} Nothing was cast.`, { extensions: { code: 'BAD_USER_INPUT', workerName: e.workerName } });
  }
  return null;
}

function castTargetChanged(): GraphQLError {
  return new GraphQLError('The cast target changed; retry the cast.', {
    extensions: { code: 'CAST_TARGET_CHANGED', retryable: true },
  });
}

export const workerMutations = {
  /**
   * castWorker — #974 (cor:dmo:050:11): cast an installed agent into the App
   * under a name. Opt-in, never requires a Team Agent (an explicit name skips
   * the register entirely); multiple castings of one agent per App are legal
   * (Iris and Henry, both `backend-engineer`). The agent must be installed in
   * the App AT CAST TIME; the Worker row survives a later uninstall
   * (cor:agt:020:02 — the name binds forever).
   *
   * Resolution (App gate, agent by ref or personaRole) is shared with
   * `castWorkerPreview` via `resolveCastTarget` (#964), so preview and cast
   * cannot drift.
   *
   * Name allocation: caller-supplied wins (one attempt — the typed
   * WORKER_NAME_TAKEN refusal IS the answer); else the Team Agent's cast-list
   * register for the role is walked first-to-last, relying on the
   * `workers_app_name_uniq` constraint as the atomic allocation primitive
   * (advance on WORKER_NAME_TAKEN, exhausted register is typed).
   */
  castWorker: async (_: unknown, args: CastArgs, ctx: Context) => {
    const { appId, app, agent, requestedRole, requestedName, choice } = await resolveCastTarget(
      ctx,
      args,
    );

    // Plan the complete authority bracket before any graph/name/Worker resource.
    const agentOwner = await ctx.db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { organizationId: true, ownerUserId: true } });
    const anchors: AuthorityAnchor[] = [
      { kind: 'app', id: appId }, { kind: 'agent', id: agent.id },
      ...[app.organizationId, agentOwner.organizationId].filter((id): id is string => !!id).map(id => ({ kind: 'org' as const, id })),
      ...[app.ownerUserId, agentOwner.ownerUserId].filter((id): id is string => !!id).map(id => ({ kind: 'user' as const, id })),
    ];

    // 3+4. Allocate + create.
    /** Sentinel: this name is taken, so a register walk should advance. */
    const NAME_TAKEN = Symbol('name-taken');

    /**
     * One name's cast attempt. Mints the #991 URN atom from the name being
     * allocated: `nextFreeWorkerSlug` is advisory — `workers_app_slug_uniq`
     * arbitrates — so a lost race retries against a freshly-read taken set.
     *
     * The retry budget is deliberately generous, because a SMALL cap would make
     * cor:agt:020:02's "a derived identifier never refuses" observably false
     * (PR #993 review): with N concurrent casts whose distinct names derive to
     * one base, each round lets only one winner claim a candidate, so a cap of
     * k turns the (k+1)-th caller away with a raw constraint error even though
     * its NAME is free. Every round is guaranteed progress — a loser re-reads a
     * taken set that has strictly grown — so the loop terminates on its own;
     * the cap is only a backstop against a pathological storm, set far above
     * any real concurrency on a single App's staffing.
     *
     * Exhausting it is an infrastructure failure, not an allocation refusal:
     * it surfaces as its own typed code, never as WORKER_NAME_TAKEN, so a
     * client's register-advance loop cannot mistake it for "pick another name"
     * and burn through a register that was never the problem.
     */
    const createWithSlug = async (
      candidate: string,
    ): Promise<{ id: string; name: string; slug: string } | typeof NAME_TAKEN> => {
      for (let attempt = 0; attempt < SLUG_RACE_RETRY_LIMIT; attempt++) {
        try {
          const plannedWorkerId = generateId();
          return await withAuthorizedTx(ctx, anchors, async () => {}, async (tx, txCtx) => {
            // Exclusive anchors prevent concurrent casts from upgrading SHARE App rows together.
            await lockWorkerNames(tx, appId);
            await lockAppReportsTo(tx, appId);
            await lockAppTickers(tx, appId);
            // Cleanup doors such as public leaveApp intentionally take no authority anchor.
            // Hold the deciding membership rows as well, before any Worker row/write.
            if (ctx.userId) {
              if (app.organizationId) await tx.$queryRaw`
                SELECT user_id FROM org_members WHERE organization_id = ${app.organizationId} AND user_id = ${ctx.userId} FOR SHARE`;
              await tx.$queryRaw`
                SELECT user_id FROM app_members WHERE app_id = ${appId} AND user_id = ${ctx.userId} FOR SHARE`;
            }
            const freshApp = await tx.app.findUniqueOrThrow({ where: { id: appId } });
            if (freshApp.deletedAt) throw forbidden();
            await requireWorkerStaffAccess(txCtx, freshApp);
            if (freshApp.organizationId !== app.organizationId || freshApp.ownerUserId !== app.ownerUserId) throw castTargetChanged();
            const freshAgent = await tx.agent.findUniqueOrThrow({ where: { id: agent.id } });
            if (freshAgent.organizationId !== agentOwner.organizationId || freshAgent.ownerUserId !== agentOwner.ownerUserId) throw castTargetChanged();
            if (freshApp.uninstalledAt) {
              throw new GraphQLError('Cannot cast a worker in an uninstalled App.', { extensions: { code: 'APP_UNINSTALLED', appId } });
            }
            const freshTarget = await resolveCastTarget(txCtx, args);
            if (freshTarget.agent.id !== agent.id) throw castTargetChanged();
            // Preserve #2458's deciding licence/role check on the transaction.
            // This remains read-only: install/changeWorkerAgent own grant provisioning.
            const { agent: castAgent } = await assertCastable(tx, freshApp, agent.id);
            const castRole = castAgent.personaRole ?? null;
            if (requestedRole !== null && requestedRole.toLowerCase() !== (castRole ?? '').toLowerCase()) {
              throw roleOverrideRefused(appId, castRole, requestedRole);
            }
            // Preserve PostgreSQL lower(name)'s existing typed refusal before
            // applying the additional DAP naming-equivalence check.
            if ((await takenWorkersByName(tx, appId, [candidate])).has(candidate)) return NAME_TAKEN;
            await assertWorkerNameNotConfusable(tx, appId, candidate);
            const slug = await nextFreeWorkerSlug(tx, appId, candidate);
            const workerIds = [plannedWorkerId, ...(freshTarget.reportingHeadId ? [freshTarget.reportingHeadId] : [])].sort();
            await tx.$queryRaw`SELECT id FROM workers WHERE id = ANY(${workerIds}::text[]) ORDER BY id FOR UPDATE`;
            const castWorkerRow = await tx.worker.create({
              data: { ...WORKER_SIGNATURE_DEFAULTS,
                id: plannedWorkerId,
                appId,
                agentId: agent.id,
                name: candidate,
                slug,
                role: castRole,
                promptOverride: freshTarget.override,
                createdBy: ctx.userId ?? null,
                // #1050 — casting does NOT hold. A name is held by the person
                // who WORKS as it, and the canonical setup flow is a coordinator
                // casting a roster that other people then bind: making the
                // caster the holder would block every one of them on a release
                // they should never have needed. So a cast worker is born UNHELD
                // and the first bind claims it.
              },
              select: { id: true, name: true, slug: true },
            });
            if (choice.kind !== 'UNSET') {
              await writeReportsTo(tx, { workerId: castWorkerRow.id, appId, to: freshTarget.reportingHeadId, actor: eventActor(ctx.userId), setBy: 'cast' });
            }
            if (freshTarget.reportingHeadId) await reconcileStopCoverage(tx, appId, new Date());
            // #2024 (S8): the Agent's declared tickers become this worker's, with the worker subscribed, in this
            // same transaction. Any refusal rolls the whole cast back, the name allocation included.
            try {
              await instantiateAgentTickerTemplates(tx, {
                appId, agentId: agent.id, worker: castWorkerRow, createdBy: ctx.userId ?? null,
              });
            } catch (e) {
              throw generatedTickerRefusal(e) ?? e;
            }
            return castWorkerRow;
          }, { lockMode: 'exclusive', timeout: 30_000, afterLock: async tx => {
            await lockAgentTemplates(tx, agent.id, 'shared');
            // Only a reporting-line birth changes S6 topology. Acquire its fence
            // before name/graph/Worker resources; no-head casts need no coverage write.
            if (choice.kind === 'REPORTS_TO') await lockStopFence(tx, appId, 'exclusive');
          } });
        } catch (e) {
          // Order matters: a slug race is private and retried; a name
          // collision is the caller-visible allocation signal.
          if (isSlugTaken(e)) continue;
          if (isNameTaken(e)) return NAME_TAKEN;
          throw e;
        }
      }
      throw new GraphQLError(
        `Could not mint a URN slug for worker name ${JSON.stringify(candidate)} after ${SLUG_RACE_RETRY_LIMIT} attempts — too many casts are racing on the same derived slug. The name itself is not taken; retry.`,
        { extensions: { code: 'WORKER_SLUG_RACE_EXHAUSTED', name: candidate, appId } },
      );
    };

    // The uniqueness constraint IS the allocation primitive (cor:agt:020:02) —
    // a P2002 on workers_app_name_uniq maps to WORKER_NAME_TAKEN; register mode
    // advances past it.
    const allocate = async (
      candidates: string[],
    ): Promise<{ id: string; name: string; slug: string } | null> => {
      for (const candidate of candidates) {
        const row = await createWithSlug(candidate);
        if (row !== NAME_TAKEN) return row;
        if (requestedName) throw nameTaken(candidate, appId);
      }
      return null;
    };

    let created: { id: string; name: string; slug: string } | null;
    if (requestedName) {
      // Explicit name: one attempt; the DB unique arbitrates atomically, so
      // no register lock is needed (nothing register-borne is consumed).
      created = await allocate([requestedName]);
      if (!created) {
        // Unreachable in practice (allocate throws WORKER_NAME_TAKEN for an
        // explicit name) — kept for the type narrowing.
        throw nameTaken(requestedName, appId);
      }
    } else {
      // #1050: there is no register to allocate from, so a nameless cast has
      // no name source and refuses rather than inventing one. A worker's name
      // is its identity and permanent per App (cor:agt:020:02) — a
      // server-derived name would be a permanent identifier nobody chose.
      //
      // This is the path the register used to serve, and dropping it costs
      // nothing measurable: across both orgs every cast was effectively an
      // explicit name already (the ordered pool allocated nothing a --name
      // would not have, #1050 evidence).
      throw new GraphQLError(
        'Pass a name for the worker — a name is permanent within the App (cor:agt:020:02), so it is chosen, never derived.',
        { extensions: { code: 'WORKER_NAME_REQUIRED', ...(workerRole ? { role: workerRole } : {}) } },
      );
    }

    // 5. Working memory — best-effort; a failure leaves memoryId null.
    await provisionWorkerMemory(ctx, app, created);

    return ctx.db.worker.findUniqueOrThrow({ where: { id: created.id } });
  },

  /**
   * retireWorker — end the casting while reserving its name FOREVER
   * (cor:agt:020:02): a retired worker stops authoring (team chat's
   * worker-App pin checks retirement at post time) and refuses new session
   * bindings; the row — and its name reservation — survive. Idempotent: the
   * claim is guarded on `retiredAt: null`, so retiring twice (or racing
   * another retirer) returns the already-retired row unchanged.
   */
  retireWorker: async (
    _: unknown,
    { workerRef }: { workerRef: string },
    ctx: Context,
  ) => {
    const { worker, app } = await resolveReadableWorkerRef(ctx, workerRef);
    await requireWorkerStaffAccess(ctx, app);
    // #1416 (R204): `retired_by` is a User.id that a merge rewrites to the survivor, so the retirer takes its own
    // shared user anchor (withAuthorizedTx adds the caller's) and is re-authorized on the transaction context: a
    // retirer merged away before this point is refused instead of stamping a deleted account. Lock order, as
    // setWorkerReportsTo: authority anchors, authority-row SHARE locks, then (afterLock) the stop fence
    // exclusively, the reportsTo graph, and the worker writes.
    const anchors: AuthorityAnchor[] = [
      { kind: 'app', id: app.id },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ];
    await withAuthorizedTx(
      ctx,
      anchors,
      async (txCtx) => { await requireWorkerStaffAccess(txCtx, app); },
      async (tx) => {
        const retired = await tx.worker.updateMany({
          where: { id: worker.id, retiredAt: null },
          data: { retiredAt: new Date(), retiredBy: ctx.userId ?? null },
        });
        // #1726: a retired worker reports to nobody. Workers that report TO it
        // keep their value; the roster flags them (`reportsToRetired`) rather
        // than the platform silently clearing a structure someone set.
        if (retired.count > 0) {
          await writeReportsTo(tx, { workerId: worker.id, appId: worker.appId, to: null, actor: eventActor(ctx.userId), setBy: 'retirement' });
          // #1747 / cor:agt:080:02: a retired worker's ticker subscriptions end
          // with it, reason WORKER_RETIRED (history kept, never deleted).
          const actor = currentActor();
          await tx.tickerSubscription.updateMany({
            where: { workerId: worker.id, endedAt: null },
            data: {
              endedAt: new Date(), endedReason: 'WORKER_RETIRED',
              endedBy: ctx.userId ?? null, endedByWorkerId: actor.workerId, endedByAgentId: actor.agentId,
            },
          });
          // #2024 (S8): the tickers generated for this worker end with it (and the subscriptions others hold to
          // them). Nothing else is touched.
          await endGeneratedTickersForWorker(tx, { workerId: worker.id, deletedBy: ctx.userId ?? null });
          await reconcileStopCoverage(tx, worker.appId, new Date());
        }
      },
      {
        afterLock: async (tx) => {
          // #2022: the stop fence, exclusive, before the graph lock (src/lib/stopSignals/state.ts): a retired worker
          // leaves every stop signal's coverage, recorded below.
          await lockStopFence(tx, worker.appId, 'exclusive');
          // #1726: the reportsTo graph lock BEFORE the worker row (the lock protocol in src/lib/workerReportsTo.ts).
          await lockAppReportsTo(tx, worker.appId);
          // #2024 (S8): the App ticker lock after the graph and BEFORE any worker row, the order the cast and every
          // ticker write use (a ticker edit holds it while it reads its subscribers' workers).
          await lockAppTickers(tx, worker.appId);
        },
      },
    );
    return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  },

  /**
   * setWorkerReportsTo — #1726: set, hand over or clear who a worker reports
   * to (`reportsTo: null` clears). Well-formedness is the writer's
   * (src/lib/workerReportsTo.ts: same App, not itself, not retired, no cycle);
   * authority is decided here, on the value as it stands under the writer's
   * lock:
   *
   * - whoever manages the App (#7790: its user-owner, owner-role members, org
   *   ADMIN/OWNER, platform admins) may make any change;
   * - the worker it reports to now may hand it over or clear it: doing so is
   *   that worker's agreement;
   * - a worker that reports to nobody may be claimed by a worker for itself
   *   only when one person holds both, or placed under any worker by its own
   *   holder (INTERIM, Ada #7981, pending Holger's ruling on Rook's
   *   claim-scope question; #7931 had allowed any worker to claim).
   *
   * "A worker" is the caller's bound session's worker, in the same App, with a
   * person behind the request (the #1713 interim: a bare App key may bind any
   * session of its App, so its worker id alone proves nothing). Refused with
   * WORKER_REPORTS_TO_FORBIDDEN otherwise.
   */
  setWorkerReportsTo: async (
    _: unknown,
    { workerRef, reportsTo }: { workerRef: string; reportsTo?: string | null },
    ctx: Context,
  ) => {
    // Identity-scoped: a support session never changes the team's structure
    // (#1737 review, Diego P2-1; the read-only plugin refuses it too).
    if (ctx.impersonation) {
      throw new GraphQLError('Impersonation sessions are read-only.', { extensions: { code: 'FORBIDDEN' } });
    }
    const { worker, app } = await resolveReadableWorkerRef(ctx, workerRef);
    const to = reportsTo ? await resolveReportsToTarget(ctx, worker.appId, reportsTo) : null;
    const forbidden = () => new GraphQLError(
      'Only the worker this one reports to, a worker claiming an unclaimed one for itself, or whoever manages the App may change who it reports to.',
      { extensions: { code: 'WORKER_REPORTS_TO_FORBIDDEN', workerId: worker.id } },
    );
    // #1737 review (Rook P2-1, Diego P2-1): the authority is decided under the
    // App's anchors, on the transaction context (platform roles re-read from
    // the user row, a deleted or uninstalled App refused), with the caller's
    // App membership held FOR SHARE, so a demotion, an org-role change or an
    // uninstall either committed first and is seen, or waits for this write.
    // Lock order per src/lib/workerReportsTo.ts: anchors, the graph, then rows.
    const anchors: AuthorityAnchor[] = [
      { kind: 'app', id: app.id },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ];
    try {
      await withAuthorizedTx(
        ctx,
        anchors,
        async () => {},
        async (tx, txCtx) => {
          const fresh = await tx.app.findUniqueOrThrow({ where: { id: app.id } });
          await writeReportsTo(tx, {
            workerId: worker.id, appId: worker.appId, to, actor: eventActor(ctx.userId), setBy: 'app-manager',
            authorize: async (from) => {
              // The worker arms: the request's bound worker, re-resolved here
              // (a person behind it, not retired, still able to drive this App).
              const actor = await resolveTaskActor(txCtx, fresh as unknown as TaskApp);
              const acting = actor?.kind === 'worker' ? actor.workerId : null;
              if (acting && from !== null && acting === from) return 'current';
              if (from === null && to !== null) {
                // A claim on a worker that reports to nobody. INTERIM rule (Ada
                // #7981, narrowing #7931 until Holger rules on Rook's claim-scope
                // question): a worker claims it only when ONE person holds both;
                // otherwise the claim is the target's holder's to make (or a
                // manager's). The writer holds both rows FOR UPDATE by now, so
                // neither hold can change under this decision.
                const holds = await tx.worker.findMany({
                  where: { id: { in: [worker.id, ...(acting ? [acting] : [])] } },
                  select: { id: true, heldByUserId: true },
                });
                const holderOf = (id: string) => holds.find((h) => h.id === id)?.heldByUserId ?? null;
                const targetHolder = holderOf(worker.id);
                if (acting && to === acting && targetHolder !== null && targetHolder === holderOf(acting)) return 'claimant';
                if (ctx.userId && targetHolder === ctx.userId) return 'holder';
              }
              if (await managesApp(txCtx, fresh)) return 'app-manager';
              throw forbidden();
            },
          });
          // #2022 (R95): a stop signal's team coverage follows the reporting lines, from this moment.
          await reconcileStopCoverage(tx, worker.appId, new Date());
        },
        {
          afterLock: async (tx) => {
            await lockStopFence(tx, app.id, 'exclusive');
            await lockAppReportsTo(tx, app.id);
            if (ctx.userId) {
              await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${app.id} AND user_id = ${ctx.userId} FOR SHARE`;
            }
          },
        },
      );
    } catch (e) {
      if (!(e instanceof Error && e.message === 'Forbidden')) throw e;
      const now = await ctx.db.app.findUnique({ where: { id: app.id }, select: { deletedAt: true, uninstalledAt: true } });
      if (now && !now.deletedAt && now.uninstalledAt) {
        throw new GraphQLError('This App is uninstalled; its team structure is read-only.', { extensions: { code: 'APP_UNINSTALLED' } });
      }
      throw forbidden();
    }
    return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  },

  /**
   * releaseWorker — #1050: give up a held name, or take one back.
   *
   * Holding is what makes a name a person's rather than a session's, so the
   * release is the ONLY thing that frees one. Two principals may call it, and
   * they are different acts:
   *
   * - **The holder**, releasing their own name. No notice owed; they are the
   *   only party losing anything.
   * - **An App/org admin**, force-releasing somebody else's. This exists for
   *   the case the holding model otherwise strands — a person leaves and their
   *   names are held forever — and it is the ONE path by which a name changes
   *   hands without its holder acting.
   *
   * That second path posts to the team chat, naming who released what and from
   * whom. hadron-cli#492 is precisely the case where notice was owed and there
   * was no way to give it: the displaced driver learned nothing, and could not
   * have. A silent admin override would rebuild that. The notification is
   * best-effort — a chat that cannot be posted to must not prevent an admin
   * from recovering a departed colleague's names.
   *
   * Releasing does NOT retire the worker, free the name for a different
   * casting, or touch its history: the name stays permanently allocated to
   * this casting (cor:agt:020:02), and the handoff sequence and worklog travel
   * with the worker to whoever holds it next (Holger, 2026-08-19). Release is
   * about WHO holds it, never about what it is.
   */
  releaseWorker: async (
    _: unknown,
    {
      workerRef,
      expectedHolderUserId,
      expectUnheld,
    }: { workerRef: string; expectedHolderUserId?: string | null; expectUnheld?: boolean | null },
    ctx: Context,
  ) => {
    // #1073 — the caller may state the hold it believes it is releasing.
    //
    // TWO arguments rather than one nullable id, deliberately. Distinguishing
    // "expect nobody" from "no expectation" through a nullable argument would
    // rest on KEY PRESENCE, and any layer forwarding the argument
    // unconditionally sends `undefined` — which is present, and would be read
    // as an assertion the caller never made
    // (findings:optional-arg-meets-presence-semantics, a real incident here).
    // A safety precondition must not depend on every hop between caller and
    // resolver preserving absence, so both forms are explicit values.
    const assertsHolder = typeof expectedHolderUserId === 'string' && expectedHolderUserId !== '';
    const assertsUnheld = expectUnheld === true;
    if (assertsHolder && assertsUnheld) {
      throw new GraphQLError(
        'Pass expectedHolderUserId or expectUnheld, not both — they assert contradictory holds.',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    // The READ gate runs FIRST, before the idempotent return below (PR #1052
    // review, Codex + Copilot P1). Without it this mutation was a read surface:
    // an unheld worker returned its row before any check, so anyone holding an
    // id or URN could confirm a foreign worker exists and collect its scalars —
    // through a mutation, while `Query.worker` would have refused them. A
    // shortcut placed above an authorization check is an authorization hole
    // whatever the shortcut is for. #1742: and a denial answers like an absent
    // worker, so the gate is not itself an existence oracle.
    const { worker, app } = await resolveReadableWorkerRef(ctx, workerRef);

    if (!worker.heldByUserId) {
      // An expectation of a SPECIFIC holder is violated by there being none —
      // the hold the caller meant to release is already gone, and reporting
      // success would describe an act that did not happen.
      if (assertsHolder) throw holdStale(worker.id, null);
      // Idempotent rather than an error: "nobody holds this" is the state the
      // caller asked for, and a release racing another release is not a fault.
      //
      // #1073: nothing was released, so the payload says so rather than
      // implying an act. `releasedFrom` null is what makes `forced: false`
      // unambiguous here — it is not claiming the holder was you, it is
      // reporting that there was no holder.
      return {
        worker: await ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } }),
        releasedFromUserId: null,
        forced: false,
        notified: null,
      };
    }
    // Held, but the caller asserted it was not. This is the dangerous case
    // #1073 names: a client whose pre-read said "unheld" does not prompt, so
    // without this the hold taken in the interval is force-released SILENTLY
    // and the team chat records a public act nobody was asked about. Refused
    // before the authorization branch below, because being told the assertion
    // is stale discloses nothing the read gate above has not already allowed.
    if (assertsUnheld) throw holdStale(worker.id, worker.heldByUserId);
    // An assertion naming a DIFFERENT user than the hold we just read is stale
    // by definition — and rejecting it here is load-bearing, not tidiness
    // (PR #1084 review, Codex P1).
    //
    // Everything below decides authorization from `worker.heldByUserId`: the
    // `isHolder` branch, the admin gate it skips, and the team-chat notice that
    // only a non-holder release posts. If the guarded write could target a
    // DIFFERENT user than that decision was made against, the two come apart —
    // holder A asserting B, with the hold moving A→B in between, would release
    // B under A's holder authorization, skipping both the admin gate and the
    // notice. That is precisely the silent force-release this feature exists to
    // prevent, reintroduced by the mechanism meant to prevent it.
    //
    // So the invariant is: the authorization decision and the guarded value
    // name the SAME user, always.
    if (assertsHolder && expectedHolderUserId !== worker.heldByUserId) {
      throw holdStale(worker.id, worker.heldByUserId);
    }

    const isHolder = !!ctx.userId && worker.heldByUserId === ctx.userId;
    if (!isHolder) {
      // ADMIN, deliberately narrower than the staff gate that governs casting
      // and retirement. `requireWorkerStaffAccess` admits any non-reader
      // AppMember — right for "may staff this App", far too wide for "may take
      // a name off a colleague", which is the one path by which a name changes
      // hands without its holder acting. My own test caught this being the
      // looser gate; the decision was App/org ADMIN.
      if (ctx.impersonation) throw forbidden();
      if (!ctx.userId) throw forbidden();
      if (app.ownerUserId !== null) {
        // spec 047 strict ownership, branching on the ownership CLASS before
        // comparing owner columns (findings:org-xor-owner-null-comparison-bypass).
        if (ctx.userId !== app.ownerUserId) throw forbidden();
      } else if (app.organizationId !== null) {
        try {
          await requireOrgRole(ctx, app.organizationId, 'ADMIN');
        } catch (e) {
          // Narrow: requireOrgRole signals denial with a 'Forbidden' message (a
          // FORBIDDEN GraphQLError since #1493); a DB
          // failure inside the membership lookup must propagate rather than
          // read as "not an admin" (review:narrow-catch-blocks).
          if (!(e instanceof Error && e.message === 'Forbidden')) throw e;
          throw forbidden();
        }
      } else {
        throw forbidden();
      }
    }

    // The guard IS the check (#1073). The assertion has already been proven
    // equal to the hold we read and authorized against, so guarding on that
    // value is atomic against a change landing between the read and this write
    // — which is exactly what a client cannot achieve from outside, however
    // tightly it re-reads. Zero rows under an assertion therefore means the
    // hold moved in that window.
    const released = await ctx.db.worker.updateMany({
      where: { id: worker.id, heldByUserId: worker.heldByUserId },
      data: { heldByUserId: null, heldAt: null, updatedBy: ctx.userId ?? null },
    });
    if (released.count === 0 && assertsHolder) {
      // Zero rows under an assertion means the hold moved between the read
      // above and this write. Re-read to name who holds it NOW rather than
      // echoing the stale value the caller sent (zero-row-guarded-write-has-
      // two-causes: say which predicate failed).
      const current = await ctx.db.worker.findUnique({
        where: { id: worker.id },
        select: { heldByUserId: true },
      });
      throw holdStale(worker.id, current?.heldByUserId ?? null);
    }

    // Read the worker back HERE, not after the notice (PR #1124 review, Codex
    // P2). The team-chat post below is a network call, and re-reading after it
    // widened the window in which another caller could bind to the length of
    // that call — so the payload could carry a NEW holder while documenting a
    // null one. The notice does not touch the worker row, so reading before it
    // changes nothing except how much can happen in between. The window is
    // narrowed, not closed: `worker` is current state and `releasedFrom` is
    // what attests the release, and the SDL now says so rather than promising
    // a null hold it cannot guarantee.
    const releasedWorker = await ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });

    // #1073 — THREE states, and the middle one is why it is not a boolean:
    // null = no notice was owed, false = one was owed and FAILED. A client
    // cannot honestly render "we may have silently failed to announce this",
    // so collapsing them would make saying nothing the only truthful UI.
    let notified: boolean | null = null;
    if (released.count > 0 && !isHolder) {
      // Best-effort: an unreachable chat must not block an admin recovering a
      // departed colleague's names. Narrow enough to be honest — this is the
      // notification, not the operation.
      try {
        const [holder, actor] = await Promise.all([
          ctx.db.user.findUnique({
            where: { id: worker.heldByUserId },
            select: { handle: true, githubUsername: true },
          }),
          ctx.userId
            ? ctx.db.user.findUnique({
                where: { id: ctx.userId },
                select: { handle: true, githubUsername: true },
              })
            : Promise.resolve(null),
        ]);
        const nameOf = (u: { handle: string | null; githubUsername: string | null } | null) =>
          u?.handle ?? u?.githubUsername ?? 'an administrator';
        /**
         * Neutralize a user-supplied name before it goes into the notice
         * (PR #1052 review, Copilot — suppressed comment, and the best finding
         * of that round).
         *
         * Worker names are only `.trim()`ed at casting, and handles are
         * user-chosen, so a name carrying `*`, backticks or a NEWLINE can break
         * the formatting or forge extra sentences into a message whose whole
         * purpose is to be trustworthy: this is the notice that tells a team
         * their colleague's name was taken by an admin. A forged one is worse
         * than none.
         *
         * Newlines collapse first — they are what lets a name append a whole
         * fabricated line — then the emphasis and code characters are escaped.
         */
        const plainly = (value: string): string =>
          value.replace(/\s+/g, ' ').replace(/([\\`*_~[\]()#>|])/g, '\\$1').trim();
        // LAZY import: resolvers.teamChat already imports locateTeamAgent
        // from this module, so a static import here would close a cycle. It is
        // reached only on the admin force-release path, so the cost is nil and
        // the module graph stays acyclic.
        const { teamChatMutations } = await import('./resolvers.teamChat.js');
        await teamChatMutations.createTeamChatMessage(
          {},
          {
            appRef: app.id,
            body:
              `The name **${plainly(worker.name)}** was released by ${plainly(nameOf(actor))}, ` +
              `and was held by ${plainly(nameOf(holder))}. ` +
              'It is now unheld — the next person to bind it holds it. ' +
              'Nothing about the worker itself changed: its history, worklog and handoffs stay with the name.',
            replyToSeq: null,
            sessionRef: null,
          },
          ctx,
        );
        notified = true;
      } catch (e) {
        // The release STOOD; only the announcement failed. Reporting that is
        // the whole point of the tri-state — before #1073 this warning was the
        // only trace, and no caller could see it.
        notified = false;
        console.warn(
          `[releaseWorker] force-release of ${worker.id} succeeded but the team-chat notice failed:`,
          e,
        );
      }
    }

    return {
      worker: releasedWorker,
      // The holder the WRITE ended — `worker.heldByUserId` is the value the
      // authorization decision was made against AND the value the updateMany
      // guarded on, which #1084 made the same user by construction. Reporting
      // a pre-read holder here would reintroduce exactly the gap that closed.
      releasedFromUserId: released.count > 0 ? worker.heldByUserId : null,
      // Known, never guessed: reaching here as a non-holder means the admin
      // gate passed, which requires ctx.userId. So `false` always means the
      // holder was the caller — or that nothing was released.
      forced: released.count > 0 ? !isHolder : false,
      notified,
    };
  },

  /**
   * updateWorker — #1010: amend a casting's individuality after the fact.
   *
   * `promptOverride` is the platform's designated per-worker escape hatch
   * (cor:agt:020:01), but it could only be set at CASTING time and was
   * immutable thereafter — which inverts the natural order, fixing a casting's
   * individuality at the one moment nobody yet knows what makes it individual.
   * Neither escape hatch covered it: the role agent's `systemPrompt` is SHARED
   * by every casting of that role (cor:agt:020:01 explicitly allows several), so
   * anything individual written there is claimed by all of them; and
   * `deleteWorker` + re-cast refuses `WORKER_IN_USE` the moment a session was
   * bound — so exactly the workers that have accumulated an identity are the
   * ones that could not be re-cast.
   *
   * `name` is permanent by law (cor:agt:020:02 — the allocation contract). The
   * agent, and with it the role, is changed by `changeWorkerAgent` (#2458,
   * cor:dmo:050:11), never here: that change has its own checks and effects.
   *
   * Argument semantics: OMITTED preserves (the partial-update convention every
   * other surface follows), explicit `null` or blank CLEARS — matching both the
   * nullable column and `castWorker`'s own blank-is-absent normalization, so a
   * value that castWorker would have stored as null cannot be reintroduced here.
   *
   * A RETIRED worker refuses. An override is briefing text, delivered at bind
   * time — and a retired worker takes no new bindings (`startSession` refuses
   * WORKER_RETIRED), so the edit could never reach anyone. Silently accepting a
   * write with no possible effect is worse than a typed refusal that says why.
   *
   * Authorization is castWorker's gate: this edits the App's staff.
   */
  updateWorker: async (
    _: unknown,
    args: { workerRef: string; promptOverride?: string | null; signature?: string | null; trailer?: string | null },
    ctx: Context,
  ) => {
    const { worker, app } = await resolveReadableWorkerRef(ctx, args.workerRef);
    const changesSignature = 'signature' in args || 'trailer' in args;
    if (changesSignature) {
      const data: { signature?: string; trailer?: string; promptOverride?: string | null } = {};
      const anchors: AuthorityAnchor[] = [
        { kind: 'app', id: app.id },
        ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
        ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
      ];
      return withAuthorizedTx(ctx, anchors, async txCtx => {
        const fresh = await txCtx.db.app.findUniqueOrThrow({ where: { id: app.id } });
        // H26 PROVISIONAL: bound workers do not exercise their holder's manager right.
        // Headless agent/run callers and impersonation likewise cannot manage these fields.
        const actor = currentActor();
        const bound = txCtx.sessionId ? await txCtx.db.session.findUnique({ where: { id: txCtx.sessionId }, select: { workerId: true } }) : null;
        if (bound?.workerId || txCtx.sessionBindingRefused || actor.workerId || actor.agentId || txCtx.impersonation || !(await managesApp(txCtx, fresh))) throw forbidden();
        if ('promptOverride' in args) await requireWorkerStaffAccess(txCtx, fresh);
        for (const field of ['signature', 'trailer'] as const) {
          if (field in args) data[field] = normalizeWorkerSignature(args[field]);
        }
        if ('promptOverride' in args) data.promptOverride = (args.promptOverride ?? '').trim() === '' ? null : args.promptOverride;
      }, async tx => {
        const { count } = await tx.worker.updateMany({ where: { id: worker.id, retiredAt: null }, data });
        if (!count) {
          const still = await tx.worker.findUnique({ where: { id: worker.id } });
          if (!still) throw workerNotFound(args.workerRef);
          throw new GraphQLError('This worker is retired.', { extensions: { code: 'WORKER_RETIRED' } });
        }
        return tx.worker.findUniqueOrThrow({ where: { id: worker.id } });
      });
    }
    await requireWorkerStaffAccess(ctx, app);

    if (worker.retiredAt) {
      throw new GraphQLError(
        'This worker is retired — it takes no new session bindings, so a prompt override would never be delivered. Cast a new worker instead.',
        { extensions: { code: 'WORKER_RETIRED', workerId: worker.id } },
      );
    }

    // Presence, not truthiness: `promptOverride: null` is a request to CLEAR,
    // while omitting it is a request to leave it alone. A `?? undefined` here
    // would collapse the two and make clearing impossible.
    if (!('promptOverride' in args)) {
      return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    }
    const next = args.promptOverride;
    // Guarded on the state the refusal above consumed (PR #1019 review,
    // Copilot): the check read `retiredAt` from a row resolved earlier, so a
    // `retireWorker` landing in between would let this write through and amend
    // a retired casting the contract says it refuses. `updateMany` re-applies
    // the predicate at write time — the same shape `retireWorker` itself uses
    // for its idempotent claim, and the lighter sibling of `deleteWorker`'s
    // SERIALIZABLE count-then-act (this write cannot corrupt anything, it just
    // must not contradict its own stated refusal).
    const { count } = await ctx.db.worker.updateMany({
      where: { id: worker.id, retiredAt: null },
      // castWorker's normalization, verbatim: blank is absent, and a non-blank
      // value is stored RAW (not trimmed) — the override is prose whose leading
      // and trailing whitespace is the author's to choose.
      data: { promptOverride: (next ?? '').trim() === '' ? null : (next as string) },
    });
    if (count === 0) {
      // Zero rows has TWO causes, and guessing retirement is wrong (PR #1020
      // review, Codex P2): a concurrent `deleteWorker` can also have removed the
      // row. It is permitted to — its "never used" test is about bound sessions
      // and working-memory content, and setting an override makes a worker
      // neither. Reporting WORKER_RETIRED for a worker that was actually DELETED
      // would be actively misleading, since deletion frees the name to be cast
      // again while retirement reserves it forever (cor:agt:020:02) — opposite
      // advice for the caller. So ask which happened rather than assume.
      const still = await ctx.db.worker.findUnique({
        where: { id: worker.id },
        select: { retiredAt: true },
      });
      if (!still) {
        throw new GraphQLError('Worker not found.', {
          extensions: { code: 'WORKER_NOT_FOUND', workerRef: args.workerRef },
        });
      }
      throw new GraphQLError(
        'This worker was retired while the update was in flight — it takes no new session bindings, so a prompt override would never be delivered.',
        { extensions: { code: 'WORKER_RETIRED', workerId: worker.id } },
      );
    }
    return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  },

  /**
   * changeWorkerAgent — #2458 / hrn:node:hadronmemory.com:specs:cor:dmo:050:11 (Holger R222): change the agent a
   * worker casts; its role follows the agent (never typed in). Name, slug, URN, signature, trailer, reporting line
   * and every past record stay; past sessions keep the agent and role they ran under (`Session.agentId`/`role`).
   *
   * Who: whoever manages the App, as themselves. The gate is updateWorker's signature/trailer gate verbatim: a
   * bound worker session (even one its manager holds, R113), a worker or agent actor, an impersonation and a
   * refused session binding are all FORBIDDEN, decided on the live transaction context.
   *
   * To what: `assertCastable`, the one casting check the cast runs too, plus the new agent must have a role of its
   * own. A refused change changes nothing.
   *
   * A COMPLETE change, in one transaction: agent and role, the per-worker boot-prompt pointer cleared (it named the
   * OLD agent's compiled prompt; the next bind takes the new agent's), the old agent's generated tickers ended and
   * the new agent's templates instantiated, the missing same-org grants provisioned, and one `worker.casting`
   * event. It takes effect at the next bind (startSession stamps agent and role from the locked worker row).
   *
   * Refused while the worker has an open session (WORKER_HAS_OPEN_SESSION): reads that serve an open session (register
   * entries, the live prompt, matcher settings) follow the worker's CURRENT agent, so a change under one would hand it
   * a mix of the old and new casting. Until #2458 slice 2 serves an open session from its own stamped agent and role,
   * the session must end first. Decided under the Worker row lock, which startSession's bind also takes before it
   * inserts the session, so a bind and a change serialize: either the change sees the session, or the bind sees the
   * new agent.
   *
   * Lock order: authority anchors, the App ticker lock (as retireWorker), the per-worker assignment lock, the old
   * and new Agent rows FOR SHARE in id order, then the Worker row FOR UPDATE: the matcher and context reset take
   * the assignment lock, then Agent, then Worker, so neither can cycle with this.
   */
  changeWorkerAgent: async (
    _: unknown,
    args: { workerRef: string; agentRef: string },
    ctx: Context,
  ) => {
    const { worker, app } = await resolveReadableWorkerRef(ctx, args.workerRef);
    const anchors: AuthorityAnchor[] = [
      { kind: 'app', id: app.id },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ];
    return withAuthorizedTx(ctx, anchors, async txCtx => {
      const fresh = await txCtx.db.app.findUniqueOrThrow({ where: { id: app.id } });
      const actor = currentActor();
      const bound = txCtx.sessionId ? await txCtx.db.session.findUnique({ where: { id: txCtx.sessionId }, select: { workerId: true } }) : null;
      if (bound?.workerId || txCtx.sessionBindingRefused || actor.workerId || actor.agentId || txCtx.impersonation || !(await managesApp(txCtx, fresh))) throw forbidden();
    }, async tx => {
      // Only a caller who passed the gate learns whether the agent exists: absent and not installed are one answer.
      let toAgentId: string;
      try {
        ({ id: toAgentId } = await resolveAgentRef(tx as unknown as Context['db'], args.agentRef.trim()));
      } catch (e) {
        if (e instanceof AgentNotFoundError) throw workerAgentNotInstalled(app.id);
        throw e;
      }
      await lockWorkersForAssignment(tx, [worker.id]);
      const before = await tx.worker.findUnique({ where: { id: worker.id }, select: { agentId: true } });
      if (!before) throw workerNotFound(args.workerRef);
      const agentIds = [...new Set([before.agentId, toAgentId])].sort();
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ANY(${agentIds}::text[]) ORDER BY id FOR SHARE`;
      const [locked] = await tx.$queryRaw<Array<{ agent_id: string; role: string | null; retired_at: Date | null; name: string; boot_prompt_node_id: string | null }>>`
        SELECT agent_id, role, retired_at, name, boot_prompt_node_id FROM workers WHERE id = ${worker.id} FOR UPDATE`;
      if (!locked) throw workerNotFound(args.workerRef);
      if (locked.retired_at) {
        throw new GraphQLError('This worker is retired; its casting no longer changes.', { extensions: { code: 'WORKER_RETIRED', workerId: worker.id } });
      }
      // The Agent locks above were taken for the agent read before the worker lock. A change that landed in between
      // moved it, so this transaction holds the wrong row: refuse rather than decide on an unlocked agent.
      if (locked.agent_id !== before.agentId) {
        throw new GraphQLError('This worker’s agent changed while the change was in flight; read it again.', {
          extensions: { code: 'WORKER_CASTING_STALE', workerId: worker.id },
        });
      }
      if (locked.agent_id === toAgentId) {
        throw new GraphQLError('This worker already casts that agent; nothing to change.', {
          extensions: { code: 'WORKER_AGENT_UNCHANGED', workerId: worker.id },
        });
      }
      const open = await tx.session.findFirst({ where: { workerId: worker.id, endedAt: null, deletedAt: null }, select: { id: true } });
      if (open) {
        throw new GraphQLError('This worker has an open session; end it first. An open session would otherwise run under a mix of the old and new agent.', {
          extensions: { code: 'WORKER_HAS_OPEN_SESSION', workerId: worker.id },
        });
      }
      const freshApp = await tx.app.findUniqueOrThrow({ where: { id: app.id } });
      const { agent, provisionGrantsFor } = await assertCastable(tx, freshApp, toAgentId);
      // "The role is the new agent's own role" (cor:dmo:050:11): an agent with none has no role to change TO, and a
      // worker left role-less would silently lose its role tasks. Refused, not stored as null (Vera, #36796).
      const toRole = (agent.personaRole ?? '').trim();
      if (toRole === '') {
        throw new GraphQLError('That agent has no role of its own, so a worker cannot change to it; give the agent a personaRole first.', {
          extensions: { code: 'WORKER_AGENT_HAS_NO_ROLE', workerId: worker.id },
        });
      }
      for (const grantAgentId of provisionGrantsFor) {
        if (freshApp.organizationId) await ensureAgentOrgGrant(tx, freshApp.organizationId, grantAgentId, { createdBy: ctx.userId ?? null });
      }
      try {
        await endGeneratedTickersForWorker(tx, { workerId: worker.id, deletedBy: ctx.userId ?? null });
        await tx.worker.update({
          where: { id: worker.id },
          data: { agentId: agent.id, role: toRole, bootPromptNodeId: null, bootPromptUrn: null },
        });
        await instantiateAgentTickerTemplates(tx, {
          appId: app.id, agentId: agent.id, worker: { id: worker.id, name: locked.name }, createdBy: ctx.userId ?? null,
        });
      } catch (e) {
        throw generatedTickerRefusal(e) ?? e;
      }
      await appendWorkerCastingEvent(tx, {
        appId: app.id, actor: eventActor(ctx.userId), workerId: worker.id,
        fromAgentId: locked.agent_id, toAgentId: agent.id, fromRole: locked.role, toRole,
        clearedBootPromptNodeId: locked.boot_prompt_node_id,
      });
      return tx.worker.findUniqueOrThrow({ where: { id: worker.id } });
    }, { afterLock: async (tx) => { await lockAppTickers(tx, app.id); } });
  },

  /** #1162 / cor:dmo:050:11: only an unreferenced, released miscast is removable. */
  deleteWorker: async (
    _: unknown,
    { workerRef, confirmNoExternalAttribution }: { workerRef: string; confirmNoExternalAttribution?: boolean | null },
    ctx: Context,
  ) => {
    const { worker, app } = await resolveReadableWorkerRef(ctx, workerRef);
    await requireWorkerStaffAccess(ctx, app);
    // Auth first: the negative attestation must not open a roster oracle.
    if (confirmNoExternalAttribution !== true) {
      throw new GraphQLError(
        'Verify that no signed commit, trailer, PR, comment, review or published artifact attributes work to this worker, then explicitly confirm. Database checks cannot prove external absence. If history is known or uncertain, retire instead.',
        { extensions: { code: 'WORKER_EXTERNAL_ATTRIBUTION_UNCONFIRMED' } },
      );
    }
    const refuse = () => new GraphQLError('This worker has persisted references, an unreleased stint, or encrypted attribution that cannot be verified. Retire it instead.', {
      extensions: { code: 'WORKER_IN_USE', workerId: worker.id },
    });
    if (await miscastHasReferences(ctx.db, worker)) throw refuse();
    try {
      await ctx.db.$transaction(async (tx) => {
        // Re-read after acquiring the identity lock; stale pre-wait eligibility
        // never authorizes destruction. The private MVCC fence
        // and SERIALIZABLE census jointly reject pre-wait snapshots.
        await tx.$queryRaw`SELECT id FROM workers WHERE id = ${worker.id} FOR UPDATE`;
        await tx.$executeRaw`INSERT INTO worker_reference_fences(subject_id) VALUES (${worker.id})
          ON CONFLICT (subject_id) DO UPDATE SET version = worker_reference_fences.version + 1`;
        const current = await tx.worker.findUnique({ where: { id: worker.id } });
        if (!current) throw new GraphQLError('Worker not found.', { extensions: { code: 'WORKER_NOT_FOUND', workerRef } });
        if (await miscastHasReferences(tx, current)) throw refuse();
        await deletePristineGeneratedTickers(tx, worker.id);
        await tx.session.deleteMany({ where: { workerId: worker.id } });
        await tx.worker.delete({ where: { id: worker.id } });
        if (current.memoryId) await tx.memory.delete({ where: { id: current.memoryId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      // The fence deliberately makes a stale SERIALIZABLE snapshot abort.
      // Raw statements report 40001/40P01 as P2010; model writes use P2034.
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))))) {
        throw new GraphQLError('Worker references changed concurrently. Retry the verified-unused repair, or retire instead.', {
          extensions: { code: 'WORKER_IN_USE', workerId: worker.id },
        });
      }
      throw error;
    }
    return true;
  },
};

export const workerQueries = {
  /**
   * Read one worker (cor:api:120 find-one). The ref is a Worker id, an
   * `hrn:worker:<root>:<app-slug>:<worker-slug>` URN (#991), or — with
   * `appRef` — the worker's NAME ("Iris", #990/#1015).
   *
   * The forms are told apart by SHAPE, never by trying each in turn: an id or a
   * scheme-prefixed URN is self-describing, anything else is a name. Falling
   * back from a failed URN resolution to a name lookup would make a typo'd URN
   * silently search the roster (startSession's rule).
   *
   * This read is what makes a boot briefing RE-FETCHABLE (#1015): `Worker.prompt`
   * renders live from the role agent's template, so an agent that lost its
   * briefing to a compaction can recover it here instead of opening a second
   * session or forcing a takeover of itself — both of which corrupt the
   * provenance record the Worker model exists to produce.
   */
  worker: async (
    _: unknown,
    { ref, appRef }: { ref: string; appRef?: string | null },
    ctx: Context,
  ) => {
    const trimmed = ref?.trim() ?? '';
    // The NAME form is activated by `appRef`, not by shape alone — it is
    // strictly ADDITIVE. Without an appRef the resolver behaves exactly as it
    // did before #1015, including for a name-shaped ref: an unresolvable ref of
    // any shape refuses WORKER_NOT_FOUND, which is the standing no-oracle
    // contract. Branching on shape alone would have re-labelled that refusal
    // and told a caller which of their guesses merely lacked App context.
    //
    // A name is unique only WITHIN an App (cor:agt:020:02), so appRef is what
    // makes the lookup well-defined; guessing across the caller's Apps would
    // resolve one name to several workers. An id or URN is self-describing and
    // wins over appRef rather than being checked against it — the same shape
    // test startSession uses, so a typo'd URN never silently degrades into a
    // roster search.
    if (appRef && trimmed !== '' && !isId(trimmed) && !hasSchemePrefix(trimmed)) {
      // An unresolvable appRef collapses into WORKER_NOT_FOUND too (PR #1019
      // review, Codex P2). `resolveAppRef` throws AppNotFoundError, which would
      // escape BEFORE the gated helper's collapse and let a caller tell a
      // nonexistent App apart from a live one with no such worker — an
      // existence oracle over other tenants' App refs, reintroduced through the
      // very argument that was supposed to be gated. The collapse has to cover
      // every input to the lookup, not just the name.
      let appId: string;
      try {
        ({ id: appId } = await resolveAppRef(ctx.db, appRef));
      } catch {
        throw new GraphQLError('Worker not found.', {
          extensions: { code: 'WORKER_NOT_FOUND', workerRef: trimmed },
        });
      }
      // Gate-then-lookup, with denial and absence collapsed — see
      // resolveWorkerIdByNameGated for why the ordering is the contract.
      const byName = await resolveWorkerIdByNameGated(ctx, appId, trimmed);
      if (!byName) {
        throw new GraphQLError('Worker not found.', {
          extensions: { code: 'WORKER_NOT_FOUND', workerRef: trimmed },
        });
      }
      return ctx.db.worker.findUniqueOrThrow({ where: { id: byName } });
    }
    const { worker } = await resolveReadableWorkerRef(ctx, ref);
    return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  },

  /**
   * The App's staff list (cor:agt:020:01 — Workers are the staff; AppAgent is
   * the install roster). Retired castings are hidden by default; pass
   * includeRetired for the full historical staff.
   */
  workers: async (
    _: unknown,
    {
      appRef,
      includeRetired,
      limit,
      offset,
    }: { appRef: string; includeRetired?: boolean | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    await requireWorkerReadAccess(ctx, app);
    const where = {
      appId,
      ...(includeRetired ? {} : { retiredAt: null }),
    };
    const [items, total] = await Promise.all([
      ctx.db.worker.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: clampListTake(limit),
        skip: offset ?? 0,
      }),
      ctx.db.worker.count({ where }),
    ]);
    return { items, total };
  },

  /**
   * Workers CURRENTLY held by one user across every App this caller may read
   * (#1344). App authorization is embedded in BOTH the item and count queries
   * before the holder predicate can influence membership or pagination.
   * Unknown users collapse to the same empty page as no visible holds, so the
   * surface is not a cross-tenant account oracle.
   */
  heldWorkers: async (
    _: unknown,
    {
      userRef,
      includeRetired,
      limit,
      offset,
    }: { userRef: string; includeRetired?: boolean | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    let heldByUserId: string;
    try {
      heldByUserId = (await resolveUserRefOrEmail(ctx.db, userRef)).id;
    } catch (err) {
      if (err instanceof UserNotFoundError || err instanceof AmbiguousUserRefError) {
        return { items: [], total: 0 };
      }
      throw err;
    }
    // An email is a PERSONAL field (`canSeeUserPersonalFields`: self, a shared
    // org, or a platform admin). Resolving one for anybody else would let a
    // caller who can read an App's workers — a direct App member from another
    // org, or a pure App key — confirm a guessed email by the page coming back
    // non-empty. For them the email names nobody, like a missing user.
    if (isEmailUserRef(userRef) && !(await canSeeUserPersonalFields(ctx, heldByUserId))) {
      return { items: [], total: 0 };
    }

    const where: Prisma.WorkerWhereInput = {
      heldByUserId,
      ...(includeRetired ? {} : { retiredAt: null }),
      AND: [
        await workerReadableWhere(ctx),
        // App keys can outlive their row's soft deletion in cached credentials;
        // uninstalled is readable by contract, deleted is not.
        { app: { is: { deletedAt: null } } },
      ],
    };
    const [rows, total] = await Promise.all([
      ctx.db.worker.findMany({
        where,
        include: { app: { select: { urn: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: clampListTake(limit),
        skip: Math.max(0, offset ?? 0),
      }),
      ctx.db.worker.count({ where }),
    ]);

    const activity = await loadWorkersActivity(ctx, rows.map((row) => row.id));
    primeHeldWorkerCaches(
      ctx,
      rows.map((row) => ({ appId: row.appId, appUrn: row.app.urn })),
    );
    return {
      total,
      items: rows.map((row) => ({
        ...row,
        __heldWorkerActivity: activity.get(row.id) ?? {
          hasLiveSession: false,
          lastActiveAt: null,
          bound: false,
          bindingFamily: null,
          bindingModel: null,
          modelReportedAt: null,
        },
      })),
    };
  },

  /**
   * castWorkerPreview — #964: the dry-run for the one IRREVERSIBLE act in the
   * team feature (a cast name is permanent, cor:agt:020:02). A QUERY, not a
   * dryRun flag: a Boolean argument cannot switch a GraphQL return type, and
   * "single implementation" is a server-code property — the resolution half
   * (`resolveCastTarget`: App gate, agent by ref or personaRole, typed
   * refusals) is the SAME code castWorker runs, and the name projection
   * consults the same roster the allocation's unique arbitrates. Returns what
   * the caller needs to decide: the name the cast would allocate, the
   * composed boot prompt (reviewable BEFORE the name is permanent — where a
   * template missing {{name}} becomes visible), and which Team Agent
   * resolved.
   *
   * THE PREVIEW RESERVES NOTHING. No lease exists by law (cor:agt:020:03 —
   * liveness and allocation both derive from real rows, never a hold), so a
   * previewed name may be gone at cast time, by design. Authorization is the
   * MINT gate, not a looser read gate: a preview reveals a name the caller
   * could mint anyway.
   */
  castWorkerPreview: async (_: unknown, args: CastArgs, ctx: Context) => {
    const { appId, agent, workerRole, requestedName, override, choice, reportingHeadId } = await resolveCastTarget(
      ctx,
      args,
    );
    let name: string;
    if (requestedName) {
      // Taken-ness judged by the DB's lower() — the constraint's own
      // expression (see takenWorkersByName).
      const taken = await takenWorkersByName(ctx.db, appId, [requestedName]);
      if (taken.has(requestedName)) {
        throw nameTaken(requestedName, appId);
      }
      await assertWorkerNameNotConfusable(ctx.db, appId, requestedName);
      name = requestedName;
    } else {
      // #1050: same refusal as castWorker, and deliberately the SAME code —
      // the preview's whole contract is to answer "what would the cast do",
      // so a nameless preview must fail exactly where the cast would.
      throw new GraphQLError(
        'Pass a name for the worker — a name is permanent within the App (cor:agt:020:02), so it is chosen, never derived.',
        { extensions: { code: 'WORKER_NAME_REQUIRED', ...(workerRole ? { role: workerRole } : {}) } },
      );
    }

    // Prompt composition mirrors Worker.prompt exactly: the agent's template
    // with {{name}}/{{role}} bound, then the override as its own paragraph.
    const template = agent.systemPrompt ?? null;
    const previewRole = workerRole ?? agent.personaRole ?? '';
    // No worker row or session exists yet, so url / model / reports-to have nothing to fill.
    const values = withWorkerSignatures({
      'worker.name': name,
      'worker.role': previewRole,
      'agent.name': agent.name,
      'worker.reportsTo.name': '',
      'worker.signature': '',
      'worker.trailer': '',
      'worker.url': '',
      'session.llmModel': '',
    }, WORKER_SIGNATURE_DEFAULTS);
    const bound = template ? applyPlatformVariables(template, values, { name, role: previewRole }) : null;
    const boundOverride = override ? applyPlatformVariables(override, values) : override;
    const prompt = bound && boundOverride ? `${bound}\n\n${boundOverride}` : (boundOverride ?? bound);

    // #2024 (S8): the tickers this cast would create, validated by the cast's own planner. Non-reserving: it reads
    // what is committed now, takes no lock and writes nothing, so a cast may still differ if the App changes.
    let tickers;
    try {
      tickers = await planGeneratedTickers(ctx.db as unknown as Prisma.TransactionClient, { appId, agentId: agent.id, workerName: name });
    } catch (e) {
      throw generatedTickerRefusal(e) ?? e;
    }

    return {
      name,
      role: workerRole,
      agentId: agent.id,
      agentName: agent.name,
      prompt,
      teamPlacement: choice.kind,
      reportsToWorkerId: reportingHeadId,
      hasNamePlaceholder: template ? templateBindsName(template) : null,
      tickers: tickers.map((t) => ({
        name: t.name,
        templateId: t.templateId,
        templateRevision: t.templateRevision,
        requestedCadenceSeconds: t.requestedCadenceSeconds,
        effectiveCadenceSeconds: t.effectiveCadenceSeconds,
        relevance: t.relevance,
        reasons: t.reasons.map(reasonEnum),
      })),
    };
  },
};

/**
 * Per-worker driving state: is a session live, and when was it last driven.
 *
 * #1707 (cor:agt:060:04) adds the BINDING, which is not the same fact as
 * liveness: a worker is `bound` while it has an OPEN session (not ended), and
 * `bindingFamily` is the model family of the newest open session — the latest
 * bind — or null when that session reported none. Going quiet never unbinds
 * (#1114; cor:agt:020:03 separates inactivity from ending a stint), so a
 * lapsed but open session keeps its family; only an end, or a newer bind,
 * clears or replaces it (#1723 review, Diego P2-2).
 */
/** The #2252 fields' shared read: masked to null on the family gate, else the activity row of the one fold. */
async function bindingModelOf(
  ctx: Context,
  worker: { id: string; appId: string; __heldWorkerActivity?: WorkerActivity },
  info?: { operation?: { operation?: string } },
): Promise<WorkerActivity | null> {
  if (!(await maySeeWorkerInternals(ctx, worker.appId))) return null;
  if (worker.__heldWorkerActivity) return worker.__heldWorkerActivity;
  const activity = await loadAppWorkerActivity(ctx, worker.appId, { memoize: info?.operation?.operation === 'query' });
  return activity.get(worker.id) ?? null;
}

export type WorkerActivity = {
  hasLiveSession: boolean;
  lastActiveAt: Date | null;
  bound: boolean;
  bindingFamily: string | null;
  /** #2252: the newest open session's reported model, its report time, and the tier derived from it. */
  bindingModel: string | null;
  modelReportedAt: Date | null;
};

/**
 * Database-side activity fold shared by one-App rosters and the cross-App
 * held-workers page. `scope` must constrain `w`; sessions remain unbounded but
 * the output is one aggregate row per worker.
 *
 * This SQL is deliberately the database twin of `lib/sessionActivity.ts`:
 * the differential matrix in resolvers.worker.test.ts pins them together. A
 * live session is open AND inside its type-specific idle window; deleted
 * sessions do not count; reaper writes are not genuine activity; and activity
 * after an end is capped at the end instant.
 */
async function queryWorkerActivity(
  ctx: Context,
  scope: Prisma.Sql,
  now: Date,
): Promise<Map<string, WorkerActivity>> {
  const rows = await ctx.db.$queryRaw<
    { workerId: string; live: boolean; lastActiveAt: Date | null; bound: boolean; bindingFamily: string | null; bindingModel: string | null; modelReportedAt: Date | null }[]
  >(workerActivitySql(scope, now));
  return new Map<string, WorkerActivity>(
    rows.map((row) => [
      row.workerId,
      {
        hasLiveSession: row.live,
        lastActiveAt: row.lastActiveAt,
        bound: row.bound,
        bindingFamily: normalizeFamily(row.bindingFamily),
        bindingModel: row.bindingModel,
        modelReportedAt: row.modelReportedAt,
      },
    ]),
  );
}

/**
 * The SQL of `queryWorkerActivity`, exported so its PLAN can be pinned
 * (#1903): its per-session activity probe took production down when it ran
 * as a backward walk of usage_events_created_at_idx.
 */
export function workerActivitySql(scope: Prisma.Sql, now: Date): Prisma.Sql {
  // AGGREGATED IN THE DATABASE, one row per worker (PR #1086 review, Codex
  // P2). This SQL is a SECOND implementation of `lib/sessionActivity.ts`, and
  // that is deliberate: one derivation aggregates unbounded history inside
  // the query; the other works on rows already in hand for the takeover
  // prompt. The differential test in resolvers.worker.test.ts pins them to the
  // same answer.
  //
  // The first implementation fetched every session and folded in JavaScript.
  // Session history is unbounded, so latency and heap grew with the App's
  // lifetime. This query's output is O(workers), not O(sessions).
  //
  // Three rules are load-bearing:
  //  - deleted sessions do not count, matching the bind gate;
  //  - ANY recent open session makes the worker live (`force` permits several);
  //  - auto-expiry's update is not genuine driver activity.
  //
  // #1114: bind naive-UTC literals. Prisma binds JS Date as timestamptz while
  // these columns are timestamp WITHOUT time zone; a bare comparison coerces
  // the column using the session timezone and is only accidentally correct on
  // a UTC server (findings:prisma-naive-timestamp-raw-sql).
  const cut = idleCutoffs(now);
  const activityAt = Prisma.sql`GREATEST(
                   s.started_at,
                   CASE WHEN s.auto_expired_at IS NULL THEN s.updated_at END,
                   ue.max_created
                 )`;
  // LIVE IS DERIVED, not stored. An open row proves only that nobody closed
  // it, so activity must also fall inside the type's idle window
  // (cor:agt:020:11 — reader and binder share one predicate).
  const sessionLive = Prisma.sql`(
             s.ended_at IS NULL
             AND (s.expires_at IS NULL OR s.expires_at > ${toNaiveUtc(now)}::timestamp)
             AND ${activityAt} >= (CASE s.type::text
                         WHEN 'DEVELOPER'  THEN ${toNaiveUtc(cut.DEVELOPER)}::timestamp
                         WHEN 'CHATBOT'    THEN ${toNaiveUtc(cut.CHATBOT)}::timestamp
                         WHEN 'AUTOMATION' THEN ${toNaiveUtc(cut.AUTOMATION)}::timestamp
                         WHEN 'EDGE'       THEN ${toNaiveUtc(cut.EDGE)}::timestamp
                       END))`;
  return Prisma.sql`
    SELECT s.worker_id AS "workerId",
           bool_or(${sessionLive}) AS "live",
           -- #1707: the BINDING is any open session, live or quiet; its family
           -- is the newest open session's (the latest bind), null included —
           -- a newer bind that reported none does not inherit an older one's.
           bool_or(s.ended_at IS NULL) AS "bound",
           (array_agg(s.family ORDER BY s.started_at DESC, s.id DESC)
              FILTER (WHERE s.ended_at IS NULL))[1] AS "bindingFamily",
           -- #2252: the model and its report time come from the SAME newest open
           -- session as the family (same ordering), so a newer bind that reported
           -- none does not inherit an older one's, and the two never mix sessions.
           (array_agg(s.llm_model ORDER BY s.started_at DESC, s.id DESC)
              FILTER (WHERE s.ended_at IS NULL))[1] AS "bindingModel",
           (array_agg(s.model_reported_at ORDER BY s.started_at DESC, s.id DESC)
              FILTER (WHERE s.ended_at IS NULL))[1] AS "modelReportedAt",
           max(LEAST(GREATEST(
             s.started_at,
             -- The reaper advances updated_at while setting auto_expired_at.
             -- Counting that maintenance write would make an abandoned worker
             -- look recently driven; omit it and safely under-report instead.
             CASE WHEN s.auto_expired_at IS NULL THEN s.updated_at END,
             ue.max_created
           -- Activity cannot postdate the end. updateSession and late usage
           -- attribution may write after ended_at, but neither means someone
           -- was still driving the worker. Postgres LEAST ignores a null end,
           -- so an open session remains uncapped.
           ), s.ended_at)) AS "lastActiveAt"
    FROM sessions s
    JOIN workers w ON w.id = s.worker_id
    LEFT JOIN LATERAL (
      -- #1952: the "+ interval '0'" is load-bearing. A bare max(created_at)
      -- lets the planner serve the max by walking usage_events_created_at_idx
      -- backwards with a filter, which for a session with no (or ancient)
      -- activity reads the whole index: the 2026-10-14 outage. Statistics in
      -- which a few sessions dominate activity choose that walk even with the
      -- index below present, and ORDER BY … LIMIT 1 is the same plan. No
      -- created_at index can order this expression, so only session-keyed
      -- paths remain. Cost: a session's activity rows are all read, bounded
      -- per App. A stored last-activity column is #1957.
      SELECT max(e.created_at + interval '0') AS max_created
      FROM usage_events e
      -- #1653 / DY-2: only events written while the session was live count.
      -- #1903: served by the partial usage_events_session_activity_idx
      -- (post-push.sql).
      WHERE e.session_id = s.id AND e.counts_as_activity
    ) ue ON true
    WHERE ${scope} AND s.deleted_at IS NULL
    GROUP BY s.worker_id
  `;
}

/** One aggregate query for the bounded #1344 page, never one per App/worker. */
export async function loadWorkersActivity(
  ctx: Context,
  workerIds: string[],
  now = new Date(),
): Promise<Map<string, WorkerActivity>> {
  if (workerIds.length === 0) return new Map();
  return queryWorkerActivity(
    ctx,
    Prisma.sql`w.id IN (${Prisma.join(workerIds)})`,
    now,
  );
}

/**
 * Driving state for EVERY worker of one App (hadron-cli#487).
 *
 * Ada's finding is that a coordinator cannot tell "dispatched and pending" from
 * "dispatched into the void": ten issues went to a worker whose entire history
 * was two sessions of 2m26s and 41s, and `worker list` renders that identically
 * to a worker driven yesterday. The join already existed — `startSession`
 * computes it for the takeover prompt — so only the READ surface was missing.
 *
 * Loaded per APP rather than per worker on purpose. A roster is the calling
 * shape, and a field resolver that queried per worker would issue one query per
 * row, concurrently, up to the 200-item page cap — the N+1 that PR #1000's
 * review pulled out of the MCP roster twice already.
 *
 * Memoized ONLY inside a query, for the reason `loadAppRepoAffinity` states: a
 * request-scoped memo over data the same request can WRITE is stale by
 * construction, and `startSession` / `endSession` write exactly this. A mutation
 * pays the re-read rather than answering from a cache it just invalidated.
 */
export async function loadAppWorkerActivity(
  ctx: Context,
  appId: string,
  opts?: { memoize?: boolean; now?: Date },
): Promise<Map<string, WorkerActivity>> {
  const now = opts?.now ?? new Date();
  type Cache = Map<string, Promise<Map<string, WorkerActivity>>>;
  const holder = ctx as Context & { workerActivityCache?: Cache };
  const cache = opts?.memoize ? (holder.workerActivityCache ??= new Map()) : null;
  const cached = cache?.get(appId);
  if (cached) return cached;

  const pending = queryWorkerActivity(ctx, Prisma.sql`w.app_id = ${appId}`, now);

  cache?.set(appId, pending);
  return pending;
}

/**
 * #2138 §3.4 — every worker's check status in one App, loaded per APP for the
 * same reason as `loadAppWorkerActivity` (a roster is the calling shape), and
 * memoized only inside a query, for the same reason too. The team channel is
 * the one the team chat reads and writes (`locateTeamChatChannel`); only a
 * check of THAT channel counts.
 */
export async function loadAppWorkerCheckStatuses(
  ctx: Context,
  appId: string,
  opts?: { memoize?: boolean; now?: Date },
): Promise<Map<string, WorkerCheckStatus>> {
  const now = opts?.now ?? new Date();
  type Cache = Map<string, Promise<Map<string, WorkerCheckStatus>>>;
  const holder = ctx as Context & { workerCheckStatusCache?: Cache };
  const cache = opts?.memoize ? (holder.workerCheckStatusCache ??= new Map()) : null;
  const cached = cache?.get(appId);
  if (cached) return cached;

  const pending = (async () => {
    // Dynamic: resolvers.teamChat imports this module.
    const { locateTeamChatChannel } = await import('./resolvers.teamChat.js');
    const channel = await locateTeamChatChannel(ctx, appId);
    return loadWorkerCheckStatuses(ctx.db, { appId, teamChannelId: channel?.channelId ?? null, now });
  })();

  cache?.set(appId, pending);
  return pending;
}

/**
 * #983 review (Codex + Copilot P1): `Session.worker` made Worker rows
 * reachable by principals the worker queries never admitted —
 * `sessionScopeFilter` admits ANY org member (READER included), and a
 * self-attributed session stays readable by its user after they leave the
 * App. Attribution needs only the IDENTITY scalars (name, role, appId,
 * retiredAt); the WORKING-STATE fields — `prompt`, `promptOverride`,
 * `memoryId` — must stay behind the worker read gate, masked to null on
 * deny (the #552 posture applied field-level, like Worker.app/agent).
 * Memoized per request+App: one gate check covers a whole session page.
 */
/**
 * #1090 — one composition of a worker's boot prompt, with the freshness facts
 * a holder needs to tell whether the text is current. `renderedAt` is stamped
 * once the text exists (an up-front clock could predate a concurrent template
 * edit the same query picked up — review P2); `roleAgentUpdatedAt` comes from
 * the SAME agent read that supplied the template, so the stamp describes the
 * template actually rendered — a parallel agent read could race an edit and
 * label an older prompt with a newer time (Andi, #2853). It is the Agent
 * row's generic `updatedAt` (nullable), NOT a proven persona-template edit
 * time; no separate prompt-override mtime exists, and none is invented here.
 * Text is null when there is no template and no override — in that case
 * callers show no stamps.
 */
export async function composeWorkerPrompt(
  ctx: Context,
  worker: { id: string; appId: string; agentId: string; name: string; slug?: string; role: string | null; promptOverride: string | null; signature: string; trailer: string; reportsToWorkerId?: string | null },
  opts?: { llmModel?: string | null },
): Promise<{ text: string | null; renderedAt: Date; roleAgentUpdatedAt: Date | null }> {
  // Working-state path: the composed boot prompt embeds the agent's persona
  // template, which this loads WITHOUT the Agent read gate — so every caller
  // must sit behind the worker read gate itself (#983 review; see
  // maySeeWorkerInternals).
  if (!(await maySeeWorkerInternals(ctx, worker.appId))) {
    return { text: null, renderedAt: new Date(), roleAgentUpdatedAt: null };
  }
  const agent = await ctx.db.agent.findUnique({
    where: { id: worker.agentId },
    select: { systemPrompt: true, personaRole: true, updatedAt: true, ownerUserId: true, name: true, urn: true },
  });
  // #1764 (Riana P1): the App's participants now include a user-owned App's members, but a USER-owned Agent stays
  // owner-only (spec 047) — its template is read by the owner, or by whoever holds the worker cast from it (the person
  // driving the name), never by a member through this nested field. The gate above is App participation; this is the
  // underlying entity's. An org-owned Agent's template is unchanged.
  if (agent?.ownerUserId != null && !(await mayReadUserOwnedAgentTemplate(ctx, worker.id, agent.ownerUserId))) {
    return { text: null, renderedAt: new Date(), roleAgentUpdatedAt: null };
  }
  const template = agent?.systemPrompt ?? null;
  const role = worker.role ?? agent?.personaRole ?? '';
  // #2042 (cor:dmo:150:08): the platform variables, filled now, at this bind, from the worker being bound.
  const platform = await workerPlatformValues(ctx, worker, agent, role, opts?.llmModel);
  // One pass over each authored text (blind review P2-1/P2-2): the override is boot-prompt text too.
  const bound = template ? applyPlatformVariables(template, platform, { name: worker.name, role }) : null;
  const override = worker.promptOverride ? applyPlatformVariables(worker.promptOverride, platform) : worker.promptOverride;
  const authored = bound && override ? `${bound}\n\n${override}` : (override ?? bound);
  // Spec 049 Phase 6: the register block is DERIVED data appended through the
  // one composition point (`renderDerivedBlocks`), never authored prompt text
  // — evaluated for the Worker's durable holder, so an admin reading another
  // Worker's briefing sees that Worker's standing, not the admin's.
  const derived = renderDerivedBlocks(await resolveRegister(ctx.db, { attendee: { workerId: worker.id }, actor: ctx, accessActor: 'ATTENDEE' }));
  const text = !derived ? authored : authored ? `${authored}\n\n${derived}` : derived;
  // #1090 review (Andi, P2): stamp the render time AFTER the text exists. A
  // clock read taken up front could predate a concurrent template edit that
  // the same query then picked up — an Agent stamp LATER than the claimed
  // render time. Down here, renderedAt is a lower bound the printed text and
  // its Agent stamp both satisfy.
  return { text, renderedAt: new Date(), roleAgentUpdatedAt: agent?.updatedAt ?? null };
}

/**
 * #2042 — the values of the platform variables for a worker bind. Bottom-up: the worker's own value, else the Agent's.
 * Stored signature/trailer templates are pre-rendered without recursive expansion (#1602). The reports-to name rides the
 * worker-visibility gate the caller already passed (same App), and `session.llmModel` is the bind's session model:
 * passed in by the bind that just created the session, else the newest open session's.
 */
async function workerPlatformValues(
  ctx: Context,
  worker: { id: string; slug?: string; appId: string; name: string; signature: string; trailer: string; reportsToWorkerId?: string | null },
  agent: { name: string; urn: string; personaRole: string | null } | null,
  role: string,
  llmModel: string | null | undefined,
): Promise<PlatformVariableValues> {
  const reportsTo = worker.reportsToWorkerId
    ? await ctx.db.worker.findFirst({ where: { id: worker.reportsToWorkerId, appId: worker.appId }, select: { name: true } })
    : null;
  const model = llmModel !== undefined
    ? llmModel
    : (await ctx.db.session.findFirst({
        where: { workerId: worker.id, endedAt: null },
        orderBy: { startedAt: 'desc' },
        select: { llmModel: true },
      }))?.llmModel;
  const urn = worker.slug ? await resolveWorkerUrnField({ appId: worker.appId, slug: worker.slug }, ctx) : null;
  return withWorkerSignatures({
    'worker.name': worker.name,
    'worker.role': role,
    'agent.name': agent?.name ?? '',
    'worker.reportsTo.name': reportsTo?.name ?? '',
    'worker.signature': '',
    'worker.trailer': '',
    'worker.url': (urn ? portalUrlForUrn(urn) : null) ?? '',
    'session.llmModel': model ?? '',
  }, worker);
}

/** The owner of a user-owned Agent, or the person holding the worker cast from it; never under impersonation. */
async function mayReadUserOwnedAgentTemplate(ctx: Context, workerId: string, agentOwnerUserId: string): Promise<boolean> {
  if (!ctx.userId || ctx.impersonation) return false;
  if (ctx.userId === agentOwnerUserId) return true;
  const w = await ctx.db.worker.findUnique({ where: { id: workerId }, select: { heldByUserId: true } });
  return w?.heldByUserId === ctx.userId;
}

export async function maySeeWorkerInternals(ctx: Context, appId: string): Promise<boolean> {
  type Cache = Map<string, Promise<boolean>>;
  const holder = ctx as Context & { workerInternalsCache?: Cache };
  const cache = (holder.workerInternalsCache ??= new Map());
  let pending = cache.get(appId);
  if (!pending) {
    pending = (async () => {
      const app = await ctx.db.app.findUnique({ where: { id: appId } });
      if (!app || app.deletedAt) return false;
      try {
        await requireWorkerReadAccess(ctx, app);
        return true;
      } catch {
        return false;
      }
    })();
    cache.set(appId, pending);
  }
  return pending;
}

/**
 * Seed request caches only with facts already proved by heldWorkers' shared
 * authorization predicate. This removes per-App field-resolution queries from
 * the cross-App page without changing what any other Worker surface may see.
 */
function primeHeldWorkerCaches(
  ctx: Context,
  apps: Array<{ appId: string; appUrn: string }>,
): void {
  type BoolCache = Map<string, Promise<boolean>>;
  type UrnCache = Map<string, Promise<string | null>>;
  const holder = ctx as Context & {
    workerInternalsCache?: BoolCache;
    workerAppUrnCache?: UrnCache;
  };
  const access = (holder.workerInternalsCache ??= new Map());
  const urns = (holder.workerAppUrnCache ??= new Map());
  for (const app of apps) {
    access.set(app.appId, Promise.resolve(true));
    urns.set(app.appId, Promise.resolve(app.appUrn));
  }
}

/**
 * The App's `urn` COLUMN, read for URN composition. Only the column — never the
 * App object, which would hand the caller App.keys / App.members
 * (findings:broadening-read-gate-leaks-nested-objects, #552).
 *
 * Memoized per request+App, and ONLY inside a query (#1026). Both halves matter:
 *
 *   - memoized, because `Worker.urn` and `Worker.portalUrl` each need it, and a
 *     roster selecting both would otherwise run TWO identical App lookups per
 *     worker — concurrently, up to the 200-item page cap. That is the defect PR
 *     #1000's review already caught once on this exact lookup; adding a second
 *     URN-shaped field without a memo would reintroduce it at double the width.
 *   - query-only, because `updateApp` can write a new `urn`, so a request-scoped
 *     memo over it is stale by construction in a mutation. Same rule, and the
 *     same reason, as the `repos` affinity memo below: a mutation pays the
 *     re-read rather than serving its own stale answer.
 *
 * `info` is absent when an MCP tool calls the field resolver directly, which
 * lands on the un-memoized path — the safe direction.
 */
async function loadAppUrnForWorker(
  ctx: Context,
  appId: string,
  opts: { memoize: boolean },
): Promise<string | null> {
  type Cache = Map<string, Promise<string | null>>;
  const read = async (): Promise<string | null> => {
    const app = await ctx.db.app.findUnique({ where: { id: appId }, select: { urn: true } });
    return app?.urn ?? null;
  };
  if (!opts.memoize) return read();
  const holder = ctx as Context & { workerAppUrnCache?: Cache };
  const cache = (holder.workerAppUrnCache ??= new Map());
  let pending = cache.get(appId);
  if (!pending) {
    pending = read();
    cache.set(appId, pending);
  }
  return pending;
}

/**
 * The worker's URN, `hrn:worker:<root>:<app-slug>:<slug>` (#991) — COMPUTED from
 * the App's URN plus the stored `slug`, never a column, so a worker is
 * addressable context-free (`workerRef`, `resolveUrn`, a portal link) without
 * the caller holding its cuid.
 *
 * Shared by `Worker.urn` and `Worker.portalUrl` (#1026) so the identifier a
 * worker prints and the link that opens it can never disagree about what they
 * address — the same reason `Node.urn` and `Node.portalUrl` share
 * `resolveNodeUrnField`.
 *
 * Null rather than an error when the App's URN isn't the flat `<root>:<slug>`
 * pair the fixed arity needs (a legacy row the #697 backfill left behind) — an
 * unaddressable worker is a gap, not a query failure.
 */
async function resolveWorkerUrnField(
  worker: { appId: string; slug: string },
  ctx: Context,
  info?: { operation?: { operation?: string } },
): Promise<string | null> {
  const appUrn = await loadAppUrnForWorker(ctx, worker.appId, {
    memoize: info?.operation?.operation === 'query',
  });
  if (appUrn === null) return null;
  try {
    return composeWorkerUrn(normalizeUrnForLookup(appUrn), worker.slug);
  } catch {
    return null;
  }
}

export const workerFieldResolvers = {
  /**
   * #1073 — the release receipt's holder, resolved lazily as a SANITIZED
   * projection (`ReleasedFromUser`), not as a `User`.
   *
   * The mutation returns `releasedFromUserId`; this loads the row only when a
   * client actually selects `releasedFrom`, so a caller that just wants
   * `forced` / `notified` pays no extra query. Null propagates unchanged,
   * which is the idempotent "nothing was released" case.
   *
   * **Why not `User`** (PR #1124 review, Codex P1 — and it disproved the
   * justification this resolver originally shipped with). That justification
   * was: the caller is the holder or an App/org ADMIN, and that audience can
   * already read the same object through `AppMember.user`. Both halves fail on
   * the path that matters:
   *
   * - `leaveApp` DELETES the `AppMember` row and does not touch the hold, so an
   *   app-only holder who has left keeps the name with no membership row behind
   *   it. That is the departed colleague — the exact case force-release exists
   *   to serve — and for them the `AppMember.user` route does not exist.
   * - `Worker` only ever exposed `heldByUserId`, a bare id. There was no path
   *   from this surface to a `User` at all, so returning one would have been a
   *   NEW disclosure rather than an inherited one.
   *
   * And what it discloses is not nothing: `User`'s gated fields are `name`,
   * `email`, `googleId`, `appleId`; `policy`, `identityProvider`, `externalId`,
   * `githubId`, `githubUsername`, `roles` and `maxReferrals` default-resolve
   * with no gate of their own, because they lean on the surface that returned
   * the object. That is the CLAUDE.md invariant verbatim — relaxing a read gate
   * re-derives the whole field surface it admits.
   *
   * So: id / handle / urn, plus `name` behind the SAME shared `#384` gate it
   * has on `User` rather than a second copy of the rule (a bespoke per-resolver
   * gate drifts). An admin releasing someone who has left the org sees a null
   * name and still learns who they released.
   */
  ReleaseWorkerPayload: {
    releasedFrom: async (
      parent: { releasedFromUserId?: string | null },
      _args: unknown,
      ctx: Context,
    ) => {
      if (!parent.releasedFromUserId) return null;
      return ctx.db.user.findUnique({
        where: { id: parent.releasedFromUserId },
        // Selected, not spread: a projection that reads the whole row is one
        // schema change away from leaking the field it forgot to think about.
        select: { id: true, handle: true, name: true },
      });
    },
  },
  ReleasedFromUser: {
    urn: (u: { handle?: string | null }) => userUrn(u.handle),
    /** The #384 gate, reused — see `User.name` in resolvers.types.ts. */
    name: async (u: { id: string; name?: string | null }, _args: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.name ?? null) : null,
  },
  /**
   * #2223 — `heldBy` on the roster. The producer (the roster leaf) has already put `name` through the shared
   * #384 gate in bulk, so only the derived URN is resolved here.
   */
  WorkerHolder: {
    urn: (u: { handle?: string | null }) => userUrn(u.handle),
  },
  Worker: {
    /**
     * Scalar App identity for cross-App worker pages (#1344). Unlike
     * `Worker.app`, this never returns an App object (and therefore cannot hand
     * an AppMember-only caller App.keys/members through nested resolvers).
     * Masked behind the worker read gate because historical Session.worker
     * reaches this type through a wider audience.
     */
    appUrn: async (
      worker: { appId: string },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<string | null> => {
      if (!(await maySeeWorkerInternals(ctx, worker.appId))) return null;
      const stored = await loadAppUrnForWorker(ctx, worker.appId, {
        memoize: info?.operation?.operation === 'query',
      });
      // Canonical, as documented and as `App.urn` answers — the stored column
      // may be a legacy shape (#1347 review).
      return stored ? safeCanonicalUrn('app', stored) : null;
    },
    /**
     * The worker's URN (#991). See `resolveWorkerUrnField`.
     *
     * An identity scalar, ungated like `name`: it discloses the App's slug, and
     * the Worker read gate already requires participation in that App.
     */
    urn: (
      worker: { appId: string; slug: string },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ) => resolveWorkerUrnField(worker, ctx, info),
    /**
     * #1026 — the portal link that opens this worker, so a worker signing an
     * artifact under #1008 hands over a URL instead of assembling one.
     *
     * Node reads have emitted this since #881, and every role-agent prompt on
     * this team carries the rule "never hand-build a portal link — copy the URL
     * line a node read prints". Worker reads printed the URN and no link, so
     * satisfying #1008 meant constructing `<origin>/app/u/<urn>` by hand: the
     * one thing the surrounding instruction forbids. The prompts resolved that
     * with an explicit carve-out ("the ONE portal link you may construct
     * yourself"), which teaches an exception to a rule that exists for a good
     * reason and puts the portal origin in the model's hands rather than the
     * server's. This field is what lets the carve-out come out.
     *
     * Built from the SAME URN the `urn` field returns, so the two cannot
     * diverge. Ungated for the same reason `urn` is — it discloses nothing the
     * URN beside it does not.
     *
     * Nullable on BOTH arms, and neither is an error: no configured portal
     * origin means no link (see lib/portalUrl.ts — a link to the wrong host is
     * worse than none), and an App URN the fixed arity cannot take means no URN
     * to build one from.
     */
    portalUrl: async (
      worker: { appId: string; slug: string },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<string | null> => {
      const urn = await resolveWorkerUrnField(worker, ctx, info);
      return urn === null ? null : portalUrlForUrn(urn);
    },
    /**
     * #1024 — the repo affinity of this worker's ROLE, resolved so a client
     * binding a worker needs no second round-trip to `teamRoles`. The CLI's
     * mismatch warning fires at `session start` (hadron-cli#456), which already
     * has the worker in hand.
     *
     * Behind the worker read gate and masked on deny, like `promptOverride` and
     * the holder — because `Session.worker` reaches a Worker through a WIDER
     * gate that admits any org member and survives a user leaving the App, so
     * an ungated field here would publish a team's repo list through any
     * historical session.
     *
     * Masking to `[]` rather than null is deliberate and costs nothing: empty
     * already means "no affinity, never warn" (the field's contract), so a
     * denied caller simply gets no warning — the safe direction for a signal
     * that must never become a refusal.
     *
     * UNPROVEN BY CONSTRUCTION, and kept anyway. `teamRoles` runs
     * `requireWorkerReadAccess` — the same predicate `maySeeWorkerInternals`
     * wraps — so today the inner call refuses first and deleting this line
     * leaves the suite green. That is a green mutation indicting the TEST, not
     * the guard (review:a-green-mutation-indicts-the-test): no input reaches
     * it, because the two gates are currently identical.
     *
     * It stays because it makes THIS field's audience explicit rather than
     * inherited. `teamRoles` is a roster read and widening it is plausible; if
     * it ever admits a broader caller, this field would silently widen with it
     * — through `Session.worker`, which is the leak path described above. The
     * day those predicates diverge, this line becomes load-bearing and a test
     * can reach it.
     *
     * Resolved through `loadAppRepoAffinity` — a direct, request-memoized read
     * of the role nodes, NOT the `teamRoles` query. Routing an internal lookup
     * through a public paged query cost three defects in one decision (PR
     * #1071 review, Codex): it truncated at 50 roles, it broke outright for an
     * App with several `roles:` branches, and it reloaded the roster once per
     * worker on a listing.
     *
     * A role with no definition, a worker with no role, and an unreadable
     * system memory all answer `[]` rather than erroring. A soft signal must
     * not be able to fail a read.
     */
    repos: async (
      worker: { appId: string; role: string | null },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<string[]> => {
      if (!worker.role) return [];
      if (!(await maySeeWorkerInternals(ctx, worker.appId))) return [];
      // LAZY import: resolvers.teamRole imports this module (withRoleWriteLock,
      // locateTeamAgent), so a static import would close the cycle. Same shape
      // as the teamChat locator below.
      const { loadAppRepoAffinity } = await import('./resolvers.teamRole.js');
      // Memoize only inside a QUERY. In a mutation the same request can write
      // the roles this answer derives from, and a request-scoped memo over
      // writable data is stale by construction — so a mutation pays the
      // re-read rather than risking its own stale answer.
      const affinity = await loadAppRepoAffinity(ctx, worker.appId, {
        memoize: info?.operation?.operation === 'query',
      });
      return affinity.get(worker.role.toLowerCase()) ?? [];
    },
    /** Working-state field — worker read gate, masked to null (see maySeeWorkerInternals). */
    signature: async (worker: { appId: string; signature: string }, _: unknown, ctx: Context) =>
      (await maySeeWorkerInternals(ctx, worker.appId)) ? worker.signature : null,
    trailer: async (worker: { appId: string; trailer: string }, _: unknown, ctx: Context) =>
      (await maySeeWorkerInternals(ctx, worker.appId)) ? worker.trailer : null,
    promptOverride: async (
      worker: { appId: string; promptOverride: string | null },
      _: unknown,
      ctx: Context,
    ) => ((await maySeeWorkerInternals(ctx, worker.appId)) ? worker.promptOverride : null),
    /**
     * #1050 — the holder, behind the worker read gate and masked to null on
     * deny (PR #1052 review, Codex P2).
     *
     * I first shipped these as ungated identity scalars, reasoning that the
     * Worker read gate already requires App participation. It does not always:
     * `Session.worker` reaches a Worker row through `sessionScopeFilter`, which
     * admits any org member AND leaves a self-attributed session readable after
     * its user has left the App — the #983 finding, which I cited in this same
     * file while making the same mistake in the opposite direction. A former
     * member could therefore read current staffing off a historical session.
     *
     * Who holds a name is working state, not identity: `name`, `role` and `urn`
     * describe the casting, while the holder describes who is working as it
     * right now.
     */
    heldByUserId: async (
      worker: { appId: string; heldByUserId: string | null },
      _: unknown,
      ctx: Context,
    ) => ((await maySeeWorkerInternals(ctx, worker.appId)) ? worker.heldByUserId : null),
    /**
     * Working-state field — worker read gate, masked to null (see heldByUserId).
     *
     * Also null whenever there is no holder, which the COLUMN alone does not
     * guarantee (PR #1052 review, Codex P2): the FK is ON DELETE SET NULL and
     * Postgres clears only `held_by_user_id`, so a hard-deleted user leaves
     * `held_at` behind. Both write paths in the platform (`releaseWorker`,
     * `deleteUserAccount`) clear the pair together, so this covers a raw
     * database delete rather than any operation — but the API invariant
     * "`heldAt` is null exactly when `heldByUserId` is" should hold because it
     * is enforced, not because every path remembered.
     *
     * Enforced HERE rather than as a CHECK constraint on purpose: a CHECK would
     * make the FK's own SET NULL violate it, turning a user deletion into an
     * error.
     */
    heldAt: async (
      worker: { appId: string; heldAt: Date | null; heldByUserId: string | null },
      _: unknown,
      ctx: Context,
    ) =>
      worker.heldByUserId && (await maySeeWorkerInternals(ctx, worker.appId))
        ? worker.heldAt
        : null,
    /**
     * #1726 — who this worker reports to. Staffing, like the hold: behind the
     * worker read gate and masked on deny (see heldByUserId), since
     * Session.worker reaches this type through a wider audience.
     */
    teamPlacement: async (worker: { appId: string; reportsToWorkerId?: string | null; explicitNoTeam?: boolean }, _: unknown, ctx: Context) =>
      (await maySeeWorkerInternals(ctx, worker.appId)) ? teamPlacement(worker) : null,
    reportsToWorkerId: async (
      worker: { appId: string; reportsToWorkerId?: string | null },
      _: unknown,
      ctx: Context,
    ) => ((await maySeeWorkerInternals(ctx, worker.appId)) ? (worker.reportsToWorkerId ?? null) : null),
    /** #1726 — the Worker this one reports to (same App, so the same gate), masked as reportsToWorkerId. */
    reportsTo: async (
      worker: { appId: string; reportsToWorkerId?: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      if (!worker.reportsToWorkerId || !(await maySeeWorkerInternals(ctx, worker.appId))) return null;
      return ctx.db.worker.findUnique({ where: { id: worker.reportsToWorkerId } });
    },
    /**
     * #1726 — the worker reports to a RETIRED worker. Retirement clears the
     * retired worker's own reportsTo but leaves the workers reporting to it
     * alone, so a stale claim is flagged here instead of cleared silently.
     */
    reportsToRetired: async (
      worker: { appId: string; reportsToWorkerId?: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      if (!worker.reportsToWorkerId || !(await maySeeWorkerInternals(ctx, worker.appId))) return false;
      const to = await ctx.db.worker.findUnique({ where: { id: worker.reportsToWorkerId }, select: { retiredAt: true } });
      return !!to?.retiredAt;
    },
    /** Working-state field — worker read gate, masked to null (see maySeeWorkerInternals). */
    memoryId: async (
      worker: { appId: string; memoryId: string | null },
      _: unknown,
      ctx: Context,
    ) => ((await maySeeWorkerInternals(ctx, worker.appId)) ? worker.memoryId : null),
    /**
     * hadron-cli#487 — is a worker session open on this name RIGHT NOW.
     *
     * Nullable, and null means "not permitted to know" rather than "no". A
     * non-null `Boolean!` would have to answer `false` on deny, which states a
     * fact the resolver never computed — the #1084 P1 in miniature, where the
     * gate and the value described different things. Masked like every other
     * working-state field, because `Session.worker` reaches Worker rows through
     * a wider gate (#983).
     *
     * This is NOT availability. A name's availability is its HOLD
     * (`cor:agt:020:09`); liveness only says whether a session is open, which
     * is a question about your own worker. The two were conflated in the CLI
     * and that conflation IS hadron-cli#487.
     */
    hasLiveSession: async (
      worker: { id: string; appId: string; __heldWorkerActivity?: WorkerActivity },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<boolean | null> => {
      if (!(await maySeeWorkerInternals(ctx, worker.appId))) return null;
      if (worker.__heldWorkerActivity) return worker.__heldWorkerActivity.hasLiveSession;
      const activity = await loadAppWorkerActivity(ctx, worker.appId, {
        memoize: info?.operation?.operation === 'query',
      });
      return activity.get(worker.id)?.hasLiveSession ?? false;
    },
    /**
     * #1707 (cor:agt:060:04) — the model family of this worker's binding: its
     * newest open session's family, kept while the session is quiet and
     * cleared when it ends. Null when unbound, when the binding reported none,
     * or when the caller may not see the worker's working state (the same gate
     * as hasLiveSession). A matching input, never authorization.
     */
    family: async (
      worker: { id: string; appId: string; __heldWorkerActivity?: WorkerActivity },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<string | null> => {
      if (!(await maySeeWorkerInternals(ctx, worker.appId))) return null;
      if (worker.__heldWorkerActivity) return worker.__heldWorkerActivity.bindingFamily;
      const activity = await loadAppWorkerActivity(ctx, worker.appId, {
        memoize: info?.operation?.operation === 'query',
      });
      return activity.get(worker.id)?.bindingFamily ?? null;
    },
    /** #2252 — the model its binding last reported (the newest open session's; same gate and fold as `family`). Self-declared; never authorization. */
    model: async (
      worker: { id: string; appId: string; __heldWorkerActivity?: WorkerActivity },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<string | null> => (await bindingModelOf(ctx, worker, info))?.bindingModel ?? null,
    /** #2252 — when that model was self-reported; null when the session never reported one. */
    modelReportedAt: async (
      worker: { id: string; appId: string; __heldWorkerActivity?: WorkerActivity },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<Date | null> => (await bindingModelOf(ctx, worker, info))?.modelReportedAt ?? null,
    /** #2252 / R189 — the coarse tier of `model` from the server's one mapping; null when unmapped. Advisory only. */
    tier: async (
      worker: { id: string; appId: string; __heldWorkerActivity?: WorkerActivity },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<string | null> => tierOf((await bindingModelOf(ctx, worker, info))?.bindingModel),
    /**
     * hadron-cli#487 — when this worker was last DRIVEN, across every session
     * it has ever had; null for a worker nobody has ever bound.
     *
     * That null is the whole point of the field: a worker cast and never driven
     * is a meaningfully different thing from one worked yesterday, and every
     * surface rendered them identically while a coordinator dispatched ten
     * issues into the second one thinking it was the first.
     *
     * Derived by the platform's shared derivation (`sessionActivityAt`), so an
     * "idle since" a human reads here agrees with the one the takeover prompt
     * shows and the one the reaper acts on. Masked on deny, as above.
     */
    lastActiveAt: async (
      worker: { id: string; appId: string; __heldWorkerActivity?: WorkerActivity },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<Date | null> => {
      if (!(await maySeeWorkerInternals(ctx, worker.appId))) return null;
      if (worker.__heldWorkerActivity) return worker.__heldWorkerActivity.lastActiveAt;
      const activity = await loadAppWorkerActivity(ctx, worker.appId, {
        memoize: info?.operation?.operation === 'query',
      });
      return activity.get(worker.id)?.lastActiveAt ?? null;
    },
    /**
     * #2138 §3.4 (experimental) — whether this worker is checking its team
     * channel as expected (`deriveWorkerCheckStatus`). Masked on deny, on the
     * same gate as hasLiveSession: anyone who may read the App's roster.
     */
    checkStatus: async (
      worker: { id: string; appId: string },
      _: unknown,
      ctx: Context,
      info?: { operation?: { operation?: string } },
    ): Promise<WorkerCheckStatus | null> => {
      if (!(await maySeeWorkerInternals(ctx, worker.appId))) return null;
      const statuses = await loadAppWorkerCheckStatuses(ctx, worker.appId, {
        memoize: info?.operation?.operation === 'query',
      });
      return statuses.get(worker.id) ?? null;
    },
    /**
     * The role-agent behind the casting — behind Query.agent's OWN read gate
     * (PUBLIC, else owner / org READER), masked to null on deny. The Worker
     * read gate is WIDER than the Agent's (App participants, App keys), and a
     * nested object hands the caller the Agent's field resolvers — systemPrompt
     * included — which assume the outer query authorized them
     * (findings:broadening-read-gate-leaks-nested-objects, #552). The
     * installed-agent read grant cannot stand in for that gate either: Worker
     * rows survive uninstall, so "a Worker exists" does not imply the grant
     * still does (PR #978 review — codex P1 + Copilot).
     */
    agent: async (worker: { agentId: string }, _: unknown, ctx: Context) => {
      const agent = await ctx.db.agent.findUnique({ where: { id: worker.agentId } });
      if (!agent || agent.deletedAt) return null;
      if (agent.visibility !== 'PUBLIC') {
        try {
          await requireAgentAccess(ctx, agent, 'READER');
        } catch {
          return null;
        }
      }
      return agent;
    },
    /**
     * The App whose staff this casting fills — behind Query.app's OWN read
     * gate (owner / org READER), masked to null on deny: an AppMember who is
     * not an org member can read the Worker but must not reach App.keys /
     * App.members through it (the same #552 class as `agent` above).
     */
    app: async (worker: { appId: string }, _: unknown, ctx: Context) => {
      const app = await ctx.db.app.findUnique({ where: { id: worker.appId } });
      if (!app || app.deletedAt) return null;
      try {
        await requireOwnerOrOrgRole(ctx, app, 'READER');
      } catch {
        return null;
      }
      return app;
    },
    /**
     * The worker's boot prompt, resolved (cor:agt:020:01 — "how {{name}} and
     * the override compose is tunable"): the agent's `systemPrompt` template
     * with `{{name}}`/`{{role}}` bound, then the per-worker `promptOverride`
     * appended as its own paragraph. Null when the agent carries no template
     * and the worker no override.
     */
    prompt: async (
      worker: { id: string; appId: string; agentId: string; name: string; role: string | null; promptOverride: string | null; signature: string; trailer: string },
      _: unknown,
      ctx: Context,
    ) => (await composeWorkerPrompt(ctx, worker)).text,
    /**
     * #1029 — what a fresh binding inherits from the previous stint.
     *
     * Working-state field, so it sits behind the same worker read gate as
     * `prompt` / `memoryId` and masks to null on deny: it returns a node out of
     * the worker's working memory and a Session row, and a nested object hands
     * the caller that entity's field resolvers
     * (findings:broadening-read-gate-leaks-nested-objects, #552).
     *
     * "Previous session" is the most recent ENDED one, deliberately not the
     * most recent session outright: the session doing the reading is typically
     * this worker's newest and is still open, and a session that inherits its
     * own handoff is a loop, not continuity. Ordered by `endedAt` rather than
     * `startedAt` because with `force` two stints can overlap, and the one that
     * finished last is the one whose account is current.
     */
    continuity: async (
      worker: { appId: string; id: string; memoryId: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      if (!(await maySeeWorkerInternals(ctx, worker.appId))) return null;
      // SANITIZED projection, never the Session row (PR #1045 review, Codex
      // P1). The gate above is App PARTICIPATION; the session read gate
      // (`sessionScopeFilter`) needs ORG membership or self-attribution — so an
      // AppMember who is not an org member passes this field and would fail a
      // direct session read. Returning the object would hand them the previous
      // driver's transcriptPath, host, repo and summary through Session's own
      // field resolvers, which assume the outer query authorized them. Selected
      // narrowly so a later field on Session cannot silently join the payload.
      const previousSession = await ctx.db.session.findFirst({
        where: { workerId: worker.id, endedAt: { not: null }, deletedAt: null },
        orderBy: { endedAt: 'desc' as const },
        select: { id: true, endedAt: true, autoExpiredAt: true },
      });
      // No working memory means no sequence to have written to — which is a
      // real state (provisioning is best-effort at cast), not an error. The
      // status still reports honestly on the previous stint.
      // #1764 (Riana P1): a USER-owned working memory is read through its own gate (the owner, or the worker's holder),
      // not through App participation: a member of a user-owned App is a participant but not a reader of it. An
      // unreadable one is treated as having no handoff to show, so neither its content nor its existence is told.
      const handoffReadable = !worker.memoryId ? false : await (async () => {
        const mem = await ctx.db.memory.findUnique({ where: { id: worker.memoryId! }, select: { ownerUserId: true } });
        return mem?.ownerUserId == null || (await isMemoryReadableCached(ctx, worker.memoryId!));
      })();
      const handoffRow = worker.memoryId && handoffReadable
        ? await newestHandoff(ctx.db, worker.memoryId)
        : null;
      const status = continuityStatusOf({
        previousSessionId: previousSession?.id ?? null,
        handoffSessionId: handoffRow ? handoffSessionId(handoffRow.data) : null,
      });
      // Re-read through the node surface so the Node field resolvers see a full
      // row (and an encrypted memory decrypts through the same path every other
      // node read uses) rather than the projection newestHandoff selects.
      const handoff = handoffRow
        ? await ctx.db.node.findUnique({ where: { id: handoffRow.id } })
        : null;
      return { status, handoff, previousSession };
    },
  },
};
