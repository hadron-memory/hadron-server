/**
 * #2015 — the admission primitives of a worker's team-chat post (`teamChatAdmission.ts`), pinned below the resolver:
 *
 *  - the ten-minute cutoff is exclusive (a message exactly ten minutes old no longer blocks; one a millisecond younger does);
 *  - the admission instant is the DATABASE clock, and is what a worker's message is stamped with — the app host's clock
 *    (skewed an hour here) never reaches `createdAt`;
 *  - the per-worker lock serializes a worker's admissions ACROSS Channels, so a post that waits for it is recorded at the
 *    instant it was admitted, after the holder committed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { runAsActor } from './requestActor.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../api/graphql/schema/resolvers.teamChat.js';
import { DUPLICATE_WINDOW_MS, admissionTime, duplicateCutoff, findEarlierDuplicate, lockWorkerPostAdmission } from './teamChatAdmission.js';

vi.mock('./teamChatAdmission.js', async (orig) => {
  const m = await orig<typeof import('./teamChatAdmission.js')>();
  return { ...m, admissionTime: vi.fn(m.admissionTime) };
});
vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let app: { id: string };
let agent: { id: string };
let memoryId: string;
let channel: { id: string; chatRootNodeId: string };
let other: { id: string; chatRootNodeId: string };
let holder: { id: string };
let worker: { id: string; session: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'adm-org', urn: `adm-org-${suffix}.com` } });
  const manager = await db.user.create({ data: { id: generateId(), githubId: 98_801, githubUsername: `adm-m-${suffix}`, roles: ['READER'] } });
  holder = await db.user.create({ data: { id: generateId(), githubId: 98_802, githubUsername: `adm-h-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  memoryId = memory.id;
  const a = await ensureChannelWithRoot(db, { memoryId, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id });
  channel = { id: a.channel.id, chatRootNodeId: a.rootId };
  const b = await ensureChannelWithRoot(db, { memoryId, loc: 'chats:release', name: 'release', createdBy: manager.id });
  other = { id: b.channel.id, chatRootNodeId: b.rootId };
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: w.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
  worker = { id: w.id, session: session.id };
});

afterEach(() => { vi.useRealTimers(); });

const rowAt = (seq: number, createdAt: Date, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc: `chats:team:messages:${String(seq).padStart(3, '0')}`, name: String(seq), nodeType: 'chat-message', seq, messageChannelId: channel.id, content: 'words', data: {}, createdByWorkerId: worker.id, createdAt, ...extra } });
const lookup = (admittedAt: Date, over: Record<string, unknown> = {}) =>
  db.$transaction((tx) => findEarlierDuplicate(tx, { memoryId, channelId: channel.id, workerId: worker.id, body: 'words', replyTargetId: null, admittedAt, ...over } as never));

describe('the ten-minute cutoff', () => {
  const admittedAt = new Date('2026-10-30T12:00:00.000Z');

  it('is exclusive: a message exactly ten minutes old does not block, one a millisecond younger does', async () => {
    expect(duplicateCutoff(admittedAt).getTime()).toBe(admittedAt.getTime() - DUPLICATE_WINDOW_MS);
    await rowAt(1, new Date(admittedAt.getTime() - DUPLICATE_WINDOW_MS));
    expect(await lookup(admittedAt)).toBeNull();
    await rowAt(2, new Date(admittedAt.getTime() - DUPLICATE_WINDOW_MS + 1));
    expect(await lookup(admittedAt)).toBe(2);
  });

  it('answers the newest match, ignores a soft-deleted one and another worker\'s, and keeps the Channel boundary', async () => {
    await rowAt(1, new Date(admittedAt.getTime() - 1000));
    await rowAt(2, new Date(admittedAt.getTime() - 500), { deletedAt: new Date() });
    await rowAt(3, new Date(admittedAt.getTime() - 400), { createdByWorkerId: null });
    await rowAt(4, new Date(admittedAt.getTime() - 300), { messageChannelId: other.id });
    expect(await lookup(admittedAt)).toBe(1);
    expect(await lookup(admittedAt, { channelId: other.id })).toBe(4);
  });
});

describe('the admission clock is the database\'s', () => {
  it('admissionTime reads clock_timestamp(), not the app host\'s Date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3_600_000)); // the app host's clock runs an hour ahead
    const [at, [{ now }]] = await db.$transaction(async (tx) => [await admissionTime(tx), await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`] as const);
    expect(Math.abs(at.getTime() - now.getTime())).toBeLessThan(5_000);
    expect(at.getTime()).toBeLessThan(Date.now() - 3_000_000);
  });

  it('a worker\'s message is stamped with it; a human\'s keeps the default', async () => {
    const real = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(real + 3_600_000));
    const posted = await runAsActor({ workerId: worker.id, agentId: agent.id }, () =>
      teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body: 'stamped', replyToSeq: null, sessionRef: worker.session }, ctx(holder.id)));
    expect(Math.abs(posted.at.getTime() - real)).toBeLessThan(10_000); // the database's instant, not the skewed Date
  });
});

describe('the persisted createdAt IS the admission instant', () => {
  it('a worker\'s message carries exactly the instant admissionTime returned, and the receipt the same', async () => {
    const instant = new Date(Date.now() - 7_000); // distinguishable from any insert-time default
    vi.mocked(admissionTime).mockImplementationOnce(async () => instant);
    const posted = await runAsActor({ workerId: worker.id, agentId: agent.id }, () =>
      teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body: 'stamped', replyToSeq: null, sessionRef: worker.session }, ctx(holder.id)));
    const row = await db.node.findFirstOrThrow({ where: { memoryId, messageChannelId: channel.id, seq: posted.seq }, select: { createdAt: true } });
    expect(row.createdAt.getTime()).toBe(instant.getTime());
    expect(posted.at.getTime()).toBe(instant.getTime());
  });

  it('a human\'s message is not stamped with it and never asks for it', async () => {
    const calls = vi.mocked(admissionTime).mock.calls.length;
    await teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body: 'hello', replyToSeq: null, sessionRef: null }, ctx(holder.id));
    expect(vi.mocked(admissionTime).mock.calls.length).toBe(calls);
  });
});

describe('the per-worker lock', () => {
  it('serializes a worker across Channels: a post waiting for it is recorded after the holder committed', async () => {
    let releasedAt = 0;
    const held = db.$transaction(async (tx) => {
      await lockWorkerPostAdmission(tx, worker.id);
      await new Promise((r) => setTimeout(r, 1500));
    }).then(() => { releasedAt = Date.now(); });
    await new Promise((r) => setTimeout(r, 200));
    const posted = await runAsActor({ workerId: worker.id, agentId: agent.id }, () =>
      M.createChannelMessage({}, { channelRef: other.id, body: 'other channel', replyToSeq: null, sessionRef: worker.session }, ctx(holder.id)));
    await held;
    expect(posted.at.getTime()).toBeGreaterThanOrEqual(releasedAt - 50);
  });

  it('does not make one worker wait for another', async () => {
    const w2 = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Rook', slug: 'rook', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
    const s2 = await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: w2.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
    const held = db.$transaction(async (tx) => { await lockWorkerPostAdmission(tx, worker.id); await new Promise((r) => setTimeout(r, 1500)); });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await runAsActor({ workerId: w2.id, agentId: agent.id }, () =>
      M.createChannelMessage({}, { channelRef: other.id, body: 'rook', replyToSeq: null, sessionRef: s2.id }, ctx(holder.id)));
    expect(Date.now() - t0).toBeLessThan(1200);
    await held;
  });
});
