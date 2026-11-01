/**
 * #3097: `startChat` on an Agent with no conversations, a named conversation
 * that does not exist, or a conversation with no stages used to throw a plain
 * `Error`, which GraphQL masks as INTERNAL_SERVER_ERROR. These are expected,
 * caller-visible refusal states, so each is now a typed `ChatScopeError`
 * (extensions.code on the wire), and a refused call creates nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { ChatScopeError } from './chat-scope.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let admin: { id: string };
let agent: { id: string };
let systemMemoryId: string;

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

async function seedNode(loc: string, data: object | null = null, content: string | null = null) {
  await db.node.create({ data: {
    id: generateId(), memoryId: systemMemoryId, loc, name: loc.split(':').pop()!, nodeType: 'system',
    data: data as never, content,
  } });
}

async function expectRefusal(args: Record<string, unknown>, code: string, message: RegExp) {
  const nodesBefore = await db.node.count();
  const err = await M.startChat(null, { agentId: agent.id, ...args }, ctx()).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ChatScopeError);
  expect((err as ChatScopeError).extensions.code).toBe(code);
  expect((err as ChatScopeError).message).toMatch(message);
  expect(await db.node.count()).toBe(nodesBefore); // a chat is a node: none was created
  expect(await db.agentSubscription.count({ where: { agentId: agent.id } })).toBe(0);
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-3097', urn: 'org-3097' } });
  admin = await db.user.create({ data: { githubId: 309700, githubUsername: 'u3097', roles: ['ADMIN'] as never } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'chat-agent', visibility: 'ORGANIZATION' }, ctx());
  agent = { id: created.id };
  systemMemoryId = created.systemMemoryId!;
  await serveEveryAgent(db);
});

describe('#3097: startChat refuses the empty conversation states with a typed code', () => {
  it('an Agent with no conversations is AGENT_HAS_NO_CONVERSATIONS', async () => {
    await expectRefusal({}, 'AGENT_HAS_NO_CONVERSATIONS', /no conversations/i);
  });

  it('a named conversation that does not exist is CONVERSATION_NOT_FOUND', async () => {
    await seedNode('conversations');
    await seedNode('conversations:qa', { stageOrder: ['s1'] });
    await expectRefusal({ conversationName: 'missing' }, 'CONVERSATION_NOT_FOUND', /"missing" not found/);
  });

  it('a conversation with no stages is CONVERSATION_HAS_NO_STAGES', async () => {
    await seedNode('conversations');
    await seedNode('conversations:qa', { stageOrder: [] });
    await expectRefusal({}, 'CONVERSATION_HAS_NO_STAGES', /"qa" has no stages/);
  });

  it('a conversation with no stageOrder at all is also CONVERSATION_HAS_NO_STAGES', async () => {
    await seedNode('conversations');
    await seedNode('conversations:qa', null);
    await expectRefusal({ conversationName: 'qa' }, 'CONVERSATION_HAS_NO_STAGES', /"qa" has no stages/);
  });

  it('CONTROL: a conversation with a stage still starts the chat', async () => {
    await seedNode('conversations');
    await seedNode('conversations:qa', { stageOrder: ['s1'] });
    await seedNode('conversations:qa:s1', {});
    const out = await M.startChat(null, { agentId: agent.id }, ctx());
    expect(out.chatId ?? out.id).toBeTruthy();
  });
});
