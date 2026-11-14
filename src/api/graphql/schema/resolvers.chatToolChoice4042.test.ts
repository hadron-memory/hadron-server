/**
 * #4042 (cor:dmo:050:10, cor:acl:030:01) — the chat turn's tool-choice decision, exposed on the resolved config
 * (`ResolvedAiConfig.toolChoice`, `Query.chatEffectiveToolChoice`) and for an unsaved pair (`Query.chatToolChoiceFor`).
 * Both read the ONE predicate in `lib/llm/chatToolChoice.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, User, Agent, App, AiServiceConfig } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { chatToolChoiceFor } from '../../../lib/llm/chatToolChoice.js';
import { effectiveChatToolChoice } from '../../../lib/chatbotAiConfig.js';
import { encryptNodeFields } from '../../../lib/nodeCrypto.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { resolveAiConfig, resolveAiConfigs, resolveAiConfigWithFallback, resolveDefaultAiConfig } from '../../../lib/aiConfig.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const AUTO_ANTHROPIC = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'];
const AUTO_BEDROCK = [
  'anthropic.claude-sonnet-5-5', 'us.anthropic.claude-sonnet-5-5', 'eu.anthropic.claude-sonnet-5-5', 'au.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-sonnet-5-5',
  'anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5', 'eu.anthropic.claude-opus-5-5', 'au.anthropic.claude-opus-5-5', 'jp.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5-5',
  'anthropic.claude-fable-5-2', 'us.anthropic.claude-fable-5-2', 'global.anthropic.claude-fable-5-2',
];
const code = async (p: Promise<unknown>) => p.then(() => null, (e: any) => e.extensions?.code ?? e.name ?? String(e));

let org: Organization, admin: User, member: User, outsider: User, agent: Agent, app: App;
const ctx = (u: User, extra: Partial<Context> = {}): Context => ({ db, userId: u.id, roles: ['READER'], ...extra } as Context);

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId();
  org = await db.organization.create({ data: { name: 'Acme', urn: `acme-${s}.example` } });
  [admin, member, outsider] = await Promise.all(['admin', 'member', 'outsider'].map(h =>
    db.user.create({ data: { handle: `${h}-${s}`, roles: ['READER'] } })));
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'chat-agent', visibility: 'ORGANIZATION' }, { db, userId: admin.id, roles: ['ADMIN'] } as Context);
  app = await db.app.create({ data: { organizationId: org.id, name: 'Workspace', urn: `${org.urn}:workspace` } });
  await db.appMember.createMany({ data: [
    { appId: app.id, userId: admin.id, role: 'admin' },
    { appId: app.id, userId: member.id, role: 'reader' },
  ] });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await createDbAgentOrgGrant(db, org.id, agent.id);
  for (const [loc, data, content] of [
    ['conversations', null, null],
    ['conversations:main', { stageOrder: ['s1'] }, null],
    ['conversations:main:s1', {}, 'prompt main/s1'],
  ] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId!, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } });
  }
  await serveEveryAgent(db);
});

const hostServer = async () => (await db.hadronServer.findFirst()) ?? db.hadronServer.create({ data: { id: generateId(), url: 'https://host4042.test' } });
const cfg = (owner: { appId?: string; agentId?: string; organizationId?: string; hadronServerId?: string }, name: string, provider: string, model: string, enabled = true): Promise<AiServiceConfig> =>
  db.aiServiceConfig.create({ data: { ...owner, name, provider, model, apiKeyEncrypted: encryptToken('fixture-key-4042'), apiKeyPreview: '…4042', enabled } });

describe('(a) ResolvedAiConfig.toolChoice is non-null on every resolve path', () => {
  it('resolveAiConfig, resolveDefaultAiConfig, resolveAiConfigs and resolveAiConfigWithFallback carry the decision at every level', async () => {
    await cfg({ appId: app.id }, 'default', 'anthropic', 'claude-sonnet-5-5'); // App level, AUTO
    await cfg({ agentId: agent.id }, 'agentcfg', 'anthropic', 'claude-sonnet'); // Agent level, FORCED
    await cfg({ organizationId: org.id }, 'orgcfg', 'bedrock', 'us.anthropic.claude-opus-5-5'); // Org level, AUTO
    const host = await hostServer();
    await cfg({ hadronServerId: host.id }, 'hostcfg', 'openai', 'gpt-x'); // Host level, FORCED
    const c = { appId: app.id, agentId: agent.id };
    expect((await resolveAiConfig(db, 'default', c))?.toolChoice).toBe('AUTO');
    expect((await resolveDefaultAiConfig(db, c))?.toolChoice).toBe('AUTO');
    expect((await resolveAiConfig(db, 'agentcfg', c))?.toolChoice).toBe('FORCED');
    expect((await resolveAiConfig(db, 'orgcfg', c))?.toolChoice).toBe('AUTO');
    expect((await resolveAiConfig(db, 'hostcfg', c))?.toolChoice).toBe('FORCED');
    expect((await resolveAiConfigWithFallback(db, 'no-such-name', c)).toolChoice).toBe('AUTO');
    const all = await resolveAiConfigs(db, c);
    expect(all.map(r => [r.config.name, r.toolChoice])).toEqual([
      ['agentcfg', 'FORCED'], ['default', 'AUTO'], ['hostcfg', 'FORCED'], ['orgcfg', 'AUTO'],
    ]);
  });
});

describe('(b) chatToolChoiceFor(provider, model): the pure unsaved-pair decision', () => {
  const ask = (provider: string, model: string, c: Context = ctx(member)) => Q.chatToolChoiceFor(null, { provider, model }, c);

  it('answers AUTO for each of the 17 listed pairs', async () => {
    expect(AUTO_ANTHROPIC.length + AUTO_BEDROCK.length).toBe(17);
    for (const m of AUTO_ANTHROPIC) expect(await ask('anthropic', m)).toBe('AUTO');
    for (const m of AUTO_BEDROCK) expect(await ask('bedrock', m)).toBe('AUTO');
  });

  it('answers FORCED, never a refusal, for a suffix, a case variant, an unlisted model, a wrong provider and an unknown provider', async () => {
    for (const [p, m] of [
      ['anthropic', 'claude-sonnet-5-5-20250929'], ['anthropic', 'Claude-Sonnet-5-5'], ['anthropic', 'claude-sonnet-5-5 '], ['anthropic', 'claude-haiku-5-5'],
      ['Anthropic', 'claude-sonnet-5-5'], ['bedrock', 'claude-sonnet-5-5'], ['anthropic', 'us.anthropic.claude-sonnet-5-5'],
      ['bedrock', 'us.anthropic.claude-fable-5-2 '], ['bedrock', 'eu.anthropic.claude-fable-5-2'],
      ['openai', 'claude-sonnet-5-5'], ['glm', 'claude-sonnet-5-5'], ['openai-compatible', 'claude-sonnet-5-5'], ['junk', 'claude-sonnet-5-5'], ['', ''],
    ]) {
      expect(await ask(p, m), `${p}/${m}`).toBe('FORCED');
    }
  });

  it('serves any signed-in caller (a person or an App key), with no owner context, and refuses an unauthenticated one', async () => {
    expect(await ask('anthropic', 'claude-opus-5-5', ctx(outsider))).toBe('AUTO');
    expect(await ask('anthropic', 'claude-opus-5-5', { db, appId: app.id, appKeyId: generateId(), roles: [] } as Context)).toBe('AUTO');
    expect(await code(Promise.resolve().then(() => ask('anthropic', 'claude-opus-5-5', { db, roles: [] } as Context)))).toBe('UNAUTHENTICATED');
  });

  describe('purity', () => {
    afterEach(() => vi.restoreAllMocks());
    it('reads no row of any kind, decrypts nothing, makes no HTTP request and writes no usage event', async () => {
      await cfg({ appId: app.id }, 'default', 'anthropic', 'claude-sonnet-5-5');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const usageBefore = await db.usageEvent.count();
      const touched: string[] = [];
      const watched = new Proxy(db, { get: (t, k) => { touched.push(String(k)); return (t as any)[k]; } }) as typeof db;
      expect(await Q.chatToolChoiceFor(null, { provider: 'anthropic', model: 'claude-sonnet-5-5' }, { db: watched, userId: member.id, roles: ['READER'] } as Context)).toBe('AUTO');
      expect(touched).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await db.usageEvent.count()).toBe(usageBefore);
    });
  });
});

describe('(c) chatEffectiveToolChoice(chatId)', () => {
  const asMember = (extra: Partial<Context> = {}) => ctx(member, extra);
  const start = (args: Record<string, unknown> = {}, c: Context = asMember()) => M.startChat(null, { agentId: agent.id, scope: 'shared', ...args }, c);
  const effective = (chatId: string, c: Context = asMember()) => Q.chatEffectiveToolChoice(null, { chatId }, c);

  it('default branch: a chat on `default` returns the decision of the config the walk lands on, at Agent, Org and Host level', async () => {
    const { chatId } = await start({ aiConfigChoice: 'default' });
    await cfg({ agentId: agent.id }, 'default', 'anthropic', 'claude-sonnet-5-5');
    expect(await effective(chatId)).toBe('AUTO'); // Agent level
    await db.aiServiceConfig.deleteMany({ where: { agentId: agent.id } });
    await cfg({ agentId: agent.id }, 'default', 'openai', 'gpt-x');
    expect(await effective(chatId)).toBe('FORCED'); // the Agent level still wins over an AUTO Org level
    await cfg({ organizationId: org.id }, 'default', 'anthropic', 'claude-sonnet-5-5');
    await db.aiServiceConfig.deleteMany({ where: { agentId: agent.id } });
    expect(await effective(chatId)).toBe('AUTO'); // Org level
    await db.aiServiceConfig.deleteMany({ where: { organizationId: org.id } });
    const host = await hostServer();
    await cfg({ hadronServerId: host.id }, 'default', 'bedrock', 'global.anthropic.claude-fable-5-2');
    expect(await effective(chatId)).toBe('AUTO'); // Host level
  });

  it('choice branch: a stored own choice, else the App chatbot config, else the walk; a disabled pin is skipped as the turn skips it', async () => {
    const walk = await cfg({ appId: app.id }, 'default', 'openai', 'gpt-x'); // FORCED
    const auto = await cfg({ appId: app.id }, 'auto', 'anthropic', 'claude-opus-5-5'); // AUTO
    const forced = await cfg({ appId: app.id }, 'forced', 'anthropic', 'claude-sonnet'); // FORCED
    const chosenAuto = await start({ aiConfigChoice: auto.id });
    const chosenForced = await start({ aiConfigChoice: forced.id });
    const unchosen = await start({});
    // Drift guard (Glen's P2 on #4151): the turn's own resolution, `resolveAIConfig(chatId:)`, judged by the one predicate, must
    // agree with the new query for every chat in every state below.
    const viaTurn = async (chatId: string) => {
      const r = await Q.resolveAIConfig(null, { name: 'default', appRef: app.id, chatId }, ctx(admin));
      return chatToolChoiceFor(r.provider, r.model);
    };
    const agree = async (chatId: string, expected: string) => {
      expect(await effective(chatId)).toBe(expected);
      expect(await viaTurn(chatId)).toBe(expected);
    };
    await agree(chosenAuto.chatId, 'AUTO');
    await agree(chosenForced.chatId, 'FORCED');
    await agree(unchosen.chatId, 'FORCED'); // the walk's `default`
    await db.app.update({ where: { id: app.id }, data: { chatbotAiConfigId: auto.id } });
    await agree(unchosen.chatId, 'AUTO'); // the App chatbot config
    await agree(chosenForced.chatId, 'FORCED'); // a stored choice still outranks it
    await db.aiServiceConfig.update({ where: { id: auto.id }, data: { enabled: false } });
    await agree(unchosen.chatId, 'FORCED'); // disabled chatbot config: falls to the walk
    await agree(chosenAuto.chatId, 'FORCED'); // disabled stored choice: falls through to the walk
    expect(walk.model).toBe('gpt-x');
  });

  it('no-App chat: an Agent chat with no App still gets the walk\'s decision', async () => {
    await cfg({ agentId: agent.id }, 'default', 'anthropic', 'claude-fable-5-2');
    await db.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: agent.id } } }); // no installed App: the org manager's chat is App-less
    const { chatId } = await start({ scope: 'private' }, ctx(admin));
    const node = await chatNodeByLocOrThrow(db, chatId);
    expect((await db.memory.findUniqueOrThrow({ where: { id: node.memoryId } })).appId).toBeNull();
    expect(await effective(chatId, ctx(admin))).toBe('AUTO');
  });

  it('answers null, and does not raise, when nothing resolves', async () => {
    const { chatId } = await start({});
    expect(await effective(chatId)).toBeNull();
  });

  it('retained private chat: after the Agent is uninstalled the turn drops it, and so does the answer (Gizelle F1)', async () => {
    await cfg({ agentId: agent.id }, 'default', 'anthropic', 'claude-sonnet-5-5'); // Agent default: AUTO
    await cfg({ organizationId: org.id }, 'default', 'openai', 'gpt-x'); // Org default: FORCED
    const { chatId } = await start({ scope: 'private', aiConfigChoice: 'default' });
    const node = await chatNodeByLocOrThrow(db, chatId);
    expect((await db.memory.findUniqueOrThrow({ where: { id: node.memoryId } })).appId).toBe(app.id); // App-bearing, but private
    expect(await effective(chatId)).toBe('AUTO'); // control
    await db.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: agent.id } } });
    expect(await effective(chatId)).toBe('FORCED');
  });

  it('an encrypted chat\'s stored choice is read, not skipped', async () => {
    const auto = await cfg({ appId: app.id }, 'auto', 'anthropic', 'claude-opus-5-5');
    await cfg({ appId: app.id }, 'default', 'openai', 'gpt-x');
    const { chatId } = await start({ aiConfigChoice: auto.id });
    const node = await chatNodeByLocOrThrow(db, chatId);
    sessionKeyCache.set(generateId(), node.memoryId, generateDataKey());
    await db.memory.update({ where: { id: node.memoryId }, data: { isEncrypted: true } });
    await db.node.update({ where: { id: node.id }, data: { data: encryptNodeFields({ data: node.data }, { id: node.memoryId, isEncrypted: true }).data! as never } });
    expect(JSON.stringify((await chatNodeByLocOrThrow(db, chatId)).data)).not.toContain(auto.id); // really ciphertext at rest
    expect(await effective(chatId)).toBe('AUTO'); // the walk's default would be FORCED
  });

  it('a user-owned App whose walk lands on the platform config answers null; its own config still answers', async () => {
    const host = await hostServer();
    await cfg({ hadronServerId: host.id }, 'default', 'anthropic', 'claude-sonnet-5-5');
    const mine = await db.app.create({ data: { ownerUserId: member.id, name: 'Mine', urn: `member-${generateId()}:mine` } });
    const ask = () => effectiveChatToolChoice(db, { appId: mine.id, agentId: null, storedChoice: null });
    expect(await ask()).toBeNull(); // the platform's config is not available to a personal App
    await cfg({ appId: mine.id }, 'default', 'anthropic', 'claude-opus-5-5');
    expect(await ask()).toBe('AUTO');
  });

  it('#829: a planted node at the chat\'s loc cannot be picked over the real chat', async () => {
    await cfg({ appId: app.id }, 'default', 'openai', 'gpt-x'); // the real chat's App: FORCED
    const { chatId } = await start({ aiConfigChoice: 'default' });
    const real = await chatNodeByLocOrThrow(db, chatId);
    // A co-member plants the same loc in a SECOND app memory the caller also belongs to: both rows survive the entitlement
    // filter, so only the oldest-wins ordering settles it. That App's `default` is AUTO, so picking the plant is visible.
    const appB = await db.app.create({ data: { organizationId: org.id, name: 'Second', urn: `${org.urn}:second` } });
    await db.appMember.createMany({ data: [{ appId: appB.id, userId: member.id, role: 'reader' }, { appId: appB.id, userId: outsider.id, role: 'reader' }] });
    await cfg({ appId: appB.id }, 'default', 'anthropic', 'claude-sonnet-5-5');
    const memB = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `plant-mem-${generateId()}`, name: 'plant-mem', class: 'app', appId: appB.id, createdBy: outsider.id } });
    await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: real.loc, name: 'plant', createdBy: outsider.id, data: { aiConfigChoice: 'default' } as never } });
    expect(await effective(chatId)).toBe('FORCED'); // the oldest, real chat
  });

  it('gate: unauthenticated and impersonated callers are refused before any read; an unreadable chat and an unknown chat answer byte-identically', async () => {
    await cfg({ appId: app.id }, 'default', 'anthropic', 'claude-sonnet-5-5');
    const { chatId } = await start({ scope: 'private' }, ctx(admin));
    expect(await effective(chatId, ctx(admin))).toBe('AUTO'); // control: the owner reads it
    expect(await code(Promise.resolve().then(() => effective(chatId, { db, roles: [] } as Context)))).toBe('UNAUTHENTICATED');
    const touched: string[] = [];
    const watched = new Proxy(db, { get: (t, k) => { touched.push(String(k)); return (t as any)[k]; } }) as typeof db;
    const imp = { orgId: org.id, sessionId: generateId(), actorUserId: outsider.id, expiresAt: new Date(Date.now() + 60000) };
    expect(await code(Promise.resolve().then(() => effective(chatId, { db: watched, userId: admin.id, roles: [], impersonation: imp } as Context)))).toBe('FORBIDDEN');
    expect(touched).toEqual([]);
    const denied = await effective(chatId, ctx(member)).catch((e: any) => e); // an App member who is not the chat's owner
    const unknown = await effective('chats:nope', ctx(member)).catch((e: any) => e);
    const stranger = await effective(chatId, ctx(outsider)).catch((e: any) => e);
    // The entitlement filter (`chatLocFilter`) admits a chat's AUTHOR; only the host memory's read gate refuses them once they
    // are no longer a participant. This is the caller that proves the gate, not the filter, is doing the work.
    const shared = await start({}, ctx(member));
    expect(await effective(shared.chatId, ctx(member))).toBe('AUTO'); // control: the author reads their own shared chat
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: member.id } } });
    const lapsed = await effective(shared.chatId, ctx(member)).catch((e: any) => e);
    for (const e of [denied, unknown, stranger, lapsed]) expect(e.extensions?.code).toBe('CHAT_NOT_FOUND');
    const shape = (e: any, id: string) => JSON.stringify({ m: e.message.split(id).join('<c>'), x: e.extensions });
    expect(shape(denied, chatId)).toBe(shape(unknown, 'chats:nope'));
    expect(shape(stranger, chatId)).toBe(shape(unknown, 'chats:nope'));
    expect(shape(lapsed, shared.chatId)).toBe(shape(unknown, 'chats:nope'));
  });
});
