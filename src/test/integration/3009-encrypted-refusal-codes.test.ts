/** #3009: both encrypted-memory refusals survive the actual HTTP/Apollo error boundary. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/node';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { FR_026_DISCLOSURE } from '../../lib/entityRef/errors.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';

vi.mock('@sentry/node', async (original) => ({
  ...await original<typeof import('@sentry/node')>(),
  captureException: vi.fn(),
}));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let server: Server;
let base: string;
let jwt: string;
let memory: { id: string; urn: string };

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});
beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const n = generateId().toLowerCase();
  const user = await db.user.create({ data: { handle: `enc-${n}`, roles: ['READER'] } });
  memory = await db.memory.create({
    data: { name: 'Private', urn: `enc-${n}:private`, class: 'private', userId: user.id, ownerUserId: user.id, vectorIndexEnabled: false },
  });
  await resolvers.Mutation.encryptMemory({}, { memoryId: memory.id, passphrase: 'synthetic-test-passphrase' }, {
    db, userId: user.id, roles: ['READER'],
  });
  sessionKeyCache.clear(); // Neither HTTP request supplies x-hadron-memory-keys.
  jwt = await signJwt({ sub: user.id, roles: ['READER'] });
  vi.mocked(Sentry.captureException).mockClear();
});
afterEach(() => sessionKeyCache.clear());

async function refusal(query: string, variables: Record<string, unknown>) {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { errors?: Array<{ extensions?: Record<string, unknown> }> };
  expect(body.errors).toHaveLength(1);
  return body.errors![0].extensions;
}

describe('#3009 typed encrypted-memory refusals on the wire', () => {
  it('vector opt-in without acknowledgment returns its code, four disclosures and memoryRef, and is not reported', async () => {
    const extensions = await refusal(
      'mutation($id: ID!){ updateMemory(id: $id, vectorIndexEnabled: true){ id } }', { id: memory.id },
    );
    expect(extensions).toEqual({
      code: 'ENCRYPTED_VECTOR_INDEX_NOT_ACKNOWLEDGED', disclosure: [...FR_026_DISCLOSURE], memoryRef: memory.urn,
    });
    expect(FR_026_DISCLOSURE).toHaveLength(4);
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      vectorIndexEnabled: false, vectorIndexEncryptedAckAt: null,
    });
  });

  it('a node write without an unlock key returns SESSION_EXPIRED and memoryId, without a write or report', async () => {
    const before = await db.node.count({ where: { memoryId: memory.id } });
    const extensions = await refusal(
      'mutation($input: CreateNodeInput!){ createNode(input: $input){ id } }',
      { input: { memoryId: memory.id, loc: 'entry', name: 'Entry', content: 'synthetic content' } },
    );
    expect(extensions).toEqual({ code: 'SESSION_EXPIRED', memoryId: memory.id });
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    expect(await db.node.count({ where: { memoryId: memory.id } })).toBe(before);
  });
});
