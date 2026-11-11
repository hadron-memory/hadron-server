/**
 * #3865 — `Worker.availability` (the `worker get` JSON surface): the same stored record the roster row
 * carries, behind the worker-internals gate (cor:agt:060:02).
 */

import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let agentId: string;
let mia: { id: string };
let admin: { id: string };
let ned: { id: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Avail', urn: `avail-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 710_000 + n, githubUsername: `av-admin-${n}`, roles: ['READER'], handle: `av-admin-${n}` } });
  mia = await db.user.create({ data: { githubId: 720_000 + n, githubUsername: `av-mia-${n}`, roles: ['READER'], handle: `av-mia-${n}` } });
  ned = await db.user.create({ data: { githubId: 730_000 + n, githubUsername: `av-ned-${n}`, roles: ['READER'], handle: `av-ned-${n}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `avail-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: ned.id, role: 'member' } });
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

let outsider: { id: string };
beforeEach(async () => {
  const n = Math.floor(Math.random() * 1_000_000);
  outsider = await db.user.create({ data: { githubId: 740_000 + n, githubUsername: `av-out-${n}`, roles: ['READER'], handle: `av-out-${n}` } });
});

async function workerGet(name: string, as: string) {
  const result = await server.executeOperation(
    { query: `{ worker(ref: "${w[name].id}") { name availability { state reason setAt setBy inEffect setByParty { kind name } } } }` },
    { contextValue: ctx(as) },
  );
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  return result.body.singleResult;
}
const record = (name: string, data: Record<string, unknown>) =>
  db.workerAvailability.create({ data: { workerId: w[name].id, state: 'unavailable', setAt: ago(60), setBy: 'stall-rule', ...data } as any });

describe('#3865 Worker.availability (worker get JSON)', () => {
  it('carries reason, setter and set-at for a participant; null for a worker with no record', async () => {
    const setAt = ago(31 * 60);
    await record('Rook', { reason: 'stalled', setAt });
    const r = await workerGet('Rook', mia.id);
    expect(r.errors).toBeUndefined();
    expect((r.data as any).worker.availability).toMatchObject({ state: 'UNAVAILABLE', reason: 'STALLED', setBy: 'STALL_RULE', setAt: setAt.toISOString(), inEffect: true, setByParty: null });
    expect(((await workerGet('Anne', mia.id)).data as any).worker.availability).toBeNull();
  });

  it('equals the roster row for the same worker (one record, one meaning), including a lapsed one', async () => {
    await record('Kit', { reason: 'other', until: ago(1), setBy: 'worker', setByWorkerId: w.Kit.id });
    const viaWorker = ((await workerGet('Kit', mia.id)).data as any).worker.availability;
    expect(viaWorker).toMatchObject({ reason: 'OTHER', inEffect: false, setByParty: { kind: 'WORKER', name: 'Kit' } });
    const roster = await server.executeOperation(
      { query: `{ teamRoster(appRef: "${app.id}") { workers { worker { name } availability { state reason setAt setBy inEffect setByParty { kind name } } } } }` },
      { contextValue: ctx(mia.id) },
    );
    if (roster.body.kind !== 'single') throw new Error('unexpected incremental result');
    expect(roster.body.singleResult.errors).toBeUndefined();
    const row = (roster.body.singleResult.data as any).teamRoster.workers.find((e: any) => e.worker.name === 'Kit');
    expect(row.availability).toEqual(viaWorker);
  });

  it('is null for a signed-in reader who is not an App participant (the profile stays readable, the record does not)', async () => {
    await record('Rook', { reason: 'stalled' });
    const r = await workerGet('Rook', outsider.id);
    expect(r.errors).toBeUndefined();
    expect((r.data as any).worker).toMatchObject({ name: 'Rook', availability: null });
  });

  it('a worker list costs one availability read and one activity aggregate, and inEffect follows each worker\'s own activity', async () => {
    await record('Anne', { reason: 'other' });
    await record('Kit', { reason: 'stalled', setAt: ago(60) }); // no session: the stall mark stands
    await record('Rook', { reason: 'stalled', setAt: ago(60) }); // acted since the mark: it no longer stands
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.Rook.id, agentId, userId: mia.id, family: 'claude', startedAt: ago(10), updatedAt: ago(10) } });
    const spy = vi.spyOn(db, '$queryRaw');
    const find = vi.spyOn((db as any).workerAvailability, 'findMany');
    const result = await server.executeOperation(
      { query: `{ workers(appRef: "${app.id}") { items { name availability { state inEffect } } } }` },
      { contextValue: ctx(mia.id) },
    );
    if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
    expect(result.body.singleResult.errors).toBeUndefined();
    const byName = Object.fromEntries((result.body.singleResult.data as any).workers.items.map((i: any) => [i.name, i.availability?.inEffect]));
    expect(byName).toEqual({ Anne: true, Kit: true, Rook: false });
    expect(find).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    find.mockRestore();
  });
});
