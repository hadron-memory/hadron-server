import { triggerBudgetPatch, type TriggerRunBudgets } from '../../../lib/automation/runBudgets.js';
import { configSelection } from '../../../lib/automation/identities.js';
import { captureSetupConsent } from '../../../lib/automation/pins.js';
// Headless-run surfaces (spec 040 plan §9): schedule CRUD, the run audit
// read surface (cor:api:120-shaped), manual trigger, and the kill switch.

import { GraphQLError } from 'graphql';
// Spec 049 Phase 3b — a trigger's scopeRef, gated and resolved in the App's context.
import { resolveScopeForTrigger } from '../../../lib/scopes.js';
import { generateId } from '../../../lib/id.js';
import {
  mintAppRun,
  handleSpawnCompletion,
  RunLaunchDeniedError,
  setQuotaLimit as setQuotaLimitKernel,
  ensureQuotaRowsForScope,
} from '../../../jobs/appRuns.js';
import { mintWebhookPlatformToken, generateWebhookSecret } from '../../webhooks.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { nextCronOccurrence } from '../../../jobs/scheduler.js';
import { parsePolicyLink, explainPolicyChain, type PolicyAction } from '@hadron-memory/access-control';
import {
  assertFullyQualifiedUrn,
  splitNodeUrn,
  normalizeUrnForLookup,
  legacyMemoryUrnToCanonical,
} from '../../../lib/urn.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAppRunRef, composeAppRunUrn } from '../../../lib/entityRef/appRunRef.js';
import { AppRunNotFoundError } from '../../../lib/entityRef/errors.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { type Context, requireOrgRole, requireOwnerOrOrgRole, isPlatformAdmin } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { hasAppRelationship } from '../../../lib/auth/appRelationship.js';
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';

/** Orderable columns on the appRuns list (#833). Mirrors the SDL enum. */
export type AppRunSortField = 'createdAt' | 'startedAt' | 'finishedAt' | 'status';

/**
 * #836 — the status filter, widened from one value to a disjunction.
 *
 * Semantics follow conventions:multi-ref-scope-args (#805/PR #808), where the
 * traps were already paid for:
 *   - OMITTED (undefined/null) means NO status filter, unchanged from today.
 *   - An explicitly EMPTY list is the EMPTY scope and matches nothing. It must
 *     NOT fall back to "all" — that relabels one scope as another, the exact
 *     trap the convention calls out.
 *   - Values are deduped. An unknown member never reaches here: GraphQL enum
 *     validation rejects it at the schema layer, so "fail loudly" is free.
 *
 * `status` (singular) is deprecated but still accepted for one release. When
 * both are supplied `statuses` wins, so a client migrating field-by-field can
 * never end up with the two silently ANDed.
 */
export function buildStatusFilter(
  status?: string | null,
  statuses?: string[] | null,
): Record<string, unknown> {
  if (statuses !== undefined && statuses !== null) {
    // Explicitly empty ⇒ empty scope. `in: []` matches nothing in Prisma,
    // which is exactly the intent — spelled out because it reads like a bug.
    const deduped = [...new Set(statuses)];
    return { status: { in: deduped as never } };
  }
  if (status) return { status: status as never };
  return {};
}

/**
 * #833 — server-side ordering for the appRuns list. Without it a client table
 * could only sort the window it already held, so "the slowest run" meant "the
 * slowest of the most recent 200" — an affordance that quietly lies.
 *
 * Two things every branch must carry:
 *   - an `id` TIEBREAK, or rows with equal sort keys (every run sharing a
 *     status, say) shuffle between offset pages;
 *   - `nulls: 'last'` on the nullable timestamps. A PENDING run has no
 *     startedAt/finishedAt, and Postgres would otherwise float those nulls to
 *     the top of a DESC sort — burying the finished runs the operator asked to
 *     rank.
 *
 * Default stays createdAt desc: existing callers depend on newest-first.
 */
export function buildAppRunOrderBy(
  sortBy?: AppRunSortField | null,
  sortDir?: 'asc' | 'desc' | null,
): Record<string, unknown>[] {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  const tiebreak = { id: dir } as Record<string, unknown>;
  switch (sortBy) {
    case 'startedAt':
      return [{ startedAt: { sort: dir, nulls: 'last' } }, tiebreak];
    case 'finishedAt':
      return [{ finishedAt: { sort: dir, nulls: 'last' } }, tiebreak];
    case 'status':
      return [{ status: dir }, tiebreak];
    case 'createdAt':
    default:
      return [{ createdAt: dir }, tiebreak];
  }
}

export interface CreateAgentScheduleInput extends TriggerRunBudgets {
  /** App reference — PK or fully-qualified URN (the platform-wide `ref` convention). */
  appRef: string;
  name: string;
  /** Recurring: 5-field cron. XOR with runAt (#510). */
  cron?: string | null;
  /** One-shot: run once at this ISO instant. XOR with cron (#510). */
  runAt?: string | null;
  timezone?: string | null;
  entryNodeUrn: string;
  /** Agent reference — PK or URN; must be installed in the App. */
  agentRef?: string | null;
  /** On-behalf-of user (cor:agt:010:01). v1: only the caller themself. */
  runAsSelf?: boolean | null;
  eventData?: Record<string, unknown> | null;
  policy?: unknown;
  aiConfigName?: string | null;
  /** Spec 049 Phase 3b — the trigger's scope (id, or a name in the App's context); update: '' clears. */
  scopeRef?: string | null;
  enabled?: boolean | null;
}

/** Resolve the App ref (PK or URN), require it live, and require org-ADMIN on its org. */
async function requireScheduleAdmin(ctx: Context, appRef: string) {
  const { id } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app) {
    throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
  }
  await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
  // Schedules, webhooks, and the policy-debug surface all key off an
  // organization (AgentSchedule/AgentWebhook.organizationId are still
  // required non-null columns) — not yet modeled for a user-owned App.
  if (!app.organizationId) {
    throw new GraphQLError('This operation is not supported for user-owned Apps yet.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return { id: app.id, organizationId: app.organizationId };
}

/**
 * #2642: the automation's name for a failed run's plain reason, only when the
 * CALLER passes the same gate that lists schedules and webhooks
 * (`requireScheduleAdmin`). Any miss or failure — denied, user-owned App,
 * deleted or foreign trigger, other trigger kind — is null, so the caller sees
 * the generic wording with the same shape; the lookup is pinned to the run's
 * own App.
 */
export async function authorizedTriggerLabel(
  ctx: Context,
  run: { appId?: string | null; triggerKind?: string | null; triggerId?: string | null },
): Promise<string | null> {
  try {
    if (!run.appId || !run.triggerId) return null;
    const app = await requireScheduleAdmin(ctx, run.appId);
    const where = { id: run.triggerId, appId: app.id, organizationId: app.organizationId, deletedAt: null };
    if (run.triggerKind === 'SCHEDULE') return (await ctx.db.agentSchedule.findFirst({ where, select: { name: true } }))?.name ?? null;
    if (run.triggerKind === 'WEBHOOK') return (await ctx.db.agentWebhook.findFirst({ where, select: { name: true } }))?.name ?? null;
    return null;
  } catch {
    return null;
  }
}

/** Next occurrence for a cron+timezone pair, as a typed BAD_USER_INPUT on invalid input. */
function validatedCronNext(cron: string, timezone: string): Date {
  try {
    return nextCronOccurrence(cron, timezone);
  } catch {
    throw new GraphQLError(
      `Invalid cron expression "${cron}" or timezone "${timezone}".`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
}

/** Parse an ISO runAt into a Date, typed BAD_USER_INPUT on garbage (#510 one-shots). */
function validatedRunAt(runAt: string): Date {
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) {
    throw new GraphQLError(`Invalid runAt "${runAt}" — use an ISO-8601 datetime.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return d;
}

/** runAsSelf REQUIRES an authenticated user — never silently degrade to a no-user run (PR-493). */
function resolveRunAsSelf(ctx: Context, runAsSelf: boolean | null | undefined): string | null {
  if (!runAsSelf) return null;
  if (!ctx.userId) {
    throw new GraphQLError('runAsSelf requires an authenticated user.', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return ctx.userId;
}

/**
 * A persisted on-behalf-of identity belongs to its user, not to the trigger's
 * administrators (cor:agt:010:01; #1643). Run this on the locked current row;
 * neither clearing nor replacing its identity permits another actor to edit it.
 */
function requireStoredRunOwner(ctx: Context, userId: string | null): void {
  if (ctx.impersonation || (userId !== null && !isStrictOwner(ctx, userId))) {
    throw new GraphQLError('Only the stored run-as user may change this trigger.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

/** Require a current App relationship for an identity retained or newly selected by an edit. */
async function requireRunIdentityRelationship(ctx: Context, appId: string, userId: string | null): Promise<void> {
  if (userId && !(await hasAppRelationship(ctx.db, appId, userId))) {
    throw new GraphQLError('The on-behalf-of user has no live relationship with this App.', {
      extensions: { code: 'RELATIONSHIP_MISSING' },
    });
  }
}

/**
 * #1565 (Codex-worker P1, Jane): who may read a run WITHOUT an org READER row.
 * `hadron_run_task` lets an App's own key and a user with a live App
 * relationship (AppMember or active subscriber) launch a run, and points them
 * at `hadron_get_run` to read it; the org-READER gate alone refused exactly
 * those starters. Shared by GraphQL `appRun` and the MCP tool, so the two
 * never drift. Admits:
 *   - a platform admin;
 *   - a PURE App-key principal (no userId) for its own App's runs — a user's
 *     App SELECTION is not that credential
 *     (findings:auth-appid-credential-vs-selection);
 *   - a user for a run that runs on their behalf (`userId`), or a MANUAL run
 *     they started (`createdBy`), while they STILL have a live relationship
 *     with the run's App (revoked membership authorizes nothing). `createdBy`
 *     counts only on MANUAL runs: scheduled and webhook runs copy the
 *     trigger configuration's creator into it (scheduler.ts, webhooks.ts), so
 *     on those it does not mean "started this run" (Copilot on #1565).
 *     Other members' runs stay masked: an envelope can carry another user's
 *     data.
 * Anyone else falls through to the org-READER gate, unchanged.
 */
export async function mayReadAppRunWithoutOrgRole(
  ctx: Context,
  run: { appId: string; userId: string | null; createdBy: string | null; triggerKind: string },
): Promise<boolean> {
  if (isPlatformAdmin(ctx)) return true;
  if (!ctx.userId) return !!ctx.appId && ctx.appId === run.appId;
  if (ctx.impersonation) return false;
  const own = run.userId === ctx.userId || (run.triggerKind === 'MANUAL' && run.createdBy === ctx.userId);
  return own && (await hasAppRelationship(ctx.db, run.appId, ctx.userId));
}

/**
 * The run read gate as one boolean (#1577): the narrow own-run arm, else an org READER. `appRun` answers null on false,
 * and a nested field that must be authorized on its own (`AppRun.servedPrompt`, #2047) asks the SAME predicate instead of
 * leaning on the parent query. Only an authorization denial is false; any other error still surfaces.
 */
export async function canReadAppRun(
  ctx: Context,
  run: { appId: string; organizationId: string; userId: string | null; createdBy: string | null; triggerKind: string },
): Promise<boolean> {
  if (await mayReadAppRunWithoutOrgRole(ctx, run)) return true;
  try {
    await requireOrgRole(ctx, run.organizationId, 'READER');
    return true;
  } catch (err) {
    if (err instanceof GraphQLError && err.extensions?.code === 'FORBIDDEN') return false;
    throw err;
  }
}

/**
 * Interactive / import MANUAL-run gate (#530, cor:acl). Ad-hoc runs
 * (`triggerAppRun`, `runTask(appRef:)`, `importNode(taskRef:)`) are the
 * end-user features these paths exist for, so — unlike schedules and webhooks,
 * which keep the stricter org-ADMIN gate (`requireScheduleAdmin`) — a run may be
 * triggered by anyone with a real relationship to the App:
 *   - a platform admin, or the App acting under its own key (`ctx.appId`),
 *   - an org ADMIN of the App's org,
 *   - an AppMember of the App, or
 *   - a user with an active AgentSubscription to one of the App's agents.
 * `mintAppRun` re-verifies the on-behalf-of *user* at launch (appRuns.ts); this
 * authorizes the *triggering caller*.
 */
async function requireManualRunAccess(ctx: Context, appRef: string) {
  const { id } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app) {
    throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
  }
  // Platform admin, or the App triggering under its own key.
  if (isPlatformAdmin(ctx) || ctx.appId === app.id) {
    // authorized — fall through to the shared organizationId guard below
  } else if (ctx.userId && (await hasAppRelationship(ctx.db, app.id, ctx.userId))) {
    // A user with a live relationship to the App (AppMember or active subscriber).
  } else {
    // Otherwise fall back to the owner-or-org-ADMIN gate: admits org admins
    // who aren't AppMembers (or the App's own owner-user), and yields the
    // standard typed Forbidden for callers with no relationship at all.
    await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
  }
  // AppRun.organizationId is still a required non-null column — manual runs
  // aren't yet modeled for a user-owned App.
  if (!app.organizationId) {
    throw new GraphQLError('Manual runs are not supported for user-owned Apps yet.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return { id: app.id, organizationId: app.organizationId };
}

/**
 * Validate that this caller may launch a MANUAL run for `entryNodeUrn` under
 * `appRef`, WITHOUT minting it: the interactive gate (#530), the App's liveness,
 * runAsSelf feasibility, and the same-org entry-node boundary (#531). Returns
 * the resolved App. Split out so a caller with a side effect to protect —
 * importNode's write (#533) — can fail on these prerequisites BEFORE the write,
 * then mint after. (mintAppRun's dynamic quota / on-behalf-of re-checks still
 * run at mint time.)
 */
export async function assertManualRunAllowed(
  ctx: Context,
  input: { appRef: string; entryNodeUrn: string; runAsSelf?: boolean | null; agentRef?: string | null },
): Promise<{ id: string; organizationId: string; agentId: string | null }> {
  const app = await requireManualRunAccess(ctx, input.appRef);
  assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
  // runAsSelf REQUIRES an authenticated user — surface it here (pre-write) too.
  const onBehalfOf = resolveRunAsSelf(ctx, input.runAsSelf);
  // When the run is on-behalf-of a user, mintAppRun re-verifies THAT user's live
  // App relationship at launch. Mirror it here so an authorized trigger-er who
  // lacks the on-behalf-of relationship (e.g. an org admin who isn't an
  // AppMember, importing into an owner-only memory) fails pre-write instead of
  // after the side effect (#566 review). Same predicate + error as mintAppRun.
  if (onBehalfOf && !(await hasAppRelationship(ctx.db, app.id, onBehalfOf))) {
    throw new GraphQLError(
      'The on-behalf-of user has no live relationship with this App.',
      { extensions: { code: 'RELATIONSHIP_MISSING' } },
    );
  }
  // Tenant boundary (#531 review, Copilot): a run resolves its entry node ONLY
  // within its own org (appRunDeps.loadEntry — cross-org reads are not a run
  // capability in v1). Reject a cross-org entry URN early rather than minting a
  // run guaranteed to fail in assembly. A not-yet-resolvable memory is left to
  // the executor's entry-not-found path (don't over-reject). Resolve the entry
  // memory the same way appRunDeps.loadEntry does (raw + canonical URN forms).
  const { memoryUrn } = splitNodeUrn(input.entryNodeUrn);
  const normalized = normalizeUrnForLookup(memoryUrn);
  const entryMem = await ctx.db.memory.findFirst({
    where: { OR: [{ urn: normalized }, { urn: legacyMemoryUrnToCanonical(normalized) }] },
    select: { organizationId: true },
  });
  if (entryMem && entryMem.organizationId !== app.organizationId) {
    throw new GraphQLError(
      'The entry node must belong to the same organization as the App.',
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
  // #2735 / cor:agt:040:10: which Agent the run is served as. Resolved here so
  // every refusal lands before a caller's write (importNode).
  return { ...app, agentId: await resolveManualRunAgent(ctx, app.id, input.agentRef) };
}

/**
 * The Agent a MANUAL run is served as (#2735, cor:agt:040:10; Holger's R1): the
 * named Agent, which must be installed in the App; else the App's single
 * installed Agent; else, with several and none named, `RUN_AGENT_REQUIRED`. An
 * App with no installed Agent yields null and keeps today's refusal at mint.
 */
async function resolveManualRunAgent(
  ctx: Context,
  appId: string,
  agentRef: string | null | undefined,
): Promise<string | null> {
  const named = await resolveInstalledAgent(ctx, appId, agentRef);
  if (named) return named;
  const installed = await ctx.db.appAgent.findMany({ where: { appId }, select: { agentId: true }, take: 2 });
  if (installed.length > 1) {
    throw new GraphQLError('This App has several installed Agents: pass agentRef to name the one the run is served as.', {
      extensions: { code: 'RUN_AGENT_REQUIRED' },
    });
  }
  return installed[0]?.agentId ?? null;
}

/**
 * Mint a MANUAL AppRun for an entry (task) node under an App — the shared
 * execute path behind the `triggerAppRun` mutation, `runTask(appRef:)` (#529),
 * and `importNode(taskRef:)` (#528). Authorized by the interactive gate (#530).
 * Maps a launch denial to a typed GraphQLError.
 */
/**
 * Mint a MANUAL run for an ALREADY-VALIDATED app (the object returned by
 * assertManualRunAllowed). Maps a launch denial to a typed GraphQLError. Split
 * from triggerManualRun so a caller that already asserted pre-write (importNode,
 * #533) can mint post-write WITHOUT re-running the gate — no double validation
 * (Copilot #566).
 */
export async function mintManualRun(
  ctx: Context,
  app: { id: string; organizationId: string; agentId?: string | null },
  input: {
    entryNodeUrn: string;
    eventData?: Record<string, unknown> | null;
    runAsSelf?: boolean | null;
    aiConfigName?: string | null;
    budgetTokens?: number | null;
    budgetActions?: number | null;
  },
  options: { publish?: boolean } = {},
) {
  try {
    return await mintAppRun(ctx.db, {
      // #2737: a composed import publishes only after its outer transaction commits.
      publish: options.publish,
      organizationId: app.organizationId,
      appId: app.id,
      agentId: app.agentId ?? null,
      userId: resolveRunAsSelf(ctx, input.runAsSelf),
      triggerKind: 'MANUAL',
      consentPrincipal: ctx,
      ...triggerBudgetPatch(input),
      entryNodeUrn: input.entryNodeUrn,
      eventData: {
        ...(input.eventData ?? {}),
        ...(input.aiConfigName ? { __aiConfigName: input.aiConfigName } : {}),
      },
      createdBy: ctx.userId ?? ctx.clientId ?? null,
    });
  } catch (err) {
    if (err instanceof RunLaunchDeniedError) {
      throw new GraphQLError(err.message, { extensions: { code: err.code } });
    }
    throw err;
  }
}

export async function triggerManualRun(
  ctx: Context,
  input: {
    appRef: string;
    agentRef?: string | null;
    entryNodeUrn: string;
    eventData?: Record<string, unknown> | null;
    runAsSelf?: boolean | null;
    aiConfigName?: string | null;
    budgetTokens?: number | null;
    budgetActions?: number | null;
  },
) {
  const app = await assertManualRunAllowed(ctx, input);
  return mintManualRun(ctx, app, input);
}

/**
 * Resolve an agent ref (PK or URN) and require it INSTALLED in the App — a
 * foreign agent would leak its AI config into the walk (PR-493, Codex P1).
 * Returns the resolved agent id (null when no ref given).
 */
async function resolveInstalledAgent(
  ctx: Context,
  appId: string,
  agentRef: string | null | undefined,
): Promise<string | null> {
  // Empty string ≡ absent (the platform's '' -> absent convention from
  // PR-486): '' never silently clears or skips validation — clearing an
  // agent is expressed with an explicit null (PR-502 review).
  if (agentRef == null || agentRef.trim() === '') return null;
  // #1946 (Holger's ruling A, team chat #11863): "no such Agent" and "not
  // installed in this App" are ONE answer, with no id, so an App's admin
  // can't probe Agents outside it.
  const notInstalled = () => new GraphQLError('agentRef does not name an agent installed in this App.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
  let agentId: string;
  try {
    ({ id: agentId } = await resolveAgentRef(ctx.db, agentRef));
  } catch (e) {
    if (e instanceof AgentNotFoundError) throw notInstalled();
    throw e;
  }
  const installed = await ctx.db.appAgent.findFirst({
    where: { appId, agentId },
    select: { agentId: true },
  });
  if (!installed) throw notInstalled();
  return agentId;
}

export const appRunMutations = {
  /** Create a recurring trigger (org-ADMIN). nextRunAt is seeded from the validated cron. */
  createAgentSchedule: async (
    _: unknown,
    { input }: { input: CreateAgentScheduleInput },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, input.appRef);
    const budgets = triggerBudgetPatch(input);
    assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
    const agentId = await resolveInstalledAgent(ctx, app.id, input.agentRef);
    const timezone = input.timezone?.trim() || 'UTC';
    // Exactly one of cron (recurring) / runAt (one-shot) — mirrors
    // chk_agent_schedule_cron_xor_run_at so the constraint never surfaces
    // as a raw DB error (#510).
    if ((input.cron == null) === (input.runAt == null)) {
      throw new GraphQLError('Provide exactly one of cron (recurring) or runAt (one-shot).', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    const nextRunAt = input.cron != null
      ? validatedCronNext(input.cron, timezone)
      : validatedRunAt(input.runAt as string);
    if (input.policy != null && parsePolicyLink(input.policy) == null) {
      throw new GraphQLError('policy must be { allow: string[] }.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    // Spec 049 Phase 3b: the trigger's scope — readable by the caller and owned
    // by this App's context; snapshotted onto each run at mint.
    const scopeId = input.scopeRef?.trim() ? await resolveScopeForTrigger(ctx, app.id, input.scopeRef) : null;
    const automationPin = await captureSetupConsent(ctx.db, app.id, resolveRunAsSelf(ctx, input.runAsSelf), input.entryNodeUrn, app.organizationId, ctx, configSelection({ ...input, agentId }));
    // #2438: the setup pin already resolved the entry — its entryId is the
    // stable key. The unadopted marker carries none (⇒ null: an unresolvable
    // entry keeps the URN path; D20 records the setup failure).
    const entryNodeId = automationPin != null && typeof automationPin === 'object' && 'entryId' in automationPin
      ? (automationPin as { entryId: string }).entryId : null;
    return ctx.db.agentSchedule.create({
      data: {
        id: generateId(),
        organizationId: app.organizationId,
        appId: app.id,
        agentId,
        scopeId,
        // v1: a schedule runs on behalf of its CREATOR or nobody — never a
        // third party (delegating another user's authority needs the rule
        // language; cor:agt:010:01 tunable).
        userId: resolveRunAsSelf(ctx, input.runAsSelf),
        name: input.name,
        cron: input.cron ?? null,
        runAt: input.runAt != null ? validatedRunAt(input.runAt) : null,
        timezone,
        entryNodeUrn: input.entryNodeUrn,
        entryNodeId,
        automationPin: automationPin as never,
        ...budgets,
        eventData: (input.eventData ?? undefined) as never,
        policy: (input.policy ?? undefined) as never,
        aiConfigName: input.aiConfigName ?? null,
        enabled: input.enabled ?? true,
        nextRunAt,
        createdBy: ctx.userId ?? ctx.clientId ?? null,
      },
    });
  },

  /** Org-ADMIN update; stored run-as authority requires its owner except for an exact stop-only edit (#1643). */
  updateAgentSchedule: async (
    _: unknown,
    { id, input }: { id: string; input: Partial<CreateAgentScheduleInput> },
    ctx: Context,
  ) => {
    const observed = await ctx.db.agentSchedule.findFirst({
      where: { id, deletedAt: null },
    });
    if (!observed) throw new GraphQLError('Schedule not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, observed.organizationId, 'ADMIN');
    // The adjudicated stop-only exception cannot carry any authority-changing field.
    const disableOnly = input.enabled === false && Object.keys(input).every(key => key === 'enabled');
    if (!disableOnly || ctx.impersonation) requireStoredRunOwner(ctx, observed.userId);
    let existing = observed;
    return withAuthorizedTx(
      ctx,
      [{ kind: 'org', id: observed.organizationId }, { kind: 'app', id: observed.appId }],
      async (txCtx) => {
        const current = await txCtx.db.agentSchedule.findFirst({ where: { id, deletedAt: null } });
        if (!current || current.appId !== observed.appId || current.organizationId !== observed.organizationId) {
          throw new GraphQLError('Schedule not found.', { extensions: { code: 'NOT_FOUND' } });
        }
        await requireOrgRole(txCtx, current.organizationId, 'ADMIN');
        if (!disableOnly || txCtx.impersonation) requireStoredRunOwner(txCtx, current.userId);
        const userId = input.runAsSelf != null ? resolveRunAsSelf(txCtx, input.runAsSelf) : current.userId;
        if (!disableOnly) await requireRunIdentityRelationship(txCtx, current.appId, userId);
        existing = current;
      },
      async (tx, txCtx) => {
        const timezone = input.timezone?.trim() || existing.timezone;
        // Mode transitions (#510): providing cron switches to recurring (clears
        // runAt); providing runAt switches to one-shot (clears cron). Both in
        // one call is ambiguous. A timezone-only change recomputes only for
        // recurring schedules — a one-shot's runAt is an absolute instant.
        if (input.cron != null && input.runAt != null) {
          throw new GraphQLError('Provide at most one of cron (recurring) or runAt (one-shot).', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        let modeFields: { cron?: string | null; runAt?: Date | null; nextRunAt?: Date } = {};
        if (input.cron != null) {
          modeFields = { cron: input.cron, runAt: null, nextRunAt: validatedCronNext(input.cron, timezone) };
        } else if (input.runAt != null) {
          const at = validatedRunAt(input.runAt);
          modeFields = { cron: null, runAt: at, nextRunAt: at };
        } else if (input.timezone != null && existing.cron != null) {
          modeFields = { nextRunAt: validatedCronNext(existing.cron, timezone) };
        }
        if (input.entryNodeUrn != null) assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
        // agentRef semantics on update: undefined/'' = no change (''≡absent),
        // null = clear the agent, string = set (validated as installed).
        const agentId =
          input.agentRef !== undefined && input.agentRef !== ''
            ? await resolveInstalledAgent(txCtx, existing.appId, input.agentRef)
            : undefined;
        if (input.policy != null && parsePolicyLink(input.policy) == null) {
          throw new GraphQLError('policy must be { allow: string[] }.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        // Spec 049: a ref sets the scope, an empty string clears it (⇒ `app`),
        // omitted leaves it — the agentRef convention above.
        const scopeId =
          input.scopeRef === undefined || input.scopeRef === null
            ? undefined
            : input.scopeRef.trim() === ''
              ? null
              : await resolveScopeForTrigger(txCtx, existing.appId, input.scopeRef);
        return tx.agentSchedule.update({
          where: { id },
          data: {
            ...triggerBudgetPatch(input),
            ...(input.name != null ? { name: input.name } : {}),
            ...modeFields,
            ...(input.timezone != null ? { timezone } : {}),
            ...(input.entryNodeUrn != null ? { entryNodeUrn: input.entryNodeUrn } : {}),
            ...(input.entryNodeUrn != null || input.runAsSelf != null || input.aiConfigName !== undefined || agentId !== undefined ? await captureSetupConsent(tx as never, existing.appId,
              input.runAsSelf != null ? resolveRunAsSelf(txCtx, input.runAsSelf) : existing.userId,
              // #2438 BLIND P2 (Andi): with no new entry supplied, capture by
              // the stamped id — after a rename the stored URN is stale, and
              // re-capturing it would break a working schedule's consent.
              input.entryNodeUrn ?? existing.entryNodeId ?? existing.entryNodeUrn, existing.organizationId, txCtx, configSelection({ ...existing, ...input, agentId: agentId === undefined ? existing.agentId : agentId })).then(consent => ({
              // #2438: a re-captured setup pin re-stamps the entry id with
              // it (the marker's absent entryId clears to null only when the
              // entry itself no longer resolves — the URN path takes over).
              automationPin: consent as never,
              ...(consent != null && typeof consent === 'object' && 'entryId' in consent ? { entryNodeId: (consent as { entryId: string }).entryId } : { entryNodeId: null }),
            })) : {}),
            ...(input.eventData !== undefined ? { eventData: input.eventData as never } : {}),
            ...(input.policy !== undefined ? { policy: input.policy as never } : {}),
            ...(input.aiConfigName !== undefined ? { aiConfigName: input.aiConfigName } : {}),
            ...(input.enabled != null ? { enabled: input.enabled } : {}),
            ...(input.runAsSelf != null ? { userId: resolveRunAsSelf(txCtx, input.runAsSelf) } : {}),
            ...(agentId !== undefined ? { agentId } : {}),
            ...(scopeId !== undefined ? { scopeId } : {}),
            updatedBy: txCtx.userId ?? txCtx.clientId ?? null,
          },
        });
      },
      { afterLock: async (tx) => {
        await tx.$queryRaw`SELECT id FROM agent_schedules WHERE id = ${id} FOR UPDATE`;
      } },
    );
  },

  /** Soft-delete + disable (org-ADMIN). */
  deleteAgentSchedule: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const existing = await ctx.db.agentSchedule.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new GraphQLError('Schedule not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, existing.organizationId, 'ADMIN');
    await ctx.db.agentSchedule.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null, enabled: false },
    });
    return true;
  },

  /** MANUAL trigger — the §4 sequence for an ad-hoc run (also the demo path). */
  triggerAppRun: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        appRef: string;
        agentRef?: string | null;
        entryNodeUrn: string;
        eventData?: Record<string, unknown> | null;
        runAsSelf?: boolean | null;
        aiConfigName?: string | null;
    budgetTokens?: number | null;
    budgetActions?: number | null;
      };
    },
    ctx: Context,
  ) => triggerManualRun(ctx, input),

  /** The kill switch's manual handle (cor:agt:010:02). */
  cancelAppRun: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const run = await ctx.db.appRun.findUnique({ where: { id } });
    if (!run) throw new GraphQLError('Run not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, run.organizationId, 'ADMIN');
    const cancelled = await ctx.db.appRun.updateMany({
      where: { id, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date(), failure: { code: 'CANCELLED' } },
    });
    if (cancelled.count === 1) {
      // A cancelled LAST child must still fire its parent's spawn callback —
      // without this, the fan-out digest waits forever (plan-spawn D-SP-4).
      await handleSpawnCompletion(ctx.db, id).catch((err) =>
        console.error(`[spawn] completion handling failed for cancelled ${id}:`, err),
      );
    }
    return ctx.db.appRun.findUniqueOrThrow({ where: { id } });
  },

  /**
   * Create a webhook trigger (D-2026-05-02). Returns the full URL path and
   * the platform token — the token is shown ONCE; rotate to get a new one.
   */
  createAgentWebhook: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        appRef: string;
        name: string;
        entryNodeUrn: string;
        agentRef?: string | null;
        runAsSelf?: boolean | null;
        argsSchema?: Record<string, unknown> | null;
        eventData?: Record<string, unknown> | null;
        policy?: unknown;
        aiConfigName?: string | null;
    budgetTokens?: number | null;
    budgetActions?: number | null;
        enabled?: boolean | null;
        scopeRef?: string | null;
      };
    },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, input.appRef);
    const budgets = triggerBudgetPatch(input);
    assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
    const agentId = await resolveInstalledAgent(ctx, app.id, input.agentRef);
    const scopeId = input.scopeRef?.trim() ? await resolveScopeForTrigger(ctx, app.id, input.scopeRef) : null;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name)) {
      throw new GraphQLError('Webhook name must be lowercase alphanumeric/dash, 1-64 chars.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (input.policy != null && parsePolicyLink(input.policy) == null) {
      throw new GraphQLError('policy must be { allow: string[] }.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    const webhook = await withAuthorizedTx(
      ctx,
      [{ kind: 'org', id: app.organizationId }, { kind: 'app', id: app.id },
        ...(agentId ? [{ kind: 'agent' as const, id: agentId }] : [])],
      async (txCtx) => {
        const currentApp = await requireScheduleAdmin(txCtx, input.appRef);
        if (currentApp.id !== app.id || currentApp.organizationId !== app.organizationId) {
          throw new Error('App scope changed; retry webhook creation');
        }
        if (agentId) await resolveInstalledAgent(txCtx, app.id, input.agentRef);
        if (input.scopeRef?.trim()) await resolveScopeForTrigger(txCtx, app.id, input.scopeRef);
      },
      async (tx) => {
        // #2438: stamp the entry's stable id from the setup pin's own
        // resolution (same as createAgentSchedule); null on the unadopted
        // marker — that row keeps the URN path.
        const consent = await captureSetupConsent(tx as never, app.id, resolveRunAsSelf(ctx, input.runAsSelf), input.entryNodeUrn, app.organizationId, ctx, configSelection({ ...input, agentId }));
        return tx.agentWebhook.create({
        data: {
        id: generateId(),
        organizationId: app.organizationId,
        appId: app.id,
        agentId,
        userId: resolveRunAsSelf(ctx, input.runAsSelf),
        scopeId,
        name: input.name,
        secret: generateWebhookSecret(),
        argsSchema: (input.argsSchema ?? undefined) as never,
        automationPin: consent as never,
        entryNodeUrn: input.entryNodeUrn,
        entryNodeId: consent != null && typeof consent === 'object' && 'entryId' in consent
          ? (consent as { entryId: string }).entryId : null,
        ...budgets,
        eventData: (input.eventData ?? undefined) as never,
        policy: (input.policy ?? undefined) as never,
        aiConfigName: input.aiConfigName ?? null,
        enabled: input.enabled ?? true,
        createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });
      },
      { afterLock: async (tx) => {
        await tx.$queryRaw`SELECT id FROM apps WHERE id = ${app.id} FOR SHARE`;
      } },
    );
    const token = await mintWebhookPlatformToken(webhook.id);
    return { webhook, path: `/hooks/${webhook.secret}/${webhook.name}`, token };
  },

  /** Rotate credentials; a stored run-as identity additionally requires its strict owner (#1643). */
  rotateAgentWebhook: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const existing = await ctx.db.agentWebhook.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new GraphQLError('Webhook not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, existing.organizationId, 'ADMIN');
    requireStoredRunOwner(ctx, existing.userId);
    const webhook = await withAuthorizedTx(
      ctx,
      [{ kind: 'org', id: existing.organizationId }, { kind: 'app', id: existing.appId }],
      async (txCtx) => {
        await requireOrgRole(txCtx, existing.organizationId, 'ADMIN');
        const current = await txCtx.db.agentWebhook.findFirst({ where: { id, deletedAt: null } });
        if (!current || current.appId !== existing.appId || current.organizationId !== existing.organizationId) {
          throw new GraphQLError('Webhook not found.', { extensions: { code: 'NOT_FOUND' } });
        }
        requireStoredRunOwner(txCtx, current.userId);
        await requireRunIdentityRelationship(txCtx, current.appId, current.userId);
      },
      (tx) => tx.agentWebhook.update({
        where: { id },
        data: { secret: generateWebhookSecret(), updatedBy: ctx.userId ?? ctx.clientId ?? null },
      }),
      { afterLock: async (tx) => {
        await tx.$queryRaw`SELECT id FROM agent_webhooks WHERE id = ${id} FOR UPDATE`;
      } },
    );
    const token = await mintWebhookPlatformToken(webhook.id);
    return { webhook, path: `/hooks/${webhook.secret}/${webhook.name}`, token };
  },

  deleteAgentWebhook: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const existing = await ctx.db.agentWebhook.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new GraphQLError('Webhook not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, existing.organizationId, 'ADMIN');
    await withAuthorizedTx(
      ctx,
      [{ kind: 'org', id: existing.organizationId }, { kind: 'app', id: existing.appId }],
      async (txCtx) => {
        await requireOrgRole(txCtx, existing.organizationId, 'ADMIN');
      },
      (tx) => tx.agentWebhook.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null, enabled: false },
      }),
      { lockMode: 'exclusive', afterLock: async (tx) => {
        await tx.$queryRaw`SELECT id FROM agent_webhooks WHERE id = ${id} FOR UPDATE`;
      } },
    );
    return true;
  },

  /**
   * Mint comm.outbound tickets into the org ledger (cor:acl:050:04 tier 2).
   * Org-ADMIN only; `note` keeps the ledger legible ("where did they go?").
   */
  mintActionTickets: async (
    _: unknown,
    {
      input,
    }: {
      input: { orgRef: string; appRef?: string | null; action: string; count: number; note?: string | null; expiresAt?: string | null };
    },
    ctx: Context,
  ) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, input.orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');
    // appRef must name an app IN this org — cross-org tickets would be
    // unconsumable dead rows (consumeActionTicket queries by org+app) and
    // an org-ADMIN must not mint against foreign apps (PR-502 review,
    // Gemini high + Copilot). ''≡absent per the platform convention.
    let appId: string | null = null;
    if (input.appRef && input.appRef.trim() !== '') {
      const { id } = await resolveAppRef(ctx.db, input.appRef);
      const app = await ctx.db.app.findFirst({
        where: { id, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!app) {
        // Denied ≡ not-found (non-disclosure posture, cor:api:120:01).
        throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      }
      appId = app.id;
    }
    if (input.action !== 'comm.outbound') {
      throw new GraphQLError('v1 tickets exist for the comm.outbound action class only (cor:acl:050:04).', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    const count = Math.min(Math.max(input.count, 1), 1000);
    const mintedBy = ctx.userId ?? ctx.clientId ?? 'unknown';
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new GraphQLError(`Invalid expiresAt "${input.expiresAt}" — use an ISO-8601 date.`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
    }
    await ctx.db.actionTicket.createMany({
      data: Array.from({ length: count }, () => ({
        id: generateId(),
        organizationId,
        appId,
        action: input.action,
        mintedBy,
        note: input.note ?? null,
        expiresAt,
      })),
    });
    return count;
  },

  /**
   * Set the STORED (enforced) quota limit for a scope × action (#510) —
   * the operator dial that previously required psql. Org-ADMIN; an app
   * scope must belong to the org (same posture as mintActionTickets).
   */
  setQuotaLimit: async (
    _: unknown,
    {
      input,
    }: {
      input: { orgRef: string; appRef?: string | null; action: string; limit: number };
    },
    ctx: Context,
  ) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, input.orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');
    if (
      input.action !== 'run.execute' &&
      input.action !== 'llm.tokens' &&
      input.action !== 'sms.send' &&
      input.action !== 'email.send'
    ) {
      throw new GraphQLError('action must be run.execute, llm.tokens, sms.send, or email.send.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    // Cap at int32 — the column is a 4-byte Int; beyond it Postgres would
    // overflow into a raw 500 (PR-512 review).
    if (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > 2_147_483_647) {
      throw new GraphQLError('limit must be a non-negative 32-bit integer (0 = pause the scope).', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    let scopeKind: 'app' | 'org' = 'org';
    let scopeId = organizationId;
    if (input.appRef && input.appRef.trim() !== '') {
      const { id } = await resolveAppRef(ctx.db, input.appRef);
      const app = await ctx.db.app.findFirst({
        where: { id, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!app) throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      scopeKind = 'app';
      scopeId = app.id;
    }
    await setQuotaLimitKernel(ctx.db, scopeKind, scopeId, input.action, input.limit);
    return ctx.db.quotaCounter.findFirstOrThrow({
      where: { scopeKind, scopeId, action: input.action, window: 'day' },
    });
  },

  /**
   * Author the caller's OWN user-layer policy link (cor:acl:040:02, #510):
   * constrains every future run made on-behalf-of this user. Pass null to
   * remove the link (= no restriction). Self-service by design — a user's
   * link belongs to the user, not to an org admin.
   */
  updateMyPolicy: async (_: unknown, { policy }: { policy?: unknown }, ctx: Context) => {
    if (!ctx.userId) {
      throw new GraphQLError('updateMyPolicy requires an authenticated user.', {
        extensions: { code: 'UNAUTHENTICATED' },
      });
    }
    if (policy != null && parsePolicyLink(policy) == null) {
      throw new GraphQLError('policy must be { allow: string[] } or null.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return ctx.db.user.update({
      where: { id: ctx.userId },
      data: { policy: (policy ?? null) as never },
    });
  },
};

export const appRunQueries = {
  /** Paginated schedules for an App (org-ADMIN; cor:api:120 envelope). */
  agentSchedules: async (
    _: unknown,
    { appRef, limit, offset }: { appRef: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, appRef);
    const where = { appId: app.id, deletedAt: null };
    const take = Math.min(Math.max(limit ?? 20, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.agentSchedule.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(0, offset ?? 0) }),
      ctx.db.agentSchedule.count({ where }),
    ]);
    return { items, total };
  },

  /** The audit surface: what ran, why, what it cost (cor:agt:010:02). */
  appRuns: async (
    _: unknown,
    {
      appRef,
      orgRef,
      status,
      statuses,
      parentRunId,
      sortBy,
      sortDir,
      limit,
      offset,
    }: {
      appRef?: string | null;
      orgRef?: string | null;
      /** @deprecated #836 — superseded by `statuses`; still accepted for one release. */
      status?: string | null;
      statuses?: string[] | null;
      parentRunId?: string | null;
      sortBy?: AppRunSortField | null;
      sortDir?: 'asc' | 'desc' | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    let organizationId = ctx.organizationId ?? null;
    let appId: string | null = null;
    if (orgRef) ({ id: organizationId } = await resolveOrgRef(ctx.db, orgRef));
    if (appRef) {
      // ref dispatch (was raw-PK-only — the refactor also makes URNs work here)
      ({ id: appId } = await resolveAppRef(ctx.db, appRef));
      const app = await ctx.db.app.findFirst({
        // When orgRef was ALSO given, scope the app to that org — a mismatch
        // is NOT_FOUND rather than orgRef being silently overridden by the
        // app's org (PR-502 review; non-disclosure posture preserved).
        where: { id: appId, deletedAt: null, ...(orgRef ? { organizationId: organizationId as string } : {}) },
      });
      if (!app) throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      organizationId = app.organizationId;
    }
    if (!organizationId) {
      throw new GraphQLError('Provide appRef or orgRef.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    if (!isPlatformAdmin(ctx)) {
      try {
        await requireOrgRole(ctx, organizationId, 'READER');
      } catch {
        // Denied ≡ not-found (no existence oracle for foreign apps/orgs —
        // PR-493 review; cor:api:120:01 non-disclosure posture).
        throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      }
    }
    const where = {
      organizationId,
      ...(appId ? { appId } : {}),
      ...buildStatusFilter(status, statuses),
      // Fan-out children of one parent (#548; index from PR-547). Rides the
      // same org/app authorization — the org scope already applies above.
      // Explicit null = top-level runs only; omitted = no filter (PR-550
      // review, Gemini).
      ...(parentRunId !== undefined ? { parentRunId } : {}),
    };
    const take = Math.min(Math.max(limit ?? 20, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.appRun.findMany({
        where,
        orderBy: buildAppRunOrderBy(sortBy, sortDir),
        take,
        skip: Math.max(0, offset ?? 0),
      }),
      ctx.db.appRun.count({ where }),
    ]);
    return { items, total };
  },

  agentWebhooks: async (
    _: unknown,
    { appRef, limit, offset }: { appRef: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, appRef);
    const where = { appId: app.id, deletedAt: null };
    const take = Math.min(Math.max(limit ?? 20, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.agentWebhook.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(0, offset ?? 0) }),
      ctx.db.agentWebhook.count({ where }),
    ]);
    // The secret is intentionally NOT part of the GraphQL type (leak surface);
    // the URL is only shown at create/rotate time.
    return { items, total };
  },

  /** The ticket ledger (cor:acl:050:04): where did they all go? */
  actionTickets: async (
    _: unknown,
    { orgRef, limit, offset }: { orgRef: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');
    const where = { organizationId };
    const take = Math.min(Math.max(limit ?? 20, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.actionTicket.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(0, offset ?? 0) }),
      ctx.db.actionTicket.count({ where }),
    ]);
    return { items, total };
  },

  appRun: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    // #696: ref is an AppRun ID or an hrn:apprun:<root>:<app>:<run-id> URN. A
    // bare cuid/UUIDv7 goes direct; a URN decomposes via resolveAppRunRef.
    let id: string;
    if (isId(ref)) {
      id = ref;
    } else {
      try {
        ({ id } = await resolveAppRunRef(ctx.db, ref));
      } catch (err) {
        if (err instanceof AppRunNotFoundError) return null;
        throw err;
      }
    }
    const run = await ctx.db.appRun.findUnique({ where: { id } });
    if (!run) return null;
    // #1577 — an unreadable run reads as MISSING, never Forbidden: the
    // difference was an existence oracle over run ids. The platform's
    // concealment posture (#1316, #1381; Ada #5919) and what MCP
    // hadron_get_run already does. Only an authorization denial is concealed;
    // any other error still surfaces.
    return (await canReadAppRun(ctx, run)) ? run : null;
  },

  /**
   * The "latest run" query (#696) — resolves the most recent run of an App to a
   * CONCRETE run (whose `.urn` is a concrete apprun URN). "current/latest/
   * previous" are queries, never magic run-ids in URN space (cor:urn:010:02).
   * `previous: true` returns the run before the latest (the second-most-recent).
   */
  latestAppRun: async (
    _: unknown,
    { appRef, previous }: { appRef: string; previous?: boolean | null },
    ctx: Context,
  ) => {
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null } });
    if (!app) throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
    if (!isPlatformAdmin(ctx)) {
      try {
        // Owner-or-org READER — App may be org-owned or user-owned (spec 047).
        await requireOwnerOrOrgRole(ctx, app, 'READER');
      } catch {
        // Denied ≡ not-found (no existence oracle for foreign apps).
        throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      }
    }
    const [run] = await ctx.db.appRun.findMany({
      where: { appId },
      orderBy: { createdAt: 'desc' },
      skip: previous ? 1 : 0,
      take: 1,
    });
    return run ?? null;
  },

  /**
   * Usage-vs-limit for a scope (#510): the org's counters, plus one app's
   * when appRef is given. Rows are materialized on first view (seeded with
   * the platform defaults) so the admin surface never shows a blank —
   * ensureQuotaRowsForScope also rolls expired windows.
   */
  quotaCounters: async (
    _: unknown,
    { orgRef, appRef }: { orgRef: string; appRef?: string | null },
    ctx: Context,
  ) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');
    const scopes: Array<{ scopeKind: 'app' | 'org'; scopeId: string }> = [
      { scopeKind: 'org', scopeId: organizationId },
    ];
    if (appRef && appRef.trim() !== '') {
      const { id } = await resolveAppRef(ctx.db, appRef);
      const app = await ctx.db.app.findFirst({
        where: { id, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!app) throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      scopes.push({ scopeKind: 'app', scopeId: app.id });
    }
    await Promise.all(scopes.map((s) => ensureQuotaRowsForScope(ctx.db, s.scopeKind, s.scopeId)));
    return ctx.db.quotaCounter.findMany({
      where: { OR: scopes.map((s) => ({ scopeKind: s.scopeKind, scopeId: s.scopeId })) },
      orderBy: [{ scopeKind: 'asc' }, { action: 'asc' }],
    });
  },

  /**
   * The policy debug surface (#510): explain the STANDING chain — org ∧
   * user (optional) ∧ app — for one action, with per-layer verdicts. This
   * answers "would a run of this app (as this user) be allowed to X, and
   * which link says no". Trigger/run links are per-trigger and therefore
   * not part of the standing chain; the run detail shows the snapshot that
   * actually applied.
   */
  effectiveActionPolicy: async (
    _: unknown,
    { appRef, action, userRef }: { appRef: string; action: string; userRef?: string | null },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, appRef);
    const [org, appRow] = await Promise.all([
      ctx.db.organization.findUniqueOrThrow({
        where: { id: app.organizationId },
        select: { policy: true },
      }),
      ctx.db.app.findUniqueOrThrow({ where: { id: app.id }, select: { policy: true } }),
    ]);
    const layers: Array<{ layer: string; link: ReturnType<typeof parsePolicyLink> }> = [
      { layer: 'org', link: parsePolicyLink(org.policy) },
    ];
    if (userRef && userRef.trim() !== '') {
      const { id: userId } = await resolveUserRef(ctx.db, userRef);
      const user = await ctx.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { policy: true },
      });
      layers.push({ layer: 'user', link: parsePolicyLink(user.policy) });
    }
    layers.push({ layer: 'app', link: parsePolicyLink(appRow.policy) });
    return explainPolicyChain(action as PolicyAction, layers);
  },
};
