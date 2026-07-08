// Headless-run surfaces (spec 040 plan §9): schedule CRUD, the run audit
// read surface (cor:api:120-shaped), manual trigger, and the kill switch.

import { GraphQLError } from 'graphql';
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
import { parsePolicyLink, explainPolicyChain, type PolicyAction } from '../../../lib/policy/index.js';
import {
  assertFullyQualifiedUrn,
  splitNodeUrn,
  normalizeUrnForLookup,
  legacyMemoryUrnToCanonical,
} from '../../../lib/urn.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { type Context, requireOrgRole, isPlatformAdmin } from './resolvers.helpers.js';

export interface CreateAgentScheduleInput {
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
  enabled?: boolean | null;
}

/** Resolve the App ref (PK or URN), require it live, and require org-ADMIN on its org. */
async function requireScheduleAdmin(ctx: Context, appRef: string) {
  const { id } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, organizationId: true },
  });
  if (!app) {
    throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
  }
  await requireOrgRole(ctx, app.organizationId, 'ADMIN');
  return app;
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
    select: { id: true, organizationId: true },
  });
  if (!app) {
    throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
  }
  // Platform admin, or the App triggering under its own key.
  if (isPlatformAdmin(ctx) || ctx.appId === app.id) return app;
  // A user with a live relationship to the App: AppMember, or an active
  // subscriber to one of its agents (mirrors mintAppRun's on-behalf-of check).
  if (ctx.userId) {
    const member = await ctx.db.appMember.findFirst({
      where: { appId: app.id, userId: ctx.userId },
      select: { userId: true },
    });
    if (member) return app;
    const sub = await ctx.db.agentSubscription.findFirst({
      where: {
        userId: ctx.userId,
        revokedAt: null,
        agent: { appAgents: { some: { appId: app.id } } },
      },
      select: { userId: true },
    });
    if (sub) return app;
  }
  // Otherwise fall back to the org-ADMIN gate: admits org admins who aren't
  // AppMembers, and yields the standard typed Forbidden for callers with no
  // relationship at all.
  await requireOrgRole(ctx, app.organizationId, 'ADMIN');
  return app;
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
  input: { appRef: string; entryNodeUrn: string; runAsSelf?: boolean | null },
): Promise<{ id: string; organizationId: string }> {
  const app = await requireManualRunAccess(ctx, input.appRef);
  assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
  // runAsSelf REQUIRES an authenticated user — surface it here (pre-write) too.
  resolveRunAsSelf(ctx, input.runAsSelf);
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
  return app;
}

/**
 * Mint a MANUAL AppRun for an entry (task) node under an App — the shared
 * execute path behind the `triggerAppRun` mutation, `runTask(appRef:)` (#529),
 * and `importNode(taskRef:)` (#528). Authorized by the interactive gate (#530).
 * Maps a launch denial to a typed GraphQLError.
 */
export async function triggerManualRun(
  ctx: Context,
  input: {
    appRef: string;
    entryNodeUrn: string;
    eventData?: Record<string, unknown> | null;
    runAsSelf?: boolean | null;
    aiConfigName?: string | null;
  },
) {
  const app = await assertManualRunAllowed(ctx, input);
  try {
    return await mintAppRun(ctx.db, {
      organizationId: app.organizationId,
      appId: app.id,
      userId: resolveRunAsSelf(ctx, input.runAsSelf),
      triggerKind: 'MANUAL',
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
  const { id: agentId } = await resolveAgentRef(ctx.db, agentRef);
  const installed = await ctx.db.appAgent.findFirst({
    where: { appId, agentId },
    select: { agentId: true },
  });
  if (!installed) {
    throw new GraphQLError('agentRef does not name an agent installed in this App.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
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
    return ctx.db.agentSchedule.create({
      data: {
        id: generateId(),
        organizationId: app.organizationId,
        appId: app.id,
        agentId,
        // v1: a schedule runs on behalf of its CREATOR or nobody — never a
        // third party (delegating another user's authority needs the rule
        // language; cor:agt:010:01 tunable).
        userId: resolveRunAsSelf(ctx, input.runAsSelf),
        name: input.name,
        cron: input.cron ?? null,
        runAt: input.runAt != null ? validatedRunAt(input.runAt) : null,
        timezone,
        entryNodeUrn: input.entryNodeUrn,
        eventData: (input.eventData ?? undefined) as never,
        policy: (input.policy ?? undefined) as never,
        aiConfigName: input.aiConfigName ?? null,
        enabled: input.enabled ?? true,
        nextRunAt,
        createdBy: ctx.userId ?? ctx.clientId ?? null,
      },
    });
  },

  /** Partial update (org-ADMIN); a cron/timezone change recomputes nextRunAt. */
  updateAgentSchedule: async (
    _: unknown,
    { id, input }: { id: string; input: Partial<CreateAgentScheduleInput> },
    ctx: Context,
  ) => {
    const existing = await ctx.db.agentSchedule.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new GraphQLError('Schedule not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, existing.organizationId, 'ADMIN');
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
        ? await resolveInstalledAgent(ctx, existing.appId, input.agentRef)
        : undefined;
    if (input.policy != null && parsePolicyLink(input.policy) == null) {
      throw new GraphQLError('policy must be { allow: string[] }.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return ctx.db.agentSchedule.update({
      where: { id },
      data: {
        ...(input.name != null ? { name: input.name } : {}),
        ...modeFields,
        ...(input.timezone != null ? { timezone } : {}),
        ...(input.entryNodeUrn != null ? { entryNodeUrn: input.entryNodeUrn } : {}),
        ...(input.eventData !== undefined ? { eventData: input.eventData as never } : {}),
        ...(input.policy !== undefined ? { policy: input.policy as never } : {}),
        ...(input.aiConfigName !== undefined ? { aiConfigName: input.aiConfigName } : {}),
        ...(input.enabled != null ? { enabled: input.enabled } : {}),
        ...(input.runAsSelf != null ? { userId: resolveRunAsSelf(ctx, input.runAsSelf) } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        updatedBy: ctx.userId ?? ctx.clientId ?? null,
      },
    });
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
        entryNodeUrn: string;
        eventData?: Record<string, unknown> | null;
        runAsSelf?: boolean | null;
        aiConfigName?: string | null;
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
        enabled?: boolean | null;
      };
    },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, input.appRef);
    assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
    const agentId = await resolveInstalledAgent(ctx, app.id, input.agentRef);
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
    const webhook = await ctx.db.agentWebhook.create({
      data: {
        id: generateId(),
        organizationId: app.organizationId,
        appId: app.id,
        agentId,
        userId: resolveRunAsSelf(ctx, input.runAsSelf),
        name: input.name,
        secret: generateWebhookSecret(),
        argsSchema: (input.argsSchema ?? undefined) as never,
        entryNodeUrn: input.entryNodeUrn,
        eventData: (input.eventData ?? undefined) as never,
        policy: (input.policy ?? undefined) as never,
        aiConfigName: input.aiConfigName ?? null,
        enabled: input.enabled ?? true,
        createdBy: ctx.userId ?? ctx.clientId ?? null,
      },
    });
    const token = await mintWebhookPlatformToken(webhook.id);
    return { webhook, path: `/hooks/${webhook.secret}/${webhook.name}`, token };
  },

  /** New secret + new platform token; the old URL/token die immediately. */
  rotateAgentWebhook: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const existing = await ctx.db.agentWebhook.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new GraphQLError('Webhook not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, existing.organizationId, 'ADMIN');
    const webhook = await ctx.db.agentWebhook.update({
      where: { id },
      data: { secret: generateWebhookSecret(), updatedBy: ctx.userId ?? ctx.clientId ?? null },
    });
    const token = await mintWebhookPlatformToken(webhook.id);
    return { webhook, path: `/hooks/${webhook.secret}/${webhook.name}`, token };
  },

  deleteAgentWebhook: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const existing = await ctx.db.agentWebhook.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new GraphQLError('Webhook not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, existing.organizationId, 'ADMIN');
    await ctx.db.agentWebhook.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null, enabled: false },
    });
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
    if (input.action !== 'run.execute' && input.action !== 'llm.tokens') {
      throw new GraphQLError('action must be run.execute or llm.tokens.', {
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
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
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
      parentRunId,
      limit,
      offset,
    }: {
      appRef?: string | null;
      orgRef?: string | null;
      status?: string | null;
      parentRunId?: string | null;
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
      ...(status ? { status: status as never } : {}),
      // Fan-out children of one parent (#548; index from PR-547). Rides the
      // same org/app authorization — the org scope already applies above.
      // Explicit null = top-level runs only; omitted = no filter (PR-550
      // review, Gemini).
      ...(parentRunId !== undefined ? { parentRunId } : {}),
    };
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.appRun.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(0, offset ?? 0) }),
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
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
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
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.actionTicket.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(0, offset ?? 0) }),
      ctx.db.actionTicket.count({ where }),
    ]);
    return { items, total };
  },

  appRun: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    // Runs are URN-less (like AiServiceConfig) — ref is the ID only.
    const run = await ctx.db.appRun.findUnique({ where: { id: ref } });
    if (!run) return null;
    if (!isPlatformAdmin(ctx)) await requireOrgRole(ctx, run.organizationId, 'READER');
    return run;
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
