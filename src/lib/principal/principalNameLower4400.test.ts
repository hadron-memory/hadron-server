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
    // lower() folds beyond ASCII only under a UTF-8 character type (not under C/POSIX). The test database is
    // en_US.UTF-8 (the collation prerequisite in CLAUDE.md); production's ctype is read by the #4400 preflight.
    const [{ datctype }] = await db.$queryRaw<{ datctype: string }[]>`
      SELECT datctype FROM pg_database WHERE datname = current_database()`;
    expect(datctype.toLowerCase()).toMatch(/utf-?8/);
    expect(await refusal(rawInsert('École.example'))).toContain('chk_principals_name_lower');
  });

  it('refuses an UPDATE that would put a stored name into mixed case', async () => {
    const p = await mintPrincipal(db, { kind: 'org', name: 'acme.example' });
    const said = await refusal(db.$executeRaw`UPDATE principals SET name = 'Acme.Example' WHERE id = ${p.id}`);
    expect(said).toContain('chk_principals_name_lower');
  });

  it('GUARD: what the writer stores always passes the CHECK', async () => {
    // JavaScript lower-cases in the writer; Postgres lower() judges in the CHECK. A name the writer produced must
    // be a fixed point of the database's lower(), or a legitimate mint would be refused. Since #4481 the pool
    // itself refuses — typed, BEFORE the insert — any name whose lower-cased form leaves lower-case ASCII, so the
    // writer can no longer produce non-ASCII output at all and what it does store ([a-z0-9._-]) is a trivial
    // fixed point. The non-ASCII names keep #4400's evidence in two legs: the pool refuses them (#4481's rule,
    // which fires ahead of the constraint), and their JS-lowered forms are still fixed points of Postgres
    // lower() — the CHECK would not have refused a writer that stored them, so no legitimate mint ever dies on
    // the constraint, whichever layer sees the name first.
    for (const name of ['Plain-Name', 'ACME.Example']) {
      const p = await mintPrincipal(db, { kind: 'org', name });
      const row = await db.principal.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.name).toBe(name.toLowerCase());
    }
    for (const name of ['İstanbul', 'ΟΔΟΣ', 'Straße', 'ÉCOLE.example']) {
      await expect(mintPrincipal(db, { kind: 'org', name })).rejects.toBeInstanceOf(RootNameInvalidError);
      const lowered = name.toLowerCase();
      const [{ fixed }] = await db.$queryRaw<{ fixed: boolean }[]>`
        SELECT ${lowered} = lower(${lowered}) AS fixed`;
      expect(fixed).toBe(true);
    }
  });
});

describe('#4400 the migration refuses on data instead of guessing', () => {
  const sql = readFileSync(
    new URL('../../../prisma/migrations/20261117900000_principals_name_lower_check/migration.sql', import.meta.url), 'utf8');
  const preflight = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;') + 'END $$;'.length);

  it('raises SQLSTATE HDPRF when a mixed-case row exists, and changes nothing', async () => {
    let state = 'NO ERROR';
    await db.$transaction(async (tx) => {
      // A database from before the constraint: drop it inside this transaction only, then roll everything back.
      await tx.$executeRawUnsafe('ALTER TABLE principals DROP CONSTRAINT chk_principals_name_lower');
      await tx.$executeRaw`INSERT INTO principals (id, name, kind, status, created_at, updated_at)
        VALUES (${generateId()}, 'Legacy.Example', 'org', 'released', now(), now())`;
      await tx.$executeRawUnsafe('SAVEPOINT before_preflight');
      try { await tx.$executeRawUnsafe(preflight); } catch (e) {
        state = JSON.stringify((e as { meta?: unknown }).meta ?? {}) + String((e as { message?: string }).message);
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT before_preflight');
      throw new Error('rollback');
    }).catch((e) => { if ((e as Error).message !== 'rollback') throw e; });
    expect(state).toContain('HDPRF');
    expect(state).toContain('1 row(s) are not lower case');
    expect(await db.principal.count({ where: { name: 'Legacy.Example' } })).toBe(0);
    // The rollback also brought the constraint back: a later test file must not run without it.
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname = 'chk_principals_name_lower'`;
    expect(Number(n)).toBe(1);
  });

  it('adds the same CHECK the test database gets from post-push.sql', () => {
    // The test database is built from prisma/post-push.sql, so the pins above judge that copy. A deployed database
    // gets the constraint from this migration: pin that the two say the same thing.
    const postPush = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    const expr = (text: string) => /ADD CONSTRAINT "?chk_principals_name_lower"?\s+CHECK \(([^;]+)\);/.exec(text)?.[1].replace(/\s+/g, ' ');
    expect(expr(sql)).toBe('name = lower(name)');
    expect(expr(postPush)).toBe(expr(sql));
  });

  it('passes on a pool that is already lower case', async () => {
    await mintPrincipal(db, { kind: 'org', name: 'Clean.Example' });
    await expect(db.$executeRawUnsafe(preflight)).resolves.toBeDefined();
  });
});
