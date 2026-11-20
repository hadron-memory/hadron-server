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
    // P2010's meta.message carries the primary message on its first line and the failing-row detail after it.
    const text = String((raw as Prisma.PrismaClientKnownRequestError).meta?.message);
    expect(text.split('\n', 1)[0]).toMatch(/"chk_principals_name_lower"/);
    expect(text.split('\n', 1)[0]).not.toMatch(/Raw\.Example/);
    const err = await mintPrincipal(failingWith(raw), { kind: 'org', name: 'raw.example' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RootNameInvalidError);
  });

  it('still maps a unique violation to RootNameTakenError', async () => {
    await mintPrincipal(db, { kind: 'org', name: 'taken.example' });
    await expect(mintPrincipal(db, { kind: 'user', name: 'taken.example' })).rejects.toBeInstanceOf(RootNameTakenError);
    // The catch branch itself, with no availability check in front of it (#4547 BLIND re-rate P3).
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`name`)', {
      code: 'P2002', clientVersion: Prisma.prismaVersion.client, meta: { target: ['name'] },
    });
    await expect(mintPrincipal(failingWith(p2002), { kind: 'org', name: 'race.example' }))
      .rejects.toBeInstanceOf(RootNameTakenError);
  });

  /** The real error a model write gets from the CHECK, captured so the variants below keep Prisma's own rendering. */
  const realViolation = async (): Promise<Prisma.PrismaClientUnknownRequestError> => {
    const e = await db.principal.create({ data: { name: 'Real.Violation', kind: 'org', status: 'active' } })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    const err = e as Prisma.PrismaClientUnknownRequestError;
    expect(err.message).toMatch(/code: \\?"23514\\?"/);
    return err;
  };
  /** The engine's rendering: `PostgresError { code: "…", message: "…", severity: …, detail: Some("…"), … }`. */
  const PRIMARY_MESSAGE_RE = /(PostgresError \{ code: "[0-9A-Z]{5}", message: ")((?:[^"\\]|\\.)*)(")/;
  const DETAIL_RE = /(detail: Some\(")((?:[^"\\]|\\.)*)("\))/;
  /** Replace the primary message, whatever language the server wrote it in. */
  const withPrimaryMessage = (rendered: string, text: string): string => {
    expect(rendered, 'the engine rendering this test rewrites').toMatch(PRIMARY_MESSAGE_RE);
    return rendered.replace(PRIMARY_MESSAGE_RE, (_m, a: string, _b: string, c: string) => a + text + c);
  };
  const withDetail = (rendered: string, text: string): string => {
    expect(rendered, 'the engine renders a failing-row detail').toMatch(DETAIL_RE);
    return rendered.replace(DETAIL_RE, (_m, a: string, _b: string, c: string) => a + text + c);
  };
  const unknownWith = (message: string) =>
    new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: Prisma.prismaVersion.client });
  const rawWith = (code: string, message: string) =>
    new Prisma.PrismaClientKnownRequestError('raw query failed', {
      code: 'P2010', clientVersion: Prisma.prismaVersion.client, meta: { code, message },
    });
  const mintWith = (err: unknown) =>
    mintPrincipal(failingWith(err), { kind: 'org', name: 'other.example' }).catch((e: unknown) => e);

  it('keeps the database error as the cause of the typed refusal', async () => {
    const err = await mintPrincipal(disagreeingWriter, { kind: 'org', name: 'cause.example' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RootNameInvalidError);
    expect((err as Error).cause).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
  });

  it('maps a translated message: only the SQLSTATE and the quoted constraint name are matched (lc_messages)', async () => {
    // A deterministic localized message, written over the engine's primary-message field (#4547 BLIND re-rate P2):
    // the test no longer depends on the live server writing English.
    const real = await realViolation();
    const translated = withPrimaryMessage(real.message,
      'neue Zeile für Relation \\"principals\\" verletzt Check-Constraint \\"chk_principals_name_lower\\"');
    expect(translated).toContain('verletzt Check-Constraint');
    expect(await mintWith(unknownWith(translated))).toBeInstanceOf(RootNameInvalidError);
    expect(await mintWith(rawWith('23514', 'neue Zeile verletzt Check-Constraint "chk_principals_name_lower"')))
      .toBeInstanceOf(RootNameInvalidError);
  });

  it('leaves a real violation of a DIFFERENT check untyped, though it carries 23514', async () => {
    const real = await realViolation();
    const other = unknownWith(real.message.replaceAll('chk_principals_name_lower', 'chk_principals_something_else'));
    expect(other.message).toMatch(/23514/);
    expect(await mintWith(other)).toBe(other);
    const otherRaw = rawWith('23514', 'new row violates check constraint "chk_principals_something_else"');
    expect(await mintWith(otherRaw)).toBe(otherRaw);
  });

  it('leaves a different check untyped when this constraint\'s name appears only in the failing-row detail', async () => {
    // #4547 BLIND re-rate P2: the SQLSTATE and the constraint name must come from the primary error, not from
    // anywhere in the rendering (the detail echoes the failing row's values).
    const real = await realViolation();
    const other = unknownWith(withDetail(
      withPrimaryMessage(real.message, 'new row for relation \\"principals\\" violates check constraint \\"chk_principals_other\\"'),
      'Failing row contains (x, \\"chk_principals_name_lower\\", org).',
    ));
    expect(other.message).toMatch(/code: "23514"/);
    expect(other.message).toMatch(/\\?"chk_principals_name_lower\\?"/);
    expect(await mintWith(other)).toBe(other);
    const otherRaw = rawWith('23514',
      'ERROR: new row for relation "principals" violates check constraint "chk_principals_other"\n'
      + 'DETAIL: Failing row contains (x, "chk_principals_name_lower", org).');
    expect(await mintWith(otherRaw)).toBe(otherRaw);
  });

  it('leaves an error naming this constraint under another SQLSTATE untyped', async () => {
    const real = await realViolation();
    const notCheck = unknownWith(real.message.replace(/code: (\\?)"23514(\\?)"/, 'code: $1"23505$2"'));
    expect(notCheck.message).not.toMatch(/23514/);
    expect(await mintWith(notCheck)).toBe(notCheck);
    const notCheckRaw = rawWith('23505', 'duplicate key value violates "chk_principals_name_lower"');
    expect(await mintWith(notCheckRaw)).toBe(notCheckRaw);
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

  it('names each offending row, says whether another row shares its root, and says what to do', async () => {
    const said = await runOnLegacy([
      { name: 'legacy.example' },
      { name: 'Legacy.Example', status: 'released' },
      { name: 'Lonely.Example', kind: 'user' },
    ]);
    expect(said).toContain('HDPRF');
    expect(said).toContain('2 principal row(s)');
    expect(said).toContain('Legacy.Example');
    expect(said).toContain('Lonely.Example');
    expect(said).toMatch(/'Legacy\.Example' \([^)]*shares its root with another row\)/);
    expect(said).not.toMatch(/'Lonely\.Example' \([^)]*shares its root/);
    expect(said).toContain('pnpm db:dev-setup');
    // Not the raw violation the ADD CONSTRAINT would have raised.
    expect(said).not.toContain('violates check constraint');
  });

  it('flags two mixed-case spellings of one root even when no lower-case row exists', async () => {
    // #4547 BLIND re-rate P2: both spellings compete for `legacy.example`; lower-casing both would collide.
    const said = await runOnLegacy([{ name: 'Legacy.Example' }, { name: 'LEGACY.EXAMPLE', kind: 'user' }, { name: 'Lonely.Example' }]);
    expect(said).toContain('3 principal row(s)');
    expect(said).toMatch(/'LEGACY\.EXAMPLE' \([^)]*shares its root with another row\)/);
    expect(said).toMatch(/'Legacy\.Example' \([^)]*shares its root with another row\)/);
    expect(said).not.toMatch(/'Lonely\.Example' \([^)]*shares its root/);
  });

  it('passes on a pool that is already lower case', async () => {
    expect(await runOnLegacy([{ name: 'clean.example' }])).toBe('NO ERROR');
  });
});
