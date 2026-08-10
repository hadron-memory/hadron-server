/**
 * The GraphQL client-error mapping (#918).
 *
 * `formatError` had no test of any kind — it was an inline lambda inside
 * `createServer`, so the only way to reach it was to boot the whole app. That
 * is why a typed error class could ship with a `code` nobody ever put on the
 * wire. Extracting it made the mapping a unit, and these are its tests; the
 * end-to-end proof that the code survives the real Apollo pipeline lives in
 * src/test/integration/918-asset-error-codes.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { formatGraphQLError, isExpectedClientError } from './formatError.js';
import { UrnNotQualifiedError, UrnParseError } from '../../lib/urn.js';
import { AmbiguousLegacyUrnError } from '../../lib/entityRef/errors.js';
import { AssetUploadError } from '../../controller/operations/beginAssetUpload.js';

/** What Apollo hands `formatError` for a thrown (non-GraphQLError) error. */
function wrap(original: Error): { formatted: GraphQLFormattedError; error: GraphQLError } {
  const error = new GraphQLError(original.message, { originalError: original });
  return {
    formatted: { message: original.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    error,
  };
}

function format(original: Error): GraphQLFormattedError {
  const { formatted, error } = wrap(original);
  return formatGraphQLError(formatted, error);
}

describe('AssetUploadError → extensions.code (#918)', () => {
  // Every code the class throws today. The mapping is by CLASS, so this list is
  // documentation rather than the mechanism — a code added later is carried
  // without touching formatError.
  const CODES = [
    'MALWARE_BLOCKED',
    'SCAN_PENDING',
    'SCAN_BLOCKED',
    'NOT_FOUND',
    'PERMISSION_DENIED',
    'UNAUTHENTICATED',
    'INVALID_INPUT',
    'MIME_NOT_ALLOWED',
    'SIZE_EXCEEDED',
    'MEMORY_NOT_ACCEPTING_UPLOADS',
    'MEMORY_ENCRYPTED_NO_KEY',
    'TOOL_NOT_ENABLED',
    'ASSET_BYTES_GONE',
    'ASSET_NOT_DELETED',
  ];

  it.each(CODES)('surfaces %s', (code) => {
    const out = format(new AssetUploadError(code, 'nope'));
    expect(out.extensions?.code).toBe(code);
    expect(out.message).toBe('nope');
  });

  it('carries a code the class has not defined yet (mapped by class, not by list)', () => {
    const out = format(new AssetUploadError('SOME_FUTURE_REFUSAL', 'nope'));
    expect(out.extensions?.code).toBe('SOME_FUTURE_REFUSAL');
  });

  it('replaces the default INTERNAL_SERVER_ERROR rather than sitting beside it', () => {
    const out = format(new AssetUploadError('SCAN_PENDING', 'nope'));
    expect(out.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('the pre-existing URN mappings still hold (extraction regression)', () => {
  it('UrnNotQualifiedError → URN_NOT_QUALIFIED with its detail fields', () => {
    const out = format(new UrnNotQualifiedError('bad', undefined, 'node'));
    expect(out.extensions).toMatchObject({
      code: 'URN_NOT_QUALIFIED',
      offendingValue: 'bad',
      expectedType: 'node',
    });
  });

  it('UrnParseError → BAD_USER_INPUT', () => {
    const err = new UrnParseError('malformed', 'reserved-word-slug', 'user');
    const out = format(err);
    expect(out.extensions?.code).toBe('BAD_USER_INPUT');
    expect(out.extensions?.reason).toBe(err.reason);
  });

  it('AmbiguousLegacyUrnError → AmbiguousLegacyUrnError with the ref', () => {
    const out = format(new AmbiguousLegacyUrnError('org::mem'));
    expect(out.extensions).toMatchObject({
      code: 'AmbiguousLegacyUrnError',
      offendingValue: 'org::mem',
    });
  });
});

describe('everything else is left alone', () => {
  it('passes an unmapped error through untouched', () => {
    const { formatted, error } = wrap(new Error('something actually broke'));
    expect(formatGraphQLError(formatted, error)).toBe(formatted);
  });

  it('preserves extensions the formatter already set (path, http, …)', () => {
    const original = new AssetUploadError('NOT_FOUND', 'asset not found');
    const out = formatGraphQLError(
      { message: original.message, extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['x'] } },
      new GraphQLError(original.message, { originalError: original }),
    );
    expect(out.extensions?.stacktrace).toEqual(['x']);
    expect(out.extensions?.code).toBe('NOT_FOUND');
  });

  it('handles an error that is its own original (constructed as GraphQLError)', () => {
    const err = new GraphQLError('direct', { extensions: { code: 'ALREADY_TYPED' } });
    const out = formatGraphQLError({ message: 'direct', extensions: { code: 'ALREADY_TYPED' } }, err);
    expect(out.extensions?.code).toBe('ALREADY_TYPED');
  });
});

describe('isExpectedClientError — the anti-drift half', () => {
  // Sentry classifies at didEncounterErrors time, BEFORE formatError runs, so
  // it cannot read the code and must consult the type. Sharing one list is what
  // stops a newly mapped client error from still being filed as a server fault
  // — which is what an asset NOT_FOUND was doing.
  it.each([
    ['AssetUploadError', new AssetUploadError('NOT_FOUND', 'x')],
    ['UrnNotQualifiedError', new UrnNotQualifiedError('bad', undefined, 'node')],
    ['UrnParseError', new UrnParseError('bad', 'reserved-word-slug', 'user')],
    ['AmbiguousLegacyUrnError', new AmbiguousLegacyUrnError('org::mem')],
  ])('%s is expected, so Sentry skips it', (_name, err) => {
    expect(isExpectedClientError(err)).toBe(true);
    // …and it is expected precisely BECAUSE it is mapped: the two agree by
    // construction, which is the property the shared list exists to give.
    expect(format(err as Error).extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
  });

  it('a genuine fault is NOT expected — it still reaches Sentry', () => {
    expect(isExpectedClientError(new Error('boom'))).toBe(false);
    expect(isExpectedClientError(new TypeError('undefined is not a function'))).toBe(false);
  });
});
