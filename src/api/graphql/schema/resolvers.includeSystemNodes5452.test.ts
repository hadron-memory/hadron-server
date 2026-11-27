/**
 * #5452 (hrn:node:hadronmemory.com:specs:cor:api:090:02, cor:api:090:05; Holger's ruling 2 of 2026-11-27) —
 * `includeSystemNodes` on `findNodes` (NodeFilter) and `memoryLocSegments`.
 *
 * `true` lifts ONE thing: `system` leaves the default node-type exclusion. Everything else stays:
 * `chat-message` stays excluded, comments do whatever they did before (findNodes: the content-scope
 * default; segments: always left out), the memory-class SYSTEM default still needs the memory named,
 * access is unchanged, and an explicit `nodeType` / `nodeTypes` decides alone. `false`, `null` and
 * omitted are today's behaviour.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, GraphQLInputObjectType, GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { upsertAbstractVector } from '../../../services/embedding/vectors.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

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

const Q = resolvers.Query as any;
let reader: { id: string };
let outsider: { id: string };
/** A system-class memory (an Agent's own system memory shape: no App). */
let sys: { id: string };
/** An ordinary knowledge memory in the same organization. */
let know: { id: string };

const as = (userId = reader.id): Context => ({ db, userId, roles: [] });
const findNodes = (args: Record<string, unknown>, ctx = as()) => Q.findNodes(null, args, ctx);
const segs = (args: Record<string, unknown>, ctx = as()) => Q.memoryLocSegments(null, args, ctx);
const locs = (res: { hits: Array<{ node: { loc: string } }> }) => res.hits.map((h) => h.node.loc).sort();
const names = (page: { items: Array<{ segment: string }> }) => page.items.map((i) => i.segment);

const SYSTEM_CHILDREN = ['conversations:intro', 'conversations:outro'];

/** A whole comment node (node + meta + its one anchor), the only shape the comment invariant admits. */
async function mkComment(memoryId: string, loc: string, targetId: string) {
  return db.$transaction(async (tx) => {
    const id = generateId();
    await tx.node.create({ data: { id, memoryId, loc, name: 'harbor comment', nodeType: 'comment', content: 'harbor plan text' } });
    await tx.commentMeta.create({ data: { nodeId: id, targetNodeId: targetId, threadState: 'OPEN', authorKey: `u:${id}` } });
    await tx.edge.create({ data: {
      memoryId, sourceId: id, targetId, loc: `${loc}-anchor`, name: 'comment-anchor',
      governedKind: 'COMMENT_ANCHOR', anchorRevNo: 1, anchorApprovalHash: 'a'.repeat(64),
    } });
    return id;
  });
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Sys Org', urn: `sys5452-${n}.example` } });
  reader = await db.user.create({ data: { githubId: 545201, githubUsername: 'sys-5452-reader', handle: 'sys-5452-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 545202, githubUsername: 'sys-5452-outsider', handle: 'sys-5452-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  sys = await db.memory.create({
    data: { id: generateId(), class: 'system', organizationId: org.id, name: 'bot system', urn: `${org.urn}:bot-system`, vectorIndexEnabled: true },
  });
  // The reader reaches the system memory the way an agent builder does: through an App the Agent is installed in.
  const agent = await db.agent.create({
    data: { organizationId: org.id, name: 'bot', urn: `${org.urn}:bot`, visibility: 'ORGANIZATION', systemMemoryId: sys.id },
  });
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'member' } });
  know = await db.memory.create({
    data: { id: generateId(), class: 'knowledge', organizationId: org.id, name: 'kb', urn: `${org.urn}:kb`, vectorIndexEnabled: true },
  });

  // Every node mentions "harbor" so keyword, regex and vector all match it.
  const base = { abstract: 'harbor plan', content: 'harbor plan text' };
  const targetId = generateId();
  await db.node.createMany({
    data: [
      // The system memory: a `conversations` parent with system children (the Know Yourself shape, #5390),
      // one info sibling, one chat-message sibling and (below) one comment sibling.
      { ...base, id: generateId(), memoryId: sys.id, loc: 'conversations', name: 'harbor conversations', nodeType: 'system' },
      ...SYSTEM_CHILDREN.map((loc) => ({ ...base, id: generateId(), memoryId: sys.id, loc, name: `harbor ${loc}`, nodeType: 'system' })),
      { ...base, id: targetId, memoryId: sys.id, loc: 'conversations:note', name: 'harbor note', nodeType: 'info' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'conversations:msg', name: 'harbor msg', nodeType: 'chat-message', seq: 1 },
      // Segment fixtures: a branch of only system nodes with no node at its own loc, a branch of only
      // chat-message nodes, and (below) a branch of only comments.
      { ...base, id: generateId(), memoryId: sys.id, loc: 'prompts:intro:greet', name: 'harbor prompt', nodeType: 'system' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'chatlog:001', name: 'harbor log 1', nodeType: 'chat-message', seq: 1 },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'chatlog:002', name: 'harbor log 2', nodeType: 'chat-message', seq: 2 },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'docs', name: 'harbor docs', nodeType: 'info' },
      // The knowledge memory: one ordinary node and one system-TYPE node (the type default is
      // orthogonal to the memory class).
      { ...base, id: generateId(), memoryId: know.id, loc: 'kb-doc', name: 'harbor kb doc', nodeType: 'info' },
      { ...base, id: generateId(), memoryId: know.id, loc: 'kb-sys', name: 'harbor kb sys', nodeType: 'system' },
    ],
  });
  await mkComment(sys.id, 'conversations:c1', targetId);
  await mkComment(sys.id, 'feedback:c2', targetId);
  for (const node of await db.node.findMany({ where: { memoryId: { in: [sys.id, know.id] }, loc: { not: '' }, deletedAt: null } })) {
    await upsertAbstractVector(db as any, { nodeId: node.id, memoryId: node.memoryId, provider: 'test', model: 'stub-model', dim: DIM, embedding: QUERY_VEC });
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

describe('#5452 findNodes: includeSystemNodes lifts the system node-type default and nothing else', () => {
  it.each(MODES)('%s: childrenOf a system parent returns the system children with the flag, none without', async (_m, args) => {
    const filter = { memoryRefs: [sys.id], childrenOf: 'conversations' };
    const without = await findNodes({ ...args, filter, limit: 50 });
    expect(locs(without)).toEqual(['conversations:note']);
    const withFlag = await findNodes({ ...args, filter: { ...filter, includeSystemNodes: true }, limit: 50 });
    // The chat-message sibling and the comment sibling stay out; the info sibling was always there.
    expect(locs(withFlag)).toEqual([...SYSTEM_CHILDREN, 'conversations:note'].sort());
  });

  it.each(MODES)('%s: false and null are the same as omitted', async (_m, args) => {
    const omitted = await findNodes({ ...args, filter: { memoryRefs: [sys.id] }, limit: 50 });
    expect(locs(omitted)).toEqual(['conversations:note', 'docs']);
    for (const value of [false, null]) {
      const res = await findNodes({ ...args, filter: { memoryRefs: [sys.id], includeSystemNodes: value }, limit: 50 });
      expect(locs(res), String(value)).toEqual(locs(omitted));
    }
  });

  it.each(MODES)('%s: chat-message nodes stay excluded with the flag', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { memoryRefs: [sys.id], includeSystemNodes: true }, limit: 50 });
    const got = locs(res);
    expect(got).toEqual(['conversations', ...SYSTEM_CHILDREN, 'conversations:note', 'docs', 'prompts:intro:greet'].sort());
    for (const loc of ['conversations:msg', 'chatlog:001', 'chatlog:002']) expect(got).not.toContain(loc);
  });

  it('comments do what they did before the flag: left out by the content default, returned for contentScope ALL, either way', async () => {
    const commentLocs = ['conversations:c1', 'feedback:c2'];
    for (const flag of [undefined, true]) {
      const dflt = locs(await findNodes({ filter: { memoryRefs: [sys.id], includeSystemNodes: flag }, limit: 50 }));
      for (const loc of commentLocs) expect(dflt, `default scope, flag ${flag}`).not.toContain(loc);
      const all = locs(await findNodes({ filter: { memoryRefs: [sys.id], contentScope: 'ALL', includeSystemNodes: flag }, limit: 50 }));
      expect(all, `ALL scope, flag ${flag}`).toEqual(expect.arrayContaining(commentLocs));
    }
  });

  it('the browse total counts what the flagged page can show', async () => {
    const res = await findNodes({ filter: { memoryRefs: [sys.id], childrenOf: 'conversations', includeSystemNodes: true }, includeTotal: true, limit: 50 });
    expect(res.total).toBe(3);
  });

  it.each(MODES)('%s: with no memory named, a system-class memory stays out (the class default is not lifted); the type default is', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { includeSystemNodes: true }, limit: 200 });
    const hits = res.hits as Array<{ node: { loc: string; memoryId: string } }>;
    expect(hits.filter((h) => h.node.memoryId === sys.id)).toEqual([]);
    // The knowledge memory's system-TYPE node is what the flag is for.
    expect(hits.filter((h) => h.node.memoryId === know.id).map((h) => h.node.loc).sort()).toEqual(['kb-doc', 'kb-sys']);
    const plain = await findNodes({ ...args, filter: {}, limit: 200 });
    expect((plain.hits as typeof hits).filter((h) => h.node.memoryId === know.id).map((h) => h.node.loc)).toEqual(['kb-doc']);
  });

  it.each(MODES)('%s: an explicit nodeType or nodeTypes decides alone; the flag is ignored, not refused', async (_m, args) => {
    const list = await findNodes({ ...args, filter: { memoryRefs: [sys.id], nodeTypes: ['info'], includeSystemNodes: true }, limit: 50 });
    expect(locs(list)).toEqual(['conversations:note', 'docs']);
    const single = await findNodes({ ...args, filter: { memoryRefs: [sys.id], nodeType: 'info', includeSystemNodes: true }, limit: 50 });
    expect(locs(single)).toEqual(['conversations:note', 'docs']);
    // Explicit chat-message still wins with the flag set.
    const chat = await findNodes({ ...args, filter: { memoryRefs: [sys.id], nodeType: 'chat-message', includeSystemNodes: true }, limit: 50 });
    expect(locs(chat)).toEqual(['chatlog:001', 'chatlog:002', 'conversations:msg']);
  });

  it.each(MODES)('%s: a caller who cannot read the memory gets the same empty result with and without the flag', async (_m, args) => {
    const without = await findNodes({ ...args, filter: { memoryRefs: [sys.id] }, limit: 50 }, as(outsider.id));
    const withFlag = await findNodes({ ...args, filter: { memoryRefs: [sys.id], includeSystemNodes: true }, limit: 50 }, as(outsider.id));
    expect(withFlag.hits).toEqual([]);
    expect(JSON.stringify(withFlag)).toBe(JSON.stringify(without));
    const missing = await findNodes({ ...args, filter: { memoryRefs: ['no-such-memory-5452'], includeSystemNodes: true }, limit: 50 }, as(outsider.id));
    expect(JSON.stringify(missing)).toBe(JSON.stringify(withFlag));
  });
});

describe('#5452 memoryLocSegments: includeSystemNodes', () => {
  it('lists a branch made only of system nodes with the flag (hasNode true where a system node sits there); absent without', async () => {
    const without = await segs({ memoryRefs: [sys.id], parentLoc: '' });
    expect(without.items).toEqual([
      // `conversations` is listed without the flag only through its info child, so it is not node-backed.
      { segment: 'conversations', hasNode: false, memoryId: sys.id },
      { segment: 'docs', hasNode: true, memoryId: sys.id },
    ]);
    const withFlag = await segs({ memoryRefs: [sys.id], parentLoc: '', includeSystemNodes: true });
    expect(withFlag.items).toEqual([
      { segment: 'conversations', hasNode: true, memoryId: sys.id },
      { segment: 'docs', hasNode: true, memoryId: sys.id },
      { segment: 'prompts', hasNode: false, memoryId: sys.id },
    ]);
  });

  it('one level down: the system children are node-backed segments with the flag, and only then', async () => {
    expect(names(await segs({ memoryRefs: [sys.id], parentLoc: 'conversations' }))).toEqual(['note']);
    const withFlag = await segs({ memoryRefs: [sys.id], parentLoc: 'conversations', includeSystemNodes: true });
    expect(withFlag.items).toEqual(['intro', 'note', 'outro'].map((segment) => ({ segment, hasNode: true, memoryId: sys.id })));
    // A branch that exists only through system nodes has nothing under it without the flag.
    expect(names(await segs({ memoryRefs: [sys.id], parentLoc: 'prompts' }))).toEqual([]);
    expect((await segs({ memoryRefs: [sys.id], parentLoc: 'prompts', includeSystemNodes: true })).items)
      .toEqual([{ segment: 'intro', hasNode: false, memoryId: sys.id }]);
  });

  it('a branch made only of chat-message nodes, or only of comments, stays absent either way', async () => {
    for (const flag of [undefined, false, true]) {
      const root = names(await segs({ memoryRefs: [sys.id], parentLoc: '', includeSystemNodes: flag }));
      expect(root, String(flag)).not.toContain('chatlog');
      expect(root, String(flag)).not.toContain('feedback');
      expect(names(await segs({ memoryRefs: [sys.id], parentLoc: 'chatlog', includeSystemNodes: flag })), String(flag)).toEqual([]);
      const children = names(await segs({ memoryRefs: [sys.id], parentLoc: 'conversations', includeSystemNodes: flag }));
      expect(children, String(flag)).not.toContain('msg');
      expect(children, String(flag)).not.toContain('c1');
    }
  });

  it('false and null are the same as omitted', async () => {
    const omitted = await segs({ memoryRefs: [sys.id], parentLoc: '' });
    for (const value of [false, null]) {
      expect(await segs({ memoryRefs: [sys.id], parentLoc: '', includeSystemNodes: value }), String(value)).toEqual(omitted);
    }
  });

  it('parity: with the flag, the top segments are the first segments of every loc the flagged findNodes returns', async () => {
    const page = await segs({ memoryRefs: [sys.id], parentLoc: '', limit: 200, includeSystemNodes: true });
    const found = await findNodes({ filter: { memoryRefs: [sys.id], includeSystemNodes: true }, limit: 200 });
    const expected = [...new Set<string>(found.hits.map((h: any) => (h.node.loc as string).split(':')[0]))].sort();
    expect(names(page).sort()).toEqual(expected);
  });

  it('paging the flagged read returns every row once', async () => {
    const first = await segs({ memoryRefs: [sys.id], parentLoc: '', limit: 2, includeSystemNodes: true });
    expect(first.hasMore).toBe(true);
    const second = await segs({ memoryRefs: [sys.id], parentLoc: '', limit: 2, after: first.endCursor, includeSystemNodes: true });
    expect([...names(first), ...names(second)]).toEqual(['conversations', 'docs', 'prompts']);
    expect(second.hasMore).toBe(false);
  });

  it('a caller who cannot read the memory gets the identical empty page with and without the flag', async () => {
    const empty = { items: [], hasMore: false, endCursor: null };
    for (const flag of [undefined, true]) {
      expect(await segs({ memoryRefs: [sys.id], parentLoc: '', includeSystemNodes: flag }, as(outsider.id)), String(flag)).toEqual(empty);
      expect(await segs({ memoryRefs: ['no-such-memory-5452'], parentLoc: '', includeSystemNodes: flag }, as(outsider.id)), String(flag)).toEqual(empty);
    }
  });
});

describe('#5452 appNodes and appNodesPage refuse the field instead of ignoring it', () => {
  for (const name of ['appNodes', 'appNodesPage']) {
    for (const value of [true, false]) {
      it(`${name} refuses ${value} with BAD_USER_INPUT naming the field, before any App lookup`, async () => {
        const spy = vi.spyOn(db.app, 'findFirst');
        try {
          await expect(Q[name](null, { appRef: 'not-an-app', filter: { includeSystemNodes: value } }, as()))
            .rejects.toMatchObject({ message: expect.stringContaining('filter.includeSystemNodes'), extensions: { code: 'BAD_USER_INPUT' } });
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
    }

    it(`${name}: null is the same as omitted (the field's refusal does not fire)`, async () => {
      const outcome = async (filter: Record<string, unknown> | undefined) => {
        try {
          return JSON.stringify(await Q[name](null, { appRef: 'not-an-app', filter }, as()));
        } catch (e) {
          return `threw: ${(e as Error).message}`;
        }
      };
      const omitted = await outcome(undefined);
      expect(omitted).not.toContain('includeSystemNodes');
      expect(await outcome({ includeSystemNodes: null })).toBe(omitted);
    });
  }
});

describe('#5452 the wire contract: the SDL declares what the resolvers read', () => {
  const schema = buildSchema(typeDefs);

  it('NodeFilter.includeSystemNodes is a nullable Boolean with a description that says what it never lifts', () => {
    const field = (schema.getType('NodeFilter') as GraphQLInputObjectType).getFields().includeSystemNodes;
    expect(field, 'NodeFilter.includeSystemNodes').toBeDefined();
    expect(String(field.type)).toBe('Boolean');
    for (const word of ['chat-message', 'memory-class', 'access', 'deleted', 'nodeType', 'hrn:node:hadronmemory.com:specs:cor:api:090:02']) {
      expect(field.description, word).toContain(word);
    }
  });

  it('Query.memoryLocSegments takes includeSystemNodes: Boolean', () => {
    const field = (schema.getType('Query') as GraphQLObjectType).getFields().memoryLocSegments;
    const arg = field.args.find((a) => a.name === 'includeSystemNodes');
    expect(arg, 'memoryLocSegments(includeSystemNodes:)').toBeDefined();
    expect(String(arg!.type)).toBe('Boolean');
    expect(field.description).toContain('includeSystemNodes');
    expect(field.description).toContain('chat-message');
  });
});
