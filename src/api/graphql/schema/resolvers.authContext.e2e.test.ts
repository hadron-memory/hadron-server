import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function run(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation(
    { query },
    { contextValue: { db, ...ctx } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

const QUERY = `query { authContext { principalType appId agentId user { id } apiKey { id keyPreview revokedAt } } }`;

let user: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: { id: generateId(), handle: 'zoe', githubId: 4100, githubUsername: 'zoe', name: 'Zoe' },
  });
});

describe('authContext e2e through the executable schema', () => {
  it('resolves a user-key principal with the exact apiKey', async () => {
    const key = await db.userApiKey.create({
      data: {
        id: generateId(), userId: user.id, keyHash: generateId(), keyPreview: 'zz99',
        label: 'l', createdBy: user.id, issuedVia: 'portal', oauthScopes: [],
      },
    });
    const r = await run(QUERY, { userId: user.id, apiKeyId: key.id, roles: ['READER'] });
    expect(r.errors).toBeUndefined();
    expect(r.data?.authContext).toMatchObject({
      principalType: 'USER',
      appId: null,
      agentId: null,
      user: { id: user.id },
      apiKey: { id: key.id, keyPreview: 'zz99', revokedAt: null },
    });
  });

  it('resolves an app principal (appId set, user/apiKey null)', async () => {
    const r = await run(QUERY, { appId: 'app-xyz', roles: [] });
    expect(r.errors).toBeUndefined();
    expect(r.data?.authContext).toMatchObject({
      principalType: 'APP', appId: 'app-xyz', agentId: null, user: null, apiKey: null,
    });
  });

  it('returns null for an unauthenticated request', async () => {
    const r = await run(QUERY, { roles: [] });
    expect(r.errors).toBeUndefined();
    expect(r.data?.authContext).toBeNull();
  });
});
