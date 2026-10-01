import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pushMemoryToGit } from '../../integrations/github/pushMemoryToGit.js';
import { memoryLocalPath, withMirrorCheckout } from '../../integrations/github/gitMirrorCheckout.js';

const { token } = vi.hoisted(() => ({ token: 'ghs_SYNTHETIC_INSTALLATION_TOKEN_1578' }));

vi.mock('../../integrations/github/githubApp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../integrations/github/githubApp.js')>();
  return { ...real, getInstallationToken: vi.fn(async () => token) };
});

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const argv = args[1] as string[];
    const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
    const message = `Command failed: git ${argv.join(' ')}\nfatal: could not read from remote`;
    cb(Object.assign(new Error(message), { cmd: message, stderr: message }), '', message);
  }),
}));

let server: Server;
let baseUrl: string;
let jwt: string;
let memoryId: string;
let checkoutPath: string;

async function graphql(query: string) {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables: { id: memoryId } }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ data?: Record<string, any> | null; errors?: Array<{ message: string }> }>;
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'git-error-org', urn: `git-error-org-${generateId()}`, githubInstallationId: 1578 },
  });
  const user = await db.user.create({
    data: { id: generateId(), handle: `git-error-owner-${generateId()}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `git-error-memory-${generateId()}`,
      name: 'git-error-memory', class: 'knowledge', createdBy: user.id,
      source: 'https://github.com/hadron-memory/nonexistent-1578.git',
    },
  });
  memoryId = memory.id;
  checkoutPath = memoryLocalPath(org.urn, memory.urn);

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(checkoutPath, { recursive: true, force: true });
});

describe('#1578 git failure credential containment', () => {
  it('keeps the synthetic token out of syncError, GraphQL, and logs', async () => {
    const logged: unknown[][] = [];
    const log = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args); });
    try {
      const failed = await graphql('mutation($id: ID!) { syncMemory(id: $id) { id } }');
      const row = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      const read = await graphql('query($id: ID!) { memory(ref: $id) { syncError } }');

      expect(row.syncStatus).toBe('ERROR');
      expect(row.syncError).toBe('Git command failed. Check the repository and branch, then retry.');
      expect(failed.errors?.[0]?.message).toBe(row.syncError);
      expect(read.data?.memory?.syncError).toBe(row.syncError);

      // The full push returns an error to GraphQL; the incremental mirror logs
      // and soft-fails. Both feed a tokenized remote through the same wrapper.
      const push = await pushMemoryToGit(memoryId);
      expect(push.error).toContain('Git command failed.');
      mkdirSync(join(checkoutPath, '.git'), { recursive: true });
      const mirror = await withMirrorCheckout(
        { memoryId, commitSubject: 'test', logPrefix: '[test]' },
        () => { throw new Error('unreachable mutation'); },
      );
      expect(mirror).toBe('failed');
      expect(JSON.stringify({ row: row.syncError, failed, read, push, mirror, logged })).not.toContain(token);
    } finally {
      log.mockRestore();
    }
  });
});
