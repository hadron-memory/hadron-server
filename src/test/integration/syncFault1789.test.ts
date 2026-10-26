/** #1789 (LOCAL delta P2): a sync fault is a fault on GraphQL even when its message is empty; typed refusals keep text. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

vi.mock('../../integrations/github/syncGraphFromGithub.js', async (orig) => ({
  ...(await orig<typeof import('../../integrations/github/syncGraphFromGithub.js')>()),
  syncGraphFromGithub: vi.fn(),
}));
import { syncGraphFromGithub } from '../../integrations/github/syncGraphFromGithub.js';

let server: Server;
let baseUrl: string;
let jwt: string;
let memoryId: string;

async function syncMemory() {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query: 'mutation($id: ID!) { syncMemory(id: $id) { id } }', variables: { id: memoryId } }),
  });
  return response.json() as Promise<{ data?: unknown; errors?: Array<{ message: string; extensions: { code: string; requestId?: string } }> }>;
}

beforeAll(async () => {
  await cleanDb(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const org = await db.organization.create({ data: { id: generateId(), name: 'sync-org', urn: `sync-org-${generateId()}` } });
  const user = await db.user.create({ data: { id: generateId(), handle: `sync-owner-${generateId()}`, roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `sync-memory-${generateId()}`, name: 'sync-memory', class: 'knowledge', createdBy: user.id, source: 'https://github.com/example/repo.git' },
  });
  memoryId = memory.id;
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

describe('syncMemory failure classification (#1789)', () => {
  it.each([['/srv/private/driver canary'], ['']])('fault with message %j is the generic envelope', async (error) => {
    vi.mocked(syncGraphFromGithub).mockResolvedValue({ error, fault: true });
    const body = await syncMemory();
    expect(body.errors?.[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.errors?.[0].extensions.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it('a typed refusal keeps its code and text', async () => {
    vi.mocked(syncGraphFromGithub).mockResolvedValue({ error: 'Bad node name', errorCode: 'BAD_USER_INPUT' });
    const body = await syncMemory();
    expect(body.errors?.[0].message).toBe('Bad node name');
    expect(body.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
  });
});
