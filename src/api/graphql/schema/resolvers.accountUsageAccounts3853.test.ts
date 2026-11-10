/**
 * #3853 — Query.accountUsageAccounts: the usage accounts an App has history for (cor:agt:140:05; V64, V65).
 * Pins: listed iff the projection would find history (V9 memories, 14-day horizon on write time, validity rules);
 * one entry per label+host+family; the read gate and its byte-identical refusal are the projection's; bound + completeness;
 * order label/host/family; every entry is accepted by accountUsageProjection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { withReadableApp } from './resolvers.agentTask.js';
import { listUsageAccounts, MAX_LISTED_ACCOUNTS } from '../../../lib/accountUsage/list.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(async () => { await server.stop(); await cleanDb(db); });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let org: { id: string; urn: string };
let app: { id: string };
let teamMemoryId: string;
let member: { id: string };
let outsider: { id: string };
let agentId: string;

async function seedApp() {
  const n = Math.floor(Math.random() * 1_000_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'AL', urn: `al-${n}.example` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 700_000 + n, githubUsername: `al-m-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 800_000 + n, githubUsername: `al-o-${n}`, roles: ['READER'] } });
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } })).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  teamMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentId } })).id;
}
beforeEach(async () => { await cleanDb(db); await seedApp(); });

type Snap = { memoryId?: string; label: string; host?: string; family?: string; minutesAgo: number; createdMinutesAgo?: number; workers?: string[]; workersConfigured?: boolean; objectType?: string; deleted?: boolean; extra?: Record<string, unknown> };
async function snapshot(o: Snap) {
  const observedAt = new Date(Date.now() - o.minutesAgo * MIN);
  const created = new Date(Date.now() - (o.createdMinutesAgo ?? o.minutesAgo) * MIN);
  const id = generateId();
  await db.node.create({
    data: {
      id, memoryId: o.memoryId ?? teamMemoryId, name: `u-${id.slice(-6)}`, loc: `account-usage:${id}`, nodeType: 'info',
      objectType: o.objectType ?? 'account-usage', createdAt: created, deletedAt: o.deleted ? new Date() : null,
      properties: {
        schemaVersion: 1, label: o.label, family: o.family ?? 'claude', host: o.host ?? 'h1', observedAt: observedAt.toISOString(),
        sevenDayPct: 40, sevenDayResetsAt: new Date(Date.now() + 40 * HOUR).toISOString(),
        workers: o.workers ?? ['Anne'], workersConfigured: o.workersConfigured ?? true, ...o.extra,
      },
    },
  });
}
const listAs = (who: string | undefined, appRef: string) => Q.accountUsageAccounts({}, { appRef }, ctx(who));
const list = (who: string = member.id, appRef: string = app.id) => listAs(who, appRef);
const names = (r: any) => r.accounts.map((a: any) => `${a.account}@${a.host}/${a.family}`);
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ message: e.message, code: e.extensions?.code, ext: e.extensions }));

describe('what is listed (A1-A3, V9, V64)', () => {
  it('lists each account with label, host, family, newest snapshot time and workers; one label from two hosts is two entries', async () => {
    await snapshot({ label: 'team-a', minutesAgo: 90 });
    await snapshot({ label: 'team-a', minutesAgo: 10, workers: ['Rook', 'Anne'] });
    await snapshot({ label: 'team-b', family: 'codex', minutesAgo: 20, workersConfigured: false, workers: [] });
    await snapshot({ label: 'team-a', host: 'h2', minutesAgo: 30 });
    const r = await list();
    expect(r.complete).toBe(true);
    expect(names(r)).toEqual(['team-a@h1/claude', 'team-a@h2/claude', 'team-b@h1/codex']);
    const a1 = r.accounts[0];
    expect(a1).toMatchObject({ workers: ['Rook', 'Anne'], workersConfigured: true });
    expect(Math.abs(a1.newestSnapshotAt.getTime() - (Date.now() - 10 * MIN))).toBeLessThan(2_000);
    expect(r.accounts[2]).toMatchObject({ workers: [], workersConfigured: false });
  });

  it('never lists another App\'s memory, a free-standing memory, a deleted object or another collection (V9)', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
    const otherMemory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`, name: 'oshared', class: 'app', appId: other.id, sharedMemoryOfAgentId: agentId } });
    const free = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:free`, name: 'free', class: 'app', appId: app.id } });
    await snapshot({ label: 'x-other', minutesAgo: 5, memoryId: otherMemory.id });
    await snapshot({ label: 'x-free', minutesAgo: 5, memoryId: free.id });
    await snapshot({ label: 'x-deleted', minutesAgo: 5, deleted: true });
    await snapshot({ label: 'x-worklog', minutesAgo: 5, objectType: 'worklog' });
    expect(await list()).toMatchObject({ accounts: [], complete: true });
    await snapshot({ label: 'real', minutesAgo: 5 });
    expect(names(await list())).toEqual(['real@h1/claude']);
  });

  it('honors the 14-day horizon on write time: 15 days old is not listed, 13 days is', async () => {
    await snapshot({ label: 'old', minutesAgo: 15 * 24 * 60 });
    await snapshot({ label: 'recent', minutesAgo: 13 * 24 * 60 });
    expect(names(await list())).toEqual(['recent@h1/claude']);
  });

  it('does not list an identity whose every snapshot is invalid (schema 2, future-dated, 65-char label)', async () => {
    await snapshot({ label: 'bad-schema', minutesAgo: 5, extra: { schemaVersion: 2 } });
    await snapshot({ label: 'bad-future', minutesAgo: -10 });
    await snapshot({ label: 'x'.repeat(65), minutesAgo: 5 });
    await snapshot({ label: 'good', minutesAgo: 5 });
    await snapshot({ label: 'good', minutesAgo: 1, extra: { schemaVersion: 2 } });
    expect(names(await list())).toEqual(['good@h1/claude']);
  });

  it('a busy account does not hide a quiet one (the cap is on identities, not rows)', async () => {
    for (let i = 0; i < 30; i++) await snapshot({ label: 'busy', minutesAgo: 5 + i });
    await snapshot({ label: 'quiet', minutesAgo: 2000 });
    const r = await listUsageAccounts(db, app.id, new Date(), 2);
    expect(r.accounts.map((a) => a.account)).toEqual(['busy', 'quiet']);
  });

  // Rows that pass the SQL preconditions but fail the projection's parse: observedAt is 30 minutes in the future, written recently.
  it('the bound counts LISTABLE accounts: 51 more recent invalid identities do not hide the one valid account (LOCAL P2-F1)', async () => {
    await snapshot({ label: 'valid', minutesAgo: 900 });
    for (let i = 0; i < MAX_LISTED_ACCOUNTS + 1; i++) await snapshot({ label: `bad-${i}`, minutesAgo: -30, createdMinutesAgo: 1 + i });
    const r = await list();
    expect(names(r)).toEqual(['valid@h1/claude']);
    expect(r.complete).toBe(true);
  });

  it('an App whose every identity is invalid gets an empty COMPLETE list, however many there are (LOCAL P2-F1)', async () => {
    for (let i = 0; i < MAX_LISTED_ACCOUNTS + 1; i++) await snapshot({ label: `bad-${i}`, minutesAgo: -30, createdMinutesAgo: 1 + i });
    expect(await list()).toMatchObject({ accounts: [], complete: true });
  });

  it('with invalid identities interleaved, the most recently written VALID accounts survive and a cut is reported', async () => {
    await snapshot({ label: 'v1', minutesAgo: 10 });
    await snapshot({ label: 'bad', minutesAgo: -30, createdMinutesAgo: 20 });
    await snapshot({ label: 'v2', minutesAgo: 30 });
    await snapshot({ label: 'v3', minutesAgo: 40 });
    const r = await listUsageAccounts(db, app.id, new Date(), 2);
    expect(r.accounts.map((a) => a.account)).toEqual(['v1', 'v2']);
    expect(r.complete).toBe(false);
  });

  it('the work spent looking for valid accounts is bounded; hitting that bound says the list is incomplete', async () => {
    await snapshot({ label: 'valid', minutesAgo: 900 });
    for (let i = 0; i < 4; i++) await snapshot({ label: `bad-${i}`, minutesAgo: -30, createdMinutesAgo: 1 + i });
    const r = await listUsageAccounts(db, app.id, new Date(), 2, 3);
    expect(r.accounts).toEqual([]);
    expect(r.complete).toBe(false);
  });

  it('identities that are not listable never take a slot of the bound: foreign, deleted, other-collection and stale rows written more recently', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
    const otherMemory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`, name: 'oshared', class: 'app', appId: other.id, sharedMemoryOfAgentId: agentId } });
    await snapshot({ label: 'real', minutesAgo: 600 });
    await snapshot({ label: 'z-foreign', minutesAgo: 1, memoryId: otherMemory.id });
    await snapshot({ label: 'z-deleted', minutesAgo: 2, deleted: true });
    await snapshot({ label: 'z-worklog', minutesAgo: 3, objectType: 'worklog' });
    await snapshot({ label: 'z-stale', minutesAgo: 1, createdMinutesAgo: 15 * 24 * 60 });
    const r = await listUsageAccounts(db, app.id, new Date(), 1);
    expect(r.accounts.map((a) => a.account)).toEqual(['real']);
    expect(r.complete).toBe(true);
  });

  it('newest comes from observedAt as the projection computes it, not from write time', async () => {
    await snapshot({ label: 'skew', minutesAgo: 10, createdMinutesAgo: 100, workers: ['Newer'] });
    await snapshot({ label: 'skew', minutesAgo: 50, createdMinutesAgo: 5, workers: ['Older'] });
    const r = await list();
    expect(r.accounts[0].workers).toEqual(['Newer']);
    expect(Math.abs(r.accounts[0].newestSnapshotAt.getTime() - (Date.now() - 10 * MIN))).toBeLessThan(2_000);
  });
});

describe('bound, completeness, order (A5, V65)', () => {
  it('the bound is on identities: 3 of 4 returned incomplete; exactly 3 is complete; the most recently written survive; output is by label', async () => {
    await snapshot({ label: 'a', minutesAgo: 400 });
    await snapshot({ label: 'b', minutesAgo: 30 });
    await snapshot({ label: 'c', minutesAgo: 20 });
    await snapshot({ label: 'd', minutesAgo: 10 });
    const cut = await listUsageAccounts(db, app.id, new Date(), 3);
    expect(cut.complete).toBe(false);
    expect(cut.accounts.map((a) => a.account)).toEqual(['b', 'c', 'd']);
    await db.node.deleteMany({ where: { memoryId: teamMemoryId, properties: { path: ['label'], equals: 'a' } } });
    const all = await listUsageAccounts(db, app.id, new Date(), 3);
    expect(all.complete).toBe(true);
    expect(all.accounts).toHaveLength(3);
  });

  it('an App with no history, and an App with no team-space memory, get an empty complete list, no error', async () => {
    expect(await list()).toMatchObject({ accounts: [], complete: true });
    const bare = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Bare', urn: `${org.urn}:bare` }, select: { id: true } });
    await db.appMember.create({ data: { appId: bare.id, userId: member.id, role: 'member' } });
    expect(await list(member.id, bare.id)).toMatchObject({ accounts: [], complete: true });
  });

  it('orders by label, then host, then family', async () => {
    await snapshot({ label: 'b', minutesAgo: 1 });
    await snapshot({ label: 'a', host: 'h2', family: 'codex', minutesAgo: 2 });
    await snapshot({ label: 'a', host: 'h2', family: 'claude', minutesAgo: 3 });
    await snapshot({ label: 'a', host: 'h1', family: 'codex', minutesAgo: 4 });
    expect(names(await list())).toEqual(['a@h1/codex', 'a@h2/claude', 'a@h2/codex', 'b@h1/claude']);
  });

  it('the SDL states the bound', () => {
    const sdl = typeDefs as unknown as string;
    const at = sdl.indexOf('accountUsageAccounts(appRef');
    expect(at).toBeGreaterThan(0);
    expect(sdl.slice(Math.max(0, at - 1800), at)).toContain(`At most ${MAX_LISTED_ACCOUNTS}`);
  });
});

describe('the read gate is the projection\'s (A4, V27, V36, V58)', () => {
  it('an outsider, an unknown App and an unauthenticated caller are refused byte-identically to the projection and the roster', async () => {
    await snapshot({ label: 'team-a', minutesAgo: 5 });
    for (const [who, appRef] of [[outsider.id, app.id], [member.id, 'no-such-app'], [undefined, app.id]] as const) {
      const roster = await refusal(Q.teamAvailability({}, { appRef }, ctx(who)));
      expect(roster).not.toBeNull();
      expect(await refusal(Q.accountUsageProjection({}, { appRef, account: 'team-a' }, ctx(who)))).toEqual(roster);
      expect(await refusal(listAs(who, appRef))).toEqual(roster);
    }
  });

  it('the App\'s own key is answered; another App\'s key and a revoked key are refused as an absent App', async () => {
    await snapshot({ label: 'team-a', minutesAgo: 5 });
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
    const keyCtx = (over: Partial<Context> = {}): Context => ({ db, appId: app.id, appKeyId: key.id, roles: [], ...over });
    expect(names(await Q.accountUsageAccounts({}, { appRef: app.id }, keyCtx()))).toEqual(['team-a@h1/claude']);
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'O2', urn: `${org.urn}:o2` }, select: { id: true } });
    const absent = await refusal(Q.teamAvailability({}, { appRef: other.id }, keyCtx()));
    expect(absent).not.toBeNull();
    expect(await refusal(Q.accountUsageAccounts({}, { appRef: other.id }, keyCtx()))).toEqual(absent);
    await db.appKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    expect(await refusal(Q.accountUsageAccounts({}, { appRef: app.id }, keyCtx()))).toEqual(await refusal(Q.teamAvailability({}, { appRef: app.id }, keyCtx())));
  });

  it('a headless run that holds a live team snapshot grant is still refused, exactly as the projection refuses it', async () => {
    await snapshot({ label: 'team-a', minutesAgo: 5 });
    const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'Snap', cron: '* * * * *', entryNodeUrn: 'hrn:node:al.example:flows:report' } });
    await db.appAutomationTeamSnapshotGrant.create({ data: { id: generateId(), appId: app.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, grantedBy: member.id } });
    const run = await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, userId: null, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: 'hrn:node:al.example:flows:report', status: 'RUNNING' } });
    const runCtx = runContext(db, run);
    // the fixture is real: a read that opts in to run principals answers this run
    expect(await withReadableApp(runCtx, app.id, async () => 'ok', true)).toBe('ok');
    const proj = await refusal(Q.accountUsageProjection({}, { appRef: app.id, account: 'team-a' }, runCtx));
    expect(proj).not.toBeNull();
    expect(await refusal(Q.accountUsageAccounts({}, { appRef: app.id }, runCtx))).toEqual(proj);
  });
});

describe('round trip into the projection (A6) and the real schema', () => {
  it('every listed entry, passed back as account/host/family, is projected, with the same newest time and workers', async () => {
    await snapshot({ label: 'team-a', minutesAgo: 30 });
    await snapshot({ label: 'team-a', host: 'h2', family: 'codex', minutesAgo: 10, workers: ['Zed'] });
    const r = await list();
    expect(r.accounts).toHaveLength(2);
    for (const a of r.accounts) {
      const p = await Q.accountUsageProjection({}, { appRef: app.id, account: a.account, host: a.host, family: a.family }, ctx(member.id));
      expect(p.newestSnapshotAt).toEqual(a.newestSnapshotAt);
      expect(p.workers).toEqual(a.workers);
      expect(p.workersConfigured).toBe(a.workersConfigured);
    }
  });

  it('answers through the executable schema', async () => {
    await snapshot({ label: 'team-a', minutesAgo: 5 });
    const res = await server.executeOperation(
      { query: 'query($a:ID!){accountUsageAccounts(appRef:$a){asOf complete accounts{account host family newestSnapshotAt workers workersConfigured}}}', variables: { a: app.id } },
      { contextValue: ctx(member.id) },
    );
    const body: any = res.body;
    expect(body.kind).toBe('single');
    expect(body.singleResult.errors).toBeUndefined();
    expect(body.singleResult.data.accountUsageAccounts.accounts[0]).toMatchObject({ account: 'team-a', host: 'h1', family: 'claude' });
  });
});
