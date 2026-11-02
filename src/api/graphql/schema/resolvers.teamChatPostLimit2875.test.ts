/**
 * #2875 — pins for #2869's post-limit guards that #2014's suite left unpinned (Rook's P3-1..6 and P3-8), and the alarm
 * title's wording (Uma P3-4, P3-5). Each pin of existing behavior must fail against a mutant of the line it guards.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { raisePostLimitAlarm } from '../../../lib/agentTasks/postLimit.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { type Context } from './resolvers.js';
import { findBrokenPostLimit } from '../../../lib/teamChatAdmission.js';
import { teamChatMutations } from './resolvers.teamChat.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

type W = { id: string; name: string; holder: string; session: string };

let org: { id: string; urn: string };
let manager: { id: string };
let holderA: { id: string };
let holderB: { id: string };
let app: { id: string };
let agent: { id: string };
let memory: { id: string };
let channel: { id: string; memoryId: string };
let other: { id: string; memoryId: string };
let liam: W;
let rook: W;
let boss: W;

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_900 + n, githubUsername: `pl-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
async function mkWorker(name: string, holder: string, reportsTo?: string): Promise<W> {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder, heldAt: new Date(), reportsToWorkerId: reportsTo ?? null }, select: { id: true, name: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  const session = (await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } })).id;
  return { ...w, holder, session };
}

const workerSays = (w: W, body: string) =>
  runAsActor({ workerId: w.id, agentId: agent.id }, () => teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq: null, sessionRef: w.session }, ctx(w.holder)));

const post = async (w: W, n: number, tag: string) => { for (let i = 0; i < n; i++) await workerSays(w, `${tag} ${i}`); };
const alarms = () => db.agentTeamEvent.findMany({ where: { type: 'alarm.post-limit' } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'pl-org', urn: `pl-org-${suffix}.com` } });
  [manager, holderA, holderB] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [manager, holderA, holderB]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id };
  const madeOther = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:release', name: 'release', createdBy: manager.id });
  other = { id: madeOther.channel.id, memoryId: memory.id };
  boss = await mkWorker('Boss', holderB.id);
  liam = await mkWorker('Liam', holderA.id, boss.id);
  rook = await mkWorker('Rook', holderB.id);
});


/** A chat-message row of `w`, written directly at `createdAt` (the window reads this column). */
const msgAt = (w: W, createdAt: Date, nodeType = 'chat-message') =>
  db.node.create({ data: { id: generateId(), memoryId: memory.id, nodeType, name: `m-${generateId()}`, loc: `pins:${generateId()}`, content: 'x', createdByWorkerId: w.id, createdAt } });

describe('#2875 window count', () => {
  it('counts only chat-message nodes: many ordinary nodes by the worker never block a post (Rook P3-2)', async () => {
    for (let i = 0; i < 12; i++) await msgAt(liam, new Date(), 'info');
    await expect(workerSays(liam, 'still allowed')).resolves.toBeTruthy();
  });

  it('a message exactly at the cutoff no longer counts; one a millisecond inside still does (Rook P3-3)', async () => {
    const admittedAt = new Date(Date.UTC(2030, 0, 1, 12, 0, 0, 0));
    const broken = () => db.$transaction((tx) => findBrokenPostLimit(tx, liam.id, admittedAt));
    for (let i = 0; i < 10; i++) await msgAt(liam, new Date(admittedAt.getTime() - 60_000));
    expect(await broken()).toBeNull();
    await db.node.updateMany({ where: { createdByWorkerId: liam.id }, data: { createdAt: new Date(admittedAt.getTime() - 60_000 + 1) } });
    expect(await broken()).toMatchObject({ name: '10 per minute' });
  });

  it('the refusal message opens with "Your message was NOT posted" (Rook P3-6)', async () => {
    await post(liam, 10, 'a');
    const err: any = await workerSays(liam, 'x').catch((e) => e);
    expect(err.message.startsWith('Your message was NOT posted: you have reached the team-chat post limit (10 per minute).')).toBe(true);
  });
});

describe('#2875 the alarm transaction', () => {
  it('raises nothing while the App\'s Organization is soft-deleted (Rook P3-1)', async () => {
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await raisePostLimitAlarm(db, liam.id, '10 per minute')).toBeNull();
    expect(await alarms()).toHaveLength(0);
    expect(await db.postLimitEpisode.count()).toBe(0);
  });

  it('runs SERIALIZABLE (Rook P3-4)', async () => {
    const real = db.$transaction.bind(db);
    const seen: unknown[] = [];
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: any, opts: any) => { seen.push(opts?.isolationLevel); return (real as any)(fn, opts); }) as any);
    try { expect(await raisePostLimitAlarm(db, liam.id, '10 per minute')).not.toBeNull(); } finally { spy.mockRestore(); }
    expect(seen).toEqual([Prisma.TransactionIsolationLevel.Serializable]);
  });

  it('a P2002 unique conflict is retried: the rerun raises the alarm once (Rook P3-5)', async () => {
    const real = db.$transaction.bind(db);
    let failed = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((...args: any[]) => {
      if (failed++ < 1) return Promise.reject(new Prisma.PrismaClientKnownRequestError('unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
      return (real as any)(...args);
    }) as any);
    let id: string | null = null;
    try { id = await raisePostLimitAlarm(db, liam.id, '10 per minute'); expect(spy.mock.calls.length).toBe(2); } finally { spy.mockRestore(); }
    expect(id).not.toBeNull();
    expect(await alarms()).toHaveLength(1);
  });

  it('the unique-index backstop alone: a precheck that sees no open episode, with one committed, rolls the new event back and leaves exactly one alarm (Rook P3-8)', async () => {
    const existing = await db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, type: 'alarm.post-limit', subjectWorkerId: liam.id, severity: 'alarm', chain: [], payload: {} } });
    await db.postLimitEpisode.create({ data: { appId: app.id, workerId: liam.id, eventId: existing.id, openedAt: new Date() } });
    const real = db.$transaction.bind(db);
    // Blind the precheck (the race it cannot see): its SELECT of open episodes answers empty, everything else is real.
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: any, opts: any) =>
      (real as any)((tx: any) => fn(new Proxy(tx, { get: (t, p) => {
        const v = Reflect.get(t, p);
        if (p === '$queryRaw') return (s: TemplateStringsArray, ...rest: unknown[]) => (s.join('?').includes('SELECT id FROM post_limit_episodes') ? Promise.resolve([]) : (v as any).call(t, s, ...rest));
        return typeof v === 'function' ? v.bind(t) : v;
      } })), opts)) as any);
    let id: string | null | undefined;
    try { id = await raisePostLimitAlarm(db, liam.id, '10 per minute'); } finally { spy.mockRestore(); }
    expect(id).toBeNull();
    expect(await alarms()).toHaveLength(1);
    expect(await db.postLimitEpisode.count()).toBe(1);
    expect(await db.agentTeamAlarmSchedule.count()).toBe(0);
  });
});

describe('#2875 the alarm title (Uma P3-4, P3-5)', () => {
  const titleOf = async () => ((await pendingTaskWakes(db, [boss.id], new Date())).get(boss.id) ?? [])[0]!.title;

  it('says the post was refused and names the limit, never the refused text', async () => {
    await post(liam, 10, 'a');
    await workerSays(liam, 'secret refused words').catch(() => undefined);
    const title = await titleOf();
    expect(title).toBe("Liam's team-chat post was refused by the post limit (10 per minute)");
    expect(title).not.toMatch(/secret refused words/);
  });

  it('has no placeholder when the event carries no limit', async () => {
    const ev = await db.agentTeamEvent.create({ data: { id: generateId(), appId: app.id, type: 'alarm.post-limit', subjectWorkerId: liam.id, severity: 'alarm', chain: [{ workerId: boss.id }], payload: {} } });
    await db.agentTeamAlarmSchedule.create({ data: { eventId: ev.id, chainIndex: 0, dueAt: new Date(), wokenAt: new Date() } });
    expect(await titleOf()).toBe("Liam's team-chat post was refused by the post limit");
  });
});
