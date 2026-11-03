/** #3308 PR A: provision the two named grants before staffing/member enforcement is deployed. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { readFileSync } from 'node:fs';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { wakeStampsFor } from '../../../lib/tickers/postStamp.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const names = [['WORKERS_STAFF', 'workers.staff'], ['APP_MEMBERS', 'app.members']] as const;
let f: Awaited<ReturnType<typeof fixture>>;
async function fixture() {
 const holder = await db.user.create({ data: { handle: 'grant-owner', roles: ['READER'] } });
 const target = await db.user.create({ data: { handle: 'grant-target', roles: ['READER'] } });
 const org = await db.organization.create({ data: { name: 'Grant names', urn: 'grant3308.test' } });
 await db.orgMember.create({ data: { organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
 const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'grant3308.test:team' } });
 await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
 const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Role', urn: 'grant3308.test:role' } });
 await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
 const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'GrantHolder', slug: 'grant-holder', heldByUserId: holder.id } });
 const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
 return { holder, target, org, app, agent, worker, session };
}
beforeEach(async () => { await cleanDb(db); f = await fixture(); });
const person = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const grant = (name: string, c = person(), extra = {}) => M.grantApp({}, { appRef: f.app.id, workerRef: f.worker.id, name, ...extra }, c);

describe('#3308 staged grant-name provisioning', () => {
 for (const [wire, stored] of names) {
  it(`${wire}: manager gives the named grant, idempotently, and revokes it`, async () => {
   const row = await grant(wire);
   expect(row).toMatchObject({ appId: f.app.id, granteeWorkerId: f.worker.id, name: stored, grantedBy: f.holder.id, revokedAt: null });
   expect((await grant(wire)).id).toBe(row.id);
   expect(await db.appGrant.count({ where: { appId: f.app.id, name: stored, revokedAt: null } })).toBe(1);
   await M.revokeAppGrant({}, { appRef: f.app.id, workerRef: f.worker.id, name: wire }, person());
   expect((await db.appGrant.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).not.toBeNull();
  });
  it(`${wire}: the database accepts the new closed-list value`, async () => {
   await expect(db.appGrant.create({ data: { appId: f.app.id, granteeWorkerId: f.worker.id, name: stored, grantedBy: f.holder.id } })).resolves.toMatchObject({ name: stored });
  });
  for (const claim of [undefined, { kind: 'LIVE_CHAT', ref: 'client-chat:turn-1' }]) {
   it(`${wire}: worker cannot give itself a grant (${claim ? 'claimed instruction' : 'no instruction'})`, async () => {
    await expect(grant(wire, person({ sessionId: f.session.id }), { instruction: claim })).rejects.toMatchObject({ extensions: { code: 'APP_GRANT_FORBIDDEN' } });
    expect(await db.appGrant.count({ where: { appId: f.app.id } })).toBe(0);
   });
  }
  it(`${wire}: real GraphQL enum input/output round-trips the stored name`, async () => {
   const server = new ApolloServer<Context>({ typeDefs, resolvers });
   try {
    const result = await server.executeOperation({ query: `mutation($a:String!,$w:String!){grantApp(appRef:$a,workerRef:$w,name:${wire}){name revokedAt}}`, variables: { a: f.app.id, w: f.worker.id } }, { contextValue: person() });
    expect(result.body.kind).toBe('single');
    if (result.body.kind !== 'single') throw new Error('Expected one response');
    expect(result.body.singleResult.errors).toBeUndefined();
    expect(result.body.singleResult.data).toMatchObject({ grantApp: { name: wire, revokedAt: null } });
   } finally { await server.stop(); }
  });
 }
 for (const [wire] of names) it(`${wire}: does not grant ticker subscriptions or broadcast wakes`, async () => {
  await grant(wire);
  const target = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.agent.id, name: 'OtherWorker', slug: 'other-worker' } });
  const ticker = await M.createTicker({}, { appRef: f.app.id, input: { name: 'Ticker', cadenceSeconds: 600 } }, person());
  const workerCtx = person({ sessionId: f.session.id });
  const subscribe = () => runAsActor({ workerId: f.worker.id, agentId: f.agent.id }, () => M.subscribeWorker({}, { tickerRef: ticker.id, workerRef: target.id }, workerCtx));
  await expect(subscribe()).rejects.toMatchObject({ extensions: { code: 'SUBSCRIBE_FORBIDDEN' } });
  const stamps = () => runAsActor({ workerId: f.worker.id, agentId: f.agent.id }, () => db.$transaction(tx => wakeStampsFor(workerCtx, tx, f.app, f.worker.id, ['all'])));
  expect(await stamps()).toEqual({});
  await grant('TICKER_SUBSCRIBE_WORKERS');
  expect(await stamps()).toEqual({ broadcastWakes: true });
  await expect(subscribe()).resolves.toBeTruthy();
 });
 it('schema-only migration upgrades the old CHECK, replays, preserves grants and creates no grants itself', async () => {
  const existing = await grant('TICKER_SUBSCRIBE_WORKERS');
  const sql = readFileSync(new URL('../../../../prisma/migrations/20261103160000_staff_member_grant_names/migration.sql', import.meta.url), 'utf8');
  await db.$transaction(async tx => {
   await tx.$executeRawUnsafe('ALTER TABLE app_grants DROP CONSTRAINT chk_app_grants_shape');
   await tx.$executeRawUnsafe("ALTER TABLE app_grants ADD CONSTRAINT chk_app_grants_shape CHECK(name IN ('ticker.subscribe-workers'))");
   for (let replay = 0; replay < 2; replay++) {
    for (const statement of sql.split(';').filter(part => part.trim())) await tx.$executeRawUnsafe(statement);
    expect(await tx.appGrant.findMany({ where: { appId: f.app.id } })).toEqual([existing]);
   }
   for (const [, name] of names) await tx.appGrant.create({ data: { appId: f.app.id, granteeWorkerId: f.worker.id, name } });
   await tx.$executeRawUnsafe('SAVEPOINT invalid_name');
   await expect(tx.appGrant.create({ data: { appId: f.app.id, granteeWorkerId: f.worker.id, name: 'unknown.grant' } })).rejects.toThrow(/chk_app_grants_shape/);
   await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_name');
   expect(await tx.appGrant.count({ where: { appId: f.app.id } })).toBe(3);
  });
 });
 it('unknown names remain rejected at both the mutation and the database', async () => {
  await expect(grant('UNKNOWN_GRANT')).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  await expect(db.appGrant.create({ data: { appId: f.app.id, granteeWorkerId: f.worker.id, name: 'unknown.grant' } })).rejects.toThrow(/chk_app_grants_shape/);
  expect(await db.appGrant.count({ where: { appId: f.app.id } })).toBe(0);
 });
 it('the existing ticker grant remains supported', async () => {
  expect((await grant('TICKER_SUBSCRIBE_WORKERS')).name).toBe('ticker.subscribe-workers');
 });
 it('PR B preserves member-add for a worker with its own new grant', async () => {
  await grant('APP_MEMBERS');
  await expect(M.ensureAppMember({}, { appRef: f.app.id, userRef: f.target.id, role: 'owner' }, person({ sessionId: f.session.id }))).resolves.toMatchObject({ userId: f.target.id, role: 'owner' });
 });
});
