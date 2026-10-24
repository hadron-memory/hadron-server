/**
 * #2403 — updateApp refuses a non-positive sessionTimeoutSeconds. A stamped session expiry is a promise
 * (cor:agt:020:03), so a ceiling of 0 or less would make it already past at creation. Only `<= 0` is refused:
 * no floor or cap exists (a range is a product ruling), and createApp / startAgentSession are separate doors.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
let admin: { id: string };
let member: { id: string };
let app: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
async function update(userId: string, args: Record<string, unknown>) {
  const out = await server.executeOperation(
    {
      query: `mutation($ref: ID!, $t: Int, $d: String) { updateApp(ref: $ref, sessionTimeoutSeconds: $t, description: $d) { id sessionTimeoutSeconds } }`,
      variables: { ref: app.id, ...args },
    },
    { contextValue: ctx(userId) },
  );
  if (out.body.kind !== 'single') throw new Error('incremental response');
  return out.body.singleResult;
}
const stored = async () => db.app.findUniqueOrThrow({ where: { id: app.id }, select: { sessionTimeoutSeconds: true, description: true } });

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({ data: { githubId: 240301, githubUsername: 'timeout-admin' } });
  member = await db.user.create({ data: { githubId: 240302, githubUsername: 'timeout-member' } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'timeout', urn: `timeout-${generateId()}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'READER' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'timeout', urn: `${org.urn}:timeout` } });
});

describe('#2403 updateApp sessionTimeoutSeconds', () => {
  it.each([0, -1, -900])('refuses %i with BAD_USER_INPUT and persists nothing', async (t) => {
    const out = await update(admin.id, { t, d: 'must not land' });
    expect(out.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(await stored()).toEqual({ sessionTimeoutSeconds: 900, description: null });
  });

  it.each([1, 900])('accepts %i', async (t) => {
    const out = await update(admin.id, { t });
    expect(out.errors).toBeUndefined();
    expect((await stored()).sessionTimeoutSeconds).toBe(t);
  });

  it('omitted preserves the stored value', async () => {
    await db.app.update({ where: { id: app.id }, data: { sessionTimeoutSeconds: 1234 } });
    const out = await update(admin.id, { d: 'only the description' });
    expect(out.errors).toBeUndefined();
    expect(await stored()).toEqual({ sessionTimeoutSeconds: 1234, description: 'only the description' });
  });

  it('a non-admin member is refused by the existing gate, not by validation, for a valid and an invalid value', async () => {
    const valid = await update(member.id, { t: 60 });
    const invalid = await update(member.id, { t: 0 });
    expect(valid.errors?.[0]?.message).toBeTruthy();
    expect(invalid.errors?.[0]?.extensions?.code).toBe(valid.errors?.[0]?.extensions?.code);
    expect(invalid.errors?.[0]?.message).toBe(valid.errors?.[0]?.message);
    expect(invalid.errors?.[0]?.extensions?.code).not.toBe('BAD_USER_INPUT');
    expect((await stored()).sessionTimeoutSeconds).toBe(900);
  });
});
