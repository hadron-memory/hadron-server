/**
 * #3820 — Query.accountUsageProjection over the real schema. The projection arithmetic is pinned in
 * `src/lib/accountUsage/projection3820.test.ts`; this file pins what only the resolver decides:
 *  - the read gate is the one the team's tasks and events are read through (cor:agt:140:03, V27, V36): participants and the App's
 *    own key, and anyone else is refused APP_NOT_FOUND exactly as for an App that does not exist;
 *  - the history comes ONLY from `account-usage` objects in the App's own team-space memory (V9): not another App's, not a
 *    free-standing memory's, not a deleted object, not another collection;
 *  - a what-if is validated after the gate, exactly one of its two forms, and the answer is advisory (it writes nothing).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

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
let outsider: { id: string };
let agentId: string;

async function seedApp() {
  const n = Math.floor(Math.random() * 1_000_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'AU', urn: `au-${n}.example` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 700_000 + n, githubUsername: `au-m-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 800_000 + n, githubUsername: `au-o-${n}`, roles: ['READER'] } });
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
const proj = (account: string, whatIf?: unknown, who = member.id, appRef = app.id) => Q.accountUsageProjection({}, { appRef, account, whatIf }, ctx(who));
const seven = (r: any) => r.windows.find((w: any) => w.window === 'SEVEN_DAY');

describe('the history source (V9)', () => {
  it('projects from the team space memory and answers PROJECTED with a range', async () => {
    await burn('team-a', 40, 1);
    const r = await proj('team-a');
    expect(r).toMatchObject({ account: 'team-a', family: 'claude', workers: ['Anne', 'Rook'], workersConfigured: true });
    expect(seven(r)).toMatchObject({ status: 'PROJECTED', usedPct: 40, burn: { lowPctPerHour: 1, highPctPerHour: 1 }, perWorkerBurn: { lowPctPerHour: 0.5 } });
    expect(r.windows.map((w: any) => w.window)).toEqual(['FIVE_HOUR', 'SEVEN_DAY']);
    expect(r.whatIf).toBeNull();
  });

  it('reads nothing from another App, a free-standing memory, a deleted object or another collection', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
    const otherMemory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`, name: 'oshared', class: 'app', appId: other.id, sharedMemoryOfAgentId: agentId } });
    const free = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:free`, name: 'free', class: 'app', appId: app.id } });
    await burn('team-a', 40, 1, { memoryId: otherMemory.id });
    await burn('team-a', 40, 1, { memoryId: free.id });
    await burn('team-a', 40, 1, { deleted: true });
    await burn('team-a', 40, 1, { objectType: 'worklog' });
    const r = await proj('team-a');
    expect(seven(r)).toMatchObject({ status: 'UNKNOWN', reason: 'NO_HISTORY' });
    expect(r.newestSnapshotAt).toBeNull();
    // and the same label's real history, once written, is the only thing that answers
    await burn('team-a', 40, 1);
    expect(seven(await proj('team-a')).status).toBe('PROJECTED');
  });

  it('skips a malformed or future-dated record rather than failing the read', async () => {
    await burn('team-a', 40, 1);
    await snapshot({ label: 'team-a', minutesAgo: -30, sevenPct: 99 }); // 30 minutes in the future
    await snapshot({ label: 'team-a', minutesAgo: 1, sevenPct: 140 }); // out of range
    await snapshot({ label: 'team-a', minutesAgo: 1, sevenPct: 50, extra: { schemaVersion: 9 } });
    const w = seven(await proj('team-a'));
    expect(w).toMatchObject({ status: 'PROJECTED', usedPct: 40 });
  });

  it('an account with no history, or only stale history, is UNKNOWN and no error', async () => {
    expect(seven(await proj('nobody'))).toMatchObject({ status: 'UNKNOWN', reason: 'NO_HISTORY' });
    for (let m = 400; m >= 300; m -= 30) await snapshot({ label: 'old', minutesAgo: m, sevenPct: 40 + (400 - m) / 100 });
    expect(seven(await proj('old'))).toMatchObject({ status: 'UNKNOWN', reason: 'STALE', lowPctAtReset: null });
  });
});

describe('the read gate is the team reads\' (V27, V36)', () => {
  const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ message: e.message, code: e.extensions?.code, ext: e.extensions }));

  it('a person outside the App is refused exactly as the team reads refuse them', async () => {
    await burn('team-a', 40, 1);
    const roster = await refusal(Q.teamAvailability({}, { appRef: app.id }, ctx(outsider.id)));
    const usage = await refusal(proj('team-a', undefined, outsider.id));
    expect(roster).not.toBeNull();
    expect(usage).toEqual(roster);
  });

  it('an unknown App, and an unauthenticated caller, are refused as the roster refuses them', async () => {
    const roster = await refusal(Q.teamAvailability({}, { appRef: 'no-such-app' }, ctx(member.id)));
    expect(await refusal(proj('team-a', undefined, member.id, 'no-such-app'))).toEqual(roster);
    const rosterAnon = await refusal(Q.teamAvailability({}, { appRef: app.id }, ctx(undefined)));
    expect(rosterAnon).not.toBeNull();
    expect(await refusal(Q.accountUsageProjection({}, { appRef: app.id, account: 'team-a' }, ctx(undefined)))).toEqual(rosterAnon);
  });

  it('a malformed what-if from a caller outside the App is still the roster refusal, not a bad-input answer', async () => {
    const roster = await refusal(Q.teamAvailability({}, { appRef: app.id }, ctx(outsider.id)));
    expect(await refusal(proj('team-a', { addWorkers: 1, moveWorker: { worker: 'x', toAccount: 'y' } }, outsider.id))).toEqual(roster);
  });

  it('a participant reads it', async () => {
    await burn('team-a', 40, 1);
    expect(seven(await proj('team-a', undefined, member.id)).status).toBe('PROJECTED');
  });

  it('the App\'s own key reads its own App; another App\'s key, a revoked key and no credential are refused as an absent App (V36)', async () => {
    await burn('team-a', 40, 1);
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
    const keyCtx = (over: Partial<Context> = {}): Context => ({ db, appId: app.id, appKeyId: key.id, roles: [], ...over });
    const r = await Q.accountUsageProjection({}, { appRef: app.id, account: 'team-a' }, keyCtx());
    expect(seven(r).status).toBe('PROJECTED');
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'O2', urn: `${org.urn}:o2` }, select: { id: true } });
    const absent = await refusal(Q.teamAvailability({}, { appRef: other.id }, keyCtx()));
    expect(absent).not.toBeNull();
    expect(await refusal(Q.accountUsageProjection({}, { appRef: other.id, account: 'team-a' }, keyCtx()))).toEqual(absent);
    await db.appKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    expect(await refusal(Q.accountUsageProjection({}, { appRef: app.id, account: 'team-a' }, keyCtx()))).toEqual(
      await refusal(Q.teamAvailability({}, { appRef: app.id }, keyCtx())),
    );
  });
});

describe('what-ifs', () => {
  it('addWorkers: 1 raises the burn by the per-worker estimate; nothing is written', async () => {
    await burn('team-a', 30, 1);
    const before = await db.node.count();
    const r = await proj('team-a', { addWorkers: 1 });
    expect(seven(r).burn).toEqual({ lowPctPerHour: 1, highPctPerHour: 1 });
    const adjusted = r.whatIf.adjusted.find((w: any) => w.window === 'SEVEN_DAY');
    expect(adjusted.burn).toEqual({ lowPctPerHour: 1.5, highPctPerHour: 1.5 });
    expect(adjusted.highPctAtReset).toBeGreaterThan(seven(r).highPctAtReset);
    expect(r.whatIf.target).toBeNull();
    expect(await db.node.count()).toBe(before);
  });

  it('moveWorker lowers the source and raises the target', async () => {
    await burn('src', 30, 1, { workers: ['Anne', 'Rook'] });
    await burn('tgt', 30, 2, { workers: ['Kit'] });
    const r = await proj('src', { moveWorker: { worker: 'Anne', toAccount: 'tgt' } });
    const src = r.whatIf.adjusted.find((w: any) => w.window === 'SEVEN_DAY');
    expect(src.burn).toEqual({ lowPctPerHour: 0.5, highPctPerHour: 0.5 });
    expect(src.highPctAtReset).toBeLessThan(seven(r).highPctAtReset);
    const t = r.whatIf.target;
    expect(t.account).toBe('tgt');
    const tBase = t.baseline.find((w: any) => w.window === 'SEVEN_DAY');
    const tAdj = t.adjusted.find((w: any) => w.window === 'SEVEN_DAY');
    expect(tBase.burn).toEqual({ lowPctPerHour: 2, highPctPerHour: 2 });
    expect(tAdj.burn).toEqual({ lowPctPerHour: 2.5, highPctPerHour: 2.5 });
  });

  it('an add on an account with no history is UNKNOWN, not an error; moving a worker an account does not list is refused (V33)', async () => {
    const none = await proj('nobody', { addWorkers: 1 });
    expect(none.whatIf.adjusted[1]).toMatchObject({ status: 'UNKNOWN', reason: 'NO_HISTORY' });
    await burn('src', 30, 1);
    await expect(proj('src', { moveWorker: { worker: 'Nobody', toAccount: 'tgt' } })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(proj('nobody', { moveWorker: { worker: 'Anne', toAccount: 'tgt' } })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('an account with no workers configured has no per-worker estimate and a what-if on it is UNKNOWN (V28)', async () => {
    await burn('bare', 30, 1, { workers: [], extra: { workersConfigured: false } });
    const r = await proj('bare', { addWorkers: 1 });
    expect(seven(r).perWorkerBurn).toBeNull();
    expect(r.whatIf.adjusted[1]).toMatchObject({ status: 'UNKNOWN', reason: 'NO_WORKERS_CONFIGURED' });
  });

  it('refuses both forms, neither form given, a count outside 1 to 50, and a move onto itself', async () => {
    await burn('src', 30, 1);
    for (const bad of [{}, { addWorkers: 1, moveWorker: { worker: 'Anne', toAccount: 'tgt' } }, { addWorkers: 0 }, { addWorkers: 51 }, { moveWorker: { worker: 'Anne', toAccount: 'src' } }]) {
      await expect(proj('src', bad)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
  });
});

describe('a newer observation with no window reading and no workers', () => {
  it('makes the baseline and the add-worker what-if UNKNOWN, never a revived older answer', async () => {
    await burn('acct', 40, 1);
    await snapshot({ label: 'acct', minutesAgo: 0, sevenPct: 0, workers: [], extra: { sevenDayPct: null, sevenDayResetsAt: null } });
    const r = await proj('acct', { addWorkers: 1 });
    expect(seven(r)).toMatchObject({ status: 'UNKNOWN', reason: 'NO_WINDOW' });
    expect(r.workers).toEqual([]);
    expect(r.whatIf.adjusted.find((w: any) => w.window === 'SEVEN_DAY')).toMatchObject({ status: 'UNKNOWN' });
  });
});

describe('self-moves judged on the resolved identity, and the per-account history bound', () => {
  it('a move naming the source own host and family is refused; the same label on another host is a valid move', async () => {
    await burn('src', 30, 1);
    await expect(proj('src', { moveWorker: { worker: 'Anne', toAccount: 'src', toHost: 'h', toFamily: 'claude' } })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const ok = await proj('src', { moveWorker: { worker: 'Anne', toAccount: 'src', toHost: 'other-host' } });
    expect(ok.whatIf.target.account).toBe('src');
  });
  it('unrelated accounts and other hosts of the same label, all newer than the row cap, cannot crowd the selected identity out', async () => {
    const { loadAccountUsageHistory } = await import('../../../lib/accountUsage/load.js');
    await burn('mine', 40, 1, { extra: { host: 'h1' } });
    for (let m = 0; m < 40; m += 1) await snapshot({ label: 'noise', minutesAgo: m / 10, sevenPct: 10 });
    for (let m = 0; m < 40; m += 1) await snapshot({ label: 'mine', minutesAgo: m / 10, sevenPct: 10, extra: { host: 'h2' } });
    const [got] = await loadAccountUsageHistory(db as any, app.id, new Date(), [{ label: 'mine', host: 'h1' }], 5);
    expect(got!.length).toBe(5);
    expect(new Set(got!.map((x) => x.host))).toEqual(new Set(['h1']));
  });
  it('an unqualified read whose cap a busy host fills still sees the other host, so the ambiguity is refused, not masked', async () => {
    const { loadAccountUsageHistory } = await import('../../../lib/accountUsage/load.js');
    await snapshot({ label: 'amb', minutesAgo: 200, sevenPct: 5, extra: { host: 'h2' } });
    for (let m = 0; m < 10; m += 1) await snapshot({ label: 'amb', minutesAgo: m, sevenPct: 10, extra: { host: 'h1' } });
    const [got] = await loadAccountUsageHistory(db as any, app.id, new Date(), [{ label: 'amb' }], 5);
    expect(new Set(got!.map((x) => x.host))).toEqual(new Set(['h1', 'h2']));
  });
  it('malformed rows cannot mask the probe: an invalid newest row and invalid one-shot alternates still reveal the valid other host', async () => {
    const { loadAccountUsageHistory } = await import('../../../lib/accountUsage/load.js');
    await snapshot({ label: 'amb2', minutesAgo: 200, sevenPct: 5, extra: { host: 'h2' } });
    for (let m = 1; m < 10; m += 1) await snapshot({ label: 'amb2', minutesAgo: m, sevenPct: 10, extra: { host: 'h1' } });
    for (let m = 0; m < 3; m += 1) await snapshot({ label: 'amb2', minutesAgo: m / 10, sevenPct: 10, extra: { host: 'h3', schemaVersion: 2 } });
    const [got] = await loadAccountUsageHistory(db as any, app.id, new Date(), [{ label: 'amb2' }], 5);
    expect(new Set(got!.map((x) => x.host))).toEqual(new Set(['h1', 'h2']));
  });
  it('#3842: an all-malformed alternate page at >= cap no longer hides an older valid host: the probe pages past it, or reports the census unfinished', async () => {
    const { loadAccountUsageCensus } = await import('../../../lib/accountUsage/load.js');
    await snapshot({ label: 'lim', minutesAgo: 300, sevenPct: 5, extra: { host: 'h2' } });
    for (let m = 1; m <= 10; m += 1) await snapshot({ label: 'lim', minutesAgo: m, sevenPct: 10, extra: { host: 'h1' } });
    for (let m = 0; m < 5; m += 1) await snapshot({ label: 'lim', minutesAgo: 20 + m, sevenPct: 10, extra: { host: 'h3', schemaVersion: 2 } });
    const [found] = await loadAccountUsageCensus(db as any, app.id, new Date(), [{ label: 'lim' }], 5, 100);
    expect(found!.incomplete).toBe(false);
    expect(new Set(found!.snaps.map((x) => x.host))).toEqual(new Set(['h1', 'h2']));
    const [cut] = await loadAccountUsageCensus(db as any, app.id, new Date(), [{ label: 'lim' }], 5, 5);
    expect(cut!.incomplete).toBe(true);
    expect(new Set(cut!.snaps.map((x) => x.host))).toEqual(new Set(['h1']));
  });
  it('a same-label move to another host reads that host own history, apart from the source', async () => {
    await burn('src', 30, 1, { extra: { host: 'h1' } });
    await burn('src', 20, 2, { extra: { host: 'h2' } });
    const r = await Q.accountUsageProjection({}, { appRef: app.id, account: 'src', host: 'h1', whatIf: { moveWorker: { worker: 'Anne', toAccount: 'src', toHost: 'h2' } } }, ctx(member.id));
    expect(seven(r)).toMatchObject({ usedPct: 30 });
    expect(r.whatIf.target.baseline.find((w: any) => w.window === 'SEVEN_DAY')).toMatchObject({ status: 'PROJECTED', usedPct: 20 });
  });
});

describe('an account is its label, host and family (cor:agt:140:01)', () => {
  it('a label two hosts wrote is refused as ambiguous unless the caller names the host; naming it answers from that host only', async () => {
    await burn('team-a', 40, 1, { extra: { host: 'h1' } });
    await burn('team-a', 20, 2, { extra: { host: 'h2' } });
    await expect(proj('team-a')).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const one = await Q.accountUsageProjection({}, { appRef: app.id, account: 'team-a', host: 'h2' }, ctx(member.id));
    expect(seven(one)).toMatchObject({ usedPct: 20, burn: { lowPctPerHour: 2, highPctPerHour: 2 } });
    expect(one.host).toBe('h2');
  });
});

describe('windows of another length (V29)', () => {
  it('a family whose newest snapshot reports a window of another length gets that window, with its length, beside the two standard ones', async () => {
    const reset = new Date(Date.now() + 1 * HOUR).toISOString();
    for (let m = 240; m >= 0; m -= 30) {
      await snapshot({ label: 'odd', minutesAgo: m, sevenPct: 0, extra: { sevenDayPct: undefined, sevenDayResetsAt: undefined, primaryPct: 30 - m / 60, primaryMinutes: 1440, primaryResetsAt: reset } });
    }
    const r = await proj('odd');
    expect(r.windows.map((w: any) => [w.window, w.lengthMinutes, w.status])).toEqual([
      ['FIVE_HOUR', 300, 'UNKNOWN'], ['OTHER', 1440, 'PROJECTED'], ['SEVEN_DAY', 10080, 'UNKNOWN'],
    ]);
  });
});

describe('over the real schema', () => {
  it('is a Query field that selects the documented shape', async () => {
    await burn('team-a', 40, 1);
    const res = await server.executeOperation(
      { query: 'query($a:ID!,$n:String!){accountUsageProjection(appRef:$a,account:$n,whatIf:{addWorkers:1}){account asOf windows{window status reason usedPct lowPctAtReset highPctAtReset confidence shape runsOutAt ceilingPct burn{lowPctPerHour highPctPerHour}} whatIf{adjusted{window status}}}}', variables: { a: app.id, n: 'team-a' } },
      { contextValue: ctx(member.id) },
    );
    if (res.body.kind !== 'single') throw new Error('incremental');
    const out = JSON.parse(JSON.stringify(res.body.singleResult));
    expect(out.errors).toBeUndefined();
    expect(out.data.accountUsageProjection.windows[1]).toMatchObject({ window: 'SEVEN_DAY', status: 'PROJECTED', ceilingPct: 85, confidence: 'HIGH', shape: 'FLAT' });
    expect(out.data.accountUsageProjection.whatIf.adjusted).toHaveLength(2);
  });
});
