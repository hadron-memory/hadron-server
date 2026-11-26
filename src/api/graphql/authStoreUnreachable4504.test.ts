/**
 * #4504 — the acceptance centerpiece: a REAL unreachable database (not a paused pool, not a
 * mock) through the REAL request-auth wiring, on both surfaces the issue names.
 *
 * #4496's QA saw 6–12 of 150 paused-DB requests per case answer a generic 500: the pool-wait
 * arms (P2024/P2028) were typed by #4471, but a NEW connection that cannot establish raises
 * Prisma P1001, which no classifier named. This file pins the decided answer end-to-end:
 *
 *   - a real PrismaClient pointed at 127.0.0.1:1 — nothing listens there, so the connection
 *     is refused at once and the engine raises P1001 (the same code the paused-DB run saw);
 *   - the app mirrors server.ts's wiring: the /graphql Apollo context builder and the
 *     /graphql/schema route both resolve the credential through
 *     resolveCredentialContextWithStatus, and the express stack ends in the same
 *     internalFaultErrorHandler;
 *   - a well-formed key of EITHER shape (user, App) must get the typed retryable 503 with
 *     reason STORE_UNREACHABLE and fixed prose — byte-identical across key shapes, because
 *     an unreachable store cannot tell a verdict it never read (no key-state oracle), and no
 *     driver text (the P1001 message embeds the host:port) anywhere on the wire;
 *   - controls with a healthy client prove the wiring: the same mounts answer 200/401 when
 *     the store answers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express4';
import { PrismaClient } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { resolveCredentialContextWithStatus } from '../../middleware/auth.js';
import { assignRequestId } from '../../lib/requestContext.js';
import { internalFaultErrorHandler } from '../../lib/internalFault.js';
import { AUTH_STORE_UNREACHABLE_MESSAGE } from '../../lib/authStoreBusy.js';
import { formatGraphQLError } from './formatError.js';

// Port 1 on loopback: nothing listens, the connection is refused immediately — a deterministic
// unreachable store, unlike a pause, which depends on connect timeouts.
const UNREACHABLE_URL = 'postgresql://127.0.0.1:1/hadron_unreachable';
const USER_KEY = 'hdr_user_' + '7e'.repeat(32);
const APP_KEY = 'hdr_app_' + '3f'.repeat(32);

let apollo: ApolloServer;
let server: Server;
let base = '';
const unreachable = new PrismaClient({ datasourceUrl: UNREACHABLE_URL });

beforeAll(async () => {
  apollo = new ApolloServer({
    typeDefs: 'type Query { hello: String }',
    resolvers: { Query: { hello: () => 'world' } },
    formatError: formatGraphQLError, // exactly server.ts's wiring
  });
  await apollo.start();
  const app = express();
  app.use(assignRequestId);
  app.use(express.json());
  // /graphql/schema BEFORE the /graphql mount, exactly as server.ts registers it: an
  // app.use('/graphql') prefix-matches /graphql/schema too, so the order is load-bearing —
  // mounted the other way round, Apollo swallows the schema route (found the hard way).
  const schemaRoute = (client: typeof unreachable | typeof db, path: string) => {
    app.get(path, async (req, res, next) => {
      try {
        const { auth } = await resolveCredentialContextWithStatus(req, client);
        if (!auth.userId && !auth.appId) {
          res.status(401).json({ error: 'Authentication required to read the GraphQL schema.' });
          return;
        }
        res.type('text/plain; charset=utf-8').send('type Query { hello: String }');
      } catch (err) {
        next(err);
      }
    });
  };
  schemaRoute(unreachable, '/graphql/schema');
  schemaRoute(db, '/graphql/schema-ok');
  // /graphql as server.ts mounts it: the credential resolves inside the Apollo context
  // builder, so a store fault surfaces as a context failure — the surface Apollo would
  // answer with its untyped context-failure 500 if the typed error were not thrown.
  app.use('/graphql', expressMiddleware(apollo, {
    context: async ({ req }) => {
      const { auth } = await resolveCredentialContextWithStatus(req, unreachable);
      return { auth };
    },
  }));
  // Control: the same mount against the healthy per-worker test DB — an unknown key
  // resolves anonymous there, proving the route works and only the fault answers 503/typed.
  app.use('/graphql-ok', expressMiddleware(apollo, {
    context: async ({ req }) => {
      const { auth } = await resolveCredentialContextWithStatus(req, db);
      return { auth };
    },
  }));
  app.use(internalFaultErrorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await apollo.stop();
  await unreachable.$disconnect();
});

describe('an unreachable store during request auth (#4504, decided: typed retryable 503, reason STORE_UNREACHABLE)', () => {
  it('/graphql: a well-formed user key gets the typed 503 — not a context-failure 500 — with no driver text', async () => {
    const res = await fetch(base + '/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${USER_KEY}` },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(503);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toBe(AUTH_STORE_UNREACHABLE_MESSAGE);
    // #4591: the three fixed fields. Apollo consumes `extensions.http` for the 503 asserted above.
    expect(body.errors[0].extensions).toStrictEqual({
      code: 'AUTH_STORE_BUSY',
      retryable: true,
      reason: 'STORE_UNREACHABLE',
    });
    // The engine's message names the host:port; none of it may reach the caller.
    expect(text).not.toMatch(/P1001|Can't reach|127\.0\.0\.1|ECONNREFUSED|INTERNAL_SERVER_ERROR/i);
  }, 30_000);

  it('/graphql: a well-formed App key gets the byte-identical answer — an unreachable store cannot tell a verdict it never read', async () => {
    const [userRes, appRes] = await Promise.all([
      fetch(base + '/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${USER_KEY}` },
        body: JSON.stringify({ query: '{ hello }' }),
      }),
      fetch(base + '/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${APP_KEY}` },
        body: JSON.stringify({ query: '{ hello }' }),
      }),
    ]);
    expect(appRes.status).toBe(userRes.status);
    const userBody = (await userRes.json()) as { errors: unknown[] };
    const appBody = (await appRes.json()) as { errors: unknown[] };
    expect(appBody.errors).toEqual(userBody.errors);
  }, 30_000);

  it('/graphql/schema: the plain-HTTP route answers the same typed 503 with the sibling prose, and the request id correlates', async () => {
    const res = await fetch(base + '/graphql/schema', { headers: { authorization: `Bearer ${USER_KEY}` } });
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(503);
    expect(body).toEqual({
      error: AUTH_STORE_UNREACHABLE_MESSAGE,
      code: 'AUTH_STORE_BUSY',
      retryable: true,
      reason: 'STORE_UNREACHABLE',
      requestId: res.headers.get('x-request-id'),
    });
    expect(text).not.toMatch(/P1001|Can't reach|127\.0\.0\.1|ECONNREFUSED|INTERNAL_SERVER_ERROR/i);
  }, 30_000);

  it('controls: the same mounts against a healthy store answer 200 (anonymous context) and 401 (schema requires a principal)', async () => {
    const graphql = await fetch(base + '/graphql-ok', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${USER_KEY}` },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    expect(graphql.status).toBe(200);
    expect(await graphql.json()).toEqual({ data: { hello: 'world' } });
    const schema = await fetch(base + '/graphql/schema-ok', { headers: { authorization: `Bearer ${USER_KEY}` } });
    expect(schema.status).toBe(401);
    expect(await schema.json()).toEqual({ error: 'Authentication required to read the GraphQL schema.' });
  });
});
