/**
 * #4481 — the #4415 root-name rule at the principal pool (#692).
 *
 * A principal root name (a user handle OR an org name — one shared pool) is
 * 1–64 lower-case ASCII letters, digits, `.`, `_` or `-`, beginning and ending
 * with a letter or digit: urn-lib's atom grammar (`ATOM_RE`, `MAX_ATOM_LEN`
 * = 64) restricted to lower case, per the Holger ruling recorded on #4415
 * (cor:urn:010:01). `mintPrincipal` now refuses a name outside that rule with
 * a typed `RootNameInvalidError` (distinct from `RootNameTakenError`) and
 * `checkRootAvailable` agrees (a refused name is not available).
 *
 * The rule applies to the name AS STORED (post-`toLowerCase()`): `Example` is
 * accepted and stored `example`; `İ` is refused because its lower-cased form
 * carries a combining mark (the writer's `toLowerCase()` and Postgres
 * `lower()` could otherwise disagree — the #4415 motivation).
 *
 * Red on main (3810250e1): every refusal pin fails as "resolved instead of
 * rejected" — main's mint accepts `ünï`, a 65-char name, a leading `.` etc.
 * and writes the row; `checkRootAvailable` answers true for each; the
 * resolver-mapping pin fails because the shared mapper and its
 * `ROOT_NAME_INVALID` code do not exist yet. The accepted-edge pins are
 * green on main BY DESIGN: they pin the rule's other side and go red at a
 * head whose guard is over-tight (a refusal of `a`, a 64-char name, `a.b_c-d`
 * or `Example` would fail them). Xanthos' binding addition (#4481 gate): a
 * refused name writes no row and leaves `ensure*Principal`'s behavior for
 * conforming names unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import {
  mintPrincipal,
  checkRootAvailable,
  ensureUserPrincipal,
  type PrincipalDb,
} from './mintPrincipal.js';

beforeEach(async () => {
  await cleanDb(db);
});

/**
 * Assert `promise` (a mint or availability probe) refuses `name` with the
 * TYPED #4481 error. Written without importing `RootNameInvalidError`
 * statically so the file runs on main, where the class does not exist: there
 * the mint resolves and the first line fails with a readable message instead
 * of a module-load error.
 */
async function expectTypedRefusal(
  promise: Promise<unknown>,
  name: string,
): Promise<void> {
  const settled = await promise.then(
    (value) => {
      throw new Error(
        `mint of "${name}" resolved (${JSON.stringify(value)}) — expected the typed RootNameInvalidError refusal (#4481)`,
      );
    },
    (err: unknown) => err,
  );
  expect(settled, `refusal for "${name}" is an Error`).toBeInstanceOf(Error);
  expect(
    (settled as Error).name,
    `refusal for "${name}" is the TYPED error, not a bare one`,
  ).toBe('RootNameInvalidError');
  expect((settled as Error).message).toMatch(/1–64 lower-case ASCII/);
  expect((settled as Error).message).toContain(name);
}

/** Every #4481 refusal, with the guard each one exists to kill (see mutants). */
const REFUSALS: ReadonlyArray<{ name: string; guard: string }> = [
  { name: '', guard: 'empty (length)' },
  // 65 characters — one past MAX_ATOM_LEN (the length guard's dedicated killer;
  // the 64-char edge is pinned as accepted below).
  { name: 'a'.repeat(65), guard: 'length > 64' },
  // Leading separator: legal charset, illegal position — kills the start guard.
  { name: '.dot', guard: 'leading separator' },
  { name: '-dash', guard: 'leading separator' },
  { name: '_under', guard: 'leading separator' },
  // Trailing separator — kills the end guard.
  { name: 'dot.', guard: 'trailing separator' },
  { name: 'dash-', guard: 'trailing separator' },
  { name: 'under_', guard: 'trailing separator' },
  // Non-ASCII under toLowerCase(): unchanged non-ASCII, and a char whose
  // lower-casing LENGTHENS and leaves the ASCII range (i̇ = i + U+0307).
  { name: 'ünï', guard: 'non-ASCII' },
  { name: 'İ', guard: 'non-ASCII, toLowerCase changes length' },
  // Mid-string charset violations — the charset guard's dedicated killers
  // (start/end are legal, so only the middle class refuses them).
  { name: 'a b', guard: 'mid-string space' },
  { name: 'a:b', guard: 'mid-string colon' },
];

describe('mintPrincipal — #4481 refusals (red on main)', () => {
  for (const { name, guard } of REFUSALS) {
    it(`refuses "${name === '' ? '(empty)' : name.length > 12 ? `${name.slice(0, 4)}…${name.length}ch` : name}" (${guard}) with the typed error and no row`, async () => {
      await expectTypedRefusal(
        mintPrincipal(db, { kind: 'org', name }),
        name,
      );
      // The refusal writes no row (Xanthos' binding addition).
      expect(await db.principal.count()).toBe(0);
    });
  }

  it('a leading/trailing separator pair is refused even between legal atoms', async () => {
    // Extra positional coverage beyond the table: separators legal in the
    // middle are refused at BOTH edges of the same name.
    await expectTypedRefusal(mintPrincipal(db, { kind: 'org', name: '.a.' }), '.a.');
    await expectTypedRefusal(mintPrincipal(db, { kind: 'org', name: '-a-' }), '-a-');
    await expectTypedRefusal(mintPrincipal(db, { kind: 'org', name: '_a_' }), '_a_');
    expect(await db.principal.count()).toBe(0);
  });

  it('the typed refusal is DISTINCT from RootNameTakenError (a free illegal name is invalid, not taken)', async () => {
    // On main this mint SUCCEEDS (the name is free), so the settled-error
    // assertions below are the red side; at head the error must be the
    // invalid-name one — a seat must not conflate it with the taken-name one.
    const settled = await mintPrincipal(db, { kind: 'org', name: 'ünï' }).then(
      () => {
        throw new Error('mint of "ünï" resolved — expected RootNameInvalidError (#4481)');
      },
      (err: unknown) => err,
    );
    expect((settled as Error).name).toBe('RootNameInvalidError');
    expect((settled as Error).name).not.toBe('RootNameTakenError');
    expect((settled as Error).message).not.toMatch(/taken/i);
  });
});

describe('mintPrincipal — #4481 accepted edges (guard against over-tightening)', () => {
  it('accepts the 1-character edge `a` and stores it as given', async () => {
    const { id } = await mintPrincipal(db, { kind: 'user', name: 'a' });
    expect(await db.principal.findUniqueOrThrow({ where: { id } })).toMatchObject({
      name: 'a',
      status: 'active',
    });
  });

  it('accepts a 64-character name (MAX_ATOM_LEN exactly)', async () => {
    const name = 'a'.repeat(63) + '9'; // legal start AND end
    await mintPrincipal(db, { kind: 'org', name });
    expect(await checkRootAvailable(db, name)).toBe(false); // it is now taken
  });

  it('accepts `a.b_c-d` and `a1` — every separator and digits in the middle', async () => {
    await mintPrincipal(db, { kind: 'org', name: 'a.b_c-d' });
    await mintPrincipal(db, { kind: 'user', name: 'a1' });
    expect(await db.principal.count()).toBe(2);
  });

  it('accepts `Example`, lower-cased to `example` (the rule applies to the stored name)', async () => {
    const { id } = await mintPrincipal(db, { kind: 'org', name: 'Example' });
    expect(
      (await db.principal.findUniqueOrThrow({ where: { id } })).name,
    ).toBe('example');
  });
});

describe('checkRootAvailable — agrees with the mint (#4481)', () => {
  it('returns false for every refused name (the probe and the mint are one rule)', async () => {
    for (const { name } of REFUSALS) {
      expect(
        await checkRootAvailable(db as unknown as PrincipalDb, name),
        `checkRootAvailable("${name === '' ? '(empty)' : name}")`,
      ).toBe(false);
    }
    // Nothing was minted by the probe.
    expect(await db.principal.count()).toBe(0);
  });

  it('still returns true for a free conforming name (the probe is not over-tight)', async () => {
    expect(await checkRootAvailable(db, 'a.b_c-d')).toBe(true);
    expect(await checkRootAvailable(db, 'Example')).toBe(true); // probes the stored form
  });
});

describe('ensureUserPrincipal — unchanged for conforming names, refuses illegal ones (#4481 gate addition)', () => {
  it('a conforming handle still mints and links (existing behavior)', async () => {
    const user = await db.user.create({
      data: { id: generateId(), handle: 'conforming-1', roles: ['READER'] },
    });
    await ensureUserPrincipal(db, user);
    const linked = await db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { principalId: true },
    });
    expect(linked.principalId).not.toBeNull();
    expect(await db.principal.count()).toBe(1);
  });

  it('an illegal handle is refused, writes no row and leaves the user unlinked', async () => {
    const user = await db.user.create({
      data: { id: generateId(), handle: 'ünï', roles: ['READER'] },
    });
    await expectTypedRefusal(ensureUserPrincipal(db, user), 'ünï');
    const after = await db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { principalId: true },
    });
    expect(after.principalId).toBeNull();
    expect(await db.principal.count()).toBe(0);
  });
});

describe('GraphQL surfacing — the shared mapper gives RootNameInvalidError its own code (#4481)', () => {
  // The org-resolver callers (updateMyProfile / createOrganization /
  // updateOrganization) validate BEFORE the mint, so the mapping is a
  // backstop that no end-to-end call can reach today. Pin the mapper itself.
  // Imported dynamically: on main the export (and the error class) do not
  // exist, and this pin must fail with a readable assertion, not a load error.
  it('maps RootNameInvalidError to the ROOT_NAME_INVALID typed refusal', async () => {
    const org = await import('../../api/graphql/schema/resolvers.mutation.org.js');
    const mint = await import('./mintPrincipal.js');
    const mapper = (org as { rethrowRootNameErrors?: (err: unknown) => never })
      .rethrowRootNameErrors;
    expect(typeof mapper).toBe('function');
    const invalid = new (mint as { RootNameInvalidError: new (name: string) => Error })
      .RootNameInvalidError('ünï');
    expect(() => mapper!(invalid)).toThrow(GraphQLError);
    try {
      mapper!(invalid);
    } catch (e) {
      const gql = e as GraphQLError;
      expect(gql.extensions.code).toBe('ROOT_NAME_INVALID');
      expect(gql.message).toMatch(/1–64 lower-case ASCII/);
    }
  });

  it('the mapper still maps RootNameTakenError to the existing taken refusal (regression guard)', async () => {
    const org = await import('../../api/graphql/schema/resolvers.mutation.org.js');
    const mint = await import('./mintPrincipal.js');
    const mapper = (org as { rethrowRootNameErrors?: (err: unknown) => never })
      .rethrowRootNameErrors;
    expect(typeof mapper).toBe('function');
    const taken = new (mint as { RootNameTakenError: new (name: string) => Error })
      .RootNameTakenError('holger');
    try {
      mapper!(taken);
      throw new Error('mapper let RootNameTakenError through');
    } catch (e) {
      const gql = e as GraphQLError;
      expect(gql.extensions.code).toBe('BAD_USER_INPUT');
      expect(gql.message).toMatch(/already taken/i);
    }
  });

  it('the mapper rethrows an unrelated error untouched', async () => {
    const org = await import('../../api/graphql/schema/resolvers.mutation.org.js');
    const mapper = (org as { rethrowRootNameErrors?: (err: unknown) => never })
      .rethrowRootNameErrors;
    expect(typeof mapper).toBe('function');
    const unrelated = new Error('boom');
    expect(() => mapper!(unrelated)).toThrow('boom');
  });
});
