/**
 * #4847 (cor:int:030:03, clauses 1-4; Holger 2026-11-22: "cap with a visible alarm", pre-#4843 orphans left out): a chat tool teardown is
 * DURABLE. The deleting transaction records an intent in `chat_tool_teardown_intents` (no foreign key to the App or organization, so it
 * outlives the hard delete a URN reclaim does); the first attempt follows the commit; a sweep retries an unconfirmed intent with a wait
 * of 5 minutes doubling to at most 6 hours; the tool's SUCCESS is the only confirmation (a not-found is not one: the tool must answer a
 * repeat DELETE with success, hadrontool-telegram#8 and hadrontool-slack#6); after 10 attempts the intent is CAPPED, ONE alarm is
 * raised and nothing is retried or dropped until an operator requeues it. Reconciliation queues the live rows of an owner that is
 * ALREADY deleted through the same intent, and only those. Real database; only the two tool clients' delete calls and the Sentry
 * capture are replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { deleteSlackToolConnection } from './slackClient.js';
import { deleteTelegramToolConnection } from './telegramClient.js';
import {
  CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS,
  attemptChatToolTeardown,
  chatToolTeardownIdle,
  chatToolTeardownSweepTick,
  reconcileOrphanedChatToolConnections,
  requeueCappedChatToolTeardowns,
  softDeleteChatToolConnections,
} from './chatToolTeardown.js';

vi.mock('./slackClient.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./slackClient.js')>()), deleteSlackToolConnection: vi.fn() }));
vi.mock('./telegramClient.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./telegramClient.js')>()), deleteTelegramToolConnection: vi.fn() }));
vi.mock('@sentry/node', async (original) => ({ ...(await original<typeof import('@sentry/node')>()), captureMessage: vi.fn() }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const slackDelete = vi.mocked(deleteSlackToolConnection);
const telegramDelete = vi.mocked(deleteTelegramToolConnection);
const alarm = vi.mocked(Sentry.captureMessage);
let org: { id: string }, otherOrg: { id: string };
let appA: { id: string }, appB: { id: string }, otherApp: { id: string };
let admin: { id: string }, platform: { id: string };
const ctx = (userId: string, roles: string[] = ['READER']): Context => ({ db, roles, userId }) as unknown as Context;
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const T0 = new Date('2026-12-01T00:00:00Z');

const telegram = (organizationId: string, appId: string, tool: string) => db.telegramConnection.create({
  data: { organizationId, appId, toolConnectionId: tool, botId: `bot-${tool}`, botUsername: `bot_${tool}`, displayName: tool } });
const slack = (organizationId: string, defaultAppId: string, tool: string) => db.slackConnection.create({
  data: { organizationId, defaultAppId, toolConnectionId: tool, teamId: `T-${tool}`, teamName: tool, botUserId: `U-${tool}`, botId: `B-${tool}` } });
const intentOf = (kind: 'telegram' | 'slack', tool: string) => db.chatToolTeardownIntent.findUniqueOrThrow({ where: { kind_toolConnectionId: { kind, toolConnectionId: tool } } });
const intentCount = () => db.chatToolTeardownIntent.count();
/** The teardown is fire-and-forget after commit: let the microtask queue run before reading the calls. */
const settle = () => chatToolTeardownIdle();
const calls = () => ({ telegram: telegramDelete.mock.calls.map((c) => c[1]).sort(), slack: slackDelete.mock.calls.map((c) => c[1]).sort() });

beforeEach(async () => {
  await cleanDb(db);
  slackDelete.mockReset().mockResolvedValue(true);
  telegramDelete.mockReset().mockResolvedValue(true);
  alarm.mockReset();
  org = await db.organization.create({ data: { id: generateId(), name: 'dt-org', urn: 'dt-org' } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'dt-other', urn: 'dt-other' } });
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'a', urn: 'dt-org::a' } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'b', urn: 'dt-org::b' } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'o', urn: 'dt-other::o' } });
  admin = await db.user.create({ data: { id: generateId(), email: `admin-${generateId().slice(0, 5)}@s4847.test`, name: 'admin' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  platform = await db.user.create({ data: { id: generateId(), email: `platform-${generateId().slice(0, 5)}@s4847.test`, name: 'platform', roles: ['ADMIN'] } });
  await telegram(org.id, appA.id, 'tg-a'); await telegram(org.id, appB.id, 'tg-b'); await telegram(otherOrg.id, otherApp.id, 'tg-other');
  await slack(org.id, appA.id, 'sl-a'); await slack(org.id, appB.id, 'sl-b'); await slack(otherOrg.id, otherApp.id, 'sl-other');
});

describe('#4847 the intent is recorded in the deleting transaction (clause 1)', () => {
  it('deleteApp records one intent per connection it soft-deletes and none for another App; the first attempt confirms it', async () => {
    await expect(M.deleteApp({}, { ref: appA.id }, ctx(admin.id))).resolves.toBe(true);
    await settle();
    expect(await intentCount()).toBe(2);
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ provider: 'telegram', state: 'CONFIRMED', attempts: 1 });
    expect(await intentOf('slack', 'sl-a')).toMatchObject({ provider: 'slack', state: 'CONFIRMED', attempts: 1 });
    expect(calls()).toEqual({ telegram: ['tg-a'], slack: ['sl-a'] });
  });

  it('a refused delete records no intent and asks no tool', async () => {
    await expect(M.deleteApp({}, { ref: appA.id }, ctx(generateId()))).rejects.toThrow();
    await settle();
    expect(await intentCount()).toBe(0);
    expect(calls()).toEqual({ telegram: [], slack: [] });
  });

  it('the intent SURVIVES the hard delete a URN reclaim does (the connection rows cascade away, the intent is not theirs)', async () => {
    telegramDelete.mockResolvedValue(false);
    slackDelete.mockResolvedValue(false);
    const agent = await db.agent.create({ data: { name: 'dt agent', urn: 'dt-org:agent', organizationId: org.id } });
    await db.app.update({ where: { id: appA.id }, data: { urn: 'dt-org:a', deletedAt: new Date() } });
    await M.createApp({}, { orgRef: org.id, agentRef: agent.id, name: 'a', urn: 'a' }, ctx(admin.id));
    await settle();
    expect(await db.app.findUnique({ where: { id: appA.id } })).toBeNull();
    expect(await db.telegramConnection.count({ where: { toolConnectionId: 'tg-a' } })).toBe(0);
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'PENDING', attempts: 1 });
    telegramDelete.mockResolvedValue(true);
    slackDelete.mockResolvedValue(true);
    await chatToolTeardownSweepTick(db, minutes(6));
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'CONFIRMED', attempts: 2 });
    expect(await intentOf('slack', 'sl-a')).toMatchObject({ state: 'CONFIRMED', attempts: 2 });
  });
});

describe('#4847 a teardown that did not complete is retried by the sweep (clause 2)', () => {
  it('a failed call stays PENDING, is not retried before 5 minutes, and a later success confirms it once', async () => {
    telegramDelete.mockResolvedValue(false);
    await M.deleteApp({}, { ref: appA.id }, ctx(admin.id));
    await settle();
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'PENDING', attempts: 1 });
    const first = await intentOf('telegram', 'tg-a');
    const lastAt = first.lastAttemptAt!;
    telegramDelete.mockClear();
    await chatToolTeardownSweepTick(db, new Date(lastAt.getTime() + 4 * 60_000));
    expect(telegramDelete).not.toHaveBeenCalled();
    telegramDelete.mockResolvedValue(true);
    await chatToolTeardownSweepTick(db, new Date(lastAt.getTime() + 6 * 60_000));
    expect(telegramDelete).toHaveBeenCalledTimes(1);
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'CONFIRMED', attempts: 2 });
    telegramDelete.mockClear();
    await chatToolTeardownSweepTick(db, new Date(lastAt.getTime() + 2 * 24 * 3_600_000));
    expect(telegramDelete, 'a confirmed intent is never asked again').not.toHaveBeenCalled();
  });

  it('a process that dies between the commit and the call: the intent is PENDING with no attempt, and the sweep completes it', async () => {
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, 'admin'));
    expect(calls()).toEqual({ telegram: [], slack: [] });
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'PENDING', attempts: 0, lastAttemptAt: null });
    await chatToolTeardownSweepTick(db, T0);
    expect(calls()).toEqual({ telegram: ['tg-a'], slack: ['sl-a'] });
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'CONFIRMED', attempts: 1 });
  });

  it('only a SUCCESS confirms: a tool that answers not-found (false) leaves the intent PENDING', async () => {
    telegramDelete.mockResolvedValue(false);
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    await chatToolTeardownSweepTick(db, T0);
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'PENDING', confirmedAt: null });
  });

  it('a tool client that throws is a failed attempt, never a failed sweep or a confirmation', async () => {
    telegramDelete.mockRejectedValue(new Error('boom'));
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    await expect(chatToolTeardownSweepTick(db, T0)).resolves.toBeTruthy();
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'PENDING', attempts: 1 });
    expect(await intentOf('slack', 'sl-a')).toMatchObject({ state: 'CONFIRMED' });
  });

  it('a connection soft-deleted BEFORE this change has no intent and is never swept (pre-#4843 orphans are out, per the node)', async () => {
    await db.telegramConnection.updateMany({ where: { toolConnectionId: 'tg-b' }, data: { deletedAt: new Date() } });
    await chatToolTeardownSweepTick(db, minutes(10_000));
    expect(calls()).toEqual({ telegram: [], slack: [] });
  });
});

describe('#4847 the wait and the cap (clause 4)', () => {
  const failAlways = () => { telegramDelete.mockResolvedValue(false); };
  async function runAttempts(until: number) {
    failAlways();
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const id = (await intentOf('telegram', 'tg-a')).id;
    const times: number[] = [];
    let t = 0;
    for (let n = 1; n <= until; n++) {
      times.push(t);
      expect(await attemptChatToolTeardown(db, id, minutes(t))).not.toBe('skipped');
      const wait = 5 * Math.min(2 ** (n - 1), 72);
      // one minute short of the wait: not due yet
      expect(await attemptChatToolTeardown(db, id, minutes(t + wait - 1)), `attempt ${n + 1} must not be due before ${wait} minutes`).toBe('skipped');
      t += wait;
    }
    return { id, times };
  }

  it('the wait starts at 5 minutes and doubles, to at most 6 hours', async () => {
    const { times } = await runAttempts(9);
    const gaps = times.slice(1).map((v, i) => v - times[i]!);
    expect(gaps).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
  });

  it('after 10 failed attempts the intent is CAPPED, ONE alarm is raised, and nothing is asked again', async () => {
    const { id } = await runAttempts(CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS - 1);
    expect(alarm).not.toHaveBeenCalled();
    telegramDelete.mockClear();
    expect(await attemptChatToolTeardown(db, id, minutes(10_000))).toBe('capped');
    expect(await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'CAPPED', attempts: CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS });
    expect(alarm).toHaveBeenCalledTimes(1);
    telegramDelete.mockClear();
    await chatToolTeardownSweepTick(db, minutes(1_000_000));
    await chatToolTeardownSweepTick(db, minutes(2_000_000));
    expect(telegramDelete, 'a capped intent is not retried').not.toHaveBeenCalled();
    expect(alarm, 'and not alarmed again').toHaveBeenCalledTimes(1);
  });

  it('the alarm carries ids only: no token, no secret', async () => {
    const { id } = await runAttempts(CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS - 1);
    await attemptChatToolTeardown(db, id, minutes(10_000));
    const [message, hint] = alarm.mock.calls[0]! as [string, { tags?: Record<string, string>; extra?: Record<string, unknown>; fingerprint?: string[] }];
    expect(hint.tags).toMatchObject({ 'chat_tool_teardown.capped': 'true', kind: 'telegram' });
    expect(hint.fingerprint).toEqual(['chat_tool_teardown.capped', id]);
    expect(JSON.stringify([message, hint])).not.toMatch(/token|secret|password/i);
    expect(hint.extra).toMatchObject({ intentId: id, toolConnectionId: 'tg-a', provider: 'telegram' });
  });

  it('an operator can requeue a capped intent (and only a capped one): it is attempted again from a clean count', async () => {
    const { id } = await runAttempts(CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS - 1);
    await attemptChatToolTeardown(db, id, minutes(10_000));
    expect(await requeueCappedChatToolTeardowns(db, { id })).toBe(1);
    expect(await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'PENDING', attempts: 0, lastAttemptAt: null, cappedAt: null });
    telegramDelete.mockResolvedValue(true);
    await chatToolTeardownSweepTick(db, minutes(20_000));
    expect(await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'CONFIRMED', attempts: 1 });
    expect(await requeueCappedChatToolTeardowns(db, { id }), 'a confirmed intent is not requeued').toBe(0);
  });
});

describe('#4847 a crash on the last attempt cannot leave an intent PENDING forever', () => {
  it('an intent with every attempt used and no recorded outcome is capped by the sweep once its last wait has passed, with one alarm', async () => {
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const id = (await intentOf('telegram', 'tg-a')).id;
    // the tenth claim ran (attempts = 10, last attempt stamped) and the process died before it recorded the outcome
    await db.chatToolTeardownIntent.update({ where: { id }, data: { attempts: CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS, lastAttemptAt: T0 } });
    telegramDelete.mockClear();
    const early = await chatToolTeardownSweepTick(db, minutes(60)); // its last wait (6 hours) has not passed
    expect(early.capped).toBe(0);
    expect((await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id } })).state).toBe('PENDING');
    const late = await chatToolTeardownSweepTick(db, minutes(7 * 60));
    expect(late.capped).toBe(1);
    expect(await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'CAPPED' });
    expect(alarm).toHaveBeenCalledTimes(1);
    expect(telegramDelete, 'the exhausted intent is capped, never asked an eleventh time').not.toHaveBeenCalledWith('telegram', 'tg-a');
    await chatToolTeardownSweepTick(db, minutes(100 * 60));
    expect(alarm, 'and not alarmed again').toHaveBeenCalledTimes(1);
  });
});

describe('#4847 the state guards: only a PENDING intent is attempted, and only a PENDING one is capped', () => {
  it('a direct attempt on a CONFIRMED or a CAPPED intent asks the tool nothing, whatever the clock says', async () => {
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const tg = (await intentOf('telegram', 'tg-a')).id;
    const sl = (await intentOf('slack', 'sl-a')).id;
    await db.chatToolTeardownIntent.update({ where: { id: tg }, data: { state: 'CONFIRMED', attempts: 2, lastAttemptAt: T0 } });
    await db.chatToolTeardownIntent.update({ where: { id: sl }, data: { state: 'CAPPED', attempts: 3, lastAttemptAt: T0, cappedAt: T0 } });
    expect(await attemptChatToolTeardown(db, tg, minutes(1_000_000))).toBe('skipped');
    expect(await attemptChatToolTeardown(db, sl, minutes(1_000_000))).toBe('skipped');
    expect(calls()).toEqual({ telegram: [], slack: [] });
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'CONFIRMED', attempts: 2 });
    expect(await intentOf('slack', 'sl-a')).toMatchObject({ state: 'CAPPED', attempts: 3 });
  });

  it('an intent confirmed by another actor while its last attempt was in flight is NOT flipped to CAPPED, and raises no alarm', async () => {
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const id = (await intentOf('telegram', 'tg-a')).id;
    await db.chatToolTeardownIntent.update({ where: { id }, data: { attempts: CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS - 1, lastAttemptAt: T0 } });
    telegramDelete.mockImplementationOnce(async () => {
      await db.chatToolTeardownIntent.update({ where: { id }, data: { state: 'CONFIRMED', confirmedAt: T0 } }); // someone else confirmed it meanwhile
      return false;
    });
    await attemptChatToolTeardown(db, id, minutes(10_000));
    expect((await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id } })).state).toBe('CONFIRMED');
    expect(alarm).not.toHaveBeenCalled();
  });
});

describe('#4847 two sweeps, or two dispatches, ask the tool once per attempt', () => {
  it('two sweeps at once: one call per intent', async () => {
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    await Promise.all([chatToolTeardownSweepTick(db, T0), chatToolTeardownSweepTick(db, T0)]);
    expect(calls()).toEqual({ telegram: ['tg-a'], slack: ['sl-a'] });
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'CONFIRMED', attempts: 1 });
  });

  it('two attempts on one intent at once: one call, the other is skipped', async () => {
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const id = (await intentOf('telegram', 'tg-a')).id;
    const outcomes = await Promise.all([attemptChatToolTeardown(db, id, T0), attemptChatToolTeardown(db, id, T0)]);
    expect(outcomes.sort()).toEqual(['confirmed', 'skipped']);
    expect(telegramDelete).toHaveBeenCalledTimes(1);
  });

  it('a failed attempt at the cap raises the alarm once even when two attempts race to it', async () => {
    telegramDelete.mockResolvedValue(false);
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const id = (await intentOf('telegram', 'tg-a')).id;
    await db.chatToolTeardownIntent.update({ where: { id }, data: { attempts: CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS - 1, lastAttemptAt: T0 } });
    await Promise.all([attemptChatToolTeardown(db, id, minutes(10_000)), attemptChatToolTeardown(db, id, minutes(10_000))]);
    expect(alarm).toHaveBeenCalledTimes(1);
    expect((await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id } })).state).toBe('CAPPED');
  });
});

describe('#4847 reconciliation queues only the live rows of an owner that is already deleted (clause 2)', () => {
  it('a live Telegram row of a deleted App and a live Slack row of an App-deleted default are queued and torn down; live owners are untouched', async () => {
    await db.app.update({ where: { id: appA.id }, data: { deletedAt: new Date() } });
    const n = await reconcileOrphanedChatToolConnections(db);
    expect(n).toBe(2);
    expect(await db.telegramConnection.findFirstOrThrow({ where: { toolConnectionId: 'tg-a' } })).toMatchObject({ deletedAt: expect.any(Date), deletedBy: 'system:reconcile' });
    expect(await db.slackConnection.findFirstOrThrow({ where: { toolConnectionId: 'sl-a' } })).toMatchObject({ deletedAt: expect.any(Date) });
    for (const live of ['tg-b', 'tg-other']) expect((await db.telegramConnection.findFirstOrThrow({ where: { toolConnectionId: live } })).deletedAt).toBeNull();
    for (const live of ['sl-b', 'sl-other']) expect((await db.slackConnection.findFirstOrThrow({ where: { toolConnectionId: live } })).deletedAt).toBeNull();
    await chatToolTeardownSweepTick(db, T0);
    expect(calls()).toEqual({ telegram: ['tg-a'], slack: ['sl-a'] });
    expect(await intentCount()).toBe(2);
  });

  it('a live row of a deleted ORGANIZATION is queued; another tenant\'s rows are never reached', async () => {
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await reconcileOrphanedChatToolConnections(db)).toBe(4);
    await chatToolTeardownSweepTick(db, T0);
    expect(calls()).toEqual({ telegram: ['tg-a', 'tg-b'], slack: ['sl-a', 'sl-b'] });
    expect((await db.telegramConnection.findFirstOrThrow({ where: { toolConnectionId: 'tg-other' } })).deletedAt).toBeNull();
    expect((await db.slackConnection.findFirstOrThrow({ where: { toolConnectionId: 'sl-other' } })).deletedAt).toBeNull();
  });

  it('with nothing orphaned it changes nothing and is repeatable', async () => {
    expect(await reconcileOrphanedChatToolConnections(db)).toBe(0);
    expect(await reconcileOrphanedChatToolConnections(db)).toBe(0);
    expect(await intentCount()).toBe(0);
    await chatToolTeardownSweepTick(db, T0);
    expect(calls()).toEqual({ telegram: [], slack: [] });
  });

  it('a connection already soft-deleted is not queued again, and a tool connection already with an intent is never doubled', async () => {
    await M.deleteApp({}, { ref: appA.id }, ctx(admin.id));
    await settle();
    telegramDelete.mockClear(); slackDelete.mockClear();
    expect(await reconcileOrphanedChatToolConnections(db)).toBe(0);
    expect(await intentCount()).toBe(2);
    await chatToolTeardownSweepTick(db, minutes(10_000));
    expect(calls()).toEqual({ telegram: [], slack: [] });
  });
});

describe('#4847 the single-connection doors record the same intent (one path)', () => {
  it('deleteTelegramConnection records an intent; a tool that fails is retried by the sweep; no admin door reaches a deleted row', async () => {
    telegramDelete.mockResolvedValue(false);
    const row = await db.telegramConnection.findFirstOrThrow({ where: { toolConnectionId: 'tg-a' } });
    await expect(M.deleteTelegramConnection({}, { ref: row.id }, ctx(admin.id))).resolves.toBe(true);
    await settle();
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'PENDING', attempts: 1, connectionId: row.id });
    await expect(M.deleteTelegramConnection({}, { ref: row.id }, ctx(admin.id)), 'a deleted row is still NOT_FOUND to an admin').rejects.toThrow(/not found/i);
    telegramDelete.mockResolvedValue(true);
    await chatToolTeardownSweepTick(db, minutes(10_000));
    expect(await intentOf('telegram', 'tg-a')).toMatchObject({ state: 'CONFIRMED', attempts: 2 });
  });

  it('deleteSlackConnection: a concurrent double delete records one intent and asks the tool once', async () => {
    const row = await db.slackConnection.findFirstOrThrow({ where: { toolConnectionId: 'sl-a' } });
    await Promise.allSettled([M.deleteSlackConnection({}, { ref: row.id }, ctx(admin.id)), M.deleteSlackConnection({}, { ref: row.id }, ctx(admin.id))]);
    await settle();
    expect(await db.chatToolTeardownIntent.count({ where: { kind: 'slack', toolConnectionId: 'sl-a' } })).toBe(1);
    expect(slackDelete).toHaveBeenCalledTimes(1);
  });
});

describe('#4847 organization deletion and a platform admin', () => {
  it('deleteOrganization records an intent for every connection of the organization and none of another', async () => {
    await M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN']));
    await settle();
    expect(await intentCount()).toBe(4);
    expect(calls()).toEqual({ telegram: ['tg-a', 'tg-b'], slack: ['sl-a', 'sl-b'] });
  });
});

describe('#4847 blind P2: a tool connection id is never reused, so the one-intent-per-id key cannot swallow a later registration', () => {
  it('core cannot hold a second connection row with the id of a deleted one (both tables), so no intent can be shadowed', async () => {
    await M.deleteApp({}, { ref: appA.id }, ctx(admin.id));
    await settle();
    // A FRESH App: appB already holds a live Telegram connection, which would fail on the one-active-per-App index instead.
    const fresh = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'fresh', urn: 'dt-org::fresh' } });
    await expect(telegram(org.id, fresh.id, 'tg-a')).rejects.toMatchObject({ code: 'P2002', meta: { target: ['tool_connection_id'] } });
    await expect(slack(org.id, fresh.id, 'sl-a')).rejects.toMatchObject({ code: 'P2002', meta: { target: ['tool_connection_id'] } });
  });

  it('one intent whose claim throws (a database fault) does not stop the sweep tick: the next due intent is still attempted', async () => {
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const first = (await db.chatToolTeardownIntent.findMany({ orderBy: { id: 'asc' } }))[0]!.id;
    let thrown = false;
    const faulty = new Proxy(db, { get: (target, prop, receiver) => {
      if (prop !== '$queryRaw') return Reflect.get(target, prop, receiver);
      return (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!thrown && Array.isArray(strings) && strings.join('?').includes('SET attempts = attempts + 1') && values.includes(first)) {
          thrown = true;
          return Promise.reject(new Error('simulated database fault'));
        }
        return (target.$queryRaw as any)(strings, ...values);
      };
    } }) as typeof db;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await chatToolTeardownSweepTick(faulty, minutes(10_000));
    errors.mockRestore();
    expect(thrown).toBe(true);
    expect(out.attempted).toBe(1);
    expect(calls().telegram.length + calls().slack.length).toBe(1);
  });

  it('a PENDING intent that has used every attempt is never claimed again (the cap guard attempts < MAX)', async () => {
    telegramDelete.mockResolvedValue(false);
    await db.$transaction((tx) => softDeleteChatToolConnections(tx, { appId: appA.id }, null));
    const id = (await intentOf('telegram', 'tg-a')).id;
    await db.chatToolTeardownIntent.update({ where: { id }, data: { attempts: CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS, lastAttemptAt: T0 } });
    expect(await attemptChatToolTeardown(db, id, minutes(1_000_000))).toBe('skipped');
    expect(telegramDelete).not.toHaveBeenCalled();
    expect((await intentOf('telegram', 'tg-a')).attempts).toBe(CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS);
  });
});
