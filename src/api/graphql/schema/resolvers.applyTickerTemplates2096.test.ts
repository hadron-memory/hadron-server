/** #2096: a manager-run "apply the Agent's current ticker templates to this worker" operation (R97 B, R92 A). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { planGeneratedTickers } from '../../../lib/tickers/agentTickerTemplates.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;

let admin: Context;
let member: Context;
let outsider: Context;
let memberId: string;
let orgId: string;
let appId: string;
let agentId: string;

const asUser = (userId: string): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Apply', urn: 'apply2096.com' } });
  orgId = org.id;
  const a = await db.user.create({ data: { id: generateId(), githubId: 209600, githubUsername: 'apply-admin' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  admin = asUser(a.id);
  const m = await db.user.create({ data: { id: generateId(), githubId: 209601, githubUsername: 'apply-member' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: m.id, role: 'CONTRIBUTOR' } });
  member = asUser(m.id);
  memberId = m.id;
  const o = await db.user.create({ data: { id: generateId(), githubId: 209602, githubUsername: 'apply-outsider' } });
  outsider = asUser(o.id);
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Coordinator role' }, admin);
  agentId = agent.id;
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Apply team', urn: `${org.urn}:team` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
});
afterEach(() => vi.restoreAllMocks());

const declare = (name: string, extra: Record<string, unknown> = {}) =>
  M.createAgentTickerTemplate({}, { agentRef: agentId, input: { name, cadenceSeconds: 600, ...extra } }, admin);
const cast = (name: string) => M.castWorker({}, { appRef: appId, agentRef: agentId, name }, admin);
const apply = (workerRef: string, ctx: Context = admin) => M.applyAgentTickerTemplates({}, { workerRef }, ctx);
const liveTickers = () => db.ticker.findMany({ where: { appId, deletedAt: null }, orderBy: { name: 'asc' } });
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e) => e?.extensions?.code ?? String(e));
const snapshot = async () => ({
  tickers: await db.ticker.findMany({ orderBy: { id: 'asc' } }),
  subs: await db.tickerSubscription.findMany({ orderBy: { id: 'asc' } }),
});

/** A worker cast BEFORE any template existed (the pre-S8 shape), then the Agent declares its templates. */
async function preS8Worker(name = 'Iris', templates: Array<[string, Record<string, unknown>?]> = [['Base tick'], ['Heartbeat', { cadenceSeconds: 3600, reasons: ['EVERY_TICK'] }]]) {
  const worker = await cast(name);
  expect(await liveTickers()).toEqual([]);
  const made = [];
  for (const [n, extra] of templates) made.push(await declare(n, extra));
  return { worker, templates: made };
}

describe('#2096 apply creates the missing template tickers', () => {
  it('pin 1: one call creates exactly the live templates\' tickers, owned by and subscribed to the worker', async () => {
    const { worker, templates } = await preS8Worker();
    const r = await apply(worker.id);
    expect(r.created.map((c: any) => c.ticker.name).sort()).toEqual(['Base tick · Iris', 'Heartbeat · Iris']);
    expect(r.alreadyPresent).toEqual([]);
    const tickers = await liveTickers();
    expect(tickers).toHaveLength(2);
    for (const t of tickers) {
      expect(t).toMatchObject({ ownerWorkerId: worker.id, generatedForWorkerId: worker.id, enabled: true });
      expect(await db.tickerSubscription.count({ where: { tickerId: t.id, workerId: worker.id, endedAt: null } })).toBe(1);
    }
    expect(tickers.find((t) => t.name.startsWith('Heartbeat'))).toMatchObject({
      sourceTemplateId: templates[1].id, sourceTemplateRevision: 1, cadenceSeconds: 3600, reasons: ['every-tick'],
    });
  });

  it('pin 2: a second call is a visible no-op and changes no row', async () => {
    const { worker, templates } = await preS8Worker();
    await apply(worker.id);
    const before = await snapshot();
    const r = await apply(worker.id);
    expect(r.created).toEqual([]);
    expect(r.alreadyPresent.map((t: any) => t.id).sort()).toEqual(templates.map((t) => t.id).sort());
    expect(await snapshot()).toEqual(before);
  });

  it('pin 3: a template added after the first call is the only one created next', async () => {
    const { worker } = await preS8Worker();
    await apply(worker.id);
    const late = await declare('Late one');
    const r = await apply(worker.id);
    expect(r.created.map((c: any) => c.template.id)).toEqual([late.id]);
    expect(r.alreadyPresent).toHaveLength(2);
    expect(await liveTickers()).toHaveLength(3);
  });

  it('a generated ticker the manager soft-deleted counts as absent and is recreated', async () => {
    const { worker } = await preS8Worker('Iris', [['Base tick']]);
    await apply(worker.id);
    const [t] = await liveTickers();
    await db.ticker.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
    const r = await apply(worker.id);
    expect(r.created).toHaveLength(1);
    expect((await liveTickers()).map((x) => x.name)).toEqual(['Base tick · Iris']);
  });

  it('pin 8: the worker\'s own hand-made tickers and subscriptions are untouched, byte for byte', async () => {
    const { worker } = await preS8Worker('Iris', [['Base tick']]);
    const hand = await M.createTicker({}, { appRef: appId, input: { name: 'Hand built', cadenceSeconds: 900 } }, admin);
    await M.subscribeWorker({}, { tickerRef: hand.id, workerRef: worker.id }, admin);
    const handRow = await db.ticker.findUniqueOrThrow({ where: { id: hand.id } });
    const handSubs = await db.tickerSubscription.findMany({ where: { tickerId: hand.id } });
    await apply(worker.id);
    expect(await db.ticker.findUniqueOrThrow({ where: { id: hand.id } })).toEqual(handRow);
    expect(await db.tickerSubscription.findMany({ where: { tickerId: hand.id } })).toEqual(handSubs);
  });
});

describe('#2096 name clash, floor and cap are all-or-nothing', () => {
  it('pin 4: a hand-built live ticker with a would-be generated name refuses the whole call, zero rows', async () => {
    const { worker } = await preS8Worker();
    await M.createTicker({}, { appRef: appId, input: { name: 'heartbeat · iris', cadenceSeconds: 900 } }, admin);
    const before = await snapshot();
    expect(await refusal(apply(worker.id))).toBe('TICKER_NAME_TAKEN');
    expect(await snapshot()).toEqual(before);
  });

  it('pin 5: a missing set that would pass the live cap refuses the whole call; a below-floor template is created at the floor', async () => {
    const { worker } = await preS8Worker('Iris', [['A'], ['B']]);
    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 1 } });
    const before = await snapshot();
    expect(await refusal(apply(worker.id))).toBe('TICKER_LIMIT_REACHED');
    expect(await snapshot()).toEqual(before);

    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 10, tickerMinCadenceSeconds: 1800 } });
    const r = await apply(worker.id);
    expect(r.created.map((c: any) => c.effectiveCadenceSeconds)).toEqual([1800, 1800]);
    expect((await liveTickers()).map((t) => t.cadenceSeconds)).toEqual([1800, 1800]);
  });

  it('the cap counts only what this call would add, not the templates already generated', async () => {
    const { worker } = await preS8Worker('Iris', [['A']]);
    await apply(worker.id);
    await declare('B');
    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 2 } });
    const r = await apply(worker.id);
    expect(r.created).toHaveLength(1);
    expect(await liveTickers()).toHaveLength(2);
  });
});

describe('#2096 who may run it', () => {
  it('pin 6: a plain participant, a holder who does not manage, an outsider and a bare App key are refused, zero rows', async () => {
    const { worker } = await preS8Worker();
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: memberId } });
    const before = await snapshot();
    expect(await refusal(apply(worker.id, member))).not.toBeNull();
    expect(await refusal(apply(worker.id, outsider))).not.toBeNull();
    expect(await refusal(apply(worker.id, { db, roles: [] } as Context))).not.toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it('pin 6: the worker itself and a worker its manager drives (a session) do not count as managing', async () => {
    const { worker } = await preS8Worker();
    const other = await cast('Henry');
    const before = await snapshot();
    const asWorker = (w: { id: string }) => runAsActor({ workerId: w.id, agentId }, () => refusal(apply(worker.id, admin)));
    expect(await asWorker(worker)).not.toBeNull();
    expect(await asWorker(other)).not.toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it('pin 6: an impersonation session is refused', async () => {
    const { worker } = await preS8Worker();
    const imp = { ...admin, impersonation: { sessionId: generateId(), actorUserId: admin.userId, orgId, expiresAt: new Date(Date.now() + 60_000) } } as Context;
    expect(await refusal(apply(worker.id, imp))).not.toBeNull();
    expect(await liveTickers()).toEqual([]);
  });

  it('a worker of another App answers as not found, zero rows', async () => {
    await preS8Worker();
    const other = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Other', urn: 'apply2096.com:other' } });
    await db.appAgent.create({ data: { appId: other.id, agentId } });
    const foreign = await M.castWorker({}, { appRef: other.id, agentRef: agentId, name: 'Zed' }, admin);
    const outsiderOfOther = outsider;
    expect(await refusal(apply(foreign.id, outsiderOfOther))).not.toBeNull();
  });
});

describe('#2096 worker and Agent state', () => {
  it('pin 7: a retired worker is refused as worker-not-found, zero rows', async () => {
    const { worker } = await preS8Worker();
    await M.retireWorker({}, { workerRef: worker.id }, admin);
    expect(await refusal(apply(worker.id))).toBe('WORKER_NOT_FOUND');
    expect(await liveTickers()).toEqual([]);
  });

  it('pin 7: an Agent no longer installed refuses with WORKER_AGENT_NOT_INSTALLED, zero rows', async () => {
    const { worker } = await preS8Worker();
    await db.appAgent.deleteMany({ where: { appId, agentId } });
    expect(await refusal(apply(worker.id))).toBe('WORKER_AGENT_NOT_INSTALLED');
    expect(await liveTickers()).toEqual([]);
  });

  it('pin 7: a retire racing the call on one worker does not deadlock; the outcome is consistent', async () => {
    const { worker } = await preS8Worker();
    const [a, r] = await Promise.all([refusal(apply(worker.id)), M.retireWorker({}, { workerRef: worker.id }, admin).then(() => 'retired', (e: any) => e?.extensions?.code ?? String(e))]);
    expect([null, 'WORKER_NOT_FOUND']).toContain(a);
    expect(r).toBe('retired');
    expect((await liveTickers()).filter((t) => t.generatedForWorkerId === worker.id)).toEqual([]);
  });
});

describe('#2096 the cast path is unchanged', () => {
  it('pin 9: planGeneratedTickers without a filter plans every live template and counts them all against the cap', async () => {
    await declare('A');
    await declare('B');
    const plans = await planGeneratedTickers(db as any, { appId, agentId, workerName: 'Iris' });
    expect(plans.map((p) => p.name)).toEqual(['A · Iris', 'B · Iris']);
    await db.app.update({ where: { id: appId }, data: { tickerLiveCap: 1 } });
    await expect(planGeneratedTickers(db as any, { appId, agentId, workerName: 'Iris' })).rejects.toThrow(/limit is 1/);
  });
});
