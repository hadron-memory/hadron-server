/**
 * #2862 (cor:agt:040:03) — the record-only read keyed by chat id, `Query.chatServedPrompts(chatId)`: the manager of the
 * App named by the chat's FIRST record reads that App's records, and nobody else reads anything (an explicit empty page,
 * never a refusal). It is the same implementation as `Chat.servedPrompts`, so the two are held to one answer by a
 * differential over every caller shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { buildSchema } from 'graphql';

const R = resolvers as any;
const EMPTY = { items: [], total: 0 };

describe('#2862 — Query.chatServedPrompts', () => {
  let appId: string;
  let otherAppId: string;
  let orgId: string;
  let chatId: string;
  let noAppChatId: string;
  let compiledNodeId: string;
  let agentId: string;
  const u: Record<string, string> = {};
  const before = process.env.BOOT_PROMPT_SERVE_ENABLED;

  const user = async (tag: string, roles: string[] = ['READER']) =>
    (await db.user.create({ data: { id: generateId(), githubId: Math.floor(Math.random() * 1e9), githubUsername: `c2862-${tag}-${generateId().slice(0, 6)}`, roles: roles as never } })).id;
  const ctxFor = (who: string, extra: Partial<Context> = {}): Context => ({ db, userId: u[who], roles: ['READER'], ...extra });
  const query = (who: string, id = chatId, args: Record<string, unknown> = {}, extra: Partial<Context> = {}) =>
    R.Query.chatServedPrompts({}, { chatId: id, ...args }, ctxFor(who, extra));
  const field = (who: string, id = chatId, args: Record<string, unknown> = {}, extra: Partial<Context> = {}) =>
    R.Chat.servedPrompts({ id }, args, ctxFor(who, extra));

  const record = (over: Record<string, unknown>) =>
    db.servedPrompt.create({
      data: { kind: 'CHAT', agentId, pointerLevel: 'AGENT', compiledNodeId, servedRevSeq: 3, provenanceRevSeq: 2, compiledContentHash: 'h', ...over } as never,
    });

  beforeEach(async () => {
    process.env.BOOT_PROMPT_SERVE_ENABLED = 'true';
    await cleanDb(db);
    const { org, graph } = await createDbOrgAndGraph(db, { orgName: `c2862-${generateId().slice(0, 8)}` });
    orgId = org.id;
    for (const who of ['manager', 'enduser', 'otherManager', 'stranger']) u[who] = await user(who);
    u.admin = await user('admin', ['ADMIN']);
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.manager!, role: 'ADMIN' } });
    agentId = (await db.agent.create({ data: { id: generateId(), name: 'A', organizationId: org.id, urn: `${org.urn}:a` } as never })).id;
    appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:t` } })).id;
    await db.appMember.create({ data: { appId, userId: u.enduser!, role: 'cook' } });
    const otherOrg = (await createDbOrgAndGraph(db, { orgName: `c2862o-${generateId().slice(0, 8)}` })).org;
    otherAppId = (await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'O', urn: `${otherOrg.urn}:o` } })).id;
    await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: u.otherManager!, role: 'ADMIN' } });
    chatId = (await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'chats:one', name: 'chat', ownerRepo: 'r' } as never })).id;
    noAppChatId = (await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'chats:two', name: 'chat2', ownerRepo: 'r' } as never })).id;
    compiledNodeId = (await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'boot:compiled', name: 'compiled', ownerRepo: 'r', revSeq: 3 } as never })).id;
    for (const ordinal of [1, 2, 3]) await record({ chatId, ordinal, appId });
    await record({ chatId, ordinal: 4, appId: otherAppId });
    await record({ chatId: noAppChatId, ordinal: 1, appId: null });
  });

  afterEach(() => {
    if (before === undefined) delete process.env.BOOT_PROMPT_SERVE_ENABLED;
    else process.env.BOOT_PROMPT_SERVE_ENABLED = before;
  });

  it('is a top-level query taking chatId, with the field\'s paging, returning the records page', async () => {
    expect(R.Query.chatServedPrompts, 'Query.chatServedPrompts must exist').toBeTypeOf('function');
  });

  it('the App manager, who is not the chat\'s user, reads its records newest first, with the field\'s paging', async () => {
    const page = await query('manager');
    expect(page.total).toBe(3);
    expect(page.items.map((r: { ordinal: number }) => r.ordinal)).toEqual([3, 2, 1]);
    const p = await query('manager', chatId, { limit: 2, offset: 2 });
    expect(p.items).toHaveLength(1);
    expect(p.total).toBe(3);
  });

  it('the chat\'s end user who does not manage the App gets an empty page', async () => {
    expect(await query('enduser')).toEqual(EMPTY);
  });

  it('a manager of a different App gets an empty page, and never sees the records the chat has under that App', async () => {
    expect(await query('otherManager')).toEqual(EMPTY);
    const page = await query('manager');
    expect(page.items.every((r: { appId: string }) => r.appId === appId)).toBe(true);
    expect(page.items.some((r: { appId: string }) => r.appId === otherAppId)).toBe(false);
  });

  it('records under a second App are never returned, even to that second App\'s manager', async () => {
    expect(await query('otherManager')).toEqual(EMPTY);
  });

  it('a stranger gets an empty page', async () => {
    expect(await query('stranger')).toEqual(EMPTY);
  });

  it('a no-App chat: a platform admin reads it; an impersonating admin and every other caller get an empty page', async () => {
    const page = await query('admin', noAppChatId, {}, { roles: ['ADMIN'] });
    expect(page.total).toBe(1);
    expect(await query('admin', noAppChatId, {}, { roles: ['ADMIN'], impersonation: { sessionId: 'x' } as never })).toEqual(EMPTY);
    for (const who of ['manager', 'enduser', 'otherManager', 'stranger']) expect(await query(who, noAppChatId)).toEqual(EMPTY);
  });

  it('an unknown chat id and serving switched off are empty pages, never errors', async () => {
    expect(await query('manager', generateId())).toEqual(EMPTY);
    delete process.env.BOOT_PROMPT_SERVE_ENABLED;
    expect(await query('manager')).toEqual(EMPTY);
  });

  it('a deleted App\'s chat records read as empty even to its manager', async () => {
    await db.app.update({ where: { id: appId }, data: { deletedAt: new Date() } });
    expect(await query('manager')).toEqual(EMPTY);
  });

  it('differential: for the same caller and chat the query and Chat.servedPrompts return the same page', async () => {
    const shapes: Array<[string, string, Record<string, unknown>, Partial<Context>]> = [
      ['manager', chatId, {}, {}],
      ['manager', chatId, { limit: 2, offset: 1 }, {}],
      ['manager', chatId, { limit: 0 }, {}],
      ['enduser', chatId, {}, {}],
      ['otherManager', chatId, {}, {}],
      ['stranger', chatId, {}, {}],
      ['admin', noAppChatId, {}, { roles: ['ADMIN'] }],
      ['admin', noAppChatId, {}, { roles: ['ADMIN'], impersonation: { sessionId: 'x' } as never }],
      ['manager', noAppChatId, {}, {}],
      ['manager', generateId(), {}, {}],
    ];
    for (const [who, id, args, extra] of shapes) {
      expect(await query(who, id, args, extra), `${who} ${JSON.stringify(args)} ${JSON.stringify(extra)}`).toEqual(await field(who, id, args, extra));
    }
  });

  it('is in the schema as a Query returning ServedPromptsPage, with chatId and paging args and no Chat in its return type', () => {
    const f = buildSchema(typeDefs).getQueryType()!.getFields().chatServedPrompts;
    expect(f, 'schema field chatServedPrompts').toBeDefined();
    expect(String(f!.type)).toBe('ServedPromptsPage!');
    expect(f!.args.map((a) => `${a.name}:${a.type}`)).toEqual(['chatId:ID!', 'limit:Int', 'offset:Int']);
  });
});
