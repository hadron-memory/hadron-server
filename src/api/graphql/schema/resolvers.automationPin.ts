/** #1719 R5b: one owner-controlled preview/re-adopt door for every trigger.
 * #2441: adoption state, a plain projection, approve and decline over the same door. */
import { configSelection } from '../../../lib/automation/identities.js';
import { GraphQLError } from 'graphql';
import { captureAutomationPin, storedAutomationPin, parseAutomationPin, AutomationPinError, type AutomationPinFormat } from '../../../lib/automation/pins.js';
import { approvalDepth, headlineOf, summarizeAutomation, type TriggerFacts } from '../../../lib/automation/approvalSummary.js';
import { runAuthContext, isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';
import { hasAppRelationship } from '../../../lib/auth/appRelationship.js';
import { boundWorkerId } from '../../../lib/bootPrompt.js';
import { currentActorAmbiguity } from '../../../lib/requestActor.js';
import { AppNotFoundError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { requireOwnerOrOrgRole, type Context } from './resolvers.helpers.js';

export type AutomationTriggerKind = 'SCHEDULE' | 'WEBHOOK' | 'MANUAL';
export interface AutomationTriggerRef { triggerKind: AutomationTriggerKind; triggerRef: string }
type AdoptionState = 'UNADOPTED' | 'ADOPTED' | 'CHANGED';
/** #2436: the one who-may refusal every adoption door throws — plain words naming the parties cor:agt:010:01's
 * today-rule admits. Deliberately not cor:dmo:050:12's word "manager": it reads as promising owner-role members
 * an admission the predicate does not grant (their widening is the open call in cor:agt:010:01). */
const denied = () => new GraphQLError("Only the trigger's run-as user may adopt this automation; a trigger with no run-as user may be previewed, approved, declined and re-adopted only by the App's owner, or by an ADMIN or OWNER of the organization that owns the App, or by a platform admin on an organization-owned App.", { extensions: { code: 'FORBIDDEN' } });
/** Cause 4: the CALLER cannot read a graph memory. Never names it: a caller who cannot read a memory is not told it exists. */
const callerCannotRead = () => new GraphQLError('You cannot read a memory this automation uses, so you cannot preview or adopt it. Ask someone who manages that memory to give you read access.', { extensions: { code: 'FORBIDDEN' } });
/** Cause 5: the RUN principal (the App, plus the run-as user when there is one) cannot read a graph memory. The memory is named only to a caller who can read it themselves. */
const principalCannotRead = (urn: string | null) => new GraphQLError(
  `A run of this automation could not read ${urn ? urn : 'a memory it uses'}: its principal (the App, plus the run-as user when there is one) cannot read it. Grant the App read access to that memory, then re-adopt.`,
  { extensions: { code: 'FORBIDDEN' } });
const workerRefused = () => new GraphQLError('A worker session cannot approve or decline an automation; the person who manages it does that as themselves.', { extensions: { code: 'FORBIDDEN' } });
const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * The ONE gate every adoption surface passes first (list, detail, approve, decline, preview, re-adopt): a signed-in
 * person acting as themselves. No user, an impersonation, a run principal and a worker-bound session are refused. A
 * worker-bound session is read from the request's published actor AND from the session row, never from a client flag.
 */
export async function requireAdopterContext(ctx: Context): Promise<string> {
  if (!ctx.userId || ctx.impersonation || isRunPrincipal(ctx)) throw denied();
  // An ambiguous MCP actor (several live worker bindings, none named) and a refused session binding are worker
  // shapes too: the same refusals as the boot-prompt pointer gate (assertMayWriteBootPromptPointer).
  if (boundWorkerId() || currentActorAmbiguity() !== null || ctx.sessionBindingRefused) throw workerRefused();
  if (ctx.sessionId && await ctx.db.session.findFirst({ where: { id: ctx.sessionId, workerId: { not: null } }, select: { id: true } })) throw workerRefused();
  return ctx.userId;
}

type App = NonNullable<Awaited<ReturnType<Context['db']['app']['findFirst']>>>;
type TriggerRow = { id: string; appId: string; organizationId: string; userId: string | null; entryNodeUrn: string; entryNodeId?: string | null };
/**
 * May this caller adopt this trigger? THE one admission predicate (#2436) behind every adoption surface —
 * preview, the approval detail, approve, decline, re-adopt, and the adoptable list's run-as-user arm —
 * implementing cor:agt:010:01's "who re-adopts" today-rule: the trigger's run-as user themself, or, for an
 * App-only trigger, the App's owner / an org ADMIN/OWNER / a platform admin on an org-owned App — all decided
 * by the shared tenant gate requireOwnerOrOrgRole('ADMIN'), never re-derived here. cor:dmo:050:12's wider
 * "manager" (owner-role members) is deliberately NOT admitted yet: widening is the open call in
 * cor:agt:010:01, and resolvers.automationPin2436.test.ts pins the refusal so the gap stays visible, not
 * silent. `memo` caches the App-only arm across the adoption door's two loads of the same row.
 */
async function canAdopt(ctx: Context, app: App, row: TriggerRow, memo: { appOnly?: boolean } = {}): Promise<boolean> {
  if (row.userId !== null) return isStrictOwner(ctx, row.userId) && await hasAppRelationship(ctx.db, row.appId, row.userId);
  if (memo.appOnly === undefined) {
    try { await requireOwnerOrOrgRole(ctx, app, 'ADMIN'); memo.appOnly = true; }
    catch (e) { if (!(e instanceof GraphQLError) || e.extensions?.code !== 'FORBIDDEN') throw e; memo.appOnly = false; }
  }
  return memo.appOnly;
}
/** The live App behind a trigger. An org-owned App must be the trigger's own org; a user-owned App has no organization (#2441), so any trigger org is accepted and the owner's strict-owner gate decides. */
async function liveApp(ctx: Context, row: { appId: string; organizationId: string }) {
  const app = await ctx.db.app.findFirst({ where: { id: row.appId, deletedAt: null, uninstalledAt: null } });
  return app && (app.organizationId === null || app.organizationId === row.organizationId) ? app : null;
}
async function load(ctx: Context, input: AutomationTriggerRef) {
  const actorId = await requireAdopterContext(ctx);
  const where = { id: input.triggerRef };
  const row = input.triggerKind === 'SCHEDULE'
    ? await ctx.db.agentSchedule.findFirst({ where: { ...where, deletedAt: null } })
    : input.triggerKind === 'WEBHOOK'
      ? await ctx.db.agentWebhook.findFirst({ where: { ...where, deletedAt: null } })
      : input.triggerKind === 'MANUAL'
        ? await ctx.db.appRun.findFirst({ where: { ...where, triggerKind: 'MANUAL' } }) : null;
  if (!row) throw new GraphQLError('Automation trigger not found.', { extensions: { code: 'NOT_FOUND' } });
  const app = await liveApp(ctx, row);
  const actor = await ctx.db.user.findFirst({ where: { id: actorId, deletedAt: null }, select: { id: true } });
  if (!app || !actor || !await canAdopt(ctx, app, row)) throw denied();
  return row;
}
/** The entry ref a capture walks from. v3 must use the literal URN — it is
 * part of the hashed identity, so an id here would desync the comparison.
 * v4 (#2438) prefers the stable node id: a renamed or moved entry keeps
 * resolving, and the id is never hashed as an address. */
const entryRefOf = (row: TriggerRow, format: AutomationPinFormat) =>
  format === 'hadron-automation-pin-v3' ? row.entryNodeUrn : row.entryNodeId ?? row.entryNodeUrn;
async function preview(ctx: Context, row: Awaited<ReturnType<typeof load>>, format: AutomationPinFormat = 'hadron-automation-pin-v4') {
  const pin = await captureAutomationPin(ctx.db, row.appId, row.userId, entryRefOf(row, format), row.organizationId, ctx, configSelection(row), { format });
  const memories = new Set(Object.values(pin.nodes).map(n => String(n.state.memoryId)));
  for (const id of memories) if (!await canReadMemory(ctx.db, ctx, id)) throw callerCannotRead();
  return pin;
}

/** Adoption state from the stored consent, by the existing parser: no pin, an unadopted marker or a corrupt pin is UNADOPTED. Never truthiness. The stored pin's FORMAT comes back too — a v3 adoption must be compared under v3 semantics (#2438). */
function storedState(raw: unknown): { state: 'UNADOPTED' | 'ADOPTED'; hash: string | null; format: AutomationPinFormat; entryId?: string } {
  try { const pin = parseAutomationPin(raw); return { state: 'ADOPTED', hash: pin.hash, format: pin.format, entryId: pin.entryId }; }
  catch (e) { if (e instanceof AutomationPinError) return { state: 'UNADOPTED', hash: null, format: 'hadron-automation-pin-v4' }; throw e; }
}
async function storedConsent(db: Context['db'], kind: AutomationTriggerKind, id: string): Promise<unknown> {
  if (kind === 'SCHEDULE') return (await db.agentSchedule.findUnique({ where: { id }, select: { automationPin: true } }))?.automationPin;
  if (kind === 'WEBHOOK') return (await db.agentWebhook.findUnique({ where: { id }, select: { automationPin: true } }))?.automationPin;
  return (await db.manualAutomationPin.findUnique({ where: { runId: id }, select: { pin: true } }))?.pin;
}
type Facts = { facts: TriggerFacts; name: string | null };
function factsOf(kind: AutomationTriggerKind, row: Record<string, unknown>): Facts {
  if (kind === 'SCHEDULE') return { name: String(row.name), facts: { kind, schedule: { cron: (row.cron as string | null) ?? null, timezone: String(row.timezone ?? 'UTC'), runAt: (row.runAt as Date | null) ?? null, enabled: row.enabled !== false } } };
  if (kind === 'WEBHOOK') return { name: String(row.name), facts: { kind } };
  return { name: null, facts: { kind } };
}

const MAX_PAGE = 50;
const encodeCursor = (name: string, kind: string, ref: string) => Buffer.from(JSON.stringify([name, kind, ref])).toString('base64url');
function decodeCursor(after: string): [string, string, string] {
  try {
    const v = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'string')) return v as [string, string, string];
  } catch { /* fall through */ }
  throw badInput('after is not a cursor returned by automationApprovals.');
}
const MANUAL_OMISSION = [{ triggerKind: 'MANUAL' as const, reason: 'approved from the run that needs it' }];

export const automationPinQueries = {
  /** Returns the exact graph bytes and digest the actor must review. */
  previewAutomation: async (_: unknown, input: AutomationTriggerRef, ctx: Context) => preview(ctx, await load(ctx, input)),

  /** #2441: the caller's adoptable schedules and webhooks. Authorization first, then order, then page: a hidden row never shifts a page. */
  automationApprovals: async (_: unknown, input: { appRef: string; limit?: number | null; after?: string | null }, ctx: Context) => {
    const actorId = await requireAdopterContext(ctx);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1) throw badInput('limit must be a positive integer.');
    const size = Math.min(limit, MAX_PAGE);
    const after = input.after ? decodeCursor(input.after) : null;
    const empty = { rows: [] as never[], nextCursor: null, omitted: MANUAL_OMISSION };
    let appId: string;
    try { appId = (await resolveAppRef(ctx.db, input.appRef)).id; }
    catch (e) { if (e instanceof AppNotFoundError) return empty; throw e; }
    const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null, uninstalledAt: null } });
    const actor = await ctx.db.user.findFirst({ where: { id: actorId, deletedAt: null }, select: { id: true } });
    if (!app || !actor) return empty;
    // Authorization is a property of the caller, not of each row: the run-as user's own triggers (when they hold the
    // App relationship) and, for a caller the predicate admits as an App-only trigger's adopter, those. So it goes into the WHERE, and the order and the
    // cursor are keyset predicates over (name, kind, id) in the database (byte order, so the JS cursor and SQL agree).
    // A small page therefore reads at most size + 1 slim rows and authorizes nothing per row.
    const synthetic = (userId: string | null) => ({ id: '', appId, organizationId: app.organizationId ?? '', userId, entryNodeUrn: '' });
    const own = await canAdopt(ctx, app, synthetic(actorId));
    const manages = await canAdopt(ctx, app, synthetic(null));
    if (!own && !manages) return empty;
    const inOrg = app.organizationId ? Prisma.sql`organization_id = ${app.organizationId}` : Prisma.sql`TRUE`;
    const who = own && manages ? Prisma.sql`(user_id IS NULL OR user_id = ${actorId})` : own ? Prisma.sql`user_id = ${actorId}` : Prisma.sql`user_id IS NULL`;
    const cursor = after
      ? Prisma.sql`WHERE ROW(name COLLATE "C", kind COLLATE "C", id COLLATE "C") > ROW(${after[0]}::text COLLATE "C", ${after[1]}::text COLLATE "C", ${after[2]}::text COLLATE "C")`
      : Prisma.empty;
    const keys = await ctx.db.$queryRaw<Array<{ id: string; name: string; kind: 'SCHEDULE' | 'WEBHOOK' }>>(Prisma.sql`
      SELECT id, name, kind FROM (
        SELECT id, name, 'SCHEDULE' AS kind FROM agent_schedules
         WHERE app_id = ${appId} AND ${inOrg} AND deleted_at IS NULL AND ${who}
        UNION ALL
        SELECT id, name, 'WEBHOOK' AS kind FROM agent_webhooks
         WHERE app_id = ${appId} AND ${inOrg} AND deleted_at IS NULL AND ${who}
      ) t ${cursor}
      ORDER BY name COLLATE "C", kind COLLATE "C", id COLLATE "C" LIMIT ${size + 1}`);
    const page = keys.slice(0, size);
    const ids = (kind: string) => page.filter(k => k.kind === kind).map(k => k.id);
    // The second stage repeats the first stage's live, org and ownership predicates, so a row that changed or was
    // deleted between the two reads is dropped rather than shown.
    const still = (kind: string) => ({ id: { in: ids(kind) }, appId, deletedAt: null, ...(app.organizationId ? { organizationId: app.organizationId } : {}),
      OR: [...(own ? [{ userId: actorId }] : []), ...(manages ? [{ userId: null }] : [])] });
    const [schedules, webhooks] = await Promise.all([
      ids('SCHEDULE').length ? ctx.db.agentSchedule.findMany({ where: still('SCHEDULE') }) : [],
      ids('WEBHOOK').length ? ctx.db.agentWebhook.findMany({ where: still('WEBHOOK') }) : [],
    ]);
    const byKey = new Map<string, Record<string, unknown>>([...schedules.map(r => [`SCHEDULE|${r.id}`, r] as const), ...webhooks.map(r => [`WEBHOOK|${r.id}`, r] as const)]);
    const rows = page.flatMap(k => {
      const row = byKey.get(`${k.kind}|${k.id}`);
      if (!row) return [];
      const { facts, name } = factsOf(k.kind, row);
      const { state } = storedState(row.automationPin);
      return [{ triggerKind: k.kind, triggerRef: k.id, name, state, headline: headlineOf(name ?? k.kind, facts, state) }];
    });
    const last = page[page.length - 1];
    return { rows, nextCursor: keys.length > size ? encodeCursor(last.name, last.kind, last.id) : null, omitted: MANUAL_OMISSION };
  },

  /** #2441: what the adopter reviews: state, the hash the Approve button carries, a plain summary, and the graph depth. */
  automationApproval: async (_: unknown, input: AutomationTriggerRef, ctx: Context) => {
    const row = await load(ctx, input);
    const stored = storedState(await storedConsent(ctx.db, input.triggerKind, row.id));
    // A pre-#2438 adoption has no stamped entryNodeId; once its entry moved,
    // the fresh v4 preview would resolve the stale URN and error the whole
    // query before the v3 comparison below could answer CHANGED (#2438 BLIND
    // P2, Andi). The stored pin's entryId is the stable ref: preview by it,
    // and keep the row's literal URN for the v3-semantics comparison.
    const pin = await preview(ctx, stored.state === 'ADOPTED' && !row.entryNodeId ? { ...row, entryNodeId: stored.entryId } as typeof row : row);
    let state: AdoptionState = stored.state;
    if (state === 'ADOPTED') {
      if (stored.format === 'hadron-automation-pin-v4') state = stored.hash === pin.hash ? 'ADOPTED' : 'CHANGED';
      else {
        // A pre-#2438 v3 adoption compares under v3 semantics: an unchanged
        // legacy trigger is still ADOPTED — its stored digest can never be
        // recomputed as v4. A v3 graph that no longer captures (rename, move)
        // is CHANGED, which is what it is under v3; re-adoption then writes v4.
        try { state = (await preview(ctx, row, stored.format)).hash === stored.hash ? 'ADOPTED' : 'CHANGED'; }
        catch (e) { if (e instanceof NodeNotFoundError || e instanceof AutomationPinError) state = 'CHANGED'; else throw e; }
      }
    }
    return { state, hash: pin.hash, summary: summarizeAutomation(pin, factsOf(input.triggerKind, row as never).facts), depth: approvalDepth(pin) };
  },
};

type Row = Awaited<ReturnType<typeof load>>;
/**
 * The ONE adoption door (#2441): the anchors, the fresh authorization under the trigger-row lock, and the event written
 * in the same transaction as the consent change. `reAdoptAutomation`, `approveAutomation` and `declineAutomation` are
 * thin resolvers over it, never over one another, so a call writes exactly one event and no more.
 */
async function adoptionDoor<T>(ctx: Context, input: AutomationTriggerRef, write: (tx: Prisma.TransactionClient, txCtx: Context, row: Row) => Promise<T>): Promise<T> {
  const observed = await load(ctx, input);
  let row = observed;
  return withAuthorizedTx(ctx, [ { kind: 'app', id: observed.appId },
    { kind: 'org', id: observed.organizationId },
    ...(observed.userId ? [{ kind: 'user' as const, id: observed.userId }] : []) ],
    async txCtx => { row = await load(txCtx, input); if (row.appId !== observed.appId || row.userId !== observed.userId || row.organizationId !== observed.organizationId) throw denied(); },
    (tx, txCtx) => write(tx, txCtx, row),
    { afterLock: async tx => {
      if (input.triggerKind === 'SCHEDULE') await tx.$queryRaw`SELECT id FROM agent_schedules WHERE id = ${observed.id} FOR UPDATE`;
      else if (input.triggerKind === 'WEBHOOK') await tx.$queryRaw`SELECT id FROM agent_webhooks WHERE id = ${observed.id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM app_runs WHERE id = ${observed.id} FOR UPDATE`;
    } });
}
/** The event's organization is the APP's (null for a user-owned App), not the trigger row's. */
const recordEvent = async (tx: Prisma.TransactionClient, row: Row, input: AutomationTriggerRef, action: 'APPROVE' | 'DECLINE' | 'REVOKE', actorUserId: string, pinHash: string | null) => {
  const app = await tx.app.findUnique({ where: { id: row.appId }, select: { organizationId: true } });
  await tx.automationAdoptionEvent.create({ data: { appId: row.appId, organizationId: app?.organizationId ?? null, triggerKind: input.triggerKind, triggerRef: row.id, action, actorUserId, pinHash } });
};

/** Rebind only the actor's exact preview hash; graph drift rejects adoption. */
function adopt(ctx: Context, input: AutomationTriggerRef & { expectedHash: string }) {
  return adoptionDoor(ctx, input, async (tx, txCtx, row) => {
    const pin = await preview(txCtx, row);
    if (pin.hash !== input.expectedHash) throw new GraphQLError('Automation changed since preview; preview and re-adopt again.', { extensions: { code: 'AUTOMATION_CHANGED' } });
    const principal = runAuthContext({ ...row, id: 'setup' });
    for (const node of Object.values(pin.nodes)) {
      const memoryId = String(node.state.memoryId);
      if (await canReadMemory(txCtx.db, principal, memoryId)) continue;
      const named = await canReadMemory(txCtx.db, txCtx, memoryId) ? await txCtx.db.memory.findUnique({ where: { id: memoryId }, select: { urn: true } }) : null;
      throw principalCannotRead(named?.urn ?? null);
    }
    // #2438: adoption is the authoritative stamp of the entry's stable id —
    // v4 pins key by it, and every later launch resolves by it first.
    const data = { automationPin: storedAutomationPin(pin) as never, entryNodeId: pin.entryId, updatedBy: ctx.userId };
    if (input.triggerKind === 'SCHEDULE') await tx.agentSchedule.update({ where: { id: row.id }, data });
    else if (input.triggerKind === 'WEBHOOK') await tx.agentWebhook.update({ where: { id: row.id }, data });
    else {
      await tx.manualAutomationPin.upsert({ where: { runId: row.id }, create: { runId: row.id, pin: storedAutomationPin(pin) as never, adoptedBy: ctx.userId }, update: { pin: storedAutomationPin(pin) as never, adoptedAt: new Date(), adoptedBy: ctx.userId } });
      await tx.appRun.update({ where: { id: row.id }, data: { entryNodeId: pin.entryId } });
    }
    await recordEvent(tx, row, input, 'APPROVE', ctx.userId!, pin.hash);
    return true;
  });
}

export const automationPinMutations = {
  reAdoptAutomation: async (_: unknown, input: AutomationTriggerRef & { expectedHash: string }, ctx: Context) => adopt(ctx, input),
  /** #2441: the plain Approve. The button carries the hash, so the person never types one. */
  approveAutomation: async (_: unknown, input: AutomationTriggerRef & { expectedHash: string }, ctx: Context) => adopt(ctx, input),
  /** #2441: Decline. An adopted trigger is revoked; with nothing adopted, no state changes. Both are recorded. */
  declineAutomation: async (_: unknown, input: AutomationTriggerRef, ctx: Context) =>
    adoptionDoor(ctx, input, async (tx, _txCtx, row) => {
      const current = storedState(await storedConsent(tx as never, input.triggerKind, row.id));
      if (current.state === 'ADOPTED') {
        if (input.triggerKind === 'SCHEDULE') await tx.agentSchedule.update({ where: { id: row.id }, data: { automationPin: Prisma.DbNull, updatedBy: ctx.userId } });
        else if (input.triggerKind === 'WEBHOOK') await tx.agentWebhook.update({ where: { id: row.id }, data: { automationPin: Prisma.DbNull, updatedBy: ctx.userId } });
        else await tx.manualAutomationPin.deleteMany({ where: { runId: row.id } });
      }
      await recordEvent(tx, row, input, current.state === 'ADOPTED' ? 'REVOKE' : 'DECLINE', ctx.userId!, current.hash);
      return true;
    }),
};
