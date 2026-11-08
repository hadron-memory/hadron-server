/**
 * #3360 (hrn:node:hadronmemory.com:specs:cor:agt:050:23, rulings:0112): a userless run of the App reads the
 * App's roster only while its own automation holds a team snapshot grant. The older worker reads
 * (`workers(appRef)`, `worker(ref)`, `heldWorkers`) admitted every userless own-App principal, key or run.
 * Controls: the App's own key still reads, a granted run reads, another App's run stays refused.
 */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import type { AppRun } from '../../../generated/prisma/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn(async () => {}) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
beforeAll(() => server.start());
afterAll(() => server.stop());

let orgId: string, appId: string, otherAppId: string, workerId: string, manager: string, holder: string, keyId: string;
const ENTRY = 'hrn:node:roster3360.example:flows:report';

async function wire(query: string, variables: Record<string, unknown>, contextValue: Context) {
  const answer = await server.executeOperation({ query, variables }, { contextValue });
  if (answer.body.kind !== 'single') throw new Error('unexpected incremental response');
  return JSON.parse(JSON.stringify(answer.body.singleResult));
}
async function schedule(forApp = appId) {
  return (await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId: forApp, name: 'Roster automation', cron: '* * * * *', entryNodeUrn: ENTRY } })).id;
}
async function runOf(triggerId: string, forApp = appId): Promise<AppRun> {
  return db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId: forApp, userId: null, triggerKind: 'SCHEDULE', triggerId, entryNodeUrn: ENTRY, status: 'RUNNING' } });
}
async function grant(triggerId: string, forApp = appId) {
  const out = await wire('mutation($a:ID!,$t:ID!){setAutomationTeamSnapshotGrant(appRef:$a,triggerKind:"SCHEDULE",triggerId:$t){id revokedAt}}',
    { a: forApp, t: triggerId }, { db, userId: manager, roles: ['READER'] });
  expect(out.errors).toBeUndefined();
  return out.data.setAutomationTeamSnapshotGrant.id as string;
}
const asRun = (run: AppRun): Context => runContext(db, run) as Context;
const asKey = (): Context => ({ db, appId, appKeyId: keyId, roles: [] } as Context);

const WORKERS = 'query($a:ID!){workers(appRef:$a){items{id name} total}}';
const WORKER = 'query($r:ID!){worker(ref:$r){id name}}';
const HELD = 'query($u:String!){heldWorkers(userRef:$u){items{id} total}}';

async function reads(c: Context) {
  return {
    workers: await wire(WORKERS, { a: appId }, c),
    worker: await wire(WORKER, { r: workerId }, c),
    held: await wire(HELD, { u: holder }, c),
  };
}
function refused(r: Awaited<ReturnType<typeof reads>>) {
  expect(r.workers.errors?.[0]?.extensions?.code, 'workers(appRef) must refuse').toBe('FORBIDDEN');
  // A denied worker(ref) collapses to the absent-worker answer (resolveProfileWorkerRef).
  expect(r.worker.errors?.[0]?.extensions?.code, 'worker(ref) must refuse').toBe('WORKER_NOT_FOUND');
  expect(r.held.errors, 'heldWorkers answers a page, never an error').toBeUndefined();
  expect(r.held.data.heldWorkers, 'heldWorkers must not list the App\'s held worker').toEqual({ items: [], total: 0 });
}
function admitted(r: Awaited<ReturnType<typeof reads>>) {
  expect(r.workers.errors).toBeUndefined();
  expect(r.workers.data.workers.items).toEqual([{ id: workerId, name: 'Builder' }]);
  expect(r.worker.errors).toBeUndefined();
  expect(r.worker.data.worker).toEqual({ id: workerId, name: 'Builder' });
  expect(r.held.errors).toBeUndefined();
  expect(r.held.data.heldWorkers).toEqual({ items: [{ id: workerId }], total: 1 });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Roster', urn: `roster-${generateId()}.example` } });
  orgId = org.id;
  manager = (await db.user.create({ data: { handle: `mgr-${generateId()}`, roles: ['READER'] } })).id;
  holder = (await db.user.create({ data: { handle: `hold-${generateId()}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'Team', urn: `${org.urn}:team`, organizationId: orgId } })).id;
  otherAppId = (await db.app.create({ data: { name: 'Other', urn: `${org.urn}:other`, organizationId: orgId } })).id;
  const agentId = (await db.agent.create({ data: { name: 'Team Agent', urn: `${org.urn}:agent`, organizationId: orgId } })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Builder', slug: 'builder',
    heldByUserId: holder, heldAt: new Date() } })).id;
  keyId = (await db.appKey.create({ data: { appId, keyHash: generateId(), keyPreview: 'synthetic' } })).id;
});

it('RED3360: an ungranted userless run of the App is refused the roster on every worker read', async () => {
  refused(await reads(asRun(await runOf(await schedule()))));
});

it('RED3360: workers(appRef) refuses an ungranted run', async () => {
  const out = await wire(WORKERS, { a: appId }, asRun(await runOf(await schedule())));
  expect(out.data?.workers ?? null, 'roster leaked').toBeNull();
  expect(out.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
});

it('RED3360: worker(ref) refuses an ungranted run like an absent worker', async () => {
  const out = await wire(WORKER, { r: workerId }, asRun(await runOf(await schedule())));
  expect(out.data?.worker ?? null, 'worker leaked').toBeNull();
  expect(out.errors?.[0]?.extensions?.code).toBe('WORKER_NOT_FOUND');
});

it('RED3360: heldWorkers lists nothing of the App for an ungranted run', async () => {
  const out = await wire(HELD, { u: holder }, asRun(await runOf(await schedule())));
  expect(out.errors).toBeUndefined();
  expect(out.data.heldWorkers).toEqual({ items: [], total: 0 });
});

it('RED3360: the refusal is byte-identical to another App\'s run (no grant oracle)', async () => {
  const own = await reads(asRun(await runOf(await schedule())));
  const foreign = await reads(asRun(await runOf(await schedule(otherAppId), otherAppId)));
  expect(own.workers.errors).toEqual(foreign.workers.errors);
  expect(own.worker).toEqual(foreign.worker);
  expect(own.held).toEqual(foreign.held);
});

it('RED3360: a revoked grant, a sibling automation\'s grant and a finished run all refuse', async () => {
  const granted = await schedule();
  const sibling = await schedule();
  await grant(sibling);
  refused(await reads(asRun(await runOf(granted))));
  const id = await grant(granted);
  const finished = await runOf(granted);
  await db.appRun.update({ where: { id: finished.id }, data: { status: 'COMPLETED' } });
  refused(await reads(asRun(finished)));
  const revoked = await wire('mutation($id:ID!){revokeAutomationTeamSnapshotGrant(id:$id){id revokedAt}}', { id }, { db, userId: manager, roles: ['READER'] } as Context);
  expect(revoked.errors).toBeUndefined();
  refused(await reads(asRun(await runOf(granted))));
});

it('a run whose own automation holds the grant reads the roster', async () => {
  const trigger = await schedule();
  await grant(trigger);
  admitted(await reads(asRun(await runOf(trigger))));
});

it('control: the App\'s own key still reads its roster without any grant', async () => {
  admitted(await reads(asKey()));
});

it('control: a granted run of another App never reads this App\'s roster', async () => {
  const trigger = await schedule(otherAppId);
  await grant(trigger, otherAppId);
  refused(await reads(asRun(await runOf(trigger, otherAppId))));
});
