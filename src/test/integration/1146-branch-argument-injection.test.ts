/**
 * #1146 — a branch name git would read as an OPTION is refused at the wire.
 *
 * `readBranch` / `writeBranch` are caller-settable (org-ADMIN) and reach `git`
 * as POSITIONAL arguments, so a value beginning with `-` is parsed as an
 * option rather than a ref. Not shell injection — `execGit` uses no shell —
 * which is why it survived #561's transport pass.
 *
 * A WIRE test rather than a resolver test, for the #918 reason this repo
 * already learned: a resolver-level test sees a perfectly good typed error
 * while the network sees `INTERNAL_SERVER_ERROR`, and a refusal a client
 * cannot branch on gets pattern-matched against English prose.
 *
 * The unit rules live in `lib/gitRef.test.ts`. What this file adds is that the
 * guard is actually MOUNTED on both mutations — a validator nothing calls is
 * the failure mode a unit test cannot see.
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
let orgId: string;
let memoryId: string;

async function graphql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  expect(res.status, 'GraphQL errors ride a 200').toBe(200);
  return (await res.json()) as {
    data?: Record<string, unknown> | null;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
}

const CREATE = `
  mutation Create($orgId: ID!, $name: String!, $readBranch: String, $writeBranch: String) {
    createMemory(orgId: $orgId, name: $name, readBranch: $readBranch, writeBranch: $writeBranch) {
      id readBranch writeBranch
    }
  }
`;

const UPDATE = `
  mutation Update($id: ID!, $readBranch: String, $writeBranch: String) {
    updateMemory(id: $id, readBranch: $readBranch, writeBranch: $writeBranch) {
      id readBranch writeBranch
    }
  }
`;

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'br-org', urn: `br-org-${generateId()}` },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { id: generateId(), handle: 'br-owner', githubUsername: 'br-owner', roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `br-mem-${generateId()}`,
      name: 'br-mem', class: 'knowledge', createdBy: user.id,
      source: 'https://github.com/hadron-memory/hadronmem-core',
    },
  });
  memoryId = memory.id;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The shapes that turn a branch name into control over the git invocation. */
const INJECTIONS: [string, string][] = [
  ['a long option', '--orphan'],
  ['a short option', '-b'],
  ['an option with a value', '--orphan=evil'],
  ['a bare dash', '-'],
];

describe('#1146 — createMemory refuses an option-shaped branch', () => {
  it.each(INJECTIONS)('readBranch: %s', async (_label, value) => {
    const res = await graphql(CREATE, { orgId, name: `m-${generateId()}`, readBranch: value });
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_GIT_BRANCH');
    expect(res.data?.createMemory).toBeFalsy();
  });

  it.each(INJECTIONS)('writeBranch: %s', async (_label, value) => {
    const res = await graphql(CREATE, { orgId, name: `m-${generateId()}`, writeBranch: value });
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_GIT_BRANCH');
  });
});

describe('#1146 — updateMemory refuses too', () => {
  // The second write path. A guard on create alone leaves the column settable
  // by anyone who creates a memory first and edits it after — which is the
  // ordinary way anybody would reach it.
  it.each(INJECTIONS)('%s', async (_label, value) => {
    const res = await graphql(UPDATE, { id: memoryId, writeBranch: value });
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_GIT_BRANCH');
  });

  it('leaves the stored value untouched after a refusal', async () => {
    // A refusal that still wrote would be worse than no guard, because the
    // error says it did not.
    const before = await db.memory.findUnique({ where: { id: memoryId } });
    await graphql(UPDATE, { id: memoryId, writeBranch: '--orphan' });
    const after = await db.memory.findUnique({ where: { id: memoryId } });
    expect(after?.writeBranch).toBe(before?.writeBranch ?? null);
  });
});

describe('#1146 — ordinary branch names still work', () => {
  // The control, and it is the assertion that keeps every refusal above
  // meaningful: a mutation that rejected ALL branch names would satisfy the
  // whole file otherwise. It also pins that underscores and slashes survive,
  // which is the way a too-strict blocklist would break real callers without
  // any test complaining.
  it.each([['plain', 'main'], ['underscore', 'my_branch'], ['path-like', 'release/1.2']])(
    '%s',
    async (_label, value) => {
      const res = await graphql(UPDATE, { id: memoryId, writeBranch: value });
      expect(res.errors, `"${value}" must be accepted`).toBeUndefined();
      expect((res.data?.updateMemory as { writeBranch?: string })?.writeBranch).toBe(value);
    },
  );
});
