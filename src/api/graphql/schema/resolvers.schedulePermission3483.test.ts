/**
 * #3483 (AT0.4741; cor:agt:010:01 r40, cor:dmo:050:12 r39, cor:agt:080:24 r13): a worker needs a person's one-time
 * permission, or the standing grant `automations.schedule`, to create a headless trigger. Red first: on main a
 * worker-bound org ADMIN creates an ADOPTED schedule alone. Row numbers are the issue's acceptance rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { automationPinQueries, automationPinMutations } from './resolvers.automationPin.js';
import { appRunMutations, appRunQueries } from './resolvers.appRun.js';
import { resolvers, type Context } from './resolvers.js';
import { mergeUsers } from '../../../controller/operations/mergeUsers.js';
import { approvedMergeProof } from '../../../test/mergeConsent.js';
import { spendAdmission } from '../../../lib/automation/scheduleAdmission.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
beforeEach(async () => { await cleanDb(db); });

async function fixture() {
  const user = await db.user.create({ data: { handle: 'sp3483-holder' } });
  const org = await db.organization.create({ data: { name: 'Sp3483', urn: 'sp3483.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Sp3483', urn: 'sp3483.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'sp3483.test:flow', class: 'knowledge', organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Weekly', isRunnable: true, content: 'approved', data: { tools: ['web_search'] } } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'other', name: 'Other', isRunnable: true, content: 'approved' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'sp3483.test:runner', name: 'runner' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  const mk = (name: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: user.id } });
  const worker = await mk('Sched');
  const other = await mk('Rival');
  const session = (workerId: string) => db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId, userId: user.id, tool: 'vitest' } });
  const s1 = await session(worker.id);
  const s2 = await session(other.id);
  const person = { db, userId: user.id, roles: [] as never[], portalHumanUserId: user.id } as unknown as Context;
  const workerCtx = (sid: string) => ({ db, userId: user.id, roles: [] as never[], sessionId: sid }) as unknown as Context;
  const as = <T>(w: { id: string }, fn: () => Promise<T>) => runAsActor({ workerId: w.id, agentId: agent.id }, fn);
  const entry = 'hrn:node:sp3483.test:flow:entry';
  const input = { appRef: app.id, cron: '0 9 * * 1', timezone: 'UTC', entryNodeUrn: entry, runAsSelf: true, agentRef: agent.id };
  return { user, org, app, agent, worker, other, person, entry, input,
    wctx: workerCtx(s1.id), octx: workerCtx(s2.id), as };
}
type F = Awaited<ReturnType<typeof fixture>>;
const give = (f: F, c: Context = f.person, over: Record<string, unknown> = {}) =>
  M.giveSchedulePermission({}, { appRef: f.app.id, workerRef: f.worker.id, entryNodeUrn: f.entry, ...over }, c);
const wcreate = (f: F, extra: Record<string, unknown> = {}, w = f.worker, c = f.wctx) =>
  f.as(w, () => appRunMutations.createAgentSchedule({}, { input: { name: 'W', ...f.input, ...extra } as never }, c));
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ code: e.extensions?.code, message: e.message }));
const grantRow = (f: F, name = 'automations.schedule') => db.appGrant.create({ data: { appId: f.app.id, granteeWorkerId: f.worker.id, name, grantedBy: f.user.id } });
const nSchedules = () => db.agentSchedule.count();

describe('#3483 invariants file', () => {
  it('the migration carries a byte-identical copy and post-push includes it', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../../../prisma/schedule-permission-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../../prisma/migrations/20261105090000_schedule_permissions/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${source}`)).toBe(true);
    expect(readFileSync(new URL('../../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir schedule-permission-invariants.sql');
  });
});

describe('#3483 row 1: a person creates unchanged', () => {
  it('a person creates an ADOPTED schedule with no permission or grant, recording no worker', async () => {
    const f = await fixture();
    const s = await appRunMutations.createAgentSchedule({}, { input: { name: 'P', ...f.input } as never }, f.person);
    const a = await (automationPinQueries as any).automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: s.id }, f.person);
    expect(a.state).toBe('ADOPTED');
    expect(s).toMatchObject({ createdByWorkerId: null, admittedPermissionId: null, admittedGrantId: null });
  });
});

describe('#3483 rows 2-3: a person gives a one-time permission', () => {
  it('row 2: names one worker, App and entry node; expires in 10 minutes; a manager lists it', async () => {
    const f = await fixture();
    const p = await give(f);
    expect(p).toMatchObject({ appId: f.app.id, workerId: f.worker.id, entryNodeUrn: f.entry, givenBy: f.user.id, consumedAt: null });
    const ms = new Date(p.expiresAt).getTime() - new Date(p.givenAt).getTime();
    expect(ms).toBe(10 * 60 * 1000);
    const listed = await Q.schedulePermissions({}, { appRef: f.app.id }, f.person);
    expect(listed.map((x: any) => x.id)).toEqual([p.id]);
  });
  it('row 2a: the read lists live permissions only (not spent, not expired) to a manager, and refuses everyone else', async () => {
    const f = await fixture();
    const spent = await give(f);
    await wcreate(f);
    const expired = await give(f, f.person, { workerRef: f.other.id });
    await db.$executeRaw`UPDATE schedule_permissions SET given_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE id = ${expired.id}`;
    const live = await give(f, f.person, { entryNodeUrn: 'hrn:node:sp3483.test:flow:other' });
    const rows = await Q.schedulePermissions({}, { appRef: f.app.id }, f.person);
    expect(rows.map((x: any) => x.id)).toEqual([live.id]);
    expect(rows.map((x: any) => x.id)).not.toContain(spent.id);
    const m = await db.user.create({ data: { handle: 'sp3483-reader' } });
    await db.orgMember.create({ data: { organizationId: f.org.id, userId: m.id, role: 'CONTRIBUTOR' } });
    for (const c of [{ db, userId: m.id, roles: [] }, { db, roles: [] }]) {
      expect((await refusal(Q.schedulePermissions({}, { appRef: f.app.id }, c as never)))?.code).toMatch(/FORBIDDEN|UNAUTHENTICATED/);
    }
  });
  const refused: Array<[string, (f: F) => Context]> = [
    ['an API key or personal token (no portal sign-in)', f => ({ db, userId: f.user.id, roles: [], apiKeyId: 'k' }) as never],
    ['an App key', f => ({ db, appId: f.app.id, appKeyId: 'ak', roles: [] }) as never],
    ['a worker-bound session', f => ({ ...f.wctx, portalHumanUserId: f.user.id }) as never],
    ['an impersonated session', f => ({ ...f.person, impersonation: { orgId: f.org.id } }) as never],
    ['a run principal', f => ({ ...f.person, clientId: 'run:abc' }) as never],
    ['a portal id that is not the caller', f => ({ ...f.person, portalHumanUserId: generateId() }) as never],
  ];
  for (const [label, ctx] of refused) {
    it(`row 3: ${label} is refused and writes nothing`, async () => {
      const f = await fixture();
      // Only the worker-bound case runs under a worker actor; the others must be refused by their own check.
      const out = await (label.startsWith('a worker') ? f.as(f.worker, () => refusal(give(f, ctx(f)))) : refusal(give(f, ctx(f))));
      expect(out?.code).toBe('FORBIDDEN');
      expect(await db.schedulePermission.count()).toBe(0);
    });
  }
  it('row 3: a portal person who is not an org ADMIN cannot give one', async () => {
    const f = await fixture();
    const m = await db.user.create({ data: { handle: 'sp3483-member' } });
    await db.orgMember.create({ data: { userId: m.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    expect((await refusal(give(f, { db, userId: m.id, roles: [], portalHumanUserId: m.id } as never)))?.code).toBe('FORBIDDEN');
    expect(await db.schedulePermission.count()).toBe(0);
  });
  it('row 3: MCP carries no mint tool', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../../mcp/server.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/giveSchedulePermission|give_schedule_permission/);
  });
});

describe('#3483 rows 4-6, 8: a worker create', () => {
  it('row 8: with neither permission nor grant it is refused and writes nothing; an instruction claim admits nothing', async () => {
    const f = await fixture();
    expect((await refusal(wcreate(f)))?.code).toBe('FORBIDDEN');
    expect((await refusal(wcreate(f, { instruction: { kind: 'LIVE_CHAT', ref: 'client:turn-1' } })))?.code).toBe('FORBIDDEN');
    expect(await nSchedules()).toBe(0);
  });
  it('row 4: a live permission admits one create: ADOPTED, runs at its next time, records worker, holder and giver', async () => {
    const f = await fixture();
    const p = await give(f);
    const s = await wcreate(f);
    expect(s).toMatchObject({ createdByWorkerId: f.worker.id, createdBy: f.user.id, admittedPermissionId: p.id, admittedGrantId: null, enabled: true });
    expect(s.nextRunAt).not.toBeNull();
    const a = await (automationPinQueries as any).automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: s.id }, f.person);
    expect(a.state).toBe('ADOPTED');
    const row = await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ consumedKind: 'SCHEDULE', consumedId: s.id, givenBy: f.user.id });
    expect(row.consumedAt).not.toBeNull();
  });
  it('row 5: single-use — a second create is refused; two concurrent creates admit exactly one', async () => {
    const f = await fixture();
    const p = await give(f);
    await wcreate(f);
    expect((await refusal(wcreate(f)))?.code).toBe('FORBIDDEN');
    const q = await give(f);
    const results = await Promise.all([wcreate(f, { name: 'a' }), wcreate(f, { name: 'b' })].map(refusal));
    expect(results.filter(r => r === null)).toHaveLength(1);
    expect(await nSchedules()).toBe(2);
  });
  it('row 5: a refused create does not burn the permission', async () => {
    const f = await fixture();
    const p = await give(f);
    expect((await refusal(wcreate(f, { cron: 'garbage' })))?.code).toBe('BAD_USER_INPUT');
    expect((await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } })).consumedAt).toBeNull();
    await expect(wcreate(f)).resolves.toBeTruthy();
  });
  it('row 6: expired, consumed, another worker, another entry node: one byte-identical refusal (row 8\'s), nothing written', async () => {
    const f = await fixture();
    const none = await refusal(wcreate(f));
    expect(none?.code).toBe('FORBIDDEN');
    const exp = await give(f);
    await db.$executeRaw`UPDATE schedule_permissions SET given_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE id = ${exp.id}`;
    expect(await refusal(wcreate(f))).toEqual(none);
    await give(f, f.person, { workerRef: f.other.id });
    await give(f, f.person, { entryNodeUrn: 'hrn:node:sp3483.test:flow:other' });
    expect(await refusal(wcreate(f))).toEqual(none);
    expect(await nSchedules()).toBe(0);
    // A rival worker holding no permission of its own, with this worker's live permission present, is refused the same way.
    await give(f);
    const rival = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.agent.id, name: 'Third', slug: 'third', heldByUserId: f.user.id } });
    const rs = await db.session.create({ data: { id: generateId(), appId: f.app.id, agentId: f.agent.id, workerId: rival.id, userId: f.user.id, tool: 'vitest' } });
    expect(await refusal(wcreate(f, {}, rival, { db, userId: f.user.id, roles: [], sessionId: rs.id } as never))).toEqual(none);
    // The live permission is spent once; the next create is refused identically.
    await wcreate(f);
    expect(await refusal(wcreate(f, { name: 'again' }))).toEqual(none);
  });
  it('row 6a: mint is refused while one is live for the same worker and entry node; another pair is fine; an expired one does not block', async () => {
    const f = await fixture();
    const first = await give(f);
    const second = await refusal(give(f));
    expect(second?.code).toBe('BAD_USER_INPUT');
    expect(second?.message).toMatch(/already has a live permission/);
    await expect(give(f, f.person, { workerRef: f.other.id })).resolves.toBeTruthy();
    await expect(give(f, f.person, { entryNodeUrn: 'hrn:node:sp3483.test:flow:other' })).resolves.toBeTruthy();
    expect(await db.schedulePermission.count({ where: { workerId: f.worker.id, entryNodeUrn: f.entry } })).toBe(1);
    await db.$executeRaw`UPDATE schedule_permissions SET given_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE id = ${first.id}`;
    await expect(give(f)).resolves.toBeTruthy();
  });
  it('row 6a: two concurrent mints admit one', async () => {
    const f = await fixture();
    const out = await Promise.all([give(f), give(f)].map(refusal));
    expect(out.filter(r => r === null)).toHaveLength(1);
    expect(await db.schedulePermission.count({ where: { workerId: f.worker.id, entryNodeUrn: f.entry } })).toBe(1);
  });
  it('row 8: a host-launched session holding a live permission is refused; the standing grant admits it', async () => {
    const f = await fixture();
    await give(f);
    const launched = await db.session.create({ data: { id: generateId(), appId: f.app.id, agentId: f.agent.id, workerId: f.worker.id, userId: f.user.id, tool: 'vitest',
      launchHostId: 'host1', launchOperationId: 'op-' + generateId(), launchIssuedBy: 'manager' } });
    const lctx = { db, userId: f.user.id, roles: [] as never[], sessionId: launched.id } as unknown as Context;
    expect((await refusal(wcreate(f, {}, f.worker, lctx)))?.code).toBe('FORBIDDEN');
    expect((await db.schedulePermission.findFirstOrThrow()).consumedAt).toBeNull();
    expect(await nSchedules()).toBe(0);
    await grantRow(f);
    await expect(wcreate(f, {}, f.worker, lctx)).resolves.toMatchObject({ admittedGrantId: expect.any(String), admittedPermissionId: null });
  });
});

describe('#3483 row 7: the standing grant', () => {
  it('a worker holding automations.schedule creates ADOPTED, recording the grant; revoking it refuses again', async () => {
    const f = await fixture();
    const g = await grantRow(f);
    const s = await wcreate(f);
    expect(s).toMatchObject({ createdByWorkerId: f.worker.id, admittedGrantId: g.id, admittedPermissionId: null });
    await db.appGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } });
    expect((await refusal(wcreate(f)))?.code).toBe('FORBIDDEN');
  });
  it('the grant is the worker\'s own: another worker\'s grant admits nothing', async () => {
    const f = await fixture();
    await db.appGrant.create({ data: { appId: f.app.id, granteeWorkerId: f.other.id, name: 'automations.schedule', grantedBy: f.user.id } });
    expect((await refusal(wcreate(f)))?.code).toBe('FORBIDDEN');
  });
  it('AUTOMATIONS_SCHEDULE is a grantable name', async () => {
    const f = await fixture();
    const row = await M.grantApp({}, { appRef: f.app.id, workerRef: f.worker.id, name: 'AUTOMATIONS_SCHEDULE' }, f.person);
    expect(row.name).toBe('automations.schedule');
  });
});

describe('#3483 rows 9-10: the other doors', () => {
  it('row 9: a worker re-capturing update needs the same admission; a non-re-capturing edit is unchanged', async () => {
    const f = await fixture();
    const g = await grantRow(f);
    const s = await wcreate(f);
    await db.appGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } });
    const upd = (input: Record<string, unknown>) => f.as(f.worker, () => appRunMutations.updateAgentSchedule({}, { id: s.id, input } as never, f.wctx));
    expect((await refusal(upd({ entryNodeUrn: 'hrn:node:sp3483.test:flow:other' })))?.code).toBe('FORBIDDEN');
    expect((await refusal(upd({ aiConfigName: 'x' })))?.code).toBe('FORBIDDEN');
    await expect(upd({ cron: '0 10 * * 1', name: 'renamed' })).resolves.toMatchObject({ name: 'renamed' });
    const p = await give(f, f.person, { entryNodeUrn: 'hrn:node:sp3483.test:flow:other' });
    await expect(upd({ entryNodeUrn: 'hrn:node:sp3483.test:flow:other' })).resolves.toMatchObject({ entryNodeUrn: 'hrn:node:sp3483.test:flow:other', admittedPermissionId: p.id });
    expect(await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ consumedKind: 'SCHEDULE', consumedId: s.id });
  });
  it('row 9: a person\'s re-capturing update is unchanged', async () => {
    const f = await fixture();
    const s = await appRunMutations.createAgentSchedule({}, { input: { name: 'P', ...f.input } as never }, f.person);
    await expect(appRunMutations.updateAgentSchedule({}, { id: s.id, input: { aiConfigName: 'x' } } as never, f.person)).resolves.toBeTruthy();
  });
  it('row 10: a worker creates a webhook only with a permission or the grant; a person unchanged', async () => {
    const f = await fixture();
    const hook = (c: Context, extra: Record<string, unknown> = {}) => {
      const run = () => appRunMutations.createAgentWebhook({}, { input: { appRef: f.app.id, name: 'h' + generateId().slice(-6).toLowerCase(), entryNodeUrn: f.entry, agentRef: f.agent.id, runAsSelf: true, ...extra } as never }, c);
      return c === f.person ? run() : f.as(f.worker, run);
    };
    expect((await refusal(hook(f.wctx)))?.code).toBe('FORBIDDEN');
    expect(await db.agentWebhook.count()).toBe(0);
    const p = await give(f);
    const out = await hook(f.wctx);
    expect(out.webhook).toMatchObject({ createdByWorkerId: f.worker.id, admittedPermissionId: p.id });
    expect((await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } })).consumedKind).toBe('WEBHOOK');
    expect((await refusal(hook(f.wctx)))?.code).toBe('FORBIDDEN');
    await expect(hook(f.person)).resolves.toBeTruthy();
  });
});

describe('#3483 row 11: preview for a worker-bound caller', () => {
  const preview = (f: F, extra: Record<string, unknown> = {}) =>
    f.as(f.worker, () => (appRunQueries as any).previewAgentSchedule({}, { input: { ...f.input, ...extra } }, f.wctx)) as Promise<any>;
  it('without a permission or grant: a typed non-admitted outcome, no hash, nothing written', async () => {
    const f = await fixture();
    const out = await preview(f);
    expect(out).toMatchObject({ outcome: 'WORKER_NEEDS_PERMISSION', hash: null });
    expect(await nSchedules()).toBe(0);
  });
  it('with a live permission or the grant it says ADOPTABLE, and does not consume the permission', async () => {
    const f = await fixture();
    const p = await give(f);
    expect((await preview(f)).outcome).toBe('ADOPTABLE');
    expect((await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } })).consumedAt).toBeNull();
    await grantRow(f);
    expect((await preview(f)).outcome).toBe('ADOPTABLE');
  });
  it('a person\'s preview is unchanged', async () => {
    const f = await fixture();
    expect(((await (appRunQueries as any).previewAgentSchedule({}, { input: f.input }, f.person)).outcome)).toBe('ADOPTABLE');
  });
});

describe('#3483 row 12: approval doors still refuse workers', () => {
  it('approveAutomation refuses a worker-bound caller', async () => {
    const f = await fixture();
    const s = await appRunMutations.createAgentSchedule({}, { input: { name: 'P', ...f.input } as never }, f.person);
    const out = await f.as(f.worker, () => refusal((automationPinMutations as any).approveAutomation({}, { input: { triggerKind: 'SCHEDULE', triggerRef: s.id, hash: 'x' } }, f.wctx)));
    expect(out?.code).toBe('FORBIDDEN');
  });
});

describe('#3483 row 5: the spend is its own guard, inside the create\'s transaction', () => {
  const spend = (f: F, id: string, over: Record<string, string> = {}, holder: string | undefined = f.user.id) =>
    db.$transaction(tx => spendAdmission(tx as never, { kind: 'permission', workerId: over.workerId ?? f.worker.id, permissionId: id }, f.app.id, over.entry ?? f.entry, { kind: 'SCHEDULE', id: 'sched-x' }, holder)).then(() => null, (e: any) => e.extensions?.code);
  it('spends once; refuses a spent, expired, other-entry, other-worker or other-holder spend, leaving it unspent', async () => {
    const f = await fixture();
    const p = await give(f);
    expect(await spend(f, p.id, { entry: 'hrn:node:sp3483.test:flow:other' })).toBe('FORBIDDEN');
    expect(await spend(f, p.id, { workerId: f.other.id })).toBe('FORBIDDEN');
    expect(await spend(f, p.id, {}, generateId())).toBe('FORBIDDEN');
    expect((await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } })).consumedAt).toBeNull();
    await db.$executeRaw`UPDATE schedule_permissions SET given_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE id = ${p.id}`;
    expect(await spend(f, p.id)).toBe('FORBIDDEN');
    const q = await give(f);
    expect(await spend(f, q.id)).toBeNull();
    expect(await spend(f, q.id)).toBe('FORBIDDEN');
  });
});

describe('#3483 BLIND head 485ba634 findings', () => {
  it('P2-1: the consumed CHECK rejects every partial NULL shape', async () => {
    const f = await fixture();
    const shapes = [
      ['now()', 'NULL', "'x'"], ['now()', 'NULL', 'NULL'], ['now()', "'SCHEDULE'", 'NULL'],
      ['NULL', "'SCHEDULE'", "'x'"], ['NULL', 'NULL', "'x'"], ['NULL', "'SCHEDULE'", 'NULL'],
    ];
    const p = await give(f);
    for (const [at, kind, cid] of shapes) {
      await expect(db.$executeRawUnsafe(`UPDATE schedule_permissions SET consumed_at = ${at}, consumed_kind = ${kind}, consumed_id = ${cid} WHERE id = '${p.id}'`)).rejects.toThrow(/chk_schedule_permissions_consumed/);
    }
  });
  it('P2-2: a spend whose transaction started before expiry but resumes after it is refused', async () => {
    const f = await fixture();
    const p = await give(f);
    const out = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT now()`;
      await tx.$executeRaw`UPDATE schedule_permissions SET expires_at = clock_timestamp() + interval '1 second' WHERE id = ${p.id}`;
      await tx.$executeRaw`SELECT pg_sleep(1.5)`;
      return spendAdmission(tx as never, { kind: 'permission', workerId: f.worker.id, permissionId: p.id }, f.app.id, f.entry, { kind: 'SCHEDULE', id: 'sched-late' }, f.user.id).then(() => null, (e: any) => e.extensions?.code);
    });
    expect(out).toBe('FORBIDDEN');
  });

  it('Ralion P2-1: a user merge moves who gave the permission to the survivor', async () => {
    const f = await fixture();
    const p = await give(f);
    const target = await db.user.create({ data: { handle: 'sp3483-target' } });
    const admin = await db.user.create({ data: { handle: 'sp3483-merge-admin', roles: ['ADMIN'] } });
    await mergeUsers(db, { sourceUserId: f.user.id, targetUserId: target.id, actorUserId: admin.id, consentProof: await approvedMergeProof(db, f.user.id, target.id, admin.id) });
    expect((await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } })).givenBy).toBe(target.id);
  });
  it('Ralion P3-2: a spend rolls back with its transaction (the permission is not burned by a later failure)', async () => {
    const f = await fixture();
    const p = await give(f);
    await expect(db.$transaction(async (tx) => {
      await spendAdmission(tx as never, { kind: 'permission', workerId: f.worker.id, permissionId: p.id }, f.app.id, f.entry, { kind: 'SCHEDULE', id: 'sched-rb' }, f.user.id);
      throw new Error('create failed after the spend');
    })).rejects.toThrow('create failed after the spend');
    expect((await db.schedulePermission.findUniqueOrThrow({ where: { id: p.id } })).consumedAt).toBeNull();
  });
  it('Ralion P3-2: the live list never shows another App\'s permission', async () => {
    const f = await fixture();
    const mine = await give(f);
    const app2 = await db.app.create({ data: { name: 'Sp3483b', urn: 'sp3483b.test:app', organizationId: f.org.id } });
    const w2 = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app2.id, agentId: f.agent.id, name: 'Far', slug: 'far', heldByUserId: f.user.id } });
    const foreign = { id: generateId() };
    await db.$executeRaw`INSERT INTO schedule_permissions (id, app_id, worker_id, entry_node_urn, given_by, given_at, expires_at)
      VALUES (${foreign.id}, ${app2.id}, ${w2.id}, ${f.entry}, ${f.user.id}, now(), now() + interval '10 minutes')`;
    const rows = await Q.schedulePermissions({}, { appRef: f.app.id }, f.person);
    expect(rows.map((x: any) => x.id)).toEqual([mine.id]);
    expect(rows.map((x: any) => x.id)).not.toContain(foreign.id);
  });
});
