/**
 * resolveAppRef — convert an entity-reference string to a
 * definite app ID. See `memoryRef.ts` for the convention.
 *
 * Apps are URN-primary in practice; ID-acceptance exists for
 * uniformity with the convention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn, normalizeUrnForLookup } from '../urn.js';
import { AppNotFoundError } from './errors.js';

export async function resolveAppRef(
  db: Pick<PrismaClient, 'app'>,
  ref: string,
): Promise<{ id: string }> {
  if (!isId(ref)) {
    // Non-ID inputs MUST be fully-qualified URNs (spec 022).
    assertFullyQualifiedUrn(ref, 'app');
  }
  const normalized = normalizeUrnForLookup(parseUrnInput(ref).value);
  // Spec 021 FR-027 removed `App.urn`'s @unique constraint in favor of
  // a partial unique index restricted to `uninstalled_at IS NULL`. So
  // `findUnique({ where: { urn } })` is no longer well-typed — use
  // `findFirst` with the active-row filter for URN lookups. ID lookups
  // still use the PK.
  const app = isId(normalized)
    ? await db.app.findUnique({
        where: { id: normalized },
        select: { id: true, deletedAt: true },
      })
    : await db.app.findFirst({
        where: { urn: normalized, uninstalledAt: null },
        select: { id: true, deletedAt: true },
      });
  if (!app || app.deletedAt) {
    throw new AppNotFoundError(ref);
  }
  return { id: app.id };
}
