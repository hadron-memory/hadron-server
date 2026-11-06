/**
 * `createApp` takes the App-layer action-policy link (cor:acl:040:02), through the real schema, the
 * same way `updateApp(policy)` does: a null or omitted link means no restriction, and any other value
 * must parse as a link. Who may set it is `createApp`'s existing gate.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const server = new ApolloServer({ typeDefs, resolvers });
afterAll(async () => { await server.stop(); });

const CREATE = `mutation($orgRef: ID, $agentRef: ID!, $name: String!, $policy: JSON) {
  createApp(orgRef: $orgRef, agentRef: $agentRef, name: $name, policy: $policy) { id policy }
}`;
const CREATE_NO_POLICY = `mutation($orgRef: ID, $agentRef: ID!, $name: String!) {
  createApp(orgRef: $orgRef, agentRef: $agentRef, name: $name) { id policy }
}`;
const UPDATE = `mutation($ref: ID!, $policy: JSON) { updateApp(ref: $ref, policy: $policy) { id } }`;

const link = { allow: ['run.execute'] };

async function run(query: string, variables: Record<string, unknown>, userId: string) {
  const contextValue = { db, roles: ['READER'], userId } as Context;
  const res = await server.executeOperation({ query, variables }, { contextValue });
  return (res.body as { kind: 'single'; singleResult: { data?: any; errors?: any[] } }).singleResult;
}
const refusal = (errors: any[] | undefined) =>
  JSON.stringify((errors ?? []).map((e) => ({ message: e.message, code: e.extensions?.code })));
const stored = (id: string) => db.app.findUniqueOrThrow({ where: { id } }).then((app) => app.policy);

let org: { id: string };
let admin: { id: string };
let member: { id: string };
let solo: { id: string };
let agent: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Policy org', urn: 'createapppolicy.test' } });
  admin = await db.user.create({ data: { id: generateId(), handle: 'createpolicyadmin' } });
  member = await db.user.create({ data: { id: generateId(), handle: 'createpolicymember' } });
  solo = await db.user.create({ data: { id: generateId(), handle: 'createpolicysolo' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' },
  ] });
  agent = await db.agent.create({ data: {
    id: generateId(), organizationId: org.id, urn: 'createapppolicy.test:agent',
    name: 'agent', type: 'CHATBOT', surfaces: ['api'], visibility: 'PUBLIC',
  } });
});

describe('createApp(policy) through the real schema', () => {
  it('an org ADMIN stores the link, and it comes back on the App', async () => {
    const reply = await run(CREATE, { orgRef: org.id, agentRef: agent.id, name: 'Narrow', policy: link }, admin.id);
    expect(reply.errors).toBeUndefined();
    expect(reply.data.createApp.policy).toEqual(link);
    expect(await stored(reply.data.createApp.id)).toEqual(link);
  });

  it('the owner of a user-owned App stores the link', async () => {
    const reply = await run(CREATE, { agentRef: agent.id, name: 'Solo narrow', policy: link }, solo.id);
    expect(reply.errors).toBeUndefined();
    expect(await stored(reply.data.createApp.id)).toEqual(link);
  });

  it('an empty allow list is a link, stored as sent', async () => {
    const reply = await run(CREATE, { orgRef: org.id, agentRef: agent.id, name: 'Empty', policy: { allow: [] } }, admin.id);
    expect(reply.errors).toBeUndefined();
    expect(await stored(reply.data.createApp.id)).toEqual({ allow: [] });
  });

  it.each([
    ['omitted', CREATE_NO_POLICY, {}],
    ['null', CREATE, { policy: null }],
  ])('%s means no restriction', async (_label, query, extra) => {
    const reply = await run(query, { orgRef: org.id, agentRef: agent.id, name: 'Open', ...extra }, admin.id);
    expect(reply.errors).toBeUndefined();
    expect(await stored(reply.data.createApp.id)).toBeNull();
  });

  it.each([
    ['an unknown shape', { nonsense: 1 }],
    ['allow that is not a list', { allow: 'run.execute' }],
    ['a string', 'run.execute'],
    ['false', false],
    ['zero', 0],
  ])('%s refuses as updateApp refuses it, and creates nothing', async (_label, policy) => {
    const existing = await db.app.create({ data: { id: generateId(), name: 'Existing', urn: 'createapppolicy.test:existing', organizationId: org.id } });
    const reference = await run(UPDATE, { ref: existing.id, policy }, admin.id);
    expect(reference.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const reply = await run(CREATE, { orgRef: org.id, agentRef: agent.id, name: 'Malformed', policy }, admin.id);
    expect(refusal(reply.errors)).toBe(refusal(reference.errors));
    expect(await db.app.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('a caller outside the gate gets the gate refusal whatever the link, and creates nothing', async () => {
    const valid = await run(CREATE, { orgRef: org.id, agentRef: agent.id, name: 'No', policy: link }, member.id);
    const malformed = await run(CREATE, { orgRef: org.id, agentRef: agent.id, name: 'No', policy: { nonsense: 1 } }, member.id);
    const none = await run(CREATE_NO_POLICY, { orgRef: org.id, agentRef: agent.id, name: 'No' }, member.id);
    expect(none.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(refusal(valid.errors)).toBe(refusal(none.errors));
    expect(refusal(malformed.errors)).toBe(refusal(none.errors));
    expect(await db.app.count({ where: { organizationId: org.id } })).toBe(0);
  });
});
