import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2022 (S6) — stop signals in due wakes: a `pause` or `halt` stops a worker's ticks while `pause-dispatch` doesn't
 * (R68); and the notice lane (cor:agt:090:04), DARK until the host consumer ships: off, no STOP reason is ever offered;
 * on, the worker's newest notice rides ahead of everything, skips the floor, passes the #2138 team pause (R105) and the
 * budget's refusal (R89), waits on the worker's own pause (cor:agt:080:11), is acknowledged through the proof like a
 * task event, and a never-delivered stop with its resume is dropped together.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../../api/graphql/schema/resolvers.teamChat.js';
import { s6NoticesAvailable, setS6NoticesAvailableForTest } from './delivery.js';
import { verifyWakeProof } from '../tickers/wakeProof.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let app: { id: string };
let manager: { id: string };
let holder: { id: string };
let liam: { id: string };
let ticker: { id: string };
let post: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await cleanDb(db);
  const n = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'sd', urn: `sd-${n}.com` } });
  const u = (k: number) => db.user.create({ data: { id: generateId(), githubId: 98_000 + k + Math.floor(Math.random() * 1e6), githubUsername: `sd-${k}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(1);
  holder = await u(2);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  liam = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  ticker = await db.ticker.create({ data: { id: generateId(), appId: app.id, ownerUserId: manager.id, name: 'Eng', slug: 'eng', cadenceSeconds: 600, anchorAt: new Date(Date.now() - 3600_000), reasons: ['every-tick'] } as never, select: { id: true } });
  await db.tickerSubscription.create({ data: { id: generateId(), tickerId: ticker.id, workerId: liam.id, createdBy: manager.id } });
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
});
afterEach(() => {
  post.mockRestore();
  setS6NoticesAvailableForTest(false);
});

const due = async () => (await Q.dueWakes({}, { appRef: app.id }, ctx(manager.id))).wakes as any[];
const kinds = (w: any) => w.reasons.map((r: any) => r.kind);
// #2173: setting a signal is refused while the notice lane is off (R95). This file tests what a RECORDED signal offers while the lane is
// dark, so the helper opens the lane for the one set call and restores whatever it was: the DARK tests then still see a dark lane.
const set = async (level: string, until?: Date) => {
  const was = s6NoticesAvailable();
  setS6NoticesAvailableForTest(true);
  try {
    return await M.setTeamStopSignal({}, { input: { appRef: app.id, level, scope: 'WORKER', worker: liam.id, ...(until ? { until } : {}) } }, ctx(manager.id));
  } finally {
    setS6NoticesAvailableForTest(was);
  }
};
const lift = (id: string) => M.liftTeamStopSignal({}, { appRef: app.id, id }, ctx(manager.id));
const ack = (proof: string) => M.acknowledgeWakes({}, { proofs: [proof] }, ctx(manager.id));

describe('R68 — ticks under a stop signal', () => {
  it('a pause and a halt stop the worker\'s ticks; a pause-dispatch does not; a lift restores them', async () => {
    expect(kinds((await due())[0])).toEqual(['TICK']);
    await db.appWakeReservation.deleteMany();
    const p = await set('PAUSE');
    expect(await due()).toEqual([]);
    await lift(p.id);
    const h = await set('HALT');
    expect(await due()).toEqual([]);
    await lift(h.id);
    await set('PAUSE_DISPATCH');
    expect(kinds((await due())[0])).toEqual(['TICK']);
  });
});

describe('cor:agt:090:04 — the notice lane', () => {
  it('DARK: with the lane off, no STOP reason is ever offered (the notice is still recorded)', async () => {
    await set('HALT');
    expect(await due()).toEqual([]);
    expect(await db.agentTeamEvent.count({ where: { type: 'stop.notice', subjectWorkerId: liam.id } })).toBe(1);
  });

  it('a halt\'s notice interrupts, is acknowledged through the proof, and is then not offered again', async () => {
    setS6NoticesAvailableForTest(true);
    const s = await set('HALT');
    const [w] = await due();
    expect(kinds(w)).toEqual(['STOP']);
    expect(w.reasons[0].stop).toMatchObject({ signalId: s.id, level: 'HALT', notice: 'STOP', interrupt: true });
    // No batching window and no busy delay.
    expect(w.deliverAfter.getTime()).toBe(w.busyDeadline.getTime());
    const proof = verifyWakeProof(w.proof);
    expect(proof.tasks).toEqual([{ eventId: w.reasons[0].stop.eventId, chainIndex: 0 }]);
    expect((await ack(w.proof)).acknowledged).toBe(1);
    expect(await due()).toEqual([]);
  });

  it('a pause notice rides ahead of a tick, and skips the floor right after a delivered wake', async () => {
    setS6NoticesAvailableForTest(true);
    const [tick] = await due();
    await ack(tick.proof);
    expect(await due()).toEqual([]); // inside the floor
    await set('PAUSE');
    const [w] = await due();
    expect(kinds(w)).toEqual(['STOP']);
    expect(w.reasons[0].stop).toMatchObject({ level: 'PAUSE', notice: 'STOP', interrupt: false });
  });

  it('the resume after a delivered stop is offered; a never-delivered stop and its resume are dropped together', async () => {
    setS6NoticesAvailableForTest(true);
    const a = await set('PAUSE');
    await ack((await due())[0].proof);
    await lift(a.id);
    const [r] = await due();
    expect(r.reasons[0].stop).toMatchObject({ notice: 'RESUME', interrupt: false });
    await ack(r.proof);
    await db.appWakeReservation.deleteMany();
    await db.workerWakeAck.updateMany({ data: { ackedAt: new Date(Date.now() - 3600_000) } });
    await db.workerDeliveryTaskEvent.updateMany({ data: { deliveredAt: new Date(Date.now() - 3600_000) } });
    const b = await set('HALT');
    await lift(b.id);
    expect((await due()).flatMap(kinds)).not.toContain('STOP');
  });

  it('R105: a stop notice reaches a worker under the #2138 team pause, alone; its own pause holds it', async () => {
    setS6NoticesAvailableForTest(true);
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: new Date() } });
    await set('HALT');
    const [w] = await due();
    expect(kinds(w)).toEqual(['STOP']);
    await db.appWakeReservation.deleteMany();
    await db.workerWakeSettings.create({ data: { workerId: liam.id, pausedUntil: new Date(Date.now() + 3600_000) } });
    expect(await due()).toEqual([]);
  });

  it('R89: a spent daily budget never withholds a stop notice', async () => {
    setS6NoticesAvailableForTest(true);
    await db.app.update({ where: { id: app.id }, data: { wakeDailyBudget: 0 } });
    await set('HALT');
    const page = await Q.dueWakes({}, { appRef: app.id }, ctx(manager.id));
    expect(page.withheld).toBe(0);
    expect(kinds(page.wakes[0])).toEqual(['STOP']);
  });
});

describe('fix head of #2166 (Diego P2-1): an outstanding wake\'s TICK is not re-offered under a pause or halt', () => {
  let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
  beforeEach(async () => {
    const appRow = await db.app.findUniqueOrThrow({ where: { id: app.id }, select: { organizationId: true, urn: true } });
    const agentRow = await db.agent.findFirstOrThrow({ where: { organizationId: appRow.organizationId! } });
    const memory = await db.memory.create({ data: { id: generateId(), organizationId: appRow.organizationId!, urn: `${appRow.urn}-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentRow.id } });
    const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'chats:team', createdBy: manager.id });
    channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: liam.id, role: 'BOTH' } });
  });
  const mentionLiam = async () => {
    const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
    await appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) =>
      tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: 'for you', data: { mentions: ['liam'] } } }),
    { asChannel: true });
  };

  for (const level of ['PAUSE', 'HALT'] as const) {
    it(`${level}: the reserved MENTION+TICK wake is re-offered without its TICK; the mention stays due`, async () => {
      await mentionLiam();
      expect(kinds((await due())[0]).sort()).toEqual(['MENTION', 'TICK']);
      await set(level);
      const [next] = await due();
      expect(kinds(next)).toEqual(['MENTION']);
      expect(verifyWakeProof(next.proof).ticks).toEqual([]);
    });
  }

  it('PAUSE_DISPATCH control: the reserved wake keeps its TICK; after a pause is lifted, ticks are offered again', async () => {
    await mentionLiam();
    await due();
    const d = await set('PAUSE_DISPATCH');
    expect(kinds((await due())[0]).sort()).toEqual(['MENTION', 'TICK']);
    await lift(d.id);
    const p = await set('PAUSE');
    expect(kinds((await due())[0])).toEqual(['MENTION']);
    await lift(p.id);
    expect(kinds((await due())[0]).sort()).toEqual(['MENTION', 'TICK']);
  });
});
