/** #3193: own-connection zones follow sweepGitMirrorObligations3174.test.ts; never change the shared DB zone. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { postgresRetrievalProvider as retrieval } from './retrieval/postgres.js';
import type { NodeSqlFilter } from './retrieval/provider.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
const clients = new Map<string, PrismaClient>();
let memoryId: string;

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
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'timezone3193', graphName: 'memory' });
  memoryId = graph.id;
});
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

async function reuseFixture(client: PrismaClient) {
  const args = { memoryId, loc: 'chats:room', name: 'room', createdBy: null };
  const first = await ensureChannelWithRoot(db, args);
  const old = await db.node.create({ data: {
    id: generateId(), memoryId, loc: 'chats:room:messages:old', name: 'old', nodeType: 'record',
  } });
  const outside = await db.node.create({ data: { id: generateId(), memoryId, loc: 'outside', name: 'outside' } });
  const edge = await db.edge.create({ data: {
    id: generateId(), memoryId, sourceId: old.id, targetId: outside.id, loc: 'old:ref:outside', name: 'ref',
  } });
  // Same persistent state as deleteChannel: the root hides its live descendants until address reuse.
  await db.channel.update({ where: { id: first.channel.id }, data: { deletedAt: new Date() } });
  await db.node.update({ where: { id: first.rootId }, data: { deletedAt: new Date() } });
  const before = Date.now();
  await ensureChannelWithRoot(client, args);
  const after = Date.now();
  return { before, after, old, edge, outside };
}

function expectUtcStamp(stamp: Date | null, before: number, after: number) {
  expect(stamp).not.toBeNull();
  expect(stamp!.getTime()).toBeGreaterThanOrEqual(before);
  expect(stamp!.getTime()).toBeLessThanOrEqual(after);
}

describe.each(ZONES)('#3193 bound timestamps with session %s', zone => {
  it('Channel reuse stamps old edges with the UTC instant, leaving unrelated nodes live', async () => {
    const { before, after, edge, outside } = await reuseFixture(zoneClient(zone));
    const row = await db.edge.findUniqueOrThrow({ where: { id: edge.id } });
    expectUtcStamp(row.deletedAt, before, after);
    expectUtcStamp(row.updatedAt, before, after);
    expect(row.updatedAt).toEqual(row.deletedAt);
    expect((await db.node.findUniqueOrThrow({ where: { id: outside.id } })).deletedAt).toBeNull();
  });

  it('Channel reuse stamps old nodes with the UTC instant', async () => {
    const { before, after, old } = await reuseFixture(zoneClient(zone));
    const row = await db.node.findUniqueOrThrow({ where: { id: old.id } });
    expectUtcStamp(row.deletedAt, before, after);
    expectUtcStamp(row.updatedAt, before, after);
    expect(row.updatedAt).toEqual(row.deletedAt);
  });

  for (const bound of ['updatedAfter', 'updatedBefore'] as const) {
    it(`retrieval ${bound} keeps inclusive UTC bounds in browse/count/lexical/regex`, async () => {
      const client = zoneClient(zone);
      const boundary = new Date('2026-01-15T12:00:00.000Z');
      const rows = await Promise.all([-1, 0, 1].map((hours, i) => db.node.create({ data: {
        id: generateId(), memoryId, loc: `match${i}`, name: 'needle',
        updatedAt: new Date(boundary.getTime() + hours * 3_600_000),
      } })));
      const expected = (bound === 'updatedAfter' ? rows.slice(1) : rows.slice(0, 2)).map(r => r.id).sort();
      // A canonical ISO ::timestamp control is independent of session zone.
      const iso = boundary.toISOString();
      const control = bound === 'updatedAfter'
        ? await client.$queryRaw<Array<{ id: string }>>`SELECT id FROM nodes WHERE memory_id = ${memoryId} AND updated_at >= ${iso}::timestamp`
        : await client.$queryRaw<Array<{ id: string }>>`SELECT id FROM nodes WHERE memory_id = ${memoryId} AND updated_at <= ${iso}::timestamp`;
      expect(control.map(r => r.id).sort()).toEqual(expected);
      // Same instant with a nonzero caller offset; dropping its offset would change even the UTC control.
      for (const value of [iso, '2026-01-15T14:00:00.000+02:00']) {
        const filter: NodeSqlFilter = { [bound]: value };
        const opts = { db: client, memoryIds: [memoryId], filter, limit: 10 };
        expect((await retrieval.filterSearch(opts)).sort()).toEqual(expected);
        expect(await retrieval.filterCount(opts)).toBe(expected.length);
        expect((await retrieval.lexicalSearch({ ...opts, query: 'needle' })).map(r => r.nodeId).sort()).toEqual(expected);
        expect((await retrieval.regexSearch({ ...opts, pattern: 'needle' })).map(r => r.nodeId).sort()).toEqual(expected);
      }
    });
  }

  it('retrieval treats an accepted date-only bound as UTC, matching the ORM date parse', async () => {
    const client = zoneClient(zone);
    const at = new Date('2026-01-15');
    const rows = await Promise.all([-1, 0, 1].map((hours, i) => db.node.create({ data: {
      id: generateId(), memoryId, loc: `date${i}`, name: 'date',
      updatedAt: new Date(at.getTime() + hours * 3_600_000),
    } })));
    const ids = await retrieval.filterSearch({
      db: client, memoryIds: [memoryId], limit: 10,
      filter: { updatedAfter: '2026-01-15', updatedBefore: '2026-01-15' },
    });
    expect(ids).toEqual([rows[1].id]);
    const control = await db.node.findMany({ where: { memoryId, updatedAt: { gte: at, lte: at } } });
    expect(control.map(r => r.id)).toEqual(ids);
  });
});
