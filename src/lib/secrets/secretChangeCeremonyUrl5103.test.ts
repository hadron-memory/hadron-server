/**
 * #5103 (cor:sec:070:02): `SecretChangeRequest.ceremonyUrl`. A request read later by its requester carries the same link the
 * `SECRET_PROTECTED_NEEDS_PASSKEY` extension handed over, minted by one helper, on every state, and only behind the
 * requester-only read: anyone else still gets the missing-request answer. Real database and a real Apollo execution.
 */
import { ApolloServer } from '@apollo/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { upsertPlatformActions } from '../grants/actions.js';
import { getProjectBaseUrl } from '../baseUrl.js';
import { secretChangeCeremonyUrl } from './changeRequests.js';

let userId: string, otherId: string, appId: string, secretId: string;
const ctxOf = (id: string) => ({ db, userId: id, roles: [] } as unknown as Context);
const api = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
const QUERY = 'query($id: ID!){ secretChangeRequest(id: $id){ id state ceremonyUrl } }';
async function read(id: string, as: string) {
  const r = await api.executeOperation({ query: QUERY, variables: { id } }, { contextValue: ctxOf(as) });
  if (r.body.kind !== 'single') throw new Error('unexpected response kind');
  return r.body.singleResult;
}
async function stage() {
  const e = await resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged' }, ctxOf(userId)).then(() => { throw new Error('expected refusal'); }, (x: unknown) => x as { extensions: { requestId: string; ceremonyUrl: string } });
  return { id: e.extensions.requestId as string, url: e.extensions.ceremonyUrl as string };
}

beforeAll(async () => { await api.start(); });
beforeEach(async () => {
  process.env.SECRET_ROOT_KEY = '33'.repeat(32); process.env.PASSKEY_SIGNING_ENABLED = 'true';
  process.env.PASSKEY_RP_ID = 'localhost'; process.env.SIGNING_CEREMONY_ORIGINS = 'http://localhost:4000';
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@c5103.test` } })).id;
  otherId = (await db.user.create({ data: { email: `${generateId()}@c5103.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'C5103', urn: `${generateId().toLowerCase()}:c5103` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctxOf(userId))).id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
});

describe('#5103 SecretChangeRequest.ceremonyUrl', () => {
  it('equals the link in the SECRET_PROTECTED_NEEDS_PASSKEY extension for the same request, and is the shared helper\'s value', async () => {
    const { id, url } = await stage();
    const got = await read(id, userId);
    expect(got.errors).toBeUndefined();
    expect(got.data).toEqual({ secretChangeRequest: { id, state: 'open', ceremonyUrl: url } });
    expect(url).toBe(secretChangeCeremonyUrl(id));
    expect(url).toBe(`${getProjectBaseUrl()}/secret-changes/${id}`);
  });

  it.each(['withdrawn', 'declined', 'completed', 'stale', 'expired'])('is served on a %s request too (the page, not the field, refuses)', async (state) => {
    const { id, url } = await stage();
    await db.$executeRaw`UPDATE secret_change_requests SET state=${state}, ended_at=now() WHERE id=${id}`;
    const got = await read(id, userId);
    expect(got.data).toEqual({ secretChangeRequest: { id, state, ceremonyUrl: url } });
  });

  it('shows nothing to anyone else: the answer for another person equals the answer for a missing request', async () => {
    const { id } = await stage();
    const other = await read(id, otherId);
    const missing = await read(generateId(), otherId);
    expect(other).toEqual(missing);
    expect(other.data).toEqual({ secretChangeRequest: null });
  });

  it('the URL carries no token: the server origin, the fixed path and the id only', async () => {
    const { id, url } = await stage();
    expect(new URL(url).search).toBe('');
    expect(url.endsWith(`/secret-changes/${id}`)).toBe(true);
  });
});
