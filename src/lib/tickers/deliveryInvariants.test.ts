import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';

describe('S5 migration/source contract', () => {
  it('ships the same checks via migration and post-push', () => {
    const sql = readFileSync(new URL('../../../prisma/delivery-stall-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261018235500_delivery_wait/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(sql)).toBe(true);
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir delivery-stall-invariants.sql');
  });
  it('rejects invalid coverage and unknown metadata keys at the database boundary', async () => {
    const db = new PrismaClient();
    try {
      // No fixtures needed: CHECK precedes FK validation, and deliberately invalid
      // records cannot survive even when inserted outside the typed writer.
      await expect(db.workerDeliveryWaitException.create({ data: {
        id: 'invalid-s5', workerId: 'missing', cause: 'wake-budget', coverageKey: 'worker', startedAt: new Date(),
      } })).rejects.toThrow(/chk_delivery_wait_exception/);
      await expect(db.agentTeamEvent.create({ data: {
        appId: 'missing', type: 'delivery.resumed', subjectWorkerId: 'missing', payload: {
          episodeId: 'e', channelId: 'c', channelIncarnation: 1, throughSeq: 1, resumedAt: new Date().toISOString(), principal: { kind: 'worker', workerId: 'w' }, draft: 'must never persist',
        },
      } })).rejects.toThrow(/chk_delivery_event_payload/);
    } finally { await db.$disconnect(); }
  });
});
