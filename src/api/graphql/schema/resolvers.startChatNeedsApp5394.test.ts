/**
 * #5394 PR 1 (hrn:node:hadronmemory.com:specs:cor:cht:010:02; Holger 2026-11-27, decisions:2026-11-27-holger-rulings-to-victor-
 * startchat-needs-app item 3): "startChat needs to know which app supplies the chatbot logic and saves the chat. If the
 * credentials name that app, great. If not, the global --app can be used to specify the app. If the app is not identified,
 * startChat should fail loudly. No hunting for a possible match searching for an app."
 *
 * The App is the credential's (`ctx.appId`) or the one the request names (`appRef`); nothing else. Pins, red on main 13cd1c30:
 *   - no App identified: CHAT_APP_NOT_IDENTIFIED on both scopes, before the Agent gate (an unknown Agent gets it too),
 *     with no memory, node or subscription written;
 *   - a named App is the App: no search picks another one, and an existing home of another App is not reused;
 *   - a named App the caller does not take part in reads exactly like an App that does not exist;
 *   - a named App that differs from the credential's is refused the same way;
 *   - a shared chat runs under the identified App, including an App credential (SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS
 *     is retired);
 *   - the no-App knowledge home is never provisioned or reused again: an Agent manager naming an App that does not
 *     install the Agent gets the unknown-Agent refusal, as any other caller does.
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let orgId: string, orgUrn: string, agentId: string, appA: string, appB: string, appAUrn: string, appBUrn: string;
let ann: string, adminId: string, outsiderApp: string;
const as = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra } as Context);
const adminCtx = (extra: Partial<Context> = {}): Context => ({ db, userId: adminId, roles: ['ADMIN'], ...extra } as Context);

const seedFlow = async (memoryId: string) => {
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: 'NEEDS APP STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId, name: row.loc, nodeType: 'system', ...row } });
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Needs app', urn: 'chat5394.test' } });
  orgId = org.id; orgUrn = org.urn;
  adminId = (await db.user.create({ data: { handle: 'admin5394' } })).id;
  ann = (await db.user.create({ data: { handle: 'ann5394' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: ann, role: 'READER' } });
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Needs app agent', visibility: 'ORGANIZATION' }, adminCtx());
  agentId = agent.id;
  await seedFlow(agent.systemMemoryId);
  // Two Apps install the Agent and ann belongs to both. B gets the larger id, so main's search (id order) picks A.
  const made = [];
  for (const slug of ['tutor-one', 'tutor-two']) made.push(await db.app.create({ data: { name: slug, urn: `${orgUrn}:${slug}`, organizationId: orgId } }));
  made.sort((x, y) => (x.id < y.id ? -1 : 1));
  [appA, appB] = [made[0].id, made[1].id];
  [appAUrn, appBUrn] = [made[0].urn, made[1].urn];
  for (const app of [appA, appB]) {
    await db.appAgent.create({ data: { appId: app, agentId } });
    await db.appMember.create({ data: { appId: app, userId: ann, role: 'member' } });
  }
  // An App of the same org that installs the Agent, which ann has no part in (she is only an org READER).
  outsiderApp = (await db.app.create({ data: { name: 'Other', urn: `${orgUrn}:other`, organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId: outsiderApp, agentId } });
  await serveEveryAgent(db);
});

const counts = async () => ({
  memories: await db.memory.count(),
  nodes: await db.node.count(),
  subscriptions: await db.agentSubscription.count(),
});
const homeOf = async (chatId: string) => (await chatNodeByLocOrThrow(db, chatId)).memoryId as string;
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: any) => e);
  expect(err, 'expected a refusal').not.toBeNull();
  return { code: err.extensions?.code ?? err.code, message: err.message as string };
};

describe('#5394 no App identified: CHAT_APP_NOT_IDENTIFIED, loudly, before anything else', () => {
  it('private: a person with no App named is refused, although two of her Apps install the Agent; nothing is written', async () => {
    const before = await counts();
    const r = await refusal(M.startChat({}, { agentRef: agentId, conversationName: 'flow' }, as(ann)));
    expect(r.code).toBe('CHAT_APP_NOT_IDENTIFIED');
    expect(r.message).toMatch(/--app/);
    expect(await counts()).toEqual(before);
  });

  it('shared: a person with no App named is refused, although she is an AppMember of an App that installs it; nothing is written', async () => {
    const before = await counts();
    const r = await refusal(M.startChat({}, { agentRef: agentId, conversationName: 'flow', scope: 'shared' }, as(ann)));
    expect(r.code).toBe('CHAT_APP_NOT_IDENTIFIED');
    expect(await counts()).toEqual(before);
  });

  it('the refusal comes before the Agent gate: an unknown Agent and a known one get the same answer', async () => {
    const known = await refusal(M.startChat({}, { agentRef: agentId }, as(ann)));
    const unknown = await refusal(M.startChat({}, { agentRef: 'hrn:agent:chat5394.test:nobody' }, as(ann)));
    const malformed = await refusal(M.startChat({}, { agentRef: 'not a ref' }, as(ann)));
    expect(unknown).toEqual(known);
    expect(malformed).toEqual(known);
  });

  it('an Agent manager gets no no-App knowledge home: refused, and no memory is provisioned', async () => {
    const solo = await M.createAgent({}, { orgRef: orgId, name: 'Solo agent', visibility: 'ORGANIZATION' }, adminCtx());
    await seedFlow(solo.systemMemoryId);
    await serveEveryAgent(db);
    const before = await counts();
    const r = await refusal(M.startChat({}, { agentRef: solo.id, conversationName: 'flow' }, adminCtx()));
    expect(r.code).toBe('CHAT_APP_NOT_IDENTIFIED');
    expect(await counts()).toEqual(before);
  });
});

describe('#5394 the named App is the App: no search', () => {
  it('appRef names the App whose personal home is used, never the first App a search finds', async () => {
    const started = await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appB }, as(ann));
    const row = await db.memory.findUniqueOrThrow({ where: { id: await homeOf(started.chatId) } });
    expect({ class: row.class, userId: row.userId, appId: row.appId }).toEqual({ class: 'personal', userId: ann, appId: appB });
  });

  it('appRef accepts the App URN', async () => {
    const started = await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appBUrn }, as(ann));
    expect((await db.memory.findUniqueOrThrow({ where: { id: await homeOf(started.chatId) } })).appId).toBe(appB);
  });

  it('an existing home of another App is not reused for the identified App', async () => {
    const inA = await homeOf((await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appAUrn }, as(ann))).chatId);
    expect((await db.memory.findUniqueOrThrow({ where: { id: inA } })).appId).toBe(appA);
    const inB = await homeOf((await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appB }, as(ann))).chatId);
    expect(inB).not.toBe(inA);
    expect((await db.memory.findUniqueOrThrow({ where: { id: inB } })).appId).toBe(appB);
    // and A's home is found again for A
    expect(await homeOf((await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appA }, as(ann))).chatId)).toBe(inA);
  });

  it('a stamped no-App knowledge home is never reused, even with an App identified', async () => {
    const legacy = await db.memory.create({ data: {
      organizationId: orgId, urn: `${orgUrn}:legacy-holding`, name: 'legacy', class: 'knowledge', visibility: 'ORGANIZATION',
      userMemoryOfAgentId: agentId, createdBy: ann,
    } });
    const home = await homeOf((await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appA }, as(ann))).chatId);
    expect(home).not.toBe(legacy.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: home } })).appId).toBe(appA);
  });

  it('an Agent manager naming an App that does not install the Agent gets the unknown-Agent refusal, and no knowledge home', async () => {
    const solo = await M.createAgent({}, { orgRef: orgId, name: 'Solo agent', visibility: 'ORGANIZATION' }, adminCtx());
    await seedFlow(solo.systemMemoryId);
    await serveEveryAgent(db);
    await db.appMember.create({ data: { appId: appA, userId: adminId, role: 'member' } });
    const before = await counts();
    const r = await refusal(M.startChat({}, { agentRef: solo.id, conversationName: 'flow', appRef: appA }, adminCtx()));
    expect(r.code).toBe('AGENT_NOT_FOUND');
    expect(await counts()).toEqual(before);
  });
});

// Gate amendment (Xan, team chat #154443, condition 3): a named App the caller cannot take part in, or that does not exist,
// answers byte-identically with the participation refusal (no App-existence oracle), not CHAT_APP_NOT_IDENTIFIED.
describe('#5394 a named App the caller cannot use answers the participation refusal, and says nothing about the App', () => {
  it('private: an App she takes no part in reads exactly like an App that does not exist; nothing is written', async () => {
    const before = await counts();
    const foreign = await refusal(M.startChat({}, { agentRef: agentId, appRef: outsiderApp }, as(ann)));
    const missing = await refusal(M.startChat({}, { agentRef: agentId, appRef: `${orgUrn}:nothing` }, as(ann)));
    const missingId = await refusal(M.startChat({}, { agentRef: agentId, appRef: '01a21c9fc8347fd79b5ed7a483b75c91' }, as(ann)));
    const malformed = await refusal(M.startChat({}, { agentRef: agentId, appRef: 'not a ref' }, as(ann)));
    expect(foreign).toEqual({ code: 'AGENT_NOT_FOUND', message: 'AGENT_NOT_FOUND: nothing found for the given ref.' });
    expect(missing).toEqual(foreign);
    expect(missingId).toEqual(foreign);
    expect(malformed).toEqual(foreign);
    expect(await counts()).toEqual(before);
  });

  it('shared: the same, with the shared participation refusal', async () => {
    const before = await counts();
    const foreign = await refusal(M.startChat({}, { agentRef: agentId, scope: 'shared', appRef: outsiderApp }, as(ann)));
    const missing = await refusal(M.startChat({}, { agentRef: agentId, scope: 'shared', appRef: `${orgUrn}:nothing` }, as(ann)));
    const malformed = await refusal(M.startChat({}, { agentRef: agentId, scope: 'shared', appRef: 'not a ref' }, as(ann)));
    expect(foreign.code).toBe('SHARED_CHAT_REQUIRES_APP_CONTEXT');
    expect(missing).toEqual(foreign);
    expect(malformed).toEqual(foreign);
    expect(await counts()).toEqual(before);
  });

  it('an appRef that differs from the credential\'s App is refused the same way', async () => {
    const r = await refusal(M.startChat({}, { agentRef: agentId, appRef: appB }, as(ann, { appId: appA })));
    expect(r.code).toBe('CHAT_APP_NOT_IDENTIFIED');
    // naming the credential's own App is fine
    const ok = await M.startChat({}, { agentRef: agentId, conversationName: 'flow', appRef: appA }, as(ann, { appId: appA }));
    expect((await db.memory.findUniqueOrThrow({ where: { id: await homeOf(ok.chatId) } })).appId).toBe(appA);
  });
});

describe('#5394 shared chats run under the identified App', () => {
  it('a credential carrying an App now starts a shared chat in that App (SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS is retired)', async () => {
    const started = await M.startChat({}, { agentRef: agentId, conversationName: 'flow', scope: 'shared' }, as(ann, { appId: appB }));
    const row = await db.memory.findUniqueOrThrow({ where: { id: await homeOf(started.chatId) } });
    expect({ class: row.class, appId: row.appId }).toEqual({ class: 'app', appId: appB });
  });

  it('a person naming the App starts the shared chat in that App, not the first one a search finds', async () => {
    const started = await M.startChat({}, { agentRef: agentId, conversationName: 'flow', scope: 'shared', appRef: appB }, as(ann));
    expect((await db.memory.findUniqueOrThrow({ where: { id: await homeOf(started.chatId) } })).appId).toBe(appB);
  });

  it('a pure App-key session starts a shared chat for its session user in its App', async () => {
    const appKey = (sessionId?: string) => ({ db, appId: appB, roles: [], ...(sessionId ? { sessionId } : {}) }) as unknown as Context;
    await db.app.update({ where: { id: appB }, data: { createUserPermission: 'EXPLICIT' } });
    await M.createAppUser({}, { externalId: 'ext-5394' }, appKey());
    const session = await M.startAgentSession({}, { agentRef: agentId, externalUserId: 'ext-5394' }, appKey());
    const sessionId: string = session.sessionId ?? session.session?.id ?? session.id;
    const started = await M.startChat({}, { agentRef: agentId, conversationName: 'flow', scope: 'shared' }, appKey(sessionId));
    const row = await db.memory.findUniqueOrThrow({ where: { id: await homeOf(started.chatId) } });
    expect({ class: row.class, appId: row.appId }).toEqual({ class: 'app', appId: appB });
  });

  it('a shared start naming an App she is a member of that does not install the Agent keeps its existing refusal', async () => {
    const bare = await db.app.create({ data: { name: 'Bare', urn: `${orgUrn}:bare`, organizationId: orgId } });
    await db.appMember.create({ data: { appId: bare.id, userId: ann, role: 'member' } });
    const before = await counts();
    const r = await refusal(M.startChat({}, { agentRef: agentId, scope: 'shared', appRef: bare.id }, as(ann)));
    expect(r.code).toBe('SHARED_CHAT_REQUIRES_APP_CONTEXT');
    expect(await counts()).toEqual(before);
  });
});

describe('#5394 the GraphQL surface', () => {
  it('startChat takes appRef and the refusal reaches the wire with its code', async () => {
    const api = new ApolloServer<Context>({ typeDefs, resolvers });
    const exec = async (variables: Record<string, unknown>) => {
      const r = await api.executeOperation({
        query: 'mutation($agentRef: ID!, $appRef: ID) { startChat(agentRef: $agentRef, conversationName: "flow", appRef: $appRef) { chatId } }',
        variables,
      }, { contextValue: as(ann) });
      return r.body.kind === 'single' ? r.body.singleResult : null;
    };
    const refused = await exec({ agentRef: agentId });
    expect(refused?.errors?.[0]?.extensions?.code).toBe('CHAT_APP_NOT_IDENTIFIED');
    const ok = await exec({ agentRef: agentId, appRef: appA });
    expect(ok?.errors).toBeUndefined();
    expect((ok?.data as any)?.startChat?.chatId).toBeTruthy();
  });
});
