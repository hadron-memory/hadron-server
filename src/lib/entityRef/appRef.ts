/**
 * resolveAppRef — convert an entity-reference string to a
 * definite app ID. See `memoryRef.ts` for the convention.
 *
 * Apps are URN-primary in practice; ID-acceptance exists for
 * uniformity with the convention.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { parseUrnInput } from '../urn.js';
import { AppNotFoundError } from './errors.js';

export async function resolveAppRef(
  db: Pick<PrismaClient, 'app'>,
  urn: string,
): Promise<{ id: string }> {
  const normalized = parseUrnInput(urn).value;
  const where = isId(normalized) ? { id: normalized } : { urn: normalized };
  const app = await db.app.findUnique({
    where,
    select: { id: true, deletedAt: true },
  });
  if (!app || app.deletedAt) {
    throw new AppNotFoundError(urn);
  }
  return { id: app.id };
}
