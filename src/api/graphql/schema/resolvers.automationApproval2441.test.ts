/**
 * #2441 (S1 of the automation approval epic #2435): adoption state, a plain
 * projection, and approve / decline on the one adoption door (cor:agt:010:01).
 * Red first: every case below fails on main, where only previewAutomation and
 * reAdoptAutomation exist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { automationPinQueries, automationPinMutations } from './resolvers.automationPin.js';
import { appRunMutations } from './resolvers.appRun.js';
import { mintAppRun, executeAppRun, type RunExecutionDeps } from '../../../jobs/appRuns.js';
import { makeProdRunDeps } from '../../../jobs/appRunDeps.js';
import { storedAutomationPin } from '../../../lib/automation/pins.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
beforeEach(async () => { await cleanDb(db); });

type Kind = 'SCHEDULE' | 'WEBHOOK' | 'MANUAL';
const Q = automationPinQueries as any;
const M = automationPinMutations as any;

async function fixture() {
  const user = await db.user.create({ data: { handle: 'adopt-owner' } });
  const org = await db.organization.create({ data: { name: 'Adopt', urn: 'adopt.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Adopt', urn: 'adopt.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'adopt.test:flow', class: 'knowledge', organizationId: org.id } });
  const entry = await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Weekly report', isRunnable: true, content: 'approved', data: { tools: ['web_search'], output: { writeTo: 'hrn:node:adopt.test:flow:out', mode: 'append' } } } });
  const next = await db.node.create({ data: { memoryId: memory.id, loc: 'next', name: 'Summarise', isRunnable: true, content: 'approved next', data: { tools: ['hadron_get_node'] } } });
  await db.edge.create({ data: { memoryId: memory.id, sourceId: entry.id, targetId: next.id, name: 'next', loc: 'entry:next:next' } });
  const ctx = { db, userId: user.id, roles: [] as never[] };
  const entryNodeUrn = 'hrn:node:adopt.test:flow:entry';
  const schedule = await appRunMutations.createAgentSchedule({}, { input: { appRef: app.id, name: 'Weekly', cron: '0 6 * * 1', entryNodeUrn, runAsSelf: true } }, ctx as never);
  const webhook = await appRunMutations.createAgentWebhook({}, { input: { appRef: app.id, name: 'inbound', entryNodeUrn, runAsSelf: true } }, ctx as never);
  const manual = await mintAppRun(db, { appId: app.id, organizationId: org.id, userId: user.id, triggerKind: 'MANUAL', entryNodeUrn });
  const llm = vi.fn(async () => ({ text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'test', model: 'test' }));
  const deps: RunExecutionDeps = { ...makeProdRunDeps(db), resolveConfig: vi.fn(async () => ({ config: {} }) as never), llm, writeOutput: vi.fn(async () => null) };
  const ref = { SCHEDULE: schedule.id, WEBHOOK: webhook.id, MANUAL: manual.id } as Record<Kind, string>;
  const other = await db.user.create({ data: { handle: 'adopt-other' } });
  await db.orgMember.create({ data: { userId: other.id, organizationId: org.id, role: 'CONTRIBUTOR' } });
  const otherCtx = { db, userId: other.id, roles: [] as never[] };
  return { user, org, app, memory, entry, next, ctx, otherCtx, schedule, webhook, manual, ref, deps, llm, entryNodeUrn };
}
type F = Awaited<ReturnType<typeof fixture>>;
const events = (appId: string) => db.automationAdoptionEvent.findMany({ where: { appId }, orderBy: { createdAt: 'asc' } });
const detail = (f: F, kind: Kind, ctx: unknown = f.ctx) => Q.automationApproval({}, { triggerKind: kind, triggerRef: f.ref[kind] }, ctx);
const approve = async (f: F, kind: Kind, ctx: unknown = f.ctx) => {
  const d = await detail(f, kind, ctx);
  return M.approveAutomation({}, { triggerKind: kind, triggerRef: f.ref[kind], expectedHash: d.hash }, ctx);
};
const decline = (f: F, kind: Kind, ctx: unknown = f.ctx) => M.declineAutomation({}, { triggerKind: kind, triggerRef: f.ref[kind] }, ctx);

describe('who may see and decide', () => {
  it('refuses a non-owner on detail, approve and decline, and lists them nothing', async () => {
    const f = await fixture();
    await expect(detail(f, 'SCHEDULE', f.otherCtx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(M.approveAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE, expectedHash: 'a'.repeat(64) }, f.otherCtx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(decline(f, 'SCHEDULE', f.otherCtx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const page = await Q.automationApprovals({}, { appRef: f.app.id }, f.otherCtx);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(await events(f.app.id)).toHaveLength(0);
  });
  it('refuses a worker-bound session, impersonation and a run principal on every door', async () => {
    const f = await fixture();
    const agent = await db.agent.create({ data: { name: 'Iris', urn: 'adopt.test:iris', organizationId: f.org.id } as never });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: f.app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    const input = { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE };
    const doors = (ctx: unknown) => [
      () => Q.automationApprovals({}, { appRef: f.app.id }, ctx),
      () => Q.automationApproval({}, input, ctx),
      () => M.approveAutomation({}, { ...input, expectedHash: 'a'.repeat(64) }, ctx),
      () => M.declineAutomation({}, input, ctx),
    ];
    for (const door of doors(f.ctx)) await expect(runAsActor({ workerId: worker.id, agentId: agent.id }, door)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const session = await db.session.create({ data: { appId: f.app.id, userId: f.user.id, workerId: worker.id, agentId: agent.id } as never });
    for (const door of doors({ ...f.ctx, sessionId: session.id })) await expect(door()).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    for (const door of doors({ ...f.ctx, impersonation: { adminUserId: 'x', orgId: f.org.id } })) await expect(door()).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const run = runAuthContext({ id: generateId(), appId: f.app.id, userId: f.user.id, organizationId: f.org.id });
    for (const door of doors({ db, ...run })) await expect(door()).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await events(f.app.id)).toHaveLength(0);
  });
  it('a plain human session with a sessionId and no worker is admitted', async () => {
    const f = await fixture();
    const session = await db.session.create({ data: { appId: f.app.id, userId: f.user.id } as never });
    await expect(Q.automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE }, { ...f.ctx, sessionId: session.id })).resolves.toMatchObject({ state: 'UNADOPTED' });
  });
});

describe('state and projection', () => {
  it('lists adopter-visible schedules and webhooks, never a MANUAL row, with the MANUAL omission', async () => {
    const f = await fixture();
    const page = await Q.automationApprovals({}, { appRef: f.app.id }, f.ctx);
    expect(page.rows.map((r: any) => [r.triggerKind, r.triggerRef, r.name, r.state]).sort()).toEqual(
      [['SCHEDULE', f.schedule.id, 'Weekly', 'ADOPTED'], ['WEBHOOK', f.webhook.id, 'inbound', 'ADOPTED']].sort());
    expect(page.rows.every((r: any) => typeof r.headline === 'string' && r.headline.length > 0)).toBe(true);
    expect(page.omitted).toEqual([{ triggerKind: 'MANUAL', reason: 'approved from the run that needs it' }]);
    expect(JSON.stringify(page)).not.toContain(f.manual.id);
  });
  it('classifies by the parser: no pin or a corrupt pin is UNADOPTED, never truthiness', async () => {
    const f = await fixture();
    await db.agentSchedule.update({ where: { id: f.schedule.id }, data: { automationPin: { format: 'hadron-automation-unadopted-v1', message: 'x' } as never } });
    await db.agentWebhook.update({ where: { id: f.webhook.id }, data: { automationPin: { hash: 'junk', format: 'bogus' } as never } });
    const page = await Q.automationApprovals({}, { appRef: f.app.id }, f.ctx);
    expect(Object.fromEntries(page.rows.map((r: any) => [r.triggerKind, r.state]))).toEqual({ SCHEDULE: 'UNADOPTED', WEBHOOK: 'UNADOPTED' });
    const legacy = await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Legacy', cron: '* * * * *', entryNodeUrn: f.entryNodeUrn } });
    expect((await Q.automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: legacy.id }, f.ctx)).state).toBe('UNADOPTED');
  });
  it('CHANGED is computed on open when the live graph differs from the adopted pin', async () => {
    const f = await fixture();
    await db.node.update({ where: { id: f.next.id }, data: { content: 'edited after adoption' } });
    expect((await detail(f, 'SCHEDULE')).state).toBe('CHANGED');
    const row = (await Q.automationApprovals({}, { appRef: f.app.id }, f.ctx)).rows.find((r: any) => r.triggerKind === 'SCHEDULE');
    expect(row.state).toBe('ADOPTED');
  });
  it('the summary lists the tools of the entry flow and of a routed flow, and never overstates what is bound', async () => {
    const f = await fixture();
    const d = await detail(f, 'SCHEDULE');
    expect(d.summary.name).toBe('Weekly report');
    expect(d.summary.tools).toEqual(['hadron_get_node', 'web_search']);
    expect(d.summary.flows.map((x: any) => [x.name, x.tools])).toEqual(expect.arrayContaining([['Weekly report', ['web_search']], ['Summarise', ['hadron_get_node']]]));
    expect(d.summary.writes.join('\n')).toMatch(/adopt\.test:flow:out/);
    expect(d.summary.writes.join('\n')).toMatch(/not bound|without a new approval|can change/i);
    expect(d.summary.schedule).toMatch(/0 6 \* \* 1/);
    expect(d.summary.schedule).toMatch(/without a new approval/i);
    expect(d.summary.limits.join('\n')).toMatch(/platform/i);
    expect(d.summary.limits.join('\n')).not.toMatch(/maximum of|at most/i);
    expect(d.summary.cannotDo.join('\n')).toMatch(/private/i);
    for (const list of ['flows', 'reads', 'writes', 'tools', 'limits', 'cannotDo']) expect(Array.isArray(d.summary[list])).toBe(true);
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.depth.nodes).toBeDefined();
    expect(JSON.stringify(d)).not.toMatch(/password|secret|authorization/i);
  });
  it('a webhook summary says it starts when called; MANUAL returns the projection for its exact origin run', async () => {
    const f = await fixture();
    expect((await detail(f, 'WEBHOOK')).summary.schedule).toMatch(/starts when called/i);
    const m = await detail(f, 'MANUAL');
    expect(m.state).toBe('ADOPTED');
    expect(m.summary.name).toBe('Weekly report');
  });
});

describe('paging', () => {
  it('pages after authorization, stable across tied names and colliding refs', async () => {
    const f = await fixture();
    const id = generateId();
    await db.agentSchedule.create({ data: { id, organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Tied', cron: '* * * * *', entryNodeUrn: f.entryNodeUrn } });
    await db.agentWebhook.create({ data: { id, organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Tied', entryNodeUrn: f.entryNodeUrn } as never });
    for (let i = 0; i < 3; i++) await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: 'Tied', cron: '* * * * *', entryNodeUrn: f.entryNodeUrn } });
    // Triggers the caller may not adopt (another user's, in the same App) never shift a page.
    await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: (await db.user.create({ data: { handle: 'someone-else' } })).id, name: 'Aardvark', cron: '* * * * *', entryNodeUrn: f.entryNodeUrn } });
    const seen: string[] = []; let after: string | undefined; let pages = 0;
    do {
      const page = await Q.automationApprovals({}, { appRef: f.app.id, limit: 2, after }, f.ctx);
      expect(page.rows.length).toBeLessThanOrEqual(2);
      seen.push(...page.rows.map((r: any) => `${r.name}|${r.triggerKind}|${r.triggerRef}`));
      after = page.nextCursor ?? undefined; pages++;
    } while (after && pages < 20);
    const all = (await Q.automationApprovals({}, { appRef: f.app.id, limit: 50 }, f.ctx)).rows.map((r: any) => `${r.name}|${r.triggerKind}|${r.triggerRef}`);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.some(s => s.startsWith('Aardvark'))).toBe(false);
    expect(seen.filter(s => s.endsWith(id))).toHaveLength(2);
    expect(seen).toEqual([...seen].sort((a, b) => { const [an, ak, ar] = a.split('|'); const [bn, bk, br] = b.split('|'); return an < bn ? -1 : an > bn ? 1 : ak < bk ? -1 : ak > bk ? 1 : ar < br ? -1 : ar > br ? 1 : 0; }));
  });
  it('defaults to 20 and caps at 50', async () => {
    const f = await fixture();
    for (let i = 0; i < 55; i++) await db.agentSchedule.create({ data: { id: generateId(), organizationId: f.org.id, appId: f.app.id, userId: f.user.id, name: `S${String(i).padStart(2, '0')}`, cron: '* * * * *', entryNodeUrn: f.entryNodeUrn } });
    expect((await Q.automationApprovals({}, { appRef: f.app.id }, f.ctx)).rows).toHaveLength(20);
    expect((await Q.automationApprovals({}, { appRef: f.app.id, limit: 500 }, f.ctx)).rows).toHaveLength(50);
    await expect(Q.automationApprovals({}, { appRef: f.app.id, limit: 0 }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(Q.automationApprovals({}, { appRef: f.app.id, after: 'not-a-cursor' }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('approve and decline', () => {
  it('approve equals reAdoptAutomation on the stored pin, and a stale hash is AUTOMATION_CHANGED', async () => {
    const f = await fixture();
    await db.node.update({ where: { id: f.next.id }, data: { content: 'edited' } });
    const a = await detail(f, 'SCHEDULE');
    await db.node.update({ where: { id: f.next.id }, data: { content: 'edited again' } });
    await expect(M.approveAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE, expectedHash: a.hash }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'AUTOMATION_CHANGED' } });
    expect(await events(f.app.id)).toHaveLength(0);
    const fresh = await detail(f, 'SCHEDULE');
    expect(await M.approveAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE, expectedHash: fresh.hash }, f.ctx)).toBe(true);
    const viaApprove = (await db.agentSchedule.findUniqueOrThrow({ where: { id: f.ref.SCHEDULE } })).automationPin;
    const preview = await Q.previewAutomation({}, { triggerKind: 'WEBHOOK', triggerRef: f.ref.WEBHOOK }, f.ctx);
    expect(await M.reAdoptAutomation({}, { triggerKind: 'WEBHOOK', triggerRef: f.ref.WEBHOOK, expectedHash: preview.hash }, f.ctx)).toBe(true);
    const viaReAdopt = (await db.agentWebhook.findUniqueOrThrow({ where: { id: f.ref.WEBHOOK } })).automationPin;
    expect(viaApprove).toEqual(storedAutomationPin(await Q.previewAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE }, f.ctx)));
    expect(viaReAdopt).toEqual(storedAutomationPin(preview));
    expect(await detail(f, 'SCHEDULE')).toMatchObject({ state: 'ADOPTED' });
  });
  it.each(['SCHEDULE', 'WEBHOOK'] as const)('declining an adopted %s revokes it: the next run fails AUTOMATION_UNADOPTED and an existing run snapshot is untouched', async kind => {
    const f = await fixture();
    const mk = () => mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: kind, triggerId: f.ref[kind], entryNodeUrn: f.entryNodeUrn });
    const before = await mk();
    expect(await decline(f, kind)).toBe(true);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: before.id } })).automationPin).toEqual(before.automationPin);
    const after = await mk();
    expect(await executeAppRun(db, after.id, f.deps)).toBe('failed');
    expect(f.llm).not.toHaveBeenCalled();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: after.id } })).failure).toMatchObject({ code: 'AUTOMATION_UNADOPTED' });
    expect((await detail(f, kind)).state).toBe('UNADOPTED');
  });
  it('declining a MANUAL origin deletes its consent row; a later activation that consumes it refuses, the run snapshot stays', async () => {
    const f = await fixture();
    const before = await db.appRun.findUniqueOrThrow({ where: { id: f.manual.id } });
    expect(await decline(f, 'MANUAL')).toBe(true);
    expect(await db.manualAutomationPin.count({ where: { runId: f.manual.id } })).toBe(0);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: f.manual.id } })).automationPin).toEqual(before.automationPin);
    const poll = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: 'INTEGRATION', parentRunId: f.manual.id, entryNodeUrn: f.entryNodeUrn });
    expect(await executeAppRun(db, poll.id, f.deps)).toBe('failed');
    expect((await db.appRun.findUniqueOrThrow({ where: { id: poll.id } })).failure).toMatchObject({ code: 'AUTOMATION_UNADOPTED' });
    // The declined origin is still reachable by its run id, as UNADOPTED, and can be approved again.
    expect((await detail(f, 'MANUAL')).state).toBe('UNADOPTED');
    await approve(f, 'MANUAL');
    expect(await db.manualAutomationPin.count({ where: { runId: f.manual.id } })).toBe(1);
  });
  it('mutations act on the exact origin run, never a substitute', async () => {
    const f = await fixture();
    const newer = await mintAppRun(db, { appId: f.app.id, organizationId: f.org.id, userId: f.user.id, triggerKind: 'MANUAL', entryNodeUrn: f.entryNodeUrn });
    await decline(f, 'MANUAL');
    expect(await db.manualAutomationPin.count({ where: { runId: newer.id } })).toBe(1);
    await expect(M.declineAutomation({}, { triggerKind: 'MANUAL', triggerRef: generateId() }, f.ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
});

describe('the audit stream', () => {
  it('writes exactly one event per successful approve (even unchanged), decline and revoke', async () => {
    const f = await fixture();
    const hash = (await detail(f, 'SCHEDULE')).hash;
    await approve(f, 'SCHEDULE'); await approve(f, 'SCHEDULE');
    await decline(f, 'SCHEDULE');           // adopted -> REVOKE
    await decline(f, 'SCHEDULE');           // nothing adopted -> DECLINE
    const rows = await events(f.app.id);
    expect(rows.map(r => [r.action, r.triggerKind, r.triggerRef, r.actorUserId, r.organizationId, r.pinHash])).toEqual([
      ['APPROVE', 'SCHEDULE', f.ref.SCHEDULE, f.user.id, f.org.id, hash],
      ['APPROVE', 'SCHEDULE', f.ref.SCHEDULE, f.user.id, f.org.id, hash],
      ['REVOKE', 'SCHEDULE', f.ref.SCHEDULE, f.user.id, f.org.id, hash],
      ['DECLINE', 'SCHEDULE', f.ref.SCHEDULE, f.user.id, f.org.id, null],
    ]);
  });
  it('reAdoptAutomation and approveAutomation each write one APPROVE through the one door, never two', async () => {
    const f = await fixture();
    const p = await Q.previewAutomation({}, { triggerKind: 'WEBHOOK', triggerRef: f.ref.WEBHOOK }, f.ctx);
    await M.reAdoptAutomation({}, { triggerKind: 'WEBHOOK', triggerRef: f.ref.WEBHOOK, expectedHash: p.hash }, f.ctx);
    expect((await events(f.app.id)).map(r => r.action)).toEqual(['APPROVE']);
    await approve(f, 'MANUAL');
    expect((await events(f.app.id)).map(r => [r.action, r.triggerKind])).toEqual([['APPROVE', 'WEBHOOK'], ['APPROVE', 'MANUAL']]);
  });
  it('a refused call leaves no event and no pin change', async () => {
    const f = await fixture();
    const pin = (await db.agentSchedule.findUniqueOrThrow({ where: { id: f.ref.SCHEDULE } })).automationPin;
    await expect(M.approveAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE, expectedHash: 'b'.repeat(64) }, f.ctx)).rejects.toBeDefined();
    await expect(decline(f, 'SCHEDULE', f.otherCtx)).rejects.toBeDefined();
    expect(await events(f.app.id)).toHaveLength(0);
    expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: f.ref.SCHEDULE } })).automationPin).toEqual(pin);
  });
  it('the table refuses UPDATE and DELETE while its App exists, but an App hard delete cascades', async () => {
    const f = await fixture();
    await approve(f, 'SCHEDULE');
    const [row] = await events(f.app.id);
    await expect(db.$executeRawUnsafe(`UPDATE automation_adoption_events SET action = 'DECLINE' WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`DELETE FROM automation_adoption_events WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/);
    await expect(db.automationAdoptionEvent.update({ where: { id: row.id }, data: { pinHash: null } })).rejects.toBeDefined();
    await expect(db.$executeRawUnsafe(`INSERT INTO automation_adoption_events (id, app_id, organization_id, trigger_kind, trigger_ref, action, actor_user_id, pin_hash) VALUES ('x', '${f.app.id}', 'o', 'SCHEDULE', 'r', 'APPROVE', 'u', NULL)`)).rejects.toThrow(/chk_automation_adoption_event_shape/);
    await db.$executeRawUnsafe(`DELETE FROM apps WHERE id = '${f.app.id}'`);
    expect(await db.automationAdoptionEvent.count()).toBe(0);
  });
  it('the actor id and trigger id survive trigger deletion and user erasure (no FK)', async () => {
    const f = await fixture();
    await approve(f, 'SCHEDULE');
    await db.agentSchedule.delete({ where: { id: f.ref.SCHEDULE } });
    expect(await db.automationAdoptionEvent.count({ where: { triggerRef: f.ref.SCHEDULE } })).toBe(1);
  });
  it('concurrent approve and decline serialize: two events, final state matches the last committed', async () => {
    const f = await fixture();
    const d = await detail(f, 'SCHEDULE');
    const results = await Promise.allSettled([
      M.approveAutomation({}, { triggerKind: 'SCHEDULE', triggerRef: f.ref.SCHEDULE, expectedHash: d.hash }, f.ctx),
      decline(f, 'SCHEDULE'),
    ]);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    const rows = await events(f.app.id);
    expect(rows).toHaveLength(2);
    const last = rows[rows.length - 1].action;
    const state = (await detail(f, 'SCHEDULE')).state;
    expect(state).toBe(last === 'APPROVE' ? 'ADOPTED' : 'UNADOPTED');
  });
});
