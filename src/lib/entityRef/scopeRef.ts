/**
 * resolveScopeRef — convert a scope reference to a definite Scope id
 * (spec 049 Phase 2). See `memoryRef.ts` for the convention.
 *
 * A Scope has NO `urn` column and, for now, no URN at all: the URN grammar for
 * a scope (`hrn:scope:…` and how it carries its owner) is a cross-repo parser
 * decision this slice does not make — reported to the coordinator rather than
 * invented here. So a scope is addressed by its id, or by NAME within an App's
 * context through `resolveScopeByNameInApp` (`lib/scopes.ts`), never here.
 * Soft-deleted rows never resolve.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { ScopeNotFoundError } from './errors.js';

export async function resolveScopeRef(
  db: Pick<PrismaClient, 'scope'>,
  ref: string,
): Promise<{ id: string }> {
  if (!isIdFunc(ref)) throw new ScopeNotFoundError(ref);
  const scope = await db.scope.findFirst({ where: { id: ref, deletedAt: null }, select: { id: true } });
  if (!scope) throw new ScopeNotFoundError(ref);
  return { id: scope.id };
}
