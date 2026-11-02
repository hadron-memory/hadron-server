/** #3096 / cor:dmo:150:08: caller-reported chat model is prompt/record text only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { chatNodeByLocOrThrow, cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';
import { recordChatServedIfChanged, serveChatPrompt } from './resolvers.mutation.chat.js';

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
async function recompileApproved(nodeId: string, content: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({ data: { nodeId, memoryId: systemMemoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
  await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  await approve(nodeId);
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


import { buildSchema } from 'graphql';
import { typeDefs } from './typeDefs.js';
const records = async (chatId: string) => {
  const chat = await chatNodeByLocOrThrow(db, chatId);
  return db.servedPrompt.findMany({ where: { chatId: chat.id }, orderBy: { ordinal: 'asc' } });
};
const report = (r: { variables: unknown }) => r.variables as Record<string, string>;

describe('#3096 client-reported chat model', () => {
  it('adds optional llmModel on both GraphQL mutations and identifies its trust boundary', () => {
    const schema = buildSchema(typeDefs);
    for (const name of ['startChat', 'sendChatMessage']) {
      const arg = schema.getMutationType()!.getFields()[name]!.args.find(a => a.name === 'llmModel');
      expect(arg).toBeDefined();
      expect(String(arg!.type)).toBe('String');
      expect(arg!.description).toContain('client-reported');
      for (const word of ['billing', 'quotas', 'authorization']) expect(arg!.description).toContain(word);
    }
  });

  it('start serves and records X, a later send serves/records Y on the SAME revision, omission is empty, repeated empty is deduplicated', async () => {
    await compiled('Model={{session.llmModel}} Agent={{agent.name}}');
    const start = await M.startChat({}, { agentId: agent.id, llmModel: 'provider/model-X' }, ctx());
    expect(start.systemMessage).toContain('Model=provider/model-X Agent=chat-agent');
    const first = await records(start.chatId);
    expect(report(first[0]!)).toMatchObject({ 'session.llmModel': 'provider/model-X', 'session.llmModel.source': 'client-reported' });
    const turn = await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'hello', llmModel: 'provider/model-Y' }, ctx());
    expect(turn.systemMessage).toContain('Model=provider/model-Y Agent=chat-agent');
    const second = await records(start.chatId);
    expect(second.map(r => [r.ordinal, r.servedRevSeq, report(r)['session.llmModel']])).toEqual([[1, 1, 'provider/model-X'], [2, 1, 'provider/model-Y']]);
    const empty = await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'no report' }, ctx());
    expect(empty.systemMessage).toContain('Model= Agent=chat-agent');
    await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'still absent' }, ctx());
    const all = await records(start.chatId);
    expect(all).toHaveLength(3);
    expect(report(all[2]!)).toMatchObject({ 'session.llmModel': '', 'session.llmModel.source': 'unspecified' });
  });

  it('old omitted and null arguments keep an empty model, with no invented identity', async () => {
    await compiled('Model={{session.llmModel}}.');
    for (const llmModel of [undefined, null]) {
      const start = await M.startChat({}, { agentId: agent.id, llmModel }, ctx());
      expect(start.systemMessage).toContain('Model=.');
      expect(report((await records(start.chatId))[0]!)).toMatchObject({ 'session.llmModel': '', 'session.llmModel.source': 'unspecified' });
    }
  });

  it('keeps template-looking text and dollar replacements literal in served text and records', async () => {
    await compiled('Model={{session.llmModel}} Agent={{agent.name}}');
    const llmModel = '{{agent.name}}$&<not-a-command>';
    const start = await M.startChat({}, { agentId: agent.id, llmModel }, ctx());
    expect(start.systemMessage).toContain(`Model=${llmModel} Agent=chat-agent`);
    expect(report((await records(start.chatId))[0]!)['session.llmModel']).toBe(llmModel);
  });

  it('accepts exactly 256 characters and labels empty explicit reports as client-reported', async () => {
    await compiled('Model={{session.llmModel}}.');
    for (const llmModel of ['x'.repeat(256), '\u{1F600}'.repeat(128), '']) {
      const start = await M.startChat({}, { agentId: agent.id, llmModel }, ctx());
      expect(start.systemMessage).toContain(`Model=${llmModel}.`);
      expect(report((await records(start.chatId))[0]!)['session.llmModel.source']).toBe('client-reported');
    }
  });

  it.each(['x'.repeat(257), 'bad\nmodel', 'bad\0model', 'bad\u007fmodel', 'bad\u0085model', 'bad\u202emodel', 'bad\u2028model', 'bad\ud800model', 'bad\udfffmodel'])(
    'refuses a malformed report before start/send writes and never echoes the input (%#)', async llmModel => {
      await compiled('Model={{session.llmModel}}.');
      const before = await db.node.count();
      let error: any;
      try { await M.startChat({}, { agentId: agent.id, llmModel }, ctx()); } catch (e) { error = e; }
      expect(error?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(error?.message).toBe('Invalid client-reported chat model.');
      expect(JSON.stringify(error)).not.toContain(llmModel);
      expect(await db.node.count()).toBe(before);
      const start = await M.startChat({}, { agentId: agent.id }, ctx());
      const count = await db.node.count();
      expect(await code(M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'must not persist', llmModel }, ctx()))).toBe('BAD_USER_INPUT');
      expect(await db.node.count()).toBe(count);
      expect(await records(start.chatId)).toHaveLength(1);
    },
  );

  it.each([123, true, {}, []])('refuses non-string reports even for a direct resolver caller (%#)', async llmModel => {
    await compiled('Model={{session.llmModel}}.');
    const before = await db.node.count();
    expect(await code(M.startChat({}, { agentId: agent.id, llmModel }, ctx()))).toBe('BAD_USER_INPUT');
    expect(await db.node.count()).toBe(before);
  });

  it('a fabricated model grants no authority, and an accepted report touches no quota or credit ledger', async () => {
    await compiled('Model={{session.llmModel}}.');
    const beforeQuota = await db.quotaCounter.findMany();
    const beforeCredit = await db.creditLedgerEntry.findMany();
    const start = await M.startChat({}, { agentId: agent.id, llmModel: 'ADMIN/unmetered' }, ctx());
    const turn = await M.sendChatMessage({}, { chatId: start.chatId, userMessage: 'hello', llmModel: 'OWNER/free' }, ctx());
    expect(turn.systemMessage).toContain('OWNER/free');
    expect(await db.quotaCounter.findMany()).toEqual(beforeQuota);
    expect(await db.creditLedgerEntry.findMany()).toEqual(beforeCredit);
    const outsider = await db.user.create({ data: { githubId: 93096001, githubUsername: 'model-outsider', roles: ['READER'] } });
    const outsiderCtx: Context = { db, userId: outsider.id, roles: ['READER'] };
    const denied = await code(M.startChat({}, { agentId: agent.id, llmModel: 'ADMIN' }, outsiderCtx));
    expect(denied).toBe(await code(M.startChat({}, { agentId: agent.id }, outsiderCtx)));
    expect(denied).not.toBe('RESOLVED');
  });

  it('different reported values on overlapping turns both reach the immutable audit history', async () => {
    await compiled('Model={{session.llmModel}}.');
    const start = await M.startChat({}, { agentId: agent.id }, ctx());
    const chat = await chatNodeByLocOrThrow(db, start.chatId);
    const base = await serveChatPrompt(db, agent, app.id);
    const one = { ...base, variables: { ...base.variables, 'session.llmModel': 'X', 'session.llmModel.source': 'client-reported' } };
    const two = { ...base, variables: { ...base.variables, 'session.llmModel': 'Y', 'session.llmModel.source': 'client-reported' } };
    await Promise.all([recordChatServedIfChanged(db, chat.id, agent.id, app.id, one), recordChatServedIfChanged(db, chat.id, agent.id, app.id, two)]);
    const all = await records(start.chatId);
    expect(all.map(r => report(r)['session.llmModel']).sort()).toEqual(['', 'X', 'Y']);
    expect(new Set(all.map(r => r.ordinal)).size).toBe(3);
  });
});
