/**
 * #5184 — `updateMemory(urn:)` is refused on an App's personal and private
 * memories (`cor:dmo:060:20`, "The slug never changes", S10).
 *
 * The predicate is one row test: `appId` set and class `personal` or
 * `private`. The refusal is judged after the manage gate (so a caller who
 * cannot read the memory keeps the missing-memory answer) and again under the
 * row lock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServerOnCleanDb } from '../../../test/startServerFixture.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
import { holdInTransaction } from '../../../test/lockHold.js';
import { deadline, waitBlocked, within } from '../../../test/lockObserver.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null, writtenNodes: [] }),
}));

const REFUSAL = 'APP_MEMORY_SLUG_FIXED';
const MESSAGE = 'A personal or private memory in an App keeps its slug. Its display name can be changed.';
const RENAME = 'mutation($r: ID!, $u: String, $n: String) { updateMemory(ref: $r, urn: $u, name: $n) { id urn name } }';

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: unknown; errors: GqlError[] | undefined };
type Principal = 'owner' | 'grantee' | 'stranger' | 'orgAdmin' | 'platformAdmin';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let org: { id: string; urn: string };
let app: { id: string };
let agent: { id: string };
const user = {} as Record<Principal, { id: string; handle: string }>;
const key = {} as Record<Principal, string>;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org-a', urn: 'org-a' } });
  agent = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: 'org-a:coach', organizationId: org.id } });
  app = (await createDbAppWithKey(db, 'tutor', org.id)).app;
  await createDbAppAgent(db, app.id, agent.id);
  const principals: Principal[] = ['owner', 'grantee', 'stranger', 'orgAdmin', 'platformAdmin'];
  for (const label of principals) {
    const handle = `${label.toLowerCase()}-5184`;
    user[label] = {
      handle,
      id: (
        await db.user.create({
          data: { id: generateId(), handle, githubUsername: handle, roles: label === 'platformAdmin' ? ['ADMIN'] : ['READER'] },
        })
      ).id,
    };
    key[label] = (
      await mintUserApiKey(db, { userId: user[label].id, label, createdBy: user[label].id, issuedVia: 'test', oauthScopes: ['account'] })
    ).rawKey;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.owner.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.grantee.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.orgAdmin.id, role: 'OWNER' } });
  await createDbAppMember(db, app.id, user.owner.id, 'eater');
});

async function gql(principal: Principal, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key[principal]}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: unknown; errors?: GqlError[] };
  return { status: response.status, data: body.data, errors: body.errors };
}

const code = (r: Gql) => r.errors?.[0]?.extensions?.code;

type Tenant = 'organization' | 'user';
type Klass = 'personal' | 'private';

/** An App memory of the owner's, seeded as a row: the org-tenant shape today's door writes, or the user-tenant one. */
async function appMemory(klass: Klass, tenant: Tenant, slug = `tutor-${klass}-${tenant}`) {
  const root = tenant === 'organization' ? org.urn : user.owner.handle;
  return db.memory.create({
    data: {
      id: generateId(),
      urn: `${root}:${slug}`,
      name: slug,
      class: klass,
      userId: user.owner.id,
      ...(tenant === 'organization' ? { organizationId: org.id } : { ownerUserId: user.owner.id }),
      appId: app.id,
      userMemoryOfAgentId: agent.id,
    },
  });
}

/** The row and the alias map are as they were: nothing was written. */
async function expectUntouched(before: { id: string; urn: string; name: string; updatedAt: Date | null; appId: string | null }) {
  const after = await db.memory.findUniqueOrThrow({ where: { id: before.id } });
  expect({ urn: after.urn, name: after.name, updatedAt: after.updatedAt, appId: after.appId }).toEqual({
    urn: before.urn,
    name: before.name,
    updatedAt: before.updatedAt,
    appId: before.appId,
  });
  expect(await db.urnAlias.count({ where: { entityId: before.id } })).toBe(0);
}

function expectRefused(r: Gql, klass: Klass) {
  expect(r.errors).toHaveLength(1);
  expect(r.errors![0].message).toBe(MESSAGE);
  expect(r.errors![0].extensions).toMatchObject({ code: REFUSAL, memoryClass: klass });
}

const SHAPES: [Klass, Tenant][] = [
  ['personal', 'organization'],
  ['private', 'organization'],
  ['personal', 'user'],
  ['private', 'user'],
];

describe('#5184 the owner is refused and nothing is written', () => {
  it.each(SHAPES)('%s, %s tenant: a new slug, with a name sent in the same call', async (klass, tenant) => {
    const mem = await appMemory(klass, tenant);
    expectRefused(await gql('owner', RENAME, { r: mem.id, u: 'another-slug', n: 'another name' }), klass);
    await expectUntouched(mem);
  });

  it('refuses the current slug too', async () => {
    const mem = await appMemory('private', 'organization', 'tutor-owner-private');
    expectRefused(await gql('owner', RENAME, { r: mem.id, u: 'tutor-owner-private' }), 'private');
    await expectUntouched(mem);
  });

  it('refuses an empty slug and a malformed one with the same code (judged before the slug is read)', async () => {
    const mem = await appMemory('personal', 'organization');
    for (const slug of ['', 'hrn:mem:org-a::x']) {
      expectRefused(await gql('owner', RENAME, { r: mem.id, u: slug }), 'personal');
    }
    await expectUntouched(mem);
  });

  it('is judged before any other argument', async () => {
    const mem = await appMemory('personal', 'organization');
    const r = await gql('owner', 'mutation($r: ID!) { updateMemory(ref: $r, urn: "x", orgRef: "no-such-org", maxRevCount: 0) { id } }', {
      r: mem.id,
    });
    expectRefused(r, 'personal');
    await expectUntouched(mem);
  });

  it('echoes no reference, slug or URN', async () => {
    const mem = await appMemory('private', 'organization');
    const r = await gql('owner', RENAME, { r: `hrn:mem:${mem.urn}`, u: 'wanted-slug' });
    const wire = JSON.stringify(r.errors);
    for (const value of [mem.id, mem.urn, 'wanted-slug']) expect(wire).not.toContain(value);
  });
});

describe('#5184 memories made before the rule', () => {
  it.each(['personal', 'private'] as const)('a %s memory made by createMemoryInApp', async (klass) => {
    const made = await gql(
      'owner',
      'mutation($a: ID!, $g: ID!, $c: MemoryClass!) { createMemoryInApp(appRef: $a, agentRef: $g, memoryClass: $c, name: "My notes") { id } }',
      { a: app.id, g: agent.id, c: klass },
    );
    expect(made.errors).toBeUndefined();
    const id = (made.data as { createMemoryInApp: { id: string } }).createMemoryInApp.id;
    const mem = await db.memory.findUniqueOrThrow({ where: { id } });
    expectRefused(await gql('owner', RENAME, { r: id, u: 'readable-slug' }), klass);
    await expectUntouched(mem);
  });

  // #5185: attachMemoryToApp LINKS a memory to an App; it no longer binds it. The memory stays free-standing (app_id null),
  // so it is not App-owned and the rule above (an App's personal or private memory keeps its slug) does not reach it.
  it('a free-standing memory linked by attachMemoryToApp stays free-standing and keeps its rename', async () => {
    const free = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'org-a:my-notes', name: 'my-notes', class: 'personal', userId: user.owner.id },
    });
    const attached = await gql(
      'owner',
      'mutation($m: ID!, $a: ID!) { attachMemoryToApp(memoryRef: $m, appRef: $a) { id } }',
      { m: free.id, a: app.id },
    );
    expect(attached.errors).toBeUndefined();
    expect((await db.memory.findUniqueOrThrow({ where: { id: free.id } })).appId).toBeNull();
    const renamed = await gql('owner', RENAME, { r: free.id, u: 'readable-slug' });
    expect(renamed.errors).toBeUndefined();
    const after = await db.memory.findUniqueOrThrow({ where: { id: free.id } });
    expect(after.urn).toBe('org-a:readable-slug');
    expect(after.appId).toBeNull();
  });
});

describe('#5184 nobody else learns more than from a read', () => {
  it.each(SHAPES)('%s, %s tenant: non-owner, org admin and platform admin get the missing-memory answer', async (klass, tenant) => {
    const mem = await appMemory(klass, tenant);
    const absent = generateId();
    for (const principal of ['stranger', 'orgAdmin', 'platformAdmin'] as const) {
      const existing = await gql(principal, RENAME, { r: mem.id, u: 'another-slug' });
      const missing = await gql(principal, RENAME, { r: absent, u: 'another-slug' });
      expect(code(missing)).toBe('MEMORY_NOT_FOUND');
      expect(JSON.stringify(existing).split(mem.id).join('<REF>')).toBe(JSON.stringify(missing).split(absent).join('<REF>'));
    }
    await expectUntouched(mem);
  });

  // A share grants no read on an agent-scoped personal row (`granteeShareAccess`),
  // and every App personal row is agent-scoped, so a grantee is a non-reader too.
  it('a share grantee gets the missing-memory answer', async () => {
    const mem = await appMemory('personal', 'organization');
    await db.memoryShare.create({
      data: { memoryId: mem.id, granteeId: user.grantee.id, grantorId: user.owner.id, role: 'writer' },
    });
    const absent = generateId();
    const existing = await gql('grantee', RENAME, { r: mem.id, u: 'another-slug' });
    const missing = await gql('grantee', RENAME, { r: absent, u: 'another-slug' });
    expect(code(missing)).toBe('MEMORY_NOT_FOUND');
    expect(JSON.stringify(existing).split(mem.id).join('<REF>')).toBe(JSON.stringify(missing).split(absent).join('<REF>'));
    await expectUntouched(mem);
  });

  it('an impersonation of the owner gets no new code', async () => {
    const mem = await appMemory('private', 'organization');
    const ctx: Context = {
      db,
      userId: user.owner.id,
      roles: [],
      impersonation: { orgId: org.id, sessionId: generateId(), actorUserId: user.orgAdmin.id, expiresAt: new Date(Date.now() + 60_000) },
    } as unknown as Context;
    await expect(resolvers.Mutation.updateMemory({}, { ref: mem.id, urn: 'another-slug' }, ctx)).rejects.toThrow(
      /^MEMORY_NOT_FOUND: /,
    );
    await expectUntouched(mem);
  });
});

describe('#5184 judged again under the row lock', () => {
  /**
   * Lock the memory row and change it without committing, start the rename (its
   * first read still sees the old row), wait until it is blocked behind the
   * holder, then commit.
   */
  async function raceRename(memoryId: string, change: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    const held = await holdInTransaction(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
      await change(tx);
    });
    const dl = deadline(10_000);
    const rename = gql('owner', RENAME, { r: memoryId, u: 'raced-slug' });
    try {
      await waitBlocked(db, dl, { query: /FROM memories WHERE id = .* FOR UPDATE/is, blockedBy: [held.pid] });
    } finally {
      held.release();
    }
    const [, answer] = await within(dl, 'the race', Promise.all([held.done, rename]));
    return answer;
  }

  it('a memory attached to an App while the rename waits is refused, with no alias', async () => {
    const free = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'org-a:loose', name: 'loose', class: 'personal', userId: user.owner.id },
    });
    const answer = await raceRename(free.id, (tx) =>
      tx.memory.update({ where: { id: free.id }, data: { appId: app.id, userMemoryOfAgentId: agent.id } }),
    );
    expectRefused(answer, 'personal');
    const after = await db.memory.findUniqueOrThrow({ where: { id: free.id } });
    expect(after.urn).toBe('org-a:loose');
    expect(await db.urnAlias.count({ where: { entityId: free.id } })).toBe(0);
  });

  it('a caller who stops being the owner while waiting gets the missing-memory answer', async () => {
    // Loose at the first read, so the earlier class check does not answer; at
    // the lock it is an App memory that belongs to somebody else.
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'org-a:moving', name: 'moving', class: 'personal', userId: user.owner.id },
    });
    const answer = await raceRename(mem.id, (tx) =>
      tx.memory.update({
        where: { id: mem.id },
        data: { appId: app.id, userMemoryOfAgentId: agent.id, userId: user.stranger.id },
      }),
    );
    expect(code(answer)).toBe('MEMORY_NOT_FOUND');
    expect(await db.urnAlias.count({ where: { entityId: mem.id } })).toBe(0);
  });
});

describe('#5184 everything else is unchanged', () => {
  const asOwner = async (data: Record<string, unknown>) =>
    db.memory.create({ data: { id: generateId(), organizationId: org.id, name: 'm', ...data } as never });

  it.each([
    ['organization knowledge', { class: 'knowledge', visibility: 'ORGANIZATION' }],
    ['App-scoped knowledge', { class: 'knowledge', visibility: 'ORGANIZATION', withApp: true }],
    ['group', { class: 'group', visibility: 'GROUP' }],
    ['system', { class: 'system' }],
    ['app class', { class: 'app', withApp: true }],
  ])('%s renames as before', async (_label, { withApp, ...shape }: Record<string, unknown>) => {
    const mem = await asOwner({ ...shape, urn: 'org-a:before', ...(withApp ? { appId: app.id } : {}) });
    const r = await gql('orgAdmin', RENAME, { r: mem.id, u: 'after' });
    expect(r.errors).toBeUndefined();
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).urn).toBe('org-a:after');
  });

  it.each(['personal', 'private'] as const)('a free-standing organization %s memory renames as before', async (klass) => {
    const mem = await asOwner({ class: klass, urn: 'org-a:free', userId: user.owner.id });
    const r = await gql('owner', RENAME, { r: mem.id, u: 'free-renamed' });
    expect(r.errors).toBeUndefined();
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).urn).toBe('org-a:free-renamed');
  });

  it('a free-standing user-owned memory keeps BAD_USER_INPUT', async () => {
    const mem = await db.memory.create({
      data: { id: generateId(), urn: `${user.owner.handle}:free`, name: 'free', class: 'personal', userId: user.owner.id, ownerUserId: user.owner.id },
    });
    expect(code(await gql('owner', RENAME, { r: mem.id, u: 'other' }))).toBe('BAD_USER_INPUT');
    await expectUntouched(mem);
  });

  it.each(SHAPES)('the display name of an App %s memory (%s tenant) still changes', async (klass, tenant) => {
    const mem = await appMemory(klass, tenant);
    const r = await gql('owner', RENAME, { r: mem.id, n: 'My own title' });
    expect(r.errors).toBeUndefined();
    const after = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });
    expect({ name: after.name, urn: after.urn }).toEqual({ name: 'My own title', urn: mem.urn });
  });
});
