/**
 * resolveAppRef — convert an entity-reference string to a
 * definite app ID. See `memoryRef.ts` for the convention.
 *
 * Apps are URN-primary in practice; ID-acceptance exists for
 * uniformity with the convention.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { AppNotFoundError } from './errors.js';
import { resolveLegacyAlias } from './legacyAlias.js';
import { findLiveUrnAliasTargets, dedupeById } from '../urnAlias.js';

export async function resolveAppRef(
  db: Pick<PrismaClient, 'app' | 'urnAlias'>,
  ref: string,
  options?: { includeDeleted?: boolean; scope?: Prisma.AppWhereInput },
): Promise<{ id: string }> {
  const isId = isIdFunc(ref);
  if (!isId) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'app');
  }
  // Spec 021 FR-027 removed `App.urn`'s @unique constraint in favor of a
  // partial unique index restricted to `uninstalled_at IS NULL`, so the URN
  // path already uses `findFirst` with the active-row filter. Use `findFirst`
  // for the ID path too so the soft-delete exclusion lives in the query for both
  // (the `{ id }` selector is still unique-backed). Normalization (prefix strip
  // + `::`→`:`) is a no-op on an ID, so it runs only on the URN path. Excluded
  // by default; `{ includeDeleted: true }` opts in (matches memoryRef).
  const deletedFilter = options?.includeDeleted ? {} : { deletedAt: null as null };
  // Reference resolution can narrow an already-authorized set without ever
  // reading an App outside it. Preserve the default resolver unchanged.
  const scoped = (where: Prisma.AppWhereInput): Prisma.AppWhereInput =>
    options?.scope ? { AND: [where, options.scope] } : where;
  const lookupUrn = isId ? null : normalizeUrnForLookup(parseUrnInput(ref).value);
  const app =
    lookupUrn === null
      ? await db.app.findFirst({
          where: scoped({ id: ref, ...deletedFilter }),
          select: { id: true },
        })
      : await db.app.findFirst({
          where: scoped({ urn: lookupUrn, uninstalledAt: null, ...deletedFilter }),
          select: { id: true },
        });
  if (app) {
    return { id: app.id };
  }
  // Alias fallback: the #697 `legacy_urn` column AND the #1079 rename map, read
  // together and deduplicated. Both keep App's active-row liveness
  // (`uninstalled_at IS NULL`), so an alias never reaches an uninstalled App.
  //
  // #1079 is what makes a renamed App's PUBLISHED worker URNs keep resolving:
  // `hrn:worker:<root>:<app-slug>:<slug>` is resolved by looking up
  // `hrn:app:<root>:<app-slug>` here first, so healing the App ref heals every
  // worker URN beneath it without workerRef knowing anything about renames.
  if (lookupUrn !== null) {
    const live = (ids: string[]) =>
      db.app.findMany({
        where: scoped({ id: { in: ids }, uninstalledAt: null, ...deletedFilter }),
        select: { id: true },
      });
    const [legacyRows, aliasRows] = await Promise.all([
      db.app.findMany({
        where: scoped({ legacyUrn: lookupUrn, uninstalledAt: null, ...deletedFilter }),
        select: { id: true },
        take: 2,
      }),
      options?.scope
        ? (async () => {
            // Constrain alias-map reads too: foreign history must not affect
            // paging, ambiguity, or the alias walk's corruption guard.
            const eligible = await db.app.findMany({
              where: scoped({ uninstalledAt: null, ...deletedFilter }),
              select: { id: true },
            });
            if (!eligible.length) return [];
            const aliases = await db.urnAlias.findMany({
              where: { urn: lookupUrn, entityType: 'APP', entityId: { in: eligible.map(row => row.id) } },
              select: { entityId: true },
              take: 2,
            });
            return aliases.map(row => ({ id: row.entityId }));
          })()
        : findLiveUrnAliasTargets(db, 'APP', lookupUrn, live),
    ]);
    // Deduplicate before the ambiguity check — the migration backfilled the map
    // FROM `legacy_urn`, so the two sources overlap by construction and a bare
    // concat would refuse a URN that resolves to exactly one App.
    const aliased = resolveLegacyAlias(ref, dedupeById(legacyRows, aliasRows));
    if (aliased) return aliased;
  }
  throw new AppNotFoundError(ref);
}
