/**
 * Unit pins for the #4838 App-ref fold helpers in workerRead.ts — the shared
 * four-class predicate's CONTRACT, pinned directly (Anita's surviving mutant on
 * #4871: the `UrnParseError` arm of `isAppRefResolutionFailure` had no pin, and
 * no DOOR path can pin it — `resolveAppRef` only ever throws
 * `UrnNotQualifiedError` for a malformed ref, because `assertFullyQualifiedUrn`
 * is the API boundary gate and the tolerant `parseUrnInput` never throws; the
 * arm guards a parser swap). Deliberately db-free: every input here throws
 * before any lookup, so no database is needed (and none is touched).
 */
import { describe, it, expect } from 'vitest';
import { isAppRefResolutionFailure, resolveAppRefConcealed } from './workerRead.js';
import { AppNotFoundError, AmbiguousLegacyUrnError } from '../entityRef/errors.js';
import { UrnNotQualifiedError, UrnParseError } from '../urn.js';

describe('isAppRefResolutionFailure (#4838 shared fold predicate)', () => {
  it('admits exactly the four ref-resolution failures', () => {
    expect(isAppRefResolutionFailure(new AppNotFoundError('x'))).toBe(true);
    expect(isAppRefResolutionFailure(new AmbiguousLegacyUrnError('x', []))).toBe(true);
    expect(isAppRefResolutionFailure(new UrnNotQualifiedError('x', undefined, 'app'))).toBe(true);
    expect(isAppRefResolutionFailure(new UrnParseError('x', 'invalid-charset'))).toBe(true);
  });

  it('refuses everything else (a database fault stays out — narrow catch)', () => {
    expect(isAppRefResolutionFailure(new Error('synthetic db fault'))).toBe(false);
    expect(isAppRefResolutionFailure(null)).toBe(false);
    expect(isAppRefResolutionFailure(undefined)).toBe(false);
  });
});

describe('resolveAppRefConcealed (#4876: the same four-class fold)', () => {
  // A malformed ref gets the bare unknown-App answer with NO echo of the caller's value. The db argument is never
  // touched: the ref throws inside the boundary gate before any lookup. A database fault still propagates (pinned
  // in workerRead.malformedRef4876.test.ts).
  it('a malformed ref answers the bare unknown-App answer, no echo', async () => {
    const e: any = await resolveAppRefConcealed(undefined as never, 'canary not a urn').then(
      () => {
        throw new Error('expected a refusal');
      },
      (x: unknown) => x,
    );
    expect(e).not.toBeInstanceOf(UrnNotQualifiedError);
    expect(e.message).toBe('App not found.');
    expect(e.extensions).toEqual({ code: 'APP_NOT_FOUND' });
    expect(JSON.stringify(e.toJSON())).not.toContain('canary');
  });
});
