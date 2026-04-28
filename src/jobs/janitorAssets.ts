// janitorAssets — purge soft-deleted assets whose 24h recovery window has
// elapsed. Deletes the R2 object first, then hard-deletes the node. Safe to
// re-run; idempotent.
//
// Spec: hadron-portal/specs/001-asset-upload/research.md §R-013
//
// Run via:
//   yarn server:janitor:assets  (after adding the script to package.json,
//                                see follow-up T059)
//   tsx src/jobs/janitorAssets.ts
//
// TODO: orphan-key reaping (R2 objects with no matching active asset node)
// requires ListObjectsV2 paging. Out of scope for v1.

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { deleteObject } from '../integrations/r2/client.js';
import { logAssetEvent } from '../lib/asset/audit.js';
import { deserializeJson } from '../integrations/db/provider.js';

interface AssetRow {
  id: string;
  memoryId: string;
  data: unknown;
  createdBy: string | null;
}

interface JanitorOutcome {
  scanned: number;
  purged: number;
  errors: number;
}

export async function runAssetJanitor(
  db: PrismaClient = defaultDb,
): Promise<JanitorOutcome> {
  const now = new Date();
  const candidates: AssetRow[] = await db.node.findMany({
    where: { nodeType: 'asset', deletedAt: null },
    select: { id: true, memoryId: true, data: true, createdBy: true },
  });

  let scanned = 0;
  let purged = 0;
  let errors = 0;

  for (const row of candidates) {
    scanned += 1;
    const data = parseObject(row.data);
    if (!data) continue;
    const purgeAt = typeof data.purgeAt === 'string' ? new Date(data.purgeAt) : null;
    if (!purgeAt || Number.isNaN(purgeAt.getTime())) continue;
    if (purgeAt > now) continue;

    const storageKey = typeof data.storageKey === 'string' ? data.storageKey : null;
    try {
      if (storageKey) await deleteObject(storageKey);
      await db.node.delete({ where: { id: row.id } });
      logAssetEvent({
        operation: 'purged',
        assetId: row.id,
        memoryId: row.memoryId,
        userId: row.createdBy ?? undefined,
        bytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : undefined,
      });
      purged += 1;
    } catch (e) {
      errors += 1;
      logAssetEvent({
        operation: 'purged',
        assetId: row.id,
        memoryId: row.memoryId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { scanned, purged, errors };
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      return deserializeJson(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}

// Allow `tsx src/jobs/janitorAssets.ts` to run the janitor directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  runAssetJanitor()
    .then((outcome) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ...outcome, ranAt: new Date().toISOString() }));
      process.exit(outcome.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
