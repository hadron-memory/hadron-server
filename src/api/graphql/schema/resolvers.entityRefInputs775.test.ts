/**
 * #5080 (gap 2 of cor:api:140:01) — input-type fields that name an entity take `<entity>Ref`, an id or a URN.
 *
 * Held here, through a real ApolloServer so argument validation runs:
 *   1. createNode `memoryRef`: the PK and the URN both write; the old `memoryId` is an unknown input field.
 *   2. createTicker / updateTicker `channelRefs`: a chat-root node URN is accepted as well as the PK (red on main,
 *      where only the PK resolved); the ticker stores the resolved id; the old `channelIds` is refused.
 *   3. cor:api:140:02 parity: an unreadable channel, a missing channel and a malformed ref get the SAME refusal,
 *      worded alike for an id and for a URN.
 *   4. the old names of the other renamed input fields are unknown input fields (the SDL guard in
 *      resolvers.refArgSchema.test.ts holds the full list; these are the wire-level refusals).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
type Answer = { data: any; error: { message: string; code: unknown } | null };
async function ask(c: Context, query: string, variables: Record<string, unknown> = {}): Promise<Answer> {
  const res = await server.executeOperation({ query, variables }, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  return { data: data ?? null, error: e ? { message: e.message, code: e.extensions?.code } : null };
}
const ctxOf = (userId: string, roles: string[] = ['READER']): Context => ({ db, userId, roles } as Context);

let orgUrn: string;
let member: { id: string };
let outsider: { id: string };
let appId: string;
let knowledge: { id: string; urn: string };
let channel: { id: string; rootUrn: string };
let hidden: { id: string; rootUrn: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = generateId().slice(-8);
  const org = await db.organization.create({ data: { id: generateId(), name: `ri-${t}`, urn: `ri-${t}.example` } });
  orgUrn = org.urn;
  const user = (tag: string) => db.user.create({ data: { id: generateId(), handle: `ri${tag}${t}`, roles: ['READER'] }, select: { id: true } });
  member = await user('m');
  outsider = await user('o');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } })).id;
  await db.appMember.create({ data: { appId, userId: member.id, role: 'owner' } });
  knowledge = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:know`, name: 'know', class: 'knowledge' },
    select: { id: true, urn: true },
  });
  const personal = (u: { id: string }, tag: string) => db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${tag}`, name: tag, class: 'personal', userId: u.id, visibility: null },
  });
  const [mine, theirs] = [await personal(member, 'mine'), await personal(outsider, 'theirs')];
  const mk = async (memoryId: string, tag: string, by: string) => {
    const made = await ensureChannelWithRoot(db, { memoryId, loc: `chats:${tag}`, name: tag, createdBy: by });
    return { id: made.channel.id, rootUrn: `hrn:node:${org.urn}:${memoryId === mine.id ? 'mine' : 'theirs'}:chats:${tag}` };
  };
  channel = await mk(mine.id, 'a', member.id);
  hidden = await mk(theirs.id, 'b', outsider.id);
});

const CREATE_NODE = 'mutation($i:CreateNodeInput!){createNode(input:$i){id loc}}';
const CREATE_TICKER = 'mutation($a:String!,$i:TickerInput!){createTicker(appRef:$a,input:$i){id}}';
const UPDATE_TICKER = 'mutation($r:String!,$i:TickerPatch!){updateTicker(ref:$r,input:$i){id}}';
const stored = async (tickerId: string) => (await db.ticker.findUniqueOrThrow({ where: { id: tickerId } })).channelIds;

describe('1. createNode memoryRef', () => {
  it('writes through the PK and through the URN, and refuses the old memoryId as an unknown field', async () => {
    const byPk = await ask(ctxOf(member.id, ['ADMIN']), CREATE_NODE, { i: { memoryRef: knowledge.id, loc: 'pk:one', name: 'one' } });
    expect(byPk.error).toBeNull();
    const byUrn = await ask(ctxOf(member.id, ['ADMIN']), CREATE_NODE, { i: { memoryRef: knowledge.urn, loc: 'urn:two', name: 'two' } });
    expect(byUrn.error).toBeNull();
    expect(await db.node.count({ where: { memoryId: knowledge.id, loc: { in: ['pk:one', 'urn:two'] } } })).toBe(2);
    const old = await ask(ctxOf(member.id, ['ADMIN']), CREATE_NODE, { i: { memoryId: knowledge.id, loc: 'old:three', name: 'three' } });
    expect(old.error?.code).toBe('BAD_USER_INPUT');
    expect(await db.node.count({ where: { memoryId: knowledge.id, loc: 'old:three' } })).toBe(0);
  });
});

describe('2. ticker channelRefs', () => {
  it('createTicker takes a chat-root URN and a PK alike and stores the resolved id', async () => {
    const byUrn = await ask(ctxOf(member.id), CREATE_TICKER, { a: appId, i: { name: 'ByUrn', cadenceSeconds: 600, channelRefs: [channel.rootUrn] } });
    expect(byUrn.error).toBeNull();
    expect(await stored(byUrn.data.createTicker.id)).toEqual([channel.id]);
    const byPk = await ask(ctxOf(member.id), CREATE_TICKER, { a: appId, i: { name: 'ByPk', cadenceSeconds: 600, channelRefs: [channel.id] } });
    expect(byPk.error).toBeNull();
    expect(await stored(byPk.data.createTicker.id)).toEqual([channel.id]);
  });

  it('updateTicker takes the URN, de-duplicates an id and its URN, and the empty list clears', async () => {
    const made = await ask(ctxOf(member.id), CREATE_TICKER, { a: appId, i: { name: 'Upd', cadenceSeconds: 600 } });
    const id = made.data.createTicker.id as string;
    const set = await ask(ctxOf(member.id), UPDATE_TICKER, { r: id, i: { channelRefs: [channel.rootUrn, channel.id] } });
    expect(set.error).toBeNull();
    expect(await stored(id)).toEqual([channel.id]);
    const cleared = await ask(ctxOf(member.id), UPDATE_TICKER, { r: id, i: { channelRefs: [] } });
    expect(cleared.error).toBeNull();
    expect(await stored(id)).toEqual([]);
  });

  it('the old channelIds is an unknown input field on both inputs', async () => {
    const c = await ask(ctxOf(member.id), CREATE_TICKER, { a: appId, i: { name: 'Old', cadenceSeconds: 600, channelIds: [channel.id] } });
    expect(c.error?.code).toBe('BAD_USER_INPUT');
    const made = await ask(ctxOf(member.id), CREATE_TICKER, { a: appId, i: { name: 'Old2', cadenceSeconds: 600 } });
    const u = await ask(ctxOf(member.id), UPDATE_TICKER, { r: made.data.createTicker.id, i: { channelIds: [channel.id] } });
    expect(u.error?.code).toBe('BAD_USER_INPUT');
  });
});

describe('3. channelRefs refusals do not tell an unreadable channel from a missing or malformed one', () => {
  it('one refusal, one wording, for an id and for a URN', async () => {
    const refs = [
      hidden.id, hidden.rootUrn,                                   // exists, caller cannot read it
      generateId(), `hrn:node:${orgUrn}:mine:chats:missing`,       // does not exist
      'not a ref at all',                                          // malformed
    ];
    const answers = [];
    for (const r of refs) {
      answers.push(await ask(ctxOf(member.id), CREATE_TICKER, { a: appId, i: { name: `x${answers.length}`, cadenceSeconds: 600, channelRefs: [r] } }));
    }
    for (const a of answers) expect(a.error).toEqual(answers[0]!.error);
    expect(answers[0]!.error?.code).toBe('BAD_USER_INPUT');
    expect(await db.ticker.count({ where: { appId } })).toBe(0);
  });

  it('a readable ref beside an unreadable one refuses the whole list and writes nothing', async () => {
    const a = await ask(ctxOf(member.id), CREATE_TICKER, { a: appId, i: { name: 'Mixed', cadenceSeconds: 600, channelRefs: [channel.rootUrn, hidden.rootUrn] } });
    expect(a.error?.code).toBe('BAD_USER_INPUT');
    expect(await db.ticker.count({ where: { appId } })).toBe(0);
  });
});

describe('4. the old names of the other renamed input fields are unknown input fields', () => {
  it.each([
    ['createNode memoryId', CREATE_NODE, { i: { memoryId: 'x', loc: 'x', name: 'x' } }],
    ['updateNode id', 'mutation($i:UpdateNodeInput!){updateNode(input:$i){id}}', { i: { id: 'x', name: 'x' } }],
    ['createAgentTask parentTaskId', 'mutation($i:CreateAgentTaskInput!){createAgentTask(input:$i){id}}', { i: { title: 't', parentTaskId: 'x' } }],
    ['searchReplaceInNodes nodeIds', 'mutation($i:SearchReplaceInNodesInput!){searchReplaceInNodes(input:$i){nodesChanged}}', { i: { oldText: 'a', newText: 'b', nodeIds: ['x'], fields: ['content'] } }],
  ])('%s', async (_label, query, variables) => {
    const a = await ask(ctxOf(member.id, ['ADMIN']), query as string, variables as Record<string, unknown>);
    expect(a.error?.code).toBe('BAD_USER_INPUT');
    expect(a.error?.message).toMatch(/not defined by type|Field .* is not defined|Unknown|Variable/i);
  });
});
