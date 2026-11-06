import type { Prisma } from '../generated/prisma/index.js';
import { resolveAppRef } from '../lib/entityRef/appRef.js';
import { resolveWorkerRef } from '../lib/entityRef/workerRef.js';
import { isId } from '../lib/entityRef/shape.js';
import { AppNotFoundError, WorkerNotFoundError, AmbiguousLegacyUrnError } from '../lib/entityRef/errors.js';
import { assertFullyQualifiedUrn, hasSchemePrefix } from '../lib/urn.js';

type Selection = { kind: 'matched'; where: Prisma.SessionWhereInput } | { kind: 'missing' | 'ambiguous' };

/** Narrow the complete caller-session set, never the first page or a global entity lookup. */
export async function whoamiSessionFilter(
  tx: Prisma.TransactionClient,
  authorized: Prisma.SessionWhereInput,
  filters: { app?: string; workerRef?: string },
): Promise<Selection> {
  let where = authorized;
  try {
    if (filters.app !== undefined) {
      if (typeof filters.app !== 'string') return { kind: 'missing' };
      const ref = filters.app.trim();
      if (!isId(ref)) {
        // Malformed input is concealed like an absent ref, not a DB error.
        try { assertFullyQualifiedUrn(ref, 'app'); } catch { return { kind: 'missing' }; }
      }
      const { id } = await resolveAppRef(tx, ref, { scope: { sessions: { some: authorized } } });
      where = { AND: [where, { appId: id }] };
    }
    if (filters.workerRef !== undefined) {
      if (typeof filters.workerRef !== 'string' || !filters.workerRef.trim()) return { kind: 'missing' };
      const ref = filters.workerRef.trim();
      const scope: Prisma.WorkerWhereInput = { sessions: { some: where } };
      let id: string;
      if (isId(ref) || hasSchemePrefix(ref)) {
        ({ id } = await resolveWorkerRef(tx, ref, { scope, appScope: { sessions: { some: where } } }));
      } else {
        const workers = await tx.worker.findMany({
          where: { AND: [scope, { OR: [{ name: { equals: ref, mode: 'insensitive' } }, { slug: ref.toLowerCase() }] }] },
          select: { id: true }, take: 2,
        });
        if (workers.length === 0) return { kind: 'missing' };
        if (workers.length > 1) return { kind: 'ambiguous' };
        id = workers[0].id;
      }
      where = { AND: [where, { workerId: id }] };
    }
    return { kind: 'matched', where };
  } catch (error) {
    if (error instanceof AppNotFoundError || error instanceof WorkerNotFoundError) return { kind: 'missing' };
    if (error instanceof AmbiguousLegacyUrnError) return { kind: 'ambiguous' };
    throw error;
  }
}
