/** #3194: own-connection zones reuse the #3182 harness; never change a shared session's zone. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { PrismaClient, type Prisma } from '../generated/prisma/index.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
import { advanceReadState, stampChannelCheck, stampTeamChannelChecks } from './channelReadState.js';
import type { RegisterAttendee } from './resolveRegister.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
const OLD = new Date('2026-01-01T00:00:00.000Z');
const clients = new Map<string, PrismaClient>();
let workerId: string;
let agentId: string;
let appId: string;
let channelId: string;
let otherId: string;

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

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'UTC read state', urn: 'utc3194.example' } });
  const agent = await db.agent.create({ data: {
    organizationId: org.id, name: 'Reader', urn: 'utc3194.example:reader', visibility: 'ORGANIZATION',
  } });
  agentId = agent.id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'utc3194.example:team' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  const memory = await db.memory.create({ data: {
    organizationId: org.id, name: 'Shared', urn: 'utc3194.example:shared', class: 'app', appId, sharedMemoryOfAgentId: agentId,
  } });
  workerId = (await db.worker.create({ data: {
    ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Reader', slug: 'reader',
  } })).id;
  const makeChannel = async (loc: string) => {
    const root = await db.node.create({ data: { memoryId: memory.id, loc, name: loc, nodeType: 'chat' } });
    return (await db.channel.create({ data: { memoryId: memory.id, loc, name: loc, chatRootNodeId: root.id } })).id;
  };
  channelId = await makeChannel('chats:team');
  otherId = await makeChannel('chats:other');
});
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

const attendee = (kind: 'worker' | 'agent'): RegisterAttendee => kind === 'worker' ? { workerId } : { agentId, appId };
const state = (tx: Prisma.TransactionClient, who: RegisterAttendee) =>
  tx.channelReadState.findFirstOrThrow({ where: { ...who, channelId } });
async function seed(who: RegisterAttendee) {
  await db.channelReadState.create({ data: {
    id: generateId(), ...who, channelId, lastSeenSeq: 7, channelIncarnation: 1, updatedAt: OLD, lastCheckedAt: OLD,
  } });
}

/** Preserve now()'s transaction clock, not just its zone. The delay makes a wall-clock substitution observable. */
async function withClock(zone: string, run: (tx: Prisma.TransactionClient, utc: Date) => Promise<void>) {
  const before = Date.now();
  await zoneClient(zone).$transaction(async tx => {
    const [clock] = await tx.$queryRaw<Array<{ zone: string; utc: Date }>>`
      SELECT current_setting('TimeZone') AS zone, (now() AT TIME ZONE 'UTC')::timestamp(3) AS utc`;
    expect(clock.zone).toBe(zone);
    expect(clock.utc.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(clock.utc.getTime()).toBeLessThanOrEqual(Date.now() + 1);
    await tx.$queryRaw`SELECT 1 AS waited FROM pg_sleep(0.02)`;
    await run(tx, clock.utc);
  });
}

describe.each(ZONES)('#3194 read-state clocks in %s', zone => {
  for (const kind of ['worker', 'agent'] as const) {
    it(`advance ${kind} INSERT writes UTC updated_at without inventing a check`, async () => {
      await withClock(zone, async (tx, utc) => {
        expect(await advanceReadState(tx, attendee(kind), channelId, 7)).toBe(7);
        const row = await state(tx, attendee(kind));
        expect(row.updatedAt).toEqual(utc);
        expect(row).toMatchObject({ lastCheckedAt: null, lastSeenSeq: 7, channelIncarnation: 1 });
      });
    });

    it(`advance ${kind} conflict writes UTC and preserves monotonic cursor/incarnation rules`, async () => {
      const who = attendee(kind);
      await seed(who);
      await db.channel.update({ where: { id: channelId }, data: { incarnation: 2 } });
      for (const seq of [5, 7, 11]) {
        await withClock(zone, async (tx, utc) => {
          expect(await advanceReadState(tx, who, channelId, seq)).toBe(Math.max(7, seq));
          const row = await state(tx, who);
          expect(row.updatedAt).toEqual(utc);
          expect(row.lastCheckedAt).toEqual(OLD);
          expect(row.channelIncarnation).toBe(seq > 7 ? 2 : 1);
        });
      }
    });
  }

  for (const kind of ['channel', 'team'] as const) {
    const stamp = async (tx: Prisma.TransactionClient) => {
      if (kind === 'channel') expect(await stampChannelCheck(tx, workerId, channelId)).toBe(true);
      else expect(await stampTeamChannelChecks(tx, workerId)).toBe(1);
    };
    it(`stamp ${kind} INSERT writes both clocks as UTC at seq zero`, async () => {
      await withClock(zone, async (tx, utc) => {
        await stamp(tx);
        const row = await state(tx, { workerId });
        expect(row.updatedAt).toEqual(utc);
        expect(row.lastCheckedAt).toEqual(utc);
        expect(row).toMatchObject({ lastSeenSeq: 0, channelIncarnation: null });
      });
    });

    it(`stamp ${kind} conflict writes UTC last_checked_at, leaving updated_at and cursor untouched`, async () => {
      await seed({ workerId });
      await withClock(zone, async (tx, utc) => {
        await stamp(tx);
        const row = await state(tx, { workerId });
        expect(row.lastCheckedAt).toEqual(utc);
        expect(row.updatedAt).toEqual(OLD);
        expect(row).toMatchObject({ lastSeenSeq: 7, channelIncarnation: 1 });
      });
    });
  }

  it('a non-team check still writes nothing', async () => {
    expect(await stampChannelCheck(zoneClient(zone), workerId, otherId)).toBe(false);
    expect(await db.channelReadState.count()).toBe(0);
  });
});
