/**
 * #4332 (part of #434 Slice C): the seven rate-limit CHECK constraints that
 * migration 20261031220000_shared_rate_limiter creates must also exist on the
 * dev and test path (push + post-push.sql), under the migration's own names, so
 * tests run with the limits production enforces. Each case writes one row that
 * only its constraint refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';

const POLICY_OK = { principal_limit: 1, key_limit: 1, ip_limit: 1, window_seconds: 60, retention_seconds: 86400, enforcement_mode: "'LOG_ONLY'" };

async function insertPolicy(over: Partial<Record<keyof typeof POLICY_OK, number | string>>): Promise<unknown> {
  const row = { ...POLICY_OK, ...over };
  return db.$executeRawUnsafe(
    `INSERT INTO rate_limit_policies (field_class, principal_limit, key_limit, ip_limit, window_seconds, retention_seconds, enforcement_mode)
     VALUES ('pin4332', ${row.principal_limit}, ${row.key_limit}, ${row.ip_limit}, ${row.window_seconds}, ${row.retention_seconds}, ${row.enforcement_mode})`,
  );
}

async function refusal(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
  } catch (e) {
    return String((e as { message?: string }).message ?? e);
  }
  return 'accepted';
}

beforeEach(async () => {
  await cleanDb(db);
});

describe('#4332 rate-limit CHECKs exist on push + post-push', () => {
  it.each([
    ['rate_limit_policies_principal_limit_check', { principal_limit: 0 }],
    ['rate_limit_policies_key_limit_check', { key_limit: 0 }],
    ['rate_limit_policies_ip_limit_check', { ip_limit: 0 }],
    ['rate_limit_policies_window_seconds_check', { window_seconds: 61 }],
    ['rate_limit_policies_retention_seconds_check', { retention_seconds: 86401 }],
    ['rate_limit_policies_enforcement_mode_check', { enforcement_mode: "'OFF'" }],
  ] as const)('%s refuses its out-of-range value', async (name, over) => {
    expect(await refusal(() => insertPolicy(over))).toContain(name);
  });

  it('a policy row inside every range is accepted', async () => {
    expect(await insertPolicy({})).toBe(1);
  });

  it('rate_limit_buckets_used_check refuses a negative count', async () => {
    const msg = await refusal(() => db.$executeRawUnsafe(
      `INSERT INTO rate_limit_buckets (id, field_class, dimension, subject, window_start, used, expires_at)
       VALUES ('b4332', 'pin4332', 'principal', 's', now(), -1, now())`,
    ));
    expect(msg).toContain('rate_limit_buckets_used_check');
  });
});
