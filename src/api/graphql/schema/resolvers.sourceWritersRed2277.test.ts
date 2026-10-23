/**
 * #2277 remaining rows, red-first (analysis tasks 01a166f962a2731a8a73ba6ab62bdb3b Channel-root, 01a166f96535723293fe86497d6f72f9
 * revisions:* creation). Same method as resolvers.commentSourceFence2277.test.ts: hold the #2063 include-history fence F, start the REAL
 * resolver against a boot-prompt SOURCE memory (class 'system'), and require it to queue on the advisory lock. Both are RED today
 * (the writer commits while F is held): they are the witnesses for the proposed attach in docs/engineering/source-writers-2277-remaining.md.
 * The old-Agent entitlement-deletion row is deliberately not here: it waits on Vera's fit (fence vs deciding-read revalidation).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { includeHistoryClient, withIncludeHistoryTransaction } from '../../../lib/includes/includeHistoryFence.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let admin: { id: string };
let orgId: string;
const as = (): Context => ({ db, userId: admin.id, roles: [] });

async function queuedOnFence(op: () => Promise<unknown>, probeWhileHeld?: () => Promise<void>): Promise<boolean> {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const done = withIncludeHistoryTransaction(db, async (f) => { includeHistoryClient(f); entered(); await held; });
  await inside;
  const running = op();
  running.catch(() => {});
  let queued = true;
  try { await waitForLockWaitersOfType(db, 'advisory', 1, 1_500); } catch { queued = false; }
  await probeWhileHeld?.();
  release();
  await done;
  await running;
  return queued;
}

async function sourceFixture(cls: 'system' | 'knowledge') {
  const memory = await db.memory.create({ data: { id: generateId(), class: cls, name: `m-${cls}`, urn: `sw2277.example:${cls}-${generateId().slice(-6)}`, organizationId: orgId, visibility: cls === 'knowledge' ? 'ORGANIZATION' : undefined } });
  const agent = cls === 'system'
    ? await db.agent.create({ data: { id: generateId(), name: 'Src', urn: `sw2277.example:agent-${generateId().slice(-6)}`, organizationId: orgId, visibility: 'ORGANIZATION', systemMemoryId: memory.id } })
    : null;
  return { memory, agent };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'SW Org', urn: 'sw2277.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 227703, githubUsername: 'sw-admin', handle: 'sw-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});

describe('#2277 Channel-root writer in a SOURCE memory (task 01a166f9...)', () => {
  it('createChannel in a system memory queues behind a held F', async () => {
    const { memory } = await sourceFixture('system');
    expect(await queuedOnFence(() => M.createChannel(null, { input: { memoryRef: memory.id, loc: 'chats:src', name: 'Src chat' } }, as()))).toBe(true);
  });

  it('scope control: createChannel in a knowledge memory does not queue', async () => {
    const { memory } = await sourceFixture('knowledge');
    expect(await queuedOnFence(() => M.createChannel(null, { input: { memoryRef: memory.id, loc: 'chats:k', name: 'K chat' } }, as()))).toBe(false);
  });

  it('deleteChannel (tombstones the root) in a system memory queues behind a held F', async () => {
    const { memory } = await sourceFixture('system');
    const ch = await M.createChannel(null, { input: { memoryRef: memory.id, loc: 'chats:del', name: 'Del chat' } }, as());
    expect(await queuedOnFence(() => M.deleteChannel(null, { ref: ch.id }, as()))).toBe(true);
  });
});

describe('#2277 Channel message producers in a SOURCE memory (Xylon #31534, Vera #31542: any Node write in a source memory)', () => {
  it('createChannelMessage (appendChatMessage: message Node + root data) queues behind a held F', async () => {
    const { memory } = await sourceFixture('system');
    const ch = await M.createChannel(null, { input: { memoryRef: memory.id, loc: 'chats:msg', name: 'Msg chat' } }, as());
    expect(await queuedOnFence(() => M.createChannelMessage(null, { channelRef: ch.id, body: 'hello' }, as()))).toBe(true);
  });

  it('scope control: createChannelMessage in a knowledge memory does not queue', async () => {
    const { memory } = await sourceFixture('knowledge');
    const ch = await M.createChannel(null, { input: { memoryRef: memory.id, loc: 'chats:kmsg', name: 'K msg chat' } }, as());
    expect(await queuedOnFence(() => M.createChannelMessage(null, { channelRef: ch.id, body: 'hello' }, as()))).toBe(false);
  });
});

describe('#2277 delta A pin: chat-session producers (chatWriteTx inTx runner) vs a Channel root in a SOURCE memory (Xylon #31627)', () => {
  it('CHARACTERIZATION (green): updateChatTitle cannot reach a Channel root created in a system memory; the chat lookup answers not found', async () => {
    // sendChatMessage/processChatResponse also refuse a system-class host earlier (validateChatScopeInvariants: scope private needs
    // personal/knowledge, shared needs app). saveChatSummary/updateChatTitle/deleteChat do NOT validate scope, only entitlement;
    // a Channel root is not entitled to the creator through chatLocFilter. Whether ANY chat root can live in a system memory is
    // unproven, so the attach fences the shared runner under the same class contract regardless (cost-free outside system).
    const { memory } = await sourceFixture('system');
    await M.createChannel(null, { input: { memoryRef: memory.id, loc: 'chats:ttl', name: 'Ttl chat' } }, as());
    await expect(M.updateChatTitle(null, { chatId: 'chats:ttl', title: 'renamed' }, as())).rejects.toThrow(/not found/);
  });
});

describe('#2277 delta C: old-Agent entitlement deletion on tombstone reclaim (createAgentCore)', () => {
  it('createAgent reclaiming a tombstoned Agent that holds an AgentOrgGrant queues behind a held F', async () => {
    const other = await db.organization.create({ data: { id: generateId(), name: 'Other', urn: 'other2277.example' } });
    const ghost = await db.agent.create({ data: { id: generateId(), name: 'ghost', urn: 'sw2277.example:ghost', organizationId: orgId, visibility: 'PUBLIC', deletedAt: new Date() } });
    await db.agentOrgGrant.create({ data: { orgId: other.id, agentId: ghost.id, activatedAt: new Date(), createdBy: admin.id } });
    // The #2273 base already fences the CREATE half (so the writer does queue), but the reclaim delete runs BEFORE it
    // on the pooled client: while F is held the old Agent's grant must still exist. RED if it was already deleted.
    let grantsWhileHeld = -1;
    const queued = await queuedOnFence(
      () => M.createAgent(null, { orgId, name: 'ghost' }, as()),
      async () => { grantsWhileHeld = await db.agentOrgGrant.count({ where: { agentId: ghost.id } }); },
    );
    expect(queued).toBe(true);
    expect(grantsWhileHeld).toBe(1);
    expect(await db.agentOrgGrant.count({ where: { agentId: ghost.id } })).toBe(0);
  });
});

describe('#2277 revisions:* creation writer (task 01a166f96535723293fe86497d6f72f9)', () => {
  it('createRevision (inserts revisions:rev-N in the Agent system memory) queues behind a held F', async () => {
    const { agent } = await sourceFixture('system');
    expect(await queuedOnFence(() => M.createRevision(null, { agentId: agent!.id }, as()))).toBe(true);
  });
});
