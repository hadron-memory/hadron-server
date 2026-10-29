/**
 * #974 — the Worker surface through the REAL wire (createServer() + GraphQL
 * POSTs), because resolver-level tests cannot see two whole failure classes:
 * SDL/resolver argument drift (findings:sdl-resolver-arg-drift-invisible-to-
 * tests) and a typed error whose code never reaches the network
 * (conventions:typed-error-must-be-registered-in-formaterror). The full-args
 * castWorker proves every advertised SDL argument is wired; retireWorker /
 * worker / workers prove theirs; the error cases pin extensions.code as the
 * CLIENT sees it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { serveAgentBootPrompt } from '../servedBootPrompt.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

/** Every advertised castWorker argument, plus the resolved-field surface. */
const CAST = `
  mutation Cast($appRef: ID!, $agentRef: ID, $role: String, $name: String) {
    castWorker(appRef: $appRef, agentRef: $agentRef, role: $role, name: $name) {
      id
      appId
      agentId
      name
      role
      memoryId
      prompt
      retiredAt
      agent { id }
      app { id }
    }
  }
`;

const RETIRE = `
  mutation Retire($workerRef: ID!) {
    retireWorker(workerRef: $workerRef) {
      id
      name
      retiredAt
    }
  }
`;

const WORKER = `
  query One($ref: ID!) {
    worker(ref: $ref) {
      id
      name
      role
      prompt
    }
  }
`;

const WORKERS = `
  query Page($appRef: ID!, $includeRetired: Boolean, $limit: Int, $offset: Int) {
    workers(appRef: $appRef, includeRetired: $includeRetired, limit: $limit, offset: $offset) {
      total
      items { id name retiredAt }
    }
  }
`;

let server: Server;
let baseUrl: string;
let jwt: string;
let app: { id: string };
let teamAgent: { id: string };
let roleAgent: { id: string };

type GqlBody = {
  data?: Record<string, any> | null;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

/** POST a GraphQL operation as the admin and return the parsed body. */
async function gql(query: string, variables: Record<string, unknown>): Promise<GqlBody> {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<GqlBody>;
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'wire-org', urn: 'wire-org-974.com' },
  });
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 97410, githubUsername: 'wire-admin-974', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  jwt = await signJwt({ sub: admin.id, roles: ['READER'] });

  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  // Team Agent: carries the cast-list register only. A one-name register so
  // exhaustion is reachable in one extra cast.
  const team = await M.createAgent({}, { orgId: org.id, name: 'Wire Team Agent' }, ctx);
  teamAgent = { id: team.id };
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: team.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      data: { names: ['Iris'] },
    },
  });
  // Role-agent: its served boot prompt is the persona dressing the Worker.prompt field binds (#2712).
  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'Wire Backend Engineer',
      personaRole: 'backend-engineer',
    },
    ctx,
  );
  roleAgent = { id: role.id };
  await serveAgentBootPrompt(db, role.id, 'You are {{name}}, a {{role}}.');

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Wire Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: team.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });

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

describe('the Worker surface on the wire (#974)', () => {
  let zoeId: string;
  let irisId: string;

  it('castWorker accepts EVERY advertised argument and returns the resolved Worker', async () => {
    const body = await gql(CAST, {
      appRef: app.id,
      agentRef: roleAgent.id,
      role: 'backend-engineer',
      name: 'Zoe',
    });
    expect(body.errors).toBeUndefined();
    const worker = body.data?.castWorker;
    expect(worker.name).toBe('Zoe');
    expect(worker.appId).toBe(app.id);
    expect(worker.agentId).toBe(roleAgent.id);
    expect(worker.role).toBe('backend-engineer');
    expect(worker.memoryId).toBeTruthy();
    expect(worker.retiredAt).toBeNull();
    // The resolved prompt: the served template, bound.
    expect(worker.prompt).toBe('You are Zoe, a backend-engineer.');
    expect(worker.agent?.id).toBe(roleAgent.id);
    expect(worker.app?.id).toBe(app.id);
    zoeId = worker.id;
  });

  it('a named cast lands through the wire', async () => {
    const body = await gql(CAST, { appRef: app.id, role: 'backend-engineer', name: 'Iris' });
    expect(body.errors).toBeUndefined();
    expect(body.data?.castWorker?.name).toBe('Iris');
    irisId = body.data?.castWorker?.id;
  });

  it('a NAMELESS cast carries WORKER_NAME_REQUIRED as extensions.code (#1050)', async () => {
    // The register used to answer this over the wire. With it gone the refusal
    // is the contract, and it must be typed rather than a bare validation
    // error — the name stays nullable in the SDL precisely so this message,
    // which says WHY a name cannot be derived, is what a client receives.
    const body = await gql(CAST, { appRef: app.id, role: 'backend-engineer' });
    expect(body.errors?.[0]?.extensions?.code).toBe('WORKER_NAME_REQUIRED');
    expect(body.errors?.[0]?.message).toMatch(/permanent within the App/);
  });

  it('a caller-supplied taken name carries WORKER_NAME_TAKEN as extensions.code', async () => {
    const body = await gql(CAST, {
      appRef: app.id,
      agentRef: roleAgent.id,
      name: 'Zoe',
    });
    expect(body.errors?.[0]?.extensions?.code).toBe('WORKER_NAME_TAKEN');
  });

  it('worker(ref) reads one casting with its resolved prompt', async () => {
    const body = await gql(WORKER, { ref: zoeId });
    expect(body.errors).toBeUndefined();
    expect(body.data?.worker?.name).toBe('Zoe');
    expect(body.data?.worker?.role).toBe('backend-engineer');
    expect(body.data?.worker?.prompt).toContain('You are Zoe,');
  });

  it('retireWorker stamps retiredAt through the wire', async () => {
    const body = await gql(RETIRE, { workerRef: irisId });
    expect(body.errors).toBeUndefined();
    expect(body.data?.retireWorker?.id).toBe(irisId);
    expect(body.data?.retireWorker?.retiredAt).toBeTruthy();
  });

  it('workers hides retired by default; includeRetired shows the full staff', async () => {
    const active = await gql(WORKERS, { appRef: app.id });
    expect(active.errors).toBeUndefined();
    expect(active.data?.workers?.total).toBe(1);
    expect(active.data?.workers?.items.map((w: { name: string }) => w.name)).toEqual(['Zoe']);

    const all = await gql(WORKERS, { appRef: app.id, includeRetired: true, limit: 10, offset: 0 });
    expect(all.data?.workers?.total).toBe(2);
    expect(all.data?.workers?.items.map((w: { name: string }) => w.name)).toEqual(['Zoe', 'Iris']);
  });

  it('an unknown workerRef carries WORKER_NOT_FOUND as extensions.code', async () => {
    const body = await gql(WORKER, { ref: 'nope' });
    expect(body.errors?.[0]?.extensions?.code).toBe('WORKER_NOT_FOUND');
  });
});
