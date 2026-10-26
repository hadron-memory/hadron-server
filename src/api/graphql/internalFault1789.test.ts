/**
 * #1789 / cor:api:260:01 — an internal fault shows the caller one generic code and a request id; detail goes to the log.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';
import { formatGraphQLError } from './formatError.js';
import { UrnParseError } from '../../lib/urn.js';
import { assignRequestId, bindRequestId } from '../../lib/requestContext.js';

afterEach(() => vi.restoreAllMocks());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const secret = '/srv/private/path.ts private-id-1789 SELECT secrets';

function apolloWrap(original: Error, extra: Record<string, unknown> = {}) {
  const error = new GraphQLError(original.message, { originalError: original });
  const formatted: GraphQLFormattedError = { message: original.message, extensions: { code: 'INTERNAL_SERVER_ERROR', ...extra }, path: ['someField'] };
  return { error, formatted };
}

/** Run `fn` inside one request's context, as the /graphql middleware chain does. */
function inRequest<T>(fn: () => T): { result: T; requestId: string } {
  const res = { locals: {} as Record<string, unknown>, setHeader: () => {} };
  assignRequestId({ headers: {} } as never, res as never, () => {});
  let result!: T;
  bindRequestId({} as never, res as never, () => { result = fn(); });
  return { result, requestId: res.locals.requestId as string };
}

describe('GraphQL internal-fault envelope (#1789)', () => {
  it('an uncoded Error becomes the generic code + fixed message + requestId, and nothing else', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error, formatted } = apolloWrap(new Error(secret));
    const { result, requestId } = inRequest(() => formatGraphQLError(formatted, error));
    expect(result.message).toBe('Internal server error.');
    expect(result.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', requestId });
    expect(result.path).toEqual(['someField']);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('logs the detail under the same request id and keeps the original for Sentry', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error(secret);
    const { error, formatted } = apolloWrap(original);
    const { requestId } = inRequest(() => formatGraphQLError(formatted, error));
    expect(log).toHaveBeenCalledWith('[graphql] internal_fault', expect.objectContaining({ requestId, error: original }));
    expect(error.originalError).toBe(original);
  });

  it('the database-fault branch carries the request id too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error, formatted } = apolloWrap(new Prisma.PrismaClientKnownRequestError(secret, { clientVersion: 'test', code: 'P2003' }));
    const { result, requestId } = inRequest(() => formatGraphQLError(formatted, error));
    expect(result.message).toBe('Internal server error.');
    expect(result.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', requestId });
  });

  it('two identical faults on separate requests get distinct request ids', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = [0, 1].map(() => {
      const { error, formatted } = apolloWrap(new Error('same fault'));
      return inRequest(() => formatGraphQLError(formatted, error)).result.extensions?.requestId;
    });
    expect(ids[0]).toMatch(UUID);
    expect(ids[1]).toMatch(UUID);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('two faults in ONE request share its id', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = inRequest(() => [new Error('a'), new Error('b')].map((e) => {
      const { error, formatted } = apolloWrap(e);
      return formatGraphQLError(formatted, error).extensions?.requestId;
    }));
    expect(result[0]).toBe(result[1]);
  });

  it('outside a request a fault still gets a well-formed id', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error, formatted } = apolloWrap(new Error('job fault'));
    expect(formatGraphQLError(formatted, error).extensions?.requestId).toMatch(UUID);
  });

  it('a public code on the wrapper never overrides a foreign original (coded-wrapper bypass)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error(secret);
    const error = new GraphQLError(original.message, { originalError: original, extensions: { code: 'BAD_USER_INPUT' } });
    const formatted: GraphQLFormattedError = { message: original.message, extensions: { code: 'BAD_USER_INPUT' }, path: ['someField'] };
    const { result, requestId } = inRequest(() => formatGraphQLError(formatted, error));
    expect(result.message).toBe('Internal server error.');
    expect(result.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', requestId });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  describe('controls: typed refusals and framework refusals keep their code and text', () => {
    it('a mapped domain class keeps message and code', () => {
      const original = new UrnParseError('bad slug', 'reserved-word-slug', 'user');
      const error = new GraphQLError(original.message, { originalError: original });
      const out = formatGraphQLError({ message: original.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } }, error);
      expect(out.message).toBe(original.message);
      expect(out.extensions?.code).toBe('BAD_USER_INPUT');
      expect(out.extensions?.requestId).toBeUndefined();
    });

    it('an explicitly coded GraphQLError is untouched', () => {
      const err = new GraphQLError('Forbidden for you', { extensions: { code: 'FORBIDDEN' } });
      const formatted = { message: 'Forbidden for you', extensions: { code: 'FORBIDDEN' } };
      expect(formatGraphQLError(formatted, err)).toEqual(formatted);
    });

    it.each(['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'UNAUTHENTICATED', 'BAD_USER_INPUT'])('framework code %s keeps its text', (code) => {
      const err = new GraphQLError('Cannot query field "x" on type "Query".', { extensions: { code } });
      const formatted = { message: err.message, extensions: { code } };
      expect(formatGraphQLError(formatted, err)).toEqual(formatted);
    });
  });
});
