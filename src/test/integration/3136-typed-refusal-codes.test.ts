/**
 * #3136 — the swept typed refusals carry `extensions.code` on the WIRE.
 *
 * The defect class (issue #3136, epic #3146): a refusal meant to be typed
 * reached the client as INTERNAL_SERVER_ERROR — either a class
 * CLIENT_ERROR_MAPPINGS never mapped (`InvalidChunkConfigError`;
 * `AmbiguousUserRefError` was swept too, then deliberately left UNMAPPED at
 * review — no GraphQL path throws it raw, see entityRef/errors.ts), a bare
 * `new Error('SESSION_EXPIRED…')` from nodeCrypto, or a raw `validateLoc`
 * throw (#3136 re-verification found `createChannel` was the one GraphQL site
 * still unwrapped).
 *
 * This is a WIRE test in the #918 style: it boots the real express app and
 * posts real GraphQL, because the defect lived entirely in the Apollo
 * pipeline — the unit pins in `src/api/graphql/formatError.test.ts` prove the
 * mapping; these prove the code survives the real server (the finding
 * `findings:resolver-level-test-cannot-see-the-wire-code`).
 *
 * All three legs need no object store, no mail and no second user: the chunk
 * dial refuses inside updateMemory before any write, the recovery content read
 * refuses before any decryption (the memory row is flipped encrypted with no
 * session key cached in this process — the same fixture trick
 * chatRootEngineState3501 uses), and createChannel refuses on loc validation
 * after the memory gate but before any row is touched.
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
let memoryId: string;
let deletedNodeId: string;

/** Post a GraphQL operation and return the first error's shape. */
async function graphqlError(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  // The transport before the payload (#924): a non-GraphQL failure would
  // otherwise surface as a confusing "errors is undefined".
  expect(res.status, 'GraphQL errors ride a 200').toBe(200);
  const body = (await res.json()) as {
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
  expect(body.errors, 'expected the operation to fail').toBeDefined();
  return body.errors![0];
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'te-org', urn: `te-org-${generateId()}` },
  });
  const user = await db.user.create({
    data: { id: generateId(), handle: 'te-owner', githubUsername: 'te-owner', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: user.id, role: 'ADMIN' },
  });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `te-mem-${generateId()}`,
      name: 'te-mem', class: 'knowledge', createdBy: user.id,
    },
  });
  memoryId = memory.id;

  // The recovery leg's fixture: a node, soft-deleted, whose memory is then
  // flipped encrypted at the row level — no session key is ever cached in this
  // process, so the content read hits decryptNodeFields keyless.
  const node = await db.node.create({
    data: {
      id: generateId(), memoryId: memory.id, loc: 'notes:gone', name: 'gone',
      nodeType: 'note', createdBy: user.id, deletedAt: new Date(),
    },
  });
  deletedNodeId = node.id;
  await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });

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

describe('#3136 — swept refusals are typed on the wire', () => {
  it('updateMemory chunk dials refuse INVALID_CHUNK_CONFIG, not INTERNAL_SERVER_ERROR', async () => {
    // chunkTokens stays null → the platform default 512 resolves it, and an
    // overlap of 600 violates 0 <= overlap < tokens — the exact partial-update
    // arm the resolver's own comment describes.
    const err = await graphqlError(
      `mutation($id: ID!) { updateMemory(id: $id, chunkOverlap: 600) { id } }`,
      { id: memoryId },
    );
    expect(err.extensions?.code).toBe('INVALID_CHUNK_CONFIG');
    expect(err.extensions?.reason).toMatch(/chunkOverlap/);
  });

  it('a keyless encrypted-memory read refuses SESSION_EXPIRED with the memoryId', async () => {
    // recoveryNode's content field decrypts raw (no hand-wrapper) — before the
    // sweep this exact leg surfaced INTERNAL_SERVER_ERROR.
    const err = await graphqlError(
      `query($ref: ID!) { recoveryNode(nodeRef: $ref) { content } }`,
      { ref: deletedNodeId },
    );
    expect(err.extensions?.code).toBe('SESSION_EXPIRED');
    expect(err.extensions?.memoryId).toBe(memoryId);
  });

  it('createChannel with an invalid loc refuses with the InvalidLocError code its nine siblings deliver', async () => {
    const err = await graphqlError(
      `mutation($input: CreateChannelInput!) { createChannel(input: $input) { id } }`,
      { input: { memoryRef: memoryId, loc: 'bad!loc', name: 'x' } },
    );
    expect(err.extensions?.code).toBe('InvalidLocError');
    expect(err.extensions?.loc).toBe('bad!loc');
  });
});
