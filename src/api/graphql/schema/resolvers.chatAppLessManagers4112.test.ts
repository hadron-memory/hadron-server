/** #4112 / cor:acl:010:01 system row: an App-less chat admits only an Agent manager, including on retained homes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { chatHomeAgentIfLicensed, refuseUnreachableChatHomeAgent } from '../../../lib/chatHomeAgent.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
let managerId: string, consumerId: string, agentOrgId: string, agentId: string, systemId: string, appId: string;
const context = (userId: string, client: typeof db = db): Context => ({ db: client, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Definition owners', urn: 'managers4112.agent' } });
  agentOrgId = org.id;
  managerId = (await db.user.create({ data: { handle: 'managers4112-manager' } })).id;
  consumerId = (await db.user.create({ data: { handle: 'managers4112-consumer' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: managerId, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Managed definition', visibility: 'PUBLIC' }, context(managerId));
  agentId = agent.id; systemId = agent.systemMemoryId;
  const carrier = await db.organization.create({ data: { name: 'Licensed carrier', urn: 'managers4112.carrier' } });
  const app = await db.app.create({ data: { organizationId: carrier.id, name: 'Licensed App', urn: `${carrier.urn}:app` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.agentOrgGrant.create({ data: { orgId: carrier.id, agentId, activatedAt: new Date() } });
  await db.appMember.create({ data: { appId, userId: consumerId, role: 'member' } });
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'conversations:next', data: { stageOrder: ['next'] } },
    { loc: 'conversations:next:next', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: 'PROTECTED MANAGER STAGE', data: {} },
    { loc: 'config', data: { privateConfig: 'PROTECTED CONFIG' } },
  ]) await db.node.create({ data: { memoryId: systemId, name: row.loc, nodeType: 'system', ...row } });
  const source = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: systemId, loc: 'conversations:flow:step' } } });
  const target = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: systemId, loc: 'conversations:next' } } });
  await db.edge.create({ data: { memoryId: systemId, sourceId: source.id, targetId: target.id, loc: 'complete', name: 'complete', data: { timing: 'on_complete' } } });
  await serveEveryAgent(db);
});

type Home = { chatId: string; memoryId: string; rootId: string };
async function start(userId: string): Promise<Home> {
  const out = await M.startChat({}, { agentId, scope: 'private', conversationName: 'flow' }, context(userId));
  const root = await chatNodeByLocOrThrow(db, out.chatId);
  return { chatId: out.chatId, memoryId: root.memoryId, rootId: root.id };
}
/** Model a pre-4095 retained home without changing its chat contents or caller's ownership. */
async function legacy(reach: 'PUBLIC' | 'READER'): Promise<Home> {
  const home = await start(consumerId);
  await db.memory.update({ where: { id: home.memoryId }, data: { appId: null } });
  if (reach === 'READER') {
    await db.agent.update({ where: { id: agentId }, data: { visibility: 'ORGANIZATION' } });
    await db.orgMember.create({ data: { organizationId: agentOrgId, userId: consumerId, role: 'READER' } });
  }
  return home;
}
async function demoted(): Promise<Home> {
  // The manager has no App carrier; this must be a lawful standalone start, not a detached licensed start.
  const home = await start(managerId);
  expect((await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } })).appId).toBeNull();
  await db.orgMember.update({ where: { organizationId_userId: { organizationId: agentOrgId, userId: managerId } }, data: { role: 'READER' } });
  return home;
}

/** Transparent observer follows the resolver's client through interactive transactions and retains real query results.
 * Its limit (#4120): it records only an explicit protected-ID detector, a Node/NodeRevision/Edge find/count/aggregate/groupBy
 * call whose arguments mention a protected id, or a raw query that does. It does NOT audit every relation-filter read or
 * every delegate projection (a read that reaches protected rows through another model's `include`/`select`/relation
 * filter is not seen). An empty `reads` therefore pins "none of those explicit reads", never "no protected read at all". */
async function observe<T>(userId: string, run: (ctx: Context) => Promise<T>, protectedMemoryId = systemId) {
  const protectedIds = [protectedMemoryId, ...(await db.node.findMany({ where: { memoryId: protectedMemoryId }, select: { id: true } })).map(n => n.id)];
  const reads: string[] = [];
  const read = /^(find|count|aggregate|groupBy)/;
  const track = (model: string, method: string, args: unknown[]) => {
    const encoded = JSON.stringify(args, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    if (protectedIds.some(id => encoded?.includes(id))) reads.push(`${model}.${method}`);
  };
  const wrap = (client: any): any => new Proxy(client, {
    get(target, key) {
      if (key === '$transaction') return (first: any, ...rest: any[]) =>
        target.$transaction(typeof first === 'function' ? (tx: any) => first(wrap(tx)) : first, ...rest);
      const value = Reflect.get(target, key, target);
      if (key === 'node' || key === 'nodeRevision' || key === 'edge') return new Proxy(value, {
        get(delegate, method) {
          const fn = Reflect.get(delegate, method, delegate);
          if (typeof fn !== 'function') return fn;
          return (...args: unknown[]) => { if (read.test(String(method))) track(String(key), String(method), args); return fn.apply(delegate, args); };
        },
      });
      if (key === '$queryRaw' || key === '$queryRawUnsafe') return (...args: unknown[]) => { track('$raw', String(key), args); return value.apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const value = await run(context(userId, wrap(db)));
  return { value, reads };
}
const send = (ctx: Context, home: Home) => M.sendChatMessage({}, { chatId: home.chatId, userMessage: 'continue' }, ctx);
const respond = (ctx: Context, home: Home) => M.processChatResponse({}, { chatId: home.chatId, toolResponse: { message: 'recorded answer', goal_reached: true, next_stage: null } }, ctx);
const messages = (home: Home) => db.node.count({ where: { memoryId: home.memoryId, loc: { startsWith: `${home.chatId}:messages:` } } });
async function errorOf(run: () => Promise<unknown>) {
  try { await run(); return null; } catch (error: any) { return { message: error.message, code: error.code, ref: error.ref, extensions: error.extensions }; }
}
/** A soft-deleted Agent is unknown under the same input ref (cor:dmo:010:04), exercising the real absent-Agent branch. */
async function unknownAgentError(home: Home, userId: string) {
  await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  return errorOf(() => send(context(userId), home));
}

describe('#4112 retained App-less turns require Agent management', () => {
  const scenarios = [
    ['legacy PUBLIC outsider', () => legacy('PUBLIC'), () => consumerId],
    ['legacy Agent-org READER', () => legacy('READER'), () => consumerId],
    ['lawful manager start then demotion', demoted, () => managerId],
  ] as const;
  for (const [name, setup, who] of scenarios) {
    it(`${name}: send conceals denial before protected reads and writes`, async () => {
      const home = await setup();
      const before = await messages(home);
      const seen = await observe(who(), ctx => errorOf(() => send(ctx, home)));
      expect(seen.value, 'a non-manager cannot send in the retained standalone home').toMatchObject({ code: 'AGENT_NOT_FOUND' });
      expect(seen.reads, 'no definition, config, revision or routing read before refusal').toEqual([]);
      expect(await messages(home)).toBe(before);
      expect(seen.value, 'same refusal as an unknown Agent, including message and extensions').toEqual(await unknownAgentError(home, who()));
    });
    it(`${name}: response records its turn without protected reads or Agent routing`, async () => {
      const home = await setup();
      const before = await messages(home);
      const seen = await observe(who(), ctx => respond(ctx, home));
      expect(seen.value).toMatchObject({ displayMessage: 'recorded answer', conversationHandoff: null, stageTransitioned: false, newStageName: null, chatEnded: false });
      expect(seen.reads, 'no system-memory or rule read after manager reach is lost').toEqual([]);
      expect(await messages(home), 'the permitted assistant response remains recorded exactly once').toBe(before + 1);
    });
  }

  it('a current Agent manager still sends and fires the rule in an App-less home (observer positive control)', async () => {
    const home = await start(managerId);
    expect((await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } })).appId).toBeNull();
    const beforeSend = await messages(home);
    const sent = await observe(managerId, ctx => send(ctx, home));
    expect(sent.reads.length).toBeGreaterThan(0);
    const afterSend = await messages(home);
    expect(afterSend - beforeSend, 'the send persists exactly one message in the owned home').toBe(1);
    const seen = await observe<any>(managerId, ctx => respond(ctx, home));
    expect(seen.value.conversationHandoff).toBe('next');
    expect(seen.reads.length).toBeGreaterThan(0);
    expect(await messages(home) - afterSend, 'the response persists exactly one message, separately from the send').toBe(1);
  });
  it('a licensed App home still admits the non-manager for send and response', async () => {
    const home = await start(consumerId);
    expect((await db.memory.findUniqueOrThrow({ where: { id: home.memoryId } })).appId).toBe(appId);
    const sent = await observe(consumerId, ctx => send(ctx, home));
    expect(sent.reads.length).toBeGreaterThan(0);
    const seen = await observe<any>(consumerId, ctx => respond(ctx, home));
    expect(seen.value.conversationHandoff).toBe('next');
    expect(seen.reads.length).toBeGreaterThan(0);
  });
});

describe('#4120 admission pins', () => {
  const adminCtx = (userId: string): Context => ({ db, userId, roles: ['ADMIN'] });

  it('an Agent with no system memory: the response helper returns none and the send helper refuses as an unknown Agent, even for a platform ADMIN (as-built defensive behaviour, not a ruled refusal)', async () => {
    const admin = await db.user.create({ data: { handle: 'managers4120-admin', roles: ['ADMIN'] } });
    const ctx = adminCtx(admin.id);
    const home = { appId: null };
    // The equivalent Agent WITH a matching live system memory: the same platform ADMIN manages it, so it is admitted.
    const withDefinition = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(withDefinition.systemMemoryId).toBe(systemId);
    expect((await chatHomeAgentIfLicensed(db, home, withDefinition, ctx))?.id).toBe(agentId);
    await expect(refuseUnreachableChatHomeAgent(db, home, withDefinition, ctx)).resolves.toBeUndefined();
    // A live Agent whose systemMemoryId is null has no definition to admit anyone to.
    const bare = await db.agent.create({ data: { name: 'No definition', urn: 'managers4120.bare', organizationId: agentOrgId, systemMemoryId: null } });
    expect(bare.deletedAt).toBeNull();
    expect(await chatHomeAgentIfLicensed(db, home, bare, ctx), 'no throw, no definition for this turn').toBeNull();
    const refusal = await errorOf(() => refuseUnreachableChatHomeAgent(db, home, bare, ctx));
    expect(refusal, 'the concealed unknown-Agent refusal').toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(refuseUnreachableChatHomeAgent(db, home, bare, ctx)).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  describe('a user-owned Agent', () => {
    let ownerId: string, strangerId: string, userAgentId: string, userSystemId: string;
    beforeEach(async () => {
      ownerId = (await db.user.create({ data: { handle: 'managers4120-owner' } })).id;
      strangerId = (await db.user.create({ data: { handle: 'managers4120-stranger' } })).id;
      const sys = await db.memory.create({ data: { class: 'system', name: 'owned definition', urn: 'managers4120.owned:sys', ownerUserId: ownerId } });
      const agent = await db.agent.create({ data: { name: 'Owned', urn: 'managers4120.owned', ownerUserId: ownerId, systemMemoryId: sys.id, visibility: 'PUBLIC' } });
      userAgentId = agent.id; userSystemId = sys.id;
      for (const row of [
        { loc: 'conversations', data: {} },
        { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
        { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
        { loc: 'conversations:next', data: { stageOrder: ['next'] } },
        { loc: 'conversations:next:next', data: { promptRef: 'prompts:step' } },
        { loc: 'prompts', data: {} },
        { loc: 'prompts:step', content: 'OWNED STAGE', data: {} },
      ]) await db.node.create({ data: { memoryId: sys.id, name: row.loc, nodeType: 'system', ...row } });
      const source = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: sys.id, loc: 'conversations:flow:step' } } });
      const target = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: sys.id, loc: 'conversations:next' } } });
      await db.edge.create({ data: { memoryId: sys.id, sourceId: source.id, targetId: target.id, loc: 'complete', name: 'complete', data: { timing: 'on_complete' } } });
      await serveEveryAgent(db);
    });
    /** Cold lazy provisioning of a user-owned Agent's home is unsupported, so graft an existing personal home (class personal,
     * strictly owned by `userId`) onto it and detach it from its App: a historical App-less home. */
    async function ownedHome(userId: string): Promise<Home> {
      await db.appMember.create({ data: { appId, userId, role: 'member' } });
      const home = await start(userId);
      await db.memory.update({ where: { id: home.memoryId }, data: { appId: null, userMemoryOfAgentId: userAgentId } });
      return home;
    }

    it('its owner (ordinary READER role, no org membership) is admitted on send and response; a non-owner is refused the send and the response records without routing', async () => {
      const agentRow = await db.agent.findUniqueOrThrow({ where: { id: userAgentId } });
      expect(agentRow.organizationId).toBeNull();
      const ownerHome = await ownedHome(ownerId);
      expect((await db.memory.findUniqueOrThrow({ where: { id: ownerHome.memoryId } })).appId).toBeNull();
      expect((await chatHomeAgentIfLicensed(db, { appId: null }, agentRow, context(ownerId)))?.id).toBe(userAgentId);
      const beforeSend = await messages(ownerHome);
      const sent = await observe(ownerId, ctx => send(ctx, ownerHome), userSystemId);
      expect(sent.reads.length).toBeGreaterThan(0);
      expect(await messages(ownerHome)).toBe(beforeSend + 1);
      const answered = await observe<any>(ownerId, ctx => respond(ctx, ownerHome), userSystemId);
      expect(answered.value.conversationHandoff).toBe('next');
      expect(answered.reads.length).toBeGreaterThan(0);

      const strangerHome = await ownedHome(strangerId);
      expect(await chatHomeAgentIfLicensed(db, { appId: null }, agentRow, context(strangerId))).toBeNull();
      const before = await messages(strangerHome);
      const refused = await observe(strangerId, ctx => errorOf(() => send(ctx, strangerHome)), userSystemId);
      expect(refused.value).toMatchObject({ code: 'AGENT_NOT_FOUND' });
      expect(refused.reads).toEqual([]);
      expect(await messages(strangerHome)).toBe(before);
      const recorded = await observe<any>(strangerId, ctx => respond(ctx, strangerHome), userSystemId);
      expect(recorded.value).toMatchObject({ displayMessage: 'recorded answer', conversationHandoff: null, stageTransitioned: false });
      expect(recorded.reads).toEqual([]);
      expect(await messages(strangerHome)).toBe(before + 1);
    });
  });
});
