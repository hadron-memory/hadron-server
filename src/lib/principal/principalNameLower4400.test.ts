/**
 * #4400 (hrn:node:hadronmemory.com:specs:cor:urn:010:01, "The root principal & the pool"): a root name is unique
 * regardless of case. Before #4400 that rested only on every writer lower-casing; these pins go to the database
 * with a raw insert that skips the writer, so they hold only when the database itself refuses.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { mintPrincipal, RootNameInvalidError } from './mintPrincipal.js';

beforeEach(async () => {
  await cleanDb(db);
});

/** Insert a principal row as a writer that forgot to lower-case would. */
const rawInsert = (name: string, status = 'active') => db.$executeRaw`
  INSERT INTO principals (id, name, kind, status, created_at, updated_at)
  VALUES (${generateId()}, ${name}, 'org', ${status}, now(), now())`;

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return String((e as { message?: string }).message ?? e); }
  return 'NOT REFUSED';
};

describe('#4400 principals.name is lower case in the database', () => {
  it('refuses a case variant of an existing name written past the writer', async () => {
    await mintPrincipal(db, { kind: 'user', name: 'example' });
    const said = await refusal(rawInsert('Example'));
    expect(said).toContain('chk_principals_name_lower');
    expect(await db.principal.count({ where: { name: { in: ['example', 'Example'] } } })).toBe(1);
  });

  it('refuses a mixed-case name that has no lower-case twin', async () => {
    expect(await refusal(rawInsert('LonelyName'))).toContain('chk_principals_name_lower');
    expect(await db.principal.count({ where: { name: 'LonelyName' } })).toBe(0);
  });

  it('refuses it in every status: a released or reserved row is in the same namespace', async () => {
    expect(await refusal(rawInsert('Released.Example', 'released'))).toContain('chk_principals_name_lower');
    expect(await refusal(rawInsert('ReservedWord', 'reserved'))).toContain('chk_principals_name_lower');
  });

  it('refuses a name with an upper-case letter outside ASCII, where the database folds it', async () => {
    // lower() folds beyond ASCII only under a locale that knows Unicode case (libc UTF-8, ICU, builtin C.UTF-8;
    // not libc C/POSIX or builtin C). The test database is en_US.UTF-8 (the collation prerequisite in CLAUDE.md);
    // production's is read by the #4400 preflight. #4411: judge the folding itself, not `datctype` alone, which is
    // not the governing setting under the ICU or builtin provider; the provider and its locale name the cause.
    // The provider and locale are read through to_jsonb so the query runs on every supported version: the
    // pg16 floor has `datlocprovider` and `daticulocale` but no `datlocale` (PG 17), and a missing key is null.
    const [{ provider, locale, folds }] = await db.$queryRaw<{ provider: string | null; locale: string | null; folds: boolean }[]>`
      SELECT j->>'datlocprovider' AS provider,
             CASE COALESCE(j->>'datlocprovider', 'c') WHEN 'c' THEN j->>'datctype'
                  ELSE COALESCE(j->>'datlocale', j->>'daticulocale') END AS locale,
             lower('É') = 'é' AS folds
      FROM (SELECT to_jsonb(d) AS j FROM pg_database d WHERE d.datname = current_database()) s`;
    expect(
      folds,
      `lower() does not fold non-ASCII under provider ${provider}, locale ${locale}: the test database needs a UTF-8 locale (collation prerequisite, CLAUDE.md, #3872)`,
    ).toBe(true);
    expect(await refusal(rawInsert('École.example'))).toContain('chk_principals_name_lower');
  });

  it('refuses an UPDATE that would put a stored name into mixed case', async () => {
    const p = await mintPrincipal(db, { kind: 'org', name: 'acme.example' });
    const said = await refusal(db.$executeRaw`UPDATE principals SET name = 'Acme.Example' WHERE id = ${p.id}`);
    expect(said).toContain('chk_principals_name_lower');
  });

  it('GUARD: what the writer stores always passes the CHECK, and a name that cannot be stored is refused typed', async () => {
    // The writer lower-cases in JavaScript; the CHECK judges in Postgres lower(). Since #4481 the pool refuses, typed
    // and BEFORE the insert, any name whose lower-cased form leaves lower-case ASCII, so what it does store
    // ([a-z0-9._-]) is a fixed point of lower() and a legitimate mint never dies on the constraint.
    // The Kelvin sign (U+212A) is the sharpest probe of WHERE the guard sits: it is not ASCII, but it lower-cases to
    // the ASCII `k`. Lower-casing first stores `k`; a guard placed before the lower-casing would refuse it.
    for (const name of ['Plain-Name', 'ACME.Example', '\u212A']) {
      const p = await mintPrincipal(db, { kind: 'org', name });
      const row = await db.principal.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.name).toBe(name.toLowerCase());
    }
    for (const name of ['İstanbul', 'ΟΔΟΣ', 'Straße', 'ÉCOLE.example']) {
      await expect(mintPrincipal(db, { kind: 'org', name })).rejects.toBeInstanceOf(RootNameInvalidError);
    }
  });
});

describe('#4400 the migration refuses on data instead of guessing', () => {
  const sql = readFileSync(
    new URL('../../../prisma/migrations/20261117900000_principals_name_lower_check/migration.sql', import.meta.url), 'utf8');
  // #4411: find the preflight as the one dollar-quoted DO block that raises HDPRF, matched on its own quote tag,
  // so a reformat (spacing, case, a named tag) still finds it and anything else fails here by name. #4405 has
  // merged, so the migration may already be applied somewhere: its bytes are not edited for a test sentinel.
  const doBlocks = [...sql.matchAll(/\bDO\s+(\$\w*\$)[\s\S]*?\1\s*;/gi)].map((m) => m[0]);
  const preflights = doBlocks.filter((b) => b.includes("'HDPRF'"));
  // #4617 item 4: no empty-string fallback; the dependent tests below stop at once unless there is exactly one.
  const onePreflight = (): string => {
    expect(preflights, 'the migration must hold exactly one DO block raising HDPRF').toHaveLength(1);
    return preflights[0];
  };

  it('carries exactly one HDPRF preflight block', () => {
    expect(preflights, 'the migration must hold exactly one DO block raising HDPRF').toHaveLength(1);
    expect(onePreflight()).toContain("name <> lower(name)");
  });

  it('extracts the preflight block it runs (a renamed marker must not make the tests below vacuous)', () => {
    expect(doBlocks.length).toBeGreaterThanOrEqual(1);
    expect(preflights).toHaveLength(1);
    expect(onePreflight()).toContain('HDPRF');
  });

  it('raises SQLSTATE HDPRF when a mixed-case row exists', async () => {
    let state = 'NO ERROR';
    await db.$transaction(async (tx) => {
      // A database from before the constraint: drop it inside this transaction only, then roll everything back.
      await tx.$executeRawUnsafe('ALTER TABLE principals DROP CONSTRAINT chk_principals_name_lower');
      await tx.$executeRaw`INSERT INTO principals (id, name, kind, status, created_at, updated_at)
        VALUES (${generateId()}, 'Legacy.Example', 'org', 'released', now(), now())`;
      await tx.$executeRawUnsafe('SAVEPOINT before_preflight');
      try { await tx.$executeRawUnsafe(onePreflight()); } catch (e) {
        state = JSON.stringify((e as { meta?: unknown }).meta ?? {}) + String((e as { message?: string }).message);
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT before_preflight');
      throw new Error('rollback');
    }).catch((e) => { if ((e as Error).message !== 'rollback') throw e; });
    expect(state).toContain('HDPRF');
    expect(state).toContain('1 row(s) are not lower case');
    // The test's own rollback (not the preflight) undid the constraint drop and the insert: a later test file must
    // not run without the constraint.
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE conname = 'chk_principals_name_lower' AND conrelid = 'principals'::regclass AND contype = 'c'`;
    expect(Number(n)).toBe(1);
  });

  it('adds the same CHECK the test database gets from post-push.sql', () => {
    // The test database is built from prisma/post-push.sql, so the pins above judge that copy. A deployed database
    // gets the constraint from this migration: pin that the two say the same thing.
    const postPush = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    // #4411: anchored on the table too, so the constraint added to some other table would not count.
    const expr = (text: string) =>
      /ALTER TABLE\s+"?principals"?\s+ADD CONSTRAINT\s+"?chk_principals_name_lower"?\s+CHECK\s*\(([^;]+)\);/i
        .exec(text)?.[1].replace(/\s+/g, ' ');
    expect(expr(sql)).toBe('name = lower(name)');
    expect(expr(postPush)).toBe(expr(sql));
  });

  it('passes on a pool that is already lower case', async () => {
    await mintPrincipal(db, { kind: 'org', name: 'Clean.Example' });
    // The DO block raises HDPRF on a mixed-case row; completing without raising is the assertion.
    await db.$executeRawUnsafe(onePreflight());
  });
});
