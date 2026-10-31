import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const READ = `query { rateLimitPolicies { fieldClass principalLimit keyLimit ipLimit windowSeconds retentionSeconds enforcementMode version } }`;
const SET = `mutation($input: SetRateLimitPolicyInput!) { setRateLimitPolicy(input:$input) { fieldClass principalLimit keyLimit ipLimit enforcementMode version } }`;
let userId: string;
async function gql(query: string, input?: unknown, extra: Partial<Context> = {}) {
  const r = await server.executeOperation({ query, variables: input ? { input } : undefined },
    { contextValue: { db, userId, roles: ['ADMIN'], ...extra } as Context });
  if (r.body.kind !== 'single') throw new Error('single response required');
  return r.body.singleResult;
}
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { id: generateId(), githubId: 179300, githubUsername: 'rate-admin', roles: ['ADMIN'] } })).id;
});
describe('#1793 admin policy contract', () => {
  it('deploys five configured classes LOG_ONLY without public counters', async () => {
    const r = await gql(READ);
    expect(r.errors).toBeUndefined();
    const rows = (r.data as any).rateLimitPolicies;
    expect(rows).toHaveLength(5);
    expect(rows.every((p: any) => p.enforcementMode === 'LOG_ONLY')).toBe(true);
    expect(rows.find((p: any) => p.fieldClass === 'FAN_OUT_READS')).toMatchObject({ principalLimit: 300, keyLimit: 120, ipLimit: 600, windowSeconds: 60, retentionSeconds: 86400 });
  });
  it('null mode preserves and a no-op never bumps version; a stale writer conflicts', async () => {
    const initial = await gql(READ);
    expect(initial.errors).toBeUndefined();
    const p = (initial.data as any).rateLimitPolicies.find((p: any) => p.fieldClass === 'FAN_OUT_READS');
    const input = { fieldClass: p.fieldClass, expectedVersion: p.version, principalLimit: p.principalLimit, keyLimit: p.keyLimit, ipLimit: p.ipLimit, enforcementMode: null, changeReference: 'test review' };
    const noop = await gql(SET, input);
    expect(noop.errors).toBeUndefined();
    expect((noop.data as any).setRateLimitPolicy).toMatchObject({ enforcementMode: 'LOG_ONLY', version: p.version });
    const changed = await gql(SET, { ...input, principalLimit: 2, enforcementMode: 'ENFORCING' });
    expect(changed.errors).toBeUndefined();
    expect((changed.data as any).setRateLimitPolicy).toMatchObject({ principalLimit: 2, enforcementMode: 'ENFORCING', version: p.version + 1 });
    expect((await gql(SET, input)).errors?.[0].extensions?.code).toBe('CONFLICT');
  });
  it.each([{ appId: 'not-a-human' }, { sessionId: 'bound' }, { clientId: 'run:untrusted' }])('denies non-human admin context %j before policy reads', async extra => {
    const r = await gql(READ, undefined, extra);
    expect(r.errors?.[0].extensions?.code).toBe('FORBIDDEN');
  });
});
