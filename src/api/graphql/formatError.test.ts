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
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { formatGraphQLError, isExpectedClientError } from './formatError.js';
import { UrnNotQualifiedError, UrnParseError } from '../../lib/urn.js';
import {
  AgentNotFoundError,
  AmbiguousLegacyUrnError,
  AppNotFoundError,
  AppRunNotFoundError,
  EdgeNotFoundError,
  InvalidChunkConfigError,
  MemoryNotFoundError,
  NodeNotFoundError,
  NodeRevisionNotFoundError,
  OrganizationNotFoundError,
  ScopeNotFoundError,
  SecretNotFoundError,
  UserNotFoundError,
  WorkerNotFoundError,
} from '../../lib/entityRef/errors.js';
import { SessionExpiredError } from '../../lib/nodeCrypto.js';
import { AssetUploadError } from '../../controller/operations/beginAssetUpload.js';
import { SetAssetEnabledError } from '../../controller/operations/setAgentAssetUploadEnabled.js';
import { AUTH_STORE_BUSY_MESSAGE, AuthStoreBusyError } from '../../lib/authStoreBusy.js';

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

describe('SetAssetEnabledError → extensions.code (#2979)', () => {
  it.each(['PERMISSION_DENIED', 'NOT_FOUND'])('surfaces %s with its own message and no request id', (code) => {
    const out = format(new SetAssetEnabledError(code, 'nope'));
    expect(out.extensions?.code).toBe(code);
    expect(out.message).toBe('nope');
    expect(out.extensions).not.toHaveProperty('requestId');
  });
});

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

describe('AuthStoreBusyError → AUTH_STORE_BUSY (#4471)', () => {
  const p2024 = () =>
    new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the pool.', {
      code: 'P2024',
      clientVersion: '6.19.2',
    });

  it('thrown straight from the auth middleware: the typed extensions survive the boundary', () => {
    const typed = new AuthStoreBusyError(p2024(), 'POOL_WAIT');
    const out = formatGraphQLError({ message: typed.message, extensions: { code: 'AUTH_STORE_BUSY' } }, typed);
    expect(out.extensions?.code).toBe('AUTH_STORE_BUSY');
    expect(out.extensions?.retryable).toBe(true);
    expect(out.extensions?.reason).toBe('POOL_WAIT');
    expect(out.message).toBe(AUTH_STORE_BUSY_MESSAGE);
  });

  it('Apollo-genericized (the context-failure wrap): the mapping restores the typed code and strips the prefix', () => {
    const typed = new AuthStoreBusyError(p2024(), 'POOL_WAIT');
    // Apollo's actual wrapper for a context-builder throw: its own GraphQLError — the
    // prefixed message, the default code, the thrown error on .originalError. Built with
    // wrap()'s shape plus the real prefix (the live round trip is pinned in
    // authStoreBusyContext4471.test.ts; this unit case isolates the mapping).
    const error = new GraphQLError(`Context creation failed: ${typed.message}`, { originalError: typed });
    const out = formatGraphQLError(
      { message: error.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } },
      error,
    );
    expect(out.extensions?.code).toBe('AUTH_STORE_BUSY');
    expect(out.extensions?.retryable).toBe(true);
    expect(out.extensions?.reason).toBe('POOL_WAIT');
    // The domain prose, not Apollo's decoration of it — the prefix never reaches the wire.
    expect(out.message).toBe(AUTH_STORE_BUSY_MESSAGE);
    expect(out.message).not.toMatch(/Context creation failed/i);
    // The driver error never rides the wire — not the code, not the prose.
    expect(JSON.stringify(out)).not.toMatch(/P2024|Timed out fetching/i);
  });
});

describe('the pre-existing URN mappings still hold (extraction regression)', () => {
  it('UrnNotQualifiedError → URN_NOT_QUALIFIED with its detail fields (#5168: never the offending value)', () => {
    const out = format(new UrnNotQualifiedError('bad', undefined, 'node'));
    expect(out.extensions).toMatchObject({
      code: 'URN_NOT_QUALIFIED',
      expectedType: 'node',
    });
    expect(out.extensions).not.toHaveProperty('offendingValue');
  });

  it('UrnParseError → BAD_USER_INPUT', () => {
    const err = new UrnParseError('malformed', 'reserved-word-slug', 'user');
    const out = format(err);
    expect(out.extensions?.code).toBe('BAD_USER_INPUT');
    expect(out.extensions?.reason).toBe(err.reason);
  });

  it('AmbiguousLegacyUrnError → AmbiguousLegacyUrnError (#5168: without the ref)', () => {
    const out = format(new AmbiguousLegacyUrnError('org::mem'));
    expect(out.extensions).toMatchObject({ code: 'AmbiguousLegacyUrnError' });
    expect(out.extensions).not.toHaveProperty('offendingValue');
    expect(JSON.stringify(out)).not.toContain('org::mem');
  });
});

describe('everything else is left alone', () => {
  it('passes a coded GraphQLError through untouched', () => {
    const error = new GraphQLError('refused', { extensions: { code: 'FORBIDDEN' } });
    const formatted = { message: 'refused', extensions: { code: 'FORBIDDEN' } };
    expect(formatGraphQLError(formatted, error)).toBe(formatted);
  });

  it('preserves public extensions while removing diagnostic extensions (#2087)', () => {
    const original = new AssetUploadError('NOT_FOUND', 'asset not found');
    const out = formatGraphQLError(
      { message: original.message, extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['x'], exception: { stacktrace: ['private'] }, http: { status: 404 }, appRef: 'public-ref' } },
      new GraphQLError(original.message, { originalError: original }),
    );
    expect(out.extensions?.stacktrace).toBeUndefined();
    expect(out.extensions?.exception).toBeUndefined();
    expect(out.extensions?.http).toEqual({ status: 404 });
    expect(out.extensions?.appRef).toBe('public-ref');
    expect(out.extensions?.code).toBe('NOT_FOUND');
  });

  it('handles an error that is its own original (constructed as GraphQLError)', () => {
    const err = new GraphQLError('direct', { extensions: { code: 'ALREADY_TYPED' } });
    const out = formatGraphQLError({ message: 'direct', extensions: { code: 'ALREADY_TYPED' } }, err);
    expect(out.extensions?.code).toBe('ALREADY_TYPED');
  });
});

describe('isExpectedClientError — mapped and silenced are DIFFERENT questions', () => {
  // Sentry classifies at didEncounterErrors time, BEFORE formatError runs, so
  // it cannot read the code and must consult the type. One shared list keeps a
  // second `instanceof` chain out of the plugin; what each entry does about
  // Sentry is declared per entry, because "the caller gets a typed code" and
  // "we do not want to hear about it" are not the same claim.
  it.each([
    ['UrnNotQualifiedError', new UrnNotQualifiedError('bad', undefined, 'node')],
    ['UrnParseError', new UrnParseError('bad', 'reserved-word-slug', 'user')],
    ['AmbiguousLegacyUrnError', new AmbiguousLegacyUrnError('org::mem')],
  ])('%s is silenced — mapped for the wire AND skipped by Sentry', (_name, err) => {
    expect(isExpectedClientError(err)).toBe(true);
    expect(format(err as Error).extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
  });

  // #1140 residual (the "when this lands" step of @Holger's 2026-09-06 split): the wire half of #918 shipped then, and
  // the Sentry half waited for an alarm where a missing object is DISCOVERED. That alarm now exists: the bytes-missing
  // sweep (src/jobs/sweepAssetBytes.ts, slice B) and the restore path raise `asset.bytes_missing`. So every asset
  // refusal, ASSET_BYTES_GONE included, is mapped for the wire AND silenced in the formatter's Sentry stream.
  it.each([
    ['NOT_FOUND', new AssetUploadError('NOT_FOUND', 'x')],
    ['MALWARE_BLOCKED', new AssetUploadError('MALWARE_BLOCKED', 'x')],
    ['ASSET_BYTES_GONE', new AssetUploadError('ASSET_BYTES_GONE', 'x')],
  ])('AssetUploadError %s is mapped for the wire AND classified as an expected client error, which src/server.ts skips in Sentry (#1140)', (code, err) => {
    // The wire half: the #918 fix, unchanged; the code still reaches the caller.
    expect(format(err as Error).extensions?.code).toBe(code);
    // The Sentry half: the plugin in src/server.ts skips exactly the errors isExpectedClientError accepts, so nothing is sent;
    // the discovery-side alarm reports a missing object instead (sweepAssetBytes.test.ts, restoreAsset.test.ts).
    expect(isExpectedClientError(err)).toBe(true);
  });

  it('a genuine fault is NOT expected — it still reaches Sentry', () => {
    expect(isExpectedClientError(new Error('boom'))).toBe(false);
    expect(isExpectedClientError(new TypeError('undefined is not a function'))).toBe(false);
  });
});


describe('EntityNotFoundError → its own code on the wire (#1174)', () => {
  // The whole family, because the mapping is by BASE CLASS: this list is
  // documentation, not the mechanism — a not-found added later is carried
  // without touching formatError. That is the #918 lesson one layer over.
  const FAMILY: ReadonlyArray<readonly [string, Error]> = [
    ['ORGANIZATION_NOT_FOUND', new OrganizationNotFoundError('nosuch')],
    ['AGENT_NOT_FOUND', new AgentNotFoundError('nosuch')],
    ['APP_NOT_FOUND', new AppNotFoundError('nosuch')],
    ['MEMORY_NOT_FOUND', new MemoryNotFoundError('nosuch')],
    ['NODE_NOT_FOUND', new NodeNotFoundError('nosuch')],
    ['EDGE_NOT_FOUND', new EdgeNotFoundError('nosuch')],
    ['SCOPE_NOT_FOUND', new ScopeNotFoundError('nosuch')],
    ['USER_NOT_FOUND', new UserNotFoundError('nosuch')],
    ['SECRET_NOT_FOUND', new SecretNotFoundError('nosuch')],
    ['APP_RUN_NOT_FOUND', new AppRunNotFoundError('nosuch')],
    ['WORKER_NOT_FOUND', new WorkerNotFoundError('nosuch')],
    ['NODE_REVISION_NOT_FOUND', new NodeRevisionNotFoundError('nosuch')],
  ];

  it.each(FAMILY)('%s reaches extensions.code instead of the message only', (code, err) => {
    const out = format(err);
    expect(out.extensions?.code).toBe(code);
    expect(out.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
    // #5168: the ref the caller passed is NOT relayed (it was, as `extensions.ref`): it is the caller's own text,
    // and a token pasted into a ref came back verbatim. The code is the contract.
    expect(out.extensions).not.toHaveProperty('ref');
    expect(JSON.stringify(out)).not.toContain('nosuch');
  });

  it('the MESSAGE keeps the code as its prefix and no longer quotes the ref (#5168)', () => {
    expect(format(new OrganizationNotFoundError('nosuch.example')).message).toBe(
      'ORGANIZATION_NOT_FOUND: nothing found for the given ref.',
    );
  });

  it('is silenced in Sentry, because the ALERTING half is half the fix', () => {
    // INTERNAL_SERVER_ERROR is what an operator builds a page-me rule on, so a
    // user typo tripped it. Mapping the code alone would have moved that noise
    // from the wire into the issue stream rather than removing it.
    for (const [, err] of FAMILY) expect(isExpectedClientError(err)).toBe(true);
    // And a genuine fault is still reported.
    expect(isExpectedClientError(new Error('boom'))).toBe(false);
  });
});


describe('#3136 — the swept refusals reach extensions.code', () => {
  it('SessionExpiredError → SESSION_EXPIRED with memoryId, message prefix intact for the internal catchers', () => {
    // The re-typing catchers in resolvers.comments/teamChat/teamRole match on
    // message.startsWith('SESSION_EXPIRED'), so the class mapping must not
    // reword the prefix — and the wire shape (code + memoryId) is what those
    // hand-wrapped sites already deliver, now from every path.
    const err = new SessionExpiredError('mem_1');
    expect(err.message.startsWith('SESSION_EXPIRED')).toBe(true);
    const out = format(err);
    expect(out.extensions?.code).toBe('SESSION_EXPIRED');
    expect(out.extensions?.memoryId).toBe('mem_1');
    expect(out.message.startsWith('SESSION_EXPIRED')).toBe(true);
  });

  it('InvalidChunkConfigError → INVALID_CHUNK_CONFIG with the reason', () => {
    // updateMemory throws this raw; the doc once promised a code the mapping
    // never delivered. Nothing ever reached the wire, so the convention's
    // SCREAMING_SNAKE (the message prefix) applies rather than the class name.
    const out = format(new InvalidChunkConfigError('chunkTokens must be > 0 (got 0).'));
    expect(out.extensions?.code).toBe('INVALID_CHUNK_CONFIG');
    expect(out.extensions?.reason).toBe('chunkTokens must be > 0 (got 0).');
    expect(out.message).toBe('INVALID_CHUNK_CONFIG: chunkTokens must be > 0 (got 0).');
  });

  // #3136 review (local seat F1) removed the AmbiguousUserRefError wire pin along
  // with the mapping: no GraphQL path throws the class raw (every caller answers
  // BAD_USER_INPUT or conceals), so there is no wire code to pin. The
  // disposition is recorded on the class doc in entityRef/errors.ts.

  it('both are silenced in Sentry — caller-state refusals, not faults', () => {
    // SESSION_EXPIRED: the hand-wrapped sites were already skipped by the
    // plugin's non-INTERNAL_SERVER_ERROR branch; this keeps parity. The other
    // one is a caller-input refusal in the EntityNotFoundError sense.
    expect(isExpectedClientError(new SessionExpiredError('mem_1'))).toBe(true);
    expect(isExpectedClientError(new InvalidChunkConfigError('x'))).toBe(true);
  });

  it('a site-constructed typed GraphQLError passes through the boundary untouched', () => {
    // Pass-through pin for the shape channel.createChannel now throws (the
    // createChannel wire leg itself is the integration test): a GraphQLError
    // that already carries extensions.code survives formatGraphQLError
    // byte-identical. A central InvalidLocError mapping is deliberately NOT
    // added — every GraphQL validateLoc site wraps it typed at the site with
    // the same shape (code/loc/segment), so a central entry would be dead code
    // today. (The wrap does echo the offending loc; #4106's no-echo question
    // for this shape is separate from this PR and unchanged by it.)
    const siteWrapped = new GraphQLError('Invalid loc "a:b!".', {
      extensions: { code: 'InvalidLocError', loc: 'a:b!', segment: 'b!' },
    });
    const out = formatGraphQLError(
      {
        message: siteWrapped.message,
        extensions: { code: 'InvalidLocError', loc: 'a:b!', segment: 'b!' },
      },
      siteWrapped,
    );
    expect(out.extensions?.code).toBe('InvalidLocError');
    expect(out.extensions?.loc).toBe('a:b!');
  });
});


describe('#1688 Prisma failures never expose query internals', () => {
  it.each([
    new Prisma.PrismaClientValidationError('orgMember.findFirst({userId:"private-id",organizationId:null})', { clientVersion: 'test' }),
    new Prisma.PrismaClientKnownRequestError('Secret query arguments', { clientVersion: 'test', code: 'P2003' }),
    new Prisma.PrismaClientUnknownRequestError('Secret database details', { clientVersion: 'test' }),
    new Prisma.PrismaClientInitializationError('Database credentials', 'test'),
    new Prisma.PrismaClientRustPanicError('Driver stack internals', 'test'),
  ])('sanitizes $name while retaining internal reporting', original => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { formatted, error } = wrap(original);
    const result = formatGraphQLError({ ...formatted, extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['Secret stack'], detail: 'query internals' }, path: ['createAgent', 'appCount'] }, error);
    expect(result.message).toBe('Internal server error.');
    expect(result.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
    expect(result.path).toEqual(['createAgent', 'appCount']);
    expect(error.originalError).toBe(original);
    expect(isExpectedClientError(original)).toBe(false);
  });
});
