/**
 * #5212 (cor:api:010:02): `hadron_record_user_merge` is the one writer of `user_merges`. Red on main: the function does not exist.
 * A2 each refusal writes nothing; A4 a success records the row and retires the source itself; A5 the catalog (SECURITY DEFINER, owner,
 * pinned search_path, no PUBLIC execute); A6 a user's hard delete still cascades its rows; and the expand-safety pin: the previous
 * image's direct INSERT still works (grants are unchanged here; the contract step is separate). One SQL source, shared verbatim with
 * the migration.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

const read = (p: string) => readFileSync(new URL(`../../../prisma/${p}`, import.meta.url), 'utf8');
const MIGRATION = read('migrations/20261126070000_user_merge_record_function/migration.sql');
const SOURCE = read('user-merge-record-invariants.sql');
const FN = 'public.hadron_record_user_merge';

let pg: Client;
let s: string; // source user
let t: string; // target user
let other: string;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });
beforeEach(async () => {
  await cleanDb(db);
  const mk = async (n: number, name: string) => (await db.user.create({ data: { id: generateId(), githubId: 52120 + n, githubUsername: name } })).id;
  s = await mk(1, 'rec-source');
  t = await mk(2, 'rec-target');
  other = await mk(3, 'rec-other');
});

/** Run `fn` inside one transaction that is always rolled back; the savepoint lets a refused call be inspected afterwards. */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await pg.query('BEGIN');
  try { return await fn(); } finally { await pg.query('ROLLBACK'); }
}
/** A consumed consent for (source, target) written in the open transaction, as consumeUserMergeConsent leaves it. */
const consent = (hash: string, source = s, target = t, consumed = true) =>
  pg.query(
    `INSERT INTO user_merge_consents (id, proof_hash, source_user_id, target_user_id, requested_by, scope, created_at, expires_at,
       source_login_at, source_login_method, target_login_at, target_login_method, consumed_at)
     VALUES ($1, $2, $3, $4, $5, 'FULL_CONSOLIDATION', now(), now() + interval '1 hour', now(), 'x', now(), 'x', ${consumed ? 'now()' : 'NULL'})`,
    [generateId(), hash, source, target, target],
  );
const call = (source = s, target = t, hash: string | null = 'h1', mergedBy = t) =>
  pg.query(`SELECT ${FN}($1, $2, $3, $4, '{"k":1}'::jsonb) AS ok`, [source, target, mergedBy, hash]);
/** The call must be refused with a message that starts as the function's refusals do, and must leave no row and no retired user. */
async function refused(run: () => Promise<unknown>, message: RegExp) {
  await pg.query('SAVEPOINT before_call');
  await expect(run()).rejects.toThrow(message);
  await pg.query('ROLLBACK TO SAVEPOINT before_call');
  // RELEASE it: a rolled-back savepoint stays open, and any row written after it carries the SUBtransaction id, so the function's
  // xmin test would refuse a later consent before reaching the pair or consumed_at checks (the pins after it could not fail).
  await pg.query('RELEASE SAVEPOINT before_call');
  expect((await pg.query('SELECT count(*)::int AS n FROM user_merges')).rows[0].n).toBe(0);
  expect((await pg.query('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NOT NULL')).rows[0].n).toBe(0);
}

describe('#5212 A2: each refusal writes nothing', () => {
  it('the same user, a missing source, a retired source, a missing target, a retired target', async () => {
    await inTx(async () => {
      await consent('h1');
      await refused(() => call(s, s), /two different users/);
      await refused(() => call(generateId(), t), /source is missing or already retired/);
      await refused(() => call(s, generateId()), /target is missing or retired/);
      await pg.query('UPDATE users SET deleted_at = now() WHERE id = $1', [s]);
      await expect(call()).rejects.toThrow(/source is missing or already retired/);
      await pg.query('ROLLBACK').then(() => pg.query('BEGIN'));
      await consent('h1');
      await pg.query('UPDATE users SET deleted_at = now() WHERE id = $1', [t]);
      await expect(call()).rejects.toThrow(/target is missing or retired/);
    });
  });

  it('an already merged source (the primary key) and a merged-away target', async () => {
    await inTx(async () => {
      await consent('h1');
      await pg.query(`INSERT INTO user_merges (source_user_id, target_user_id) VALUES ($1, $2)`, [s, other]);
      await pg.query('SAVEPOINT a');
      await expect(call()).rejects.toThrow(/duplicate key|unique/i);
      await pg.query('ROLLBACK TO SAVEPOINT a');
      await pg.query('RELEASE SAVEPOINT a');
      await pg.query('DELETE FROM user_merges');
      await pg.query(`INSERT INTO user_merges (source_user_id, target_user_id) VALUES ($1, $2)`, [t, other]);
      await expect(call()).rejects.toThrow(/target was itself merged away/);
    });
  });

  it('no consent, a consent for another pair, an unconsumed consent, and a consent consumed in an EARLIER transaction', async () => {
    await inTx(async () => {
      await refused(() => call(), /no consent consumed by this transaction/); // none at all
      await refused(() => call(s, t, null), /no consent consumed by this transaction/);
      await consent('wrong', s, other);
      await refused(() => call(s, t, 'wrong'), /no consent consumed by this transaction/); // another pair
      await consent('open', s, t, false);
      await refused(() => call(s, t, 'open'), /no consent consumed by this transaction/); // never consumed
    });
    // Consumed and COMMITTED earlier: a later transaction (this call) is not the one that consumed it.
    await consent('old'); // outside any BEGIN: autocommit
    await inTx(async () => {
      await refused(() => call(s, t, 'old'), /no consent consumed by this transaction/);
    });
  });
});

describe('#5212 the consent must be consumed at the transaction\'s top level', () => {
  it('a consent consumed under a savepoint is refused (fail closed: mergeUsers consumes at the top level, never in a subtransaction)', async () => {
    await inTx(async () => {
      await pg.query('SAVEPOINT sub');
      await consent('h1'); // the row carries the subtransaction id, not the transaction's
      await expect(call()).rejects.toThrow(/no consent consumed by this transaction/);
      await pg.query('ROLLBACK TO SAVEPOINT sub');
      await pg.query('RELEASE SAVEPOINT sub');
      await consent('h2'); // the same consent at the top level is accepted
      expect((await call(s, t, 'h2')).rows[0].ok).toBe(true);
    });
  });
});

describe('#5212 A4: a success records the row and retires the source itself', () => {
  it('inserts the sealed row, soft-deletes the source with deleted_by = merged_by, and returns true', async () => {
    await inTx(async () => {
      await consent('h1');
      expect((await call()).rows[0].ok).toBe(true);
      const m = (await pg.query('SELECT source_user_id, target_user_id, merged_by, consent_hash, consent_receipt FROM user_merges')).rows;
      expect(m).toEqual([{ source_user_id: s, target_user_id: t, merged_by: t, consent_hash: 'h1', consent_receipt: { k: 1 } }]);
      const u = (await pg.query('SELECT deleted_at, deleted_by, updated_by FROM users WHERE id = $1', [s])).rows[0];
      expect(u.deleted_at).not.toBeNull();
      expect(u.deleted_by).toBe(t);
      expect(u.updated_by).toBe(t);
      expect((await pg.query('SELECT deleted_at FROM users WHERE id = $1', [t])).rows[0].deleted_at).toBeNull();
    });
  });
});

describe('#5212 A5: the catalog', () => {
  it('SECURITY DEFINER, owned by the migrating role, search_path pinned, never executable by PUBLIC', async () => {
    const r = (await pg.query(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner) = current_user AS owned_here, p.proconfig,
              (SELECT count(*)::int FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_grants
         FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}(text, text, text, text, jsonb)')`)).rows[0];
    expect(r.prosecdef).toBe(true);
    expect(r.owned_here).toBe(true);
    expect(r.proconfig).toContain('search_path=public, pg_temp');
    expect(r.public_grants).toBe(0);
  });

  it('runtime-role.sql grants the serve role EXECUTE on it', () => {
    expect(read('runtime-role.sql')).toMatch(/GRANT EXECUTE ON FUNCTION public\.hadron_record_user_merge\(text, text, text, text, jsonb\) TO %I/);
  });

  it('one SQL source, shared verbatim with the migration and applied by post-push.sql', () => {
    expect(MIGRATION).toContain(SOURCE);
    expect(read('post-push.sql')).toMatch(/\\ir user-merge-record-invariants\.sql/);
  });
});

describe('#5212 A6 and expand-safety', () => {
  it('a hard delete of a user still cascades its user_merges rows', async () => {
    await inTx(async () => {
      await pg.query(`INSERT INTO user_merges (source_user_id, target_user_id) VALUES ($1, $2)`, [s, t]);
      await pg.query('DELETE FROM users WHERE id = $1', [t]);
      expect((await pg.query('SELECT count(*)::int AS n FROM user_merges')).rows[0].n).toBe(0);
    });
  });

  it('the previous image\'s direct INSERT into user_merges still works (grants unchanged: this is the expand step)', async () => {
    await inTx(async () => {
      await pg.query(`INSERT INTO user_merges (source_user_id, target_user_id) VALUES ($1, $2)`, [s, t]);
      expect((await pg.query('SELECT count(*)::int AS n FROM user_merges')).rows[0].n).toBe(1);
    });
  });
});
