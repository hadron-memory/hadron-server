/**
 * #1581: startChat reads an Agent's definition (it returns the system prompt)
 * and auto-provisions an AgentSubscription. Before this fix it did the
 * provisioning first, for a caller-supplied `userId`, with no Agent gate at
 * all: a stranger minted licenses to another org's private Agent for
 * themselves AND for any user they named, even when the chat then failed.
 *
 * Now (canChatWithAgent):
 * - the caller must reach the Agent: PUBLIC, own, an org READER, or an
 *   AppMember of an App with a live, licensed install (a pure App key: the
 *   Agent installed and licensed in its App); a refusal reads as "not found";
 * - only a pure App key may act on behalf of another user;
 * - the license is provisioned in the transaction that creates the chat, so
 *   a chat that fails leaves none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { canChatWithAgent } from './agentChatAccess.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let orgA: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let stranger: { id: string };
let victim: { id: string };
let endUser: { id: string };
let agent: { id: string; organizationId: string | null; ownerUserId: string | null; visibility: string | null; deletedAt: Date | null };
let app: { id: string };
let otherApp: { id: string };

const userCtx = (userId: string, extra: Partial<Context> = {}): Context =>
  ({ db, roles: ['READER'], userId, ...extra }) as Context;

const subsFor = (agentId: string) =>
  db.agentSubscription.findMany({ where: { agentId }, select: { userId: true } }).then((rows) => rows.map((r) => r.userId).sort());

async function seedConversations(systemMemoryId: string) {
  const nodes = [
    { loc: 'conversations', name: 'conversations' },
    { loc: 'conversations:research', name: 'research', data: { stageOrder: ['scope'], isSetup: false } },
    { loc: 'conversations:research:scope', name: 'scope', data: { promptRef: 'prompts:research:scope' } },
    { loc: 'prompts', name: 'prompts' },
    { loc: 'prompts:research', name: 'research' },
    { loc: 'prompts:research:scope', name: 'scope', content: 'Scope the research.' },
  ];
  for (const n of nodes) {
    await db.node.create({ data: {
      id: generateId(), memoryId: systemMemoryId, loc: n.loc, name: n.name, nodeType: 'system',
      data: ((n as { data?: object }).data ?? null) as never, content: (n as { content?: string }).content ?? null,
    } });
  }
}

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'org-a', urn: 'org-a-1581' } });
  const mk = (n: number, roles: string[] = ['READER']) =>
    db.user.create({ data: { githubId: 158100 + n, githubUsername: `u1581-${n}`, roles: roles as never } });
  admin = await mk(1, ['ADMIN']);
  member = await mk(2);
  stranger = await mk(3);
  victim = await mk(4);
  endUser = await mk(5);
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: member.id, role: 'READER' } });

  const created = await M.createAgent({}, { orgId: orgA.id, name: 'secret-agent', visibility: 'ORGANIZATION' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context);
  await db.agent.update({ where: { id: created.id }, data: { systemPrompt: 'VENDOR-SECRET-PROMPT' } });
  agent = await db.agent.findUniqueOrThrow({
    where: { id: created.id },
    select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
  });
  await seedConversations(created.systemMemoryId!);

  app = await db.app.create({ data: {
    id: generateId(), name: 'research-app', urn: `${orgA.urn}:research-app`, organizationId: orgA.id,
    appAgents: { create: { agentId: agent.id } },
  } });
  otherApp = await db.app.create({ data: {
    id: generateId(), name: 'other-app', urn: `${orgA.urn}:other-app`, organizationId: orgA.id,
  } });
  // An App end user: a member of the App, NOT of the org.
  await db.appMember.create({ data: { appId: app.id, userId: endUser.id, role: 'member' } });
});

describe('#1581: startChat gates the Agent before reading or licensing anything', () => {
  it('a stranger is refused as "not found": no prompt, and no license minted', async () => {
    await expect(M.startChat(null, { agentId: agent.id }, userCtx(stranger.id)))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('a stranger naming a victim is refused, and the victim gets no license (the reproduced exploit)', async () => {
    await expect(M.startChat(null, { agentId: agent.id, userId: victim.id }, userCtx(stranger.id)))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('even a user who CAN reach the Agent may not start a chat on behalf of someone else', async () => {
    await expect(M.startChat(null, { agentId: agent.id, userId: victim.id }, userCtx(member.id)))
      .rejects.toThrow(/only an App key can start a chat on behalf of another user/);
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('CONTROL: an org READER starts the chat and is licensed', async () => {
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(member.id));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([member.id]);
  });

  it('CONTROL: an App end user (AppMember, not an org member) reaches the Agent through the live install', async () => {
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(endUser.id));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([endUser.id]);
  });

  it('the App end user loses the path when the App is uninstalled (the license must be live)', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expect(M.startChat(null, { agentId: agent.id }, userCtx(endUser.id)))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('CONTROL: a PUBLIC Agent is reachable by anyone signed in', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(stranger.id));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([stranger.id]);
  });

  it('a chat that fails after the gate leaves no license (provisioned in the chat transaction)', async () => {
    // The Agent is reachable, but it has no conversation of this name.
    await expect(M.startChat(null, { agentId: agent.id, conversationName: 'nope' }, userCtx(member.id)))
      .rejects.toThrow();
    expect(await subsFor(agent.id)).toEqual([]);
  });
});

// #1581 review (Atilla, Copilot): real App-key contexts carry roles: [] and
// reach startChat itself. Ada's ruling (#6055): an App key acts only for a user
// with a live relationship to THAT App, and a session-bound key only for its
// session's own user; anything else reads as an unknown user.
describe('#1581: startChat through a pure App key (resolver level)', () => {
  async function appKeySessionFor(userId: string | null, appId = app.id, sessionAgentId = agent.id) {
    const mem = await db.memory.create({ data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:session-${generateId().slice(-8)}`,
      name: 'session memory', class: 'app', appId,
    } });
    const session = await db.session.create({ data: {
      id: generateId(), appId, userId, agentId: sessionAgentId, memoryId: mem.id, type: 'CHATBOT', startedAt: new Date(),
    } as never });
    return { db, appId, sessionId: session.id, roles: [] } as unknown as Context;
  }

  it('an App key starts a chat for its session user, an AppMember, and licenses them', async () => {
    const ctx = await appKeySessionFor(endUser.id);
    const out = await M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx);
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([endUser.id]);
  });

  it('an App key may NOT act for a user with no relationship to its App', async () => {
    const ctx = await appKeySessionFor(null);
    await expect(M.startChat(null, { agentId: agent.id, userId: stranger.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('a session-bound App key may not license a DIFFERENT user than its session user, even an AppMember', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: victim.id, role: 'member' } });
    const ctx = await appKeySessionFor(endUser.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: victim.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('an App key may not act for a user licensed only through ANOTHER App (a subscription carries no App)', async () => {
    // appY installs the same Agent; `subUser` holds an active subscription to
    // the Agent (as if through some other App) but is no member of appY.
    const appY = await db.app.create({ data: {
      id: generateId(), name: 'app-y', urn: `${orgA.urn}:app-y`, organizationId: orgA.id,
      appAgents: { create: { agentId: agent.id } },
    } });
    const subUser = await db.user.create({ data: { githubId: 158190, githubUsername: 'sub-1581', roles: ['READER'] } });
    await db.agentSubscription.create({ data: { userId: subUser.id, agentId: agent.id, activatedAt: new Date() } });
    const ctx = await appKeySessionFor(subUser.id, appY.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: subUser.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
  });

  it('an anonymous session (no user) names nobody, not even an AppMember', async () => {
    const ctx = await appKeySessionFor(null);
    await expect(M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it("a session-bound App key may chat only with its session's Agent", async () => {
    const otherAgent = await db.agent.create({ data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:other-agent`, name: 'other', type: 'CHATBOT', surfaces: ['api'],
    } as never });
    await db.appAgent.create({ data: { appId: app.id, agentId: otherAgent.id } });
    const ctx = await appKeySessionFor(endUser.id, app.id, otherAgent.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('an App key whose App does not install the Agent is refused as not found', async () => {
    const ctx = await appKeySessionFor(endUser.id, otherApp.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
  });
});

describe('#1581 review: two concurrent first chats for the same user both complete', () => {
  it('neither chat transaction is aborted, and exactly one subscription exists', async () => {
    const results = await Promise.allSettled([
      M.startChat(null, { agentId: agent.id }, userCtx(member.id)),
      M.startChat(null, { agentId: agent.id }, userCtx(member.id)),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await subsFor(agent.id)).toEqual([member.id]);
  });
});

describe('#1581: canChatWithAgent for a pure App key', () => {
  it('allows the App the Agent is installed and licensed in, and refuses any other App', async () => {
    expect(await canChatWithAgent({ db, appId: app.id } as Context, agent)).toBe(true);
    expect(await canChatWithAgent({ db, appId: otherApp.id } as Context, agent)).toBe(false);
  });

  it('refuses an anonymous caller and a soft-deleted Agent', async () => {
    expect(await canChatWithAgent({ db } as Context, agent)).toBe(false);
    expect(await canChatWithAgent(userCtx(member.id), { ...agent, deletedAt: new Date() })).toBe(false);
  });
});
