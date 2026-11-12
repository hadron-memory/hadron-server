/** #3957 (cor:dmo:050:10) — an App's chatbot AI config, the list a chat chooses from, and the order at turn time. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, User, Agent, App, AiServiceConfig } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { encryptNodeFields } from '../../../lib/nodeCrypto.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
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

  // Atilla's P3 on #3960: a run carrying a real userId and an authenticated worker, on the mutation, the field and the list.
  const run = () => ({ ...ctx(admin), appId: app.id, clientId: 'run:fixture' }) as unknown as Context;
  const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId: generateId(), agentId: null }, fn);
  it('a run carrying a real userId and a bound worker cannot set it', async () => {
    expect(await code(M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, run()))).toBe('FORBIDDEN');
    expect(await code(asWorker(() => M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin))))).toBe('FORBIDDEN');
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBeNull();
  });

  it('a demotion that commits between the check and the write is seen: the setter refuses (Andi F2 on #3960)', async () => {
    // `admin` manages this App only through the org ADMIN arm; the App role below is not an owner role.
    await db.appMember.upsert({ where: { appId_userId: { appId: app.id, userId: admin.id } }, update: { role: 'admin' }, create: { appId: app.id, userId: admin.id, role: 'admin' } });
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db as unknown as { $transaction: (...a: unknown[]) => Promise<unknown> }, '$transaction').mockImplementationOnce((async (...a: unknown[]) => {
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: admin.id } }, data: { role: 'READER' } });
      return real(...a);
    }) as never);
    const raced = await code(M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin)));
    spy.mockRestore();
    expect(raced).toBe('FORBIDDEN');
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBeNull();
    expect(await code(M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin)))).toBe('FORBIDDEN');
  });

  // #3965 (cor:dmo:050:12: "never an App key, and never a session acting as someone else"): the setter pins are above;
  // the field and the list refuse the same principals. For the list the audience ("any App member") is built behaviour, not law.
  it('an App key and an impersonated session read the field as null and the list as a missing App', async () => {
    await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
    const appKey = { db, appId: app.id, roles: [] } as unknown as Context;
    const impersonated = { ...ctx(admin), impersonation: { actorId: platform.id } } as unknown as Context;
    const field = (c: Context) => (resolvers as any).App.chatbotAiConfigId({ id: app.id }, {}, c);
    const missing = await Q.chatAiConfigChoices(null, { appRef: generateId() }, ctx(admin)).catch((e: any) => e.name);
    for (const c of [appKey, impersonated]) {
      expect(await field(c)).toBeNull();
      expect(await Q.chatAiConfigChoices(null, { appRef: app.id }, c).catch((e: any) => e.name)).toBe(missing);
    }
  });

  it('a demotion that overlaps the write is serialized: the setter waits for the revoker, then refuses (Atilla P3 on #3960)', async () => {
    // `admin` manages this App only through the org ADMIN arm. The revoker below takes the org authority anchor
    // exclusively (the protocol every revoker follows), demotes, and commits only when released.
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: admin.id } }, data: { role: 'admin' } });
    let release!: () => void;
    const released = new Promise<void>(r => { release = r; });
    let locked!: (pid: number) => void;
    const holding = new Promise<number>(r => { locked = r; });
    const revoker = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: org.id }], 'exclusive');
      await tx.orgMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: admin.id } }, data: { role: 'READER' } });
      locked(Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid));
      await released;
    }, { timeout: 30_000 });
    const holderPid = await holding;
    let settled = false;
    const setter = M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin)).then(
      (v: unknown) => { settled = true; return v; }, (e: unknown) => { settled = true; throw e; });
    try {
      // Synchronize on a DIFFERENT backend WAITING for this org's authority anchor (the same two-key advisory lock the
      // revoker holds), not on elapsed time and not on any advisory waiter in the cluster.
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        waiting = Number((await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND pid <> ${holderPid}
            AND classid::bigint = (hashtext('authorization:org')::bigint & 4294967295)
            AND objid::bigint = (hashtext(${org.id})::bigint & 4294967295)`)[0]?.n ?? 0);
        if (waiting === 0) await new Promise(r => setTimeout(r, 50));
      }
      expect(waiting).toBeGreaterThan(0);
      expect(settled).toBe(false); // blocked behind the revoker's anchor, not yet decided
    } finally {
      release(); // never leave the revoker holding its lock, whatever the assertion said
      await revoker;
      await setter.catch(() => undefined); // never leave the setter running after an assertion failure
    }
    expect(await code(setter)).toBe('FORBIDDEN');
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).chatbotAiConfigId).toBeNull();
  }, 20_000);

  it('the field reads null for a run and a worker, and the list answers them as a missing App', async () => {
    await M.setAppChatbotAiConfig(null, { appRef: app.id, configId: glm.id }, ctx(admin));
    const field = (c: Context) => (resolvers as any).App.chatbotAiConfigId({ id: app.id }, {}, c);
    expect(await field(ctx(admin))).toBe(glm.id);
    expect(await field(run())).toBeNull();
    expect(await asWorker(() => field(ctx(admin)))).toBeNull();
    const missing = await Q.chatAiConfigChoices(null, { appRef: generateId() }, ctx(admin)).catch((e: any) => e.name);
    expect(await Q.chatAiConfigChoices(null, { appRef: app.id }, run()).catch((e: any) => e.name)).toBe(missing);
    expect(await asWorker(() => Q.chatAiConfigChoices(null, { appRef: app.id }, ctx(admin))).catch((e: any) => e.name)).toBe(missing);
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
    expect(Object.keys(list[2]).sort()).toEqual(['isAppChatbotConfig', 'isDefault', 'model', 'name', 'provider', 'toolChoice', 'value']);
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

  it('a refused cold shared start provisions nothing: no memory, subscription or node (Andi F1 on #3960)', async () => {
    // loc-scope-ok: whole-table counts, compared before and after one refused call.
    const counts = async () => [await db.memory.count(), await db.node.count(), await db.memorySubscription.count()];
    // Atilla's P3: the guard is only exercised on a COLD start, so state the precondition.
    expect(await db.memory.count({ where: { appId: app.id, class: 'app' } })).toBe(0);
    const before = await counts();
    expect(await code(start({ aiConfigChoice: foreign.id }))).toBe('AiServiceConfigNotFoundError');
    expect(await counts()).toEqual(before);
    // the same start without the bad choice does provision, so the count above is a real signal
    await start({});
    expect((await counts())[0]).toBeGreaterThan(before[0] as number);
  });

  it('a refused cold PRIVATE start provisions nothing, with or without a matching App (Andi F1 on #3960, Rodolfo P3-3)', async () => {
    // loc-scope-ok: whole-table counts, compared before and after one refused call.
    const counts = async () => [await db.memory.count(), await db.node.count(), await db.memorySubscription.count()];
    const asAdmin = (): Context => ({ db, userId: admin.id, roles: ['READER'] } as Context);
    // `admin` is an org member, so the lazy per-user memory belongs to the App; `member` is not, so it belongs to none.
    for (const [who, bad] of [[asAdmin, foreign.id], [asMember, foreign.id], [asMember, claude.id]] as const) {
      // Atilla's P3: this person has no per-user memory for the Agent yet, so the lazy-create branch is the one tested.
      const asUser = who().userId!;
      expect(await db.memory.count({ where: { userMemoryOfAgentId: chatAgent.id, createdBy: asUser } })).toBe(0);
      const before = await counts();
      expect(await code(start({ scope: 'private', aiConfigChoice: bad }, who()))).toBe('AiServiceConfigNotFoundError');
      expect(await counts()).toEqual(before);
    }
    // the App's own config is accepted for the person it belongs to, and does provision
    const ok = await start({ scope: 'private', aiConfigChoice: claude.id }, asAdmin());
    expect(await stored(ok.chatId)).toBe(claude.id);
  });

  it('a warm PRIVATE start with a bad choice is refused and creates nothing (Rodolfo P3-3 on #3960)', async () => {
    // loc-scope-ok: whole-table counts, compared before and after one refused call.
    const counts = async () => [await db.memory.count(), await db.node.count(), await db.memorySubscription.count()];
    const asAdmin = { db, userId: admin.id, roles: ['READER'] } as Context;
    await start({ scope: 'private' }, asAdmin); // cold: provisions the per-user memory
    expect(await db.memory.count({ where: { userMemoryOfAgentId: chatAgent.id, createdBy: admin.id } })).toBe(1); // now warm
    const before = await counts();
    expect(await code(start({ scope: 'private', aiConfigChoice: foreign.id }, asAdmin))).toBe('AiServiceConfigNotFoundError');
    expect(await counts()).toEqual(before);
  });

  // Rodolfo P3-2 (cor:dmo:050:10: a pin naming another App's config, a deleted one or an id that doesn't exist is refused
  // like a missing id, with nothing revealing that the config exists): a chat with no App, and a REAL org config's id.
  it('a choice on a chat with no App is refused identically to a nonexistent id, after normalizing only the id the caller sent', async () => {
    const orgConfig = await db.aiServiceConfig.create({ data: { organizationId: org.id, name: 'org-wide', provider: 'openai', model: 'gpt-org', apiKeyEncrypted: encryptToken(KEY), apiKeyPreview: '…3957' } });
    // `member` is not an org member, so the lazy per-user memory belongs to no App.
    // Victor's conditions: every occurrence of the caller's exact input becomes one shared placeholder on both sides and the WHOLE
    // serialized error is compared; and the echo is the verbatim input, never anything config-derived.
    const refusal = (id: string, run: () => Promise<unknown>) => run().then(() => null, (e: any) => {
      const whole = JSON.stringify({ name: e.name, ...(typeof e.toJSON === 'function' ? e.toJSON() : { message: e.message }) });
      expect(whole).toContain(id); // the caller's own input comes back verbatim
      for (const derived of [orgConfig.name, orgConfig.model, orgConfig.provider, orgConfig.apiKeyPreview!, KEY]) expect(whole).not.toContain(derived);
      return whole.split(id).join('<id>');
    });
    const absent = generateId();
    const spellings = [orgConfig.id, orgConfig.id.toUpperCase(), orgConfig.id.toLowerCase(), absent]; // a spelling only the caller supplied is echoed as sent
    const starts = await Promise.all(spellings.map(id => refusal(id, () => start({ scope: 'private', aiConfigChoice: id }))));
    expect(new Set(starts).size).toBe(1);
    expect(starts[0]).toContain('AiServiceConfigNotFoundError');
    const { chatId } = await start({ scope: 'private' });
    expect((await db.memory.findUniqueOrThrow({ where: { id: (await chatNodeByLocOrThrow(db, chatId)).memoryId } })).appId).toBeNull();
    const sends = await Promise.all(spellings.map(id => refusal(id, () => M.sendChatMessage(null, { chatId, userMessage: 'x', aiConfigChoice: id }, asMember()))));
    expect(new Set(sends).size).toBe(1);
    expect(sends[0]).toContain('AiServiceConfigNotFoundError');
    expect(await stored(chatId)).toBeUndefined();
  });

  it('an encrypted chat\'s stored choice resolves; an org ADMIN who cannot read the chat gets the unknown-chat answer and no config detail', async () => {
    // Anne F1: the denied caller must pass the OUTER org-admin gate, so it is the chat-read gate that refuses.
    const asAdmin = { db, userId: admin.id, roles: ['READER'] } as Context;
    const { chatId } = await start({ scope: 'private', aiConfigChoice: claude.id }, asAdmin);
    const node = await chatNodeByLocOrThrow(db, chatId);
    expect((await db.memory.findUniqueOrThrow({ where: { id: node.memoryId } })).appId).toBe(app.id); // admin's own private chat of this App
    const key = generateDataKey();
    sessionKeyCache.set(generateId(), node.memoryId, key);
    await db.memory.update({ where: { id: node.memoryId }, data: { isEncrypted: true } });
    await db.node.update({ where: { id: node.id }, data: { data: encryptNodeFields({ data: node.data }, { id: node.memoryId, isEncrypted: true }).data! as never } });
    expect(JSON.stringify((await chatNodeByLocOrThrow(db, chatId)).data)).not.toContain(claude.id); // really ciphertext at rest
    const mine = await resolve(chatId); // the owner: an org admin and App member
    expect(mine.configId).toBe(claude.id);
    expect(mine.model).toBe('claude-sonnet');
    const peer = await db.user.create({ data: { handle: `peer-${generateId()}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: peer.id, role: 'ADMIN' } });
    const control = await Q.resolveAIConfig(null, { name: 'default', appRef: app.id }, ctx(peer)); // passes the outer gate: not a gate-order artefact
    expect(control.configId).toBe(dflt.id);
    const denied = await Q.resolveAIConfig(null, { name: 'default', appRef: app.id, chatId }, ctx(peer)).catch((e: any) => e);
    const unknown = await Q.resolveAIConfig(null, { name: 'default', appRef: app.id, chatId: 'chats:nope' }, ctx(peer)).catch((e: any) => e);
    expect(denied).toBeInstanceOf(Error);
    expect(denied.message.split(chatId).join('<c>')).toBe(unknown.message.split('chats:nope').join('<c>'));
    const text = JSON.stringify({ m: denied.message, x: denied.extensions });
    for (const secret of [KEY, claude.id, 'claude-sonnet', 'anthropic', '…3957']) expect(text).not.toContain(secret);
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

    it('with a chat the fallback is the `default` walk whatever name the caller sends (Atilla P2 on #3960)', async () => {
      await db.aiServiceConfig.create({ data: { appId: app.id, name: 'other-name', provider: 'glm', model: 'o', apiKeyEncrypted: encryptToken(KEY) } });
      const resolveNamed = (chatId: string) => Q.resolveAIConfig(null, { name: 'other-name', appRef: app.id, chatId }, ctx(admin));
      // a chat storing `default`
      const stored = await start({ aiConfigChoice: 'default' });
      expect((await resolveNamed(stored.chatId)).configId).toBe(dflt.id);
      // a chat with no usable pin (the pin is disabled)
      const pinned = await start({ aiConfigChoice: claude.id });
      await db.aiServiceConfig.update({ where: { id: claude.id }, data: { enabled: false } });
      expect((await resolveNamed(pinned.chatId)).configId).toBe(dflt.id);
      // a chat with no choice at all
      const none = await start({});
      expect((await resolveNamed(none.chatId)).configId).toBe(dflt.id);
      // without a chat the caller's name still counts, unchanged
      expect((await Q.resolveAIConfig(null, { name: 'other-name', appRef: app.id }, ctx(admin))).name).toBe('other-name');
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
