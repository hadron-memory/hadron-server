import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #2278 — roster model metadata uses the existing batched binding fold. */

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
    expect(await F.Worker.modelGroups({ id: w.Anne.id, appId: app.id }, {}, ctx(mia.id))).toEqual(['all', 'custom']);
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
});
