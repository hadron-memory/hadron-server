// connectionGrant resolvers — user→App scoped delegation on user-owned
// connections (spec-042 Track B, #593). Owner-only management surface; the
// enforcement gate lives in requireEmailConnection (resolvers.helpers.ts).
import { GraphQLError } from 'graphql';
import { type Context, clampListTake, toISO, safeCanonicalUrn } from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { generateId } from '../../../lib/id.js';
import { withAuthorizedTx } from './authorizedTx.js';
import {
  CONNECTION_GRANT_SCOPES,
  isConnectionGrantScope,
} from '../../../lib/emailOperationScopes.js';

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

// What each grant query selects — the grantee App is projected to SCALARS
// (id/urn/name), never returned as an `App` object, so its `keys`/`members`
// field resolvers are unreachable through a (possibly cross-org) grant — the
// #552 nested-field-leak invariant.
const GRANT_SELECT = {
  id: true,
  connectionId: true,
  granteeAppId: true,
  scopes: true,
  expiresAt: true,
  createdAt: true,
  granteeApp: { select: { urn: true, name: true } },
} as const;

type GrantRow = {
  id: string;
  connectionId: string;
  granteeAppId: string;
  scopes: string[];
  expiresAt: Date | null;
  createdAt: Date;
  granteeApp: { urn: string; name: string } | null;
};

/** Flatten a selected grant row into the GraphQL ConnectionGrant shape. */
function projectGrant(g: GrantRow) {
  return {
    id: g.id,
    connectionId: g.connectionId,
    granteeAppId: g.granteeAppId,
    granteeAppUrn: g.granteeApp ? safeCanonicalUrn('app', g.granteeApp.urn) : null,
    granteeAppName: g.granteeApp?.name ?? null,
    scopes: g.scopes,
    expiresAt: toISO(g.expiresAt),
    createdAt: toISO(g.createdAt),
  };
}

/**
 * Owner-only management gate: the caller must be an INTERACTIVE user
 * (`ctx.userId` set, `ctx.appId` ABSENT) who owns the connection — no
 * org-admin bypass, and crucially no App-key / on-behalf-of-run path.
 *
 * The `ctx.appId` exclusion is load-bearing: without it, a run on-behalf-of the
 * owner (which carries both `userId === owner` AND `appId`) could call
 * `createConnectionGrant` to bootstrap its OWN mailbox access — defeating the
 * whole fail-closed gate (PR-599 review, Copilot). Grant management is personal
 * authority exercised interactively, never by an autonomous principal.
 *
 * A missing/soft-deleted connection and a non-owner both surface identically
 * (create throws; list/read return empty) so neither leaks existence.
 */
async function loadOwnedConnection(
  ctx: Context,
  connectionRef: string,
): Promise<{ id: string; userId: string } | null> {
  if (!ctx.userId || ctx.appId) return null;
  const conn = await ctx.db.exchangeConnection.findFirst({
    where: { id: connectionRef, deletedAt: null },
    select: { id: true, userId: true },
  });
  if (!conn || conn.userId !== ctx.userId) return null;
  return conn;
}

/** True for an interactive user principal — the only context allowed to MANAGE
 * grants (create/list/revoke). An App-key / on-behalf-of context is excluded. */
function isInteractiveUser(ctx: Context): boolean {
  // #876 class sweep: every surface behind this predicate is keyed on
  // `grantedByUserId: ctx.userId` with no org constraint, so under
  // impersonation it disclosed which Apps hold delegated scopes on the
  // TARGET's personal mailbox — cross-org, and identity-scoped by definition.
  // An impersonated session is not an interactive user.
  return !!ctx.userId && !ctx.appId && !ctx.impersonation;
}

export const connectionGrantQueries = {
  // cor:api:120 find-one — owner-scoped; a grant the caller didn't create
  // resolves to null (no existence oracle).
  connectionGrant: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    if (!isInteractiveUser(ctx)) return null;
    const grant = (await ctx.db.connectionGrant.findFirst({
      where: { id: ref, deletedAt: null, grantedByUserId: ctx.userId },
      select: GRANT_SELECT,
    })) as GrantRow | null;
    return grant ? projectGrant(grant) : null;
  },

  // cor:api:120 find-many — the caller's own grants. Optional connectionRef
  // narrows to one connection; because the filter is always pinned to
  // grantedByUserId, a connection the caller doesn't own yields an empty page
  // (no oracle) without a separate ownership probe.
  connectionGrants: async (
    _: unknown,
    { connectionRef, limit, offset }: { connectionRef?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    if (!isInteractiveUser(ctx)) return { items: [], total: 0 };
    const where = {
      grantedByUserId: ctx.userId,
      deletedAt: null,
      ...(connectionRef ? { connectionId: connectionRef } : {}),
    };
    const take = clampListTake(limit);
    // Clamp: a negative offset makes Prisma's skip throw → 500 (PR-599 review).
    const skip = Math.max(0, offset ?? 0);
    const [rows, total] = await Promise.all([
      ctx.db.connectionGrant.findMany({ where, select: GRANT_SELECT, orderBy: { createdAt: 'desc' }, take, skip }),
      ctx.db.connectionGrant.count({ where }),
    ]);
    return { items: (rows as GrantRow[]).map(projectGrant), total };
  },
};

export const connectionGrantMutations = {
  // Owner-only create. Validates scope allow-list, grantee App existence (live),
  // and a future expiry. grantedByUserId := the owner.
  createConnectionGrant: async (
    _: unknown,
    {
      connectionRef,
      appRef,
      scopes,
      expiresAt,
    }: { connectionRef: string; appRef: string; scopes: string[]; expiresAt?: string | null },
    ctx: Context,
  ) => {
    const conn = await loadOwnedConnection(ctx, connectionRef);
    // Owner-only: absence and denial are indistinguishable (no existence oracle).
    if (!conn) throw new GraphQLError('Connection not found', { extensions: { code: 'NOT_FOUND' } });

    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw badInput('At least one scope is required.');
    }
    const unknown = scopes.filter((s) => !isConnectionGrantScope(s));
    if (unknown.length > 0) {
      throw badInput(
        `Unknown scope(s): ${unknown.join(', ')}. Valid scopes: ${CONNECTION_GRANT_SCOPES.join(', ')}.`,
      );
    }
    const scopeSet = [...new Set(scopes)];

    let granteeAppId: string;
    try {
      ({ id: granteeAppId } = await resolveAppRef(ctx.db, appRef));
    } catch (e) {
      if (e instanceof AppNotFoundError) throw badInput(`Grantee App not found: '${appRef}'.`);
      throw e;
    }

    let expiry: Date | null = null;
    if (expiresAt != null) {
      // Require an explicit UTC `Z` or numeric offset — a timezone-naive string
      // (`2026-01-01T00:00:00`) parses in the SERVER's local zone, so the stored
      // instant would drift from what the caller meant (PR-599 review).
      const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
      if (!ISO_8601.test(expiresAt)) {
        throw badInput('expiresAt must be an ISO-8601 timestamp with a timezone (e.g. 2026-01-01T00:00:00Z).');
      }
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) throw badInput('expiresAt is not a valid date.');
      if (d.getTime() <= Date.now()) throw badInput('expiresAt must be in the future.');
      expiry = d;
    }

    const grant = await withAuthorizedTx(
      ctx,
      [{ kind: 'connection', id: conn.id }, { kind: 'app', id: granteeAppId }],
      async (txCtx) => {
        if (!(await loadOwnedConnection(txCtx, connectionRef))) {
          throw new GraphQLError('Connection not found', { extensions: { code: 'NOT_FOUND' } });
        }
      },
      (tx) => tx.connectionGrant.create({
        data: {
          id: generateId(),
          connectionId: conn.id,
          granteeAppId,
          grantedByUserId: ctx.userId!,
          scopes: scopeSet,
          expiresAt: expiry,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        select: GRANT_SELECT,
      }),
      { afterLock: async (tx) => {
        await tx.$queryRaw`SELECT id FROM exchange_connections WHERE id = ${conn.id} FOR KEY SHARE`;
      } },
    ) as GrantRow;
    return projectGrant(grant);
  },

  // Owner-only revoke → soft delete. findFirst + deletedAt:null (never
  // findUnique), gated on the caller being the grantor/owner.
  revokeConnectionGrant: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    // Interactive owner only — no App-key / on-behalf-of path (see loadOwnedConnection).
    if (!isInteractiveUser(ctx)) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
    const grant = await ctx.db.connectionGrant.findFirst({
      where: { id: ref, deletedAt: null, grantedByUserId: ctx.userId },
      select: { id: true, connectionId: true },
    });
    // A grant the caller didn't create (or doesn't exist) is indistinguishable.
    if (!grant) throw new GraphQLError('Grant not found', { extensions: { code: 'NOT_FOUND' } });
    await withAuthorizedTx(
      ctx,
      [{ kind: 'connection', id: grant.connectionId }],
      async (txCtx) => {
        if (!(await loadOwnedConnection(txCtx, grant.connectionId))) {
          throw new GraphQLError('Grant not found', { extensions: { code: 'NOT_FOUND' } });
        }
      },
      (tx) => tx.connectionGrant.update({
        where: { id: grant.id },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
      }),
      {
        lockMode: 'exclusive',
        afterLock: async (tx) => {
          await tx.$queryRaw`SELECT id FROM connection_grants WHERE id = ${grant.id} FOR UPDATE`;
        },
      },
    );
    return true;
  },
};
