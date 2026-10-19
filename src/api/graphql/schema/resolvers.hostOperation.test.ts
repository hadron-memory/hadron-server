import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1709 (Task Management T6, slice 1) — the host-operation queue and the
 * `host:operate` App-key scope bound to one host. Scenarios of
 * cor:agt:070:03 (closed set), :04 (a key reaches one App and one host), :05
 * (who issues), :07 (every use recorded) and the host arm of cor:agt:060:08.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let otherApp: { id: string };
let agentId: string;
let manager: { id: string };
let holder: { id: string };
let adaHolder: { id: string };
let member: { id: string };
let kit: { id: string };
let ada: { id: string };
let zed: { id: string };
let orca1: { id: string };
let orca2: { id: string };
let plainKey: { id: string };
let foreignKey: { id: string };

async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
/** What the middleware builds for a bare App key. */
const keyCtx = (k: { id: string }, appId = app.id, extra: Partial<Context> = {}): Context =>
  ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [], ...extra }) as Context;
const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);

const register = (k: { id: string }, workers: unknown[] = [], extra: Record<string, unknown> = {}) =>
  M.registerHost({}, { input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 60, workers, ...extra } }, keyCtx(k));
const create = (c: Context, extra: Record<string, unknown> = {}) =>
  M.issueHostOperation({}, {
    input: {
      appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worktree.create',
      args: { repo: 'hadron-server', baseBranch: 'main', branchName: 'kit/1709-x', label: 'kit-1709' },
      ...extra,
    },
  }, c);
const collect = (k: { id: string }, first?: number) => M.collectHostOperations({}, { appRef: app.id, first }, keyCtx(k));
const report = (k: { id: string }, input: Record<string, unknown>) => M.reportHostOperation({}, { input: { appRef: app.id, ...input } }, keyCtx(k));

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Hosts', urn: `hostops-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `ho-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(71, 'manager');
  holder = await u(72, 'holder');
  adaHolder = await u(73, 'ada-holder');
  member = await u(74, 'member');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  for (const id of [holder.id, adaHolder.id, member.id]) await db.appMember.create({ data: { appId: app.id, userId: id, role: 'member' } });
  ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: adaHolder.id }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id, reportsToWorkerId: ada.id }, select: { id: true } });
  zed = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId, name: 'Zed', slug: 'zed' }, select: { id: true } });
  orca1 = await mkKey(app.id, 'orca1');
  orca2 = await mkKey(app.id, 'orca2');
  plainKey = await mkKey(app.id, 'plain');
  foreignKey = await mkKey(otherApp.id, 'foreign');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(manager.id));
  await M.grantAppKeyScope({}, { id: foreignKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
});

describe('the host:operate scope is granted for one host (cor:agt:070:04)', () => {
  it('names the host, and is shown with it; other scopes take no host', async () => {
    const shown = await F.AppKey.scopes({ id: orca1.id, appId: app.id }, {}, ctx(manager.id));
    expect(shown.map((s: any) => [s.scope, s.hostId])).toEqual([['host:operate', 'orca1']]);
    expect(await code(M.grantAppKeyScope({}, { id: plainKey.id, scope: 'host:operate' }, ctx(manager.id)))).toBe('BAD_USER_INPUT');
    expect(await code(M.grantAppKeyScope({}, { id: plainKey.id, scope: 'host:operate', hostId: '-rf' }, ctx(manager.id)))).toBe('BAD_USER_INPUT');
    expect(await code(M.grantAppKeyScope({}, { id: plainKey.id, scope: 'attention:deliver', hostId: 'orca1' }, ctx(manager.id)))).toBe('BAD_USER_INPUT');
  });

  it('a key operates as one host: granting it again for the same host changes nothing, for another is refused', async () => {
    await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
    expect(await db.appKeyScope.count({ where: { appKeyId: orca1.id } })).toBe(1);
    expect(await code(M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca2' }, ctx(manager.id)))).toBe('APP_KEY_SCOPE_HOST_CONFLICT');
    // Revoked, it can be given for another host.
    await M.revokeAppKeyScope({}, { id: orca1.id, scope: 'host:operate' }, ctx(manager.id));
    await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca3' }, ctx(manager.id));
    expect((await db.appKeyScope.findFirstOrThrow({ where: { appKeyId: orca1.id, revokedAt: null } })).hostId).toBe('orca3');
  });

  it('cor:agt:070:07 S2: a participant who does not manage the App grants nothing', async () => {
    expect(await code(M.grantAppKeyScope({}, { id: plainKey.id, scope: 'host:operate', hostId: 'orca9' }, ctx(member.id)))).toBe('FORBIDDEN');
    expect(await db.appKeyScope.count({ where: { appKeyId: plainKey.id } })).toBe(0);
  });
});

describe('registerHost: the host identity comes from the key (cor:agt:070:01, :04)', () => {
  it('registers the key\'s host with its workers, families and worktrees, and records the use', async () => {
    const r = await register(orca1, [{ worker: 'Kit', family: 'Claude', worktrees: ['hadron-server/kit', 'hadron-cli/kit'] }]);
    expect(r).toMatchObject({ hostId: 'orca1', label: 'Orca', live: true, workers: [{ workerId: kit.id, family: 'claude', worktrees: ['hadron-server/kit', 'hadron-cli/kit'] }] });
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: orca1.id } });
    expect(uses.map((u) => [u.action, u.hostId, u.count])).toEqual([['register', 'orca1', 1]]);
    expect(await db.agentTeamEvent.count({ where: { type: 'host.registered', appId: app.id } })).toBe(1);
  });

  it('refuses a person, a key without the scope, another App\'s key and a key with a session, writing nothing', async () => {
    expect(await code(M.registerHost({}, { input: { appRef: app.id, label: 'x', pollIntervalSeconds: 60 } }, ctx(manager.id)))).toBe('HOST_KEY_REQUIRED');
    expect(await code(register(plainKey))).toBe('APP_KEY_SCOPE_REQUIRED');
    // A key of another App, naming this one: not found, before anything about its scope.
    expect(await code(M.registerHost({}, { input: { appRef: app.id, label: 'x', pollIntervalSeconds: 60 } }, keyCtx(foreignKey, otherApp.id)))).toBe('APP_NOT_FOUND');
    expect(await code(M.registerHost({}, { input: { appRef: app.id, label: 'x', pollIntervalSeconds: 60 } }, keyCtx(orca1, app.id, { sessionId: 's1' } as any)))).toBe('APP_KEY_SESSION_BOUND');
    expect(await db.hostRegistration.count()).toBe(0);
    // #1881 (070:07): every refused call of a HOST key is recorded with its code, under the key's own App (the other
    // App's host key included); the person and the key never granted host:operate are not host keys.
    const uses = await db.hostKeyUse.findMany({ orderBy: { usedAt: 'asc' } });
    expect(uses.map((u) => [u.appKeyId, u.appId, u.action, u.hostId, u.refusedCode])).toEqual([
      [foreignKey.id, otherApp.id, 'register', 'orca1', 'APP_NOT_FOUND'],
      [orca1.id, app.id, 'register', 'orca1', 'APP_KEY_SESSION_BOUND'],
    ]);
  });

  it('refuses another App\'s worker and a worktree that is not a name token', async () => {
    expect(await code(register(orca1, [{ worker: zed.id, family: 'claude' }]))).toBe('BAD_HOST_REGISTRATION');
    for (const bad of ['-rf', '../etc', 'a//b', 'a/', 'x;rm', 'a b', '$(id)']) {
      expect(await code(register(orca1, [{ worker: kit.id, family: 'claude', worktrees: [bad] }]))).toBe('BAD_HOST_REGISTRATION');
    }
    expect(await db.hostRegistration.count()).toBe(0);
  });

  it('a revoked scope or key is refused from its next call', async () => {
    await register(orca1);
    await M.revokeAppKeyScope({}, { id: orca1.id, scope: 'host:operate' }, ctx(manager.id));
    expect(await code(register(orca1))).toBe('APP_KEY_SCOPE_REQUIRED');
    await register(orca2);
    await db.appKey.update({ where: { id: orca2.id }, data: { revokedAt: new Date() } });
    expect(await code(register(orca2))).toBe('APP_KEY_SCOPE_REQUIRED');
  });
});

describe('issueHostOperation: the closed set (cor:agt:070:03) and who issues (cor:agt:070:05)', () => {
  beforeEach(async () => {
    await register(orca1, [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }]);
  });

  it('S2: an operation of type shell is refused at issue, and nothing is queued', async () => {
    expect(await code(create(ctx(manager.id), { type: 'shell', args: { command: 'rm -rf /' } }))).toBe('HOST_OPERATION_TYPE_UNKNOWN');
    expect(await code(create(ctx(manager.id), { type: 'worktree.create', args: { repo: 'r', baseBranch: 'main', branchName: 'b', label: 'l', command: 'id' } })))
      .toBe('BAD_HOST_OPERATION_ARGS');
    expect(await code(create(ctx(manager.id), { args: { repo: '--upload-pack=x', baseBranch: 'main', branchName: 'b', label: 'l' } }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await code(create(ctx(manager.id), { args: { repo: 'r', baseBranch: 'main', branchName: 'b' } }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await code(create(ctx(manager.id), { args: { workerId: zed.id, repo: 'r', baseBranch: 'main', branchName: 'b', label: 'l' } }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('S2 (070:05): Kit\'s holder, the worker Kit reports to and whoever manages the App create a worktree', async () => {
    const byHolder = await create(ctx(holder.id));
    expect(byHolder).toMatchObject({ status: 'issued', issuedBy: 'user', issuedByUserId: holder.id, hostId: 'orca1', workerId: kit.id });
    expect(byHolder.args).toEqual({ workerId: kit.id, repo: 'hadron-server', baseBranch: 'main', branchName: 'kit/1709-x', label: 'kit-1709' });
    const byAda = await asWorker(ada, () => create(ctx(adaHolder.id)));
    expect(byAda).toMatchObject({ issuedBy: 'worker', issuedByWorkerId: ada.id });
    expect((await create(ctx(manager.id))).issuedBy).toBe('user');
    expect(F.HostOperation.status(byAda)).toBe('ISSUED');
  });

  it('S3: a participant who neither holds Kit, nor is the worker Kit reports to, nor manages the App is refused', async () => {
    expect(await code(create(ctx(member.id)))).toBe('HOST_OPERATION_NOT_PERMITTED');
    // Ada's holder as a person is not Ada: the reports-to arm is the worker's.
    expect(await code(create(ctx(adaHolder.id)))).toBe('HOST_OPERATION_NOT_PERMITTED');
    // Kit itself is none of the three either.
    expect(await code(asWorker(kit, () => create(ctx(holder.id))))).toBe('HOST_OPERATION_NOT_PERMITTED');
    expect(await code(create(keyCtx(orca1)))).toBe('FORBIDDEN');
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('S4: the worker Kit reports to may not start Kit (only whoever manages the App); worker.deliver is not issuable here (worker.end: sessionEnd.test.ts)', async () => {
    const start = { type: 'worker.start', args: { worktree: 'hadron-server/kit', family: 'claude' } };
    expect(await code(asWorker(ada, () => create(ctx(adaHolder.id), start)))).toBe('HOST_OPERATION_NOT_PERMITTED');
    expect(await code(create(ctx(holder.id), start))).toBe('HOST_OPERATION_NOT_PERMITTED');
    expect(await code(create(ctx(manager.id), { type: 'worker.deliver', args: { sessionId: 's1', eventId: 'e1' } }))).toBe('HOST_OPERATION_NOT_ISSUABLE');
    expect(await db.hostOperation.count()).toBe(0);
    // Whoever manages the App starts it (slice 2: launch.test.ts carries the rest).
    expect(await create(ctx(manager.id), start)).toMatchObject({ type: 'worker.start', issuedBy: 'user', args: { workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude' } });
  });

  it('#12143: the issueHostOperation SDL says worker.end is issuable by whoever manages the App; only worker.deliver is not', () => {
    const doc = /"""\n([^"]*)"""\n\s*issueHostOperation\(/.exec(typeDefs)?.[1] ?? '';
    expect(doc).toContain('worker.end: whoever manages the App only');
    expect(doc.replace(/\s+/g, ' ')).toContain('worker.deliver is the one type not issued yet, HOST_OPERATION_NOT_ISSUABLE');
    // The pre-#1709 wording said worker.end was not issuable yet.
    expect(doc).not.toMatch(/worker\.end ships with/);
  });

  it('S1 (070:05): the holder removes a worktree the host registers for Kit; one it does not register is refused', async () => {
    const op = await create(ctx(holder.id), { type: 'worktree.remove', args: { worktree: 'hadron-server/kit' } });
    expect(op).toMatchObject({ type: 'worktree.remove', args: { workerId: kit.id, worktree: 'hadron-server/kit' } });
    expect(await code(create(ctx(holder.id), { type: 'worktree.remove', args: { worktree: 'hadron-server/other' } }))).toBe('BAD_HOST_OPERATION_ARGS');
  });

  it('an unregistered host, a retired worker and another App\'s worker are refused', async () => {
    expect(await code(create(ctx(manager.id), { hostId: 'orca9' }))).toBe('HOST_NOT_FOUND');
    expect(await code(create(ctx(manager.id), { worker: zed.id }))).toBe('WORKER_NOT_FOUND');
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect(await code(create(ctx(manager.id)))).toBe('WORKER_RETIRED');
  });
});

describe('collect and report: a key reaches only its own host (cor:agt:070:04)', () => {
  let op1: { id: string };
  let op2: { id: string };
  beforeEach(async () => {
    await register(orca1, [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await register(orca2, [{ worker: kit.id, family: 'claude' }]);
    op1 = await create(ctx(manager.id));
    op2 = await create(ctx(manager.id), { hostId: 'orca2' });
  });

  it('S1: orca1 collects only orca1\'s operations, which become collected; a restarted host gets the unreported ones again', async () => {
    const got = await collect(orca1);
    expect(got.map((o: any) => [o.id, o.status])).toEqual([[op1.id, 'collected']]);
    expect((await db.hostOperation.findUniqueOrThrow({ where: { id: op2.id } })).status).toBe('issued');
    expect((await collect(orca1)).map((o: any) => o.id)).toEqual([op1.id]);
    expect((await collect(orca2)).map((o: any) => o.id)).toEqual([op2.id]);
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: orca1.id, action: 'collect' } });
    expect(uses.map((u) => u.count)).toEqual([1, 1]);
  });

  it('S2: orca2\'s key reporting orca1\'s operation is "not found", and nothing changes', async () => {
    await collect(orca1);
    expect(await code(report(orca2, { id: op1.id, outcome: 'SUCCEEDED', worktree: 'hadron-server/kit-1709' }))).toBe('HOST_OPERATION_NOT_FOUND');
    expect(await code(M.reportHostOperation({}, { input: { appRef: app.id, id: op1.id, outcome: 'FAILED', failureReason: 'x' } }, keyCtx(foreignKey, otherApp.id))))
      .toBe('APP_NOT_FOUND');
    expect((await db.hostOperation.findUniqueOrThrow({ where: { id: op1.id } })).status).toBe('collected');
  });

  it('a success records its typed result and writes host.operation.succeeded; the same report again changes nothing', async () => {
    expect(await code(report(orca1, { id: op1.id, outcome: 'SUCCEEDED', worktree: 'hadron-server/kit-1709' }))).toBe('HOST_OPERATION_NOT_COLLECTED');
    await collect(orca1);
    expect(await code(report(orca1, { id: op1.id, outcome: 'SUCCEEDED' }))).toBe('BAD_USER_INPUT');
    const done = await report(orca1, { id: op1.id, outcome: 'SUCCEEDED', worktree: 'hadron-server/kit-1709' });
    expect(done).toMatchObject({ status: 'succeeded', result: { worktree: 'hadron-server/kit-1709' }, failureReason: null });
    expect(done.finishedAt).toBeInstanceOf(Date);
    const again = await report(orca1, { id: op1.id, outcome: 'SUCCEEDED', worktree: 'hadron-server/kit-1709' });
    expect(again.finishedAt).toEqual(done.finishedAt);
    expect(await code(report(orca1, { id: op1.id, outcome: 'FAILED', failureReason: 'late' }))).toBe('HOST_OPERATION_ALREADY_REPORTED');
    const events = await db.agentTeamEvent.findMany({ where: { type: { startsWith: 'host.operation.' } } });
    expect(events.map((e) => [e.type, e.subjectWorkerId, e.payload])).toEqual([
      ['host.operation.succeeded', kit.id, { operationId: op1.id, hostId: 'orca1', operationType: 'worktree.create' }],
    ]);
    // The idempotent second report is a use too (Diego P2-2); one outcome event either way.
    const reports = await db.hostKeyUse.findMany({ where: { action: 'report', refusedCode: null } });
    expect(reports.map((u) => u.operationId)).toEqual([op1.id, op1.id]);
  });

  it('S3 (070:03): a failure carries its reason on the operation, never in the event', async () => {
    await collect(orca1);
    expect(await code(report(orca1, { id: op1.id, outcome: 'FAILED' }))).toBe('BAD_USER_INPUT');
    const failed = await report(orca1, { id: op1.id, outcome: 'FAILED', failureReason: 'branch kit/1709-x already exists' });
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'branch kit/1709-x already exists', result: null });
    const [e] = await db.agentTeamEvent.findMany({ where: { type: 'host.operation.failed' } });
    expect(JSON.stringify(e!.payload)).not.toMatch(/already exists|kit\/1709/);
    // A repeated failure: a second use row, still one outcome event, the first reason kept.
    expect(await report(orca1, { id: op1.id, outcome: 'FAILED', failureReason: 'retry' })).toMatchObject({ failureReason: 'branch kit/1709-x already exists' });
    expect(await db.hostKeyUse.count({ where: { action: 'report', operationId: op1.id, refusedCode: null } })).toBe(2);
    expect(await db.agentTeamEvent.count({ where: { type: 'host.operation.failed' } })).toBe(1);
  });

  it('S3 (070:04): a revoked key collects nothing, and the revocation is not raced by a collection already waiting', async () => {
    // A revoker holds the App's anchors exclusively while it revokes; a collection that started then waits, and is refused.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }, { kind: 'org', id: org.id }], 'exclusive');
      await tx.appKeyScope.updateMany({ where: { appKeyId: orca1.id, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: manager.id } });
      ready();
      await gate;
    });
    await locked;
    // The gate outside the transaction still sees the committed (unrevoked) scope; the re-check under the anchor does not.
    const waiting = code(collect(orca1));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await revoker;
    expect(await waiting).toBe('APP_KEY_SCOPE_REQUIRED');
    expect((await db.hostOperation.findUniqueOrThrow({ where: { id: op1.id } })).status).toBe('issued');
    expect(await db.hostKeyUse.count({ where: { action: 'collect', refusedCode: null } })).toBe(0);
    // #1881: the refused collect is recorded apart, under the revoked grant's host, so its rollback kept it.
    expect((await db.hostKeyUse.findMany({ where: { action: 'collect' } })).map((u) => [u.hostId, u.refusedCode])).toEqual([['orca1', 'APP_KEY_SCOPE_REQUIRED']]);
  });
});

describe('the host arm of cor:agt:060:08: out of tokens or host down, its own marks only', () => {
  const setAs = (k: { id: string }, input: Record<string, unknown>) =>
    M.setHostWorkerAvailability({}, { input: { appRef: app.id, worker: kit.id, ...input } }, keyCtx(k));

  beforeEach(async () => {
    await register(orca1, [{ worker: kit.id, family: 'claude' }]);
    await register(orca2, [{ worker: kit.id, family: 'claude' }]);
  });

  it('S1: Kit runs out of tokens; orca1 marks it, then clears its own mark', async () => {
    const r = await setAs(orca1, { state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'out-of-tokens', setBy: 'host', setByHostId: 'orca1', setByUserId: null });
    const [e] = await db.agentTeamEvent.findMany({ where: { type: 'availability.changed' } });
    expect(e!.payload).toMatchObject({ state: 'unavailable', reason: 'out-of-tokens', setBy: 'host', hostId: 'orca1' });
    // Another host may not clear it, nor replace it.
    expect(await code(setAs(orca2, { state: 'AVAILABLE' }))).toBe('AVAILABILITY_NOT_PERMITTED');
    expect(await code(setAs(orca2, { state: 'UNAVAILABLE', reason: 'HOST_DOWN' }))).toBe('AVAILABILITY_NOT_PERMITTED');
    expect((await setAs(orca1, { state: 'AVAILABLE' })).state).toBe('available');
    expect(await db.hostKeyUse.count({ where: { action: 'availability', appKeyId: orca1.id, refusedCode: null } })).toBe(2);
    expect(await db.hostKeyUse.count({ where: { action: 'availability', appKeyId: orca2.id, refusedCode: 'AVAILABILITY_NOT_PERMITTED' } })).toBe(2);
  });

  it('S2: a host never sets another reason, and never clears or replaces a mark it did not set (a stall among them)', async () => {
    expect(await code(setAs(orca1, { state: 'UNAVAILABLE', reason: 'OTHER' }))).toBe('AVAILABILITY_NOT_PERMITTED');
    expect(await code(setAs(orca1, { state: 'UNAVAILABLE', reason: 'STALLED' }))).toBe('AVAILABILITY_NOT_PERMITTED');
    expect(await code(setAs(orca1, { state: 'AVAILABLE' }))).toBe('AVAILABILITY_NOT_PERMITTED');
    await db.workerAvailability.create({ data: { workerId: kit.id, state: 'unavailable', reason: 'stalled', setAt: new Date(), setBy: 'stall-rule' } });
    expect(await code(setAs(orca1, { state: 'AVAILABLE' }))).toBe('AVAILABILITY_NOT_PERMITTED');
    expect(await code(setAs(orca1, { state: 'UNAVAILABLE', reason: 'HOST_DOWN' }))).toBe('AVAILABILITY_NOT_PERMITTED');
    expect(await db.workerAvailability.findUniqueOrThrow({ where: { workerId: kit.id } })).toMatchObject({ reason: 'stalled', setBy: 'stall-rule' });
  });

  it('Diego P2-3: two hosts\' FIRST marks serialize on the worker; the second sees the first and is refused', async () => {
    // Host A's first mark, uncommitted, holding the worker row only as every OTHER availability writer does (FOR
    // SHARE): so it is host B's own lock that must order the two. Before the fix B also took FOR SHARE, found no row,
    // and replaced A's mark.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const hostA = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${kit.id} FOR SHARE`;
      await tx.workerAvailability.create({
        data: { workerId: kit.id, state: 'unavailable', reason: 'host-down', setAt: new Date(), setBy: 'host', setByHostId: 'orca1' },
      });
      ready();
      await gate;
    });
    await locked;
    let settled = false;
    const b = code(setAs(orca2, { state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' })).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await hostA;
    expect(await b).toBe('AVAILABILITY_NOT_PERMITTED');
    expect(await db.workerAvailability.findUniqueOrThrow({ where: { workerId: kit.id } })).toMatchObject({ reason: 'host-down', setByHostId: 'orca1' });
    expect(await db.agentTeamEvent.count({ where: { type: 'availability.changed' } })).toBe(0);
    expect(await db.hostKeyUse.count({ where: { action: 'availability', refusedCode: null } })).toBe(0);
  });

  it('Riana P2 (#10733): a refresh dropping the worker, in flight, fences the mark: it waits, then is refused', async () => {
    // orca1's registerHost(workers: []) in flight: its registration row FOR UPDATE and Kit's membership deleted,
    // uncommitted, locking no worker row (an empty list locks none), as the writer does.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const refresh = db.$transaction(async (tx) => {
      const [reg] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM host_registrations WHERE app_id = ${app.id} AND host_id = 'orca1' FOR UPDATE`;
      await tx.hostRegistrationWorker.deleteMany({ where: { registrationId: reg!.id } });
      ready();
      await gate;
    });
    await locked;
    let settled = false;
    const mark = code(setAs(orca1, { state: 'UNAVAILABLE', reason: 'HOST_DOWN' })).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await refresh;
    expect(await mark).toBe('WORKER_NOT_FOUND');
    expect(await db.workerAvailability.count()).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { type: 'availability.changed' } })).toBe(0);
    expect(await db.hostKeyUse.count({ where: { action: 'availability', refusedCode: null } })).toBe(0);
  });

  it('the real refresh to no workers, then a mark: refused, and no deadlock with a refresh that lists the worker', async () => {
    await register(orca1, []);
    expect(await code(setAs(orca1, { state: 'UNAVAILABLE', reason: 'HOST_DOWN' }))).toBe('WORKER_NOT_FOUND');
    // Concurrent refreshes that keep Kit and marks by the same host all settle (the lock orders never cycle).
    const runs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      i % 2 ? register(orca1, [{ worker: kit.id, family: 'claude' }]) : setAs(orca1, { state: 'UNAVAILABLE', reason: 'HOST_DOWN' })));
    for (const r of runs) {
      if (r.status === 'rejected') expect((r.reason as GraphQLError).extensions?.code).toBe('WORKER_NOT_FOUND');
    }
  });

  it('a worker the host does not register is "not found"; a person replacing a host mark clears its host', async () => {
    expect(await code(M.setHostWorkerAvailability({}, { input: { appRef: app.id, worker: ada.id, state: 'UNAVAILABLE', reason: 'HOST_DOWN' } }, keyCtx(orca1))))
      .toBe('WORKER_NOT_FOUND');
    await setAs(orca1, { state: 'UNAVAILABLE', reason: 'HOST_DOWN' });
    await M.setWorkerAvailability({}, { input: { worker: kit.id, state: 'AVAILABLE' } }, ctx(holder.id));
    expect(await db.workerAvailability.findUniqueOrThrow({ where: { workerId: kit.id } })).toMatchObject({ setBy: 'holder', setByHostId: null });
  });
});

describe('reads', () => {
  beforeEach(async () => {
    await register(orca1, [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await create(ctx(manager.id));
  });

  it('the App\'s participants and its own key read registrations and operations; an outsider reads nothing', async () => {
    expect((await Q.hostRegistrations({}, { appRef: app.id }, ctx(member.id))).map((r: any) => r.hostId)).toEqual(['orca1']);
    const page = await Q.hostOperations({}, { appRef: app.id }, ctx(member.id));
    expect(page.items).toHaveLength(1);
    expect((await Q.hostOperations({}, { appRef: app.id, status: 'SUCCEEDED' }, ctx(member.id))).items).toHaveLength(0);
    expect((await Q.hostOperations({}, { appRef: app.id }, keyCtx(plainKey))).items).toHaveLength(1);
    const outsider = await db.user.create({ data: { githubId: 999_000_000 + Math.floor(Math.random() * 1e5), githubUsername: `ho-out-${generateId()}`, roles: ['READER'] }, select: { id: true } });
    expect(await code(Q.hostOperations({}, { appRef: app.id }, ctx(outsider.id)))).toBe('APP_NOT_FOUND');
    expect(await code(Q.hostRegistrations({}, { appRef: app.id }, keyCtx(foreignKey, otherApp.id)))).toBe('APP_NOT_FOUND');
  });

  it('ruling 0 (#1894, cor:agt:070:04 S5): a host key is refused the App-wide listing; participants and non-host keys see all', async () => {
    await register(orca2, [{ worker: kit.id, family: 'claude' }]);
    const op1 = (await db.hostOperation.findFirstOrThrow({ where: { hostId: 'orca1' } })).id;
    const op2 = (await create(ctx(manager.id), { hostId: 'orca2' })).id;
    const ids = async (c: Context, extra: Record<string, unknown> = {}) =>
      (await Q.hostOperations({}, { appRef: app.id, ...extra }, c)).items.map((o: any) => o.id).sort();
    const refusal = async (c: Context, extra: Record<string, unknown>) => {
      try {
        await Q.hostOperations({}, { appRef: app.id, ...extra }, c);
      } catch (e: any) {
        return { code: e.extensions?.code, message: e.message };
      }
      return null;
    };
    // Riana's orca1/orca2 case, now refused. One refusal, whatever the key passes: its own host, another host's, a
    // cursor naming its own or another host's operation, a missing id, a bad status. Nothing in the answer depends on
    // what exists, so the refusal is no oracle for other hosts' operations.
    const asked: Record<string, unknown>[] = [
      {}, { hostId: 'orca1' }, { hostId: 'orca2' }, { hostId: 'nohost' },
      { after: op1 }, { after: op2 }, { after: generateId() }, { status: 'BOGUS' }, { worker: 'nobody' },
    ];
    const expected = await refusal(keyCtx(orca1), {});
    expect(expected?.code).toBe('FORBIDDEN');
    for (const extra of asked) {
      expect(await refusal(keyCtx(orca1), extra)).toEqual(expected);
      expect(await refusal(keyCtx(orca2), extra)).toEqual(expected);
    }
    // Controls: a participant and the App's non-host key see the whole App, as before.
    expect(await ids(ctx(member.id))).toEqual([op1, op2].sort());
    expect(await ids(keyCtx(plainKey))).toEqual([op1, op2].sort());
    expect(await ids(keyCtx(plainKey), { hostId: 'orca2' })).toEqual([op2]);
    // A key whose host:operate grant was revoked is still a host key here: revoking never opens the listing.
    await M.revokeAppKeyScope({}, { id: orca1.id, scope: 'host:operate' }, ctx(manager.id));
    expect(await refusal(keyCtx(orca1), {})).toEqual(expected);
    expect(await refusal(keyCtx(orca1), { after: op2 })).toEqual(expected);
  });

  it('ruling 0: collect stays the host key\'s way to its own operations, unchanged', async () => {
    await register(orca2, [{ worker: kit.id, family: 'claude' }]);
    const op1 = (await db.hostOperation.findFirstOrThrow({ where: { hostId: 'orca1' } })).id;
    const op2 = (await create(ctx(manager.id), { hostId: 'orca2' })).id;
    expect((await collect(orca1)).map((o: any) => o.id)).toEqual([op1]);
    expect((await collect(orca2)).map((o: any) => o.id)).toEqual([op2]);
  });

  it('cor:agt:070:07 S3: whoever manages the App reads every use of a host key; a member does not', async () => {
    const uses = await F.AppKey.hostUses({ id: orca1.id, appId: app.id }, {}, ctx(manager.id));
    expect(uses.map((u: any) => u.action)).toEqual(['register']);
    expect(await code(F.AppKey.hostUses({ id: orca1.id, appId: app.id }, {}, ctx(member.id)))).toBe('FORBIDDEN');
  });

  it('#1881: a refused use reads back with its code, and the SDL exposes it', async () => {
    expect(await code(M.registerHost({}, { input: { appRef: app.id, label: 'x', pollIntervalSeconds: 60 } }, keyCtx(orca1, app.id, { sessionId: 's1' } as any)))).toBe('APP_KEY_SESSION_BOUND');
    const uses = await F.AppKey.hostUses({ id: orca1.id, appId: app.id }, {}, ctx(manager.id));
    expect(uses.map((u: any) => [u.action, u.refusedCode]).sort()).toEqual([['register', null], ['register', 'APP_KEY_SESSION_BOUND']]);
    // The resolver returns whole rows, so the field reaches a client exactly when the SDL declares it.
    expect(/type HostKeyUse \{[^}]*\n\s*refusedCode: String\n/.exec(typeDefs)).not.toBeNull();
  });
});
