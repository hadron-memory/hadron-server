/** #1931: operator-supplied model families, never inferred from the tool host.
 * Preview by default. Apply only to null families on newest open bindings.
 * Raw SQL deliberately preserves updated_at: a backfill must not revive a session.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { normalizeFamily } from './family.js';
export type FamilyMapping = { workerId: string; family: string };
export async function backfillSessionFamilies(db: PrismaClient, mapping: FamilyMapping[], apply = false) {
  const seen = new Set<string>();
  const rows = mapping.map(row => {
    const family = normalizeFamily(row.family);
    if (!row.workerId || !family || seen.has(row.workerId)) throw new Error('Mapping requires unique workerIds and valid model-family tokens.');
    seen.add(row.workerId);
    return { workerId: row.workerId, family };
  });
  return db.$transaction(async tx => {
    const changed: Array<{ workerId: string; sessionId: string; family: string }> = [];
    // Stable lock order makes two operator runs serialize rather than deadlock.
    for (const row of rows.sort((a, b) => a.workerId.localeCompare(b.workerId))) {
      const [worker] = await tx.$queryRaw<Array<{id: string}>>`
        SELECT id FROM workers WHERE id = ${row.workerId} AND retired_at IS NULL FOR SHARE`;
      if (!worker) continue;
      const [session] = await tx.$queryRaw<Array<{id: string; family: string | null}>>`
        SELECT id, family FROM sessions WHERE worker_id = ${row.workerId} AND ended_at IS NULL AND deleted_at IS NULL
        ORDER BY started_at DESC, id DESC LIMIT 1 FOR UPDATE`;
      if (!session || session.family !== null) continue;
      if (apply) await tx.$executeRaw`UPDATE sessions SET family = ${row.family} WHERE id = ${session.id} AND family IS NULL`;
      changed.push({ workerId: row.workerId, sessionId: session.id, family: row.family });
    }
    return changed;
  });
}
