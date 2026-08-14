/**
 * #939 — team-chat operations through the REAL wire (createServer() + a
 * GraphQL POST), because resolver-level tests cannot see two whole failure
 * classes: SDL/resolver argument drift (findings:sdl-resolver-arg-drift-
 * invisible-to-tests) and a typed error whose code never reaches the network
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

const POST_MSG = `
  mutation Post($appRef: ID!, $body: String!, $replyToSeq: Int, $sessionRef: ID) {
    createTeamChatMessage(appRef: $appRef, body: $body, replyToSeq: $replyToSeq, sessionRef: $sessionRef) {
      seq
      body
      authorUserId
      authorWorkerId
      authorName
      replyToSeq
      mentions
    }
  }
`;

const READ_MSGS = `
  query Read($appRef: ID!, $sinceSeq: Int, $mentionsRef: ID, $limit: Int, $offset: Int) {
    teamChatMessages(appRef: $appRef, sinceSeq: $sinceSeq, mentionsRef: $mentionsRef, limit: $limit, offset: $offset) {
      total
      items { seq body authorWorkerId authorName mentions }
    }
  }
`;

let server: Server;
let baseUrl: string;
let jwt: string;
let app: { id: string };

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
    data: { id: generateId(), name: 'wire-org-939', urn: 'wire-org-939.com' },
  });
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 93910, githubUsername: 'wire-admin-939', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  jwt = await signJwt({ sub: admin.id, roles: ['READER'] });

  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  const teamAgent = await M.createAgent({}, { orgId: org.id, name: 'Wire Team Agent 939' }, ctx);
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
    data: { id: generateId(), organizationId: org.id, name: 'Wire Team App 939', urn: `${org.urn}:team` },
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

describe('team chat on the wire (#939)', () => {
  it('posts through the advertised SDL arguments and reads the page back', async () => {
    const posted = await gql(POST_MSG, { appRef: app.id, body: 'hello @Iris' });
    expect(posted.errors).toBeUndefined();
    expect(posted.data?.createTeamChatMessage?.seq).toBe(1);
    expect(posted.data?.createTeamChatMessage?.mentions).toEqual(['iris']);
    // #974: a human post carries no worker author.
    expect(posted.data?.createTeamChatMessage?.authorWorkerId).toBeNull();

    const reply = await gql(POST_MSG, { appRef: app.id, body: 'ack', replyToSeq: 1 });
    expect(reply.errors).toBeUndefined();
    expect(reply.data?.createTeamChatMessage?.replyToSeq).toBe(1);

    const page = await gql(READ_MSGS, { appRef: app.id, sinceSeq: 0 });
    expect(page.errors).toBeUndefined();
    expect(page.data?.teamChatMessages?.total).toBe(2);
    expect(page.data?.teamChatMessages?.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
  });

  it('a missing replyToSeq target carries TEAM_CHAT_REPLY_NOT_FOUND as extensions.code', async () => {
    const body = await gql(POST_MSG, { appRef: app.id, body: 'reply to nothing', replyToSeq: 99 });
    expect(body.errors?.[0]?.extensions?.code).toBe('TEAM_CHAT_REPLY_NOT_FOUND');
  });

  it('an over-cap body carries TEAM_CHAT_BODY_TOO_LARGE as extensions.code', async () => {
    const body = await gql(POST_MSG, { appRef: app.id, body: 'x'.repeat(65_537) });
    expect(body.errors?.[0]?.extensions?.code).toBe('TEAM_CHAT_BODY_TOO_LARGE');
  });

  it('an unknown sessionRef carries SESSION_NOT_FOUND as extensions.code', async () => {
    const body = await gql(POST_MSG, { appRef: app.id, body: 'as worker', sessionRef: 'nope' });
    expect(body.errors?.[0]?.extensions?.code).toBe('SESSION_NOT_FOUND');
  });
});
