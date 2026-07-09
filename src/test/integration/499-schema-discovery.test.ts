/**
 * #499 — GraphQL schema discovery route.
 *
 * Apollo introspection is off in production, but `hadron api <raw GraphQL>` is
 * the documented CLI fallback for anything the curated commands don't cover —
 * which needs the schema. GET /graphql/schema serves the SDL to any
 * authenticated principal; anonymous callers get 401.
 *
 * Boots the real express app (like the 025-oauth suites) and hits the route
 * over HTTP so route ordering vs the '/graphql' Apollo mount is exercised too.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

let server: Server;
let baseUrl: string;
let jwt: string;

beforeAll(async () => {
  await cleanDb(db);
  const user = await db.user.create({
    data: { id: generateId(), handle: 'sdl-reader', githubUsername: 'sdl-reader', roles: ['READER'] },
  });
  jwt = await signJwt({ sub: user.id, roles: ['READER'] });

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('GET /graphql/schema (#499)', () => {
  it('401s an anonymous request (no schema for scrapers)', async () => {
    const res = await fetch(`${baseUrl}/graphql/schema`);
    expect(res.status).toBe(401);
  });

  it('serves the SDL to an authenticated principal', async () => {
    const res = await fetch(`${baseUrl}/graphql/schema`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const sdl = await res.text();
    // Real SDL — contains the root type and the surface the CLI needs to
    // discover (findNodes is the whole point of the escape hatch).
    expect(sdl).toContain('type Query');
    expect(sdl).toContain('findNodes');
  });

  it('does not let the /graphql Apollo mount swallow the schema path', async () => {
    // Regression guard on route ordering: a GET to /graphql/schema must hit our
    // handler, not Apollo (which would answer with a GraphQL error envelope).
    const res = await fetch(`${baseUrl}/graphql/schema`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await res.text();
    expect(body).not.toContain('"errors"');
    expect(body.trimStart().startsWith('{')).toBe(false);
  });
});
