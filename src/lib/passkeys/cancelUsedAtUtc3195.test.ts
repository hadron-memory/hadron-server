/**
 * #3195 (time-zone audit slice 6, #3187): `passkey_cancel_tokens.used_at` is a `timestamp(3)` (no zone) column that holds
 * UTC, like every other clock in `cancelFirstPasskey`. The spend wrote a bare `clock_timestamp()`, which a session whose
 * TimeZone is not UTC converts to its own local time, shifting `used_at` by the offset. Every pin runs the cancel through a
 * client whose OWN connection carries the zone (`options=-c TimeZone=<zone>`, the #3174 harness); the shared test
 * database and its session setting are never changed. The single-use refusal and the window refusal must hold in every zone.
 *
 * The BEFORE UPDATE trigger `hadron_guard_passkey_cancel_token` (prisma/passkey-registration-invariants.sql) replaces any
 * newly set `used_at` with its own UTC clock, so the stored value was already right on every zone and the first three pins
 * are regression pins, green on main. The last pin runs the cancel on a connection that also carries
 * `session_replication_role=replica`, which skips that trigger, so it observes what the application's own statement writes.
 * That one is red on main under a non-UTC zone.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { PrismaClient } from '../../generated/prisma/index.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { cancelFirstPasskey, issueCancelToken } from './cancel.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
/** How far `used_at` may sit from the test's own UTC clock: generous for a slow CI shard, far below any zone offset. */
const BOUND_MS = 60_000;
const req = { ip: '203.0.113.7', userAgent: 'Mail/1.0' };
const clients = new Map<string, PrismaClient>();

/** A client whose own connection runs in `zone`; with `bypassTriggers`, also with ordinary triggers skipped. */
function zoneClient(zone: string, bypassTriggers = false): PrismaClient {
  const key = `${zone}|${bypassTriggers}`;
  let client = clients.get(key);
  if (!client) {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${zone}${bypassTriggers ? ' -c session_replication_role=replica' : ''}`);
    client = new PrismaClient({ datasourceUrl: url.toString() });
    clients.set(key, client);
  }
  return client;
}

let first: string;
let token: string;

beforeEach(async () => {
  await cleanDb(db);
  const ana = (await db.user.create({ data: { handle: 'cancel3195-ana', roles: [] } })).id;
  first = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
  token = await db.$transaction((tx) => issueCancelToken(tx, first));
});
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

const usedAt = async () => (await db.passkeyCancelToken.findUniqueOrThrow({ where: { passkeyId: first } })).usedAt;
const cred = () => db.passkeyCredential.findUniqueOrThrow({ where: { id: first } });

/** Move the window's end into the past, as cancel1631.test.ts does. */
async function runOut(id: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw`UPDATE passkey_credentials SET registered_at = registered_at - interval '73 hours',
      window_ends_at = window_ends_at - interval '73 hours' WHERE id = ${id}`;
  });
}

describe.each(ZONES)('#3195 cancel token used_at under session zone %s', zone => {
  it('records used_at as UTC now, alongside the credential\'s own UTC cancel time', async () => {
    const before = Date.now();
    expect(await cancelFirstPasskey(zoneClient(zone), { token, ...req })).toBe(true);
    const after = Date.now();
    const used = await usedAt();
    expect(used).not.toBeNull();
    const t = used!.getTime();
    expect(t, `used_at ${used!.toISOString()} is outside [now - ${BOUND_MS}ms, now + ${BOUND_MS}ms]`)
      .toBeGreaterThanOrEqual(before - BOUND_MS);
    expect(t, `used_at ${used!.toISOString()} is outside [now - ${BOUND_MS}ms, now + ${BOUND_MS}ms]`)
      .toBeLessThanOrEqual(after + BOUND_MS);
    // revoked_at is the transaction clock, used_at the statement clock after it: same zone, never earlier.
    const revoked = (await cred()).revokedAt!.getTime();
    expect(t).toBeGreaterThanOrEqual(revoked);
    expect(t - revoked).toBeLessThan(BOUND_MS);
  });

  it('a token spent in this zone is refused the second time and changes nothing', async () => {
    const client = zoneClient(zone);
    expect(await cancelFirstPasskey(client, { token, ...req })).toBe(true);
    const spent = await usedAt();
    const c = await cred();
    expect(await cancelFirstPasskey(client, { token, ip: '198.51.100.1', userAgent: 'Other' })).toBe(false);
    expect((await usedAt())?.getTime()).toBe(spent?.getTime());
    expect((await cred()).cancelIp).toBe(c.cancelIp);
  });

  it('a token whose window has ended is refused and stays unspent', async () => {
    await runOut(first);
    expect(await cancelFirstPasskey(zoneClient(zone), { token, ...req })).toBe(false);
    expect(await usedAt()).toBeNull();
    expect((await cred()).revokedAt).toBeNull();
  });

  it('the cancel statement itself writes UTC, not session-zone time, when the guard trigger does not run', async () => {
    const before = Date.now();
    expect(await cancelFirstPasskey(zoneClient(zone, true), { token, ...req })).toBe(true);
    const after = Date.now();
    const t = (await usedAt())!.getTime();
    expect(t, `used_at ${new Date(t).toISOString()} is outside [now - ${BOUND_MS}ms, now + ${BOUND_MS}ms]`)
      .toBeGreaterThanOrEqual(before - BOUND_MS);
    expect(t, `used_at ${new Date(t).toISOString()} is outside [now - ${BOUND_MS}ms, now + ${BOUND_MS}ms]`)
      .toBeLessThanOrEqual(after + BOUND_MS);
  });
});
