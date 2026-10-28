/**
 * #2047 (S10, cor:agt:040:03/:10) — the CHAT surface: an unserveable boot prompt refuses startChat and sendChatMessage with
 * the bind's typed refusal and leaves no chat; an approved one is served with its variables bound to the Agent, never the
 * retired `Agent.systemPrompt`; the chat records at start and again only when its served revision changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let org: any, user: any, agent: any, app: any, systemMemoryId: string;
const before = process.env.BOOT_PROMPT_SERVE_ENABLED;
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
async function recompileApproved(nodeId: string, content: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({ data: { nodeId, memoryId: systemMemoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
  await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  await approve(nodeId);
}

beforeEach(async () => {
  process.env.BOOT_PROMPT_SERVE_ENABLED = 'true';
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'sc-org', urn: 'sc-org' } });
  user = await db.user.create({ data: { githubId: 92047100, githubUsername: 'sc-user', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'chat-agent', visibility: 'ORGANIZATION', systemPrompt: 'LEGACY {{agent.name}}' }, { db, roles: ['ADMIN'], userId: user.id });
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
afterEach(() => {
  if (before === undefined) delete process.env.BOOT_PROMPT_SERVE_ENABLED;
  else process.env.BOOT_PROMPT_SERVE_ENABLED = before;
});

const chatNodes = () => db.node.count({ where: { loc: { startsWith: 'chats:' } } });

describe('#2047 chat', () => {
  it('serving OFF: the legacy Agent prompt is bound and nothing is recorded', async () => {
    delete process.env.BOOT_PROMPT_SERVE_ENABLED;
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    expect(start.systemMessage).toContain('LEGACY chat-agent');
    expect(await db.servedPrompt.count()).toBe(0);
  });

  it('no pointer: startChat is refused with the typed refusal and creates no chat', async () => {
    const chats = await chatNodes();
    expect(await code(M.startChat({}, { agentId: agent.id }, ctx()))).toBe('BOOT_PROMPT_NOT_SET');
    expect(await chatNodes()).toBe(chats);
  });

  it('serves the approved compiled text with the Agent-bound variables, records once, and never reads the retired prompt', async () => {
    await compiled('You are {{agent.name}}.');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    expect(start.systemMessage).toContain('You are chat-agent.');
    expect(start.systemMessage).not.toContain('LEGACY');
    const chatNode = await db.node.findFirstOrThrow({ where: { loc: start.chatId } });
    const recs = await db.servedPrompt.findMany({ where: { chatId: chatNode.id } });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: 'CHAT', ordinal: 1, appId: app.id, agentId: agent.id, pointerLevel: 'AGENT', servedRevSeq: 1 });
    expect(recs[0]!.variables).toMatchObject({ 'agent.name': 'chat-agent', 'worker.name': 'chat-agent' });
    // Never per message.
    for (const m of ['one', 'two']) {
      const turn = await M.sendChatMessage({}, { chatId: start.chatId, userMessage: m }, ctx());
      expect(turn.systemMessage).toContain('You are chat-agent.');
    }
    expect(await db.servedPrompt.count({ where: { chatId: chatNode.id } })).toBe(1);
  });

  it('records again when the served revision changes, and only then', async () => {
    const node = await compiled('v1 {{agent.name}}');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    await recompileApproved(node, 'v2 {{agent.name}}');
    const turn = await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'hi' }, ctx());
    expect(turn.systemMessage).toContain('v2 chat-agent');
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'again' }, ctx());
    const chatNode = await db.node.findFirstOrThrow({ where: { loc: start.chatId } });
    const recs = await db.servedPrompt.findMany({ where: { chatId: chatNode.id }, orderBy: { ordinal: 'asc' } });
    expect(recs.map((r) => [r.ordinal, r.servedRevSeq])).toEqual([[1, 1], [2, 2]]);
  });

  it('an unserveable prompt on a later turn refuses sendChatMessage with the same code', async () => {
    const node = await compiled('v1');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    await db.node.update({ where: { id: node }, data: { deletedAt: new Date() } });
    expect(await code(M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'hi' }, ctx()))).toBe('BOOT_PROMPT_TARGET_DELETED');
  });
});
