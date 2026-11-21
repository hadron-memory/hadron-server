/**
 * #4593 (S1 of #4521): the @apollo/server 4 -> 5 move must change nothing a client can see.
 * v5 answers a variable-coercion error with HTTP 400 by default; v4 answered 200 with `errors`.
 * server.ts sets `status400ForVariableCoercionErrors: false` to keep the v4 answer. Flipping it
 * to 400 is S2, a client-visible contract change that needs a ruling and a client read first.
 *
 * GREEN on main by design: it passes on v4 and guards that the option stays set through the bump.
 * It boots the REAL createServer (through createServerOnCleanDb, #3066) and POSTs over HTTP, so a missing option in server.ts turns it red
 * under v5. The two admission pins prove the L2/L3 limits still answer 400 with their stable codes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServerOnCleanDb } from '../../test/startServerFixture.js';

let server: Server | undefined;
let base = '';

beforeEach(async () => {
  server = httpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
});

const post = (body: unknown) => fetch(`${base}/graphql`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'apollo-require-preflight': 'true' },
  body: JSON.stringify(body),
});

describe('#4593 /graphql wire answers are unchanged by the Apollo 5 move', () => {
  it('GREEN: a bad variable answers 200 with errors and the unchanged extensions.code', async () => {
    const res = await post({
      query: 'query Q($n: String!) { __type(name: $n) { name } }',
      variables: { n: { not: 'a string' } },
    });
    const json = await res.json() as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(res.status).toBe(200);
    expect(json.errors).toHaveLength(1);
    expect(json.errors![0]!.extensions!.code).toBe('BAD_USER_INPUT');
  });

  it('GREEN: a missing required variable answers 200 with errors too', async () => {
    const res = await post({ query: 'query Q($n: String!) { __type(name: $n) { name } }' });
    const json = await res.json() as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(res.status).toBe(200);
    expect(json.errors![0]!.extensions!.code).toBe('BAD_USER_INPUT');
  });

  it('GREEN: a document that does not parse still answers 400 GRAPHQL_PARSE_FAILED', async () => {
    const res = await post({ query: '{ ' });
    const json = await res.json() as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(res.status).toBe(400);
    expect(json.errors![0]!.extensions!.code).toBe('GRAPHQL_PARSE_FAILED');
  });

  it('GREEN: a document that fails validation still answers 400 GRAPHQL_VALIDATION_FAILED', async () => {
    const res = await post({ query: '{ thisFieldDoesNotExist }' });
    const json = await res.json() as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(res.status).toBe(400);
    expect(json.errors![0]!.extensions!.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});
