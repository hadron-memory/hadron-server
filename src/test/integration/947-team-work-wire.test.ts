import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
/**
 * #947 — worklog operations through the REAL wire (createServer() + a GraphQL
 * POST), because resolver-level tests cannot see two whole failure classes:
 * SDL/resolver argument drift (findings:sdl-resolver-arg-drift-invisible-to-
 * tests) and a typed error whose code never reaches the network
 * (conventions:typed-error-must-be-registered-in-formaterror). The happy path
 * proves the SDL args are wired for BOTH the mutation and the query; the
 * error cases pin extensions.code as the CLIENT sees it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { serveAgentBootPrompt } from '../servedBootPrompt.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

const RECORD = `
  mutation Record($appRef: ID!, $sessionRef: ID!, $tool: String!, $kind: String!, $ref: String!, $action: String!, $detail: JSON, $model: String) {
    recordTeamWork(appRef: $appRef, sessionRef: $sessionRef, tool: $tool, kind: $kind, ref: $ref, action: $action, detail: $detail, model: $model) {
      nodeId
      sessionId
      workerName
      workerId
      tool
      kind
      ref
      action
      at
      detail
      model
    }
  }
`;

const ITEMS = `
  query Items($appRef: ID!, $ref: String, $sessionRef: ID, $tool: String, $kind: String, $limit: Int, $offset: Int) {
    teamWorkItems(appRef: $appRef, ref: $ref, sessionRef: $sessionRef, tool: $tool, kind: $kind, limit: $limit, offset: $offset) {
      total
      items { nodeId sessionId workerName workerId ref kind action model }
    }
  }
`;

let server: Server;
let baseUrl: string;
let jwt: string;
let app: { id: string };
let session: { id: string };
let worker: { id: string };
let adminId: string;

async function gql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    data?: Record<string, any> | null;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  }>;
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'wire-org-947', urn: 'wire-org-947.com' },
  });
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 94710, githubUsername: 'wire-admin-947', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;
  jwt = await signJwt({ sub: admin.id, roles: ['READER'] });

  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  const teamAgent = await M.createAgent({}, { orgId: org.id, name: 'Wire Team Agent 947' }, ctx);
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Iris'] },
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Wire Team App 947', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await serveAgentBootPrompt(db, teamAgent.id, 'Test boot prompt.'); // #2712: the bind needs a served prompt
  // #974: bind the session to a Worker casting so the wire test exercises the
  // workerName + workerId selection fields for a worker-bound record.
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
  });
  session = await M.startSession(
    {},
    { input: { id: generateId(), appRef: app.id, workerRef: worker.id, transcriptPath: '/tmp/wire-947.jsonl' } },
    ctx,
  );

  const express = await createServer();
  server = createHttpServer(express);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('team worklog on the wire (#947)', () => {
  it('records through the advertised SDL arguments and reads the page back by a URL spelling', async () => {
    const recorded = await gql(RECORD, {
      appRef: app.id,
      sessionRef: session.id,
      tool: 'github',
      kind: 'pr',
      ref: 'https://github.com/Acme/Widgets/pull/371',
      action: 'opened',
      detail: { title: 'Add widgets' },
    });
    expect(recorded.errors).toBeUndefined();
    expect(recorded.data?.recordTeamWork?.ref).toBe('acme/widgets#371');
    expect(recorded.data?.recordTeamWork?.sessionId).toBe(session.id);
    expect(recorded.data?.recordTeamWork?.workerName).toBe('Iris');
    expect(recorded.data?.recordTeamWork?.workerId).toBe(worker.id);
    expect(recorded.data?.recordTeamWork?.detail).toEqual({ title: 'Add widgets' });

    const page = await gql(ITEMS, { appRef: app.id, ref: 'Acme/Widgets#371' });
    expect(page.errors).toBeUndefined();
    expect(page.data?.teamWorkItems?.total).toBe(1);
    expect(page.data?.teamWorkItems?.items[0].sessionId).toBe(session.id);
    expect(page.data?.teamWorkItems?.items[0].workerName).toBe('Iris');
    expect(page.data?.teamWorkItems?.items[0].workerId).toBe(worker.id);
  });

  it('an unparseable github ref carries WORK_REF_INVALID as extensions.code', async () => {
    const body = await gql(RECORD, {
      appRef: app.id,
      sessionRef: session.id,
      tool: 'github',
      kind: 'pr',
      ref: '371',
      action: 'opened',
    });
    expect(body.errors?.[0]?.extensions?.code).toBe('WORK_REF_INVALID');
  });

  it("a session of another App carries SESSION_NOT_IN_APP as extensions.code", async () => {
    const stray = await db.session.create({
      data: { id: generateId(), userId: adminId, appId: null },
    });
    // The stray session belongs to no App, and is attributed to our admin.
    const body = await gql(RECORD, {
      appRef: app.id,
      sessionRef: stray.id,
      tool: 'github',
      kind: 'pr',
      ref: 'o/r#1',
      action: 'opened',
    });
    expect(body.errors?.[0]?.extensions?.code).toBe('SESSION_NOT_IN_APP');
  });

  it('model round-trips over the POST wire: explicit on record, snapshot on read (#1401)', async () => {
    const recorded = await gql(RECORD, {
      appRef: app.id,
      sessionRef: session.id,
      tool: 'github',
      kind: 'pr',
      ref: 'o/r#4',
      action: 'opened',
      detail: null,
      model: 'glm-5.3',
    });
    expect(recorded.errors).toBeUndefined();
    expect(recorded.data?.recordTeamWork?.model).toBe('glm-5.3');

    const listed = await gql(ITEMS, { appRef: app.id, ref: 'o/r#4' });
    expect(listed.errors).toBeUndefined();
    expect(listed.data?.teamWorkItems?.items?.[0]?.model).toBe('glm-5.3');
  });

  it('omitting model over the wire stores nothing, and an empty string is refused (#1401)', async () => {
    const recorded = await gql(RECORD, {
      appRef: app.id,
      sessionRef: session.id,
      tool: 'github',
      kind: 'pr',
      ref: 'o/r#5',
      action: 'opened',
      detail: null,
    });
    expect(recorded.errors).toBeUndefined();
    expect(recorded.data?.recordTeamWork?.model).toBeNull();

    const refused = await gql(RECORD, {
      appRef: app.id,
      sessionRef: session.id,
      tool: 'github',
      kind: 'pr',
      ref: 'o/r#6',
      action: 'opened',
      detail: null,
      model: '',
    });
    expect(refused.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('an unknown session carries SESSION_NOT_FOUND as extensions.code', async () => {
    const body = await gql(RECORD, {
      appRef: app.id,
      sessionRef: 'nope',
      tool: 'github',
      kind: 'pr',
      ref: 'o/r#1',
      action: 'opened',
    });
    expect(body.errors?.[0]?.extensions?.code).toBe('SESSION_NOT_FOUND');
  });
});
