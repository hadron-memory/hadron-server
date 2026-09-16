/**
 * #1174 — a not-found reaches the client as `extensions.code`, not as prose.
 *
 * `organization(ref: "nosuch.example")` answered with the message
 * `ORGANIZATION_NOT_FOUND: nosuch.example` under
 * `extensions.code: "INTERNAL_SERVER_ERROR"`. The classification existed only
 * in the English text, where nothing machine-readable could reach it:
 * hadron-cli routes `*_NOT_FOUND` CODES to exit 4, so a typo exited 1
 * ("internal error"), and `INTERNAL_SERVER_ERROR` is exactly what an operator
 * builds a page-me rule on — so every user typo tripped the alarm that should
 * mean the server broke.
 *
 * This is a WIRE contract, so it is a wire test, for the reason #918's is:
 * every resolver-level test in the suite calls the resolver directly and sees a
 * perfectly good error class while the NETWORK saw `INTERNAL_SERVER_ERROR`.
 * The defect lived entirely in the Apollo pipeline, which is the only place
 * this can be observed.
 *
 * `organization(ref:)` is the case the issue measured, and it is the right
 * one: its siblings (`agent`, `app`, `memory`) return a bare `null` on a miss
 * because missing and unreadable must be INDISTINGUISHABLE there — an
 * anti-enumeration guarantee, not an ergonomics choice. Organizations have no
 * such concern since spec 048 dropped `isVisible` and made every org listable,
 * so erroring is correct for this one entity and the divergence is justified.
 * The sibling assertions below pin that difference so nobody "harmonises" it
 * (the coordinator's triage on #1174, and
 * `conventions:the-error-code-is-the-contract-the-prose-is-not`).
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

async function graphql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  // Assert the transport before the payload: a non-GraphQL failure would
  // otherwise surface as "errors is undefined" rather than as what broke.
  expect(res.status, 'GraphQL errors ride a 200').toBe(200);
  return (await res.json()) as {
    data?: Record<string, unknown> | null;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
}

beforeAll(async () => {
  await cleanDb(db);
  const user = await db.user.create({
    data: { id: generateId(), handle: 'nf-owner', githubUsername: 'nf-owner', roles: ['ADMIN'] },
  });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
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

describe('#1174 — the not-found is in the code, not only in the message', () => {
  it('organization(ref:) on a missing org answers ORGANIZATION_NOT_FOUND', async () => {
    const body = await graphql('query Org($ref: ID!) { organization(ref: $ref) { id } }', { ref: 'nosuch.example' });
    const err = body.errors?.[0];
    expect(err, 'expected the operation to fail').toBeDefined();
    expect(err!.extensions?.code).toBe('ORGANIZATION_NOT_FOUND');
    expect(err!.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
    // The ref, structured — a client never has to split the message for it.
    expect(err!.extensions?.ref).toBe('nosuch.example');
    // The message is UNCHANGED. The code is additive: this fix must not break
    // a reader who is (wrongly) matching prose today.
    expect(err!.message).toBe('ORGANIZATION_NOT_FOUND: nosuch.example');
  });

  it('the siblings still answer a bare null, because THAT is their contract', async () => {
    // Not a "fix them too" gap: a null that covers missing AND unreadable is
    // the anti-enumeration guarantee. Pinned so the divergence stays deliberate.
    for (const [field, query, ref] of [
      ['agent', 'query A($ref: ID!) { agent(ref: $ref) { id } }', 'hrn:agent:nosuch.example:nosuch'],
      ['app', 'query P($ref: ID!) { app(ref: $ref) { id } }', 'nosuch-app'],
      ['memory', 'query M($ref: ID!) { memory(ref: $ref) { id } }', 'hrn:mem:nosuch.example:nosuch'],
    ] as const) {
      const body = await graphql(query, { ref });
      expect(body.errors, `${field} must not error on a miss`).toBeUndefined();
      expect(body.data?.[field], `${field} must answer null on a miss`).toBeNull();
    }
  });

  it('a missing org is not an alarm: the same error is not reported as a server fault', async () => {
    // The wire half above and the Sentry half are one fix — see the mapping's
    // note in formatError.ts. Asserted there as a unit; here we only pin that
    // the wire no longer SAYS "internal".
    const body = await graphql('query Org($ref: ID!) { organization(ref: $ref) { id } }', { ref: `nosuch-${generateId()}` });
    expect(body.errors?.[0]?.extensions?.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
