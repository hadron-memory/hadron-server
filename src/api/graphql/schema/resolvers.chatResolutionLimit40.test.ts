/**
 * hadron-internal#40 (rulings 0196/0197) — a chat prompt over a resolution limit refuses with the one typed error.
 * startChat compiles before the chat exists, so a refusal leaves no chat behind; sendChatMessage refuses rather than
 * handing the client a partial or raw prompt. Neither makes a server-side model call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { CONTENT_RESOLUTION_LIMIT_EXCEEDED, setResolutionLimits } from '../../../lib/includes/resolutionBudget.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let alice: { id: string };
let agent: { id: string };
let systemMemoryId: string;
const ctxFor = (userId: string): Context => ({ db, roles: ['READER'], userId });
// loc-scope-ok: deliberately every memory; a refused startChat must leave no chat root anywhere.
const chatRoots = () => db.node.count({ where: { loc: { startsWith: 'chats:' }, NOT: { loc: { contains: ':messages' } } } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-cl40', urn: 'org-cl40' } });
  alice = await db.user.create({ data: { githubId: 40401, githubUsername: 'alice-cl40', roles: ['READER'] } });
  const admin = await db.user.create({ data: { githubId: 40400, githubUsername: 'admin-cl40', roles: ['ADMIN'] } });
  for (const u of [admin, alice]) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: u === admin ? 'ADMIN' : 'CONTRIBUTOR' } });
  }
  agent = await resolvers.Mutation.createAgent(
    {}, { orgId: org.id, name: 'cl40-agent', visibility: 'ORGANIZATION' }, { db, roles: ['ADMIN'], userId: admin.id },
  );
  systemMemoryId = (agent as unknown as { systemMemoryId: string }).systemMemoryId;
  const app = await db.app.create({
    data: {
      id: generateId(), name: 'cl40-app', urn: `${org.urn}:cl40-app`,
      organizationId: org.id, appAgents: { create: { agentId: agent.id } },
    },
  });
  await db.appMember.create({ data: { appId: app.id, userId: alice.id, role: 'member' } });
  const nodes: Array<{ loc: string; data?: unknown; content?: string }> = [
    { loc: 'conversations' },
    { loc: 'conversations:intake', data: { stageOrder: ['scope'], isSetup: false } },
    { loc: 'conversations:intake:scope', data: { promptRef: 'prompts:intake:scope' } },
    { loc: 'prompts' },
    { loc: 'prompts:intake' },
    // Template text is charged before it is parsed, so the prompt's own text reaches a lowered limit.
    { loc: 'prompts:intake:scope', content: `ask {{name}} ${'x'.repeat(20)}` },
  ];
  for (const n of nodes) {
    await db.node.upsert({
      where: { loc_memoryId: { loc: n.loc, memoryId: systemMemoryId } },
      update: { data: (n.data ?? undefined) as never, content: n.content ?? undefined },
      create: {
        id: generateId(), memoryId: systemMemoryId, loc: n.loc, name: n.loc.split(':').pop()!, nodeType: 'system',
        data: (n.data ?? null) as never, content: n.content ?? null,
      },
    });
  }
  await serveEveryAgent(db);
});
afterEach(() => setResolutionLimits(null));

const start = () => resolvers.Mutation.startChat({}, { agentId: agent.id, scope: 'shared' }, ctxFor(alice.id));

describe('#40 chat prompts', () => {
  it('control: under the limit the prompt compiles', async () => {
    const chat = await start();
    expect(chat.systemMessage).toContain('ask  ' + 'x'.repeat(20));
  });

  it('startChat over the limit refuses with the typed error and leaves no chat', async () => {
    setResolutionLimits({ limits: { maxBytes: 12 } });
    await expect(start()).rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' } });
    expect(await chatRoots()).toBe(0);
  });

  it('sendChatMessage over the limit refuses rather than returning a partial or raw prompt', async () => {
    const chat = await start();
    setResolutionLimits({ limits: { maxBytes: 12 } });
    await expect(resolvers.Mutation.sendChatMessage({}, { chatId: chat.chatId, userMessage: 'hi' }, ctxFor(alice.id)))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'bytes' } });
  });

  // #40: a compiled chat prompt is a served resolved read, so it counts toward the request's
  // aggregate like every other. The prompt compiles to "ask  " plus 20 bytes; one byte of
  // aggregate is far below it.
  it('startChat past the request aggregate refuses as requestBytes and leaves no chat', async () => {
    setResolutionLimits({ requestMaxBytes: 1 });
    await expect(start()).rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'requestBytes' } });
    expect(await chatRoots()).toBe(0);
  });

  it('sendChatMessage past the request aggregate refuses as requestBytes', async () => {
    const chat = await start();
    setResolutionLimits({ requestMaxBytes: 1 });
    await expect(resolvers.Mutation.sendChatMessage({}, { chatId: chat.chatId, userMessage: 'hi' }, ctxFor(alice.id)))
      .rejects.toMatchObject({ extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit: 'requestBytes' } });
  });

  it('control: an aggregate the prompt fits under serves it', async () => {
    setResolutionLimits({ requestMaxBytes: 1024 });
    expect((await start()).systemMessage).toContain('ask  ' + 'x'.repeat(20));
  });
});
