/**
 * #3198 (time-zone audit slice 9): `node_embeddings.created_at` is `timestamp(3)` (no zone) holding UTC. The vector
 * writes stamped it with a bare `now()`, which the assignment converts to the SESSION's local time, so under a non-UTC
 * session the row was shifted by the offset. No trigger on `node_embeddings` rewrites the column (checked in
 * prisma/*.sql and the migrations), so the statement's own value is what is stored.
 *
 * Each pin runs the write through a client whose OWN connection carries the zone (`options=-c TimeZone=<zone>`, the
 * #3174 harness); the shared test database and its session setting are never changed. The stored value is compared
 * with UTC now on the database clock, so no JS Date crosses a zone boundary in the assertion.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { PrismaClient } from '../../generated/prisma/index.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { upsertAbstractVector, upsertChunkVectors } from './vectors.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
const DIM = 768;
const BOUND_SECONDS = 60;
const unit = (): number[] => { const v = new Array(DIM).fill(0); v[0] = 1; return v; };
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

let memoryId: string;
let nodeId: string;

/** Seconds between the stored created_at and UTC now, both naive UTC, on the shared (UTC) client. */
async function skewSeconds(kind: 'abstract' | 'chunk'): Promise<number[]> {
  const rows = await db.$queryRaw<{ skew: number }[]>`
    SELECT EXTRACT(EPOCH FROM (created_at - (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)))::float8 AS skew
    FROM node_embeddings WHERE node_id = ${nodeId} AND kind = ${kind}::"EmbeddingKind"`;
  return rows.map(r => r.skew);
}

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'vec-3198-org', graphName: 'vec/3198' });
  memoryId = made.graph.id;
  await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: true } });
  nodeId = generateId();
  await db.node.create({ data: { id: nodeId, memoryId, loc: 'tz.target', name: 'tz target' } });
});
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

describe.each(ZONES)('#3198 vector created_at is UTC under session zone %s', zone => {
  const abstractRow = () => ({ nodeId, memoryId, provider: 'local', model: 'm', dim: DIM, embedding: unit() });

  it('abstract INSERT stamps UTC now', async () => {
    expect(await upsertAbstractVector(zoneClient(zone), abstractRow())).toBe(true);
    const skew = await skewSeconds('abstract');
    expect(skew).toHaveLength(1);
    expect(Math.abs(skew[0])).toBeLessThan(BOUND_SECONDS);
  });

  it('abstract ON CONFLICT update re-stamps UTC now', async () => {
    expect(await upsertAbstractVector(db, abstractRow())).toBe(true);
    // Backdate on the shared client so only the conflict branch can bring it back to now.
    await db.$executeRaw`UPDATE node_embeddings SET created_at = created_at - interval '2 days' WHERE node_id = ${nodeId}`;
    expect(await upsertAbstractVector(zoneClient(zone), abstractRow())).toBe(true);
    const skew = await skewSeconds('abstract');
    expect(skew).toHaveLength(1);
    expect(Math.abs(skew[0])).toBeLessThan(BOUND_SECONDS);
  });

  it('chunk INSERT stamps UTC now', async () => {
    const rows = [0, 1].map(i => ({
      nodeId, memoryId, provider: 'local', model: 'm', dim: DIM,
      chunkIndex: i, charStart: i * 10, charEnd: i * 10 + 10, chunkText: `chunk ${i}`, embedding: unit(),
    }));
    expect(await upsertChunkVectors(zoneClient(zone), nodeId, rows)).toBe(true);
    const skew = await skewSeconds('chunk');
    expect(skew).toHaveLength(2);
    for (const s of skew) expect(Math.abs(s)).toBeLessThan(BOUND_SECONDS);
  });
});
