/**
 * #3183 (combined, needs #3174's naive-UTC binds on main): a debt settled through `settleMirrorObligations` is then retried by
 * `gitMirrorSweepTick` at the exact backoff boundary, with BOTH running on a client whose own connection is not UTC. The row
 * is stamped in real time, so a stamp shifted by the zone offset makes the row due immediately (west of UTC) or hours late (east).
 * Fixtures need no Git: a due debt for a node that does not exist is cleared without any Git command.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../integrations/db/client.js';
import { PrismaClient } from '../generated/prisma/index.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { settleMirrorObligations, takeAttemptSeq } from '../integrations/github/mirrorObligations.js';

const env = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
import { gitMirrorSweepTick } from './sweepGitMirrorObligations.js';

const ORG_URN = 'settle3183-org';
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

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'bindi-settle3183-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(env.root, { recursive: true, force: true }); });
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

describe.each(ZONES)('#3183 settle then tick under session zone %s', zone => {
  // First settle creates the row (INSERT, attempts 1, 5 minute backoff); a settle on an existing row takes DO UPDATE
  // (attempts 2, 10 minute backoff). Each statement stamps last_attempt_at, so each needs its own end-to-end pin.
  it.each([
    { path: 'INSERT', existing: false, attempts: 1, insideMin: 4, pastMin: 6 },
    { path: 'DO UPDATE', existing: true, attempts: 2, insideMin: 9, pastMin: 11 },
  ])('a $path-settled failure is retried at its backoff boundary: not before, and not hours late', async ({ existing, attempts, insideMin, pastMin }) => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: ORG_URN } });
    const memory = await db.memory.create({ data: {
      id: generateId(), organizationId: org.id, name: 'm', urn: `${ORG_URN}:m`, class: 'knowledge', source: 'https://github.com/acme/repo.git',
    } });
    mkdirSync(join(env.root, ORG_URN, 'm', '.git'), { recursive: true });
    if (existing) {
      await db.gitMirrorObligation.create({ data: {
        memoryId: memory.id, nodeId: 'missing-node', kind: 'WRITE', removeLoc: '', state: 'FAILED', errorClass: 'PUSH_FAILED',
        attempts: 1, attemptSeq: await takeAttemptSeq(db), lastAttemptAt: new Date(Date.now() - 24 * 60 * 60_000),
      } });
    }
    const client = zoneClient(zone);
    await settleMirrorObligations(client, memory.id, [{ nodeId: 'missing-node', kind: 'WRITE' }], { result: 'failed', errorClass: 'PUSH_FAILED' }, await takeAttemptSeq(db));
    const settledAt = Date.now();
    expect((await db.gitMirrorObligation.findFirstOrThrow({ where: { memoryId: memory.id } })).attempts).toBe(attempts);

    expect(await gitMirrorSweepTick(client, new Date(settledAt + insideMin * 60_000))).toBe(0);   // inside the backoff: no retry
    expect(await db.gitMirrorObligation.count({ where: { memoryId: memory.id } })).toBe(1);
    expect(await gitMirrorSweepTick(client, new Date(settledAt + pastMin * 60_000))).toBe(1);     // past it: retried and cleared
    expect(await db.gitMirrorObligation.count({ where: { memoryId: memory.id } })).toBe(0);
  });
});
