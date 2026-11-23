/**
 * #3539 — the alarm reporting line, a leaf shared by the dark-worker alarm and the post-limit alarm so the latter does not
 * reach `darkWorker.ts` (and through its literal dynamic imports the GraphQL resolvers). `darkWorker.ts` re-exports it, so
 * every existing import keeps working. The body is moved verbatim: it runs on the exact client it is given, and only an
 * empty live line falls back to the App's managers.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { appManagerUserIds } from '../auth/appManagement.js';
import type { AlarmChain } from './events.js';

/** The live same-App reporting line, nearest first; only an empty line falls back to App managers (cor:agt:050:18/:26, #3358). */
export async function darkAlarmChain(db: Prisma.TransactionClient | PrismaClient, app: { id: string; organizationId: string | null; ownerUserId: string | null }, workerId: string): Promise<AlarmChain> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE up AS (
      SELECT w.reports_to_worker_id AS id, 1 AS depth FROM workers w WHERE w.id = ${workerId} AND w.reports_to_worker_id IS NOT NULL
      UNION ALL
      SELECT w.reports_to_worker_id, up.depth + 1 FROM workers w JOIN up ON w.id = up.id
      WHERE w.reports_to_worker_id IS NOT NULL AND up.depth < 64
    )
    SELECT up.id FROM up JOIN workers h ON h.id = up.id AND h.app_id = ${app.id} AND h.retired_at IS NULL ORDER BY up.depth`;
  const chain: AlarmChain = [];
  const seen = new Set<string>([workerId]);
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    chain.push({ workerId: r.id });
  }
  if (chain.length === 0) {
    for (const userId of await appManagerUserIds(db, app)) chain.push({ userId, via: 'manager' });
  }
  return chain;
}
