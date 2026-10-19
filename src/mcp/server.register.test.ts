import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * Spec 049 Phase 5 — the register tools on the MCP surface.
 *
 * The rules are pinned in lib/register.test.ts; this covers the SURFACE: the
 * tools go through the same resolvers (the install default lists under the
 * active App; add → list → remove round-trip), a refusal comes back as a
 * `[code] message` text envelope rather than a thrown error, and a Channel
 * whose host memory the caller cannot read is named by id only — the same
 * gate `RegisterEntry.channel` applies (Codex P1 on PR #1166).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { idleWindowMsFor } from '../lib/sessionActivity.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let app: { id: string; urn: string };
let app2: { id: string; urn: string };
let agent: { id: string; urn: string };
let worker: { id: string };
let channel: { id: string };
let channel2: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'rgm', urn: `rgm-${t}.com` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 49301, githubUsername: `rgm-admin-${t}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 49302, githubUsername: `rgm-member-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
  app2 = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  // The admin participates in BOTH Apps (app-class memories admit participants, not org rank); the member only in the first.
  await db.appMember.create({ data: { appId: app2.id, userId: admin.id, role: 'owner' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appAgent.create({ data: { appId: app2.id, agentId: agent.id } });
  const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-shared`, name: 's', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const mem2 = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`, name: 's2', class: 'app', appId: app2.id, sharedMemoryOfAgentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  channel = (await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id })).channel;
  channel2 = (await ensureChannelWithRoot(db, { memoryId: mem2.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app2.id })).channel;
});

function server(userId: string, activeAppId: string = app.id) {
  const auth = { userId, roles: ['READER'], clientId: `user:${userId}`, appId: activeAppId, organizationId: org.id } as AuthContext;
  return createTestableMcpServer(auth, { sessionId: `rgm-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
}

describe('register tools', () => {
  it('lists the install default under the active App; add → list → remove round-trip', async () => {
    const asAdmin = server(admin.id);
    const listed = await asAdmin.callToolText('hadron_register_list', {});
    expect(listed).toContain('1 register entry');
    expect(listed).toContain(`team (chats:team) ← ${agent.urn} — BOTH, install default`);
    const added = await asAdmin.callToolText('hadron_register_add', { channel: channel.id, attendee: worker.id, role: 'WATCH', description: 'Iris watches' });
    expect(added).toContain('Added.');
    expect(added).toContain(`hrn:worker:${org.urn}:app:iris — WATCH`);
    expect(added).toContain('Iris watches');
    const id = added.match(/id ([0-9a-f]{32})/)![1];
    expect(await asAdmin.callToolText('hadron_register_list', { attendee: worker.id })).toContain('1 register entry');
    expect(await asAdmin.callToolText('hadron_register_remove', { entry: id })).toBe('Removed.');
    expect(await asAdmin.callToolText('hadron_register_list', { attendee: worker.id })).toContain('No register entries');
  });

  it('a refusal is a [code] text envelope, not a thrown error', async () => {
    const asMember = server(member.id);
    expect(await asMember.callToolText('hadron_register_add', { channel: channel.id })).toMatch(/^\[forbidden\]/);
    const dup = await server(admin.id).callToolText('hadron_register_add', { channel: channel.id, attendee: agent.urn });
    expect(dup).toMatch(/^\[register_entry_exists\]/);
    const foreign = await server(admin.id).callToolText('hadron_register_add', { channel: 'nope' });
    expect(foreign).toMatch(/^\[bad_user_input\] No match for channelRef "nope"/);
    const install = await db.registerEntry.findFirstOrThrow({ where: { appId: app.id } });
    expect(await asMember.callToolText('hadron_register_remove', { entry: install.id })).toMatch(/^\[forbidden\]/);
  });

  it('an owner-side reader sees the row but not a Channel whose host memory they cannot read', async () => {
    // An org row (admin is org ADMIN) naming the OTHER App's Channel; the
    // member is on the org side but not a participant of that App.
    const asAdmin = server(admin.id);
    await asAdmin.callToolText('hadron_register_add', { owner: org.urn, channel: channel2.id });
    const seen = await server(member.id).callToolText('hadron_register_list', { owner: org.urn });
    expect(seen).toContain('1 register entry');
    expect(seen).toContain(`channel ${channel2.id} (host memory not readable to you)`);
    expect(seen).not.toContain('team (chats:team)');
    // The admin, driving the OTHER App (an active App bounds MCP reads to its memories), sees the name and address.
    expect(await server(admin.id, app2.id).callToolText('hadron_register_list', { owner: org.urn })).toContain('team (chats:team) ← every attendee');
  });
});

describe('the register on the identity surfaces (Phase 6)', () => {
  it('hadron_start_session, hadron_get_worker and hadron_whoami all carry the bound worker\'s register block', async () => {
    const asAdmin = server(admin.id);
    const started = await asAdmin.callToolText('hadron_start_session', { description: 'stint', workerRef: 'Iris' });
    expect(started).toContain('## Channels (register)');
    expect(started).toContain('- team — hrn:mem:');
    expect(await asAdmin.callToolText('hadron_get_worker', { workerRef: 'Iris' })).toContain('## Channels (register)');
    const who = await asAdmin.callToolText('hadron_whoami', {});
    expect(who).toContain('working as: Iris');
    expect(who).toContain('    ## Channels (register)');
  });
});

describe('team-chat monitor (#1265)', () => {
  type MonitorCheckpoint = { worker: string; channel: string; seq: number; proof: string };
  const checkpointsOf = (text: string): MonitorCheckpoint[] => {
    const raw = text.match(/deliberately acknowledge this checkpoint:\n(\[[^\n]+\])/s)?.[1];
    expect(raw).toBeTruthy();
    return JSON.parse(raw!) as MonitorCheckpoint[];
  };

  it('routes mention-only attention for this operator\'s live Workers and advances only on deliberate acknowledgement', async () => {
    const mira = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Mira', slug: 'mira' },
    });
    const asAdmin = server(admin.id);
    const irisStarted = await asAdmin.callToolText('hadron_start_session', { description: 'Iris stint', workerRef: 'Iris' });
    const miraStarted = await asAdmin.callToolText('hadron_start_session', { description: 'Mira stint', workerRef: 'Mira' });
    expect(irisStarted).toContain('Session started:');
    expect(miraStarted).toContain('Session started:');

    expect(await asAdmin.callToolText('hadron_register_add', {
      channel: channel.id,
      attendee: worker.id,
      role: 'WATCH',
      mentionOnly: true,
    })).toContain('Added.');
    expect(await asAdmin.callToolText('hadron_register_add', {
      channel: channel.id,
      attendee: mira.id,
      role: 'WATCH',
      mentionOnly: true,
    })).toContain('Added.');
    expect(await asAdmin.callToolText('hadron_team_chat_post', { asMe: true, body: 'Please check this, @Iris.' })).toContain('message #1');

    const first = await asAdmin.callToolText('hadron_team_chat_read', { monitor: true });
    expect(first).toContain('1 message needs routing');
    expect(first).toContain('Please check this, @Iris.');
    expect(first).toContain('mentions: @iris');
    expect(first).toContain(`route to: hrn:worker:${org.urn}:app:iris`);
    expect(first).not.toContain(`route to: hrn:worker:${org.urn}:app:mira`);
    expect(first).not.toContain('HOST_MEMORY_NOT_WRITABLE');
    const checkpoints = checkpointsOf(first);
    expect(checkpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ worker: worker.id, channel: channel.id, seq: 1 }),
      expect.objectContaining({ worker: mira.id, channel: channel.id, seq: 1 }),
    ]));
    expect(checkpoints.every((checkpoint) => checkpoint.proof.length > 20)).toBe(true);
    expect(await db.channelReadState.count()).toBe(0);

    // A read (and even a fresh server instance after a relay restart) repeats
    // the same window until the host says its action succeeded.
    const restarted = server(admin.id);
    expect(await restarted.callToolText('hadron_team_chat_read', { monitor: true })).toContain('Please check this, @Iris.');
    expect(await db.channelReadState.count()).toBe(0);

    const afterAck = await restarted.callToolText('hadron_team_chat_read', {
      monitor: true,
      acknowledge: checkpoints,
    });
    expect(afterAck).toContain('Acknowledged');
    expect(afterAck).toContain('No new registered team-chat attention');
    expect(await db.channelReadState.findMany({
      where: { channelId: channel.id },
      orderBy: { workerId: 'asc' },
      select: { workerId: true, lastSeenSeq: true },
    })).toEqual([
      { workerId: [worker.id, mira.id].sort()[0], lastSeenSeq: 1 },
      { workerId: [worker.id, mira.id].sort()[1], lastSeenSeq: 1 },
    ]);
    expect(await server(admin.id).callToolText('hadron_team_chat_read', { monitor: true })).toContain('No new registered team-chat attention');

    await restarted.callToolText('hadron_team_chat_post', { asMe: true, body: '@all broadcast' });
    await restarted.callToolText('hadron_team_chat_post', { asMe: true, body: '@team broadcast' });
    await restarted.callToolText('hadron_team_chat_post', { asMe: true, body: '@someone unrelated' });
    const broadcasts = await restarted.callToolText('hadron_team_chat_read', { monitor: true });
    expect(broadcasts).toContain('2 messages need routing');
    expect(broadcasts).toContain('@all broadcast');
    expect(broadcasts).toContain('@team broadcast');
    expect(broadcasts).not.toContain('@someone unrelated');
    const routeLines = broadcasts.split('\n').filter((line) => line.startsWith('route to:'));
    expect(routeLines).toHaveLength(2);
    expect(routeLines.every((line) => line.includes(`hrn:worker:${org.urn}:app:iris`))).toBe(true);
    expect(routeLines.every((line) => line.includes(`hrn:worker:${org.urn}:app:mira`))).toBe(true);

    await restarted.callToolText('hadron_team_chat_read', {
      monitor: true,
      acknowledge: checkpointsOf(broadcasts),
    });
    const irisSession = irisStarted.match(/Session started: (\S+)/)![1];
    // #2020: a worker's broadcast is a mention only when the server stamped it
    // at post time — Iris holds no broadcast grant yet, so it routes nowhere.
    expect(await restarted.callToolText('hadron_team_chat_post', {
      body: '@all @team by Iris',
      session: irisSession,
    })).toContain('message #5');
    const unstamped = await restarted.callToolText('hadron_team_chat_read', { monitor: true });
    expect(unstamped).not.toContain('@all @team by Iris');
    expect(unstamped).not.toContain('route to:');
    await db.appGrant.create({ data: { id: generateId(), appId: app.id, granteeWorkerId: worker.id, name: 'ticker.subscribe-workers', grantedBy: admin.id } });
    expect(await restarted.callToolText('hadron_team_chat_post', {
      body: '@all @team by Iris, granted',
      session: irisSession,
    })).toContain('message #6');
    const authoredBroadcast = await restarted.callToolText('hadron_team_chat_read', { monitor: true });
    expect(authoredBroadcast).toContain('1 message needs routing');
    expect(authoredBroadcast).toContain('@all @team by Iris, granted');
    expect(authoredBroadcast).toContain(`route to: hrn:worker:${org.urn}:app:mira`);
    expect(authoredBroadcast).not.toContain(`route to: hrn:worker:${org.urn}:app:iris`);
  });

  it('never routes an ordinary WATCH message back to its Worker author', async () => {
    const asAdmin = server(admin.id);
    const started = await asAdmin.callToolText('hadron_start_session', { description: 'Iris stint', workerRef: 'Iris' });
    const session = started.match(/Session started: (\S+)/)![1];
    expect(await asAdmin.callToolText('hadron_register_add', {
      channel: channel.id,
      attendee: worker.id,
      role: 'WATCH',
    })).toContain('Added.');
    expect(await asAdmin.callToolText('hadron_team_chat_post', {
      body: 'Ordinary message by Iris',
      session,
    })).toContain('message #1');

    const monitored = await asAdmin.callToolText('hadron_team_chat_read', { monitor: true });
    expect(monitored).toContain('No messages in the scanned window need routing to these attendees.');
    expect(monitored).not.toContain('route to:');
    expect(checkpointsOf(monitored)).toEqual([
      expect.objectContaining({ worker: worker.id, channel: channel.id, seq: 1 }),
    ]);
  });

  it('refuses manual cursors, App-key monitoring, non-live targets and impossible acknowledgements', async () => {
    const asAdmin = server(admin.id);
    await asAdmin.callToolText('hadron_start_session', { description: 'Iris stint', workerRef: 'Iris' });
    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, sinceSeq: 0 })).toMatch(/^\[bad_user_input\]/);
    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, limit: 0 })).toMatch(/^\[bad_user_input\]/);
    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitorFor: worker.id })).toMatch(/^\[bad_user_input\]/);

    const theirs = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Theirs', slug: 'theirs' },
    });
    await server(member.id).callToolText('hadron_start_session', { description: 'another operator', workerRef: 'Theirs' });
    const ownOnly = await asAdmin.callToolText('hadron_team_chat_read', { monitor: true });
    expect(ownOnly).toContain('1 live Worker monitored');
    expect(ownOnly).not.toContain(`hrn:worker:${org.urn}:app:${theirs.slug}`);

    const idle = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Idle', slug: 'idle' },
    });
    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, monitorFor: idle.id })).toMatch(/^\[monitor_target_not_live\]/);
    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, monitorFor: 'does-not-exist' })).toMatch(/^\[monitor_target_not_live\]/);
    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, channel: channel2.id })).toMatch(/^\[channel_not_found\]/);
    await asAdmin.callToolText('hadron_team_chat_post', { asMe: true, body: 'checkpoint me' });
    const checkpoint = checkpointsOf(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, monitorFor: worker.id }))[0];
    expect(await asAdmin.callToolText('hadron_team_chat_read', {
      monitor: true,
      monitorFor: worker.id,
      acknowledge: [checkpoint, { ...checkpoint, seq: checkpoint.seq + 1 }],
    })).toMatch(/^\[invalid_checkpoint\]/);
    expect(await db.channelReadState.count()).toBe(0);
    expect(await asAdmin.callToolText('hadron_team_chat_read', {
      monitor: true,
      monitorFor: worker.id,
      acknowledge: Array.from({ length: 21 }, () => checkpoint),
    })).toMatch(/^\[bad_user_input\]/);

    const memoryId = (await db.channel.findUniqueOrThrow({ where: { id: channel.id }, select: { memoryId: true } })).memoryId;
    const otherChannel = (await ensureChannelWithRoot(db, {
      memoryId,
      loc: 'chats:other',
      name: 'other',
      createdBy: admin.id,
    })).channel;
    await asAdmin.callToolText('hadron_register_add', { channel: otherChannel.id, attendee: worker.id, role: 'WATCH' });
    expect(await asAdmin.callToolText('hadron_team_chat_read', {
      monitor: true,
      monitorFor: worker.id,
      channel: otherChannel.id,
      acknowledge: [checkpoint],
    })).toMatch(/^\[invalid_checkpoint\]/);

    const appKey = createTestableMcpServer(
      { appId: app.id, organizationId: org.id } as AuthContext,
      { sessionId: `rgm-app-${generateId()}` },
    );
    expect(await appKey.callToolText('hadron_team_chat_read', { monitor: true })).toMatch(/^\[forbidden\]/);
  });

  it('observes a stale Worker session without heartbeating it back to live', async () => {
    const asAdmin = server(admin.id);
    const started = await asAdmin.callToolText('hadron_start_session', { description: 'stale stint', workerRef: 'Iris' });
    const sessionId = started.match(/Session started: (\S+)/)![1];
    const staleAt = new Date(Date.now() - idleWindowMsFor('DEVELOPER') - 60_000);
    await db.session.update({ where: { id: sessionId }, data: { startedAt: staleAt, updatedAt: staleAt } });
    await db.usageEvent.deleteMany({ where: { sessionId } });

    // #1617 B: the caller holds Iris and nobody else drives her, so her lapsed
    // session is RESUMABLE and stays monitored — a quiet night must not make a
    // worker unwakeable. Observing still resumes nothing.
    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, session: sessionId })).toContain(
      '1 live Worker monitored',
    );
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { updatedAt: true } })).updatedAt?.getTime()).toBe(staleAt.getTime());
  });

  it('#1617 B: a stale session on a worker the caller does NOT hold is not monitored', async () => {
    const asAdmin = server(admin.id);
    const started = await asAdmin.callToolText('hadron_start_session', { description: 'stale stint', workerRef: 'Iris' });
    const sessionId = started.match(/Session started: (\S+)/)![1];
    const staleAt = new Date(Date.now() - idleWindowMsFor('DEVELOPER') - 60_000);
    await db.session.update({ where: { id: sessionId }, data: { startedAt: staleAt, updatedAt: staleAt } });
    await db.usageEvent.deleteMany({ where: { sessionId } });
    await db.worker.update({ where: { id: worker.id }, data: { heldByUserId: null, heldAt: null } });

    expect(await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, session: sessionId })).toContain(
      'No live Worker sessions of yours',
    );
  });

  it('does not attribute monitor transcript reads to the transport-bound Worker session', async () => {
    const asAdmin = server(admin.id);
    const started = await asAdmin.callToolText('hadron_start_session', { description: 'observed stint', workerRef: 'Iris' });
    const sessionId = started.match(/Session started: (\S+)/)![1];
    await asAdmin.callToolText('hadron_team_chat_post', { asMe: true, body: 'new attention' });
    await db.usageEvent.deleteMany({ where: { sessionId } });
    const bound = createTestableMcpServer(
      { userId: admin.id, roles: ['READER'], clientId: `user:${admin.id}`, appId: app.id, organizationId: org.id, sessionId } as AuthContext,
      { sessionId: `rgm-bound-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } },
    );

    expect(await bound.callToolText('hadron_team_chat_read', { monitor: true })).toContain('new attention');
    expect(await db.usageEvent.count({ where: { sessionId } })).toBe(0);
  });

  it('checkpoints the captured watermark after an exhausted page ending in a tombstone', async () => {
    const asAdmin = server(admin.id);
    await asAdmin.callToolText('hadron_start_session', { description: 'Iris stint', workerRef: 'Iris' });
    await asAdmin.callToolText('hadron_team_chat_post', { asMe: true, body: 'soon deleted' });
    const { memoryId } = await db.channel.findUniqueOrThrow({ where: { id: channel.id }, select: { memoryId: true } });
    await db.node.updateMany({ where: { memoryId, seq: 1, nodeType: { in: ['chat-message', 'record'] } }, data: { deletedAt: new Date() } });

    const out = await asAdmin.callToolText('hadron_team_chat_read', { monitor: true, monitorFor: worker.id });
    expect(out).toContain('No messages in the scanned window need routing');
    expect(checkpointsOf(out)[0]).toEqual(expect.objectContaining({ worker: worker.id, channel: channel.id, seq: 1 }));
  });
});
