/**
 * The principal pool's typed errors to the GraphQL refusals (`rethrowRootNameErrors`).
 * #4481 gave `RootNameInvalidError` its own `ROOT_NAME_INVALID` code; #4515 moved the mapper out of the org
 * resolver module into `rootNameErrors.ts`, so this file imports it from there.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { MAX_ATOM_LEN } from '../urn.js';
import { mintPrincipal, ROOT_NAME_RULE_TEXT, RootNameInvalidError, RootNameTakenError } from './mintPrincipal.js';
import { rethrowRootNameErrors } from './rootNameErrors.js';

beforeEach(async () => {
  await cleanDb(db);
});

/** What the mapper throws for `err`, or fails the test if it lets `err` through unchanged. */
function mapped(err: unknown): GraphQLError {
  try {
    rethrowRootNameErrors(err);
  } catch (e) {
    if (e === err) throw new Error('mapper rethrew the original error instead of mapping it');
    return e as GraphQLError;
  }
  throw new Error('mapper returned without throwing');
}

describe('#4516 F7: the refusal message echoes a bounded, escaped name and derives its bound from MAX_ATOM_LEN', () => {
  it('elides the tail of an oversized name (mutant: no truncation) with the code unchanged', () => {
    const big = `x${'y'.repeat(9_998)}TAIL`;
    const gql = mapped(new RootNameInvalidError(big));
    expect(gql.extensions.code).toBe('ROOT_NAME_INVALID');
    expect(gql.message.length).toBeLessThan(400);
    expect(gql.message).not.toContain('TAIL');
  });

  it('escapes a quote-bearing name (mutant: no JSON.stringify)', () => {
    const gql = mapped(new RootNameInvalidError('a"b\nc'));
    expect(gql.extensions.code).toBe('ROOT_NAME_INVALID');
    expect(gql.message).toContain(JSON.stringify('a"b\nc'));
  });

  it('states the bound from MAX_ATOM_LEN (mutant: a hard-coded 64)', () => {
    expect(ROOT_NAME_RULE_TEXT).toContain(`1–${MAX_ATOM_LEN}`);
    expect(mapped(new RootNameInvalidError('ünï')).message).toContain(ROOT_NAME_RULE_TEXT);
  });
});

describe('rethrowRootNameErrors', () => {
  it('maps RootNameInvalidError to the ROOT_NAME_INVALID typed refusal', () => {
    const gql = mapped(new RootNameInvalidError('ünï'));
    expect(gql).toBeInstanceOf(GraphQLError);
    expect(gql.extensions.code).toBe('ROOT_NAME_INVALID');
    expect(gql.message).toMatch(/1–64 lower-case ASCII/);
  });

  it('maps RootNameTakenError to the existing taken refusal (regression guard)', () => {
    const gql = mapped(new RootNameTakenError('holger'));
    expect(gql.extensions.code).toBe('BAD_USER_INPUT');
    expect(gql.message).toMatch(/already taken/i);
  });

  it('maps the error the pool REALLY throws on a taken name, not a hand-built one', async () => {
    // The mapped error is only as good as the class the mint throws: remove the P2002 mapping in mintPrincipal
    // and the raw Prisma error reaches the mapper unchanged, which `mapped` reports instead of passing.
    await mintPrincipal(db, { kind: 'user', name: 'holger' });
    const real = await mintPrincipal(db, { kind: 'org', name: 'holger' }).then(
      () => { throw new Error('second mint resolved'); },
      (e: unknown) => e,
    );
    const gql = mapped(real);
    expect(gql.extensions.code).toBe('BAD_USER_INPUT');
    expect(gql.message).toMatch(/"holger" is already taken/);
  });

  it('maps the error the pool REALLY throws on an illegal name', async () => {
    const real = await mintPrincipal(db, { kind: 'org', name: 'ünï' }).then(
      () => { throw new Error('mint resolved'); },
      (e: unknown) => e,
    );
    expect(mapped(real).extensions.code).toBe('ROOT_NAME_INVALID');
  });

  it('rethrows an unrelated error untouched', () => {
    const unrelated = new Error('boom');
    expect(() => rethrowRootNameErrors(unrelated)).toThrow(unrelated);
  });
});
