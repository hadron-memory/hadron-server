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
import { managesAgent, managesApp, managesAppBatch } from '../../../lib/auth/appManagement.js';
import { requirePersonAsThemselves, requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { READ_GRANT_MEMORY_SELECT, readGrantTargetRefusal, type ReadGrantTriggerKind } from '../../../lib/automationReadGrant.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { validateLoc, InvalidLocError } from '../../../lib/validateLoc.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { requireMemoryManageAccess, safeCanonicalUrn, type Context } from './resolvers.helpers.js';

import { requireInstructedAct, type ActInstruction } from '../../../lib/auth/instructedAct.js';
import { automationGrantAdmission, finalAutomationGrantAdmission, lockAutomationGrantActor, refuseAutomationGrantPrincipal } from './automationGrantInstruction.js';
import { callerIsWorkerSession, readActInstruction } from './resolvers.instruction.js';
import { appendCredentialInstructionEvent } from '../../../lib/agentTasks/events.js';
import { withManagerOrgRoles } from '../../../lib/auth/managerOrgRoles.js';

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
  if (raw == null) return null;
  // A blank string is a mistake, not the maximum grant: only an absent prefix means the whole memory.
  if (raw.trim() === '') throw badInput('prefix must be a loc, or omitted for the whole memory.');
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
export async function managesReadGrantTarget(ctx: Context, memory: TargetRow,
  prefetchedAgents?: readonly { organizationId: string | null; ownerUserId: string | null }[],
): Promise<boolean> {
  if (memory.class === 'system') {
    const agents = prefetchedAgents ?? await ctx.db.agent.findMany({
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

/** #3382: data batched once per predicate evaluation, while the shared gates retain their policy.
 * Never retain this across admissions: the final locked admission needs fresh memberships and targets.
 * The caller still traverses observed order and stops at its first matching, non-drifted target.
 */
async function targetManagers(ctx: Context, memories: readonly TargetRow[]) {
  const fresh = await withManagerOrgRoles(ctx, memories.flatMap(m => m.organizationId ? [m.organizationId] : []));
  const systemIds = memories.filter(m => m.class === 'system').map(m => m.id);
  const agents = systemIds.length ? await ctx.db.agent.findMany({
    where: { systemMemoryId: { in: systemIds }, deletedAt: null },
    select: { systemMemoryId: true, organizationId: true, ownerUserId: true },
  }) : [];
  const byMemory = new Map<string, typeof agents>();
  for (const agent of agents) {
    const id = agent.systemMemoryId!;
    const group = byMemory.get(id) ?? [];
    group.push(agent); byMemory.set(id, group);
  }
  return (memory: TargetRow) => managesReadGrantTarget(fresh, memory,
    (byMemory.get(memory.id) ?? []).filter(a => a.organizationId === memory.organizationId && a.ownerUserId === memory.ownerUserId));
}

function project(row: GrantRow, memory: { urn: string } | null) {
  return {
    id: row.id, appId: row.appId, triggerKind: row.triggerKind, triggerId: row.triggerId,
    memoryUrn: memory ? safeCanonicalUrn('memory', memory.urn) : null,
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
    // #3277: giving a grant is person-only (hrn:node:hadronmemory.com:specs:cor:dmo:050:12, ruling 0099 A).
    const actorId = await requirePersonOnlyAct(ctx, 'grant.give', denied);
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
    return project(row, memory);
  },

  revokeAutomationReadGrant: async (_: unknown, { id, instruction }: { id: string; instruction?: ActInstruction | null }, ctx: Context) => {
    refuseAutomationGrantPrincipal(ctx);
    const existing = await ctx.db.appAutomationReadGrant.findUnique({ where: { id }, include: { app: { select: APP_SELECT } } });
    if (!existing) throw denied();
    const app0 = existing.app;
    const target0 = await ctx.db.memory.findFirst({ where: { id: existing.memoryId, deletedAt: null }, select: TARGET_SELECT });
    const allows = async (c: Context) => {
      const app = await c.db.app.findUnique({ where: { id: app0.id }, select: APP_SELECT });
      if (!app) return false;
      if (await managesApp(c, app)) return true;
      const memory = await c.db.memory.findFirst({ where: { id: existing.memoryId, deletedAt: null }, select: TARGET_SELECT });
      if (memory && target0 && (memory.organizationId !== target0.organizationId || memory.ownerUserId !== target0.ownerUserId)) return false;
      return !!memory && await managesReadGrantTarget(c, memory);
    };
    let admission = await automationGrantAdmission(ctx, app0, instruction, allows);
    await withAuthorizedTx(
      ctx,
      anchorsOf(app0, existing.memoryId),
      async c => { admission = await automationGrantAdmission(c, app0, instruction, allows, admission); },
      async (tx, c) => {
        admission = await finalAutomationGrantAdmission(c, app0, instruction, allows, admission);
        const actorId = admission.userId;
        // Terminal: a second revoke matches nothing and records nothing.
        const ended = await tx.appAutomationReadGrant.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: actorId } });
        if (ended.count === 1) {
          await tx.appAutomationReadGrantEvent.create({
            data: { appId: existing.appId, triggerKind: existing.triggerKind, triggerId: existing.triggerId, memoryId: existing.memoryId, grantId: id, prefix: existing.prefix, action: 'REVOKE', actorUserId: actorId },
          });
          await appendCredentialInstructionEvent(tx, { appId: existing.appId, admission, act: 'automation-read-grant.revoke' });
        }
      },
      { afterLock: tx => lockAutomationGrantActor(tx, admission, app0, target0?.organizationId ? [target0.organizationId] : []) },
    );
    const row = await ctx.db.appAutomationReadGrant.findUniqueOrThrow({ where: { id } });
    const memory = await ctx.db.memory.findUnique({ where: { id: row.memoryId }, select: { urn: true } });
    return project(row, memory);
  },
};

type ListInput = { appRef?: string | null; memoryRef?: string | null; includeRevoked?: boolean | null; instruction?: ActInstruction | null };
async function readGrantRows(input: ListInput, ctx: Context) {
  // An unknown ref and a ref the caller cannot see are the one answer, the empty list (as the rows below are filtered
  // by what the caller manages), so the list is no existence oracle for an App or a memory.
  let appId: string | undefined;
  let memoryId: string | undefined;
  try {
    appId = input.appRef ? (await resolveOrDeny(() => resolveAppRef(ctx.db, input.appRef!))).id : undefined;
    memoryId = input.memoryRef ? (await resolveOrDeny(() => resolveMemoryRef(ctx.db, input.memoryRef!))).id : undefined;
  } catch (e) {
    if ((e as { extensions?: { code?: string } }).extensions?.code === 'FORBIDDEN') return [];
    throw e;
  }
  const rows = await ctx.db.appAutomationReadGrant.findMany({
    where: { ...(appId ? { appId } : {}), ...(memoryId ? { memoryId } : {}), ...(input.includeRevoked ? {} : { revokedAt: null }) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { app: { select: APP_SELECT } },
  });
  // #3382: retain the grant query's order and complete result, batching only predicate inputs.
  const appManaged = await managesAppBatch(ctx, [...new Map(rows.map(r => [r.appId, r.app])).values()]);
  // Include deleted rows for the App-manager's historical URN projection, as findUnique did before.
  const memories = rows.length ? await ctx.db.memory.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.memoryId))] } }, select: TARGET_SELECT,
  }) : [];
  const byId = new Map(memories.map(m => [m.id, m]));
  const managesTarget = await targetManagers(ctx, memories.filter(m => !m.deletedAt));
  const targetManaged = new Map<string, boolean>();
  const out: ReturnType<typeof project>[] = [];
  for (const row of rows) {
    const memory = byId.get(row.memoryId) ?? null;
    let target = targetManaged.get(row.memoryId);
    if (target === undefined) {
      target = !!memory && !memory.deletedAt && await managesTarget(memory);
      targetManaged.set(row.memoryId, target);
    }
    if (!appManaged.get(row.appId) && !target) continue;
    out.push(project(row, memory));
  }
  return out;
}
export const automationReadGrantQueries = {
  automationReadGrants: async (_: unknown, input: ListInput, ctx: Context) => {
    refuseAutomationGrantPrincipal(ctx);
    if (!await callerIsWorkerSession(ctx)) {
      // Preserve the direct-person filtering and cross-App target-manager reach.
      await requirePersonAsThemselves(ctx, denied);
      if (!input.appRef && !input.memoryRef) throw badInput('appRef or memoryRef is required.');
      // Validate a supplied person claim under the same protocol, without recording it.
      if (input.instruction != null) {
        // No inferred App for a direct person's cross-App memory-only list. A supplied claim must name its App.
        if (!input.appRef) throw denied();
        // LIVE_CHAT is an opaque person's claim, with no referenced App to resolve. Validate it before
        // the filtered row reader, which conceals an unknown App just like an existing unmanaged App.
        // TASK/message claims still resolve and check their same-App readable reference.
        const claimApp = input.instruction.kind === 'LIVE_CHAT' ? input.appRef
          : (await resolveOrDeny(() => resolveAppRef(ctx.db, input.appRef!))).id;
        await requireInstructedAct(ctx, claimApp, input.instruction, async () => true,
          readActInstruction, denied);
      }
      return readGrantRows(input, ctx);
    }
    if (!input.appRef && !input.memoryRef) throw badInput('appRef or memoryRef is required.');
    // #3361 FIT: the session's App, never a target-manager's other Apps, binds an instructed memory-only list.
    const session = ctx.sessionId ? await ctx.db.session.findUnique({ where: { id: ctx.sessionId }, select: { appId: true } }) : null;
    if (!session?.appId) throw denied();
    const appId = input.appRef ? (await resolveOrDeny(() => resolveAppRef(ctx.db, input.appRef!))).id : session.appId;
    if (appId !== session.appId) throw denied();
    const app = await ctx.db.app.findUnique({ where: { id: appId }, select: APP_SELECT });
    if (!app) throw denied();
    let memoryId: string | undefined;
    let unknownMemory = false;
    if (input.memoryRef) {
      try { memoryId = (await resolveOrDeny(() => resolveMemoryRef(ctx.db, input.memoryRef!))).id; }
      catch (e) {
        if ((e as { extensions?: { code?: string } }).extensions?.code !== 'FORBIDDEN') throw e;
        unknownMemory = true;
      }
    }
    // An unknown selector never becomes an unscoped list. Managers are admitted and record the same empty
    // result as for an existing foreign target; a non-manager has no target authority and is refused.
    const targets = unknownMemory ? [] : await ctx.db.memory.findMany({ where: memoryId ? { id: memoryId, deletedAt: null } : {
      deletedAt: null, automationReadGrants: { some: { appId } },
    }, select: TARGET_SELECT });
    const allows = async (c: Context) => {
      if (await managesApp(c, app)) return true;
      const live = targets.length ? await c.db.memory.findMany({
        where: { id: { in: targets.map(m => m.id) }, deletedAt: null }, select: TARGET_SELECT,
      }) : [];
      const byId = new Map(live.map(m => [m.id, m]));
      const managesTarget = await targetManagers(c, live);
      for (const observed of targets) {
        const m = byId.get(observed.id);
        if (m && m.organizationId === observed.organizationId && m.ownerUserId === observed.ownerUserId && await managesTarget(m)) return true;
      }
      return false;
    };
    let admission = await automationGrantAdmission(ctx, app, input.instruction, allows);
    return withAuthorizedTx(ctx, [...anchorsOf(app), ...targets.map(m => ({kind:'memory' as const,id:m.id}))],
      async c => { admission = await automationGrantAdmission(c, app, input.instruction, allows, admission); },
      async (tx, c) => {
        admission = await finalAutomationGrantAdmission(c, app, input.instruction, allows, admission);
        const rows = await readGrantRows({ ...input, appRef: app.id }, c);
        await appendCredentialInstructionEvent(tx, { appId, admission, act: 'automation-read-grant.list' });
        return rows;
      }, { afterLock: tx => lockAutomationGrantActor(tx, admission, app, targets.flatMap(m => m.organizationId ? [m.organizationId] : [])) });
  },
};
