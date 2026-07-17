/**
 * resolveAppRef — convert an entity-reference string to a
 * definite app ID. See `memoryRef.ts` for the convention.
 *
 * Apps are URN-primary in practice; ID-acceptance exists for
 * uniformity with the convention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { AppNotFoundError } from './errors.js';
import { resolveLegacyAlias } from './legacyAlias.js';

export async function resolveAppRef(
  db: Pick<PrismaClient, 'app'>,
  ref: string,
  options?: { includeDeleted?: boolean },
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
  const lookupUrn = isId ? null : normalizeUrnForLookup(parseUrnInput(ref).value);
  const app =
    lookupUrn === null
      ? await db.app.findFirst({
          where: { id: ref, ...deletedFilter },
          select: { id: true },
        })
      : await db.app.findFirst({
          where: { urn: lookupUrn, uninstalledAt: null, ...deletedFilter },
          select: { id: true },
        });
  if (app) {
    return { id: app.id };
  }
  // #697 stored-alias-map fallback — see memoryRef. The alias match keeps App's
  // active-row liveness (`uninstalled_at IS NULL`). Inert until migration.
  if (lookupUrn !== null) {
    const aliased = resolveLegacyAlias(
      ref,
      await db.app.findMany({
        where: { legacyUrn: lookupUrn, uninstalledAt: null, ...deletedFilter },
        select: { id: true },
        take: 2,
      }),
    );
    if (aliased) return aliased;
  }
  throw new AppNotFoundError(ref);
}
