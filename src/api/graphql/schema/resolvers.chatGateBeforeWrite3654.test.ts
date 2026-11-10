/**
 * #3654 — a refused chat turn persists NOTHING: the serve gate (canChatWithAgent, the served boot prompt) runs before the
 * user message is written, so a refusal leaves no message node, no message-count bump and no served-prompt record behind.
 * The every-turn scope of the gate is deliberately unchanged (cor:dmo:050:02, Proposed, not ruled).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { chatNodeByLocOrThrow, cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let org: any, user: any, agent: any, app: any, systemMemoryId: string;
const ctx = (): Context => ({ db, roles: ['READER'], userId: user.id });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };

const provenance = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});
async function approve(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({ where: { id: nodeId }, data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
}
async function compiled(content: string) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId: systemMemoryId, loc: 'boot:compiled', name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  await approve(node.id);
  await db.agent.update({ where: { id: agent.id }, data: { bootPromptNodeId: node.id, bootPromptUrn: `u:${node.id}` } });
  return node.id as string;
}
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'sc-org', urn: 'sc-org' } });
  user = await db.user.create({ data: { githubId: 92047100, githubUsername: 'sc-user', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'chat-agent', visibility: 'ORGANIZATION', description: 'LEGACY {{agent.name}}' }, { db, roles: ['ADMIN'], userId: user.id });
  systemMemoryId = agent.systemMemoryId;
  app = await db.app.create({ data: { id: generateId(), name: 'chat-app', urn: `${org.urn}:chat-app`, organizationId: org.id, appAgents: { create: { agentId: agent.id } } } });
  const nodes = [
    { loc: 'conversations', name: 'conversations', nodeType: 'system' },
    { loc: 'conversations:research', name: 'research', nodeType: 'system', data: { stageOrder: ['scope'], isSetup: false } },
    { loc: 'conversations:research:scope', name: 'scope', nodeType: 'system', data: { promptRef: 'prompts:research:scope' } },
    { loc: 'prompts', name: 'prompts', nodeType: 'system' },
    { loc: 'prompts:research', name: 'research', nodeType: 'system' },
    { loc: 'prompts:research:scope', name: 'scope', nodeType: 'system', content: 'Scope the research.' },
  ];
  for (const n of nodes) await db.node.create({ data: { id: generateId(), memoryId: systemMemoryId, loc: n.loc, name: n.name, nodeType: n.nodeType, data: ((n as any).data ?? null) as any, content: ((n as any).content ?? null) as any } });
});


// The authoritative stage under the chat lock is the chatRootEngineState row, not the root's data (#3666): set both, or the
// in-transaction gate fires on the row's stage in every test and the stage-less fixtures are not stage-less.
async function setStage(chat: { id: string; data: unknown }, conversationName: string, stageName: string) {
  await db.node.update({ where: { id: chat.id }, data: { data: { ...(chat.data as object), conversationName, stageName } } });
  const row = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: chat.id } });
  await db.chatRootEngineState.update({ where: { chatRootNodeId: chat.id }, data: { state: { ...(row.state as object), conversationName, ...(stageName ? { stageName } : {}) } } });
}
// loc-scope-ok: counts the messages of the one chat under test, by its own prefix
const messageNodes = (chatId: string) => db.node.count({ where: { loc: { startsWith: `${chatId}:messages:` } } });
const snapshot = async (chatId: string) => {
  const chat = await chatNodeByLocOrThrow(db, chatId);
  const fresh = await db.node.findUniqueOrThrow({ where: { id: chat.id } });
  return { messages: await messageNodes(chatId), data: fresh.data, served: await db.servedPrompt.count({ where: { chatId: chat.id } }) };
};

describe('#3654 a refused sendChatMessage turn persists nothing', () => {
  it('an unserveable boot prompt refuses and leaves no message, count bump or record', async () => {
    const node = await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'first' }, ctx());
    const before = await snapshot(start.chatId);
    await db.node.update({ where: { id: node }, data: { deletedAt: new Date() } });
    expect(await code(M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'refused' }, ctx()))).toBe('BOOT_PROMPT_TARGET_DELETED');
    expect(await snapshot(start.chatId)).toEqual(before);
  });

  it('a soft-deleted Agent refuses AGENT_NOT_FOUND and leaves no message behind', async () => {
    await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'first' }, ctx());
    const before = await snapshot(start.chatId);
    await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    expect(await code(M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'refused' }, ctx()))).toMatch(/^AGENT_NOT_FOUND/);
    expect(await snapshot(start.chatId)).toEqual(before);
  });

  it('a turn that gains its stage only by the fallback re-route is gated before the write too', async () => {
    const node = await compiled('v1');
    await db.node.create({ data: { id: generateId(), memoryId: systemMemoryId, loc: 'conversations:fallback', name: 'fallback', nodeType: 'system', data: { isFallback: true, stageOrder: ['hold'] } } });
    await db.node.updateMany({ where: { memoryId: systemMemoryId, loc: 'conversations:research' }, data: { data: { stageOrder: ['scope'], isSetup: false, goalSignals: ['research'] } } });
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const chat = await chatNodeByLocOrThrow(db, start.chatId);
    // A chat parked in the fallback conversation with no stage: only the re-route would give this turn one.
    await setStage(chat, 'fallback', '');
    const before = await snapshot(start.chatId);
    await db.node.update({ where: { id: node }, data: { deletedAt: new Date() } });
    expect(await code(M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'please research this topic' }, ctx()))).toBe('BOOT_PROMPT_TARGET_DELETED');
    expect(await snapshot(start.chatId)).toEqual(before);
  });

  it('a stage that appears between the early read and the chat lock is gated inside the write transaction (nothing persists)', async () => {
    const node = await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const chat = await chatNodeByLocOrThrow(db, start.chatId);
    // Parked with no stage: the early gate does not apply to this turn.
    await setStage(chat, 'research', '');
    const before = await snapshot(start.chatId);
    await db.node.update({ where: { id: node }, data: { deletedAt: new Date() } });
    // A concurrent turn gives the chat its stage after this turn read the root, before it takes the chat lock.
    const original = db.memory.findUniqueOrThrow.bind(db.memory);
    const spy = vi.spyOn(db.memory, 'findUniqueOrThrow').mockImplementationOnce(((args: any) => {
      return setStage(chat, 'research', 'scope').then(() => original(args));
    }) as any);
    try {
      expect(await code(M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'racing turn' }, ctx()))).toBe('BOOT_PROMPT_TARGET_DELETED');
    } finally { spy.mockRestore(); }
    const after = await snapshot(start.chatId);
    expect(after.messages).toBe(before.messages);
    expect(after.served).toBe(before.served);
  });

  it('the happy path still writes the turn', async () => {
    await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const before = await snapshot(start.chatId);
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'ok' }, ctx());
    const after = await snapshot(start.chatId);
    expect(after.messages).toBeGreaterThan(before.messages);
  });
});
