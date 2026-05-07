/**
 * Reader / writer for the 011 release marker (R-4, FR-023).
 *
 * The marker is persisted as a single row in the `system_config` table
 * (key: `memory.011.release_marker`, value: `{ deployedAt: ISO-string }`).
 * The migration that introduces the table inserts the row at deploy time
 * with `ON CONFLICT DO NOTHING`; this helper provides a typed read path for
 * the retention sweep and a defensive writer for environments where the
 * migration didn't seed it (e.g., test setup).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export const RELEASE_MARKER_KEY = 'memory.011.release_marker';

type MarkerValue = { deployedAt: string };

function isMarkerValue(value: unknown): value is MarkerValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'deployedAt' in value &&
    typeof (value as { deployedAt: unknown }).deployedAt === 'string'
  );
}

/** Returns the release marker timestamp, or `null` if missing / malformed. */
export async function readReleaseMarker(
  db: Pick<PrismaClient, 'systemConfig'>,
): Promise<Date | null> {
  const row = await db.systemConfig.findUnique({
    where: { key: RELEASE_MARKER_KEY },
  });
  if (!row) {
    return null;
  }
  if (!isMarkerValue(row.value)) {
    return null;
  }
  const parsed = new Date(row.value.deployedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

/**
 * Writes the release marker iff it is not already present. Idempotent:
 * subsequent calls return the existing value without overwriting it. The
 * migration's ON CONFLICT DO NOTHING gives the same behavior at deploy time;
 * this function is the equivalent escape hatch for tests and out-of-band
 * setup.
 */
export async function writeReleaseMarkerIfMissing(
  db: Pick<PrismaClient, 'systemConfig'>,
  deployedAt: Date,
): Promise<Date> {
  const existing = await readReleaseMarker(db);
  if (existing !== null) {
    return existing;
  }
  await db.systemConfig.upsert({
    where: { key: RELEASE_MARKER_KEY },
    create: {
      key: RELEASE_MARKER_KEY,
      value: { deployedAt: deployedAt.toISOString() },
    },
    // upsert's update path is intentionally no-op: even if a concurrent
    // writer raced us, we keep whichever marker landed first.
    update: {},
  });
  return deployedAt;
}
