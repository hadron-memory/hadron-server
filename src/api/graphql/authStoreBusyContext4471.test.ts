/**
 * #4471 BLIND P2-1 — the 503 asserted through REAL Apollo, not the mapping in isolation.
 *
 * The unit tests in formatError.test.ts prove the mapping restores the typed code; this pin
 * builds the server exactly as server.ts does (expressMiddleware from @as-integrations/express4,
 * `formatError: formatGraphQLError`) and throws the typed fault from the CONTEXT BUILDER — the
 * middleware's real surface, where Apollo would otherwise wrap it as an untyped
 * INTERNAL_SERVER_ERROR over a context-failure 500. What must reach the wire: HTTP 503 (the
 * extensions.http channel, #1303's mechanism — pinned end-to-end here, which also kills the
 * LOCAL survivor mutant that flipped it to 500 unnoticed), the fixed prose with NO "Context
 * creation failed" prefix, exactly the typed extensions, and no driver text.
 *
 * #4504 adds the unreachable arm's row: the same mount shape throwing the P1001-shaped fault
 * must answer the same 503 under the same code, with the sibling reason and prose on the wire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express4';
import { Prisma } from '../../generated/prisma/index.js';
import {
  AUTH_STORE_BUSY_MESSAGE,
  AUTH_STORE_UNREACHABLE_MESSAGE,
  AuthStoreBusyError,
} from '../../lib/authStoreBusy.js';
import { formatGraphQLError } from './formatError.js';

let apollo: ApolloServer;
let server: Server;
let base = '';

beforeAll(async () => {
  apollo = new ApolloServer({
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
        { code: 'P2024', clientVersion: '6.19.2' },
      ), 'POOL_WAIT');
    },
  }));
  // #4504: the unreachable arm on the same real surface — P1001 arrives as an
  // initialization error (host:port in the message is the driver text that must not leak).
  app.use('/graphql-unreachable', expressMiddleware(apollo, {
    context: async () => {
      throw new AuthStoreBusyError(
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server at `127.0.0.1:5432` after 1 attempts",
          '6.19.2',
          'P1001',
        ),
        'STORE_UNREACHABLE',
      );
    },
  }));
  // The control: the same server, a healthy context — proves the 503 below is the fault's
  // answer, not a broken harness.
  app.use('/graphql-ok', expressMiddleware(apollo, { context: async () => ({}) }));
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
// #4504 hygiene (Bradley P3): stop Apollo too, not just the listener — the server holds
// timers/middleware state that outlive server.close() otherwise.
afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await apollo.stop();
});

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
    // Exactly the fixed fields (#4591). Apollo consumes `extensions.http` to set the 503 above,
    // and the formatter no longer copies it back onto the wire.
    expect(wire.extensions).toStrictEqual({
      code: 'AUTH_STORE_BUSY',
      retryable: true,
      reason: 'POOL_WAIT',
    });
    expect(text).not.toMatch(/P2024|Timed out fetching/i);
  });

  it('#4504: the unreachable arm answers the same 503 and code, with the sibling reason and prose', async () => {
    const res = await fetch(base + '/graphql-unreachable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(503);
    expect(body.errors).toHaveLength(1);
    const wire = body.errors[0];
    expect(wire.message).toBe(AUTH_STORE_UNREACHABLE_MESSAGE);
    expect(wire.extensions).toStrictEqual({
      code: 'AUTH_STORE_BUSY',
      retryable: true,
      reason: 'STORE_UNREACHABLE',
    });
    // The host:port from the driver message never reaches the wire.
    expect(text).not.toMatch(/P1001|Can't reach|127\.0\.0\.1/i);
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
