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
 * The accepted-edge pins pin the rule's other side and go red at a guard that
 * is over-tight (a refusal of `a`, a 64-char name, `a.b_c-d`, `a..b`,
 * `Example` or the Kelvin sign would fail them). A refused name writes no row
 * and leaves `ensure*Principal`'s behavior for conforming names unchanged.
 * The error-to-GraphQL mapper's own pins live in `rootNameErrors.test.ts`.
 *
 * #4515 added the direct `isValidRootName` table, the adjacent-separator,
 * trailing-newline and Kelvin-sign pins at both the mint and the probe, the
 * `ensureOrgPrincipal` contract, and the real-class taken-name path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import {
  mintPrincipal,
  checkRootAvailable,
  ensureUserPrincipal,
  ensureOrgPrincipal,
  isValidRootName,
  RootNameTakenError,
} from './mintPrincipal.js';

beforeEach(async () => {
  await cleanDb(db);
});

/**
 * Assert `promise` (a mint or an `ensure*Principal` call — the availability
 * probe never rejects, it answers false) refuses `name` with the TYPED
 * #4481 error.
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
  // The refusal names the name AS STORED (post-lower-casing): for `İ` the
  // message carries `i̇`, its lower-cased form — the rule governs the stored
  // name, and the message shows what was refused about it.
  expect((settled as Error).message).toContain(name.toLowerCase());
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

describe('mintPrincipal — #4481 refusals', () => {
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
        await checkRootAvailable(db, name),
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

describe('isValidRootName — the rule itself, direct table (#4515)', () => {
  // The mint and the probe lower-case before validating, so a test that goes
  // through them cannot tell a lower-case-only rule from one that also admits
  // upper case. Judge the predicate directly.
  const ACCEPTED = ['a', 'a1', 'a.b_c-d', 'a..b', 'a--b', '0', 'a'.repeat(64)];
  const REFUSED = [
    'Example', 'EXAMPLE', 'aB', 'Ab', // upper case: the rule governs the STORED (lower-cased) form
    '', 'a'.repeat(65), '.a', 'a.', '-a', 'a-', '_a', 'a_', 'a b', 'a:b', 'ünï', 'a\n', '\na', 'a\n\n', 'K',
  ];
  for (const name of ACCEPTED) {
    it(`accepts ${JSON.stringify(name.length > 12 ? `${name.slice(0, 4)}…${name.length}ch` : name)}`, () => {
      expect(isValidRootName(name)).toBe(true);
    });
  }
  for (const name of REFUSED) {
    it(`refuses ${JSON.stringify(name.length > 12 ? `${name.slice(0, 4)}…${name.length}ch` : name)}`, () => {
      expect(isValidRootName(name)).toBe(false);
    });
  }
});

describe('root-name edges at BOTH the mint and the probe (#4515)', () => {
  it('`a..b` is legal: adjacent interior separators are part of the atom grammar', async () => {
    expect(await checkRootAvailable(db, 'a..b')).toBe(true);
    const { id } = await mintPrincipal(db, { kind: 'org', name: 'a..b' });
    expect((await db.principal.findUniqueOrThrow({ where: { id } })).name).toBe('a..b');
    expect(await checkRootAvailable(db, 'a..b')).toBe(false); // now taken, not refused
  });

  it("a trailing newline `'a\\n'` is refused: `$` must not tolerate it", async () => {
    expect(await checkRootAvailable(db, 'a\n')).toBe(false);
    await expectTypedRefusal(mintPrincipal(db, { kind: 'org', name: 'a\n' }), 'a\n');
    expect(await db.principal.count()).toBe(0);
    // And the legal neighbour is untouched, so the refusal is the newline's.
    expect(await checkRootAvailable(db, 'a')).toBe(true);
  });

  it('the Kelvin sign (U+212A) is accepted: its stored form is the ASCII `k`', async () => {
    // Lower-casing happens BEFORE the rule, so the rule judges the stored `k`.
    // A guard moved above the lower-casing would refuse this name.
    const kelvin = 'K';
    expect(kelvin.toLowerCase()).toBe('k');
    expect(await checkRootAvailable(db, kelvin)).toBe(true);
    const { id } = await mintPrincipal(db, { kind: 'org', name: kelvin });
    expect((await db.principal.findUniqueOrThrow({ where: { id } })).name).toBe('k');
    expect(await checkRootAvailable(db, 'k')).toBe(false); // the same root, now taken
  });
});

describe('ensureOrgPrincipal — the wrapper contract (#4515)', () => {
  it('mints for a principal-less org and links it', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'o', urn: 'ensure-org-pin' },
    });
    await ensureOrgPrincipal(db, org);
    const linked = await db.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { principalId: true },
    });
    expect(linked.principalId).not.toBeNull();
    const row = await db.principal.findUniqueOrThrow({ where: { id: linked.principalId! } });
    expect(row).toMatchObject({ name: 'ensure-org-pin', kind: 'org', status: 'active' });
  });

  it('is a no-op for an org that already has a principal (no second mint, link unchanged)', async () => {
    const first = await mintPrincipal(db, { kind: 'org', name: 'already-linked' });
    const org = await db.organization.create({
      data: { id: generateId(), name: 'o', urn: 'already-linked', principalId: first.id },
    });
    // A wrapper without its `principalId` guard would mint `already-linked` again and throw RootNameTakenError.
    await expect(ensureOrgPrincipal(db, org)).resolves.toBeUndefined();
    expect(await db.principal.count()).toBe(1);
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: org.id }, select: { principalId: true } })).principalId,
    ).toBe(first.id);
  });

  it('refuses an illegal org urn with the typed error, writes no row and leaves the org unlinked', async () => {
    // The wrapper goes through the mint, so it cannot store a name the grammar cannot express.
    const org = await db.organization.create({
      data: { id: generateId(), name: 'o', urn: 'ünï-org' },
    });
    await expectTypedRefusal(ensureOrgPrincipal(db, org), 'ünï-org');
    expect(await db.principal.count()).toBe(0);
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: org.id }, select: { principalId: true } })).principalId,
    ).toBeNull();
  });
});

describe('the taken-name error is the REAL class from the real path (#4515)', () => {
  it('a second mint of the same name rejects with RootNameTakenError (the P2002 mapping)', async () => {
    await mintPrincipal(db, { kind: 'user', name: 'taken-name' });
    // Removing the P2002 -> RootNameTakenError mapping in mintPrincipal lets the raw Prisma error through.
    const err = await mintPrincipal(db, { kind: 'org', name: 'Taken-Name' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RootNameTakenError);
    expect((err as RootNameTakenError).rootName).toBe('taken-name');
    expect(await db.principal.count()).toBe(1);
  });
});
