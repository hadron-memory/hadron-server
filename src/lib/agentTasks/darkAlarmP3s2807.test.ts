/**
 * #2807 — the optional P3 pins from the #2789 review of the dark-worker alarm (#2755).
 *
 * Item 1 (latest anchor wins), item 2 (the cross-App `reports_to` chain) and item 4 (migration/SQL byte identity) pin
 * behaviour that already holds, so they are proven by mutants, not by a red run on `main`. Item 5 (the empty chain's
 * log line) is red on `main`. Fixtures mirror darkWorkerWake2755.test.ts.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { darkAlarmChain, evaluateDarkWorkers } from './darkWorker.js';
import { pendingTaskWakes } from './taskWakes.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { runAsActor } from '../requestActor.js';
import { setS7AvailableForTest } from '../tickers/s7Availability.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const T0 = new Date();
const after = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

let org: { id: string; urn: string };
let app: { id: string; organizationId: string | null; ownerUserId: string | null };
let user: { id: string };
let agent: { id: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
const w: Record<string, { id: string }> = {};

/** A worker of `appId` (the first App's unless given) with a register entry on the team channel when it is that App's. */
async function makeWorker(name: string, appId = app.id, agentId = agent.id) {
  return db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name, slug: `${name.toLowerCase()}-${generateId().slice(-6)}`, role: 'engineer', heldByUserId: user.id, heldAt: new Date() },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'p3-org', urn: `p3-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 98_700 + Math.floor(Math.random() * 1000), githubUsername: `p3-${suffix}`, roles: ['READER'] } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const name of ['Liam', 'Tove']) {
    w[name] = await makeWorker(name);
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: w[name].id, role: 'BOTH' } });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function say(body: string, mentions: string[]) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(db, { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: channel.memoryId, loc: `${channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: channel.id, content: body, data: { mentions } } }),
    { asChannel: true });
}
// A QUIET live session: since #2813 a session driven inside the alarm window exempts the wake-unacked trigger, and these
// pins are about the chain, not the activity exemption (pinned in darkWorkerActive2813.test.ts). The second argument
// only documents how long the test keeps the session in play.
const bind = (name: string, _liveUntil: Date) => {
  const startedAt = new Date(T0.getTime() - 120 * MIN);
  return db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', startedAt, updatedAt: startedAt } });
};
const exemptEndedAt = async (name: string) => (await db.workerWakeSettings.findUniqueOrThrow({ where: { workerId: w[name].id } })).exemptEndedAt?.getTime();
const holderCtx = (): Context => ({ db, userId: user.id, roles: ['READER'] });
const M = resolvers.Mutation as any;
const atClock = async <T>(at: Date, fn: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(at);
    return await fn();
  } finally {
    vi.useRealTimers();
  }
};

describe('#2807 item 1: the latest exemption end wins when an existing exemptEndedAt is later than the cleared expiry', () => {
  it('clearPause on a pause that ended at +20 keeps an existing exemptEndedAt of +30', async () => {
    await db.workerWakeSettings.create({ data: { workerId: w.Tove.id, pausedUntil: after(20), exemptEndedAt: after(30) } });
    await atClock(after(45), () => runAsActor({ workerId: w.Tove.id, agentId: agent.id }, () =>
      M.setWorkerWakeSettings({}, { workerRef: w.Tove.id, input: { clearPause: true } }, holderCtx())));
    expect(await exemptEndedAt('Tove')).toBe(after(30).getTime());
  });

  it('clearPause on a running pause (ended now, +40) keeps an existing exemptEndedAt of +50', async () => {
    await db.workerWakeSettings.create({ data: { workerId: w.Tove.id, pausedUntil: after(120), exemptEndedAt: after(50) } });
    await atClock(after(40), () => runAsActor({ workerId: w.Tove.id, agentId: agent.id }, () =>
      M.setWorkerWakeSettings({}, { workerRef: w.Tove.id, input: { clearPause: true } }, holderCtx())));
    expect(await exemptEndedAt('Tove')).toBe(after(50).getTime());
  });

  it('clearWorkerIsolation on an isolation that ended at +20 keeps an existing exemptEndedAt of +30', async () => {
    setS7AvailableForTest(true);
    try {
      await db.workerWakeSettings.create({ data: { workerId: w.Tove.id, isolatedUntil: after(20), exemptEndedAt: after(30) } });
      await atClock(after(45), () => M.clearWorkerIsolation({}, { workerRef: w.Tove.id }, holderCtx()));
      expect(await exemptEndedAt('Tove')).toBe(after(30).getTime());
    } finally {
      setS7AvailableForTest(false);
    }
  });

  it('clearWorkerIsolation on a running isolation (ended now, +40) keeps an existing exemptEndedAt of +50', async () => {
    setS7AvailableForTest(true);
    try {
      await db.workerWakeSettings.create({ data: { workerId: w.Tove.id, isolatedUntil: after(120), exemptEndedAt: after(50) } });
      await atClock(after(40), () => M.clearWorkerIsolation({}, { workerRef: w.Tove.id }, holderCtx()));
      expect(await exemptEndedAt('Tove')).toBe(after(50).getTime());
    } finally {
      setS7AvailableForTest(false);
    }
  });

  it('and an earlier existing stamp is replaced by the later cleared end (the other direction of the same rule)', async () => {
    await db.workerWakeSettings.create({ data: { workerId: w.Tove.id, pausedUntil: after(30), exemptEndedAt: after(10) } });
    await atClock(after(45), () => runAsActor({ workerId: w.Tove.id, agentId: agent.id }, () =>
      M.setWorkerWakeSettings({}, { workerRef: w.Tove.id, input: { clearPause: true } }, holderCtx())));
    expect(await exemptEndedAt('Tove')).toBe(after(30).getTime());
  });
});

describe('#2807 item 2: a cross-App reports_to row never reaches the chain or the delivery', () => {
  it('a foreign worker planted as reports_to by raw SQL is in neither the chain nor pendingTaskWakes', async () => {
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: `other-${Date.now()}.com` } });
    const otherAgent = await db.agent.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Other', urn: `${otherOrg.urn}:other`, visibility: 'ORGANIZATION' } });
    const otherApp = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Other Team', urn: `${otherOrg.urn}:team` } });
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: otherAgent.id } });
    const foreign = await makeWorker('Foreign', otherApp.id, otherAgent.id);
    // The write path refuses this (workerReportsTo.ts); a write-path bug or a hand repair would not.
    await db.$executeRaw`UPDATE workers SET reports_to_worker_id = ${foreign.id} WHERE id = ${w.Tove.id}`;

    const chain = await darkAlarmChain(db, app, w.Tove.id);
    expect(chain.map((p) => p.workerId).filter(Boolean)).not.toContain(foreign.id);

    // The real raise seals a chain without the foreign worker (mutant: darkAlarmChain's per-hop same-App filter).
    await bind('Tove', after(200));
    await say('hello @tove', ['tove']);
    const raised = await evaluateDarkWorkers(db, after(31));
    expect(raised).toHaveLength(1);
    const event = await db.agentTeamEvent.findUniqueOrThrow({ where: { id: raised[0] } });
    expect(JSON.stringify(event.chain)).not.toContain(foreign.id);

    // The alarm stream is append-only, so a chain naming the foreign worker is planted as a fresh open episode of
    // another worker, and the delivery's own same-App filter must still refuse it (mutant: `w.app_id = e.app_id`).
    const eventId = generateId();
    const now = after(31);
    await db.$executeRaw`
      INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
      VALUES (${eventId}, ${app.id}, 'alarm.dark-worker', NULL, ${w.Liam.id}, 'alarm', ${JSON.stringify([{ workerId: foreign.id }])}::jsonb,
              ${JSON.stringify({ reason: 'overdue', windowMinutes: 30 })}::jsonb, ${now.toISOString().replace('Z', '')}::timestamp, NULL)`;
    await db.darkWorkerEpisode.create({ data: { appId: app.id, workerId: w.Liam.id, eventId, reason: 'overdue', openedAt: now } });
    await db.agentTeamAlarmSchedule.create({ data: { eventId, chainIndex: 0, dueAt: now, wokenAt: now } });
    expect((await pendingTaskWakes(db, [foreign.id], now)).get(foreign.id) ?? []).toHaveLength(0);
  });
});

describe('#2807 item 4: the migration and prisma/dark-alarm-invariants.sql stay byte-identical', () => {
  it('the invariants file is exactly the migration after its two column statements', () => {
    const invariants = readFileSync(new URL('../../../prisma/dark-alarm-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261029120000_dark_alarm_window/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(invariants)).toBe(true);
    // What the migration adds beyond the file is only the two Prisma-modelled column adds.
    expect(migration.slice(0, migration.length - invariants.length)).toBe(
      '-- #2755 — the dark-worker alarm: its per-App window and its episode table.\n' +
      'ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "delivery_dark_alarm_window_seconds" INTEGER NOT NULL DEFAULT 1800;\n' +
      '\n' +
      '-- #2755 — when an active pause or isolation was cleared on purpose (the end of an exemption a clear would erase).\n' +
      'ALTER TABLE worker_wake_settings ADD COLUMN IF NOT EXISTS exempt_ended_at TIMESTAMP(3);\n' +
      '\n',
    );
  });
});

describe('#2807 item 5: an empty chain is logged once per raised episode', () => {
  it('a worker with no reporting line in an App with no managers raises the alarm and logs dark_worker.chain_empty once', async () => {
    // No owner, no org admin and no app owner: appManagerUserIds is empty. The holder stays a plain member (it must still
    // participate for the wake to be due).
    await db.orgMember.deleteMany({ where: { organizationId: org.id } });
    await bind('Tove', after(200));
    await say('hello @tove', ['tove']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const raised = await evaluateDarkWorkers(db, after(31));
    expect(raised).toHaveLength(1);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dark_worker.chain_empty'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ event: 'dark_worker.chain_empty', appId: app.id, workerId: w.Tove.id, eventId: raised[0] });
    // The alarm and its episode still exist, and nobody was scheduled.
    const event = await db.agentTeamEvent.findUniqueOrThrow({ where: { id: raised[0] } });
    expect(event.chain).toEqual([]);
    expect(await db.darkWorkerEpisode.count({ where: { workerId: w.Tove.id, endedAt: null, eventId: raised[0] } })).toBe(1);
    expect(await db.agentTeamAlarmSchedule.count({ where: { eventId: raised[0] } })).toBe(0);

    // A later pass in the same episode raises nothing and logs nothing: once per raised episode.
    warn.mockClear();
    expect(await evaluateDarkWorkers(db, after(40))).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dark_worker.chain_empty'))).toHaveLength(0);
  });

  it('a worker with a non-empty chain logs no such line', async () => {
    await bind('Tove', after(200));
    await say('hello @tove', ['tove']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await evaluateDarkWorkers(db, after(31))).toHaveLength(1);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dark_worker.chain_empty'))).toHaveLength(0);
  });
});
