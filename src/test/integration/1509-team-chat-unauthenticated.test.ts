/**
 * #1509 — a team-chat caller with NO principal is UNAUTHENTICATED, not
 * FORBIDDEN, on the wire.
 *
 * `requireTeamChatAccess` refused an unauthenticated caller (no token, an
 * expired JWT, a garbage bearer) with the same FORBIDDEN ("You are not
 * authorized to use this App's team chat.") as an authenticated non-member,
 * so a signed-out portal user saw "needs App membership" (hadron-portal#974).
 *
 * The contract is what a client SEES, so this drives real HTTP
 * (findings:resolver-level-test-cannot-see-the-wire-code). It pins four things:
 * - the appRef surfaces answer UNAUTHENTICATED for every principal-less shape,
 *   identically whether or not the App exists, and write nothing;
 * - an authenticated non-participant is still FORBIDDEN;
 * - a participant still reads;
 * - the Channel surfaces keep concealing: an anonymous caller gets the same
 *   CHANNEL_NOT_FOUND for a real App-hosted Channel as for a missing ref.
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

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { data: Record<string, any> | null | undefined; errors: GqlError[] | undefined };

const POST_MSG = `mutation($a: ID!, $b: String!) { createTeamChatMessage(appRef: $a, body: $b) { seq } }`;
const READ_MSGS = `query($a: ID!) { teamChatMessages(appRef: $a) { total } }`;
const READ_CHANNEL = `query($c: ID!) { channelMessages(channelRef: $c) { total } }`;

let server: Server;
let baseUrl: string;
let appId: string;
let channelId: string;
/** Bearer values by caller; `null` sends no Authorization header at all. */
const bearer: Record<string, string | null> = {};

async function gql(who: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const token = bearer[who];
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data?: Record<string, any> | null; errors?: GqlError[] };
  return { data: body.data, errors: body.errors };
}

const codeOf = (r: Gql) => r.errors?.[0]?.extensions?.code;

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'unauth-org', urn: 'unauth-org-1509.com' } });
  const member = await db.user.create({ data: { id: generateId(), githubId: 150901, githubUsername: 'm-1509', roles: ['READER'] } });
  const stranger = await db.user.create({ data: { id: generateId(), githubId: 150902, githubUsername: 's-1509', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'ADMIN' } });
  appId = generateId();
  await db.app.create({ data: { id: appId, organizationId: org.id, name: 'Unauth App', urn: `${org.urn}:team` } });
  // The team chat bootstraps through its Team Agent, which needs a roles: branch.
  const ctx: Context = { db, userId: member.id, roles: ['READER'] };
  const teamAgent = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Unauth Team Agent' }, ctx);
  await db.node.create({ data: {
    id: generateId(), memoryId: teamAgent.systemMemoryId, loc: 'roles:backend-engineer', name: 'backend-engineer',
    content: 'You are {{name}}, a {{role}}.', data: { names: ['Iris'] },
  } });
  await db.appAgent.create({ data: { appId, agentId: teamAgent.id } });

  bearer.member = await signJwt({ sub: member.id, roles: ['READER'] });
  bearer.stranger = await signJwt({ sub: stranger.id, roles: ['READER'] });
  bearer.none = null;
  bearer.garbage = 'not-a-real-token';
  // Signed correctly, expired a minute ago: the portal's signed-out shape.
  bearer.expired = await signJwt({ sub: member.id, roles: ['READER'] }, { expiresIn: Math.floor(Date.now() / 1000) - 60 });

  const express = await createServer();
  server = createHttpServer(express);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The member's first post bootstraps the team chat and its Channel.
  const first = await gql('member', POST_MSG, { a: appId, b: 'hello' });
  expect(first.errors, JSON.stringify(first.errors)).toBeUndefined();
  channelId = (await db.channel.findFirstOrThrow({ where: { memory: { appId } } })).id;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('#1509 — no principal is UNAUTHENTICATED on the team-chat appRef surfaces', () => {
  for (const who of ['none', 'garbage', 'expired']) {
    it(`${who}: read and post are UNAUTHENTICATED, and nothing is written`, async () => {
      const read = await gql(who, READ_MSGS, { a: appId });
      expect(read.errors).toHaveLength(1);
      expect(read.errors![0]!.extensions).toEqual({ code: 'UNAUTHENTICATED' });

      const before = await db.channel.findUniqueOrThrow({ where: { id: channelId } });
      const post = await gql(who, POST_MSG, { a: appId, b: `from ${who}` });
      expect(codeOf(post)).toBe('UNAUTHENTICATED');
      expect((await db.channel.findUniqueOrThrow({ where: { id: channelId } })).lastSeq).toBe(before.lastSeq);
    });
  }

  it('the answer does not depend on whether the App exists (no oracle)', async () => {
    const real = await gql('none', READ_MSGS, { a: appId });
    const missing = await gql('none', READ_MSGS, { a: generateId() });
    expect(missing.errors![0]!.extensions).toEqual(real.errors![0]!.extensions);
    expect(missing.errors![0]!.message).toBe(real.errors![0]!.message);
  });

  it('CONTROL: an authenticated non-participant is still FORBIDDEN', async () => {
    expect(codeOf(await gql('stranger', READ_MSGS, { a: appId }))).toBe('FORBIDDEN');
    expect(codeOf(await gql('stranger', POST_MSG, { a: appId, b: 'nope' }))).toBe('FORBIDDEN');
  });

  it('CONTROL: a participant still reads', async () => {
    const r = await gql('member', READ_MSGS, { a: appId });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data?.teamChatMessages?.total).toBe(1);
  });
});

describe('#1509 — the Channel surfaces keep concealing', () => {
  it('an anonymous caller gets the same CHANNEL_NOT_FOUND for a real App-hosted Channel as for a missing ref', async () => {
    const missingRef = generateId();
    const real = await gql('none', READ_CHANNEL, { c: channelId });
    const missing = await gql('none', READ_CHANNEL, { c: missingRef });
    expect(codeOf(real)).toBe('CHANNEL_NOT_FOUND');
    expect(codeOf(missing)).toBe('CHANNEL_NOT_FOUND');
    // Identical but for the ref each one echoes back.
    expect(real.errors![0]!.message.replace(channelId, 'REF')).toBe(missing.errors![0]!.message.replace(missingRef, 'REF'));
  });
});
