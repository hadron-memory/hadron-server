/**
 * #3174: the retry sweep binds JS Dates into raw SQL against `timestamp` (no zone) columns that hold UTC. On a session
 * whose TimeZone is not UTC the binds shift by the offset. Every pin runs through a client whose OWN connection carries the
 * zone (`options=-c TimeZone=<zone>`); the shared test database and its session setting are never changed.
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
import { takeAttemptSeq } from '../integrations/github/mirrorObligations.js';

const env = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
import { gitMirrorSweepTick } from './sweepGitMirrorObligations.js';

const SOURCE = 'https://github.com/acme/repo.git';
const ORG_URN = 'sweep3174-org';
const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000);
const clients = new Map<string, PrismaClient>();
let orgId: string;

/** A client whose own connection runs in `zone`. Wrapped so a runaway cursor fails an assertion instead of hanging. */
function zoneClient(zone: string, maxCandidateQueries = Infinity): { client: PrismaClient; candidateQueries: () => number } {
  let raw = clients.get(zone);
  if (!raw) {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${zone}`);
    raw = new PrismaClient({ datasourceUrl: url.toString() });
    clients.set(zone, raw);
  }
  const target = raw;
  let candidateQueries = 0;
  const client = new Proxy(target, {
    get(t, prop) {
      if (prop === '$queryRaw') {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('?').includes('WITH due') && ++candidateQueries > maxCandidateQueries) {
            throw new Error(`cursor did not advance: ${candidateQueries} candidate queries (bounded failure, not a hang)`);
          }
          return t.$queryRaw(strings, ...values);
        };
      }
      const value = Reflect.get(t, prop);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  return { client, candidateQueries: () => candidateQueries };
}

async function memoryWithDebt(name: string, extra: { source?: string; lastAttemptAt: Date; attempts?: number; clone?: boolean }) {
  const memory = await db.memory.create({ data: {
    id: generateId(), organizationId: orgId, name, urn: `${ORG_URN}:${name}`, class: 'knowledge', source: extra.source ?? SOURCE,
  } });
  if (extra.clone !== false) mkdirSync(join(env.root, ORG_URN, name, '.git'), { recursive: true });
  await db.gitMirrorObligation.create({ data: {
    memoryId: memory.id, nodeId: `missing-${name}`, kind: 'WRITE', removeLoc: '', state: 'FAILED', errorClass: 'PUSH_FAILED',
    attempts: extra.attempts ?? 1, attemptSeq: await takeAttemptSeq(db), lastAttemptAt: extra.lastAttemptAt,
  } });
  return memory.id;
}
const remaining = (memoryId: string) => db.gitMirrorObligation.count({ where: { memoryId } });

beforeEach(async () => {
  env.root = mkdtempSync(join(tmpdir(), 'bindi-sweep3174-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'o', urn: ORG_URN } })).id;
});
afterEach(() => { vi.restoreAllMocks(); rmSync(env.root, { recursive: true, force: true }); });
afterAll(async () => { await Promise.all([...clients.values()].map(c => c.$disconnect())); });

describe.each(ZONES)('#3174 sweep binds under session zone %s', zone => {
  it('cursor: reaches an eligible memory behind a full page of skipped memories (bounded, never hangs)', async () => {
    for (let i = 0; i < 20; i++) {
      await memoryWithDebt(`skip${i}`, { source: 'https://attacker.invalid/repo', lastAttemptAt: hoursAgo(48 + i / 60) });
    }
    const eligible = await memoryWithDebt('eligible', { lastAttemptAt: hoursAgo(24) });
    const { client } = zoneClient(zone, 4); // a correct sweep needs 2 candidate queries
    expect(await gitMirrorSweepTick(client)).toBe(1);
    expect(await remaining(eligible)).toBe(0);
  });

  it('due comparison: a row is retried at its exact boundary, neither early nor late by the zone offset', async () => {
    // attempts 2 => backoff 10 minutes.
    const lastAttemptAt = new Date(Date.now() - 6 * 60 * 60_000);
    const memoryId = await memoryWithDebt('boundary', { lastAttemptAt, attempts: 2 });
    const due = lastAttemptAt.getTime() + 10 * 60_000;
    const { client } = zoneClient(zone, 4);
    expect(await gitMirrorSweepTick(client, new Date(due - 1))).toBe(0);
    expect(await remaining(memoryId)).toBe(1);
    expect(await gitMirrorSweepTick(client, new Date(due))).toBe(1);
    expect(await remaining(memoryId)).toBe(0);
  });
});
