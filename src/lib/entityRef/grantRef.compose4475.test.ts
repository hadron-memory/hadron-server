/**
 * #4475 (follow-up to #4465): the refusal classes of composeGrantUrn and the narrowed catch of Grant.urn.
 * Pure unit pins: no database. Spec: cor:urn:010:01 (shape), cor:api:260:01 (a fault propagates, only a typed refusal is null).
 */
import { describe, expect, it } from 'vitest';
import { UrnNotQualifiedError, UrnParseError } from '../urn.js';
import { composeGrantUrn } from './grantRef.js';
import { grantFieldResolvers } from '../../api/graphql/schema/resolvers.grant.js';

const ID = '0123456789abcdef0123456789abcdef';
const refusal = (e: unknown) => e instanceof UrnParseError || e instanceof UrnNotQualifiedError;
const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

describe('#4475 composeGrantUrn refusal classes', () => {
  it('composes the canonical form for a simple <root>:<slug> App urn', () => {
    expect(composeGrantUrn('acme.test:app', ID)).toBe(`hrn:grant:acme.test:app:${ID}`);
  });

  it('a urn with no colon is a UrnParseError', () => {
    expect(thrown(() => composeGrantUrn('nocolon', ID))).toBeInstanceOf(UrnParseError);
  });

  it.each(['root:a:b', ':x', 'x:'])('%s never composes: a typed urn-lib refusal, not a fault', (appUrn) => {
    const e = thrown(() => composeGrantUrn(appUrn, ID));
    expect(e, `${appUrn} must throw`).toBeDefined();
    expect(refusal(e), `${appUrn} threw ${String(e)}`).toBe(true);
  });
});

describe('#4475 Grant.urn narrows its catch', () => {
  const urn = grantFieldResolvers.Grant.urn;

  it('is the composed URN for a composable App urn', () => {
    expect(urn({ appUrn: 'acme.test:app', id: ID })).toBe(`hrn:grant:acme.test:app:${ID}`);
  });

  it.each(['nocolon', 'root:a:b', ':x', 'x:'])('a typed compose refusal (%s) is null, never a throw', (appUrn) => {
    expect(urn({ appUrn, id: ID })).toBeNull();
  });

  it('a genuine fault propagates (cor:api:260:01): a non-string App urn throws a TypeError, not null', () => {
    expect(() => urn({ appUrn: undefined as unknown as string, id: ID })).toThrow(TypeError);
    expect(() => urn({ appUrn: null as unknown as string, id: ID })).toThrow(TypeError);
  });
});
