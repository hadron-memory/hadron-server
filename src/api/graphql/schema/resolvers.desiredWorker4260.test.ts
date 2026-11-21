/**
 * #4260 — the targeted desired-worker read: an optional worker selector on hostDesiredState that returns only the
 * selected worker's row from the host's own list, with the same gates, refusals, key-use recording and row semantics
 * as the host-wide read.
 *
 * THE CONCEALMENT RULE (Victor's FIT, cor:agt:070:04 with cor:agt:020:08): a worker this host does not run — another
 * host's, a retired worker not on this host, or an unknown id or name — answers EXACTLY like an unknown worker: the
 * same empty workers list, with no distinguishing code, message or metadata. A retired worker this host still lists
 * keeps its row (that is the row parity the host-wide read already gives).
 *
 * Cast: mirrors resolvers.desiredState4224.test.ts. Ada (LONG_LIVED) and Kit (SHORT_LIVED) on orca1; Zoe
 * (SHORT_LIVED) on orca2 — Zoe is the off-host worker. Sweep mode OBSERVE unless a test says otherwise.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { declareAllStopLanes } from '../../../test/stopLanes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let longAgentId: string;
let shortAgentId: string;
let app: { id: string; urn: string };
let ada: { id: string };
let kit: { id: string };
let zoe: { id: string };
let orca1: { id: string };
let orca2: { id: string };
let plainKey: { id: string };
let revokedScopeKey: { id: string };

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra } as Context);
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;

async function refusal(p: Promise<unknown>): Promise<{ message: string; extensions: Record<string, unknown> }> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return { message: (e as GraphQLError).message, extensions: (e as GraphQLError).extensions as Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}
const code = async (p: Promise<unknown>) => (await refusal(p)).extensions.code;

type Row = {
  workerId: string; name: string; lifecycle: string; desired: string | null; reason: string;
  wouldBe: string | null; wouldBeReason: string | null; openSessionId: string | null; family: string; worktrees: string[];
};
type State = { hostId: string; sweepMode: string; workers: Row[] };
/** The host read, with the #4260 selector when given (undefined = the host-wide discovery read). */
const state = (hostId = 'orca1', worker?: string, c: Context = ctx(admin.id)) =>
  Q.hostDesiredState({}, { appRef: app.id, hostId, ...(worker !== undefined ? { worker } : {}) }, c) as Promise<State>;
const rowOf = async (wide: State, w: { id: string }): Promise<Row> => {
  const r = wide.workers.find((x) => x.workerId === w.id);
  if (!r) throw new Error('worker not in the host-wide answer');
  return r;
};

const sweep = (mode: string, c: Context = ctx(admin.id)) => M.setAppSweepMode({}, { appRef: app.id, mode }, c);
const leaveAlone = (w: { id: string }, on: boolean, c: Context = ctx(admin.id), reason?: string) =>
  M.setWorkerLeaveAlone({}, { input: { worker: w.id, leaveAlone: on, ...(reason !== undefined ? { reason } : {}) } }, c);
const task = (assignee: { id: string }, status: 'pending' | 'started' = 'pending') =>
  db.agentTask.create({
    data: {
      appId: app.id, title: 'A task', ownerUserId: admin.id, assigneeWorkerId: assignee.id, status, assignedAt: new Date(),
      ...(status !== 'pending' ? { startedAt: new Date() } : {}),
    },
    select: { id: true },
  });
const retire = (w: { id: string }) => db.worker.update({ where: { id: w.id }, data: { retiredAt: new Date() }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'ds', urn: `ds4260-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 42_260_000 + k * 1000 + (n % 1000), githubUsername: `dw-${name}-${n}`, handle: `dw-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  member = await u(2, 'member');
  outsider = await u(3, 'outsider');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  longAgentId = (await M.createAgent({}, { orgRef: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  shortAgentId = (await M.createAgent({}, { orgRef: org.id, name: 'Builder', lifecycle: 'SHORT_LIVED' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const w = (agentId: string, name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: member.id, heldAt: new Date() }, select: { id: true } });
  ada = await w(longAgentId, 'Ada');
  kit = await w(shortAgentId, 'Kit');
  zoe = await w(shortAgentId, 'Zoe');
  const mkKey = (label: string) =>
    db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd', label }, select: { id: true } });
  orca1 = await mkKey('orca1');
  orca2 = await mkKey('orca2');
  plainKey = await mkKey('plain');
  revokedScopeKey = await mkKey('revoked-scope');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: revokedScopeKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.revokeAppKeyScope({}, { id: revokedScopeKey.id, scope: 'host:operate' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [
    { worker: ada.id, family: 'claude', worktrees: ['hadron-server/ada'] },
    { worker: kit.id, family: 'codex', worktrees: ['hadron-server/kit', 'hadron-cli/kit'] },
  ] } }, keyCtx(orca1));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: zoe.id, family: 'claude' }] } }, keyCtx(orca2));
  await declareAllStopLanes(db, app.id);
  await sweep('OBSERVE');
});

describe('#4260 targeted desired-worker read: the selected row', () => {
  it("returns only the selected worker's row, field for field the row the host-wide read returns", async () => {
    const s = await db.session.create({
      data: { id: generateId(), appId: app.id, workerId: ada.id, agentId: longAgentId, userId: member.id, startedAt: new Date(), updatedAt: new Date() },
      select: { id: true },
    });
    const wide = await state();
    const selAda = await state('orca1', ada.id);
    expect(selAda.hostId).toBe('orca1');
    expect(selAda.sweepMode).toBe(wide.sweepMode);
    expect(selAda.workers).toHaveLength(1);
    expect(selAda.workers[0]).toEqual(await rowOf(wide, ada));
    expect(selAda.workers[0].openSessionId).toBe(s.id);
    expect(selAda.workers[0].family).toBe('claude');
    expect(selAda.workers[0].worktrees).toEqual(['hadron-server/ada']);
    // The no-open-session row parity: Kit has none.
    const selKit = await state('orca1', kit.id);
    expect(selKit.workers).toHaveLength(1);
    expect(selKit.workers[0]).toEqual(await rowOf(wide, kit));
    expect(selKit.workers[0].openSessionId).toBeNull();
    // The host-wide discovery read is unchanged when no selector is given.
    expect(wide.workers.map((r) => r.name)).toEqual(['Ada', 'Kit']);
  });

  it('selects by exact name too, the same row as by id', async () => {
    const byId = await state('orca1', ada.id);
    const byName = await state('orca1', 'Ada');
    expect(byName.workers).toHaveLength(1);
    expect(byName.workers).toEqual(byId.workers);
  });

  it('a whitespace-only selector is no selector: the full host-wide list returns', async () => {
    const blank = await state('orca1', '   ');
    const wide = await state();
    expect(blank.workers.map((r) => r.name)).toEqual(['Ada', 'Kit']);
    expect(blank.sweepMode).toBe(wide.sweepMode);
  });

  it('a retired worker this host still lists keeps its row, retired, exactly as the host-wide read shows it', async () => {
    await retire(ada);
    const wide = await state();
    const sel = await state('orca1', ada.id);
    expect(sel.workers).toHaveLength(1);
    expect(sel.workers[0]).toEqual(await rowOf(wide, ada));
    expect(sel.workers[0].reason).toBe('RETIRED');
    expect(sel.workers[0].desired).toBe('STOPPED');
    expect(sel.workers[0].name).toBe('Ada');
  });

  it('SWEEP_OFF and LEAVE_ALONE rows say the same through the selector as through the host-wide read', async () => {
    await task(kit, 'pending'); // SHORT_LIVED with an open task: would be RUNNING/HOLDS_TASK.
    await sweep('OFF');
    const offWide = await state();
    const offSel = await state('orca1', kit.id);
    expect(offSel.workers).toHaveLength(1);
    expect(offSel.workers[0]).toEqual(await rowOf(offWide, kit));
    expect(offSel.workers[0]).toMatchObject({ desired: null, reason: 'SWEEP_OFF', wouldBe: 'RUNNING', wouldBeReason: 'HOLDS_TASK' });
    await sweep('OBSERVE');
    await leaveAlone(ada, true, ctx(admin.id), 'why');
    const laWide = await state();
    const laSel = await state('orca1', ada.id);
    expect(laSel.workers).toHaveLength(1);
    expect(laSel.workers[0]).toEqual(await rowOf(laWide, ada));
    expect(laSel.workers[0]).toMatchObject({ desired: null, reason: 'LEAVE_ALONE', wouldBe: 'RUNNING', wouldBeReason: 'LONG_LIVED' });
  });
});

describe('#4260 concealment: outside this host\'s set answers exactly like an unknown worker', () => {
  it('another host\'s worker, a retired off-host worker, and unknown id or name all give the same empty answer', async () => {
    const offHostById = await state('orca1', zoe.id); // Zoe runs on orca2, not orca1.
    const offHostByName = await state('orca1', 'Zoe');
    await retire(zoe); // A retired worker not on this host.
    const retiredOffHostById = await state('orca1', zoe.id);
    const retiredOffHostByName = await state('orca1', 'Zoe');
    const unknownId = await state('orca1', generateId());
    const unknownName = await state('orca1', 'Nobody');
    const expected: State = { hostId: 'orca1', sweepMode: 'OBSERVE', workers: [] };
    for (const answer of [offHostById, offHostByName, retiredOffHostById, retiredOffHostByName, unknownId, unknownName]) {
      expect(answer).toEqual(expected); // Same shape, same emptiness, no distinguishing code, message or metadata.
    }
  });

  it('the selector adds no roster oracle through the host-key gate: the off-host answer equals the unknown one under a host key', async () => {
    const offHost = await state('orca1', zoe.id, keyCtx(orca1));
    const unknown = await state('orca1', generateId(), keyCtx(orca1));
    expect(offHost).toEqual(unknown);
    expect(offHost.workers).toEqual([]);
  });
});

describe('#4260 the gates, refusals and recording are the host-wide read\'s', () => {
  it('a host key reads its own host with the selector; another host answers HOST_NOT_FOUND, with or without one', async () => {
    const own = await state('orca1', kit.id, keyCtx(orca1));
    expect(own.workers.map((r) => r.name)).toEqual(['Kit']);
    expect(await code(state('orca2', zoe.id, keyCtx(orca1)))).toBe('HOST_NOT_FOUND');
    expect(await code(state('orca1', ada.id, keyCtx(orca2)))).toBe('HOST_NOT_FOUND');
  });

  it('a key whose host:operate scope was revoked reads no host, its former one included', async () => {
    expect(await code(state('orca1', ada.id, keyCtx(revokedScopeKey)))).toBe('HOST_NOT_FOUND');
  });

  it('an outsider and another App\'s key get the App-not-found answer', async () => {
    const mine = await refusal(state('orca1', ada.id, ctx(outsider.id)));
    const registrations = await refusal(Q.hostRegistrations({}, { appRef: app.id }, ctx(outsider.id)));
    expect(mine).toEqual(registrations);
    const otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
    const foreign = await db.appKey.create({ data: { id: generateId(), appId: otherApp.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
    expect(await code(state('orca1', ada.id, { db, appId: otherApp.id, appKeyId: foreign.id, roles: [] } as Context))).toBe('APP_NOT_FOUND');
  });

  it('a host the App does not have answers HOST_NOT_FOUND with a selector too — a failed read is never an empty success', async () => {
    expect(await code(state('orca9', ada.id))).toBe('HOST_NOT_FOUND');
    expect(await code(state('orca9', ada.id, keyCtx(orca1)))).toBe('HOST_NOT_FOUND');
  });

  it('a host key\'s selector read is recorded as a use, hit, miss or refused', async () => {
    const before = await db.hostKeyUse.count({ where: { appKeyId: orca1.id, action: 'read' } });
    await state('orca1', kit.id, keyCtx(orca1)); // Hit: one row.
    await state('orca1', zoe.id, keyCtx(orca1)); // Miss: zero rows, still a read of the host's own list.
    await refusal(state('orca2', zoe.id, keyCtx(orca1))); // Refused: another host.
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: orca1.id, action: 'read' }, orderBy: { usedAt: 'asc' } });
    expect(uses.length - before).toBe(3);
    expect(uses.slice(-3).map((x) => [x.hostId, x.count, x.refusedCode])).toEqual([
      ['orca1', 1, null], ['orca1', 0, null], ['orca1', null, 'HOST_NOT_FOUND'],
    ]);
  });
});

describe('#4260 the SDL declares the optional worker argument', () => {
  it('a real operation selects one worker through the wire contract', async () => {
    const api = new ApolloServer<Context>({ typeDefs, resolvers });
    await api.start();
    try {
      const q = `query($appRef: String!, $hostId: String!, $worker: String) {
        hostDesiredState(appRef: $appRef, hostId: $hostId, worker: $worker) { hostId sweepMode workers { workerId name desired reason } } }`;
      const r = await api.executeOperation({ query: q, variables: { appRef: app.id, hostId: 'orca1', worker: kit.id } }, { contextValue: ctx(admin.id) });
      if (r.body.kind !== 'single') throw new Error('unexpected incremental response');
      expect(r.body.singleResult.errors).toBeUndefined();
      expect((r.body.singleResult.data as any).hostDesiredState.workers).toHaveLength(1);
      expect((r.body.singleResult.data as any).hostDesiredState.workers[0]).toMatchObject({ name: 'Kit' });
    } finally {
      await api.stop();
    }
  });
});
