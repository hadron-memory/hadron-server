/**
 * #3483 (Grants phase 3; cor:agt:010:01 rev 46, cor:acl:140:03 / :06): with the switch on, a worker-bound session needs a
 * live, signed grant to create a schedule or webhook, or to make a schedule edit that re-captures its automation. Red on main,
 * where those doors check only for an org ADMIN, so a worker creates and adopts with no grant.
 *
 * The rows are #3483's acceptance (Bo's rows 1-11 and 13, row 12 struck) plus the gate's additions: App mismatch, an
 * agent-held grant, a base agent's grant, a departed holder, an unsigned grant, two matches charge one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { dbNowPlus, dropTestActions } from '../../../lib/grants/grantFixtures3668.js';
import {
  seedTriggerWorld, sessionOf, triggerGrant, useCount, useEvents, workerOf, type TriggerWorld,
} from '../../../lib/grants/triggerGrantFixtures3483.js';
import { appRunMutations, appRunQueries } from './resolvers.appRun.js';
import { automationPinMutations } from './resolvers.automationPin.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = appRunMutations as any;
const Q = appRunQueries as any;
const REFUSAL = { extensions: { code: 'TRIGGER_GRANT_REQUIRED' } };

let w: TriggerWorld;
beforeEach(async () => { await cleanDb(db); w = await seedTriggerWorld(); vi.stubEnv('WORKER_TRIGGER_GRANT_ENFORCED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

/** Run `fn` as the world's worker (the request actor AND a session row naming it), or as `workerId` on its own session. */
const asWorker = <T>(fn: (ctx: any) => Promise<T>, workerId = w.workerId, sessionId = w.sessionId) =>
  runAsActor({ workerId, agentId: w.agentId }, () => fn({ ...w.workerCtx, sessionId }));
const scheduleInput = (over: Record<string, unknown> = {}) => ({ appRef: w.appId, name: 'Daily', cron: '0 6 * * *', entryNodeUrn: w.entryNodeUrn, runAsSelf: true, ...over });
const createSchedule = (ctx: any, over: Record<string, unknown> = {}) => M.createAgentSchedule({}, { input: scheduleInput(over) }, ctx);
const createWebhook = (ctx: any, over: Record<string, unknown> = {}) =>
  M.createAgentWebhook({}, { input: { appRef: w.appId, name: 'inbound', entryNodeUrn: w.entryNodeUrn, runAsSelf: true, ...over } }, ctx);
const schedules = () => db.agentSchedule.count({ where: { appId: w.appId } });
const refusalOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: { message: string; extensions?: unknown }) => err);
  expect(e).toMatchObject(REFUSAL);
  return { message: e!.message, extensions: e!.extensions };
};

describe('#3483 row 1: a person\'s own create is unchanged', () => {
  it('creates and adopts with no grant, and reads no grant', async () => {
    const s = await createSchedule(w.person);
    expect(s.automationPin).toMatchObject({ entryId: w.entryNodeId });
  });
});

describe('#3483 rows 2, 3, 6: a worker needs a live single-use grant, spent with the create', () => {
  it('refuses a worker with no grant and writes nothing (an instruction claim admits nothing either)', async () => {
    await refusalOf(asWorker((ctx) => createSchedule(ctx)));
    await refusalOf(asWorker((ctx) => createSchedule({ ...ctx, instruction: { kind: 'TEAM_CHAT_MESSAGE', ref: '1' } })));
    expect(await schedules()).toBe(0);
  });

  it('admits with a single-use grant for this worker and entry node: adopted, the grant spent, one USE event', async () => {
    const g = await triggerGrant(w);
    const s: any = await asWorker((ctx) => createSchedule(ctx));
    expect(s.automationPin).toMatchObject({ entryId: w.entryNodeId });
    expect(await useCount(g)).toBe(1);
    expect(await useEvents(g)).toEqual([expect.objectContaining({ workerId: w.workerId, sessionId: w.sessionId, appId: w.appId })]);
    // Spent: a second create is refused, byte-identically to having no grant.
    const spent = await refusalOf(asWorker((ctx) => createSchedule(ctx, { name: 'Again' })));
    // The no-grant refusal, for an entry node no grant names.
    expect(spent).toEqual(await refusalOf(asWorker((ctx) => createSchedule(ctx, { entryNodeUrn: w.otherEntryNodeUrn }))));
    expect(await schedules()).toBe(1);
  });

  it('two concurrent creates on one single-use grant admit exactly one', async () => {
    const g = await triggerGrant(w);
    const results = await Promise.allSettled([
      asWorker((ctx) => createSchedule(ctx, { name: 'A' })),
      asWorker((ctx) => createSchedule(ctx, { name: 'B' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([expect.objectContaining(REFUSAL)]);
    expect(await useCount(g)).toBe(1);
    expect(await useEvents(g)).toHaveLength(1);
    expect(await schedules()).toBe(1);
  });

  it('a create refused for another reason spends nothing', async () => {
    const g = await triggerGrant(w);
    await expect(asWorker((ctx) => createSchedule(ctx, { cron: null }))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await useCount(g)).toBe(0);
    expect(await useEvents(g)).toHaveLength(0);
  });

  // Blind finding on 8f098618 (P3): the case above fails before admission. Here the act's own write fails AFTER the grant was
  // spent (a test trigger refuses the insert), and the spend and its USE event roll back with it.
  it.each([
    ['schedule', 'agent_schedules', 'schedule.create' as const, (ctx: any) => createSchedule(ctx)],
    ['webhook', 'agent_webhooks', 'webhook.create' as const, (ctx: any) => createWebhook(ctx)],
  ])('a %s write that fails after the spend rolls the spend back', async (_label, table, action, act) => {
    const g = await triggerGrant(w, { action });
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_insert_3483() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: the write fails'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER fail_insert_3483 BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_insert_3483()`);
    try {
      await expect(asWorker(act)).rejects.toThrow(/the write fails/);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER fail_insert_3483 ON ${table}`);
      await db.$executeRawUnsafe('DROP FUNCTION fail_insert_3483()');
    }
    expect(await useCount(g)).toBe(0);
    expect(await useEvents(g)).toHaveLength(0);
    // The grant is intact: the same act now succeeds and spends it.
    await asWorker(act);
    expect(await useCount(g)).toBe(1);
  });
});

describe('#3483 rows 4, 7 and the gate\'s additions: a grant that does not admit gets the no-grant refusal, byte for byte', () => {
  const misses: Array<[string, (w: TriggerWorld) => Promise<unknown>]> = [
    ['unsigned (pending)', (w) => triggerGrant(w, { activate: false })],
    ['expired', async (w) => { const g = await triggerGrant(w, { over: { expires_at: dbNowPlus('1 second') } }); await new Promise((r) => setTimeout(r, 1500)); return g; }],
    ['spent', async (w) => { const g = await triggerGrant(w); await db.$executeRawUnsafe('UPDATE grants SET use_count = 1 WHERE id = $1', g); return g; }],
    ['revoked', async (w) => { const g = await triggerGrant(w); await db.$executeRawUnsafe(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, g, w.userId); return g; }],
    ['for another worker', async (w) => triggerGrant(w, { holder: { kind: 'worker', id: await workerOf(w) } })],
    ['for another entry node', (w) => triggerGrant(w, { entryNode: w.otherEntryNodeId })],
    ['for another App', (w) => triggerGrant(w, { over: { app_id: w.app2Id } })],
    ['for the other action', (w) => triggerGrant(w, { action: 'webhook.create' })],
    ['naming the entry node by URN, not id', (w) => triggerGrant(w, { entryNode: w.entryNodeUrn })],
    ['held by a base agent of the worker\'s agent', async (w) => {
      const base = await db.agent.create({ data: { organizationId: w.orgId, name: 'base', urn: `base.${w.orgId}` } });
      await db.agent.update({ where: { id: w.agentId }, data: { extendsAgentId: base.id } as never });
      await db.appAgent.create({ data: { appId: w.appId, agentId: base.id } });
      return triggerGrant(w, { holder: { kind: 'agent', id: base.id } });
    }],
  ];
  it.each(misses)('%s', async (_label, make) => {
    const baseline = await refusalOf(asWorker((ctx) => createSchedule(ctx)));
    await make(w);
    expect(await refusalOf(asWorker((ctx) => createSchedule(ctx)))).toEqual(baseline);
    expect(await schedules()).toBe(0);
  });

  it('a departed holder (the worker retired, then a new session) is refused', async () => {
    const k = await workerOf(w);
    const s = await sessionOf(w, k);
    await triggerGrant(w, { holder: { kind: 'worker', id: k } });
    await db.worker.update({ where: { id: k }, data: { retiredAt: new Date() } });
    await db.$executeRawUnsafe(`UPDATE grants SET holder_departed_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE worker_id = $1`, k);
    await refusalOf(asWorker((ctx) => createSchedule(ctx), k, s));
  });
});

describe('#3483 row 5 and the gate\'s additions: repeating, agent-held, two matches', () => {
  it('a repeating grant admits every create and counts each use', async () => {
    const g = await triggerGrant(w, { over: { max_uses: null } });
    await asWorker((ctx) => createSchedule(ctx, { name: 'A' }));
    await asWorker((ctx) => createSchedule(ctx, { name: 'B' }));
    expect(await useCount(g)).toBe(2);
    expect(await useEvents(g)).toHaveLength(2);
  });

  it('a grant held by the worker\'s role agent admits that agent\'s live workers in the App', async () => {
    const g = await triggerGrant(w, { holder: { kind: 'agent', id: w.agentId }, over: { max_uses: null } });
    const k = await workerOf(w);
    await asWorker((ctx) => createSchedule(ctx, { name: 'A' }), k, await sessionOf(w, k));
    expect(await useEvents(g)).toEqual([expect.objectContaining({ workerId: k })]);
  });

  it('two live matches charge exactly one, the capped one first', async () => {
    const repeating = await triggerGrant(w, { over: { max_uses: null } });
    const capped = await triggerGrant(w, { over: { max_uses: 3 } });
    await asWorker((ctx) => createSchedule(ctx));
    expect([await useCount(capped), await useCount(repeating)]).toEqual([1, 0]);
  });

  it('a grant naming a list of entry nodes admits each of them', async () => {
    const g = await triggerGrant(w, { entryNode: [w.otherEntryNodeId, w.entryNodeId], over: { max_uses: null } });
    await asWorker((ctx) => createSchedule(ctx));
    expect(await useCount(g)).toBe(1);
  });
});

describe('#3483 Q17 (open, built as no): a host-launched session cannot spend a single-use grant', () => {
  it('refuses a launched session with only a single-use grant; a repeating grant admits it', async () => {
    const launched = await sessionOf(w, w.workerId, w.agentId, true);
    const single = await triggerGrant(w);
    await refusalOf(asWorker((ctx) => createSchedule(ctx), w.workerId, launched));
    expect(await useCount(single)).toBe(0);
    const repeating = await triggerGrant(w, { over: { max_uses: null } });
    await asWorker((ctx) => createSchedule(ctx), w.workerId, launched);
    expect(await useCount(repeating)).toBe(1);
  });
});

describe('#3483 row 8: an edit that re-captures needs the grant; other edits do not', () => {
  it('a name-only edit needs no grant; an entry-node edit needs one for the new entry node and spends it', async () => {
    const s = await createSchedule(w.person);
    await asWorker((ctx) => M.updateAgentSchedule({}, { id: s.id, input: { name: 'Renamed' } }, ctx));
    await refusalOf(asWorker((ctx) => M.updateAgentSchedule({}, { id: s.id, input: { entryNodeUrn: w.otherEntryNodeUrn } }, ctx)));
    expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } })).entryNodeId).toBe(w.entryNodeId);
    const g = await triggerGrant(w, { entryNode: w.otherEntryNodeId });
    await asWorker((ctx) => M.updateAgentSchedule({}, { id: s.id, input: { entryNodeUrn: w.otherEntryNodeUrn } }, ctx));
    expect(await useCount(g)).toBe(1);
    expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } })).entryNodeId).toBe(w.otherEntryNodeId);
  });

  it('an AI-configuration edit re-captures, so it needs a grant for the entry node the schedule keeps', async () => {
    const s = await createSchedule(w.person);
    await refusalOf(asWorker((ctx) => M.updateAgentSchedule({}, { id: s.id, input: { aiConfigName: 'other' } }, ctx)));
  });
});

describe('#3483 row 9: createAgentWebhook has the same admission, on webhook.create', () => {
  it('refuses with no grant or a schedule grant; admits and spends a webhook grant', async () => {
    await refusalOf(asWorker((ctx) => createWebhook(ctx)));
    await triggerGrant(w);
    await refusalOf(asWorker((ctx) => createWebhook(ctx)));
    expect(await db.agentWebhook.count({ where: { appId: w.appId } })).toBe(0);
    const g = await triggerGrant(w, { action: 'webhook.create' });
    await asWorker((ctx) => createWebhook(ctx));
    expect(await useCount(g)).toBe(1);
    expect(await useEvents(g)).toHaveLength(1);
  });
});

describe('#3483 row 10: the preview tells a worker, with no lock and no spend', () => {
  const preview = (ctx: any) => Q.previewAgentSchedule({}, { input: scheduleInput() }, ctx);
  it('answers GRANT_REQUIRED with no hash for a worker with no grant; ADOPTABLE once it holds one, which it does not spend', async () => {
    expect(await asWorker(preview)).toEqual({ outcome: 'GRANT_REQUIRED', hash: null, summary: null, reason: null });
    const g = await triggerGrant(w);
    expect(await asWorker(preview)).toMatchObject({ outcome: 'ADOPTABLE', hash: expect.any(String) });
    expect(await useCount(g)).toBe(0);
    expect(await preview(w.person)).toMatchObject({ outcome: 'ADOPTABLE' });
  });
});

describe('#3483 row 11: the adoption doors still refuse workers', () => {
  it('approve, decline and re-adopt refuse a worker even when it holds a grant', async () => {
    const s = await createSchedule(w.person);
    await triggerGrant(w, { over: { max_uses: null } });
    const ref = { triggerKind: 'SCHEDULE', triggerRef: s.id };
    for (const door of [
      (ctx: any) => (automationPinMutations as any).approveAutomation({}, { ...ref, expectedHash: 'a'.repeat(64) }, ctx),
      (ctx: any) => (automationPinMutations as any).declineAutomation({}, ref, ctx),
      (ctx: any) => (automationPinMutations as any).reAdoptAutomation({}, { ...ref, expectedHash: 'a'.repeat(64) }, ctx),
    ]) await expect(asWorker(door)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

describe('#3483 row 13: off is main, and only the exact value turns it on', () => {
  it.each([[undefined], [''], ['1'], ['TRUE'], ['True'], ['yes'], ['on'], [' true']])('WORKER_TRIGGER_GRANT_ENFORCED=%s: a worker creates with no grant', async (value) => {
    vi.unstubAllEnvs();
    if (value === undefined) delete process.env.WORKER_TRIGGER_GRANT_ENFORCED; else vi.stubEnv('WORKER_TRIGGER_GRANT_ENFORCED', value);
    const g = await triggerGrant(w);
    await asWorker((ctx) => createSchedule(ctx));
    await asWorker((ctx) => createWebhook(ctx));
    expect(await asWorker((ctx) => Q.previewAgentSchedule({}, { input: scheduleInput() }, ctx))).toMatchObject({ outcome: 'ADOPTABLE' });
    expect(await useCount(g)).toBe(0);
  });
});
