/**
 * #4411 — follow-ups to #4400 / #4405 (`chk_principals_name_lower`,
 * hrn:node:hadronmemory.com:specs:cor:urn:010:01).
 *
 * 1. `mintPrincipal` maps a violation of the CHECK to the typed `RootNameInvalidError` (the #4481
 *    `ROOT_NAME_INVALID` refusal, per the spec review's condition: one code for one cause), instead of letting a raw
 *    database error escape. #4481's pre-insert rule means no name the writer stores can reach the CHECK, so the pin
 *    forces it: a stubbed `principal.create` that upper-cases the name on its way to the REAL database, which then
 *    raises the real violation.
 * 2. `prisma/post-push.sql` (the `db:dev-setup` and test-template path) refuses a mixed-case principal row with a
 *    message a developer can act on, before the `ADD CONSTRAINT` would fail with a raw check violation.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { mintPrincipal, RootNameInvalidError, RootNameTakenError } from './mintPrincipal.js';

beforeEach(async () => {
  await cleanDb(db);
});

type MintDb = Parameters<typeof mintPrincipal>[0];
type CreateArgs = Parameters<typeof db.principal.create>[0];

/** A pool whose insert stores the name upper-cased, as a writer whose lower-casing disagreed with Postgres would. */
const disagreeingWriter = {
  principal: {
    create: (args: CreateArgs) =>
      db.principal.create({ ...args, data: { ...args.data, name: String(args.data.name).toUpperCase() } }),
  },
} as unknown as MintDb;

/** A pool whose insert fails with the given error. */
const failingWith = (err: unknown) =>
  ({ principal: { create: () => Promise.reject(err) } }) as unknown as MintDb;

describe('#4411 item 1: mintPrincipal maps a chk_principals_name_lower violation to RootNameInvalidError', () => {
  it('refuses typed, naming the name, when the database CHECK refuses the insert', async () => {
    const err = await mintPrincipal(disagreeingWriter, { kind: 'org', name: 'acme.example' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RootNameInvalidError);
    expect((err as RootNameInvalidError).rootName).toBe('acme.example');
    // Fails closed: nothing was stored under either spelling.
    expect(await db.principal.count({ where: { name: { in: ['acme.example', 'ACME.EXAMPLE'] } } })).toBe(0);
  });

  it('maps the CHECK as a raw statement reports it too (P2010, SQLSTATE 23514)', async () => {
    const raw = await db.$executeRaw`
      INSERT INTO principals (id, name, kind, status, created_at, updated_at)
      VALUES (${generateId()}, 'Raw.Example', 'org', 'active', now(), now())`.catch((e: unknown) => e);
    expect(raw).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const err = await mintPrincipal(failingWith(raw), { kind: 'org', name: 'raw.example' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RootNameInvalidError);
  });

  it('still maps a unique violation to RootNameTakenError', async () => {
    await mintPrincipal(db, { kind: 'org', name: 'taken.example' });
    await expect(mintPrincipal(db, { kind: 'user', name: 'taken.example' })).rejects.toBeInstanceOf(RootNameTakenError);
  });

  it('leaves any other database error untyped: a different CHECK is not this refusal', async () => {
    const other = new Prisma.PrismaClientUnknownRequestError(
      'new row for relation "principals" violates check constraint "chk_principals_something_else"',
      { clientVersion: Prisma.prismaVersion.client },
    );
    const err = await mintPrincipal(failingWith(other), { kind: 'org', name: 'other.example' }).catch((e: unknown) => e);
    expect(err).toBe(other);
  });
});

describe('#4411 item 2: post-push.sql refuses a mixed-case principal row with an actionable message', () => {
  const postPush = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
  const BEGIN = '-- #4411 preflight chk_principals_name_lower: begin';
  const END = '-- #4411 preflight chk_principals_name_lower: end';

  /** The guard as post-push.sql carries it, between its sentinel comments (each present exactly once). */
  const preflight = (): string => {
    expect(postPush.split(BEGIN).length - 1, `post-push.sql must carry "${BEGIN}" exactly once`).toBe(1);
    expect(postPush.split(END).length - 1, `post-push.sql must carry "${END}" exactly once`).toBe(1);
    return postPush.slice(postPush.indexOf(BEGIN) + BEGIN.length, postPush.indexOf(END));
  };

  /** Run the guard on a database from before the constraint holding `rows`; everything is rolled back. */
  const runOnLegacy = async (rows: { name: string; kind?: string; status?: string }[]): Promise<string> => {
    const guard = preflight();
    let said = 'NO ERROR';
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE principals DROP CONSTRAINT chk_principals_name_lower');
      for (const r of rows) {
        await tx.$executeRaw`INSERT INTO principals (id, name, kind, status, created_at, updated_at)
          VALUES (${generateId()}, ${r.name}, ${r.kind ?? 'org'}, ${r.status ?? 'active'}, now(), now())`;
      }
      await tx.$executeRawUnsafe('SAVEPOINT before_preflight');
      try { await tx.$executeRawUnsafe(guard); } catch (e) {
        said = JSON.stringify((e as { meta?: unknown }).meta ?? {}) + String((e as { message?: string }).message);
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT before_preflight');
      throw new Error('rollback');
    }).catch((e) => { if ((e as Error).message !== 'rollback') throw e; });
    return said;
  };

  it('sits ahead of the ADD CONSTRAINT it guards', () => {
    const at = postPush.indexOf('ADD CONSTRAINT chk_principals_name_lower');
    expect(at).toBeGreaterThan(-1);
    expect(postPush.indexOf(END)).toBeGreaterThan(-1);
    expect(postPush.indexOf(END)).toBeLessThan(at);
  });

  it('names each offending row, says whether it has a lower-case twin, and says what to do', async () => {
    const said = await runOnLegacy([
      { name: 'legacy.example' },
      { name: 'Legacy.Example', status: 'released' },
      { name: 'Lonely.Example', kind: 'user' },
    ]);
    expect(said).toContain('HDPRF');
    expect(said).toContain('2 principal row(s)');
    expect(said).toContain('Legacy.Example');
    expect(said).toContain('Lonely.Example');
    expect(said).toMatch(/'Legacy\.Example' \([^)]*lower-case twin exists\)/);
    expect(said).not.toMatch(/'Lonely\.Example' \([^)]*twin/);
    expect(said).toContain('pnpm db:dev-setup');
    // Not the raw violation the ADD CONSTRAINT would have raised.
    expect(said).not.toContain('violates check constraint');
  });

  it('passes on a pool that is already lower case', async () => {
    expect(await runOnLegacy([{ name: 'clean.example' }])).toBe('NO ERROR');
  });
});
