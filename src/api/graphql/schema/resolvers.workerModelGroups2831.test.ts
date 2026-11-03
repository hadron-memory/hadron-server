import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #2831 S3 — live model-group membership uses the existing binding fold and audiences. */

import { GraphQLError } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let appUrn: string;
let agentId: string;
let admin: { id: string };
let mia: { id: string };
let outsider: { id: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Roster', urn: `roster-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 610_000 + n, githubUsername: `ro-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 620_000 + n, githubUsername: `ro-mia-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 630_000 + n, githubUsername: `ro-out-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  appUrn = `roster-${n}.example:team`;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: appUrn }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  for (const name of ['Anne', 'Rook', 'Kit']) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: mia.id },
      select: { id: true },
    });
  }
});

const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());
const fields = 'worker { id name } model modelGroups';
async function projected(userId = mia.id) {
  const result = await server.executeOperation({ query: `{ teamRoster(appRef: "${app.id}") { workers { ${fields} } } }` }, { contextValue: ctx(userId) });
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  return result.body.singleResult;
}
async function session(name: string, data: Record<string, unknown> = {}) {
  return db.session.create({ data: { id: generateId(), appId: app.id, workerId: w[name].id, agentId, userId: mia.id, family: 'claude', startedAt: ago(1), updatedAt: ago(1), ...data } });
}

describe('#2831 S3 current model groups', () => {
  const group = (name: string, patterns: string[]) => db.modelGroup.create({ data: { appId: app.id, name, patterns } });
  it('reports every matching group on Worker and roster, independent of model family/tier', async () => {
    await group('custom', ['unknown-?odel']);
    await group('all', ['*']);
    await group('anchored', ['known-*']);
    await session('Anne', { llmModel: 'unknown-model' });
    const result = await projected();
    expect(result.errors).toBeUndefined();
    const rows = (result.data as any).teamRoster.workers;
    expect(rows.find((r: any) => r.worker.name === 'Anne').modelGroups).toEqual(['all', 'custom']);
    expect(rows.find((r: any) => r.worker.name === 'Kit').modelGroups).toEqual([]);
    const wire = await server.executeOperation({ query: `{ worker(ref: "${w.Anne.id}") { modelGroups } }` }, { contextValue: ctx(mia.id) });
    if (wire.body.kind !== 'single') throw new Error('unexpected incremental result');
    expect(wire.body.singleResult.errors).toBeUndefined();
    expect((wire.body.singleResult.data as any).worker.modelGroups).toEqual(['all', 'custom']);
    expect(await F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(mia.id))).toEqual(['all', 'custom']);
  });

  it('normalizes supported writes and exposes only the existing participant inputs', async () => {
    await M.setAppModelGroup({}, { appRef: app.id, name: 'Custom', patterns: [' MODEL-* '] }, ctx(admin.id));
    await session('Anne', { llmModel: 'model-one' });
    const visible = await Q.effectiveModelGroups({}, { appRef: app.id }, ctx(mia.id));
    expect(visible).toEqual([{ name: 'custom', patterns: ['model-*'], origin: 'APP' }]);
    expect((await projected()).errors).toBeUndefined();
    expect(((await projected()).data as any).teamRoster.workers[0]).toMatchObject({ model: 'model-one', modelGroups: ['custom'] });
    await expect(Q.effectiveModelGroups({}, { appRef: app.id }, ctx(outsider.id))).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    expect((await projected(outsider.id)).errors?.[0].extensions?.code).toBe('APP_NOT_FOUND');
    expect(await F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(outsider.id))).toBeNull();
  });

  it('reads live App overrides and Team Agent edits without copying groups', async () => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    await db.node.create({ data: { memoryId: agent.systemMemoryId!, loc: 'roles:engineer', name: 'engineer', content: '' } });
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    await db.modelGroup.create({ data: { agentId, name: 'inherited', patterns: ['model-*'] } });
    await db.modelGroup.create({ data: { agentId, name: 'disabled', patterns: ['*'] } });
    await group('disabled', []);
    await session('Anne', { llmModel: 'model-one' });
    const read = () => F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(mia.id));
    expect(await read()).toEqual(['inherited']);
    await db.modelGroup.updateMany({ where: { agentId, name: 'inherited' }, data: { patterns: ['other-*'] } });
    expect(await read()).toEqual([]);
    await group('inherited', ['model-*']);
    expect(await read()).toEqual(['inherited']);
  });

  it('uses newest open binding including quiet sessions and a newer missing report', async () => {
    await group('chosen', ['model-*']);
    const old = await session('Anne', { llmModel: 'model-old', startedAt: ago(10000), updatedAt: ago(10000) });
    const read = () => F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(mia.id));
    expect(await read()).toEqual(['chosen']);
    await db.session.update({ where: { id: old.id }, data: { llmModel: 'other' } });
    expect(await read()).toEqual([]);
    await session('Anne', { llmModel: null });
    await session('Anne', { llmModel: 'model-ended', startedAt: new Date(), endedAt: new Date() });
    expect(await read()).toEqual([]);
  });

  it('keeps Worker working-state denial and roster admission', async () => {
    await group('secret', ['*']);
    await session('Anne', { llmModel: 'model' });
    expect(await F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(outsider.id))).toBeNull();
    expect((await projected(outsider.id)).errors?.[0].extensions?.code).toBe('APP_NOT_FOUND');
  });
  it('batches group reads across Worker query fields and re-reads mutations', async () => {
    await group('all', ['*']);
    await session('Anne', { llmModel: 'model' });
    await session('Kit', { llmModel: 'model' });
    let reads = 0;
    const traced = db.$extends({ query: { modelGroup: { findMany: async ({ args, query }) => { reads++; return query(args); } } } });
    const c = { ...ctx(mia.id), db: traced as unknown as Context['db'] };
    const worker = (name: string) => ({ id: w[name].id, appId: app.id });
    await Promise.all(['Anne', 'Kit'].map(name => F.Worker.modelGroups(worker(name), {}, c, { operation: { operation: 'query' } })));
    expect(reads).toBe(1); // No Team Agent installed: one App-list query for all workers.
    await db.modelGroup.deleteMany({ where: { appId: app.id } });
    expect(await F.Worker.modelGroups(worker('Anne'), {}, c, { operation: { operation: 'mutation' } })).toEqual([]);
    expect(reads).toBe(2);
  });

  it('never reads groups for a denied Worker, and never uses another App group', async () => {
    const spy = vi.spyOn(db.modelGroup, 'findMany');
    expect(await F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(outsider.id))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const other = await db.app.create({ data: { organizationId: (await db.app.findUniqueOrThrow({ where: { id: app.id } })).organizationId, name: 'Other', urn: `${appUrn}-other` } });
    await db.modelGroup.create({ data: { appId: other.id, name: 'wrong-app', patterns: ['*'] } });
    await session('Anne', { llmModel: 'model' });
    expect(await F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(mia.id))).toEqual([]);
  });

  it('uses one group resolution for roster growth and leaves work decisions untouched', async () => {
    await group('all', ['*']);
    await session('Anne', { llmModel: 'model' });
    let reads = 0;
    const traced = db.$extends({ query: { modelGroup: { findMany: async ({ args, query }) => { reads++; return query(args); } } } });
    const read = async () => {
      const c = { ...ctx(mia.id), db: traced as unknown as Context['db'] };
      const result = await Q.teamRoster({}, { appRef: app.id }, c);
      for (const row of result.workers) row.modelGroups = await F.TeamRosterEntry.modelGroups(row, {}, c, { operation: { operation: 'query' } });
      return result;
    };
    const before = await read();
    expect(reads).toBe(1);
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Extra', slug: 'extra', heldByUserId: mia.id } });
    const grown = await read();
    expect(reads).toBe(2);
    expect(grown.workers).toHaveLength(before.workers.length + 1);
    const decisions = (rows: any[]) => rows.map(({ workerId, family, state, free, liveSession, bound }) => ({ workerId, family, state, free, liveSession, bound }));
    await db.modelGroup.updateMany({ where: { appId: app.id }, data: { patterns: [] } });
    const after = await read();
    expect(decisions(after.workers)).toEqual(decisions(grown.workers));
    expect(after.workers.every((row: any) => row.modelGroups.length === 0)).toBe(true);
  });

  it('preserves the effective-group typed refusal for ambiguous Team Agents', async () => {
    for (const name of ['Team A', 'Team B']) {
      const agent = await M.createAgent({}, { orgId: (await db.app.findUniqueOrThrow({ where: { id: app.id } })).organizationId, name }, ctx(admin.id));
      await db.node.create({ data: { memoryId: agent.systemMemoryId, loc: 'roles:engineer', name: 'engineer', content: '' } });
      await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    }
    await session('Anne', { llmModel: 'model' });
    await expect(F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(mia.id))).rejects.toMatchObject({ extensions: { code: 'TEAM_AGENT_AMBIGUOUS' } });
    const result = await projected();
    expect(result.errors?.[0].extensions?.code).toBe('TEAM_AGENT_AMBIGUOUS');
    expect(result.errors?.[0].path).toEqual(['teamRoster', 'workers', 0, 'modelGroups']);
    expect((result.data as any).teamRoster.workers).toHaveLength(3);
    expect((result.data as any).teamRoster.workers[0].modelGroups).toBeNull();
  });

  it('keeps core roster and composition readable without selecting failing optional group metadata', async () => {
    await session('Anne', { llmModel: 'model' });
    let reads = 0;
    const traced = db.$extends({ query: { modelGroup: { findMany: async () => {
      reads++;
      throw new GraphQLError('test group lookup unavailable', { extensions: { code: 'GROUP_METADATA_TEST_UNAVAILABLE' } });
    } } } });
    const c = { ...ctx(mia.id), db: traced as unknown as Context['db'] };
    const result = await server.executeOperation({ query: `{ teamRoster(appRef: "${app.id}") { workers { worker { id name } model } } }` }, { contextValue: c });
    if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
    expect(result.body.singleResult.errors).toBeUndefined();
    expect((result.body.singleResult.data as any).teamRoster.workers).toHaveLength(3);
    await expect(Q.teamComposition({}, { appRef: app.id }, { ...ctx(mia.id), db: traced as unknown as Context['db'] })).resolves.toMatchObject({ appId: app.id });
    expect(reads).toBe(0);
  });

  it('reports a selected group lookup failure only on that nullable field, preserving the roster facts', async () => {
    await session('Anne', { llmModel: 'model' });
    const traced = db.$extends({ query: { modelGroup: { findMany: async () => {
      throw new GraphQLError('test group lookup unavailable', { extensions: { code: 'GROUP_METADATA_TEST_UNAVAILABLE' } });
    } } } });
    const result = await server.executeOperation({ query: `{ teamRoster(appRef: "${app.id}") { workers { worker { id name } model modelGroups } } }` }, { contextValue: { ...ctx(mia.id), db: traced as unknown as Context['db'] } });
    if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
    expect(result.body.singleResult.errors?.map(e => ({ code: e.extensions?.code, path: e.path }))).toEqual([
      { code: 'GROUP_METADATA_TEST_UNAVAILABLE', path: ['teamRoster', 'workers', 0, 'modelGroups'] },
    ]);
    expect((result.body.singleResult.data as any)?.teamRoster.workers).toEqual([
      { worker: { id: w.Anne.id, name: 'Anne' }, model: 'model', modelGroups: null },
      { worker: { id: w.Kit.id, name: 'Kit' }, model: null, modelGroups: [] },
      { worker: { id: w.Rook.id, name: 'Rook' }, model: null, modelGroups: [] },
    ]);
  });

});
