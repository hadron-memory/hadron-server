/**
 * #935 — createTeamPersona through the REAL wire (createServer() + a GraphQL
 * POST), because resolver-level tests cannot see two whole failure classes:
 * SDL/resolver argument drift (findings:sdl-resolver-arg-drift-invisible-to-
 * tests) and a typed error whose code never reaches the network
 * (conventions:typed-error-must-be-registered-in-formaterror). The happy path
 * proves the SDL args are wired; the error cases pin extensions.code as the
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

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

const MINT = `
  mutation Mint($appRef: ID!, $role: String!, $name: String) {
    createTeamPersona(appRef: $appRef, role: $role, name: $name) {
      id
      personaName
      personaRole
      personaPrompt
    }
  }
`;

let server: Server;
let baseUrl: string;
let jwt: string;
let app: { id: string };

async function mint(variables: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ query: MINT, variables }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    data?: { createTeamPersona?: { personaName: string; personaRole: string; personaPrompt: string } } | null;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  }>;
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'wire-org', urn: 'wire-org-935.com' },
  });
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 93510, githubUsername: 'wire-admin-935', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  jwt = await signJwt({ sub: admin.id, roles: ['READER'] });

  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  const teamAgent = await M.createAgent({}, { orgId: org.id, name: 'Wire Team Agent' }, ctx);
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      // A one-name register so exhaustion is reachable in one extra mint.
      data: { names: ['Iris'] },
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Wire Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });

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

describe('createTeamPersona on the wire (#935)', () => {
  it('mints through the advertised SDL arguments and returns the persona', async () => {
    const body = await mint({ appRef: app.id, role: 'backend-engineer' });
    expect(body.errors).toBeUndefined();
    expect(body.data?.createTeamPersona?.personaName).toBe('Iris');
    expect(body.data?.createTeamPersona?.personaRole).toBe('backend-engineer');
    expect(body.data?.createTeamPersona?.personaPrompt).toBe('You are Iris, a backend-engineer.');
  });

  it('register exhaustion carries PERSONA_REGISTER_EXHAUSTED as extensions.code', async () => {
    const body = await mint({ appRef: app.id, role: 'backend-engineer' });
    expect(body.errors?.[0]?.extensions?.code).toBe('PERSONA_REGISTER_EXHAUSTED');
  });

  it('a caller-supplied taken name carries PERSONA_NAME_TAKEN as extensions.code', async () => {
    const body = await mint({ appRef: app.id, role: 'backend-engineer', name: 'Iris' });
    expect(body.errors?.[0]?.extensions?.code).toBe('PERSONA_NAME_TAKEN');
  });
});
