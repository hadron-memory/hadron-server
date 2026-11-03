/** #3273: one collected reset, its owning host only; audit reads, never advance the protocol. */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { ctx, M, NEW_PROC, PROC, setUpResetFixture, type ResetFixture } from '../../../test/contextResetFixture.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import { sweepUnreportedHostOperations } from '../../../lib/hostOperations/settle.js';
import { sweepContextResets } from '../../../lib/contextReset/contextReset.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
afterAll(() => server.stop());
let f: ResetFixture;
beforeEach(async () => { f = await setUpResetFixture(); });
const query = 'query($app:String!,$id:ID!){contextReset(appRef:$app,resetId:$id){id appId hostId phase epoch reason endedAt stopGrantedAt stopLeaseMs}}';
async function read(resetId: string, context = f.keyCtx(), app = f.app.id) {
  const response = await server.executeOperation({ query, variables: { app, id: resetId } }, { contextValue: context });
  if (response.body.kind !== 'single') throw new Error('incremental response');
  return JSON.parse(JSON.stringify(response.body.singleResult));
}
// Every table is in this run's private worker DB; snapshot rows rather than counts so updates cannot hide.
async function state() {
  return {
    resets: await db.contextReset.findMany({ orderBy: { id: 'asc' } }),
    operations: await db.hostOperation.findMany({ orderBy: { id: 'asc' } }),
    events: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
    availability: await db.workerAvailability.findMany({ orderBy: { workerId: 'asc' } }),
    families: await db.modelFamilyAvailability.findMany({ orderBy: { family: 'asc' } }),
    alarms: await db.agentTeamAlarmSchedule.findMany({ orderBy: [{ eventId: 'asc' }, { chainIndex: 'asc' }] }),
  };
}
async function recorded(resetId: string, code: string | null, context = f.keyCtx(), app = f.app.id) {
  const before = await state();
  const uses = await db.hostKeyUse.findMany({ orderBy: { id: 'asc' } });
  const answer = await read(resetId, context, app);
  expect(await state()).toEqual(before);
  const after = await db.hostKeyUse.findMany({ orderBy: { id: 'asc' } });
  const added = after.filter(row => !uses.some(old => old.id === row.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ appKeyId: context.appKeyId, action: 'read', refusedCode: code });
  return answer;
}

describe('#3273 ContextReset read', () => {
  it('reads each restart phase and current epoch without advancing it, ended done included', async () => {
    const s = await f.collectedReset();
    const check = async (phase: string) => {
      const row = await db.contextReset.findUniqueOrThrow({ where: { id: s.resetId } });
      const answer = await recorded(s.resetId, null);
      expect(answer.errors).toBeUndefined();
      expect(answer.data.contextReset).toMatchObject({ id: row.id, phase, epoch: row.epoch, reason: row.reason });
      expect(answer.data.contextReset.stopLeaseMs).toBe(row.stopLeaseMs);
      expect(answer.data.contextReset.endedAt).toBe(row.endedAt?.toISOString() ?? null);
    };
    await check('requested');
    await f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC });
    await check('claimed');
    await f.step('registerContextResetRecovery', { resetId: s.resetId, epoch: 1, checkpointNode: (await f.checkpoint()).id, sessionId: f.session.id, taskId: s.taskId });
    await check('checkpointed');
    await f.step('authorizeContextResetStop', { resetId: s.resetId, epoch: 1, process: PROC });
    await check('stop-granted');
    await f.step('reportContextResetAgentStopped', { resetId: s.resetId, epoch: 1 });
    await check('agent-stopped');
    await f.step('reportContextResetRelaunched', { resetId: s.resetId, epoch: 1, process: NEW_PROC });
    await check('relaunched');
    await M.reportHostOperation({}, { input: { appRef: f.app.id, id: s.operationId, outcome: 'SUCCEEDED' } }, f.keyCtx());
    await check('done');
  });

  it.each(['refused', 'failed'])('reads ended %s with reason and moved epoch', async phase => {
    const s = await f.collectedReset();
    await db.contextReset.update({ where: { id: s.resetId }, data: { phase, reason: phase === 'refused' ? 'BUSY' : 'HOST_LOST', endedAt: new Date(), epoch: 7 } });
    const answer = await recorded(s.resetId, null);
    expect(answer.errors).toBeUndefined();
    expect(answer.data.contextReset).toMatchObject({ phase, epoch: 7, reason: phase === 'refused' ? 'BUSY' : 'HOST_LOST' });
    expect(answer.data.contextReset.endedAt).not.toBeNull();
  });

  it('the issued operation is NOT_COLLECTED, with exactly one refused read use', async () => {
    const task = await f.startedTask();
    await f.finish(task.id);
    const row = await db.contextReset.findUniqueOrThrow({ where: { taskId: task.id } });
    const answer = await recorded(row.id, 'HOST_OPERATION_NOT_COLLECTED');
    expect(answer.errors?.[0].extensions).toEqual({ code: 'HOST_OPERATION_NOT_COLLECTED' });
  });

  it('a failed operation never collected is still NOT_COLLECTED, even after its reset ends', async () => {
    const task = await f.startedTask();
    await f.finish(task.id);
    const row = await db.contextReset.findUniqueOrThrow({ where: { taskId: task.id } });
    await db.hostRegistration.updateMany({ where: { appId: f.app.id, hostId: 'orca1' }, data: { lostAt: new Date() } });
    await sweepUnreportedHostOperations(db);
    await sweepContextResets(db);
    expect(await db.hostOperation.findUniqueOrThrow({ where: { id: row.hostOperationId! } }))
      .toMatchObject({ status: 'failed', collectedAt: null });
    expect(await db.contextReset.findUniqueOrThrow({ where: { id: row.id } }))
      .toMatchObject({ phase: 'failed', reason: 'HOST_LOST' });
    const answer = await recorded(row.id, 'HOST_OPERATION_NOT_COLLECTED');
    expect(answer.errors?.[0].extensions).toEqual({ code: 'HOST_OPERATION_NOT_COLLECTED' });
  });

  it('a collected operation that later fails stays readable with its ended reset', async () => {
    const s = await f.collectedReset();
    const later = new Date(Date.now() + 24 * 60 * 60_000);
    await sweepUnreportedHostOperations(db, later);
    await sweepContextResets(db, later);
    const op = await db.hostOperation.findUniqueOrThrow({ where: { id: s.operationId } });
    expect(op.status).toBe('failed');
    expect(op.collectedAt).not.toBeNull();
    const answer = await recorded(s.resetId, null);
    expect(answer.errors).toBeUndefined();
    expect(answer.data.contextReset).toMatchObject({ phase: 'failed', reason: 'REPORT_TIMEOUT' });
    expect(answer.data.contextReset.endedAt).not.toBeNull();
  });

  it('unknown, malformed, another host/App, and missing operation have byte-identical full wire errors', async () => {
    const s = await f.collectedReset();
    const unknown = await recorded(generateId(), 'CONTEXT_RESET_NOT_FOUND');
    expect(unknown.errors?.[0].extensions).toEqual({ code: 'CONTEXT_RESET_NOT_FOUND' });
    const same = async (id: string, c = f.keyCtx(), app = f.app.id) => {
      const answer = await recorded(id, 'CONTEXT_RESET_NOT_FOUND', c, app);
      expect(JSON.stringify(answer)).toBe(JSON.stringify(unknown));
    };
    await same('bad.id');
    await same('x'.repeat(65));
    await same(s.resetId, f.keyCtx(await f.hostKey('orca2')));
    const foreign = await db.app.create({ data: { organizationId: f.orgId, name: 'Foreign', urn: `reset-${generateId().toLowerCase()}.example:other` } });
    const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const key = await db.appKey.create({ data: { appId: foreign.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
    await M.grantAppKeyScope({}, { id: key.id, scope: 'host:operate', hostId: 'orca1' }, ctx(f.manager.id));
    await same(s.resetId, { db, appId: foreign.id, appKeyId: key.id, roles: [] }, foreign.id);
    // Operation history is append-only and reset identity immutable. Insert a separate synthetic reset;
    // there is deliberately no operation FK, so an absent-operation row can be modelled without disabling guards.
    const missing = await db.contextReset.create({ data: {
      id: generateId(), appId: f.app.id, workerId: f.kit.id, sessionId: f.session.id,
      taskId: generateId(), hostId: 'orca1', hostOperationId: generateId(), phase: 'requested', requestedAt: new Date(),
    } });
    await same(missing.id);
  });

  it('user session and never-host App key follow the protocol key gate without use records', async () => {
    const s = await f.collectedReset();
    const before = await db.hostKeyUse.count();
    const user = await read(s.resetId, ctx(f.holder.id));
    expect(user.errors?.[0].extensions.code).toBe('HOST_KEY_REQUIRED');
    const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const key = await db.appKey.create({ data: { appId: f.app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
    const plain = await read(s.resetId, f.keyCtx(key));
    expect(plain.errors?.[0].extensions.code).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await db.hostKeyUse.count()).toBe(before);
  });

  it('records scope-revoked and session-bound host refusals once, never reads reset state', async () => {
    const s = await f.collectedReset();
    const bound = await recorded(s.resetId, 'APP_KEY_SESSION_BOUND', { ...f.keyCtx(), sessionId: f.session.id });
    expect(bound.data).toBeNull();
    await M.revokeAppKeyScope({}, { id: f.orca1.id, scope: 'host:operate' }, ctx(f.manager.id));
    const revoked = await recorded(s.resetId, 'APP_KEY_SCOPE_REQUIRED');
    expect(revoked.data).toBeNull();
  });

  it('rechecks host authority inside the deciding transaction after a committed scope revocation', async () => {
    const s = await f.collectedReset();
    let injected = 0;
    const client = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== '$transaction') return Reflect.get(target, key, receiver);
        return async (fn: any, options: any) => {
          if (injected++ === 0) {
            await M.revokeAppKeyScope({}, { id: f.orca1.id, scope: 'host:operate' }, ctx(f.manager.id));
          }
          return target.$transaction(fn, options);
        };
      },
    });
    const answer = await recorded(s.resetId, 'APP_KEY_SCOPE_REQUIRED', { ...f.keyCtx(), db: client });
    expect(injected).toBe(1);
    expect(answer.data).toBeNull();
    expect(answer.errors?.[0].extensions.code).toBe('APP_KEY_SCOPE_REQUIRED');
  });
});
