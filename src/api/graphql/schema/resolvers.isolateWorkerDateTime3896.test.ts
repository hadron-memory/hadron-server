/**
 * #3896 (refs #3630, #3606; governing spec cor:agt:080:29, FIT 6781821347): the deprecated isolateWorker door over the REAL
 * schema. The direct-resolver test in resolvers.s7Retirement3606.test.ts calls the resolver with a raw string, so it only proves
 * the resolver never parses `until`. On the wire a variable that does not coerce to DateTime is refused by GraphQL before the
 * resolver runs, so nothing is written. The valid-timestamp control reaches the resolver's WORKER_ISOLATION_UNAVAILABLE.
 * The corpus names no code for a scalar coercion failure; this pins the shape the server serves today, not a spec'd code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const MUTATION = `mutation Isolate($workerRef: String!, $until: DateTime) {
  isolateWorker(workerRef: $workerRef, until: $until) { pausedUntil }
}`;
let appId: string, targetId: string, adminId: string;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Isolate', urn: 'isolate3896.test' } });
  adminId = (await db.user.create({ data: { id: generateId(), handle: 'iso-admin' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Engineer', urn: 'isolate3896.test:engineer' } });
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'isolate3896.test:team' } })).id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  targetId = (await db.worker.create({ data: { appId, agentId: agent.id, name: 'Target', slug: 'target', signature: '', trailer: '', heldByUserId: adminId } })).id;
});

async function run(resolverMap: unknown, until: unknown) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers: resolverMap as never });
  await server.start();
  try {
    const res = await server.executeOperation({ query: MUTATION, variables: { workerRef: targetId, until } }, { contextValue: ctx(adminId) });
    if (res.body.kind !== 'single') throw new Error('single result required');
    return res.body.singleResult;
  } finally { await server.stop(); }
}
const writes = async () => ({
  settings: await db.workerWakeSettings.count({ where: { workerId: targetId } }),
  events: await db.agentTeamEvent.count({ where: { appId } }),
});

describe('isolateWorker DateTime coercion over the real schema (#3896)', () => {
  it('a malformed DateTime variable is refused by GraphQL before the resolver runs, with no write or event', async () => {
    const before = await writes();
    const spy = vi.spyOn((resolvers.Mutation as any), 'isolateWorker');
    try {
      const result = await run(resolvers, 'not-a-date');
      expect(result.data).toBeUndefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]!.extensions?.code).toBe('BAD_USER_INPUT');
      expect(result.errors![0]!.message).toMatch(/Variable "\$until" got invalid value "not-a-date"/);
      expect(result.errors![0]!.extensions?.code).not.toBe('WORKER_ISOLATION_UNAVAILABLE');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(await writes()).toEqual(before);
  });

  it('a non-string DateTime variable is refused the same way, before the resolver', async () => {
    const before = await writes();
    const result = await run(resolvers, 12345);
    expect(result.data).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]!.extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0]!.message).toMatch(/Variable "\$until" got invalid value 12345/);
    expect(await writes()).toEqual(before);
  });

  it('control: a valid timestamp reaches the resolver and its WORKER_ISOLATION_UNAVAILABLE refusal, still with no write or event', async () => {
    const before = await writes();
    const result = await run(resolvers, new Date(Date.now() + 60_000).toISOString());
    expect(result.data).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]!.extensions?.code).toBe('WORKER_ISOLATION_UNAVAILABLE');
    expect(await writes()).toEqual(before);
  });
});
