/**
 * #3865 — the roster row carries the worker's availability record (reason, who set it,
 * when), so "stale or deliberate" is answerable from the roster (cor:agt:060:02).
 * V67 regression: a STALLED mark clears with the worker's next Hadron call through its
 * session (cor:agt:060:11, cor:agt:050:12); a turn that makes no call clears nothing.
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
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Avail', urn: `avail-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 710_000 + n, githubUsername: `av-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 720_000 + n, githubUsername: `av-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `avail-${n}.example:team` }, select: { id: true } });
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

const fields = `worker { name } state freeForWork unavailableReason availability {
  state reason until setAt setBy inEffect setByParty { ... on Worker { name } ... on User { id } } }`;
const baseFields = 'worker { name } state freeForWork unavailableReason';
async function roster(selection = fields) {
  const result = await server.executeOperation({ query: `{ teamRoster(appRef: "${app.id}") { workers { ${selection} } } }` }, { contextValue: ctx(mia.id) });
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  expect(result.body.singleResult.errors).toBeUndefined();
  const rows = (result.body.singleResult.data as any).teamRoster.workers as any[];
  return (name: string) => rows.find((r) => r.worker.name === name);
}
async function record(name: string, data: Record<string, unknown>) {
  return db.workerAvailability.create({ data: { workerId: w[name].id, state: 'unavailable', setAt: ago(60), setBy: 'stall-rule', ...data } as any });
}

describe('#3865 roster availability provenance', () => {
  it('carries reason, setter and set-at for a worker with a record, and null for one without', async () => {
    const setAt = ago(31 * 60);
    await record('Rook', { reason: 'stalled', setAt, setBy: 'stall-rule' });
    await record('Kit', { reason: 'out-of-tokens', setAt: ago(5), setBy: 'worker', setByWorkerId: w.Kit.id });
    const row = await roster();
    expect(row('Rook').availability).toMatchObject({ state: 'UNAVAILABLE', reason: 'STALLED', setBy: 'STALL_RULE', setAt: setAt.toISOString(), inEffect: true, setByParty: null });
    expect(row('Kit').availability).toMatchObject({ reason: 'OUT_OF_TOKENS', setBy: 'WORKER', inEffect: true, setByParty: { name: 'Kit' } });
    expect(row('Anne').availability).toBeNull();
  });

  it('tells a stale mark from a deliberate one: both read the same reason, the setter differs', async () => {
    await record('Rook', { reason: 'other', setBy: 'holder', setByUserId: mia.id });
    await record('Kit', { reason: 'other', setBy: 'stall-rule' });
    const row = await roster();
    expect(row('Rook').availability.setBy).toBe('HOLDER');
    expect(row('Kit').availability.setBy).toBe('STALL_RULE');
    expect(row('Rook').unavailableReason).toBe(row('Kit').unavailableReason);
  });

  it('keeps a lapsed or cleared record visible but not in effect', async () => {
    await record('Rook', { reason: 'other', until: ago(1), setBy: 'worker', setByWorkerId: w.Rook.id });
    const row = await roster();
    expect(row('Rook').availability).toMatchObject({ reason: 'OTHER', inEffect: false });
    expect(row('Rook').unavailableReason).toBeNull();
    expect(row('Rook').freeForWork).toBe(true);
  });
});

describe('#3865 V67 regression pin (built behaviour, cor:agt:060:11 + cor:agt:050:12)', () => {
  it('a STALLED worker that makes a Hadron call through its session reads available; one that made none stays unavailable', async () => {
    await record('Rook', { reason: 'stalled', setAt: ago(60) });
    await record('Kit', { reason: 'stalled', setAt: ago(60) });
    for (const name of ['Rook', 'Kit']) {
      await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w[name].id, agentId, userId: mia.id, family: 'claude', startedAt: ago(120), updatedAt: ago(120) } });
    }
    // Rook acts through its session after the mark: the call is recorded as session activity.
    await db.session.updateMany({ where: { workerId: w.Rook.id }, data: { updatedAt: ago(10) } });
    // Existing fields only: this pins behaviour that is already built, so it is green on main.
    const row = await roster(baseFields);
    expect(row('Rook').unavailableReason).toBeNull();
    expect(row('Rook').freeForWork).toBe(true);
    expect(row('Rook').state).not.toBe('UNAVAILABLE');
    expect(row('Kit').unavailableReason).toBe('STALLED');
    expect(row('Kit').freeForWork).toBe(false);
    expect(row('Kit').state).toBe('UNAVAILABLE');
  });
});
