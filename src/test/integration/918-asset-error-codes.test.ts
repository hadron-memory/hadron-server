/**
 * #918 — asset refusals carry `extensions.code` on the wire.
 *
 * `AssetUploadError` has always had a typed `code` — and none of it reached the
 * client, because the class extends `Error` rather than `GraphQLError` and
 * `formatError` mapped only the URN errors. Apollo therefore sent the message
 * with the default `INTERNAL_SERVER_ERROR`, so a client could only pattern-match
 * English prose that is free to change under it (issue #918, reproduced against
 * prd with the EICAR file on 2026-08-08).
 *
 * That is a WIRE contract, so this test is a wire test: it boots the real
 * express app and posts real GraphQL, because the defect lived entirely in the
 * Apollo pipeline — every resolver-level test in the suite calls the resolver
 * directly and sees a perfectly good `err.code` while the network sees none.
 *
 * The scan gate in `mintAssetDownloadUrl` runs BEFORE any object-store call, so
 * SCAN_PENDING / SCAN_BLOCKED are reachable with no storage configured — which
 * is what makes the codes from the issue testable here rather than only through
 * a real upload.
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

/** Post a GraphQL operation and return the first error's shape. */
async function graphqlError(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  // Assert the transport before the payload (@copilot, PR #924): a non-GraphQL
  // failure (500 + a different body shape) would otherwise surface as a
  // confusing "errors is undefined" rather than as what actually went wrong.
  expect(res.status, 'GraphQL errors ride a 200').toBe(200);
  const body = (await res.json()) as {
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
  expect(body.errors, 'expected the operation to fail').toBeDefined();
  return body.errors![0];
}

const DOWNLOAD = `
  query Download($assetId: ID!) {
    assetDownloadUrl(assetId: $assetId) { url }
  }
`;

async function makeAsset(scanStatus: 'PENDING' | 'BLOCKED' | 'CLEAN') {
  return db.asset.create({
    data: {
      id: generateId(),
      memoryId,
      filename: `${scanStatus.toLowerCase()}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 68,
      storageKey: `org/mem/${generateId()}.txt`,
      scanStatus,
    },
  });
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'ae-org', urn: `ae-org-${generateId()}` },
  });
  const user = await db.user.create({
    data: { id: generateId(), handle: 'ae-owner', githubUsername: 'ae-owner', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: user.id, role: 'ADMIN' },
  });
  jwt = await signJwt({ sub: user.id, roles: ['ADMIN'] });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `ae-mem-${generateId()}`,
      name: 'ae-mem', class: 'knowledge', createdBy: user.id,
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

describe('#918 — AssetUploadError codes reach the client', () => {
  it('an unscanned asset refuses with SCAN_PENDING, not INTERNAL_SERVER_ERROR', async () => {
    const asset = await makeAsset('PENDING');
    const err = await graphqlError(DOWNLOAD, { assetId: asset.id });
    expect(err.extensions?.code).toBe('SCAN_PENDING');
    // The message is still populated — the code is additive, so a client
    // reading prose today keeps working. Asserting only that it is NON-EMPTY,
    // not what it says (@copilot, PR #924): this PR's whole argument is that
    // the prose is free to change and the code is the contract, so pinning the
    // wording here would contradict the change and break the suite on a copy
    // edit that altered nothing a caller depends on.
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('a blocked asset refuses with SCAN_BLOCKED', async () => {
    const asset = await makeAsset('BLOCKED');
    const err = await graphqlError(DOWNLOAD, { assetId: asset.id });
    expect(err.extensions?.code).toBe('SCAN_BLOCKED');
  });

  it('an unknown asset refuses with NOT_FOUND', async () => {
    // Called out in the issue: this one is a visible change for anyone
    // branching on the CLI's generic exit 1 today, and it is the correct code.
    const err = await graphqlError(DOWNLOAD, { assetId: generateId() });
    expect(err.extensions?.code).toBe('NOT_FOUND');
  });

  it('never leaves an asset refusal as the default INTERNAL_SERVER_ERROR', async () => {
    // The regression in one line: this is exactly what the CLI saw on prd.
    for (const status of ['PENDING', 'BLOCKED'] as const) {
      const asset = await makeAsset(status);
      const err = await graphqlError(DOWNLOAD, { assetId: asset.id });
      expect(err.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
      expect(err.extensions?.code).toEqual(expect.any(String));
    }
  });
});
