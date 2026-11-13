/** #4112 / cor:acl:010:01 system row: an App-less chat admits only an Agent manager, including on retained homes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

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

/** Transparent observer follows the resolver's client through interactive transactions and retains real query results. */
async function observe<T>(userId: string, run: (ctx: Context) => Promise<T>) {
  const protectedIds = [systemId, ...(await db.node.findMany({ where: { memoryId: systemId }, select: { id: true } })).map(n => n.id)];
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
    const sent = await observe(managerId, ctx => send(ctx, home));
    expect(sent.reads.length).toBeGreaterThan(0);
    const seen = await observe<any>(managerId, ctx => respond(ctx, home));
    expect(seen.value.conversationHandoff).toBe('next');
    expect(seen.reads.length).toBeGreaterThan(0);
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
