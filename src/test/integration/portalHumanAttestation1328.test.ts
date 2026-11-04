/**
 * #1328 — the trusted portal human over the real HTTP path. The exemption
 * follows the surface (D-2026-09-24-004), and the server derives it from the
 * credential: a sign-in JWT on /graphql, and nothing else. The Apollo context is
 * the one place that sets it, so a hand-built Context cannot stand in for this.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';
import { mintUserApiKey } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let server: Server;
let baseUrl: string;
let userId: string;
let memoryId: string;
let jwt: string;

const CREATE = 'mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }';
const send = async (token: string, input: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ query: CREATE, variables: { input } }),
  });
  return await res.json() as { data?: unknown; errors?: Array<{ message: string; extensions?: { code?: string } }> };
};
const input = (loc: string, extra: Record<string, unknown> = {}) => ({ memoryId, loc, name: loc, content: 'x', role: 'guide', ...extra });

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-http', urn: 'attest-http' } });
  userId = (await db.user.create({ data: { githubId: 13282, githubUsername: 'attest-http', handle: 'attest-http', email: 'attest-http@example.test' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'attest-http:mem', name: 'mem', class: 'knowledge' } })).id;
  const task = await db.node.create({ data: { id: generateId(), memoryId, loc: 'task', name: 'Task', isRunnable: true } });
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: task.id, authorTaskRequired: true } });
  jwt = await signJwt({ sub: userId, roles: ['CONTRIBUTOR'], email: 'attest-http@example.test' });
});

describe('#1328 the portal path over HTTP', () => {
  it('a sign-in JWT writes without a claim and records no task', async () => {
    const res = await send(jwt, input('a'));
    expect(res.errors).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'a', memoryId } } }))
      .toMatchObject({ role: 'guide', authorshipKind: null, authoredByTask: null });
  });

  it('a user API key, the CLI credential, attests', async () => {
    const { rawKey } = await mintUserApiKey(db, { userId, label: 'cli', createdBy: userId, issuedVia: null });
    const res = await send(rawKey, input('a'));
    expect(res.errors?.[0]?.extensions?.code).toBe('AUTHORING_ATTESTATION_MISSING');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });

  it('a JWT naming a worker session, even an invalid one, attests', async () => {
    const res = await send(jwt, input('a'), { 'x-hadron-session': generateId() });
    expect(res.errors?.[0]?.extensions?.code).toBe('AUTHORING_ATTESTATION_MISSING');
  });

  it('a client-supplied human field is refused by the schema', async () => {
    const res = await send(jwt, input('a', { human: true }));
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });
});
