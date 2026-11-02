/**
 * #3192 (slice 2 of the #3187 time-zone audit): `ensureQuotaRow` seeds `quota_counters.reset_at`, a `timestamp` column
 * with no zone that holds UTC, from a raw-SQL bound JS Date. Bound that way the value reaches Postgres as `timestamptz` and
 * is converted through the SESSION's zone on assignment, so under a non-UTC session the daily window ends early (west of
 * UTC) or late (east of UTC) by the offset. Every pin runs through a client whose OWN connection carries the zone
 * (`options=-c TimeZone=<zone>`, the #3182 harness of sweepGitMirrorObligations3174.test.ts); the shared test database and
 * its session setting are never changed.
 *
 * The rollover pin drives the INSERT-then-reset path end to end through `reserveQuota`'s clock seam: the first call seeds
 * the row, then the window must still be open one millisecond before the next UTC midnight and must roll exactly at it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { reserveQuota } from './appRuns.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
const clients = new Map<string, PrismaClient>();

/** A client whose own connection runs in `zone`. */
function zoneClient(zone: string): PrismaClient {
  let client = clients.get(zone);
  if (!client) {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${zone}`);
    client = new PrismaClient({ datasourceUrl: url.toString() });
    clients.set(zone, client);
  }
  return client;
}

/** The next UTC midnight after `at`, the same boundary the production helper computes. */
function nextUtcMidnightAfter(at: number): Date {
  const d = new Date(at);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

const used = async (scopeId: string) =>
  (await db.quotaCounter.findFirstOrThrow({ where: { scopeKind: 'app', scopeId, action: 'run.execute' } })).used;

beforeEach(async () => { await cleanDb(db); });
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

describe.each(ZONES)('#3192 quota reset_at seeded under session zone %s', zone => {
  it('the seeded window ends at the next UTC midnight, not shifted by the session offset', async () => {
    const scopeId = generateId();
    const before = nextUtcMidnightAfter(Date.now()).getTime();
    const reservation = await reserveQuota(zoneClient(zone), 'app', scopeId, 'run.execute', 5, 1);
    const after = nextUtcMidnightAfter(Date.now()).getTime();
    const row = await db.quotaCounter.findFirstOrThrow({ where: { scopeKind: 'app', scopeId, action: 'run.execute' } });
    // `before === after` except when the call straddles a UTC midnight; either boundary is then correct.
    expect([before, after]).toContain(row.resetAt.getTime());
    expect(reservation).not.toBeNull();
  });

  it('rollover: the counter resets at the same UTC instant as under UTC, neither early nor late', async () => {
    const scopeId = generateId();
    const client = zoneClient(zone);
    // The UTC day boundary the window must end at. Seed through the INSERT (first touch) with the real clock: used = 1.
    const boundary = nextUtcMidnightAfter(Date.now()).getTime();
    expect(await reserveQuota(client, 'app', scopeId, 'run.execute', 10, 1)).not.toBeNull();
    // A call straddling a UTC midnight would have seeded the following day; the scenario needs the same day.
    expect(nextUtcMidnightAfter(Date.now()).getTime()).toBe(boundary);
    // One millisecond before the boundary the window is still open: the reservation adds to it.
    await reserveQuota(client, 'app', scopeId, 'run.execute', 10, 1, () => new Date(boundary - 1));
    expect(await used(scopeId)).toBe(2);
    // At the boundary the window rolls: used resets, then this reservation lands in the new day.
    await reserveQuota(client, 'app', scopeId, 'run.execute', 10, 1, () => new Date(boundary));
    expect(await used(scopeId)).toBe(1);
  });
});
