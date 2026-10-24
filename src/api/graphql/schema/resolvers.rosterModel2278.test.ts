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
const fields = 'worker { id name } model modelReportedAt tier family bound liveSession state freeForWork';
async function projected(userId = mia.id) {
  const result = await server.executeOperation({ query: `{ teamRoster(appRef: "${app.id}") { workers { ${fields} } } }` }, { contextValue: ctx(userId) });
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  return result.body.singleResult;
}
async function session(name: string, data: Record<string, unknown> = {}) {
  return db.session.create({ data: { id: generateId(), appId: app.id, workerId: w[name].id, agentId, userId: mia.id, family: 'claude', startedAt: ago(1), updatedAt: ago(1), ...data } });
}

describe('#2278 roster binding model scalars', () => {
  it('exposes real GraphQL scalars with Worker parity and retains a quiet binding report time', async () => {
    const reported = ago(60 * 24 * 30);
    await session('Kit', { llmModel: 'claude-sonnet-4-6', modelReportedAt: reported, startedAt: reported, updatedAt: reported });
    await session('Anne', { llmModel: 'unknown-model', modelReportedAt: reported });
    const result = await projected();
    expect(result.errors).toBeUndefined();
    const rows = (result.data as any).teamRoster.workers;
    expect(rows.map((r: any) => r.worker.name)).toEqual(['Anne', 'Kit', 'Rook']);
    const kit = rows.find((r: any) => r.worker.name === 'Kit');
    expect(kit).toMatchObject({ model: 'claude-sonnet-4-6', modelReportedAt: reported.toISOString(), tier: 'mid', family: 'claude', bound: true, liveSession: false, state: 'AVAILABLE', freeForWork: true });
    expect(rows.find((r: any) => r.worker.name === 'Anne')).toMatchObject({ model: 'unknown-model', tier: null, modelReportedAt: reported.toISOString() });
    expect(rows.find((r: any) => r.worker.name === 'Rook')).toMatchObject({ model: null, modelReportedAt: null, tier: null, bound: false });
    for (const name of ['Kit', 'Anne']) {
      const worker = { id: w[name].id, appId: app.id };
      const row = rows.find((r: any) => r.worker.name === name);
      expect(row.model).toEqual(await F.Worker.model(worker, {}, ctx(mia.id)));
      expect(row.tier).toEqual(await F.Worker.tier(worker, {}, ctx(mia.id)));
      expect(row.modelReportedAt).toEqual((await F.Worker.modelReportedAt(worker, {}, ctx(mia.id)))?.toISOString());
    }
  });

  it('uses the same newest-open tie break, suppresses older reports on a newer NULL and ignores ended/deleted rows', async () => {
    const same = ago(5);
    const first = await session('Kit', { startedAt: same, llmModel: 'claude-opus-4-6', modelReportedAt: same });
    const second = await session('Kit', { startedAt: same, llmModel: 'claude-haiku-4-5', modelReportedAt: ago(2) });
    let rows = (await Q.teamRoster({}, { appRef: app.id }, ctx(mia.id))).workers;
    expect(rows.find((r: any) => r.name === 'Kit').model).toBe(first.id > second.id ? first.llmModel : second.llmModel);
    await session('Kit', { startedAt: ago(1), llmModel: null, modelReportedAt: null, family: null });
    await session('Kit', { startedAt: new Date(), llmModel: 'claude-opus-4-6', modelReportedAt: new Date(), endedAt: new Date() });
    await session('Kit', { startedAt: new Date(), llmModel: 'claude-opus-4-6', modelReportedAt: new Date(), deletedAt: new Date() });
    await session('Anne', { endedAt: new Date(), llmModel: 'claude-opus-4-6', modelReportedAt: same });
    const result = await projected();
    expect(result.errors).toBeUndefined();
    rows = (result.data as any).teamRoster.workers;
    expect(rows.find((r: any) => r.worker.name === 'Kit')).toMatchObject({ model: null, modelReportedAt: null, tier: null, family: null, bound: true });
    expect(rows.find((r: any) => r.worker.name === 'Anne')).toMatchObject({ model: null, modelReportedAt: null, tier: null, bound: false });
  });

  it('keeps activity reads batched as the roster grows and preserves existing decisions', async () => {
    await session('Kit', { llmModel: 'claude-opus-4-6', modelReportedAt: ago(1) });
    let activityQueries = 0;
    const traced = db.$extends({ query: { $allOperations: async ({ args, operation, query }) => {
      if (operation === '$queryRaw' && JSON.stringify(args).includes('bindingModel')) activityQueries++;
      return query(args);
    } } });
    const before = await Q.teamRoster({}, { appRef: app.id }, { ...ctx(mia.id), db: traced });
    // Existing roster-state and check-status loaders each batch activity; no per-worker read.
    expect(activityQueries).toBe(2);
    activityQueries = 0;
    const extra = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Extra', slug: 'extra', heldByUserId: mia.id } });
    const grown = await Q.teamRoster({}, { appRef: app.id }, { ...ctx(mia.id), db: traced });
    expect(grown.workers).toHaveLength(before.workers.length + 1);
    expect(activityQueries).toBe(2);
    await db.worker.delete({ where: { id: extra.id } });
    const decisions = (rows: any[]) => rows.map(({ workerId, family, state, free, liveSession, bound }) => ({ workerId, family, state, free, liveSession, bound }));
    await db.session.updateMany({ where: { workerId: w.Kit.id }, data: { llmModel: 'unknown-model', modelReportedAt: ago(2) } });
    const after = await Q.teamRoster({}, { appRef: app.id }, ctx(mia.id));
    expect(decisions(after.workers)).toEqual(decisions(before.workers));
  });

  it('retains roster refusal for a nonparticipant', async () => {
    const result = await projected(outsider.id);
    expect(result.errors?.[0].extensions?.code).toBe('APP_NOT_FOUND');
    expect(result.data).toBeNull();
  });
});
