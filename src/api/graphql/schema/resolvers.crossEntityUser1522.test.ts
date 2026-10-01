import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

describe('#1522 nested User field visibility', () => {
  beforeEach(async () => cleanDb(db));

  it('keeps a foreign App member identity readable without exposing private User fields', async () => {
    const ownerOrg = await createDbOrgAndGraph(db, { orgName: 'nested-user-owner', graphName: 'owner-memory' });
    const externalOrg = await createDbOrgAndGraph(db, { orgName: 'nested-user-external', graphName: 'external-memory' });
    const owner = await db.user.create({
      data: { githubId: 9182202, githubUsername: 'nested-user-owner', roles: ['READER'] },
    });
    const { app } = await createDbAppWithKey(db, 'nested-user-owner-app', ownerOrg.org.id);
    const external = await db.user.create({
      data: {
        githubId: 9182203,
        githubUsername: 'nested-user-external',
        name: 'External Private Name',
        roles: ['CONTRIBUTOR'],
        identityProvider: 'GITHUB',
        externalId: 'synthetic-external-id',
        externalAppId: app.id,
        linkedAt: new Date('2026-09-30T00:00:00.000Z'),
        maxReferrals: 42,
        policy: { syntheticSecret: 'external-user-private-policy' },
      },
    });
    const coMember = await db.user.create({
      data: { githubId: 9182204, githubUsername: 'nested-user-co-member', roles: ['READER'] },
    });
    await db.orgMember.createMany({
      data: [
        { organizationId: ownerOrg.org.id, userId: owner.id, role: 'READER' },
        { organizationId: ownerOrg.org.id, userId: coMember.id, role: 'READER' },
        { organizationId: externalOrg.org.id, userId: coMember.id, role: 'READER' },
        { organizationId: externalOrg.org.id, userId: external.id, role: 'READER' },
      ],
    });
    await db.appMember.create({ data: { appId: app.id, userId: external.id, role: 'owner' } });

    const query = `query ($ref: ID!) {
      app(ref: $ref) {
        members { user { id handle name policy identityProvider externalId externalAppId linkedAt roles maxReferrals } }
      }
    }`;
    const execute = async (userId: string, roles: Context['roles'] = ['READER']) => {
      const response = await server.executeOperation(
        { query, variables: { ref: app.id } },
        { contextValue: { db, userId, roles } as Context },
      );
      expect(response.body.kind).toBe('single');
      if (response.body.kind !== 'single') throw new Error('Expected a single GraphQL result');
      expect(response.body.singleResult.errors).toBeUndefined();
      return response.body.singleResult.data?.app;
    };

    const direct = await server.executeOperation(
      { query: 'query ($ref: ID!) { user(ref: $ref) { id policy } }', variables: { ref: external.id } },
      { contextValue: { db, userId: owner.id, roles: ['READER'] } as Context },
    );
    expect(direct.body.kind).toBe('single');
    if (direct.body.kind !== 'single') throw new Error('Expected a single GraphQL result');
    expect(direct.body.singleResult.data?.user).toBeNull();

    expect(await execute(owner.id)).toMatchObject({
      members: [{ user: {
        id: external.id,
        handle: external.handle,
        name: null,
        policy: null,
        identityProvider: null,
        externalId: null,
        externalAppId: null,
        linkedAt: null,
        roles: [],
        maxReferrals: null,
      } }],
    });
    const expectedPersonal = {
      id: external.id,
      name: 'External Private Name',
      policy: { syntheticSecret: 'external-user-private-policy' },
      identityProvider: 'GITHUB',
      externalId: 'synthetic-external-id',
      externalAppId: app.id,
      linkedAt: '2026-09-30T00:00:00.000Z',
      roles: ['CONTRIBUTOR'],
      maxReferrals: 42,
    };
    expect(await execute(coMember.id)).toMatchObject({
      members: [{ user: expectedPersonal }],
    });
    const self = await server.executeOperation(
      {
        query: 'query ($ref: ID!) { user(ref: $ref) { id name policy identityProvider externalId externalAppId linkedAt roles maxReferrals } }',
        variables: { ref: external.id },
      },
      { contextValue: { db, userId: external.id, roles: ['READER'] } as Context },
    );
    expect(self.body.kind).toBe('single');
    if (self.body.kind !== 'single') throw new Error('Expected a single GraphQL result');
    expect(self.body.singleResult.data?.user).toMatchObject(expectedPersonal);
    expect(await execute(owner.id, ['ADMIN'])).toMatchObject({
      members: [{ user: { id: external.id, policy: { syntheticSecret: 'external-user-private-policy' } } }],
    });
  });
});
