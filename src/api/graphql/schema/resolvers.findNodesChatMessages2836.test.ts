/**
 * #2836 (cor:api:090:02) — unqualified search leaves out `chat-message` nodes,
 * alongside `system`, in every findNodes mode and through MCP. Explicit wins:
 * `nodeType: "chat-message"` returns them, access gate unchanged. `record` is
 * never excluded, so a chatbot chat root's `record` messages stay searchable.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { upsertAbstractVector } from '../../../services/embedding/vectors.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
const QUERY_VEC = (() => { const v = new Array(DIM).fill(0); v[1] = 1; return v; })();
const stubClient: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) { return texts.map(() => QUERY_VEC); },
};

let admin: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const findNodes = (args: Record<string, unknown>, ctx = as()) => (resolvers.Query as any).findNodes(null, args, ctx);
const locs = (res: { hits: Array<{ node: { loc: string } }> }) => res.hits.map((h) => h.node.loc).sort();

const CHAT_ROOT = 'team-chat';
const MSG_LOCS = [`${CHAT_ROOT}:messages:001-ada`, `${CHAT_ROOT}:messages:002-dan`];
const BOT_ROOT = 'chats:bot';
const BOT_MSG = `${BOT_ROOT}:messages:001-user`;

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Chat Search Org', urn: 'chatsearch.example' } });
  admin = await db.user.create({ data: { githubId: 283601, githubUsername: 'chat-search-admin', handle: 'chat-search-admin', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 283602, githubUsername: 'chat-search-outsider', handle: 'chat-search-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'chatsearch' }, as());
  await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true } });

  // Every node mentions "harbor" so keyword, regex and vector all match it.
  const base = { memoryId: memory.id, abstract: 'harbor plan', content: 'harbor plan text' };
  await db.node.createMany({
    data: [
      { ...base, id: generateId(), loc: 'doc', name: 'Harbor doc' },
      { ...base, id: generateId(), loc: 'run-output', name: 'Harbor run', nodeType: 'record' },
      { ...base, id: generateId(), loc: CHAT_ROOT, name: 'Team chat', nodeType: 'chat' },
      ...MSG_LOCS.map((loc, i) => ({ ...base, id: generateId(), loc, name: `harbor msg ${i}`, nodeType: 'chat-message', seq: i + 1 })),
      // The chatbot path writes messages as `record` (src/lib/chatRoot.ts).
      { ...base, id: generateId(), loc: BOT_ROOT, name: 'Bot chat', nodeType: 'chat' },
      { ...base, id: generateId(), loc: BOT_MSG, name: 'harbor bot msg', nodeType: 'record', seq: 1 },
    ],
  });
  // Chat messages are never embedded today (isRawChatNode), but an index can
  // still hold an older vector for one; give every seeded node a vector so the
  // vector and hybrid legs are exercised for real.
  for (const n of await db.node.findMany({ where: { memoryId: memory.id, loc: { not: '' }, deletedAt: null } })) {
    await upsertAbstractVector(db as any, { nodeId: n.id, memoryId: memory.id, provider: 'test', model: 'stub-model', dim: DIM, embedding: QUERY_VEC });
  }
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

const MODES: Array<[string, Record<string, unknown>]> = [
  ['filter-only', {}],
  ['keyword', { query: 'harbor', mode: 'keyword' }],
  ['regex', { query: 'harbor', mode: 'regex' }],
  ['vector', { query: 'harbor', mode: 'vector' }],
  ['hybrid', { query: 'harbor', mode: 'hybrid' }],
];

describe('findNodes leaves chat-message nodes out of unqualified search (cor:api:090:02)', () => {
  it.each(MODES)('%s: no chat-message hit without a nodeType; record and chatbot record messages stay', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { memoryIds: [memory.id] }, limit: 50 });
    const got = locs(res);
    for (const loc of MSG_LOCS) expect(got).not.toContain(loc);
    expect(got).toEqual(expect.arrayContaining(['doc', 'run-output', BOT_MSG]));
  });

  it('a loc-prefix read of a team chat root returns no messages; of a chatbot root, its record messages', async () => {
    const team = await findNodes({ filter: { memoryIds: [memory.id], locPrefix: `${CHAT_ROOT}:` }, limit: 50 });
    expect(locs(team)).toEqual([]);
    const bot = await findNodes({ filter: { memoryIds: [memory.id], locPrefix: `${BOT_ROOT}:` }, limit: 50 });
    expect(locs(bot)).toEqual([BOT_MSG]);
  });

  it.each([
    ['keyword', { mode: 'keyword' }],
    ['regex', { mode: 'regex' }],
  ])('%s: messages are excluded BEFORE the limit, so they never take a page slot', async (_m, args) => {
    // 30 messages whose locs sort before every other hit.
    await db.node.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        id: generateId(), memoryId: memory.id, loc: `a-chat:messages:${String(i).padStart(3, '0')}`,
        name: 'harbor msg', abstract: 'harbor plan', nodeType: 'chat-message', seq: i + 1,
      })),
    });
    const res = await findNodes({ query: 'harbor', ...args, sort: 'loc', filter: { memoryIds: [memory.id] }, limit: 2 });
    expect(locs(res)).toEqual([BOT_ROOT, BOT_MSG]);
  });

  it('the browse total counts what the page can show', async () => {
    const res = await findNodes({ filter: { memoryIds: [memory.id], locPrefix: `${CHAT_ROOT}` }, limit: 50 });
    expect(locs(res)).toEqual([CHAT_ROOT]);
    if (res.total != null) expect(res.total).toBe(1);
  });

  it.each(MODES)('%s: explicit nodeType chat-message returns them', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { memoryIds: [memory.id], nodeType: 'chat-message' }, limit: 50 });
    expect(locs(res)).toEqual(MSG_LOCS);
  });

  it('explicit nodeType chat-message under a loc prefix returns the direct messages; a non-reader still gets nothing', async () => {
    const res = await findNodes({ filter: { memoryIds: [memory.id], nodeType: 'chat-message', locPrefix: `${CHAT_ROOT}:messages:` }, limit: 50 });
    expect(locs(res)).toEqual(MSG_LOCS);
    // The access gate is unchanged: an inaccessible memory is dropped silently (090:02).
    const denied = await findNodes({ filter: { memoryIds: [memory.id], nodeType: 'chat-message' }, limit: 50 }, as(outsider.id));
    expect(denied.hits).toEqual([]);
  });

  it('system stays excluded and explicit system still wins (the list is shared, not replaced)', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'sys', name: 'harbor sys', nodeType: 'system', abstract: 'harbor plan' } });
    expect(locs(await findNodes({ query: 'harbor', mode: 'keyword', filter: { memoryIds: [memory.id] }, limit: 50 }))).not.toContain('sys');
    expect(locs(await findNodes({ filter: { memoryIds: [memory.id], nodeType: 'system' }, limit: 50 }))).toEqual(['sys']);
  });
});

describe('hadron_find_nodes', () => {
  it('leaves chat messages out unqualified and returns them for nodeType chat-message', async () => {
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const urn = memory.urn.startsWith('hrn:') ? memory.urn : `hrn:mem:${memory.urn}`;
    for (const mode of ['keyword', 'regex', 'vector', 'hybrid']) {
      const plain = await mcp.callToolText('hadron_find_nodes', { query: 'harbor', mode, memoryUrn: urn, limit: 50 });
      for (const loc of MSG_LOCS) expect(plain).not.toContain(loc);
      expect(plain).toContain(BOT_MSG);
      const typed = await mcp.callToolText('hadron_find_nodes', { query: 'harbor', mode, memoryUrn: urn, nodeType: 'chat-message', limit: 50 });
      for (const loc of MSG_LOCS) expect(typed).toContain(loc);
    }
  });
});
