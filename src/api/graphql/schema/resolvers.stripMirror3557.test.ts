/**
 * #3557 R1 — the pre-lock routing names come from the state row (decrypted for an encrypted memory); the root's data is a
 * fallback only for a root with no row. Setup copied from the #3654 gate suite.
 * (#3654 — a refused chat turn persists NOTHING: the serve gate (canChatWithAgent, the served boot prompt) runs before the
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
import { decryptNodeFields, encryptNodeFields } from '../../../lib/nodeCrypto.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
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


// loc-scope-ok: counts the messages of the one chat under test, by its own prefix
const messageNodes = (chatId: string) => db.node.count({ where: { loc: { startsWith: `${chatId}:messages:` } } });
const snapshot = async (chatId: string) => {
  const chat = await chatNodeByLocOrThrow(db, chatId);
  const fresh = await db.node.findUniqueOrThrow({ where: { id: chat.id } });
  return { messages: await messageNodes(chatId), data: fresh.data, served: await db.servedPrompt.count({ where: { chatId: chat.id } }) };
};

const stateOf = async (chatId: string) => (await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: (await chatNodeByLocOrThrow(db, chatId)).id } })).state as Record<string, unknown>;
async function parkInFallback(chatId: string, data: Record<string, unknown>) {
  await db.node.create({ data: { id: generateId(), memoryId: systemMemoryId, loc: 'conversations:fallback', name: 'fallback', nodeType: 'system', data: { isFallback: true, stageOrder: ['hold'] } } });
  await db.node.updateMany({ where: { memoryId: systemMemoryId, loc: 'conversations:research' }, data: { data: { stageOrder: ['scope'], isSetup: false, goalSignals: ['research'] } } });
  const chat = await chatNodeByLocOrThrow(db, chatId);
  await db.node.update({ where: { id: chat.id }, data: { data: { ...(chat.data as object), ...data } } });
  await db.chatRootEngineState.update({ where: { chatRootNodeId: chat.id }, data: { state: { conversationName: 'fallback', stageName: 'hold' } } });
  return chat;
}
describe('#3557 R1 reads the state row, not the stripped root', () => {
  it('a new chat carries no names in its root data, only in the row', async () => {
    await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const chat = await chatNodeByLocOrThrow(db, start.chatId);
    expect(chat.data).not.toHaveProperty('conversationName');
    expect(chat.data).not.toHaveProperty('stageName');
    expect(await stateOf(start.chatId)).toMatchObject({ conversationName: 'research', stageName: 'scope' });
  });
  it('plaintext stripped root: the fallback re-route still happens (row says fallback)', async () => {
    await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    await parkInFallback(start.chatId, {});
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'please research this topic' }, ctx());
    expect(await stateOf(start.chatId)).toMatchObject({ conversationName: 'research', stageName: 'scope' });
    expect((await chatNodeByLocOrThrow(db, start.chatId)).data).not.toHaveProperty('stageName');
  });
  it('D1 row/data disagreement: the row (not fallback) wins over a stale root copy, so there is no re-route', async () => {
    await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const chat = await parkInFallback(start.chatId, { conversationName: 'fallback', stageName: 'hold' });
    await db.node.create({ data: { id: generateId(), memoryId: systemMemoryId, loc: 'conversations:alt', name: 'alt', nodeType: 'system', data: { stageOrder: ['a'] } } });
    await db.chatRootEngineState.update({ where: { chatRootNodeId: chat.id }, data: { state: { conversationName: 'alt', stageName: 'a' } } });
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'please research this topic' }, ctx());
    expect(await stateOf(start.chatId)).toMatchObject({ conversationName: 'alt', stageName: 'a' });
    expect((await chatNodeByLocOrThrow(db, start.chatId)).data).not.toHaveProperty('conversationName');
  });
  it('a root with NO row falls back to its own data', async () => {
    await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const chat = await parkInFallback(start.chatId, { conversationName: 'fallback', stageName: 'hold' });
    await db.chatRootEngineState.delete({ where: { chatRootNodeId: chat.id } });
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'please research this topic' }, ctx());
    expect(await stateOf(start.chatId)).toMatchObject({ conversationName: 'research', stageName: 'scope' });
  });
  it('early refusal before the user message: row stage, stripped root', async () => {
    const node = await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const before = await snapshot(start.chatId);
    await db.node.update({ where: { id: node }, data: { deletedAt: new Date() } });
    expect(await code(M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'refused' }, ctx()))).toBe('BOOT_PROMPT_TARGET_DELETED');
    expect(await snapshot(start.chatId)).toEqual(before);
  });
  it('encrypted stripped root: the row is decrypted with the session key and routes the fallback re-route', async () => {
    await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const chat = await parkInFallback(start.chatId, {});
    const info = { id: chat.memoryId, isEncrypted: true }, key = generateDataKey();
    sessionKeyCache.set(generateId(), chat.memoryId, key);
    await db.memory.update({ where: { id: chat.memoryId }, data: { isEncrypted: true } });
    const fresh = await db.node.findUniqueOrThrow({ where: { id: chat.id } });
    await db.node.update({ where: { id: chat.id }, data: { data: encryptNodeFields({ data: fresh.data }, info).data! } });
    await db.chatRootEngineState.update({ where: { chatRootNodeId: chat.id }, data: { state: encryptNodeFields({ data: { conversationName: 'fallback', stageName: 'hold' } }, info).data as never } });
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'please research this topic' }, ctx());
    const row = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: chat.id } });
    expect(JSON.stringify(row.state)).not.toContain('research');
    expect(decryptNodeFields({ data: row.state }, info).data).toMatchObject({ conversationName: 'research', stageName: 'scope' });
    expect(JSON.stringify((await db.node.findUniqueOrThrow({ where: { id: chat.id } })).data)).not.toContain('scope');
  });
});
