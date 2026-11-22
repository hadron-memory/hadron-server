/** #4876: each parser error class folds into the bare unknown-App answer, and nothing else does. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';

const resolveAppRef = vi.fn();
vi.mock('../entityRef/appRef.js', () => ({ resolveAppRef: (...a: unknown[]) => resolveAppRef(...a) }));

import { resolveAppRefConcealed } from './workerRead.js';
import { UrnNotQualifiedError, UrnParseError } from '../urn.js';
import { AmbiguousLegacyUrnError, AppNotFoundError } from '../entityRef/errors.js';

beforeEach(() => resolveAppRef.mockReset());

const SECRET = 'hdr_user_CANARY';
describe('resolveAppRefConcealed folds exactly the ref-shape failures', () => {
  const folded: Array<[string, () => Error]> = [
    ['UrnParseError', () => new UrnParseError(SECRET, 'invalid-segment-shape')],
    ['UrnNotQualifiedError', () => new UrnNotQualifiedError(SECRET, undefined, 'app')],
    ['AppNotFoundError', () => new AppNotFoundError(SECRET)],
    ['AmbiguousLegacyUrnError', () => new AmbiguousLegacyUrnError(SECRET, ['a', 'b'] as never)],
  ];
  for (const [name, make] of folded) {
    it(`${name} answers the bare App not found, no echo`, async () => {
      resolveAppRef.mockRejectedValueOnce(make());
      const err = await resolveAppRefConcealed({} as never, SECRET).catch((e) => e);
      expect(err).toBeInstanceOf(GraphQLError);
      expect(err.message).toBe('App not found.');
      expect(err.extensions).toEqual({ code: 'APP_NOT_FOUND' });
      expect(JSON.stringify(err.toJSON())).not.toContain('CANARY');
    });
  }
  it('a database fault and any other error propagate untouched', async () => {
    for (const boom of [new Error('connection terminated'), new TypeError('x')]) {
      resolveAppRef.mockRejectedValueOnce(boom);
      await expect(resolveAppRefConcealed({} as never, SECRET)).rejects.toBe(boom);
    }
  });
});
