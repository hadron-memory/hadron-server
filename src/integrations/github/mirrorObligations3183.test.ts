/**
 * #3183: `settleMirrorObligations` stamps `last_attempt_at` with the database's now(). The column is `timestamp` (no zone) and holds
 * UTC, so under a session whose TimeZone is not UTC an unconverted now() stores local wall time. Each pin runs through a client
 * whose OWN connection carries the zone; the shared test database and its session setting are untouched.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { PrismaClient } from '../../generated/prisma/index.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { settleMirrorObligations, takeAttemptSeq } from './mirrorObligations.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
const clients = new Map<string, PrismaClient>();
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
let memoryId: string;
const ref = [{ nodeId: 'n1', kind: 'WRITE' as const }];
const stamp = async () => (await db.gitMirrorObligation.findFirstOrThrow({ where: { memoryId } })).lastAttemptAt.getTime();

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: 'settle3183-org' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'm', urn: 'settle3183-org:m', class: 'knowledge' } })).id;
});
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

describe.each(ZONES)('#3183 settle stamps UTC wall time under session zone %s', zone => {
  /** The stamp must fall inside the statement's own span (a few seconds of slack for clock and rounding), never offset by the zone. */
  const within = (value: number, before: number, after: number) => {
    expect(value).toBeGreaterThanOrEqual(before - 5_000);
    expect(value).toBeLessThanOrEqual(after + 5_000);
  };

  it('first settle (INSERT) records last_attempt_at in UTC', async () => {
    const client = zoneClient(zone);
    const before = Date.now();
    await settleMirrorObligations(client, memoryId, ref, { result: 'failed', errorClass: 'PUSH_FAILED' }, await takeAttemptSeq(db));
    within(await stamp(), before, Date.now());
  });

  it('second settle on the same row (DO UPDATE) records last_attempt_at in UTC', async () => {
    const client = zoneClient(zone);
    await settleMirrorObligations(db, memoryId, ref, { result: 'failed', errorClass: 'PUSH_FAILED' }, await takeAttemptSeq(db));
    await db.gitMirrorObligation.updateMany({ where: { memoryId }, data: { lastAttemptAt: new Date(Date.now() - 24 * 60 * 60_000) } });
    const before = Date.now();
    await settleMirrorObligations(client, memoryId, ref, { result: 'failed', errorClass: 'PUSH_FAILED' }, await takeAttemptSeq(db));
    expect((await db.gitMirrorObligation.findFirstOrThrow({ where: { memoryId } })).attempts).toBe(2);
    within(await stamp(), before, Date.now());
  });
});
