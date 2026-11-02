/**
 * #2883 (ruling 0081 = A, cor:agt:010:01): give, revoke and list an automation's READ grant. The enforcement side is
 * `runHoldsReadGrant` in `src/lib/automationReadGrant.ts`, answered by the run `hadron_read_node` read; this file is
 * only the doors that make and end the rows.
 *
 * Who may do what:
 *  - GIVE: a person acting as themselves (no worker session, run principal, impersonation or App key) who MANAGES the
 *    target: the Agent for an Agent's system memory ({@link managesAgent}), the memory's manager for any other class
 *    ({@link requireMemoryManageAccess}). The trigger must be a live schedule or webhook of the named App, and the
 *    target must pass {@link readGrantTargetRefusal} (an installed Agent's system memory; never personal/private,
 *    encrypted, install, Worker, session or another App's team space; others only within the App tenant's reach).
 *    Giving needs no App-manager role: the memory's manager decides what of theirs an automation may read.
 *  - REVOKE: the App's managers, or the target's manager.
 *  - LIST: the App's managers see the App's grants; a target's manager sees the grants on what they manage; nobody else.
 *
 * Every refusal on give and revoke is the one `Forbidden`, and an unknown App, trigger, memory or grant is the same
 * answer. A person who may not see a grant is told nothing about whether it exists (list filters per row).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { managesAgent, managesApp } from '../../../lib/auth/appManagement.js';
import { requirePersonAsThemselves } from '../../../lib/auth/personAsThemselves.js';
import { READ_GRANT_MEMORY_SELECT, readGrantTargetRefusal, type ReadGrantTriggerKind } from '../../../lib/automationReadGrant.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { validateLoc, InvalidLocError } from '../../../lib/validateLoc.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { requireMemoryManageAccess, safeCanonicalUrn, type Context } from './resolvers.helpers.js';

const denied = () => authorizationDenied();
const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

type GrantRow = NonNullable<Awaited<ReturnType<Context['db']['appAutomationReadGrant']['findFirst']>>>;
type AppRow = { id: string; organizationId: string | null; ownerUserId: string | null };
type TargetRow = Prisma.MemoryGetPayload<{ select: typeof READ_GRANT_MEMORY_SELECT }> & { urn: string };

const TARGET_SELECT = { ...READ_GRANT_MEMORY_SELECT, urn: true } as const;
const APP_SELECT = { id: true, organizationId: true, ownerUserId: true } as const;

function parseKind(raw: string): ReadGrantTriggerKind {
  if (raw === 'SCHEDULE' || raw === 'WEBHOOK') return raw;
  throw badInput('triggerKind must be SCHEDULE or WEBHOOK.');
}

/** The prefix is optional: absent or blank is the whole memory; otherwise a loc. Validated before any lookup. */
function parsePrefix(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return null;
  const prefix = raw.trim();
  try { validateLoc(prefix); } catch (e) {
    if (e instanceof InvalidLocError) throw badInput(`prefix is not a valid loc: ${e.message}`);
    throw e;
  }
  return prefix;
}

async function resolveOrDeny<T>(lookup: () => Promise<T>): Promise<T> {
  try { return await lookup(); } catch (e) {
    if (e instanceof GraphQLError) throw e;
    // Every unknown or unparseable ref is the one Forbidden (the lookups throw typed *_NOT_FOUND errors, not GraphQL ones).
    if (e instanceof Error && /not[ _]found|not fully qualified|URN/i.test(`${(e as { code?: string }).code ?? ''} ${e.message}`)) throw denied();
    throw e;
  }
}

/** The trigger is a live row of this App. */
async function triggerIsLive(db: Pick<Context['db'], 'agentSchedule' | 'agentWebhook'>, appId: string, kind: ReadGrantTriggerKind, id: string): Promise<boolean> {
  const where = { id, appId, deletedAt: null };
  const row = kind === 'SCHEDULE'
    ? await db.agentSchedule.findFirst({ where, select: { id: true } })
    : await db.agentWebhook.findFirst({ where, select: { id: true } });
  return row !== null;
}

/**
 * Does the caller manage this target? An Agent's system memory: whoever manages an Agent whose definition it is
 * (the Agent-side twin of managesApp). Any other class: the memory's manager. Never throws a refusal: false.
 */
export async function managesReadGrantTarget(ctx: Context, memory: TargetRow): Promise<boolean> {
  if (memory.class === 'system') {
    const agents = await ctx.db.agent.findMany({
      where: { systemMemoryId: memory.id, deletedAt: null, organizationId: memory.organizationId, ownerUserId: memory.ownerUserId },
      select: { organizationId: true, ownerUserId: true },
    });
    for (const agent of agents) if (await managesAgent(ctx, agent)) return true;
    return false;
  }
  try { await requireMemoryManageAccess(ctx, memory); return true; } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') return false;
    throw e;
  }
}

function project(row: GrantRow, memory: { urn: string } | null, canSeeMemory: boolean) {
  return {
    id: row.id, appId: row.appId, triggerKind: row.triggerKind, triggerId: row.triggerId,
    memoryUrn: canSeeMemory && memory ? safeCanonicalUrn('memory', memory.urn) : null,
    prefix: row.prefix, grantedBy: row.grantedBy,
    createdAt: row.createdAt, revokedAt: row.revokedAt, revokedBy: row.revokedBy,
  };
}

const anchorsOf = (app: AppRow, memoryId?: string) => [
  { kind: 'app' as const, id: app.id },
  ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
  ...(memoryId ? [{ kind: 'memory' as const, id: memoryId }] : []),
];

export const automationReadGrantMutations = {
  setAutomationReadGrant: async (
    _: unknown,
    input: { appRef: string; triggerKind: string; triggerId: string; memoryRef: string; prefix?: string | null },
    ctx: Context,
  ) => {
    const triggerKind = parseKind(input.triggerKind);
    const prefix = parsePrefix(input.prefix);
    const actorId = await requirePersonAsThemselves(ctx, denied);
    const { id: appId } = await resolveOrDeny(() => resolveAppRef(ctx.db, input.appRef));
    const { id: memoryId } = await resolveOrDeny(() => resolveMemoryRef(ctx.db, input.memoryRef));
    const triggerId = input.triggerId;
    const app0 = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null, uninstalledAt: null }, select: APP_SELECT });
    if (!app0) throw denied();

    const run = () => withAuthorizedTx(
      ctx,
      anchorsOf(app0, memoryId),
      async (txCtx) => {
        // Re-decided on the transaction with the anchors held: everything is read as it is now.
        const app = await txCtx.db.app.findFirst({ where: { id: appId, deletedAt: null, uninstalledAt: null }, select: APP_SELECT });
        const memory = await txCtx.db.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: TARGET_SELECT });
        if (!app || !memory) throw denied();
        if (!(await triggerIsLive(txCtx.db, appId, triggerKind, triggerId))) throw denied();
        if ((await readGrantTargetRefusal(txCtx.db, app, memory)) !== null) throw denied();
        if (!(await managesReadGrantTarget(txCtx, memory))) throw denied();
      },
      async (tx) => {
        const live = await tx.appAutomationReadGrant.findFirst({ where: { appId, triggerKind, triggerId, memoryId, prefix, revokedAt: null } });
        if (live) return live;
        const row = await tx.appAutomationReadGrant.create({ data: { appId, triggerKind, triggerId, memoryId, prefix, grantedBy: actorId } });
        await tx.appAutomationReadGrantEvent.create({ data: { appId, triggerKind, triggerId, memoryId, grantId: row.id, prefix, action: 'GRANT', actorUserId: actorId } });
        return row;
      },
    );
    let row: GrantRow;
    try { row = await run(); } catch (e) {
      // A concurrent identical give won the one-live-row index: the same grant, so answer with it.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const live = await ctx.db.appAutomationReadGrant.findFirst({ where: { appId, triggerKind, triggerId, memoryId, prefix, revokedAt: null } });
      if (!live) throw e;
      row = live;
    }
    const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, select: { urn: true } });
    return project(row, memory, true);
  },

  revokeAutomationReadGrant: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const actorId = await requirePersonAsThemselves(ctx, denied);
    const existing = await ctx.db.appAutomationReadGrant.findUnique({ where: { id }, include: { app: { select: APP_SELECT } } });
    if (!existing) throw denied();
    const app0 = existing.app;
    await withAuthorizedTx(
      ctx,
      anchorsOf(app0, existing.memoryId),
      async (txCtx) => {
        const app = await txCtx.db.app.findUnique({ where: { id: app0.id }, select: APP_SELECT });
        if (!app) throw denied();
        if (await managesApp(txCtx, app)) return;
        const memory = await txCtx.db.memory.findFirst({ where: { id: existing.memoryId, deletedAt: null }, select: TARGET_SELECT });
        if (memory && (await managesReadGrantTarget(txCtx, memory))) return;
        throw denied();
      },
      async (tx) => {
        // Terminal: a second revoke matches nothing and records nothing.
        const ended = await tx.appAutomationReadGrant.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: actorId } });
        if (ended.count === 1) {
          await tx.appAutomationReadGrantEvent.create({
            data: { appId: existing.appId, triggerKind: existing.triggerKind, triggerId: existing.triggerId, memoryId: existing.memoryId, grantId: id, prefix: existing.prefix, action: 'REVOKE', actorUserId: actorId },
          });
        }
      },
    );
    const row = await ctx.db.appAutomationReadGrant.findUniqueOrThrow({ where: { id } });
    const memory = await ctx.db.memory.findUnique({ where: { id: row.memoryId }, select: { urn: true } });
    return project(row, memory, true);
  },
};

export const automationReadGrantQueries = {
  automationReadGrants: async (_: unknown, input: { appRef?: string | null; memoryRef?: string | null; includeRevoked?: boolean | null }, ctx: Context) => {
    await requirePersonAsThemselves(ctx, denied);
    if (!input.appRef && !input.memoryRef) throw badInput('appRef or memoryRef is required.');
    const appId = input.appRef ? (await resolveOrDeny(() => resolveAppRef(ctx.db, input.appRef!))).id : undefined;
    const memoryId = input.memoryRef ? (await resolveOrDeny(() => resolveMemoryRef(ctx.db, input.memoryRef!))).id : undefined;
    const rows = await ctx.db.appAutomationReadGrant.findMany({
      where: { ...(appId ? { appId } : {}), ...(memoryId ? { memoryId } : {}), ...(input.includeRevoked ? {} : { revokedAt: null }) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { app: { select: APP_SELECT } },
    });
    // A reader sees a row when they manage its App or manage its target; decided once per App and per memory.
    const appManaged = new Map<string, boolean>();
    const targetManaged = new Map<string, TargetRow | null>();
    const out: ReturnType<typeof project>[] = [];
    for (const row of rows) {
      let viaApp = appManaged.get(row.appId);
      if (viaApp === undefined) { viaApp = await managesApp(ctx, row.app); appManaged.set(row.appId, viaApp); }
      let target = targetManaged.get(row.memoryId);
      if (target === undefined) {
        const memory = await ctx.db.memory.findFirst({ where: { id: row.memoryId, deletedAt: null }, select: TARGET_SELECT });
        target = memory && (await managesReadGrantTarget(ctx, memory)) ? memory : null;
        targetManaged.set(row.memoryId, target);
      }
      if (!viaApp && !target) continue;
      const memory = target ?? (await ctx.db.memory.findUnique({ where: { id: row.memoryId }, select: { urn: true } }));
      out.push(project(row, memory, true));
    }
    return out;
  },
};
