/**
 * #561 — `Memory.source` is allowlisted at the boundary, and the refusal is
 * typed on the wire.
 *
 * The defect: `source` names the git remote a memory syncs from, it is settable
 * through `createMemory` / `updateMemory`, and git reads a remote URL as a
 * TRANSPORT SELECTOR rather than an address. Nothing constrained it.
 *
 * Measured against the git that serves this code (2.50.1 local, 2.54.0 prd) —
 * the issue's `ext::` payload is refused by git's own default, and two other
 * things were reachable: a clone of any LOCAL repository the server can read,
 * whose files are ingested as nodes, and an outbound request to any https host.
 * The `ext::` cases below are still pinned, because git's default is a property
 * of the binary rather than of anything this repo controls. Full reasoning in
 * execGit.ts.
 *
 * This is a WIRE test rather than a resolver test, for the reason #918 taught
 * this repo six weeks ago: every resolver-level test in the suite calls the
 * resolver directly, so it sees a perfectly good typed error while the network
 * sees `INTERNAL_SERVER_ERROR`. A refusal a client cannot branch on is a
 * refusal that gets pattern-matched against English prose.
 *
 * The transport guard on the git invocations themselves — the second layer,
 * which holds for a value that reached the column some other way — is asserted
 * where git is actually invoked, in `syncGraphFromGithub.test.ts`.
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

/** Post a GraphQL operation; return `{ data, errors }` without asserting either. */
async function graphql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  // Assert the transport before the payload: a non-GraphQL failure would
  // otherwise surface as a confusing "errors is undefined".
  expect(res.status, 'GraphQL errors ride a 200').toBe(200);
  return (await res.json()) as {
    data?: Record<string, unknown> | null;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
}

const UPDATE = `
  mutation Update($id: ID!, $source: String) {
    updateMemory(id: $id, source: $source) { id source }
  }
`;

const CREATE = `
  mutation Create($orgId: ID!, $name: String!, $source: String) {
    createMemory(orgId: $orgId, name: $name, source: $source) { id source }
  }
`;

/**
 * The payload from the issue, plus the shapes the measurement found reachable.
 * They are why the fix is an allowlist and not a `startsWith('ext::')` check:
 * three of the four would sail past that.
 */
const PAYLOADS: [string, string][] = [
  ['ext:: transport', "ext::sh -c 'touch /tmp/hadron-561-pwned'"],
  ['option injection', '--upload-pack=sh -c id'],
  ['non-github host (the SSRF half)', 'https://github.com.evil.example/o/r'],
  ['local path', '/tmp/evil-repo'],
];

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'gs-org', urn: `gs-org-${generateId()}` },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { id: generateId(), handle: 'gs-owner', githubUsername: 'gs-owner', roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `gs-mem-${generateId()}`,
      name: 'gs-mem', class: 'knowledge', createdBy: user.id,
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
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('#561 — updateMemory refuses a transport-selecting source', () => {
  it.each(PAYLOADS)('refuses %s with INVALID_MEMORY_SOURCE', async (_label, source) => {
    const body = await graphql(UPDATE, { id: memoryId, source });
    expect(body.errors, 'expected the mutation to fail').toBeDefined();
    expect(body.errors![0].extensions?.code).toBe('INVALID_MEMORY_SOURCE');
    // The message is populated but not pinned: the code is the contract, and
    // pinning the wording would break on a copy edit that changed nothing a
    // caller depends on (the #924 convention).
    expect(body.errors![0].message.length).toBeGreaterThan(0);
  });

  it('leaves the stored source untouched when it refuses', async () => {
    // The refusal has to happen BEFORE the write, not after it. A validator
    // that rejects on the way out would still have persisted the payload — and
    // the clone reads the column, not the mutation.
    await graphql(UPDATE, { id: memoryId, source: 'ext::whoami' });
    const row = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect(row.source).toBe('https://github.com/hadron-memory/hadronmem-core');
  });

  it('still accepts the shapes every stored row uses', async () => {
    for (const source of [
      'https://github.com/hadron-memory/hadronmem-core',
      'https://github.com/hadron-memory/hadronmem-mcp.git',
      'git@github.com:owner/repo.git',
    ]) {
      const body = await graphql(UPDATE, { id: memoryId, source });
      expect(body.errors, `expected ${source} to be accepted`).toBeUndefined();
      expect((body.data!.updateMemory as { source: string }).source).toBe(source);
    }
  });

  it('accepts null — a memory with no repository is DB-only, not a refusal', async () => {
    const body = await graphql(UPDATE, { id: memoryId, source: null });
    expect(body.errors).toBeUndefined();
    expect((body.data!.updateMemory as { source: string | null }).source).toBeNull();
  });
});

describe('#561 — createMemory refuses it too', () => {
  it.each(PAYLOADS)('refuses %s at create time', async (_label, source) => {
    const name = `gs-create-${generateId()}`;
    const body = await graphql(CREATE, { orgId, name, source });
    expect(body.errors, 'expected the mutation to fail').toBeDefined();
    expect(body.errors![0].extensions?.code).toBe('INVALID_MEMORY_SOURCE');
    // And no memory was created — the refusal precedes every side effect,
    // including the root node createMemory writes.
    const created = await db.memory.findFirst({ where: { name } });
    expect(created).toBeNull();
  });

  it('never leaves the refusal as the default INTERNAL_SERVER_ERROR', async () => {
    // The regression in one line: an untyped refusal is one a client can only
    // pattern-match on prose, which is what #918 was about.
    const body = await graphql(CREATE, { orgId, name: `gs-x-${generateId()}`, source: 'ext::id' });
    expect(body.errors![0].extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
  });
});
