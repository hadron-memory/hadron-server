/** #2061 — composition is a closed projection of the roster, not another worker read surface. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { assertObjectType, buildASTSchema, parse } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import * as rosterLoader from '../../../lib/agentTasks/roster.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
let appId: string, memberId: string, outsiderId: string;
const ids: Record<string, string> = {};
const party = 'kind id name urn';
const composition = `query($app: ID!) { teamComposition(appRef: $app) { appId asOf lanes {
  coordinator { ${party} } coordinatorRetired
  workers { worker { ${party} } role family bound liveSession state }
  countsByRole { role count } countsByRoleFamily { role family count }
} } }`;
async function query(query: string, userId = memberId, app = appId) {
  const result = await server.executeOperation({ query, variables: { app } }, { contextValue: ctx(userId) });
  if (result.body.kind !== 'single') throw new Error('Expected single GraphQL result');
  return result.body.singleResult;
}
beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Composition', urn: `composition-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 810_000_000 + n, githubUsername: `composition-admin-${n}`, roles: ['READER'] } });
  const member = await db.user.create({ data: { githubId: 820_000_000 + n, githubUsername: `composition-member-${n}`, roles: ['READER'] } });
  const outsider = await db.user.create({ data: { githubId: 830_000_000 + n, githubUsername: `composition-outsider-${n}`, roles: ['READER'] } });
  memberId = member.id; outsiderId = outsider.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Composition Agent' }, ctx(admin.id));
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Composition', urn: `composition-${n}.example:team` } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
  for (const [name, role] of [['Alpha', 'coordinator'], ['beta', 'coordinator'], ['Charlie', 'coordinator'], ['Alice', 'engineer'], ['Andy', 'engineer'], ['Bea', 'saas-pm'], ['Ben', null], ['Cora', 'engineer'], ['Unassigned', null], ['Retired', 'engineer']] as const) {
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name, slug: name.toLowerCase(), role, heldByUserId: memberId } });
    ids[name] = worker.id;
  }
  for (const [name, head] of [['Alice', 'Alpha'], ['Andy', 'Alpha'], ['Bea', 'beta'], ['Ben', 'beta'], ['Cora', 'Charlie'], ['Retired', 'Alpha'], ['beta', 'Alpha']] as const) {
    await db.worker.update({ where: { id: ids[name] }, data: { reportsToWorkerId: ids[head] } });
  }
  await db.worker.updateMany({ where: { id: { in: [ids.Charlie, ids.Retired] } }, data: { retiredAt: new Date() } });
  for (const [name, family] of [['Alice', 'codex'], ['Andy', 'claude'], ['Bea', 'codex'], ['Ben', null]] as const) {
    await db.session.create({ data: { id: generateId(), appId, workerId: ids[name], agentId: agent.id, family } });
  }
});

describe('#2061 teamComposition', () => {
  it('groups direct reports and matches a hand join of roster rows, with plain role/family headcounts', async () => {
    const result = await query(composition);
    expect(result.errors).toBeUndefined();
    const data = (result.data as any).teamComposition;
    expect(data.appId).toBe(appId);
    expect(Number.isNaN(Date.parse(data.asOf))).toBe(false);
    const roster = await query(`query($app: ID!) { teamRoster(appRef: $app) { workers { worker { ${party} } role family bound liveSession state reportsTo { ${party} } reportsToRetired } } }`);
    expect(roster.errors).toBeUndefined();
    const rows = (roster.data as any).teamRoster.workers as any[];
    expect(data.lanes.map((l: any) => l.coordinator?.name ?? null)).toEqual(['Alpha', 'beta', 'Charlie', null]);
    const flat = data.lanes.flatMap((l: any) => l.workers.map((w: any) => w.worker.id));
    expect(flat.sort()).toEqual(rows.map(r => r.worker.id).sort());
    expect(flat).not.toContain(ids.Retired);
    expect(flat).not.toContain(ids.Charlie);
    for (const lane of data.lanes) {
      const expected = rows.filter(r => (r.reportsTo?.id ?? null) === (lane.coordinator?.id ?? null));
      expect(lane.workers).toEqual(expected.map(({ reportsTo, reportsToRetired, ...row }) => row));
      const roles = new Map<string | null, number>();
      const families = new Map<string, number>();
      for (const row of expected) {
        roles.set(row.role, (roles.get(row.role) ?? 0) + 1);
        const key = JSON.stringify([row.role, row.family]);
        families.set(key, (families.get(key) ?? 0) + 1);
      }
      expect(new Map(lane.countsByRole.map((c: any) => [c.role, c.count]))).toEqual(roles);
      expect(new Map(lane.countsByRoleFamily.map((c: any) => [JSON.stringify([c.role, c.family]), c.count]))).toEqual(families);
    }
    const retired = data.lanes.find((l: any) => l.coordinator?.id === ids.Charlie);
    expect(retired.coordinatorRetired).toBe(true);
    expect(retired.coordinator).toMatchObject({ kind: 'WORKER', id: ids.Charlie, name: 'Charlie', urn: expect.stringMatching(/^hrn:worker:/) });
    expect(data.lanes.filter((l: any) => !l.coordinator)).toHaveLength(1);
    const beta = data.lanes.find((l: any) => l.coordinator?.id === ids.beta);
    expect(beta.countsByRole).toEqual([{ role: 'saas-pm', count: 1 }, { role: null, count: 1 }]);
    expect(beta.countsByRoleFamily).toEqual([{ role: 'saas-pm', family: 'codex', count: 1 }, { role: null, family: null, count: 1 }]);
    expect(retired.workers[0]).toMatchObject({ bound: false, liveSession: false, family: null });
  });

  it('uses the exact roster refusal for nonparticipants, missing Apps, and foreign App credentials', async () => {
    for (const [userId, ref] of [[outsiderId, appId], [memberId, generateId()]] as const) {
      const roster = await query('query($app: ID!) { teamRoster(appRef: $app) { appId } }', userId, ref);
      const composed = await query(composition, userId, ref);
      expect(composed.errors?.map(e => ({ message: e.message, code: e.extensions?.code })))
        .toEqual(roster.errors?.map(e => ({ message: e.message, code: e.extensions?.code })));
      expect(composed.errors?.[0].extensions?.code).toBe('APP_NOT_FOUND');
    }
    const foreignCtx: Context = { db, roles: ['READER'], appId: generateId(), appKeyId: generateId() };
    const Q = resolvers.Query as any;
    const errors = [];
    for (const name of ['teamRoster', 'teamComposition']) {
      const error = await Q[name]({}, { appRef: appId }, foreignCtx).catch((e: any) => e);
      expect(error.extensions?.code).toBe('APP_NOT_FOUND');
      errors.push({ message: error.message, code: error.extensions.code });
    }
    expect(errors[1]).toEqual(errors[0]);
  });

  it('has a closed composition worker surface and only sanitized parties', () => {
    const schema = buildASTSchema(parse(typeDefs));
    expect(Object.keys(assertObjectType(schema.getType('TeamCompositionWorker')).getFields()).sort())
      .toEqual(['bound', 'family', 'liveSession', 'role', 'state', 'worker']);
    expect(Object.keys(assertObjectType(schema.getType('AgentTaskParty')).getFields()).sort())
      .toEqual(['id', 'kind', 'name', 'urn']);
  });

  it('resolves an App URN and takes one roster load inside one RepeatableRead transaction', async () => {
    const app = await db.app.findUniqueOrThrow({ where: { id: appId }, select: { urn: true } });
    const load = vi.spyOn(rosterLoader, 'loadTeamRoster');
    const transaction = vi.spyOn(db, '$transaction');
    try {
      const result = await query(composition, memberId, `hrn:app:${app.urn}`);
      expect(result.errors).toBeUndefined();
      expect((result.data as any).teamComposition.appId).toBe(appId);
      expect(load).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead', timeout: 20_000 });
      expect(Object.is(load.mock.calls[0][0], db)).toBe(false);
      expect(load.mock.calls[0][1]).toBe(appId);
    } finally {
      load.mockRestore(); transaction.mockRestore();
    }
  });

  it('returns no lanes for an empty team', async () => {
    await db.worker.updateMany({ where: { appId }, data: { retiredAt: new Date() } });
    const result = await query(composition);
    expect(result.errors).toBeUndefined();
    expect((result.data as any).teamComposition.lanes).toEqual([]);
  });
});
