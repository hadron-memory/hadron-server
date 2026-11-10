/**
 * #3842 — `accountUsageProjection` when the history census cannot be finished (V55; cor:agt:140:02/:03, scenario S8b). The
 * loader's cap and probe budget are shrunk through a mock of `load.js` so a handful of rows exhaust them. Pinned here: the
 * UNKNOWN / HISTORY_INCOMPLETE answer, the ambiguity refusal when the probe does find a second host, qualified reads that are
 * never incomplete, the what-if and move shapes on an incomplete source or target, and the unchanged complete-census answers.
 * The gate, memory scope and what-if validation are pinned in `resolvers.accountUsageProjection3820.test.ts`.
 */import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
// A small cap and probe budget stand in for the real 20_000 / 100_000, so the exhaustion cases need a handful of rows.
const LIM = vi.hoisted(() => ({ rows: 5, budget: 6 }));
vi.mock('../../../lib/accountUsage/load.js', async (orig) => {
  const real = await orig<typeof import('../../../lib/accountUsage/load.js')>();
  return { ...real, loadAccountUsageHistory: (d: any, a: string, n: Date, acc: any) => real.loadAccountUsageHistory(d, a, n, acc, LIM.rows), loadAccountUsageCensus: (d: any, a: string, n: Date, acc: any) => real.loadAccountUsageCensus(d, a, n, acc, LIM.rows, LIM.budget) };
});

const Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(async () => { await server.stop(); await cleanDb(db); });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let org: { id: string; urn: string };
let app: { id: string };
let teamMemoryId: string;
let member: { id: string };
let agentId: string;

async function seedApp() {
  const n = Math.floor(Math.random() * 1_000_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'AU', urn: `au-${n}.example` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 700_000 + n, githubUsername: `au-m-${n}`, roles: ['READER'] } });
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } })).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  teamMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentId } })).id;
}
beforeEach(async () => { await cleanDb(db); await seedApp(); });

/** One `account-usage` object, written the way the collector does (through an ordinary session): a node with that objectType. */
async function snapshot(opts: { memoryId?: string; label: string; minutesAgo: number; sevenPct: number; resetsInHours?: number; workers?: string[]; objectType?: string; deleted?: boolean; extra?: Record<string, unknown> }) {
  const observedAt = new Date(Date.now() - opts.minutesAgo * MIN);
  const id = generateId();
  await db.node.create({
    data: {
      id, memoryId: opts.memoryId ?? teamMemoryId, name: `u-${id.slice(-6)}`, loc: `account-usage:${id}`, nodeType: 'info',
      objectType: opts.objectType ?? 'account-usage', createdAt: observedAt, deletedAt: opts.deleted ? new Date() : null,
      properties: {
        schemaVersion: 1, label: opts.label, family: 'claude', host: 'h', observedAt: observedAt.toISOString(),
        sevenDayPct: opts.sevenPct, sevenDayResetsAt: new Date(Date.now() + (opts.resetsInHours ?? 40) * HOUR).toISOString(),
        workers: opts.workers ?? ['Anne', 'Rook'], workersConfigured: true, ...opts.extra,
      },
    },
  });
}
/** A steady burn: `ratePerHour` over the last `hours`, ending at `endPct` now. */
async function burn(label: string, endPct: number, ratePerHour: number, over: Partial<Parameters<typeof snapshot>[0]> = {}) {
  for (let m = 6 * 60; m >= 0; m -= 30) await snapshot({ label, minutesAgo: m, sevenPct: endPct - (m / 60) * ratePerHour, ...over });
}


const proj2 = (args: Record<string, unknown>) => Q.accountUsageProjection({}, { appRef: app.id, ...args }, ctx(member.id));
const sevenOf = (r: any) => r.windows.find((w: any) => w.window === 'SEVEN_DAY');
/** 13 valid h1 rows (newest), `junk` malformed h3 rows, and one older valid h2 row (when `withH2`). */
async function seedCensus(label: string, junk: number, withH2: boolean) {
  await burn(label, 40, 1, { extra: { host: 'h1' } });
  for (let k = 0; k < junk; k += 1) await snapshot({ label, minutesAgo: 361 + k / 10, sevenPct: 10, extra: { host: 'h3', schemaVersion: 2 } });
  if (withH2) await snapshot({ label, minutesAgo: 400, sevenPct: 5, extra: { host: 'h2' } });
}

describe('#3842 history census exhausted is UNKNOWN / HISTORY_INCOMPLETE (V55, cor:agt:140:03 S8b)', () => {
  it('S8b: budget too small to reach the older host: every window UNKNOWN HISTORY_INCOMPLETE, nothing projected', async () => {
    LIM.rows = 5; LIM.budget = 4;
    await seedCensus('s8b', 5, true);
    const r = await proj2({ account: 's8b' });
    expect(r.windows.length).toBeGreaterThan(0);
    for (const w of r.windows) {
      expect(w).toMatchObject({ status: 'UNKNOWN', reason: 'HISTORY_INCOMPLETE', runsOutAt: null, lowPctAtReset: null, highPctAtReset: null, burn: null, perWorkerBurn: null, confidence: null, shape: null });
    }
  });
  it('a budget large enough to reach the older host finds it: the existing ambiguity refusal', async () => {
    LIM.rows = 5; LIM.budget = 10;
    await seedCensus('s8b2', 5, true);
    await expect(proj2({ account: 's8b2' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
  it('qualified reads (host and family named) on the same data are never HISTORY_INCOMPLETE', async () => {
    LIM.rows = 5; LIM.budget = 4;
    await seedCensus('s8b3', 5, true);
    const r = await proj2({ account: 's8b3', host: 'h1', family: 'claude' });
    expect(sevenOf(r)).toMatchObject({ status: 'PROJECTED', reason: null });
    expect(r.windows.some((w: any) => w.reason === 'HISTORY_INCOMPLETE')).toBe(false);
  });
  it('rows exhausted within the budget (no second host) answers as a complete census, as today', async () => {
    LIM.rows = 5; LIM.budget = 6;
    await seedCensus('done', 5, false);
    const open = await proj2({ account: 'done' });
    const named = await proj2({ account: 'done', host: 'h1', family: 'claude' });
    expect(sevenOf(open).status).not.toBe('UNKNOWN');
    expect(sevenOf(open)).toEqual(sevenOf(named));
  });
  it('rows that run out exactly at the budget are a complete census (the lookahead row decides), not incomplete', async () => {
    LIM.rows = 5; LIM.budget = 5;
    await seedCensus('edge', 5, false);
    const r = await proj2({ account: 'edge' });
    expect(r.windows.some((w: any) => w.reason === 'HISTORY_INCOMPLETE')).toBe(false);
  });
  it('finding the second host stops the probe: a budget that reaches it but not the rows after it still refuses the ambiguity', async () => {
    LIM.rows = 5; LIM.budget = 3;
    await burn('stop', 40, 1, { extra: { host: 'h1' } });
    await snapshot({ label: 'stop', minutesAgo: 361, sevenPct: 5, extra: { host: 'h2' } });
    for (let k = 0; k < 5; k += 1) await snapshot({ label: 'stop', minutesAgo: 362 + k / 10, sevenPct: 10, extra: { host: 'h3', schemaVersion: 2 } });
    await expect(proj2({ account: 'stop' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
  it('a census that fits under the cap needs no probe and answers as today, whatever the budget', async () => {
    LIM.rows = 50; LIM.budget = 1;
    await burn('fits', 40, 1);
    const r = await proj2({ account: 'fits' });
    expect(sevenOf(r)).toMatchObject({ status: 'PROJECTED', reason: null });
  });
  it('a what-if on an incomplete census answers UNKNOWN HISTORY_INCOMPLETE too, and the target of a move likewise', async () => {
    LIM.rows = 5; LIM.budget = 4;
    await seedCensus('wi', 5, true);
    const add = await proj2({ account: 'wi', whatIf: { addWorkers: 1 } });
    for (const w of add.whatIf.adjusted) expect(w).toMatchObject({ status: 'UNKNOWN', reason: 'HISTORY_INCOMPLETE' });
    await burn('dest', 20, 1, { extra: { host: 'hd' } });
    await burn('src2', 30, 1, { extra: { host: 'hs' } });
    await seedCensus('dst-amb', 5, true);
    const mv = await proj2({ account: 'src2', host: 'hs', family: 'claude', whatIf: { moveWorker: { worker: 'Anne', toAccount: 'dst-amb' } } });
    for (const w of [...mv.whatIf.target.baseline, ...mv.whatIf.target.adjusted]) expect(w).toMatchObject({ status: 'UNKNOWN', reason: 'HISTORY_INCOMPLETE' });
  });
  it('a tied createdAt cannot make the probe skip a row: rows written in the same instant are all read, the second host is found', async () => {
    LIM.rows = 2; LIM.budget = 20;
    await burn('tie', 40, 1, { extra: { host: 'h1' } });
    const at = new Date(Date.now() - 400 * MIN);
    for (let k = 0; k < 7; k += 1) {
      const id = generateId();
      await db.node.create({ data: { id, memoryId: teamMemoryId, name: `t-${k}`, loc: `account-usage:${id}`, nodeType: 'info', objectType: 'account-usage', createdAt: at,
        properties: { schemaVersion: 1, label: 'tie', family: 'claude', host: k === 3 ? 'h2' : 'h3', observedAt: at.toISOString(), sevenDayPct: 5, workers: [], workersConfigured: false, ...(k === 3 ? {} : { schemaVersion: 2 }) } } });
    }
    await expect(proj2({ account: 'tie' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
  it('a move FROM an incomplete source: no V33 or self-move refusal (no census to judge them on), source and target windows UNKNOWN', async () => {
    LIM.rows = 5; LIM.budget = 4;
    await seedCensus('srcinc', 5, true);
    await burn('tgt', 20, 1, { extra: { host: 'ht' } });
    const unknownWorker = await proj2({ account: 'srcinc', whatIf: { moveWorker: { worker: 'Nobody', toAccount: 'tgt' } } });
    for (const w of unknownWorker.whatIf.adjusted) expect(w).toMatchObject({ status: 'UNKNOWN', reason: 'HISTORY_INCOMPLETE' });
    expect(unknownWorker.whatIf.target.baseline.find((w: any) => w.window === 'SEVEN_DAY')).toMatchObject({ status: 'PROJECTED', usedPct: 20 });
    for (const w of unknownWorker.whatIf.target.adjusted) expect(w).toMatchObject({ status: 'UNKNOWN', reason: 'HISTORY_INCOMPLETE' });
    // Same label, a named host: the source identity is unresolved, so the self-move judgement is skipped, not refused.
    const self = await proj2({ account: 'srcinc', whatIf: { moveWorker: { worker: 'Anne', toAccount: 'srcinc', toHost: 'h1', toFamily: 'claude' } } });
    for (const w of self.whatIf.adjusted) expect(w).toMatchObject({ status: 'UNKNOWN', reason: 'HISTORY_INCOMPLETE' });
  });
  it('the other reasons are unchanged: no history stays NO_HISTORY, and a thin history keeps its reason', async () => {
    LIM.rows = 5; LIM.budget = 4;
    expect(sevenOf(await proj2({ account: 'nobody' }))).toMatchObject({ status: 'UNKNOWN', reason: 'NO_HISTORY' });
  });
});
