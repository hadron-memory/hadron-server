/**
 * The member and share doors on a memory, called without a user (no credential, or an App key): one answer whatever the
 * memory reference names (hrn:node:hadronmemory.com:specs:cor:api:140:02). Signed-in callers' answers are the control.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { APP_KEY_PREFIX, USER_API_KEY_PREFIX, hashAppKey, hashUserApiKey } from '../../../middleware/auth.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../../test/startServerFixture.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let server: Server;
let url: string;
const refs: Record<string, string> = {};
const missing: Record<string, string> = {};
let groupId: string;
let target: string;
const bearer: Record<string, string | null> = { anonymous: null };

async function call(caller: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer[caller] ? { authorization: `Bearer ${bearer[caller]}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: unknown; errors?: Array<{ message: string; extensions: { code: string } }> };
  return { status: res.status, body, code: body.errors?.[0]?.extensions.code ?? null };
}

const person = async (n: number, h: string) => {
  const user = await db.user.create({ data: { id: generateId(), githubId: 7_600_000 + n, githubUsername: `${h}mdo`, handle: `${h}-mdo` } });
  const raw = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { id: generateId(), userId: user.id, keyHash: hashUserApiKey(raw), keyPreview: raw.slice(-4), label: 'p', oauthScopes: [] } });
  bearer[h] = raw;
  return user.id;
};

beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  await cleanDb(db);
  const owner = await person(1, 'owner');
  await person(2, 'stranger');
  target = await person(3, 'target');
  const org = await db.organization.create({ data: { id: generateId(), name: 'mdo', urn: 'mdo.test' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: 'mdo.test:x' } as never });
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'k' } });
  bearer['App key'] = raw;
  const add = async (slug: string, data: Record<string, unknown>) => {
    const memory = await db.memory.create({ data: { id: generateId(), name: slug, urn: `mdo.test:${slug}`, createdBy: owner, ...data } as never });
    refs[`${slug} (id)`] = memory.id;
    refs[`${slug} (URN)`] = `hrn:mem:${memory.urn}`;
    return memory.id;
  };
  const org_ = { organizationId: org.id };
  groupId = await add('group', { ...org_, class: 'group', visibility: 'GROUP' });
  await db.memoryMember.create({ data: { memoryId: groupId, userId: owner, role: 'owner' } });
  await add('knowledge', { ...org_, class: 'knowledge', visibility: 'ORGANIZATION' });
  await add('public', { ...org_, class: 'knowledge', visibility: 'PUBLIC' });
  await add('personal', { ownerUserId: owner, userId: owner, class: 'personal', visibility: null });
  await add('private', { ownerUserId: owner, userId: owner, class: 'private', visibility: null });
  await add('deleted', { ...org_, class: 'group', visibility: 'GROUP', deletedAt: new Date() });
  missing['missing (id)'] = generateId();
  missing['missing (URN)'] = 'hrn:mem:mdo.test:no-such-memory';
}, 60_000);
afterAll(async () => { await closeServerIfStarted(server); });

const DOORS: Array<[string, string, string]> = [
  ['addMemoryMember', 'mutation($m: ID!, $u: ID!) { addMemoryMember(memoryRef: $m, userRef: $u, role: writer) { __typename } }', 'UNAUTHENTICATED'],
  ['updateMemoryMemberRole', 'mutation($m: ID!, $u: ID!) { updateMemoryMemberRole(memoryRef: $m, userRef: $u, role: writer) { __typename } }', 'UNAUTHENTICATED'],
  // controls: these four answered alike already
  ['removeMemoryMember', 'mutation($m: ID!, $u: ID!) { removeMemoryMember(memoryRef: $m, userRef: $u) { __typename } }', 'FORBIDDEN'],
  ['createMemoryShare', 'mutation($m: ID!, $u: ID!) { createMemoryShare(memoryRef: $m, granteeRef: $u, role: writer) { __typename } }', 'UNAUTHENTICATED'],
  ['updateMemoryShareRole', 'mutation($m: ID!, $u: ID!) { updateMemoryShareRole(memoryRef: $m, granteeRef: $u, role: writer) { __typename } }', 'UNAUTHENTICATED'],
  ['deleteMemoryShare', 'mutation($m: ID!, $u: String) { deleteMemoryShare(memoryRef: $m, granteeRef: $u) { __typename } }', 'UNAUTHENTICATED'],
];
const audience = async () => JSON.stringify([await db.memoryMember.findMany({ orderBy: { userId: 'asc' } }), await db.memoryShare.findMany()]);

describe.each(['anonymous', 'App key'])('a caller without a user: %s', (caller) => {
  it.each(DOORS)('%s gives one answer for every reference and writes nothing', async (_door, query, code) => {
    const before = await audience();
    for (const u of [target, 'hrn:user:nobody-mdo']) {
      const want = await call(caller, query, { m: missing['missing (URN)'], u });
      expect(want.code).toBe(code);
      for (const [name, m] of Object.entries({ ...refs, ...missing })) {
        const got = await call(caller, query, { m, u });
        expect({ name, status: got.status, body: got.body }).toEqual({ name, status: want.status, body: want.body });
      }
    }
    expect(await audience()).toBe(before);
  });

  it.each(DOORS.slice(0, 2))('%s refuses the caller before it looks at a malformed reference', async (_door, query) => {
    expect((await call(caller, query, { m: 'not a ref', u: target })).code).toBe('UNAUTHENTICATED');
  });
});

describe('a signed-in caller is answered as before', () => {
  it.each(DOORS.slice(0, 2))('%s: a stranger is FORBIDDEN alike for every reference, and a malformed one is named', async (_door, query) => {
    const want = await call('stranger', query, { m: missing['missing (URN)'], u: target });
    expect(want.code).toBe('FORBIDDEN');
    for (const [name, m] of Object.entries({ ...refs, ...missing })) {
      for (const u of [target, 'hrn:user:nobody-mdo']) expect({ name, body: (await call('stranger', query, { m, u })).body }).toEqual({ name, body: want.body });
    }
    expect((await call('stranger', query, { m: 'not a ref', u: target })).code).toBe('URN_NOT_QUALIFIED');
  });

  it('the owner adds a member and changes their role', async () => {
    const roleOf = async () => (await db.memoryMember.findFirst({ where: { memoryId: groupId, userId: target } }))?.role;
    expect((await call('owner', DOORS[0]![1], { m: groupId, u: target })).body.errors).toBeUndefined();
    expect(await roleOf()).toBe('writer');
    await db.memoryMember.updateMany({ where: { memoryId: groupId, userId: target }, data: { role: 'reader' } });
    expect((await call('owner', DOORS[1]![1], { m: groupId, u: target })).body.errors).toBeUndefined();
    expect(await roleOf()).toBe('writer');
  });
});
