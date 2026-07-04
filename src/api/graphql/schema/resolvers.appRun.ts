// Headless-run surfaces (spec 040 plan §9): schedule CRUD, the run audit
// read surface (cor:api:120-shaped), manual trigger, and the kill switch.

import { GraphQLError } from 'graphql';
import { generateId } from '../../../lib/id.js';
import { mintAppRun, RunLaunchDeniedError } from '../../../jobs/appRuns.js';
import { mintWebhookPlatformToken, generateWebhookSecret } from '../../webhooks.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { nextCronOccurrence } from '../../../jobs/scheduler.js';
import { parsePolicyLink } from '../../../lib/policy/index.js';
import { assertFullyQualifiedUrn } from '../../../lib/urn.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { type Context, requireOrgRole, isPlatformAdmin } from './resolvers.helpers.js';

export interface CreateAgentScheduleInput {
  appId: string;
  name: string;
  cron: string;
  timezone?: string | null;
  entryNodeUrn: string;
  agentId?: string | null;
  /** On-behalf-of user (cor:agt:010:01). v1: only the caller themself. */
  runAsSelf?: boolean | null;
  eventData?: Record<string, unknown> | null;
  policy?: unknown;
  aiConfigName?: string | null;
  enabled?: boolean | null;
}

/** Resolve the App (ID or URN), require it live, and require org-ADMIN on its org. */
async function requireScheduleAdmin(ctx: Context, appId: string) {
  const { id } = await resolveAppRef(ctx.db, appId);
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

/** agentId must be installed in the App — a foreign agent would leak its AI config into the walk (PR-493, Codex P1). */
async function assertAgentInstalled(ctx: Context, appId: string, agentId: string | null | undefined) {
  if (!agentId) return;
  const installed = await ctx.db.appAgent.findFirst({
    where: { appId, agentId },
    select: { agentId: true },
  });
  if (!installed) {
    throw new GraphQLError('agentId is not installed in this App.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

export const appRunMutations = {
  /** Create a recurring trigger (org-ADMIN). nextRunAt is seeded from the validated cron. */
  createAgentSchedule: async (
    _: unknown,
    { input }: { input: CreateAgentScheduleInput },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, input.appId);
    assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
    await assertAgentInstalled(ctx, app.id, input.agentId);
    const timezone = input.timezone?.trim() || 'UTC';
    const nextRunAt = validatedCronNext(input.cron, timezone);
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
        agentId: input.agentId ?? null,
        // v1: a schedule runs on behalf of its CREATOR or nobody — never a
        // third party (delegating another user's authority needs the rule
        // language; cor:agt:010:01 tunable).
        userId: resolveRunAsSelf(ctx, input.runAsSelf),
        name: input.name,
        cron: input.cron,
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
    const cron = input.cron ?? existing.cron;
    const timezone = input.timezone?.trim() || existing.timezone;
    const nextRunAt =
      input.cron != null || input.timezone != null
        ? validatedCronNext(cron, timezone)
        : undefined;
    if (input.entryNodeUrn != null) assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
    if (input.agentId !== undefined) await assertAgentInstalled(ctx, existing.appId, input.agentId);
    if (input.policy != null && parsePolicyLink(input.policy) == null) {
      throw new GraphQLError('policy must be { allow: string[] }.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return ctx.db.agentSchedule.update({
      where: { id },
      data: {
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.cron != null ? { cron: input.cron } : {}),
        ...(input.timezone != null ? { timezone } : {}),
        ...(input.entryNodeUrn != null ? { entryNodeUrn: input.entryNodeUrn } : {}),
        ...(input.eventData !== undefined ? { eventData: input.eventData as never } : {}),
        ...(input.policy !== undefined ? { policy: input.policy as never } : {}),
        ...(input.aiConfigName !== undefined ? { aiConfigName: input.aiConfigName } : {}),
        ...(input.enabled != null ? { enabled: input.enabled } : {}),
        ...(input.runAsSelf != null ? { userId: resolveRunAsSelf(ctx, input.runAsSelf) } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
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
        appId: string;
        entryNodeUrn: string;
        eventData?: Record<string, unknown> | null;
        runAsSelf?: boolean | null;
        aiConfigName?: string | null;
      };
    },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, input.appId);
    assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
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
  },

  /** The kill switch's manual handle (cor:agt:010:02). */
  cancelAppRun: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const run = await ctx.db.appRun.findUnique({ where: { id } });
    if (!run) throw new GraphQLError('Run not found.', { extensions: { code: 'NOT_FOUND' } });
    await requireOrgRole(ctx, run.organizationId, 'ADMIN');
    await ctx.db.appRun.updateMany({
      where: { id, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date(), failure: { code: 'CANCELLED' } },
    });
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
        appId: string;
        name: string;
        entryNodeUrn: string;
        agentId?: string | null;
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
    const app = await requireScheduleAdmin(ctx, input.appId);
    assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
    await assertAgentInstalled(ctx, app.id, input.agentId);
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
        agentId: input.agentId ?? null,
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
      input: { orgId: string; appId?: string | null; action: string; count: number; note?: string | null; expiresAt?: string | null };
    },
    ctx: Context,
  ) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, input.orgId);
    await requireOrgRole(ctx, organizationId, 'ADMIN');
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
        appId: input.appId ?? null,
        action: input.action,
        mintedBy,
        note: input.note ?? null,
        expiresAt,
      })),
    });
    return count;
  },
};

export const appRunQueries = {
  /** Paginated schedules for an App (org-ADMIN; cor:api:120 envelope). */
  agentSchedules: async (
    _: unknown,
    { appId, limit, offset }: { appId: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, appId);
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
      appId,
      orgId,
      status,
      limit,
      offset,
    }: {
      appId?: string | null;
      orgId?: string | null;
      status?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    let organizationId = orgId ?? ctx.organizationId ?? null;
    if (appId) {
      const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null } });
      if (!app) throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      organizationId = app.organizationId;
    }
    if (!organizationId) {
      throw new GraphQLError('Provide appId or orgId.', { extensions: { code: 'BAD_USER_INPUT' } });
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
    { appId, limit, offset }: { appId: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, appId);
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
    { orgId, limit, offset }: { orgId: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, orgId);
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
};
