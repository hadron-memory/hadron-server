// Headless-run surfaces (spec 040 plan §9): schedule CRUD, the run audit
// read surface (cor:api:120-shaped), manual trigger, and the kill switch.

import { GraphQLError } from 'graphql';
import { generateId } from '../../../lib/id.js';
import { mintAppRun, RunLaunchDeniedError } from '../../../jobs/appRuns.js';
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

function validatedCronNext(cron: string, timezone: string): Date {
  try {
    return nextCronOccurrence(cron, timezone);
  } catch {
    throw new GraphQLError(`Invalid cron expression "${cron}".`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

export const appRunMutations = {
  createAgentSchedule: async (
    _: unknown,
    { input }: { input: CreateAgentScheduleInput },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, input.appId);
    assertFullyQualifiedUrn(input.entryNodeUrn, 'node');
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
        userId: input.runAsSelf ? (ctx.userId ?? null) : null,
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
        ...(input.runAsSelf != null
          ? { userId: input.runAsSelf ? (ctx.userId ?? null) : null }
          : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        updatedBy: ctx.userId ?? ctx.clientId ?? null,
      },
    });
  },

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
        userId: input.runAsSelf ? (ctx.userId ?? null) : null,
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
};

export const appRunQueries = {
  agentSchedules: async (
    _: unknown,
    { appId, limit, offset }: { appId: string; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const app = await requireScheduleAdmin(ctx, appId);
    const where = { appId: app.id, deletedAt: null };
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.agentSchedule.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: offset ?? 0 }),
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
    if (!isPlatformAdmin(ctx)) await requireOrgRole(ctx, organizationId, 'READER');
    const where = {
      organizationId,
      ...(appId ? { appId } : {}),
      ...(status ? { status: status as never } : {}),
    };
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
    const [items, total] = await Promise.all([
      ctx.db.appRun.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: offset ?? 0 }),
      ctx.db.appRun.count({ where }),
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
