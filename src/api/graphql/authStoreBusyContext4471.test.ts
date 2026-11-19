/**
 * #4471 BLIND P2-1 — the 503 asserted through REAL Apollo, not the mapping in isolation.
 *
 * The unit tests in formatError.test.ts prove the mapping restores the typed code; this pin
 * builds the server exactly as server.ts does (expressMiddleware from @apollo/server/express4,
 * `formatError: formatGraphQLError`) and throws the typed fault from the CONTEXT BUILDER — the
 * middleware's real surface, where Apollo would otherwise wrap it as an untyped
 * INTERNAL_SERVER_ERROR over a context-failure 500. What must reach the wire: HTTP 503 (the
 * extensions.http channel, #1303's mechanism — pinned end-to-end here, which also kills the
 * LOCAL survivor mutant that flipped it to 500 unnoticed), the fixed prose with NO "Context
 * creation failed" prefix, exactly the typed extensions, and no driver text.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { Prisma } from '../../generated/prisma/index.js';
import { AUTH_STORE_BUSY_MESSAGE, AuthStoreBusyError } from '../../lib/authStoreBusy.js';
import { formatGraphQLError } from './formatError.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const apollo = new ApolloServer({
    typeDefs: 'type Query { hello: String }',
    resolvers: { Query: { hello: () => 'world' } },
    formatError: formatGraphQLError, // exactly server.ts's wiring
  });
  await apollo.start();
  const app = express();
  app.use(express.json());
  // The fault surface: the context builder rejects with the typed error, as the auth
  // middleware does when the store is too busy to answer the credential lookup.
  app.use('/graphql', expressMiddleware(apollo, {
    context: async () => {
      throw new AuthStoreBusyError(new Prisma.PrismaClientKnownRequestError(
        'Timed out fetching a new connection from the pool.',
        { code: 'P2024', clientVersion: '6.19.2' } as never,
      ));
    },
  }));
  // The control: the same server, a healthy context — proves the 503 below is the fault's
  // answer, not a broken harness.
  app.use('/graphql-ok', expressMiddleware(apollo, { context: async () => ({}) }));
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

describe('a busy store in the Apollo context builder (#4471)', () => {
  it('answers 503 with the typed code, the fixed prose and no driver text — no context-failure 500', async () => {
    const res = await fetch(base + '/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(503);
    expect(body.errors).toHaveLength(1);
    const wire = body.errors[0];
    // The domain prose, never Apollo's "Context creation failed" decoration of it.
    expect(wire.message).toBe(AUTH_STORE_BUSY_MESSAGE);
    expect(wire.message).not.toMatch(/Context creation failed/i);
    // Exactly the typed extensions. `http.status` is ON the wire by design: it is the
    // graphql-over-http channel that makes the response 503 (#1303's mechanism), and it
    // carries no driver detail — the BLIND P3 asked whether it leaks; the answer is that
    // it is the mechanism, pinned here rather than filtered.
    expect(wire.extensions).toEqual({
      code: 'AUTH_STORE_BUSY',
      retryable: true,
      reason: 'POOL_WAIT',
      http: { status: 503 },
    });
    expect(text).not.toMatch(/P2024|Timed out fetching/i);
  });

  it('control: the same server with a healthy context answers 200/{hello}', async () => {
    const res = await fetch(base + '/graphql-ok', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { hello: 'world' } });
  });
});
