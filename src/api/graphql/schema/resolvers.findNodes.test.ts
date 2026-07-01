import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const ctx = (o: Partial<Context> = {}): Context => ({ db, ...o });
// Admin context → getAccessibleMemoryIds returns null (all memories accessible).
const admin = () => ctx({ roles: ['ADMIN'], userId: 'admin-fn' });

const findNodes = (args: Record<string, unknown>, c: Context = admin()) =>
  (resolvers.Query as any).findNodes(null, args, c);

async function mkNode(memoryId: string, fields: Record<string, unknown>) {
  return db.node.create({ data: { id: generateId(), memoryId, ...fields } as any });
}

let orgA: { id: string };
let graph: { id: string };
let sysMem: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'fn-org', graphName: 'fn/graph' });
  orgA = made.org;
  graph = made.graph;
  const sys = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'fn-org:fn/system', name: 'fn/system', class: 'system' },
  });
  sysMem = { id: sys.id };
});

describe('findNodes — lexical ranking (cor:rag:010:02)', () => {
  it('ranks a name hit above the same term buried in a long body (the motivating case)', async () => {
    await mkNode(graph.id, { loc: 'fruit.banana', name: 'Banana smoothie', content: 'A short unrelated note.' });
    await mkNode(graph.id, {
      loc: 'fruit.filler',
      name: 'Grocery list',
      content: 'A long descriptive body about the weekly shop. ' + 'lorem ipsum dolor sit amet. '.repeat(80) + ' banana appears once here, buried.',
    });
    const res = await findNodes({ query: 'banana', mode: 'keyword' });
    expect(res.hits.length).toBe(2);
    expect(res.hits[0].node.loc).toBe('fruit.banana');
    expect(res.hits[0].score).toBeGreaterThan(res.hits[1].score);
  });

  it('fields weight-mask: restricting to name does not let a body-only hit rank', async () => {
    await mkNode(graph.id, { loc: 'n.name', name: 'banana', content: 'nothing here' });
    await mkNode(graph.id, { loc: 'n.body', name: 'Grocery', content: 'banana in the body' });
    const res = await findNodes({ query: 'banana', mode: 'keyword', fields: ['name'] });
    // Both may match (weight-mask is not a hard filter), but the name hit must
    // score > 0 and outrank the body-only hit (which scores ~0 under a name mask).
    const nameHit = res.hits.find((h: any) => h.node.loc === 'n.name');
    const bodyHit = res.hits.find((h: any) => h.node.loc === 'n.body');
    expect(nameHit.score).toBeGreaterThan(0);
    expect(nameHit.score).toBeGreaterThan(bodyHit?.score ?? 0);
  });
});

describe('findNodes — boolean operators (cor:api:090:01)', () => {
  beforeEach(async () => {
    await mkNode(graph.id, { loc: 'b.bshake', name: 'Banana shake recipe' });
    await mkNode(graph.id, { loc: 'b.ashake', name: 'Apple shake recipe' });
    await mkNode(graph.id, { loc: 'b.bread', name: 'Banana bread' });
  });

  it('evaluates (banana OR apple) AND shake', async () => {
    const res = await findNodes({ query: '(banana OR apple) AND shake', mode: 'keyword' });
    const locs = res.hits.map((h: any) => h.node.loc).sort();
    expect(locs).toEqual(['b.ashake', 'b.bshake']);
  });

  it('rejects a malformed boolean query with BAD_USER_INPUT', async () => {
    await expect(findNodes({ query: '(banana OR', mode: 'keyword' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('findNodes — regex mode', () => {
  it('matches by POSIX regex', async () => {
    await mkNode(graph.id, { loc: 'r.a', name: 'banana' });
    await mkNode(graph.id, { loc: 'r.b', name: 'bandana' });
    await mkNode(graph.id, { loc: 'r.c', name: 'orange' });
    const res = await findNodes({ query: 'ban.*na', mode: 'regex' });
    expect(res.hits.map((h: any) => h.node.loc).sort()).toEqual(['r.a', 'r.b']);
  });
});

describe('findNodes — regex fields are a score-mask, not a hard filter (cor:api:090:03)', () => {
  it('still returns a body-only regex match when fields=[name], just unscored', async () => {
    await mkNode(graph.id, { loc: 'rx.name', name: 'banana', content: 'x' });
    await mkNode(graph.id, { loc: 'rx.body', name: 'grocery', content: 'banana here' });
    const res = await findNodes({ query: 'banana', mode: 'regex', fields: ['name'] });
    const locs = res.hits.map((h: any) => h.node.loc).sort();
    expect(locs).toEqual(['rx.body', 'rx.name']); // both returned; fields only masks scoring
  });
});

describe('findNodes — sort + pagination on a query (applied in SQL, not after truncation)', () => {
  beforeEach(async () => {
    await mkNode(graph.id, { loc: 'srt.c', name: 'zeta gamma' });
    await mkNode(graph.id, { loc: 'srt.a', name: 'zeta alpha' });
    await mkNode(graph.id, { loc: 'srt.b', name: 'zeta beta' });
  });
  it('orders a keyword query by loc and pages correctly', async () => {
    const p1 = await findNodes({ query: 'zeta', mode: 'keyword', sort: 'loc', filter: { memoryIds: [graph.id] }, limit: 2, offset: 0 });
    expect(p1.hits.map((h: any) => h.node.loc)).toEqual(['srt.a', 'srt.b']);
    const p2 = await findNodes({ query: 'zeta', mode: 'keyword', sort: 'loc', filter: { memoryIds: [graph.id] }, limit: 2, offset: 2 });
    expect(p2.hits.map((h: any) => h.node.loc)).toEqual(['srt.c']);
  });
});

describe('findNodes — filtered list (query omitted, subsumes `nodes`)', () => {
  it('returns a deterministic list and excludes system-type nodes by default', async () => {
    await mkNode(graph.id, { loc: 'a.two', name: 'Two' });
    await mkNode(graph.id, { loc: 'a.one', name: 'One' });
    await mkNode(graph.id, { loc: 'a.sys', name: 'Sys', nodeType: 'system' });
    const res = await findNodes({ filter: { memoryIds: [graph.id] } });
    const locs = res.hits.map((h: any) => h.node.loc);
    expect(locs).toEqual(['a.one', 'a.two']); // loc-ordered, system-type excluded
    expect(res.hits.every((h: any) => h.score === null)).toBe(true); // unscored list
  });

  it('filters by isRunnable and locPrefix', async () => {
    await mkNode(graph.id, { loc: 'task.a', name: 'Task A', isRunnable: true });
    await mkNode(graph.id, { loc: 'task.b', name: 'Task B', isRunnable: false });
    await mkNode(graph.id, { loc: 'note.c', name: 'Note C', isRunnable: true });
    const res = await findNodes({ filter: { memoryIds: [graph.id], isRunnable: true, locPrefix: 'task.' } });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['task.a']);
  });
});

describe('findNodes — structured filters apply to query results, not just lists', () => {
  it('respects isRunnable on a keyword query', async () => {
    await mkNode(graph.id, { loc: 'q.run1', name: 'runnable banana', isRunnable: true });
    await mkNode(graph.id, { loc: 'q.run2', name: 'another banana task', isRunnable: true });
    await mkNode(graph.id, { loc: 'q.note', name: 'banana note', isRunnable: false });
    const res = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryIds: [graph.id], isRunnable: true } });
    expect(res.hits.map((h: any) => h.node.loc).sort()).toEqual(['q.run1', 'q.run2']);
  });

  it('excludes soft-deleted matches by default and includes them with includeDeleted', async () => {
    await mkNode(graph.id, { loc: 'd.live', name: 'live banana' });
    await mkNode(graph.id, { loc: 'd.dead', name: 'dead banana', deletedAt: new Date() });
    const def = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryIds: [graph.id] } });
    expect(def.hits.map((h: any) => h.node.loc)).toEqual(['d.live']);
    const inc = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryIds: [graph.id], includeDeleted: true } });
    expect(inc.hits.map((h: any) => h.node.loc).sort()).toEqual(['d.dead', 'd.live']);
  });
});

describe('findNodes — memoryClasses (cor:api:090:02)', () => {
  beforeEach(async () => {
    await mkNode(graph.id, { loc: 'k.node', name: 'knowledge banana' });
    await mkNode(sysMem.id, { loc: 's.node', name: 'system banana' });
  });

  it('excludes SYSTEM-class memories by default on a broad search', async () => {
    const res = await findNodes({ query: 'banana', mode: 'keyword' }); // no memoryIds → broad
    const locs = res.hits.map((h: any) => h.node.loc);
    expect(locs).toContain('k.node');
    expect(locs).not.toContain('s.node');
  });

  it('includes SYSTEM when explicitly requested via memoryClasses (explicit wins)', async () => {
    const res = await findNodes({ query: 'banana', mode: 'keyword', filter: { memoryClasses: ['system'] } });
    expect(res.hits.map((h: any) => h.node.loc)).toEqual(['s.node']);
  });
});
