/**
 * #4461 — a bad loc on a write is refused ONE way at every GraphQL site:
 * `BAD_USER_INPUT`, naming the field and the reason, never echoing the value,
 * with no `loc`/`segment` extensions.
 *
 * Before the shared helper the ten sites answered two shapes: eight threw
 * `extensions.code = 'InvalidLocError'` with `loc` + `segment` (the caller's
 * whole input back, twice), two (`setAppMemoryWriteGrant`,
 * `setAutomationReadGrant`) threw `BAD_USER_INPUT` with the underlying message
 * (echo included) in the text.
 *
 * A WIRE test in the #918 style (real express app, real GraphQL), because the
 * code that matters is the one the Apollo pipeline puts on the response.
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
let memoryUrn: string;
let srcNodeId: string;
let tgtNodeId: string;
let edgeId: string;

// A marker no legitimate message would contain: if it shows up in the answer,
// the value was echoed.
const MARK = 'ZQ9X';
const BAD = `${MARK}!bad`; // invalid charset
const LONG_ATOM = `${MARK}${'a'.repeat(70)}`; // an atom over 64
const LONG_TOTAL = Array.from({ length: 200 }, (_, i) => `${MARK}a${i}`).join(':'); // every atom valid, total far over any cap

async function graphqlError(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  expect(res.status, 'GraphQL errors ride a 200').toBe(200);
  const body = (await res.json()) as {
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
  expect(body.errors, 'expected the operation to fail').toBeDefined();
  return body.errors![0];
}

/** The one answer: code, field named, reason set, nothing echoed. */
function expectOneAnswer(
  err: { message: string; extensions?: Record<string, unknown> },
  field: string,
  reason: 'empty' | 'invalid-charset' | 'too-long',
) {
  expect(err.extensions?.code).toBe('BAD_USER_INPUT');
  expect(err.extensions?.field).toBe(field);
  expect(err.extensions?.reason).toBe(reason);
  expect(err.extensions).not.toHaveProperty('loc');
  expect(err.extensions).not.toHaveProperty('segment');
  expect(JSON.stringify(err)).not.toContain(MARK);
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'bl-org', urn: `bl-org-${generateId()}` },
  });
  const user = await db.user.create({
    data: { id: generateId(), handle: 'bl-owner', githubUsername: 'bl-owner', roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:bl-mem`,
      name: 'bl-mem', class: 'knowledge', createdBy: user.id,
    },
  });
  memoryId = memory.id;
  memoryUrn = `hrn:node:${memory.urn}`;
  const mk = async (loc: string) => (await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, nodeType: 'info', createdBy: user.id },
  })).id;
  srcNodeId = await mk('notes:src');
  tgtNodeId = await mk('notes:tgt');
  edgeId = (await db.edge.create({
    data: {
      id: generateId(), memoryId: memory.id, sourceId: srcNodeId, targetId: tgtNodeId, name: 'rel',
      loc: 'notes:src:rel:notes:tgt', createdBy: user.id,
    },
  })).id;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('#4461 — createNode (resolvers.mutation.node.ts core write)', () => {
  it('invalid charset: BAD_USER_INPUT, field loc, reason, no echo', async () => {
    const err = await graphqlError(
      `mutation($i: CreateNodeInput!) { createNode(input: $i) { id } }`,
      { i: { memoryId, loc: BAD, name: 'x' } },
    );
    expectOneAnswer(err, 'loc', 'invalid-charset');
  });
  it('an atom over 64 characters: reason too-long', async () => {
    const err = await graphqlError(
      `mutation($i: CreateNodeInput!) { createNode(input: $i) { id } }`,
      { i: { memoryId, loc: LONG_ATOM, name: 'x' } },
    );
    expectOneAnswer(err, 'loc', 'too-long');
  });
  it('a loc whose atoms are each valid but whose total is over the cap: too-long', async () => {
    const err = await graphqlError(
      `mutation($i: CreateNodeInput!) { createNode(input: $i) { id } }`,
      { i: { memoryId, loc: LONG_TOTAL, name: 'x' } },
    );
    expectOneAnswer(err, 'loc', 'too-long');
  });
});

describe('#4461 — every other site answers the same', () => {
  it('createChannel', async () => {
    const err = await graphqlError(
      `mutation($input: CreateChannelInput!) { createChannel(input: $input) { id } }`,
      { input: { memoryRef: memoryId, loc: BAD, name: 'x' } },
    );
    expectOneAnswer(err, 'loc', 'invalid-charset');
  });
  it('createEdge (edge loc)', async () => {
    const err = await graphqlError(
      `mutation($s: ID!, $t: ID!, $l: String) { createEdge(sourceRef: $s, targetRef: $t, loc: $l) { id } }`,
      { s: srcNodeId, t: tgtNodeId, l: BAD },
    );
    expectOneAnswer(err, 'loc', 'invalid-charset');
  });
  it('updateEdge (edge loc)', async () => {
    const err = await graphqlError(
      `mutation($e: ID!, $l: String) { updateEdge(edgeRef: $e, loc: $l) { id } }`,
      { e: edgeId, l: BAD },
    );
    expectOneAnswer(err, 'loc', 'invalid-charset');
  });
  it('moveNode (destination loc)', async () => {
    const err = await graphqlError(
      `mutation($s: ID!, $t: String) { moveNode(sourceRef: $s, targetUrn: $t) { id } }`,
      { s: srcNodeId, t: `${memoryUrn}:${BAD}` },
    );
    expectOneAnswer(err, 'destLoc', 'invalid-charset');
  });
  it('createQuestionLog', async () => {
    const err = await graphqlError(
      `mutation($m: ID!, $l: String!) { createQuestionLog(memoryRef: $m, loc: $l, defaultDeciders: []) { id } }`,
      { m: memoryId, l: BAD },
    );
    expectOneAnswer(err, 'loc', 'invalid-charset');
  });
  it('setAppMemoryWriteGrant (prefix): was BAD_USER_INPUT with the echo in the text', async () => {
    const err = await graphqlError(
      `mutation($a: String!, $m: String!, $p: String!) { setAppMemoryWriteGrant(appRef: $a, memoryRef: $m, prefix: $p) { id } }`,
      { a: 'nope', m: memoryId, p: BAD },
    );
    expectOneAnswer(err, 'prefix', 'invalid-charset');
  });
  it('setAutomationReadGrant (prefix): was BAD_USER_INPUT with the echo in the text', async () => {
    const err = await graphqlError(
      `mutation($a: String!, $k: String!, $i: ID!, $m: String!, $p: String) { setAutomationReadGrant(appRef: $a, triggerKind: $k, triggerId: $i, memoryRef: $m, prefix: $p) { id } }`,
      { a: 'nope', k: 'SCHEDULE', i: generateId(), m: memoryId, p: BAD },
    );
    expectOneAnswer(err, 'prefix', 'invalid-charset');
  });
});
