/**
 * #3474 (cor:acl:040:07 S7): an App's policy link is exactly `{ allow: string[] }`. `parsePolicyLink` reads `allow` and
 * ignores the rest, and `createApp` and `updateApp` store what the caller sent, so an extra key used to pass and be
 * stored. A row that already holds one stays as it is; sending it back is refused like any other malformed link.
 *
 * Bodies go over real HTTP as JSON text: an own `__proto__` key doesn't exist in a JS object literal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { signJwt } from '../../../auth/jwt.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const MESSAGE = 'policy must be { allow: string[] } or null.';
const SENTINEL = 'sentinel3474';
const VALID = '{"allow":["run.execute"]}';
const CREATE = 'mutation($org: ID, $agent: ID!, $name: String!, $policy: JSON) { createApp(orgRef: $org, agentRef: $agent, name: $name, policy: $policy) { id policy } }';
const UPDATE = 'mutation($ref: ID!, $name: String, $policy: JSON) { updateApp(ref: $ref, name: $name, policy: $policy) { id policy } }';
const NAME_ONLY = 'mutation($ref: ID!, $name: String) { updateApp(ref: $ref, name: $name) { id policy } }';

type Reply = { raw: string; data?: any; errors?: Array<{ message: string; extensions?: { code?: string } }> };

let server: Server;
let url: string;
let org: { id: string };
let agent: { id: string };
let app: { id: string };
let adminJwt: string;
let memberJwt: string;
let adminId: string;

/** `policyJson` is spliced in as text, so its keys reach the server exactly as written. */
async function post(query: string, variables: Record<string, unknown>, policyJson: string | null, bearer = adminJwt): Promise<Reply> {
  const vars = JSON.stringify(variables).slice(0, -1);
  const withPolicy = policyJson === null ? `${vars}}` : `${vars}${vars === '{' ? '' : ','}"policy":${policyJson}}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: `{"query":${JSON.stringify(query)},"variables":${withPolicy}}`,
  });
  const raw = await response.text();
  return { raw, ...JSON.parse(raw) };
}
const create = (policyJson: string | null, bearer?: string) => post(CREATE, { org: org.id, agent: agent.id, name: 'Created' }, policyJson, bearer);
const update = (policyJson: string | null, bearer?: string, name?: string) => post(UPDATE, { ref: app.id, ...(name ? { name } : {}) }, policyJson, bearer);
const policyOf = (id: string) => db.app.findUniqueOrThrow({ where: { id } }).then(row => row.policy);
const refusal = (reply: Reply) => JSON.stringify((reply.errors ?? []).map(e => [e.message, e.extensions?.code]));
const expectShapeRefusal = (reply: Reply) => {
  expect(reply.errors).toHaveLength(1);
  expect(reply.errors![0].message).toBe(MESSAGE);
  expect(reply.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  expect(reply.raw).not.toContain(SENTINEL);
};
/** Everything a successful createApp leaves behind. */
const footprint = async () => ({
  apps: await db.app.count(),
  members: await db.appMember.count(),
  memories: await db.memory.count(),
  channels: await db.channel.count(),
  grants: await db.agentOrgGrant.count(),
});

const EXTRA_KEYS: Array<[string, string]> = [
  ['an extra key', `{"allow":["run.execute"],"note":"${SENTINEL}"}`],
  ['an extra key beside an empty allow', `{"allow":[],"note":"${SENTINEL}"}`],
  ['an extra key before allow', `{"note":"${SENTINEL}","allow":["run.execute"]}`],
  ['an own __proto__', `{"allow":["run.execute"],"__proto__":{"note":"${SENTINEL}"}}`],
  ['an own constructor', `{"allow":["run.execute"],"constructor":"${SENTINEL}"}`],
  ['an own prototype', `{"allow":["run.execute"],"prototype":"${SENTINEL}"}`],
  ['an own name Object.prototype also has', `{"allow":["run.execute"],"toString":"${SENTINEL}"}`],
];

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Org 3474', urn: 'org3474.test' } });
  const admin = await db.user.create({ data: { id: generateId(), handle: 'admin3474', roles: ['READER'] } });
  const member = await db.user.create({ data: { id: generateId(), handle: 'member3474', roles: ['READER'] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' },
  ] });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'org3474.test:agent', name: 'agent', type: 'CHATBOT', surfaces: ['api'], visibility: 'PUBLIC' } });
  app = await db.app.create({ data: { id: generateId(), name: 'Existing', urn: 'org3474.test:existing', organizationId: org.id, policy: { allow: ['memory.*'] } } });
  adminId = admin.id;
  adminJwt = await signJwt({ sub: admin.id, roles: ['READER'] });
  memberJwt = await signJwt({ sub: member.id, roles: ['READER'] });
});

describe('#3474 updateApp refuses a link with any other own key', () => {
  it.each(EXTRA_KEYS)('%s: the fixed refusal, and the stored link stays', async (_name, policyJson) => {
    expectShapeRefusal(await update(policyJson));
    expect(await policyOf(app.id)).toEqual({ allow: ['memory.*'] });
  });

  it('an unrelated field beside it is not written either', async () => {
    expectShapeRefusal(await update(EXTRA_KEYS[0][1], adminJwt, 'Renamed'));
    expect(await db.app.findUniqueOrThrow({ where: { id: app.id } })).toMatchObject({ name: 'Existing', policy: { allow: ['memory.*'] } });
  });

  it('an inline literal is held to the same shape', async () => {
    const inline = (literal: string) => `mutation($ref: ID!) { updateApp(ref: $ref, policy: ${literal}) { id policy } }`;
    expectShapeRefusal(await post(inline(`{ allow: ["run.execute"], note: "${SENTINEL}" }`), { ref: app.id }, null));
    expect(await policyOf(app.id)).toEqual({ allow: ['memory.*'] });
    expect((await post(inline('{ allow: ["run.execute"] }'), { ref: app.id }, null)).errors).toBeUndefined();
    expect(await policyOf(app.id)).toEqual({ allow: ['run.execute'] });
  });
});

describe('#3474 createApp refuses a link with any other own key', () => {
  it.each(EXTRA_KEYS)('%s: the fixed refusal, and nothing is provisioned', async (_name, policyJson) => {
    const before = await footprint();
    expectShapeRefusal(await create(policyJson));
    expect(await footprint()).toEqual(before);
  });
});

describe('#3474 only what JSON can carry reaches the check, but the check takes nothing else', () => {
  class Link { allow = ['run.execute']; }
  const direct: Array<[string, unknown]> = [
    ['an inherited allow', Object.create({ allow: ['run.execute'] })],
    ['a class instance', new Link()],
  ];

  it.each(direct)('%s is not a plain link', async (_name, policy) => {
    const ctx = { db, roles: ['READER'], userId: adminId } as Context;
    await expect(resolvers.Mutation.updateApp({}, { ref: app.id, policy }, ctx)).rejects.toThrow(MESSAGE);
    await expect(resolvers.Mutation.createApp({}, { orgRef: org.id, agentRef: agent.id, name: 'Direct', policy } as never, ctx)).rejects.toThrow(MESSAGE);
    expect(await policyOf(app.id)).toEqual({ allow: ['memory.*'] });
  });
});

describe('#3474 a stored row that already holds an extra key', () => {
  const legacy = { allow: ['run.execute'], note: 'stored' };
  beforeEach(async () => { await db.app.update({ where: { id: app.id }, data: { policy: legacy } }); });

  it('omitting policy keeps it, extra key included', async () => {
    expect((await post(NAME_ONLY, { ref: app.id, name: 'Renamed' }, null)).errors).toBeUndefined();
    expect(await db.app.findUniqueOrThrow({ where: { id: app.id } })).toMatchObject({ name: 'Renamed', policy: legacy });
  });

  it('null clears it', async () => {
    expect((await update('null')).errors).toBeUndefined();
    expect(await policyOf(app.id)).toBeNull();
  });

  it('a canonical link replaces it, and the extra key goes', async () => {
    expect((await update(VALID)).errors).toBeUndefined();
    expect(await policyOf(app.id)).toEqual({ allow: ['run.execute'] });
  });

  it('sending the stored value back is refused: there is no same-value bypass', async () => {
    const reply = await update(JSON.stringify(legacy));
    expect(reply.errors?.[0]).toMatchObject({ message: MESSAGE, extensions: { code: 'BAD_USER_INPUT' } });
    expect(await policyOf(app.id)).toEqual(legacy);
  });
});

describe('#3474 controls, unchanged on both mutations', () => {
  it.each([
    ['a valid link', VALID, { allow: ['run.execute'] }],
    ['an empty allow', '{"allow":[]}', { allow: [] }],
    ['null', 'null', null],
  ])('%s is accepted', async (_name, policyJson, expected) => {
    expect((await update(policyJson)).errors).toBeUndefined();
    expect(await policyOf(app.id)).toEqual(expected);
    const created = await create(policyJson);
    expect(created.errors).toBeUndefined();
    expect(await policyOf(created.data.createApp.id)).toEqual(expected);
  });

  it('omitted: update keeps the link, create stores none', async () => {
    expect((await update(null)).errors).toBeUndefined();
    expect(await policyOf(app.id)).toEqual({ allow: ['memory.*'] });
    const created = await create(null);
    expect(created.errors).toBeUndefined();
    expect(await policyOf(created.data.createApp.id)).toBeNull();
  });

  it('a list with a non-string entry stays refused', async () => {
    const before = await footprint();
    expectShapeRefusal(await update('{"allow":[123]}'));
    expectShapeRefusal(await create('{"allow":[123]}'));
    expectShapeRefusal(await update('{"allow":["run.execute",123]}'));
    expectShapeRefusal(await create('{"allow":["run.execute",123]}'));
    expect(await policyOf(app.id)).toEqual({ allow: ['memory.*'] });
    expect(await footprint()).toEqual(before);
  });

  it('a caller outside the gate gets the gate refusal whatever the link', async () => {
    const before = await footprint();
    for (const send of [update, create]) {
      const baseline = await send(VALID, memberJwt);
      expect(baseline.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      for (const [, policyJson] of EXTRA_KEYS) expect(refusal(await send(policyJson, memberJwt))).toBe(refusal(baseline));
      expect(refusal(await send('{"allow":[123]}', memberJwt))).toBe(refusal(baseline));
    }
    expect(await policyOf(app.id)).toEqual({ allow: ['memory.*'] });
    expect(await footprint()).toEqual(before);
  });
});
