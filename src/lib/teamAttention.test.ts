/** #1353 — loss-safe compact attention, worker-owned reads and switchover. */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { appendChatMessage } from './chatRoot.js';
import { getMemoryEncryptionInfo } from './nodeCrypto.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import type { AuthContext } from '../middleware/auth.js';
import {
  confirmTeamAttentionSwitchover,
  getTeamAttention,
  previewTeamAttentionSwitchover,
} from './teamAttention.js';

vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let user: { id: string };
let otherUser: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };
let agent: { id: string };
let memory: { id: string; urn: string };
let channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
let worker: { id: string; name: string };
let sessionId: string;

const userCtx = (extra: Partial<Context> = {}): Context => ({ db, userId: user.id, roles: ['READER'], ...extra }) as Context;

async function post(body: string, options: { authorWorkerId?: string; mentions?: string[] } = {}) {
  const enc = await getMemoryEncryptionInfo(db, channel.memoryId);
  return appendChatMessage(
    db,
    { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc },
    enc,
    async ({ tx, seq, msgNum }) => tx.node.create({
      data: {
        id: generateId(),
        memoryId: channel.memoryId,
        loc: `${channel.loc}:messages:${msgNum}`,
        name: msgNum,
        nodeType: 'chat-message',
        seq,
        content: body,
        data: {
          mentions: options.mentions ?? [],
          ...(options.authorWorkerId ? { authorWorkerId: options.authorWorkerId } : {}),
        },
      },
    }),
    { asChannel: true },
  );
}

async function addWorker(name: string) {
  const made = await db.worker.create({
    data: { id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase() },
  });
  await db.registerEntry.create({
    data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: made.id, role: 'BOTH' },
  });
  const madeSession = await db.session.create({
    data: { id: generateId(), appId: app.id, userId: user.id, workerId: made.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  return { ...made, sessionId: madeSession.id };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'attention', urn: `attention-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 1353001, githubUsername: `attention-${suffix}` } });
  otherUser = await db.user.create({ data: { id: generateId(), githubId: 1353002, githubUsername: `other-${suffix}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: otherUser.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Pilot', urn: `${org.urn}:pilot` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'admin' } });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:pilot-shared`,
      name: 'shared',
      class: 'app',
      appId: app.id,
      sharedMemoryOfAgentId: agent.id,
    },
  });
  worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  const made = await ensureChannelWithRoot(db, {
    memoryId: memory.id,
    loc: 'chats:team',
    name: 'team',
    createdBy: user.id,
    asDefaultOfAppId: app.id,
  });
  channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  await db.registerEntry.create({
    data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
  });
  sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  process.env.TEAM_ATTENTION_PILOT_USER_IDS = user.id;
  process.env.TEAM_ATTENTION_PILOT_APP_IDS = app.id;
});

afterEach(() => {
  delete process.env.TEAM_ATTENTION_PILOT_USER_IDS;
  delete process.env.TEAM_ATTENTION_PILOT_APP_IDS;
  delete process.env.TEAM_ATTENTION_TOKEN_SECRET;
  sessionKeyCache.clear();
});

describe('worker-owned ordinary reads', () => {
  it('advances only contiguous, unfiltered forward pages and preserves every unsafe window', async () => {
    for (let i = 1; i <= 5; i++) await post(`message ${i}`);
    const ctx = userCtx({ sessionId });

    // A partial forward page proves only that page was consumed.
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 2, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });

    // Starting ahead of the stored cursor leaves a gap; backward, offset and
    // filtered windows likewise cannot prove the missing interval was read.
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 4, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: null, beforeSeq: 5, mentionsRef: null, limit: 2, offset: 0 }, ctx);
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 2, beforeSeq: null, mentionsRef: null, limit: 2, offset: 1 }, ctx);
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 2, beforeSeq: null, mentionsRef: worker.id, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });

    // The complete contiguous remainder reaches the captured head.
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 2, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 5 });
  });

  it('an empty visible result may cross tombstones, while count-only and outside-pilot reads stay read-only', async () => {
    const tombstone = await post('deleted before read');
    await db.node.updateMany({
      where: { memoryId: channel.memoryId, nodeType: 'chat-message', seq: tombstone.seq },
      data: { deletedAt: new Date() },
    });
    const ctx = userCtx({ sessionId });

    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 0, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });

    await db.channelReadState.deleteMany();
    delete process.env.TEAM_ATTENTION_PILOT_USER_IDS;
    await Q.channelMessages({}, { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 }, ctx);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();
  });

  it('derives the cursor owner App from the Worker session for a registered free-standing Channel', async () => {
    const externalMemory = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: user.id,
        urn: `${org.urn}:external-${Date.now()}`,
        name: 'external',
        class: 'knowledge',
      },
    });
    const external = await ensureChannelWithRoot(db, {
      memoryId: externalMemory.id,
      loc: 'chats:external',
      name: 'external',
      createdBy: user.id,
    });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: external.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' },
    });
    const enc = await getMemoryEncryptionInfo(db, externalMemory.id);
    await appendChatMessage(
      db,
      { id: external.rootId, memoryId: externalMemory.id, loc: 'chats:external' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(),
          memoryId: externalMemory.id,
          loc: `chats:external:messages:${msgNum}`,
          name: msgNum,
          nodeType: 'chat-message',
          seq,
          content: 'registered outside the pilot App',
        },
      }),
      { asChannel: true },
    );

    await Q.channelMessages(
      {},
      { channelRef: external.channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 },
      userCtx({ sessionId }),
    );
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: external.channel.id } })).toMatchObject({ lastSeenSeq: 1 });
  });
});

describe('signed attention poll', () => {
  it('domain-separates attention signatures even when the configured secret is shared', async () => {
    process.env.TEAM_ATTENTION_TOKEN_SECRET = 'shared-test-secret';
    const result = await getTeamAttention(userCtx(), app.id);
    const [body, signature] = result.token.split('.');
    const rawSharedSecretSignature = createHmac('sha256', 'shared-test-secret')
      .update(body)
      .digest('base64url');

    expect(signature).not.toBe(rawSharedSecretSignature);
    await expect(getTeamAttention(userCtx(), app.id, result.token)).resolves.toMatchObject({ workers: [] });
  });

  it('conceals an existing App from a non-participant exactly like an absent App', async () => {
    const outsider = await db.user.create({
      data: { id: generateId(), githubId: 1353003, githubUsername: `outsider-${Date.now()}` },
    });
    process.env.TEAM_ATTENTION_PILOT_USER_IDS = outsider.id;
    const outsiderCtx = { db, userId: outsider.id, roles: ['READER'] } as Context;

    const existing = getTeamAttention(outsiderCtx, app.id).catch((error) => error);
    const absent = getTeamAttention(outsiderCtx, generateId()).catch((error) => error);
    const [existingError, absentError] = await Promise.all([existing, absent]);

    expect(existingError).toMatchObject({ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } });
    expect(absentError).toMatchObject({ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } });
  });

  it('derives mention-only relevance and counts from the register while excluding the Worker author', async () => {
    await db.registerEntry.updateMany({
      where: { appId: app.id, attendeeWorkerId: worker.id },
      data: { mentionOnly: true },
    });
    await post('ordinary unread');
    await post('@dara relevant', { mentions: ['dara'] });
    await post('@all broadcast', { mentions: ['all'] });
    await post('@team broadcast', { mentions: ['team'] });
    await post('@someone unrelated', { mentions: ['someone'] });
    await post('@dara by Dara', { mentions: ['dara'], authorWorkerId: worker.id });

    const result = await getTeamAttention(userCtx(), app.id);
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0].channels).toEqual([
      expect.objectContaining({ unread: 5, unreadMentions: 3, firstUnreadSeq: 1, lastSeq: 6 }),
    ]);
  });

  it('excludes broadcast authors while counting multiple broadcast tokens once for another Worker', async () => {
    const mira = await addWorker('Mira');
    await db.registerEntry.updateMany({
      where: { appId: app.id, channelId: channel.id },
      data: { mentionOnly: true },
    });
    await post('@all @team by Dara', { mentions: ['all', 'team'], authorWorkerId: worker.id });
    await post('@all @team by Mira', { mentions: ['all', 'team'], authorWorkerId: mira.id });

    const result = await getTeamAttention(userCtx(), app.id);
    expect(result.workers).toHaveLength(2);
    expect(result.workers.find((row) => row.worker === worker.id)?.channels[0]).toMatchObject({
      unread: 1, unreadMentions: 1, firstUnreadSeq: 2, lastSeq: 2,
    });
    expect(result.workers.find((row) => row.worker === mira.id)?.channels[0]).toMatchObject({
      unread: 1, unreadMentions: 1, firstUnreadSeq: 1, lastSeq: 2,
    });
  });

  it('pages an encrypted Channel once for multiple Workers and fails safe when the key is unavailable', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    sessionKeyCache.set('attention-encrypted', memory.id, generateDataKey());
    const iris = await addWorker('Iris');
    await db.registerEntry.updateMany({
      where: { appId: app.id, attendeeWorkerId: worker.id, channelId: channel.id },
      data: { mentionOnly: true },
    });
    await post('ordinary encrypted unread');
    await post('@dara encrypted relevant', { mentions: ['dara'] });
    await post('@dara encrypted by Dara', { mentions: ['dara'], authorWorkerId: worker.id });
    // Cross the encrypted keyset-page boundary. The scan is per Channel, so
    // this backlog is decrypted once and fanned out to both Worker predicates.
    for (let i = 0; i < 48; i++) await post(`encrypted page filler ${i}`);

    const result = await getTeamAttention(userCtx(), app.id);
    expect(result.workers.find((row) => row.worker === worker.id)?.channels[0]).toMatchObject({
      unread: 50,
      unreadMentions: 1,
      firstUnreadSeq: 1,
      lastSeq: 51,
    });
    expect(result.workers.find((row) => row.worker === iris.id)?.channels[0]).toMatchObject({
      unread: 51,
      unreadMentions: 0,
      firstUnreadSeq: 1,
      lastSeq: 51,
    });

    sessionKeyCache.clear();
    await expect(getTeamAttention(userCtx(), app.id)).rejects.toMatchObject({
      extensions: { code: 'SESSION_EXPIRED', memoryId: memory.id },
    });
  });

  it('retries the whole delivery set after a partial failure, while adopting the returned token suppresses it', async () => {
    const iris = await addWorker('Iris');
    const baseline = await getTeamAttention(userCtx(), app.id);
    await post('for both workers');

    const first = await getTeamAttention(userCtx(), app.id, baseline.token);
    expect(first.workers.map((w) => w.worker).sort()).toEqual([iris.id, worker.id].sort());

    // One nudge succeeded and one failed: retaining the old token returns the
    // entire atomic set again. Duplicates are visible; loss is impossible.
    const retry = await getTeamAttention(userCtx(), app.id, baseline.token);
    expect(retry.workers.map((w) => w.worker).sort()).toEqual([iris.id, worker.id].sort());
    expect((await getTeamAttention(userCtx(), app.id, first.token)).workers).toEqual([]);
  });

  it('handles delayed nudges, posts during polling, own posts, and a Worker first seen after the token', async () => {
    const baseline = await getTeamAttention(userCtx(), app.id);
    await post('new after the snapshot');
    const pending = await getTeamAttention(userCtx(), app.id, baseline.token);
    expect(pending.workers[0].channels[0]).toMatchObject({ unread: 1, firstUnreadSeq: 1, lastSeq: 1 });

    // The Worker reads before a delayed nudge is delivered: unread state is
    // authoritative, so the old token no longer produces a stale nudge.
    await Q.channelMessages(
      {},
      { channelRef: channel.id, sinceSeq: 0, beforeSeq: null, mentionsRef: null, limit: 50, offset: 0 },
      userCtx({ sessionId }),
    );
    expect((await getTeamAttention(userCtx(), app.id, baseline.token)).workers).toEqual([]);

    const afterRead = await getTeamAttention(userCtx(), app.id);
    await post('written by Dara', { authorWorkerId: worker.id });
    expect((await getTeamAttention(userCtx(), app.id, afterRead.token)).workers).toEqual([]);

    await post('arrived during the next poll');
    expect((await getTeamAttention(userCtx(), app.id, afterRead.token)).workers).toHaveLength(1);

    const newcomer = await addWorker('Newcomer');
    const seenBeforeNewcomer = await getTeamAttention(userCtx(), app.id);
    expect(seenBeforeNewcomer.workers.some((w) => w.worker === newcomer.id)).toBe(true);
  });

  it('binds tokens to the exact operator and App, and refuses the backlog-skipping shortcut', async () => {
    const result = await getTeamAttention(userCtx(), app.id);
    process.env.TEAM_ATTENTION_PILOT_USER_IDS = `${user.id},${otherUser.id}`;
    process.env.TEAM_ATTENTION_PILOT_APP_IDS = `${app.id},${otherApp.id}`;
    await expect(getTeamAttention({ db, userId: otherUser.id, roles: ['READER'] } as Context, app.id, result.token)).rejects.toMatchObject({ extensions: { code: 'INVALID_ATTENTION_TOKEN' } });
    await expect(getTeamAttention(userCtx(), otherApp.id, result.token)).rejects.toMatchObject({ extensions: { code: 'INVALID_ATTENTION_TOKEN' } });
    await expect(getTeamAttention(userCtx(), app.id, 'now')).rejects.toMatchObject({ extensions: { code: 'SWITCHOVER_CONFIRMATION_REQUIRED' } });
  });
});

describe('explicit switchover', () => {
  it('requires a fresh same-operator/App proof and leaves post-preview messages unread', async () => {
    await post('backlog');
    const preview = await previewTeamAttentionSwitchover(userCtx(), app.id);
    expect(preview.workers[0].channels[0]).toMatchObject({ fromSeq: 0, throughSeq: 1, unread: 1 });
    await post('arrived after preview');

    const applied = await confirmTeamAttentionSwitchover(userCtx(), app.id, preview.proof);
    expect(applied).toMatchObject({ applied: true, workersAdvanced: 1, channelsAdvanced: 1 });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });
    const remaining = await getTeamAttention(userCtx(), app.id);
    expect(remaining.workers[0].channels[0]).toMatchObject({ unread: 1, firstUnreadSeq: 2, lastSeq: 2 });

    process.env.TEAM_ATTENTION_PILOT_USER_IDS = `${user.id},${otherUser.id}`;
    await expect(confirmTeamAttentionSwitchover({ db, userId: otherUser.id, roles: ['READER'] } as Context, app.id, preview.proof)).rejects.toMatchObject({ extensions: { code: 'INVALID_SWITCHOVER_PROOF' } });
    process.env.TEAM_ATTENTION_PILOT_APP_IDS = `${app.id},${otherApp.id}`;
    await expect(confirmTeamAttentionSwitchover(userCtx(), otherApp.id, preview.proof)).rejects.toMatchObject({ extensions: { code: 'INVALID_SWITCHOVER_PROOF' } });
  });

  it('rejects cursor or live-scope drift atomically', async () => {
    await post('backlog');
    const preview = await previewTeamAttentionSwitchover(userCtx(), app.id);
    await db.channelReadState.create({ data: { id: generateId(), workerId: worker.id, channelId: channel.id, lastSeenSeq: 1 } });
    await expect(confirmTeamAttentionSwitchover(userCtx(), app.id, preview.proof)).rejects.toMatchObject({ extensions: { code: 'SWITCHOVER_PROOF_STALE' } });

    await db.channelReadState.deleteMany();
    const second = await previewTeamAttentionSwitchover(userCtx(), app.id);
    await addWorker('Scope Drift');
    await expect(confirmTeamAttentionSwitchover(userCtx(), app.id, second.proof)).rejects.toMatchObject({ extensions: { code: 'SWITCHOVER_PROOF_STALE' } });
    expect(await db.channelReadState.count()).toBe(0);
  });

  it('accepts a freshly minted proof when a reused Channel head is behind its preserved cursor', async () => {
    await db.channelReadState.create({
      data: { id: generateId(), workerId: worker.id, channelId: channel.id, lastSeenSeq: 5 },
    });
    const preview = await previewTeamAttentionSwitchover(userCtx(), app.id);
    expect(preview.workers[0].channels[0]).toMatchObject({ fromSeq: 5, throughSeq: 0, unread: 0 });

    await expect(confirmTeamAttentionSwitchover(userCtx(), app.id, preview.proof)).resolves.toMatchObject({
      applied: true,
      workersAdvanced: 1,
      channelsAdvanced: 1,
    });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 5 });
  });
});

describe('MCP parity and discovery gate', () => {
  const auth = (): AuthContext => ({ userId: user.id, appId: app.id, roles: ['READER'], clientId: `user:${user.id}` });

  it('a monitor read never advances the Worker cursor, even with the session bound to the transport (#1362 review)', async () => {
    await post('first');
    await post('second');
    // The transport carries the Worker's own session: exactly the shape an
    // ordinary read auto-advances under the pilot. The monitor's contract is
    // that only an explicit acknowledge moves the cursor.
    const bound = createTestableMcpServer({ ...auth(), sessionId });
    const monitored = await bound.callToolText('hadron_team_chat_read', { monitor: true });
    expect(monitored).toContain('second');
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();

    // Control: an ordinary read on the same transport does advance it.
    await bound.callToolText('hadron_team_chat_read', { sinceSeq: 0 });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } }))
      .toMatchObject({ lastSeenSeq: 2 });
  });

  it('advertises the capability only inside the operator+App pilot and delegates the compact query', async () => {
    const enabled = createTestableMcpServer(auth());
    expect(await enabled.callToolText('hadron_server_info', {})).toContain('team-attention');
    await post('compact, no body in the result');
    const out = await enabled.callToolText('hadron_team_attention', {});
    expect(out).toContain(`"worker": "${worker.id}"`);
    expect(out).toContain('"unread": 1');
    expect(out).not.toContain('compact, no body in the result');

    delete process.env.TEAM_ATTENTION_PILOT_USER_IDS;
    const disabled = createTestableMcpServer(auth());
    expect(await disabled.callToolText('hadron_server_info', {})).not.toContain('team-attention');
    expect(await disabled.callToolText('hadron_team_attention', {})).toContain('[feature_not_available]');
  });

  it('ordinary MCP reads own the cursor and the explicit mark-read door covers filtered reads', async () => {
    await post('@dara first', { mentions: ['dara'] });
    await post('second');
    const server = createTestableMcpServer(auth());

    await server.callToolText('hadron_team_chat_read', { session: sessionId, app: app.id, mentions: worker.id });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();

    const marked = await server.callToolText('hadron_team_chat_mark_read', {
      session: sessionId,
      app: app.id,
      channel: channel.id,
      seq: 1,
    });
    expect(marked).toContain('"lastSeenSeq": 1');

    const blank = await server.callToolText('hadron_team_chat_mark_read', {
      session: sessionId,
      app: app.id,
      channel: '   ',
      seq: 2,
    });
    expect(blank).toContain('[channel_not_found]');
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });

    const markedDefault = await server.callToolText('hadron_team_chat_mark_read', {
      session: sessionId,
      app: app.id,
      seq: 2,
    });
    expect(markedDefault).toContain(`"channelId": "${channel.id}"`);
    expect(markedDefault).toContain('"lastSeenSeq": 2');

    await server.callToolText('hadron_team_chat_read', { session: sessionId, app: app.id, sinceSeq: 1 });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 2 });
  });

  it('exposes the same pilot-gated, session-pinned mark-read door through GraphQL', async () => {
    await post('one');
    await post('two');
    const marked = await M.markOwnTeamChatRead(
      {},
      { appRef: app.urn, sessionRef: sessionId, channelRef: channel.id, seq: 1 },
      userCtx(),
    );
    expect(marked).toEqual({ workerId: worker.id, channelId: channel.id, lastSeenSeq: 1 });

    await expect(M.markOwnTeamChatRead(
      {},
      { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 3 },
      userCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'SEQ_BEYOND_WATERMARK', lastSeq: 2 } });

    delete process.env.TEAM_ATTENTION_PILOT_USER_IDS;
    await expect(M.markOwnTeamChatRead(
      {},
      { appRef: app.id, sessionRef: sessionId, channelRef: channel.id, seq: 2 },
      userCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'FEATURE_NOT_AVAILABLE' } });
  });

  it('an explicit MCP session advances only that Worker, not the different header-bound session', async () => {
    const iris = await addWorker('Iris');
    await post('one message for both');
    const server = createTestableMcpServer({ ...auth(), sessionId });

    await server.callToolText('hadron_channel_read', {
      channel: channel.id,
      session: iris.sessionId,
      sinceSeq: 0,
    });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();
    expect(await db.channelReadState.findFirst({ where: { workerId: iris.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });

    await db.channelReadState.deleteMany();
    await server.callToolText('hadron_team_chat_read', {
      app: app.id,
      session: iris.sessionId,
      sinceSeq: 0,
    });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();
    expect(await db.channelReadState.findFirst({ where: { workerId: iris.id, channelId: channel.id } })).toMatchObject({ lastSeenSeq: 1 });
  });

  it('does not advance a former Worker after its user loses App participation', async () => {
    const independentMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:independent`,
        name: 'independent', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const made = await ensureChannelWithRoot(db, {
      memoryId: independentMemory.id, loc: 'chats:independent', name: 'independent', createdBy: user.id,
    });
    const independent = made.channel;
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: independent.id, attendeeWorkerId: worker.id, role: 'WATCH' },
    });
    const enc = await getMemoryEncryptionInfo(db, independentMemory.id);
    await appendChatMessage(
      db,
      { id: made.rootId, memoryId: independentMemory.id, loc: 'chats:independent' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(), memoryId: independentMemory.id,
          loc: `chats:independent:messages:${msgNum}`, name: msgNum,
          nodeType: 'chat-message', seq, content: 'still readable',
        },
      }),
      { asChannel: true },
    );

    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: user.id } } });
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: user.id }, data: { role: 'READER' },
    });
    const read = await createTestableMcpServer(auth()).callToolText('hadron_channel_read', {
      channel: independent.id, session: sessionId, sinceSeq: 0,
    });
    expect(read).toContain('still readable');
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: independent.id } }))
      .toBeNull();
  });

  it('does not advance a Worker whose App belongs to a soft-deleted org', async () => {
    const independentMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:independent`,
        name: 'independent', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const made = await ensureChannelWithRoot(db, {
      memoryId: independentMemory.id, loc: 'chats:independent', name: 'independent', createdBy: user.id,
    });
    const independent = made.channel;
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: independent.id, attendeeWorkerId: worker.id, role: 'WATCH' },
    });
    const enc = await getMemoryEncryptionInfo(db, independentMemory.id);
    await appendChatMessage(
      db,
      { id: made.rootId, memoryId: independentMemory.id, loc: 'chats:independent' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(), memoryId: independentMemory.id,
          loc: `chats:independent:messages:${msgNum}`, name: msgNum,
          nodeType: 'chat-message', seq, content: 'still readable',
        },
      }),
      { asChannel: true },
    );

    // Soft delete stamps the org only: the App row and every membership stay.
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    await createTestableMcpServer(auth()).callToolText('hadron_channel_read', {
      channel: independent.id, session: sessionId, sinceSeq: 0,
    });
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: independent.id } }))
      .toBeNull();
    // The pilot door answers a deleted org's App exactly like an absent one.
    const error = await getTeamAttention(userCtx(), app.id).catch((e) => e);
    expect(error).toMatchObject({ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } });
  });

  it('a convenience read of a registered cross-App team Channel uses the Worker session pilot', async () => {
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: agent.id } });
    await db.appMember.create({ data: { appId: otherApp.id, userId: user.id, role: 'admin' } });
    const otherMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`,
        name: 'other-shared', class: 'app', appId: otherApp.id, sharedMemoryOfAgentId: agent.id,
      },
    });
    const made = await ensureChannelWithRoot(db, {
      memoryId: otherMemory.id, loc: 'chats:team', name: 'other team',
      createdBy: user.id, asDefaultOfAppId: otherApp.id,
    });
    await db.registerEntry.create({
      data: { id: generateId(), appId: app.id, channelId: made.channel.id, attendeeWorkerId: worker.id, role: 'WATCH' },
    });
    const enc = await getMemoryEncryptionInfo(db, otherMemory.id);
    await appendChatMessage(
      db,
      { id: made.rootId, memoryId: otherMemory.id, loc: 'chats:team' },
      enc,
      async ({ tx, seq, msgNum }) => tx.node.create({
        data: {
          id: generateId(), memoryId: otherMemory.id,
          loc: `chats:team:messages:${msgNum}`, name: msgNum,
          nodeType: 'chat-message', seq, content: 'cross-App team message',
        },
      }),
      { asChannel: true },
    );

    const page = await Q.teamChatMessages({}, { appRef: otherApp.id }, userCtx({ sessionId }));
    expect(page.total).toBe(1);
    expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: made.channel.id } }))
      .toMatchObject({ lastSeenSeq: 1 });
  });

  it('returns successful MCP transcripts when the best-effort cursor write fails', async () => {
    await post('the transcript survives');
    const server = createTestableMcpServer(auth());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queryRaw = vi.spyOn(db, '$queryRaw').mockRejectedValue(new Error('cursor store unavailable'));
    try {
      const channelRead = await server.callToolText('hadron_channel_read', {
        channel: channel.id,
        session: sessionId,
        sinceSeq: 0,
      });
      expect(channelRead).toContain('the transcript survives');
      expect(channelRead).not.toContain('cursor store unavailable');

      const teamRead = await server.callToolText('hadron_team_chat_read', {
        app: app.id,
        session: sessionId,
        sinceSeq: 0,
      });
      expect(teamRead).toContain('the transcript survives');
      expect(teamRead).not.toContain('cursor store unavailable');
      expect(await db.channelReadState.findFirst({ where: { workerId: worker.id, channelId: channel.id } })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      queryRaw.mockRestore();
      warn.mockRestore();
    }
  });
});
