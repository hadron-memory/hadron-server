import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Client } from 'pg';

describe('S5 migration/source contract', () => {
  it('ships the same checks via migration and post-push', () => {
    const sql = readFileSync(new URL('../../../prisma/delivery-stall-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261018235500_delivery_wait/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(sql)).toBe(true);
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir delivery-stall-invariants.sql');
  });
  it('rejects invalid coverage and unknown metadata keys at the database boundary', async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      // PostgreSQL's structured code/constraint fields are authoritative.
      // Prisma messages include source snippets, so matching a bare constraint
      // name there can match the assertion's own source instead of the failure.
      await expect(db.query(`INSERT INTO worker_delivery_wait_exceptions
        (id,worker_id,cause,coverage_key,started_at) VALUES ('invalid-s5','missing','wake-budget','worker',now())`))
        .rejects.toMatchObject({ code: '23514', constraint: 'chk_delivery_wait_exception' });
      const base = { episodeId: 'e', channelId: 'c', channelIncarnation: 1, throughSeq: 1,
        resumedAt: new Date().toISOString(), principal: { kind: 'worker', workerId: 'w' } };
      for (const payload of [
        { ...base, draft: 'must never persist' },
        { ...base, throughSeq: 'draft text must not fit in an allowlisted numeric field' },
      ]) {
        await expect(db.query(`INSERT INTO agent_team_events
          (id,app_id,type,subject_worker_id,payload) VALUES ('invalid-s5-event','missing','delivery.resumed','missing',$1::jsonb)`, [JSON.stringify(payload)]))
          .rejects.toMatchObject({ code: '23514', constraint: 'chk_delivery_event_payload' });
      }
    } finally { await db.end(); }
  });
});
