/**
 * #3405 (cor:cht:020:01 step 1, ruling 0127): an unnamed `startChat` opens a
 * deterministic conversation: the first ordinary top-level conversation
 * (neither setup nor fallback) by `loc` in code-unit order, else setup, else
 * fallback, else the existing AGENT_HAS_NO_CONVERSATIONS refusal. The same
 * rule holds on the live script and on the published snapshot.
 *
 * The fallback re-route (cor:cht:030:02 step 3) walks conversations in the
 * same code-unit `loc` order, for both the goal match and the no-match default.
 *
 * Each red pin inserts rows (or snapshot entries) in an order that today's
 * row-order pick gets wrong.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLoc } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { ChatScopeError } from './chat-scope.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let admin: { id: string };
let agentId: string;
let systemMemoryId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

type Seed = { loc: string; data?: Record<string, unknown> | null; content?: string | null };
type Path = 'live' | 'snapshot';

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-3405', urn: 'org-3405' } });
  admin = await db.user.create({ data: { githubId: 340500, githubUsername: 'u3405', roles: ['ADMIN'] as never } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'order-agent', visibility: 'ORGANIZATION' }, ctx());
  agentId = created.id;
  systemMemoryId = created.systemMemoryId!;
  await serveEveryAgent(db);
});

/** A conversation and (unless `stages` is null) one stage per name, in the given order. */
function conv(name: string, flags: Record<string, unknown> = {}, stages: string[] | null = ['s1']): Seed[] {
  const data = stages === null ? { ...flags } : { ...flags, stageOrder: stages };
  return [
    { loc: `conversations:${name}`, data },
    ...(stages ?? []).map((s) => ({ loc: `conversations:${name}:${s}`, data: {}, content: `prompt ${name}/${s}` })),
  ];
}

/** Seed in the given order, as live rows or as one published snapshot (array order = given order). */
async function seed(path: Path, seeds: Seed[]) {
  const all: Seed[] = [{ loc: 'conversations', data: null }, ...seeds];
  if (path === 'live') {
    for (const s of all) {
      await db.node.create({ data: {
        id: generateId(), memoryId: systemMemoryId, loc: s.loc, name: s.loc.split(':').pop()!, nodeType: 'system',
        data: (s.data ?? null) as never, content: s.content ?? null,
      } });
    }
    return;
  }
  const nodes = all.map((s) => ({
    loc: s.loc, name: s.loc.split(':').pop()!, nodeType: 'system', description: null, content: s.content ?? null, data: s.data ?? null,
  }));
  await db.node.create({ data: {
    id: generateId(), memoryId: systemMemoryId, loc: 'revisions:rev-3405', name: 'rev-3405', nodeType: 'system',
    data: { snapshot: { nodes } } as never,
  } });
  await db.agent.update({ where: { id: agentId }, data: { publishedRevisionLoc: 'revisions:rev-3405' } });
}

const start = (args: Record<string, unknown> = {}) => M.startChat(null, { agentId, ...args }, ctx());
const opened = async (args: Record<string, unknown> = {}) => (await start(args)).conversationName as string;
async function refusal(args: Record<string, unknown> = {}) {
  const err = await start(args).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ChatScopeError);
  return (err as ChatScopeError).extensions.code;
}

for (const path of ['live', 'snapshot'] as const) describe(`#3405 unnamed startChat order (${path})`, () => {
  it('only setup and fallback: opens setup, even when fallback comes first in row order', async () => {
    await seed(path, [...conv('fallback', { isFallback: true }), ...conv('setup', { isSetup: true })]);
    expect(await opened()).toBe('setup');
  });

  it('two ordinary conversations: opens the lower loc, regardless of insertion order', async () => {
    await seed(path, [...conv('zeta'), ...conv('alpha')]);
    expect(await opened()).toBe('alpha');
  });

  it('collation pin: code-unit order picks conversations:B before conversations:a', async () => {
    // 'B' (0x42) < 'a' (0x61) by code unit; a locale/collation compare (en_US) puts 'a' first.
    expect('B' < 'a').toBe(true);
    expect('a'.localeCompare('B')).toBeLessThan(0);
    await seed(path, [...conv('a'), ...conv('B')]);
    expect(await opened()).toBe('B');
  });

  it('an ordinary conversation wins over setup and fallback that sort before it', async () => {
    await seed(path, [...conv('a-fallback', { isFallback: true }), ...conv('b-setup', { isSetup: true }), ...conv('z-main')]);
    expect(await opened()).toBe('z-main');
  });

  it('a conversation flagged both setup and fallback counts as setup, ahead of a fallback that sorts first', async () => {
    await seed(path, [...conv('help', { isFallback: true }), ...conv('welcome', { isSetup: true, isFallback: true })]);
    expect(await opened()).toBe('welcome');
  });

  it('several setups (or several fallbacks) take the lower loc', async () => {
    await seed(path, [...conv('setup-z', { isSetup: true }), ...conv('setup-a', { isSetup: true }),
      ...conv('fb-z', { isFallback: true }), ...conv('fb-a', { isFallback: true })]);
    expect(await opened()).toBe('setup-a');
  });

  it('fallback only: opens fallback', async () => {
    await seed(path, [...conv('fb-z', { isFallback: true }), ...conv('fb-a', { isFallback: true })]);
    expect(await opened()).toBe('fb-a');
  });

  it('no conversation at all: AGENT_HAS_NO_CONVERSATIONS is unchanged', async () => {
    await seed(path, []);
    expect(await refusal()).toBe('AGENT_HAS_NO_CONVERSATIONS');
  });

  it('the chosen conversation has no stageOrder: CONVERSATION_HAS_NO_STAGES, no skip to the next one', async () => {
    await seed(path, [...conv('beta'), ...conv('alpha', {}, null)]);
    expect(await refusal()).toBe('CONVERSATION_HAS_NO_STAGES');
  });

  it('nested conversation nodes are not candidates', async () => {
    await seed(path, [...conv('zeta'), { loc: 'conversations:zeta:aaa', data: { stageOrder: ['x'] } }]);
    expect(await opened()).toBe('zeta');
  });

  it('a named start is unchanged: it opens the named conversation, not the default', async () => {
    await seed(path, [...conv('zeta'), ...conv('alpha'), ...conv('setup', { isSetup: true })]);
    expect(await opened({ conversationName: 'zeta' })).toBe('zeta');
    expect(await opened({ conversationName: 'setup' })).toBe('setup');
  });
});

for (const path of ['live', 'snapshot'] as const) describe(`#3405 fallback re-route order (${path})`, () => {
  async function rerouted(userMessage: string) {
    const chat = await start({ conversationName: 'fallback' });
    expect(chat.conversationName).toBe('fallback');
    await M.sendChatMessage({}, { chatId: chat.chatId, userMessage }, ctx());
    const node = await chatNodeByLoc(db, chat.chatId, { includeDeleted: true });
    // #3557: the name lives only in the state row (no rollback mirror in the root's data).
    const row = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: node!.id } });
    return (row.state as Record<string, unknown>).conversationName;
  }

  it('two conversations both matching the signals: re-routes to the lower loc, whatever the insertion order', async () => {
    await seed(path, [...conv('fallback', { isFallback: true }),
      ...conv('zeta', { goalSignals: ['mentor'] }), ...conv('alpha', { goalSignals: ['mentor'] })]);
    expect(await rerouted('I need a mentor')).toBe('alpha');
  });

  it('no match, a message of 4 words or more: the default is the lower loc', async () => {
    await seed(path, [...conv('fallback', { isFallback: true }), ...conv('zeta'), ...conv('alpha')]);
    expect(await rerouted('tell me something about everything')).toBe('alpha');
  });

  it('CONTROL: matching rules unchanged: a short no-match message stays in fallback, setup is never a target', async () => {
    await seed(path, [...conv('fallback', { isFallback: true }), ...conv('a-setup', { isSetup: true }), ...conv('zeta')]);
    expect(await rerouted('hi there')).toBe('fallback');
  });

  it('CONTROL: only the matching conversation is chosen, even when a non-matching one sorts first', async () => {
    await seed(path, [...conv('fallback', { isFallback: true }),
      ...conv('zeta', { goalSignals: ['mentor'] }), ...conv('alpha', { goalSignals: ['billing'] })]);
    expect(await rerouted('I need a mentor')).toBe('zeta');
  });
});
