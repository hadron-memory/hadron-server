/** #3957 (cor:dmo:050:10) — an App's chatbot AI config, the list a chat chooses from, and the order at turn time. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, User, Agent, App, AiServiceConfig } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const KEY = 'fixture-provider-key-3957';
let org: Organization, admin: User, member: User, outsider: User, platform: User, agent: Agent, app: App, other: App;
let dflt: AiServiceConfig, claude: AiServiceConfig, glm: AiServiceConfig, foreign: AiServiceConfig;
const ctx = (u: User, roles: string[] = ['READER']): Context => ({ db, userId: u.id, roles } as Context);
const code = async (p: Promise<unknown>) => p.then(() => null, (e: any) => e.extensions?.code ?? e.name ?? String(e));

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId();
  org = await db.organization.create({ data: { name: 'Acme', urn: `acme-${s}.example` } });
  [admin, member, outsider, platform] = await Promise.all(['admin', 'member', 'outsider', 'platform'].map(h =>
    db.user.create({ data: { handle: `${h}-${s}`, roles: h === 'platform' ? ['ADMIN'] : ['READER'] } })));
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { organizationId: org.id, name: 'Assistant', urn: `${org.urn}:assistant`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Workspace', urn: `${org.urn}:workspace` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.createMany({ data: [
    { appId: app.id, userId: admin.id, role: 'admin' },
    { appId: app.id, userId: member.id, role: 'reader' },
  ] });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await createDbAgentOrgGrant(db, org.id, agent.id);
  const mk = (appId: string, name: string, provider: string, model: string, enabled = true) =>
    db.aiServiceConfig.create({ data: { appId, name, provider, model, apiKeyEncrypted: encryptToken(KEY), apiKeyPreview: '…3957', enabled } });
  dflt = await mk(app.id, 'default', 'anthropic', 'claude-default');
  claude = await mk(app.id, 'claude', 'anthropic', 'claude-sonnet');
  glm = await mk(app.id, 'glm', 'glm', 'glm-5');
  foreign = await mk(other.id, 'foreign', 'openai', 'gpt-x');
});

describe('App.chatbotAiConfigId and setAppChatbotAiConfig', () => {
  it('whoever manages the App sets and clears it; the field reads back to members', async () => {
    const set = await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
    expect(set.chatbotAiConfigId).toBe(glm.id);
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBe(glm.id);
    const A = (resolvers as any).App;
    expect(await A.chatbotAiConfigId({ id: app.id }, {}, ctx(member))).toBe(glm.id);
    expect(await A.chatbotAiConfigId({ id: app.id }, {}, ctx(outsider))).toBeNull();
    await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: null }, ctx(admin));
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBeNull();
  });

  it('a member who does not manage the App is refused; a stranger gets the missing-App answer', async () => {
    expect(await code(M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(member)))).toBe('FORBIDDEN');
    expect(await code(M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(outsider))))
      .toBe(await code(M.setAppChatbotAiConfig(null, { appRef: generateId(), configId: glm.id }, ctx(outsider))));
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBeNull();
  });

  it('a platform admin sets it even on a user-owned App', async () => {
    const mine = await db.app.create({ data: { ownerUserId: member.id, name: 'Mine', urn: `member-${generateId()}:mine` } });
    const own = await db.aiServiceConfig.create({ data: { appId: mine.id, name: 'default', provider: 'glm', model: 'glm-5' } });
    const set = await M.setAppChatbotAiConfig(null, { appRef: mine.id, configId: own.id }, ctx(platform, ['ADMIN']));
    expect(set.chatbotAiConfigId).toBe(own.id);
  });

  it('another App\'s config, a deleted one and an unknown id are one refusal', async () => {
    const gone = await db.aiServiceConfig.create({ data: { appId: app.id, name: 'gone', provider: 'glm', model: 'g' } });
    await db.aiServiceConfig.delete({ where: { id: gone.id } });
    const answers = await Promise.all([foreign.id, gone.id, generateId()].map(async id =>
      M.setAppChatbotAiConfig(null, { appRef: app.id, configId: id }, ctx(admin)).catch((e: any) => ({ code: e.extensions.code, text: e.message.split(id).join('<id>') }))));
    expect(answers.map(a => a.code)).toEqual(['AiServiceConfigNotFoundError', 'AiServiceConfigNotFoundError', 'AiServiceConfigNotFoundError']);
    expect(new Set(answers.map(a => a.text)).size).toBe(1);
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBeNull();
  });

  it('deleting the config clears the field', async () => {
    await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
    await db.aiServiceConfig.delete({ where: { id: glm.id } });
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBeNull();
  });

  it('an App key, an impersonation and a headless call cannot set it', async () => {
    expect(await code(M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, { db, appId: app.id, roles: [] } as Context))).toBe('FORBIDDEN');
    expect(await code(M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, { ...ctx(admin), impersonation: { actorId: platform.id } } as unknown as Context))).toBe('FORBIDDEN');
  });
});

describe('chatAiConfigChoices', () => {
  it('lists the App\'s own enabled configs plus one default entry, and never a key', async () => {
    await db.aiServiceConfig.update({ where: { id: claude.id }, data: { enabled: false } });
    await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
    const list = await Q.chatAiConfigChoices(null, { appRef: app.id }, ctx(member));
    expect(list.map((c: any) => [c.value, c.name, c.isDefault, c.isAppChatbotConfig])).toEqual([
      ['default', 'default', true, false],
      [dflt.id, 'default', false, false],
      [glm.id, 'glm', false, true],
    ]);
    const text = JSON.stringify(list);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('3957');
    expect(text).not.toContain(foreign.id);
    expect(Object.keys(list[2]).sort()).toEqual(['isAppChatbotConfig', 'isDefault', 'model', 'name', 'provider', 'value']);
  });

  it('a non-member gets exactly the answer a missing App gets', async () => {
    const a = await Q.chatAiConfigChoices(null, { appRef: app.id }, ctx(outsider)).catch((e: any) => e);
    const b = await Q.chatAiConfigChoices(null, { appRef: generateId() }, ctx(outsider)).catch((e: any) => e);
    const strip = (e: Error, id: string) => `${e.name}|${e.message.split(id).join('<ref>')}`;
    expect(a).toBeInstanceOf(Error);
    expect(a.name).toBe('AppNotFoundError');
    expect(strip(a, app.id)).toBe(strip(b, (b.message.match(/[A-Za-z0-9]{20,}/) ?? [''])[0]));
  });
});

// ── the chat path ─────────────────────────────────────────────────────────

import { serveEveryAgent } from '../../../test/servedBootPrompt.js';

describe('the chat path', () => {
  let chatAgent: { id: string; systemMemoryId: string };
  const asMember = (extra: Partial<Context> = {}): Context => ({ db, userId: member.id, roles: ['READER'], ...extra } as Context);
  beforeEach(async () => {
    const created = await M.createAgent({}, { orgId: org.id, name: 'chat-agent', visibility: 'ORGANIZATION' }, ctx(admin, ['ADMIN']));
    chatAgent = { id: created.id, systemMemoryId: created.systemMemoryId! };
    for (const [loc, data, content] of [
      ['conversations', null, null],
      ['conversations:main', { stageOrder: ['s1'] }, null],
      ['conversations:main:s1', {}, 'prompt main/s1'],
    ] as const) {
      await db.node.create({ data: { id: generateId(), memoryId: chatAgent.systemMemoryId, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } });
    }
    await db.appAgent.create({ data: { appId: app.id, agentId: chatAgent.id } });
    await serveEveryAgent(db);
  });
  const start = (args: Record<string, unknown>, c: Context = asMember()) => M.startChat(null, { agentId: chatAgent.id, scope: 'shared', ...args }, c);

  // loc-scope-ok: a count over every memory, to prove that a refused start left no chat anywhere.
  const chatCount = () => db.node.count({ where: { loc: { startsWith: 'chats:' }, nodeType: { not: 'message' }, name: { not: 'messages' } } });
  const stored = async (chatId: string) => ((await chatNodeByLocOrThrow(db, chatId)).data as Record<string, unknown>).aiConfigChoice;
  const resolve = (chatId: string | null, c: Context = ctx(admin)) =>
    Q.resolveAIConfig(null, { name: 'default', appRef: app.id, ...(chatId ? { chatId } : {}) }, c);

  it('startChat stores a valid choice with the chat, and `default` too', async () => {
    const a = await start({ aiConfigChoice: claude.id });
    expect(await stored(a.chatId)).toBe(claude.id);
    const b = await start({ aiConfigChoice: 'default' });
    expect(await stored(b.chatId)).toBe('default');
    const c = await start({});
    expect(await stored(c.chatId)).toBeUndefined();
  });

  it('sendChatMessage stores the choice; a later turn without one keeps it; a new choice replaces it', async () => {
    const { chatId } = await start({});
    await M.sendChatMessage(null, { chatId, userMessage: 'hi', aiConfigChoice: glm.id }, asMember());
    expect(await stored(chatId)).toBe(glm.id);
    await M.sendChatMessage(null, { chatId, userMessage: 'again' }, asMember());
    expect(await stored(chatId)).toBe(glm.id);
    await M.sendChatMessage(null, { chatId, userMessage: 'switch', aiConfigChoice: claude.id }, asMember());
    expect(await stored(chatId)).toBe(claude.id);
    const rows = await Q.myChats(null, { agentRef: chatAgent.id }, asMember());
    expect(rows.find((r: any) => r.loc === chatId)?.aiConfigChoice).toBe(claude.id);
  });

  it('another App\'s config, a deleted one and an unknown id are one refusal, before any write', async () => {
    const gone = await db.aiServiceConfig.create({ data: { appId: app.id, name: 'gone', provider: 'glm', model: 'g' } });
    await db.aiServiceConfig.delete({ where: { id: gone.id } });
    const before = await chatCount();
    const ids = [foreign.id, gone.id, generateId()];
    const starts = await Promise.all(ids.map(id => start({ aiConfigChoice: id }).catch((e: any) => ({ code: e.extensions.code, text: e.message.split(id).join('<id>') }))));
    expect(starts.map(a => a.code)).toEqual(['AiServiceConfigNotFoundError', 'AiServiceConfigNotFoundError', 'AiServiceConfigNotFoundError']);
    expect(new Set(starts.map(a => a.text)).size).toBe(1);
    expect(await chatCount()).toBe(before);
    const { chatId } = await start({ aiConfigChoice: claude.id });
    // loc-scope-ok: the chat id is unique in this fixture, and the count only compares before and after.
    const messages = () => db.node.count({ where: { loc: { startsWith: `${chatId}:messages:` } } });
    const m0 = await messages();
    const sends = await Promise.all(ids.map(id => M.sendChatMessage(null, { chatId, userMessage: 'x', aiConfigChoice: id }, asMember()).catch((e: any) => ({ code: e.extensions.code, text: e.message.split(id).join('<id>') }))));
    expect(sends.map(a => a.code)).toEqual(['AiServiceConfigNotFoundError', 'AiServiceConfigNotFoundError', 'AiServiceConfigNotFoundError']);
    expect(new Set(sends.map(a => a.text)).size).toBe(1);
    expect(await messages()).toBe(m0);
    expect(await stored(chatId)).toBe(claude.id);
  });

  it('a disabled own config is accepted as a choice (skipped at turn time)', async () => {
    await db.aiServiceConfig.update({ where: { id: glm.id }, data: { enabled: false } });
    const { chatId } = await start({ aiConfigChoice: glm.id });
    expect(await stored(chatId)).toBe(glm.id);
  });

  describe('resolveAIConfig(chatId:) order', () => {
    it('no choice and no App chatbot config: today\'s default walk, byte-identical', async () => {
      const { chatId } = await start({});
      const withChat = await resolve(chatId);
      const without = await resolve(null);
      expect(withChat).toEqual(without);
      expect(withChat.configId).toBe(dflt.id);
    });

    it('a turn with the second config\'s id uses that config', async () => {
      const { chatId } = await start({});
      await M.sendChatMessage(null, { chatId, userMessage: 'hi', aiConfigChoice: claude.id }, asMember());
      const r = await resolve(chatId);
      expect(r.configId).toBe(claude.id);
      expect(r.model).toBe('claude-sonnet');
      expect(r.ownerType).toBe('APP');
    });

    it('the chat\'s choice beats the App\'s chatbot config, which beats the default walk', async () => {
      await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
      const none = await start({});
      const picked = await start({ aiConfigChoice: claude.id });
      expect((await resolve(none.chatId)).configId).toBe(glm.id);
      expect((await resolve(picked.chatId)).configId).toBe(claude.id);
    });

    it('`default` stored on the chat skips the App\'s chatbot config and takes the walk', async () => {
      await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
      const { chatId } = await start({ aiConfigChoice: 'default' });
      expect((await resolve(chatId)).configId).toBe(dflt.id);
    });

    it('a disabled or deleted pin is skipped as if unset, never winning', async () => {
      await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
      const { chatId } = await start({ aiConfigChoice: claude.id });
      await db.aiServiceConfig.update({ where: { id: claude.id }, data: { enabled: false } });
      expect((await resolve(chatId)).configId).toBe(glm.id);
      await db.aiServiceConfig.update({ where: { id: glm.id }, data: { enabled: false } });
      expect((await resolve(chatId)).configId).toBe(dflt.id);
      await db.aiServiceConfig.update({ where: { id: claude.id }, data: { enabled: true } });
      expect((await resolve(chatId)).configId).toBe(claude.id);
      await db.aiServiceConfig.delete({ where: { id: claude.id } });
      expect((await resolve(chatId)).configId).toBe(dflt.id);
    });

    it('a foreign config id planted in the chat data is skipped, never used', async () => {
      const { chatId } = await start({});
      const node = await chatNodeByLocOrThrow(db, chatId);
      await db.node.update({ where: { id: node.id }, data: { data: { ...(node.data as object), aiConfigChoice: foreign.id } as never } });
      expect((await resolve(chatId)).configId).toBe(dflt.id);
    });

    it('a chat of another App answers as a missing chat', async () => {
      const { chatId } = await start({});
      await db.appMember.create({ data: { appId: other.id, userId: admin.id, role: 'admin' } });
      const err = await Q.resolveAIConfig(null, { name: 'default', appRef: other.id, chatId }, ctx(admin)).catch((e: any) => e);
      const unknown = await Q.resolveAIConfig(null, { name: 'default', appRef: other.id, chatId: 'chats:nope' }, ctx(admin)).catch((e: any) => e);
      expect(err.message).toBeDefined();
      expect(err.message.split(chatId).join('<c>')).toBe(unknown.message.split('chats:nope').join('<c>'));
    });
  });
});
