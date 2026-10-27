/**
 * #2484 (cor:agt:010:01, epic #2435, #2431 slice A): set, revoke and list an App's prefix-scoped write grant for its
 * userless runs. The enforcement side is `src/lib/appWriteGrant.ts`, answered by the node write door's gate; this file
 * is only the doors that make and end the rows.
 *
 * Who may do what (Holger, 2026-10-27, A1-A3 and the owner<->App answer):
 *  - SET: a person acting as themselves (no worker session, run principal, impersonation or App key) who MANAGES the
 *    App (cor:dmo:050:12, the shared {@link managesApp}) and can WRITE the target memory themselves (the delegation
 *    ceiling, cor:acl:040). A shared memory must be one the App's own org or team space already holds; a personal or
 *    private memory is grantable only by its OWNER, who must also manage the App; an encrypted one never.
 *  - REVOKE: whoever manages the App, as themselves; nothing more.
 *  - LIST: the same managers; a grant on a personal or private memory is shown to its owner alone.
 *
 * Every refusal on the set and revoke doors is the one `Forbidden`, and an unknown App, memory or grant is the same
 * answer: a caller who cannot act on a thing is not told whether it exists. The prefix is validated first, before any
 * lookup, so a malformed one reveals nothing.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { requirePersonAsThemselves } from '../../../lib/auth/personAsThemselves.js';
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';
import { GRANT_MEMORY_SELECT, grantTargetRefusal, isStrictOwnerClass } from '../../../lib/appWriteGrant.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { parseUrnInput } from '../../../lib/urn.js';
import { validateLoc, InvalidLocError } from '../../../lib/validateLoc.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { requireMemoryWriteAccess, safeCanonicalUrn, type Context } from './resolvers.helpers.js';

const denied = () => authorizationDenied();
const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
const REGISTER_URN_MAX = 500;

type GrantRow = NonNullable<Awaited<ReturnType<Context['db']['appMemoryWriteGrant']['findFirst']>>>;
type AppRow = { id: string; organizationId: string | null; ownerUserId: string | null };

/** The prefix is a loc and is required: an empty one would be a memory-wide grant, which the table cannot express. */
function parsePrefix(raw: string): string {
  const prefix = raw.trim();
  if (prefix === '') throw badInput('prefix is required: a grant covers one loc prefix, never a whole memory.');
  try { validateLoc(prefix); } catch (e) {
    if (e instanceof InvalidLocError) throw badInput(`prefix is not a valid loc: ${e.message}`);
    throw e;
  }
  return prefix;
}

/** The register line the grant cites: a node URN, kept as given. A citation only: nothing reads it or relies on it. */
function parseRegisterUrn(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return null;
  const urn = raw.trim();
  if (urn.length > REGISTER_URN_MAX || parseUrnInput(urn).type !== 'node') {
    throw badInput('registerNodeUrn must be a node URN (hrn:node:<root>:<memory>:<loc>).');
  }
  return urn;
}

async function resolveOrDeny<T>(lookup: () => Promise<T>): Promise<T> {
  try { return await lookup(); } catch (e) {
    if (e instanceof GraphQLError) throw e;
    if (e instanceof Error && /not found|not fully qualified|URN/i.test(e.message)) throw denied();
    throw e;
  }
}

/** Project one row. `memoryUrn` is withheld from anyone who may not know that a personal/private memory is granted. */
function project(row: GrantRow, memory: { urn: string; class: string; userId: string | null } | null, viewerId: string | undefined) {
  const visible = memory !== null && (!isStrictOwnerClass(memory.class) || isStrictOwner({ userId: viewerId }, memory.userId));
  return {
    id: row.id, appId: row.appId, memoryUrn: visible ? safeCanonicalUrn('memory', memory!.urn) : null,
    prefix: row.prefix, registerNodeUrn: row.registerNodeUrn, grantedBy: row.grantedBy,
    createdAt: row.createdAt, revokedAt: row.revokedAt, revokedBy: row.revokedBy,
  };
}

const anchorsOf = (app: AppRow, memoryId?: string) => [
  { kind: 'app' as const, id: app.id },
  ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
  ...(memoryId ? [{ kind: 'memory' as const, id: memoryId }] : []),
];

/** Hold the caller's deciding memberships through the write: a demotion that committed first is seen, a later one waits. */
async function lockManagerMemberships(tx: Prisma.TransactionClient, userId: string, app: AppRow): Promise<void> {
  await tx.$queryRaw`SELECT user_id FROM app_members WHERE app_id = ${app.id} AND user_id = ${userId} FOR SHARE`;
  if (app.organizationId) await tx.$queryRaw`SELECT user_id FROM org_members WHERE organization_id = ${app.organizationId} AND user_id = ${userId} FOR SHARE`;
}

export const appWriteGrantMutations = {
  setAppMemoryWriteGrant: async (
    _: unknown,
    input: { appRef: string; memoryRef: string; prefix: string; registerNodeUrn?: string | null },
    ctx: Context,
  ) => {
    const prefix = parsePrefix(input.prefix);
    const registerNodeUrn = parseRegisterUrn(input.registerNodeUrn);
    const actorId = await requirePersonAsThemselves(ctx, denied);
    const { id: appId } = await resolveOrDeny(() => resolveAppRef(ctx.db, input.appRef));
    const { id: memoryId } = await resolveOrDeny(() => resolveMemoryRef(ctx.db, input.memoryRef));
    const app0 = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null, uninstalledAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
    if (!app0) throw denied();

    const run = () => withAuthorizedTx(
      ctx,
      anchorsOf(app0, memoryId),
      async (txCtx) => {
        // Re-decided on the transaction, with the anchors held: the App, the memory and the setter's authority are
        // read as they are now, not as the request first saw them.
        const app = await txCtx.db.app.findFirst({ where: { id: appId, deletedAt: null, uninstalledAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
        const memory = await txCtx.db.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: GRANT_MEMORY_SELECT });
        if (!app || !memory) throw denied();
        if (app.organizationId !== app0.organizationId || app.ownerUserId !== app0.ownerUserId) throw denied();
        if (!(await managesApp(txCtx, app))) throw denied();
        if (grantTargetRefusal(app, memory) !== null) throw denied();
        // A personal or private memory: only its owner (the manager above is the same person, so the owner must
        // manage this App). Every other class: the setter's own write on the target, the delegation ceiling.
        if (isStrictOwnerClass(memory.class) && !isStrictOwner(txCtx, memory.userId)) throw denied();
        try { await requireMemoryWriteAccess(txCtx, memory.id); } catch { throw denied(); }
      },
      async (tx) => {
        const live = await tx.appMemoryWriteGrant.findFirst({ where: { appId, memoryId, prefix, revokedAt: null } });
        if (live) return live;
        const row = await tx.appMemoryWriteGrant.create({ data: { appId, memoryId, prefix, registerNodeUrn, grantedBy: actorId } });
        await tx.appMemoryWriteGrantEvent.create({ data: { appId, memoryId, grantId: row.id, prefix, action: 'GRANT', actorUserId: actorId } });
        return row;
      },
      { afterLock: (tx) => lockManagerMemberships(tx, actorId, app0) },
    );
    let row: GrantRow;
    try { row = await run(); } catch (e) {
      // A concurrent identical set won the one-live-row index: the same grant, so answer with it.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const live = await ctx.db.appMemoryWriteGrant.findFirst({ where: { appId, memoryId, prefix, revokedAt: null } });
      if (!live) throw e;
      row = live;
    }
    const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, select: { urn: true, class: true, userId: true } });
    return project(row, memory, actorId);
  },

  revokeAppMemoryWriteGrant: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    const actorId = await requirePersonAsThemselves(ctx, denied);
    const existing = await ctx.db.appMemoryWriteGrant.findUnique({ where: { id }, include: { app: { select: { id: true, organizationId: true, ownerUserId: true } } } });
    if (!existing) throw denied();
    const app0 = existing.app;
    await withAuthorizedTx(
      ctx,
      anchorsOf(app0),
      async (txCtx) => {
        const app = await txCtx.db.app.findUnique({ where: { id: app0.id }, select: { id: true, organizationId: true, ownerUserId: true } });
        if (!app || app.organizationId !== app0.organizationId || app.ownerUserId !== app0.ownerUserId) throw denied();
        if (!(await managesApp(txCtx, app))) throw denied();
      },
      async (tx) => {
        // The UPDATE takes the grant row's lock: it waits for a write that already read the grant (FOR SHARE) and every
        // later write sees `revokedAt`. Terminal: a second revoke matches nothing and records nothing.
        const ended = await tx.appMemoryWriteGrant.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: actorId } });
        if (ended.count === 1) {
          await tx.appMemoryWriteGrantEvent.create({ data: { appId: existing.appId, memoryId: existing.memoryId, grantId: id, prefix: existing.prefix, action: 'REVOKE', actorUserId: actorId } });
        }
      },
      { afterLock: (tx) => lockManagerMemberships(tx, actorId, app0) },
    );
    const row = await ctx.db.appMemoryWriteGrant.findUniqueOrThrow({ where: { id } });
    const memory = await ctx.db.memory.findUnique({ where: { id: row.memoryId }, select: { urn: true, class: true, userId: true } });
    return project(row, memory, actorId);
  },
};

export const appWriteGrantQueries = {
  appMemoryWriteGrants: async (_: unknown, input: { appRef: string; includeRevoked?: boolean | null }, ctx: Context) => {
    const actorId = await requirePersonAsThemselves(ctx, denied);
    const { id: appId } = await resolveOrDeny(() => resolveAppRef(ctx.db, input.appRef));
    const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null, uninstalledAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
    if (!app || !(await managesApp(ctx, app))) throw denied();
    const rows = await ctx.db.appMemoryWriteGrant.findMany({
      where: { appId, ...(input.includeRevoked ? {} : { revokedAt: null }) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { memory: { select: { urn: true, class: true, userId: true } } },
    });
    // A grant on a personal or private memory tells a reader that the memory exists and is delegated: its owner only.
    return rows
      .filter((row) => !isStrictOwnerClass(row.memory.class) || isStrictOwner({ userId: actorId }, row.memory.userId))
      .map((row) => project(row, row.memory, actorId));
  },
};
