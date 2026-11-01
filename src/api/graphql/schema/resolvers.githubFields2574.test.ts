/**
 * #2574 — the legacy GitHub fields on a nested `User` (Holger V28,
 * hrn:node:hadronmemory.com:specs:cor:acl:070:01).
 *
 * - `githubId` sits with name and email behind `canSeeUserPersonalFields`:
 *   self, a co-member and a platform admin read it; anyone else reads null,
 *   never an error.
 * - `githubUsername` and `avatarUrl` are identity: any signed-in viewer reads
 *   them, and the username stays the public search key of cor:acl:070:02
 *   (`users(filter)` and `globalSearch` match it for a stranger).
 *
 * Principals: the target themselves, a platform admin who shares no org, a
 * co-member, a member of an unrelated org who reaches the target through a
 * readable relation (`app.members`), and an outsider with no org at all.
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { resolveRevisionEditor } from './resolvers.types.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

const GITHUB_ID = 25740001;
const USERNAME = 'gh-target-2574';
const AVATAR = 'https://avatars.example.com/u/25740001';

async function run(query: string, variables: Record<string, unknown>, userId: string, roles: Context['roles'] = ['READER']) {
  const response = await server.executeOperation({ query, variables }, { contextValue: { db, userId, roles } as Context });
  if (response.body.kind !== 'single') throw new Error('Expected a single GraphQL result');
  expect(response.body.singleResult.errors).toBeUndefined();
  return response.body.singleResult.data as Record<string, any>;
}

async function fixture() {
  const targetOrg = await createDbOrgAndGraph(db, { orgName: 'gh2574-target-org', graphName: 'gh2574-target-memory' });
  const otherOrg = await createDbOrgAndGraph(db, { orgName: 'gh2574-other-org', graphName: 'gh2574-other-memory' });
  const target = await db.user.create({
    data: { handle: 'gh2574-target', githubId: GITHUB_ID, githubUsername: USERNAME, avatarUrl: AVATAR, roles: ['READER'] },
  });
  const coMember = await db.user.create({ data: { handle: 'gh2574-co', githubId: 25740002, githubUsername: 'gh2574-co', roles: ['READER'] } });
  const unrelated = await db.user.create({ data: { handle: 'gh2574-unrelated', githubId: 25740003, githubUsername: 'gh2574-unrelated', roles: ['READER'] } });
  const outsider = await db.user.create({ data: { handle: 'gh2574-outsider', githubId: 25740004, githubUsername: 'gh2574-outsider', roles: ['READER'] } });
  const admin = await db.user.create({ data: { handle: 'gh2574-admin', githubId: 25740005, githubUsername: 'gh2574-admin', roles: ['ADMIN'] } });
  await db.orgMember.createMany({
    data: [
      { organizationId: targetOrg.org.id, userId: target.id, role: 'READER' },
      { organizationId: targetOrg.org.id, userId: coMember.id, role: 'READER' },
      { organizationId: otherOrg.org.id, userId: unrelated.id, role: 'READER' },
    ],
  });
  // A readable relation into the target from an org the target is not in: the
  // unrelated member's App lists the target as a member.
  const { app } = await createDbAppWithKey(db, 'gh2574-other-app', otherOrg.org.id);
  await db.appMember.create({ data: { appId: app.id, userId: target.id, role: 'owner' } });
  return { target, coMember, unrelated, outsider, admin, app };
}

const FIELDS = 'id githubId githubUsername avatarUrl';
const BY_USERNAME = `query ($q: String!) { users(filter: { query: $q }) { items { ${FIELDS} } } }`;
const visible = (id: string) => ({ id, githubId: GITHUB_ID, githubUsername: USERNAME, avatarUrl: AVATAR });
const hidden = (id: string) => ({ id, githubId: null, githubUsername: USERNAME, avatarUrl: AVATAR });

describe('#2574 githubId is personal, githubUsername and avatarUrl are identity (V28)', () => {
  beforeEach(async () => cleanDb(db));

  it('the target reads their own githubId', async () => {
    const f = await fixture();
    const data = await run(`query ($ref: ID!) { user(ref: $ref) { ${FIELDS} } }`, { ref: f.target.id }, f.target.id);
    expect(data.user).toEqual(visible(f.target.id));
  });

  it('a platform admin who shares no org reads githubId', async () => {
    const f = await fixture();
    const data = await run(BY_USERNAME, { q: USERNAME }, f.admin.id, ['ADMIN']);
    expect(data.users.items).toEqual([visible(f.target.id)]);
  });

  it('a co-member reads githubId', async () => {
    const f = await fixture();
    const data = await run(BY_USERNAME, { q: USERNAME }, f.coMember.id);
    expect(data.users.items).toEqual([visible(f.target.id)]);
  });

  it('a member of an unrelated org reaching the target through app.members reads null githubId, identity intact', async () => {
    const f = await fixture();
    const data = await run(`query ($ref: ID!) { app(ref: $ref) { members { user { ${FIELDS} } } } }`, { ref: f.app.id }, f.unrelated.id);
    expect(data.app?.members?.map((m: { user: unknown }) => m.user)).toEqual([hidden(f.target.id)]);
  });

  it('an outsider with no org finds the target by username and reads null githubId, identity intact', async () => {
    const f = await fixture();
    const data = await run(BY_USERNAME, { q: USERNAME }, f.outsider.id);
    expect(data.users.items).toEqual([hidden(f.target.id)]);
  });
});

describe('#2574 githubId at the field resolver for callers with no plain user viewer (Riana §10 P3-1)', () => {
  beforeEach(async () => cleanDb(db));
  const githubId = (resolvers.User as Record<string, (u: unknown, a: unknown, c: Context) => Promise<unknown>>).githubId;

  it('a caller with no userId (App key, anonymous) reads null githubId', async () => {
    const f = await fixture();
    expect(await githubId({ id: f.target.id, githubId: GITHUB_ID }, {}, { db, roles: [] } as unknown as Context)).toBeNull();
  });

  it('an impersonation scoped to an org the target is not in reads null githubId, though the impersonated user is a co-member', async () => {
    const f = await fixture();
    const otherOrgId = (await db.orgMember.findFirstOrThrow({ where: { userId: f.unrelated.id } })).organizationId;
    const ctx = { db, userId: f.coMember.id, roles: ['READER'], impersonation: { orgId: otherOrgId, adminUserId: f.admin.id } } as unknown as Context;
    expect(await githubId({ id: f.target.id, githubId: GITHUB_ID }, {}, ctx)).toBeNull();
    // Control: the same co-member without impersonation reads it.
    expect(await githubId({ id: f.target.id, githubId: GITHUB_ID }, {}, { db, userId: f.coMember.id, roles: ['READER'] } as Context)).toBe(GITHUB_ID);
  });
});

describe('#2574 the username stays a public search key (cor:acl:070:02, V28 keeps it)', () => {
  beforeEach(async () => cleanDb(db));

  it('an outsider locates the target by a githubUsername substring through users(filter)', async () => {
    const f = await fixture();
    const data = await run(BY_USERNAME, { q: 'target-2574' }, f.outsider.id);
    expect(data.users.items.map((u: { id: string }) => u.id)).toEqual([f.target.id]);
  });

  it('an outsider resolves a github:<login> revision editor to the target (exact match, handle and urn only)', async () => {
    const f = await fixture();
    const ctx = { db, userId: f.outsider.id, roles: ['READER'] } as Context;
    expect(await resolveRevisionEditor(ctx, [`github:${USERNAME.toUpperCase()}`])).toEqual({
      handle: f.target.handle,
      urn: `hrn:user:${f.target.handle}`,
    });
  });

  it('an outsider locates the target by githubUsername through globalSearch', async () => {
    const f = await fixture();
    const data = await run(
      `query ($q: String!) { globalSearch(query: $q, entityTypes: [user]) { hits { entityType id } } }`,
      { q: USERNAME },
      f.outsider.id,
    );
    expect(data.globalSearch.hits).toContainEqual({ entityType: 'user', id: f.target.id });
  });
});
