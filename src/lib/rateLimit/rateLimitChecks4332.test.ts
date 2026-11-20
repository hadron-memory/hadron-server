/**
 * #4332 (part of #434 Slice C): the seven rate-limit CHECK constraints that
 * migration 20261031220000_shared_rate_limiter creates must also exist on the
 * dev and test path (push + post-push.sql), under the migration's own names, so
 * tests run with the limits production enforces. Each refusal case writes one
 * row that only its constraint refuses; the acceptance cases cover every value
 * the migration admits at a boundary or in a list.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';

type Policy = {
  principalLimit: number;
  keyLimit: number;
  ipLimit: number;
  windowSeconds: number;
  retentionSeconds: number;
  enforcementMode: string;
};

const POLICY_OK: Policy = { principalLimit: 1, keyLimit: 1, ipLimit: 1, windowSeconds: 60, retentionSeconds: 86400, enforcementMode: 'LOG_ONLY' };

async function insertPolicy(overrides: Partial<Policy>, fieldClass = 'pin4332'): Promise<number> {
  const p = { ...POLICY_OK, ...overrides };
  return db.$executeRaw`
    INSERT INTO rate_limit_policies (field_class, principal_limit, key_limit, ip_limit, window_seconds, retention_seconds, enforcement_mode)
    VALUES (${fieldClass}, ${p.principalLimit}, ${p.keyLimit}, ${p.ipLimit}, ${p.windowSeconds}, ${p.retentionSeconds}, ${p.enforcementMode})`;
}

async function insertBucket(used: number): Promise<number> {
  return db.$executeRaw`
    INSERT INTO rate_limit_buckets (id, field_class, dimension, subject, window_start, used, expires_at)
    VALUES (${`b4332_${used}`}, 'pin4332', 'principal', 's', now(), ${used}, now())`;
}

/** The refusal's text and SQLSTATE, or `accepted`. Prisma carries the Postgres code in `meta.code` for a raw query. */
async function refusal(write: () => Promise<unknown>): Promise<{ message: string; sqlstate: string | undefined } | 'accepted'> {
  try {
    await write();
  } catch (e) {
    const err = e as { message?: string; meta?: { code?: string } };
    return { message: String(err.message ?? e), sqlstate: err.meta?.code };
  }
  return 'accepted';
}

beforeEach(async () => {
  await cleanDb(db);
});

describe('#4332 rate-limit CHECKs exist on push + post-push', () => {
  it.each([
    ['rate_limit_policies_principal_limit_check', { principalLimit: 0 }],
    ['rate_limit_policies_key_limit_check', { keyLimit: 0 }],
    ['rate_limit_policies_ip_limit_check', { ipLimit: 0 }],
    ['rate_limit_policies_window_seconds_check', { windowSeconds: 61 }],
    ['rate_limit_policies_retention_seconds_check', { retentionSeconds: 86401 }],
    ['rate_limit_policies_enforcement_mode_check', { enforcementMode: 'OFF' }],
  ] as const)('%s refuses its out-of-range value with 23514', async (name, overrides) => {
    const r = await refusal(() => insertPolicy(overrides));
    expect(r).not.toBe('accepted');
    if (r === 'accepted') return;
    expect(r.message).toContain(name);
    expect(r.sqlstate).toBe('23514');
  });

  it('rate_limit_buckets_used_check refuses a negative count with 23514', async () => {
    const r = await refusal(() => insertBucket(-1));
    expect(r).not.toBe('accepted');
    if (r === 'accepted') return;
    expect(r.message).toContain('rate_limit_buckets_used_check');
    expect(r.sqlstate).toBe('23514');
  });

  it('every admitted window, both modes and the lowest limits are accepted', async () => {
    let n = 0;
    for (const windowSeconds of [60, 900, 3600]) {
      for (const enforcementMode of ['LOG_ONLY', 'ENFORCING']) {
        expect(await insertPolicy({ windowSeconds, enforcementMode }, `pin4332_${n++}`)).toBe(1);
      }
    }
  });

  it('a bucket count of 0 is accepted', async () => {
    expect(await insertBucket(0)).toBe(1);
  });
});

/**
 * #4611 BLIND delta F2 and F1 at 8c629d6f (LOCAL F1): psql runs on the SAME database and schema as Prisma. Only Prisma's
 * own URL parameters are dropped (libpq refuses them); every libpq one (sslmode, `options` and the rest) is kept, and the
 * inherited PGOPTIONS is left alone. Prisma's `schema` is set in the same psql session before the file runs, as a
 * quoted identifier, so a mixed-case name or one with spaces, commas or quotes selects exactly that schema.
 */
const PRISMA_ONLY = ['connection_limit', 'pool_timeout', 'schema', 'pgbouncer', 'socket_timeout', 'statement_cache_size'];
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
export function psqlArgs(databaseUrl: string, file: string): string[] {
  const schema = new URL(databaseUrl).searchParams.get('schema') ?? 'public';
  // #4611 BLIND delta F1 at e86277a8: the retained parameters keep their RAW encoding. URLSearchParams re-serializes a
  // space as `+`, which libpq does not decode, so the query is filtered as text, never rebuilt.
  const q = databaseUrl.indexOf('?');
  const kept = q === -1 ? [] : databaseUrl.slice(q + 1).split('&').filter((pair) => {
    const key = decodeURIComponent(pair.split('=')[0].replace(/\+/g, ' '));
    return pair !== '' && !PRISMA_ONLY.includes(key);
  });
  const url = (q === -1 ? databaseUrl : databaseUrl.slice(0, q)) + (kept.length ? `?${kept.join('&')}` : '');
  return [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', `SET search_path TO ${quoteIdent(schema)}`, '-f', file];
}

describe('#4332 psqlArgs (the atomicity pin\'s psql target)', () => {
  it('quotes a non-simple schema and keeps libpq parameters', () => {
    const args = psqlArgs('postgresql://u@h:5432/db?schema=Odd%20"Name",x&sslmode=require&connection_limit=3&options=-c%20a%3Db', '/f.sql');
    // The exact text psql receives: retained parameters byte-for-byte, the space still `%20` (libpq reads `+` literally).
    expect(args[0]).toBe('postgresql://u@h:5432/db?sslmode=require&options=-c%20a%3Db');
    expect(args.slice(1)).toEqual(['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'SET search_path TO "Odd ""Name"",x"', '-f', '/f.sql']);
  });

  it('defaults to public when the URL names no schema', () => {
    expect(psqlArgs('postgresql://u@h/db', '/f.sql')).toContain('SET search_path TO "public"');
  });
});

/**
 * #4611 BLIND F1: post-push runs through psql statement by statement, so the file is one transaction. A failure part way
 * through must leave every constraint as it was, not some replaced and the rest dropped.
 */
describe('#4332 prisma/rate-limit-invariants.sql applies atomically', () => {
  const run = promisify(execFile);
  const apply = () => run('psql', psqlArgs(process.env.DATABASE_URL!, resolve('prisma/rate-limit-invariants.sql')), { timeout: 60_000 });
  // Scoped to the constraint's own table in the schema Prisma uses, never a same-named constraint elsewhere.
  const def = async (table: string, name: string) =>
    (await db.$queryRaw<Array<{ d: string }>>`
      SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c
      WHERE c.conname = ${name} AND c.conrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(${table}))`)[0]?.d ?? null;

  it('a failing ADD late in the file leaves the earlier constraints unreplaced', async () => {
    try {
      // An earlier constraint with a different definition, and a row that the LAST constraint refuses.
      await db.$executeRawUnsafe('ALTER TABLE rate_limit_policies DROP CONSTRAINT rate_limit_policies_principal_limit_check');
      await db.$executeRawUnsafe('ALTER TABLE rate_limit_policies ADD CONSTRAINT rate_limit_policies_principal_limit_check CHECK (principal_limit > 5)');
      await db.$executeRawUnsafe('ALTER TABLE rate_limit_buckets DROP CONSTRAINT rate_limit_buckets_used_check');
      await insertBucket(-1);

      await expect(apply()).rejects.toThrow(/rate_limit_buckets_used_check/);
      expect(await def('rate_limit_policies', 'rate_limit_policies_principal_limit_check')).toBe('CHECK ((principal_limit > 5))');
    } finally {
      await cleanDb(db);
      await apply();
    }
    expect(await def('rate_limit_policies', 'rate_limit_policies_principal_limit_check')).toBe('CHECK ((principal_limit > 0))');
    expect(await def('rate_limit_buckets', 'rate_limit_buckets_used_check')).toBe('CHECK ((used >= 0))');
  });
});
