import { randomUUID } from 'node:crypto';
/**
 * #3113 — `NodeFilter.nodeTypes`: an explicit list of node types, a union.
 *
 * The list NARROWS to the named types and ANDs every other filter. It lifts
 * only the node-type default (`system`), never the memory-class default, the
 * comment scope, access, deleted rows or inheritance. Unknown strings match
 * nothing (exact, case-sensitive). `null` is omitted; `[]`, both fields set
 * (an empty-string `nodeType` counts as set), more than 20 entries (counted
 * before de-duplication) and any list containing `comment` are BAD_USER_INPUT,
 * on every path including the empty and denied ones, and never echo a value.
 *
 * Totals keep the current contract: exact in the filter-only list; vector and
 * hybrid keep `total: null`, a bounded ANN window and widening.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
// "far" text embeds off the query axis, so every plain node outranks it.
const stub: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      v[1] = 1;
      if (t.includes('far')) v[2] = 1;
      return v;
    });
  },
};

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-3113' });
const Q = resolvers.Query as any;
const findNodes = (args: Record<string, unknown>, ctx: Context = admin()) => Q.findNodes(null, args, ctx);
const locs = (res: any) => res.hits.map((h: any) => h.node.loc).sort();

let orgId: string;
let memoryId: string;
let appId: string;

async function mk(loc: string, nodeType: string, extra: Record<string, unknown> = {}, mem = memoryId) {
  const id = generateId();
  await db.node.create({
    data: { id, memoryId: mem, loc, name: `marker ${loc}`, content: `marker ${loc}`, nodeType, ...extra } as any,
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'nt-org', graphName: 'nt/graph' });
  orgId = org.id;
  memoryId = graph.id;
  await mk('n.info', 'info');
  await mk('n.task', 'task');
  await mk('n.record', 'record');
  await mk('n.widget', 'widget');
  await mk('n.system', 'system');
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.id}:nt-agent`, name: 'nt-agent' },
  });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId, role: 'read-write' } });
  const { app } = await createDbAppWithKey(db, 'nt-app', org.id);
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  appId = app.id;
});

describe('filter-only list: union, exact total, paging', () => {
  it('returns exactly the listed types with an exact union total', async () => {
    const res = await findNodes({ includeTotal: true, filter: { memoryIds: [memoryId], nodeTypes: ['task', 'record'] } });
    expect(locs(res)).toEqual(['n.record', 'n.task']);
    expect(res.total).toBe(2);
  });

  it('pages the union by offset with no repeat and no gap, one count domain', async () => {
    const filter = { memoryIds: [memoryId], nodeTypes: ['task', 'record', 'widget'] };
    const seen: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const res = await findNodes({ includeTotal: true, limit: 1, offset, filter });
      expect(res.total).toBe(3);
      seen.push(...res.hits.map((h: any) => h.node.loc));
    }
    expect(seen).toEqual(['n.record', 'n.task', 'n.widget']);
  });

  it('the paged SQL browse (a where predicate) honours the list and its total', async () => {
    const res = await findNodes({
      includeTotal: true,
      filter: { memoryIds: [memoryId], nodeTypes: ['task', 'info'], where: { path: ['zz'], exists: false } },
    });
    expect(locs(res)).toEqual(['n.info', 'n.task']);
    expect(res.total).toBe(2);
  });

  it('keyword and regex keep total null even with includeTotal (as on main); the union still filters them', async () => {
    const kw = await findNodes({ includeTotal: true, query: 'marker', mode: 'keyword', filter: { memoryIds: [memoryId], nodeTypes: ['task', 'record'] } });
    expect(locs(kw)).toEqual(['n.record', 'n.task']);
    expect(kw.total).toBeNull();
    const rx = await findNodes({ includeTotal: true, query: 'marker', mode: 'regex', filter: { memoryIds: [memoryId], nodeTypes: ['task', 'record'] } });
    expect(locs(rx)).toEqual(['n.record', 'n.task']);
    expect(rx.total).toBeNull();
  });

  it('an explicit list replaces the system-type default; it is not defaults plus the list', async () => {
    const withSystem = await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: ['system', 'task'] } });
    expect(locs(withSystem)).toEqual(['n.system', 'n.task']);
    const baseline = await findNodes({ filter: { memoryIds: [memoryId] } });
    expect(locs(baseline)).not.toContain('n.system');
  });

  it('ANDs the other filters', async () => {
    await mk('n.task.runnable', 'task', { isRunnable: true });
    await mk('n.widget.runnable', 'widget', { isRunnable: true });
    const res = await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: ['task', 'info'], isRunnable: true } });
    expect(locs(res)).toEqual(['n.task.runnable']);
  });

  it('unknown values match nothing and values are exact and case-sensitive', async () => {
    expect(locs(await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: ['nope'] } }))).toEqual([]);
    expect(locs(await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: ['TASK', ' task'] } }))).toEqual([]);
    expect(locs(await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: ['nope', 'task'] } }))).toEqual(['n.task']);
  });

  it('a duplicated list is the same set; exactly 20 supplied entries are allowed', async () => {
    const dup = await findNodes({ includeTotal: true, filter: { memoryIds: [memoryId], nodeTypes: ['task', 'task', 'task'] } });
    expect(locs(dup)).toEqual(['n.task']);
    expect(dup.total).toBe(1);
    const twenty = Array.from({ length: 19 }, (_, i) => `t${i}`).concat('task');
    expect(locs(await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: twenty } }))).toEqual(['n.task']);
  });

  it('null is omitted: the unqualified result is unchanged; singular nodeType is unchanged', async () => {
    const omitted = await findNodes({ filter: { memoryIds: [memoryId] } });
    const nulled = await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: null } });
    expect(locs(nulled)).toEqual(locs(omitted));
    const single = await findNodes({ filter: { memoryIds: [memoryId], nodeType: 'task', nodeTypes: null } });
    expect(locs(single)).toEqual(['n.task']);
  });

  it('a system-type list lifts only the node-type default, never the memory-class default', async () => {
    const sys = await db.memory.create({ data: { class: 'system', organizationId: orgId, name: 'nt system', urn: `${orgId}:nt-system` } });
    await mk('s.info', 'info', {}, sys.id);
    await mk('s.sys', 'system', {}, sys.id);
    // No memory named: the SYSTEM class stays out, whatever the list.
    const all = await findNodes({ filter: { nodeTypes: ['info', 'system'] } });
    expect(locs(all).filter((l: string) => l.startsWith('s.'))).toEqual([]);
    // Naming the system memory is the existing override; the list still narrows.
    const named = await findNodes({ filter: { memoryIds: [sys.id], nodeTypes: ['system'] } });
    expect(locs(named)).toEqual(['s.sys']);
  });

  it('does not lift access: a non-reader gets nothing from a listed type', async () => {
    const stranger = await db.user.create({ data: { githubId: 311301, githubUsername: 'nt-stranger', handle: 'nt-stranger', roles: [] } });
    const res = await findNodes(
      { filter: { memoryIds: [memoryId], nodeTypes: ['task', 'info'] } },
      { db, userId: stranger.id, roles: ['READER'] } as Context,
    );
    expect(res.hits).toEqual([]);
  });

  it('does not lift soft-deletion', async () => {
    const id = await mk('n.task.gone', 'task');
    await db.node.update({ where: { id }, data: { deletedAt: new Date() } });
    const res = await findNodes({ filter: { memoryIds: [memoryId], nodeTypes: ['task'] } });
    expect(locs(res)).toEqual(['n.task']);
  });
});

describe('ranked lexical modes', () => {
  it.each(['keyword', 'regex'])('%s: the list narrows the ranked set', async (mode) => {
    const res = await findNodes({ query: mode === 'regex' ? 'marker n\\.(task|record|info)' : 'marker', mode, filter: { memoryIds: [memoryId], nodeTypes: ['task', 'record'] } });
    expect(locs(res)).toEqual(['n.record', 'n.task']);
  });
});

describe('refusals (BAD_USER_INPUT, field named, value never echoed, every path)', () => {
  const refuse = async (filter: Record<string, unknown>, ctx?: Context) => {
    const err: any = await findNodes({ query: 'marker', filter }, ctx).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toContain('nodeTypes');
    return err.message as string;
  };

  it('[] is refused', async () => { await refuse({ memoryIds: [memoryId], nodeTypes: [] }); });

  it('both fields set is refused, an empty-string nodeType counts as set', async () => {
    await refuse({ memoryIds: [memoryId], nodeType: 'task', nodeTypes: ['task'] });
    await refuse({ memoryIds: [memoryId], nodeType: '', nodeTypes: ['task'] });
  });

  it('more than 20 supplied entries is refused, counted before de-duplication', async () => {
    await refuse({ memoryIds: [memoryId], nodeTypes: Array.from({ length: 21 }, (_, i) => `t${i}`) });
    await refuse({ memoryIds: [memoryId], nodeTypes: Array.from({ length: 21 }, () => 'task') });
  });

  it('a list containing comment is refused with or without contentScope, without echoing the others', async () => {
    const m1 = await refuse({ memoryIds: [memoryId], nodeTypes: ['secret-type-xyz', 'comment'] });
    expect(m1).not.toContain('secret-type-xyz');
    await refuse({ memoryIds: [memoryId], nodeTypes: ['comment'], contentScope: 'ALL' });
    await refuse({ memoryIds: [memoryId], nodeTypes: ['comment'], contentScope: 'COMMENTS' });
  });

  it('refuses on the empty-scope and the denied paths too: no ignored field', async () => {
    await refuse({ memoryIds: [generateId()], nodeTypes: [] });
    const stranger = await db.user.create({ data: { githubId: 311302, githubUsername: 'nt-stranger2', handle: 'nt-stranger2', roles: [] } });
    await refuse({ memoryIds: [memoryId], nodeTypes: [] }, { db, userId: stranger.id, roles: ['READER'] } as Context);
  });

  it('the singular nodeType and contentScope keep their meaning', async () => {
    const single = await findNodes({ filter: { memoryIds: [memoryId], nodeType: 'comment' } });
    expect(single.hits).toEqual([]);
    const scoped = await findNodes({ filter: { memoryIds: [memoryId], nodeType: 'task', contentScope: 'ALL' } });
    expect(locs(scoped)).toEqual(['n.task']);
  });
});

describe('appNodes: the same list and validation', () => {
  it('narrows to the list, ANDs the rest, lifts nothing else', async () => {
    const res = await Q.appNodes(null, { appRef: appId, filter: { nodeTypes: ['task', 'system'] } }, admin());
    expect(res.map((n: any) => n.loc).sort()).toEqual(['n.system', 'n.task']);
    const none = await Q.appNodes(null, { appRef: appId, filter: { nodeTypes: ['nope'] } }, admin());
    expect(none).toEqual([]);
    const nulled = await Q.appNodes(null, { appRef: appId, filter: { nodeTypes: null } }, admin());
    expect(nulled.length).toBe(5);
  });

  it('refuses [], both fields, over 20 and comment, also for an unknown App', async () => {
    const bad: Array<Record<string, unknown>> = [
      { nodeTypes: [] },
      { nodeType: 'task', nodeTypes: ['task'] },
      { nodeType: '', nodeTypes: ['task'] },
      { nodeTypes: Array.from({ length: 21 }, () => 'task') },
      { nodeTypes: ['comment'], contentScope: 'ALL' },
    ];
    for (const filter of bad) {
      for (const ref of [appId, generateId()]) {
        const err: any = await Q.appNodes(null, { appRef: ref, filter }, admin()).then(() => null, (e: unknown) => e);
        expect(err?.extensions?.code).toBe('BAD_USER_INPUT');
        expect(err.message).toContain('nodeTypes');
      }
    }
  });
});

describe('vector and hybrid: the list rides the bounded window, total stays null', () => {
  let farId: string;
  beforeEach(async () => {
    process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
    setEmbeddingClientForTests(stub);
    await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
    const seed = async (loc: string, content: string, nodeType: string) => {
      const id = generateId();
      await db.node.create({ data: { id, memoryId, loc, name: loc, content, nodeType, embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } as any });
      expect(await embedNode(db, id)).toBe('embedded');
      return id;
    };
    for (let i = 0; i < 8; i++) await seed(`near${i}`, `near body ${i}`, 'info');
    farId = await seed('far.match', 'far body match', 'widget');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    resetEmbeddingClientForTests();
    delete process.env.EMBEDDING_API_URL;
  });

  it('vector: limit 1 finds the only listed-type node ranked past the first window; total is null', async () => {
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 1, filter: { memoryIds: [memoryId], nodeTypes: ['widget', 'nope'] } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([farId]);
    expect(res.total).toBeNull();
  });

  it('vector chunk granularity: the same', async () => {
    const res = await findNodes({ query: 'q', mode: 'vector', granularity: 'chunk', limit: 1, filter: { memoryIds: [memoryId], nodeTypes: ['widget'] } });
    expect(res.passages.map((p: any) => p.parentNodeId)).toEqual([farId]);
  });

  it('hybrid: the widened vector leg keeps the listed node; total is null', async () => {
    const res = await findNodes({ query: 'zzzunmatchable', mode: 'hybrid', limit: 1, filter: { memoryIds: [memoryId], nodeTypes: ['widget'] } });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([farId]);
    expect(res.total).toBeNull();
  });

  it('the list narrows: other types never appear', async () => {
    const res = await findNodes({ query: 'q', mode: 'vector', limit: 20, filter: { memoryIds: [memoryId], nodeTypes: ['widget'] } });
    expect(res.hits.every((h: any) => h.node.nodeType === 'widget')).toBe(true);
  });
});
