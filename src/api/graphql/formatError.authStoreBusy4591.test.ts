/**
 * #4591 — the GraphQL boundary renders AUTH_STORE_BUSY from fixed values only
 * (cor:aut:010:05, cor:api:260:01).
 *
 * `instanceof` proves the class, not that a subclass or a late mutation kept the error's
 * message and extensions intact. The public error is the normalized reason, the fixed prose for
 * that reason, `code`, `retryable` and `reason`, and nothing else the thrown error carries. The
 * plain-HTTP boundary already holds this (#4519); both now read one reason normalizer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express4';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import {
  AUTH_STORE_BUSY_MESSAGE,
  AUTH_STORE_UNREACHABLE_MESSAGE,
  AuthStoreBusyError,
  normalizeAuthStoreBusyReason,
  type AuthStoreBusyReason,
} from '../../lib/authStoreBusy.js';
import { formatGraphQLError } from './formatError.js';

const DRIVER = "Can't reach database server at `db.internal:5432`";

const FIXED: Record<AuthStoreBusyReason, string> = {
  POOL_WAIT: AUTH_STORE_BUSY_MESSAGE,
  STORE_UNREACHABLE: AUTH_STORE_UNREACHABLE_MESSAGE,
};

/** A typed fault whose public surface was changed after construction. */
function tampered(
  mutate: (extensions: Record<string, unknown>) => void,
  reason: AuthStoreBusyReason = 'POOL_WAIT',
): AuthStoreBusyError {
  const error = new AuthStoreBusyError(new Error(DRIVER), reason);
  mutate(error.extensions as Record<string, unknown>);
  return error;
}

/** What Apollo hands `formatError`: its own copy of the thrown error's message and extensions. */
function format(thrown: AuthStoreBusyError): GraphQLFormattedError {
  const { http: _consumedByApollo, ...extensions } = thrown.extensions;
  return formatGraphQLError({ message: thrown.message, path: ['hello'], extensions }, thrown);
}

function expectFixed(out: GraphQLFormattedError, reason: AuthStoreBusyReason): void {
  expect(out.message).toBe(FIXED[reason]);
  expect(out.extensions).toStrictEqual({ code: 'AUTH_STORE_BUSY', retryable: true, reason });
  expect(JSON.stringify(out)).not.toContain('db.internal');
}

describe('the rendered error is exactly the fixed fields (#4591)', () => {
  it.each(['POOL_WAIT', 'STORE_UNREACHABLE'] as const)('keeps the recognized reason %s, its prose and the path', (reason) => {
    const out = format(new AuthStoreBusyError(new Error(DRIVER), reason));
    expectFixed(out, reason);
    expect(out.path).toEqual(['hello']);
  });

  it('drops an extension added to the error', () => {
    const out = format(tampered((e) => { e.diagnostic = DRIVER; }));
    expectFixed(out, 'POOL_WAIT');
  });

  it('drops an extension that only the formatted error carries', () => {
    const typed = new AuthStoreBusyError(new Error(DRIVER), 'STORE_UNREACHABLE');
    const out = formatGraphQLError({ message: typed.message, extensions: { diagnostic: DRIVER } }, typed);
    expectFixed(out, 'STORE_UNREACHABLE');
  });

  it.each([
    ['absent', undefined],
    ['an unknown string', DRIVER],
    ['a differently cased value', 'store_unreachable'],
    ['an object', { detail: DRIVER }],
    ['an array holding a known value', ['STORE_UNREACHABLE']],
  ])('answers POOL_WAIT and its prose when reason is %s', (_label, value) => {
    const out = format(tampered((e) => {
      if (value === undefined) delete e.reason;
      else e.reason = value;
    }, 'STORE_UNREACHABLE'));
    expectFixed(out, 'POOL_WAIT');
  });

  // #5253: `instanceof` proves the class, not that `extensions` survived. The renderers read the reason through `?.`, so an error
  // whose extensions were nulled or removed after construction still normalizes to POOL_WAIT. The GraphQL 503 is not asserted: Apollo
  // reads the status from the thrown `extensions.http` before `formatError` runs, so no renderer can supply it.
  it.each([
    ['null', (e: AuthStoreBusyError) => { (e as unknown as { extensions: unknown }).extensions = null; }],
    ['removed', (e: AuthStoreBusyError) => { delete (e as unknown as { extensions?: unknown }).extensions; }],
  ])('answers POOL_WAIT, its prose and the three fixed fields when the error\'s extensions are %s (#5253)', (_label, gone) => {
    const error = new AuthStoreBusyError(new Error(DRIVER), 'STORE_UNREACHABLE');
    gone(error);
    const out = formatGraphQLError({ message: error.message, path: ['hello'], extensions: {} }, error);
    expectFixed(out, 'POOL_WAIT');
    expect(out.path).toEqual(['hello']);
  });

  it('answers POOL_WAIT when the extensions are gone on an error wrapped as a resolver throw is (#5253)', () => {
    const original = new AuthStoreBusyError(new Error(DRIVER), 'STORE_UNREACHABLE');
    (original as unknown as { extensions: unknown }).extensions = null;
    const wrapper = new GraphQLError(original.message, { originalError: original });
    const out = formatGraphQLError({ message: wrapper.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } }, wrapper);
    expectFixed(out, 'POOL_WAIT');
  });

  it('answers the fixed code and retryable when both were changed', () => {
    const out = format(tampered((e) => { e.code = DRIVER; e.retryable = DRIVER; }));
    expectFixed(out, 'POOL_WAIT');
  });

  it('renders the prose from the reason, not the thrown message', () => {
    const error = new AuthStoreBusyError(new Error(DRIVER), 'STORE_UNREACHABLE');
    error.message = DRIVER;
    expectFixed(format(error), 'STORE_UNREACHABLE');
  });

  it('holds for a subclass, wrapped as a resolver throw is', () => {
    class Chatty extends AuthStoreBusyError {
      constructor() {
        super(new Error(DRIVER), 'POOL_WAIT');
        this.message = DRIVER;
        (this.extensions as Record<string, unknown>).diagnostic = DRIVER;
      }
    }
    const original = new Chatty();
    const wrapper = new GraphQLError(original.message, { originalError: original });
    const out = formatGraphQLError(
      { message: wrapper.message, extensions: { code: 'INTERNAL_SERVER_ERROR', diagnostic: DRIVER } },
      wrapper,
    );
    expectFixed(out, 'POOL_WAIT');
  });
});

describe('the shared reason normalizer (#4591)', () => {
  it.each([
    ['STORE_UNREACHABLE', 'STORE_UNREACHABLE'],
    ['POOL_WAIT', 'POOL_WAIT'],
    [undefined, 'POOL_WAIT'],
    [null, 'POOL_WAIT'],
    ['store_unreachable', 'POOL_WAIT'],
    [['STORE_UNREACHABLE'], 'POOL_WAIT'],
  ])('maps %j to %s', (input, expected) => {
    expect(normalizeAuthStoreBusyReason(input)).toBe(expected);
  });
});

describe('through real Apollo (#4591)', () => {
  let apollo: ApolloServer;
  let server: Server;
  let base = '';
  const thrown = () => tampered((e) => { e.diagnostic = DRIVER; e.reason = { detail: DRIVER }; }, 'STORE_UNREACHABLE');

  beforeAll(async () => {
    apollo = new ApolloServer({
      typeDefs: 'type Query { hello: String }',
      resolvers: { Query: { hello: () => { throw thrown(); } } },
      formatError: formatGraphQLError,
    });
    await apollo.start();
    const app = express();
    app.use(express.json());
    app.use('/context', expressMiddleware(apollo, { context: async () => { throw thrown(); } }));
    app.use('/resolver', expressMiddleware(apollo, { context: async () => ({}) }));
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await apollo.stop();
  });

  it.each(['/context', '/resolver'])('%s: 503, the three fixed extensions and no driver text', async (mount) => {
    const res = await fetch(base + mount, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    const text = await res.text();
    expect(res.status).toBe(503);
    const [wire] = JSON.parse(text).errors;
    expect(wire.message).toBe(AUTH_STORE_BUSY_MESSAGE);
    expect(wire.extensions).toStrictEqual({ code: 'AUTH_STORE_BUSY', retryable: true, reason: 'POOL_WAIT' });
    expect(text).not.toContain('db.internal');
  });
});
