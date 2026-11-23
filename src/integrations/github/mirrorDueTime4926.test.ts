/**
 * #4926: the sweep's SQL due-time fragment and the in-lock TypeScript twin are one rule. Pure checks: the fragment is
 * evaluated by Postgres over literals (no table, no tick, nothing to settle), then compared with the TypeScript for
 * attempts 0 through 12, past the exponent clamp (attempts 8) and the 72x ceiling (attempts 8 and up).
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../db/client.js';
import {
  mirrorDueAtMs, mirrorDueAtSql, mirrorRetryBackoffMs, MIRROR_RETRY_MAX_BACKOFF_MS,
} from './mirrorDueTime.js';

const BASE = new Date('2026-01-01T00:00:00.000Z');
const ATTEMPTS = Array.from({ length: 13 }, (_, i) => i);

async function sqlDueMs(state: string, attempts: number): Promise<number> {
  const due = mirrorDueAtSql(Prisma.sql`${state}::text`, Prisma.sql`'2026-01-01 00:00:00'::timestamp`, Prisma.sql`${attempts}::int`);
  const [row] = await db.$queryRaw<{ ms: number }[]>`SELECT (EXTRACT(EPOCH FROM (${due} - '2026-01-01 00:00:00'::timestamp)) * 1000)::float8 AS ms`;
  return row.ms;
}

describe('#4926 mirror due time: one rule in SQL and TypeScript', () => {
  it('the SQL fragment and the TypeScript agree for every attempt count, FAILED and NOT_CLONED', async () => {
    for (const state of ['FAILED', 'NOT_CLONED']) {
      for (const attempts of ATTEMPTS) {
        expect(await sqlDueMs(state, attempts), `${state} attempts=${attempts}`)
          .toBe(mirrorDueAtMs({ state, lastAttemptAt: BASE, attempts }) - BASE.getTime());
      }
    }
  });
  it('a PENDING row is due at its own last attempt, with no wait, in both spellings', async () => {
    for (const attempts of ATTEMPTS) {
      expect(await sqlDueMs('PENDING', attempts)).toBe(0);
      expect(mirrorDueAtMs({ state: 'PENDING', lastAttemptAt: BASE, attempts })).toBe(BASE.getTime());
    }
  });
  it('the backoff doubles from five minutes and holds at the six-hour ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(mirrorRetryBackoffMs)).toEqual([5, 10, 20, 40, 80, 160, 320].map(m => m * 60_000));
    expect(MIRROR_RETRY_MAX_BACKOFF_MS).toBe(6 * 60 * 60_000);
    for (const attempts of [8, 9, 12, 50]) expect(mirrorRetryBackoffMs(attempts)).toBe(MIRROR_RETRY_MAX_BACKOFF_MS);
  });
});
