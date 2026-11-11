/**
 * #3774 — `uninstallApp` / `reinstallApp` (hrn:node:hadronmemory.com:specs:cor:dmo:050:21; Holger R1-R3, 2026-11-09).
 *
 * R1: the gate is `deleteApp`'s, the SAME call (`requireOwnerOrOrgRole(…, 'ADMIN')`), re-checked inside the transaction.
 * R2: a reinstall clears the stamp on the SAME row and is refused `APP_URN_IN_USE` while another installed App holds the
 *     handle (`apps_urn_active_uniq WHERE uninstalled_at IS NULL`); it never creates a row.
 * R3: an uninstall ends every open dark-worker episode of the App's workers at the uninstall time, in the same transaction.
 *
 * NO EXISTENCE ORACLE: a missing App and a caller who fails the gate get the one `authorizationDenied()`; only a caller who
 * passes the gate learns the App's state (deleted, handle taken). The lock order is deleteApp's (app/org/user anchors, then
 * `apps FOR UPDATE`), and the state is judged AFTER the lock.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { AmbiguousLegacyUrnError, AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { normalizeUrnForLookup, parseUrnInput } from '../../../lib/urn.js';
import { findLiveUrnAliasTargets } from '../../../lib/urnAlias.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { requireOwnerOrOrgRole, type Context } from './resolvers.helpers.js';

type AppRow = { id: string; organizationId: string | null; ownerUserId: string | null };

/**
 * The App a ref names, whatever its state; null when none. An ID names that row. A URN names the INSTALLED App that holds it
 * and, when none does, the one uninstalled, undeleted App with it (two or more: ambiguous, name one by id). Both calls share
 * this rule, so a repeat by URN reaches the same App as the first call did (the installed holder, once reinstalled) and a
 * historical uninstalled App with the same handle is never retargeted while an installed holder exists.
 */
async function locate(ctx: Context, ref: string): Promise<AppRow | null> {
  const select = { id: true, organizationId: true, ownerUserId: true } as const;
  if (isId(ref)) return ctx.db.app.findUnique({ where: { id: ref }, select });
  try {
    const { id } = await resolveAppRef(ctx.db, ref);
    return await ctx.db.app.findUnique({ where: { id }, select });
  } catch (e) {
    if (!(e instanceof AppNotFoundError)) throw e;
  }
  const urn = normalizeUrnForLookup(parseUrnInput(ref).value);
  const rows = await ctx.db.app.findMany({ where: { urn, uninstalledAt: { not: null }, deletedAt: null }, select, take: 2 });
  return rows.length === 1 ? rows[0]! : null;
}

async function setInstalled(ctx: Context, ref: string, install: boolean): Promise<true> {
  const found = await locate(ctx, ref);
  if (!found) throw authorizationDenied();
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: found.id } });
  await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
  try {
    await withAuthorizedTx(
      ctx,
      [
        { kind: 'app', id: app.id },
        ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
        ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
      ],
      async (txCtx) => {
        const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: app.id } });
        if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
          throw new Error('App ownership changed; retry');
        }
        await requireOwnerOrOrgRole(txCtx, current, 'ADMIN');
      },
      async (tx) => {
        const current = await tx.app.findUniqueOrThrow({ where: { id: app.id } });
        // Judged after the lock. A deleted App is never revived or touched (no undelete, cor:dmo:050:21).
        if (current.deletedAt) {
          throw new GraphQLError('This App is deleted.', { extensions: { code: 'APP_DELETED', appId: app.id } });
        }
        if (install) {
          if (!current.uninstalledAt) return; // already installed: a no-op
          const holder = await tx.app.findFirst({ where: { urn: current.urn, uninstalledAt: null, NOT: { id: current.id } }, select: { id: true } });
          if (holder) throw urnInUse(current.id, current.urn);
          await tx.app.update({ where: { id: current.id }, data: { uninstalledAt: null, updatedBy: ctx.userId ?? null } });
          return;
        }
        if (current.uninstalledAt) return; // already uninstalled: no second stamp
        const now = new Date();
        await tx.app.updateMany({ where: { id: current.id, uninstalledAt: null, deletedAt: null }, data: { uninstalledAt: now, updatedBy: ctx.userId ?? null } });
        // R3: end the App's open dark-worker episodes at the uninstall time (never before the open: the row's CHECK).
        const open = await tx.darkWorkerEpisode.findMany({ where: { appId: current.id, endedAt: null }, select: { id: true, openedAt: true } });
        for (const e of open) {
          await tx.darkWorkerEpisode.updateMany({ where: { id: e.id, endedAt: null }, data: { endedAt: e.openedAt > now ? e.openedAt : now } });
        }
      },
      { lockMode: 'exclusive', allowInactiveApp: true, afterLock: async (tx) => { await tx.$queryRaw`SELECT id FROM apps WHERE id = ${app.id} FOR UPDATE`; } },
    );
  } catch (e) {
    // A create that took the handle between the check and the write trips the partial unique index.
    if (install && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && String(e.meta?.target ?? '').includes('urn')) {
      const urn = (await ctx.db.app.findUnique({ where: { id: app.id }, select: { urn: true } }))?.urn ?? null;
      throw urnInUse(app.id, urn);
    }
    throw e;
  }
  return true;
}

const urnInUse = (appId: string, urn: string | null): GraphQLError =>
  new GraphQLError('Another installed App holds this App\'s handle; reinstall refused.', { extensions: { code: 'APP_URN_IN_USE', appId, urn } });

export const uninstallApp = (ctx: Context, ref: string) => setInstalled(ctx, ref, false);
export const reinstallApp = (ctx: Context, ref: string) => setInstalled(ctx, ref, true);

/**
 * #3975 — what `deleteApp`'s ref names, for the gate to judge. By id: that row in ANY state (so the gate, not the lookup,
 * answers a refused caller, and the state refusal follows it). By URN: the INSTALLED, undeleted App that holds it (what
 * `resolveAppRef` reaches). `none` when nothing does; a URN with no installed holder reads as `none`, so an uninstalled App
 * is reached by id only (#3974's FIT). `ambiguous` carries EVERY live claimant of a legacy URN: the caller learns of the
 * ambiguity only when the gate admits them on all of them (never one, which would show another tenant's App exists).
 */
export type DeleteTarget =
  | { kind: 'none' }
  | { kind: 'app'; app: AppFull }
  | { kind: 'ambiguous'; ref: string; candidates: AppFull[] };
type AppFull = NonNullable<Awaited<ReturnType<Context['db']['app']['findUnique']>>>;

export async function locateForDelete(ctx: Context, ref: string): Promise<DeleteTarget> {
  const byId = async (id: string): Promise<DeleteTarget> => {
    const app = await ctx.db.app.findUnique({ where: { id } });
    return app ? { kind: 'app', app } : { kind: 'none' };
  };
  if (isId(ref)) return byId(ref);
  try {
    return await byId((await resolveAppRef(ctx.db, ref)).id);
  } catch (e) {
    if (e instanceof AppNotFoundError) return { kind: 'none' };
    if (!(e instanceof AmbiguousLegacyUrnError)) throw e;
  }
  // Every live claimant, read the way resolveAppRef reads them (the legacy column and the rename map), uncapped by its take: 2.
  const urn = normalizeUrnForLookup(parseUrnInput(ref).value);
  const live = (ids: string[]) => ctx.db.app.findMany({ where: { id: { in: ids }, uninstalledAt: null, deletedAt: null } });
  const [legacy, aliased] = await Promise.all([
    ctx.db.app.findMany({ where: { legacyUrn: urn, uninstalledAt: null, deletedAt: null } }),
    findLiveUrnAliasTargets(ctx.db, 'APP', urn, live, { all: true }),
  ]);
  const byKey = new Map([...legacy, ...aliased].map((a) => [a.id, a]));
  return { kind: 'ambiguous', ref, candidates: [...byKey.values()] };
}
