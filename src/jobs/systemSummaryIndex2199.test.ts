/**
 * #2199 (cor:rag:010:01 r17) — a `class = 'system'` memory is ALWAYS indexed by summary; the setting and the source
 * only add content passages. Non-system classes keep the opt-in rule untouched.
 *
 * Hermetic: a stub embedder, the real pipeline (enqueue, embedNode, the drain), the real memory-config mutation and the
 * real findNodes scope. Nothing here calls a paid embedding endpoint.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { EmbeddingClient } from '../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../lib/embedding/index.js';
import { embedNode, drainEmbeddingQueue } from './embedNodes.js';
import { enqueueNodeEmbedding, stampMemoryEmbeddingsBatch } from '../services/embedding/enqueue.js';
import { embeddingKindsWanted, memoryIsVectorIndexed } from '../lib/embedding/indexing.js';
import { backfillSystemMemoryEmbeddings, parseBackfillArgs, parseCursor } from './backfillSystemMemoryEmbeddings.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const DIM = 768;
const oneHot = (slot: number): number[] => { const v = new Array(DIM).fill(0); v[slot % DIM] = 1; return v; };
const stub: EmbeddingClient = {
  provider: 'test', model: 'stub', dim: DIM,
  async embed(texts: string[]) { return texts.map((t) => oneHot(t === 'q' ? 1 : t.length)); },
};

let orgId: string;
let admin: { id: string };
const adminCtx = (): Context => ({ db, userId: admin.id, roles: ['READER'] }) as Context;

type MemOpts = { cls: 'system' | 'knowledge' | 'app'; flag?: boolean; source?: 'abstract' | 'contentChunks' | 'both' };
async function memory({ cls, flag = false, source = 'abstract' }: MemOpts) {
  const id = generateId();
  await db.memory.create({
    data: {
      id, organizationId: orgId, name: `m-${id}`, urn: `idx2199:${id.toLowerCase()}`, class: cls,
      ...(cls === 'knowledge' ? { visibility: 'ORGANIZATION' } : {}),
      ...(cls === 'system' ? { acceptsUploads: false } : {}),
      vectorIndexEnabled: flag, embeddingSource: source,
    } as never,
  });
  return id;
}
async function node(memoryId: string, loc: string, abstract: string | null, content = `content of ${loc}. `.repeat(8)) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, abstract, content, embeddingPendingAt: new Date() } });
}
async function kinds(nodeId: string): Promise<{ abstract: number; chunk: number }> {
  const rows = await db.$queryRaw<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM node_embeddings WHERE node_id = ${nodeId} GROUP BY kind`;
  return { abstract: rows.find((r) => r.kind === 'abstract')?.n ?? 0, chunk: rows.find((r) => r.kind === 'chunk')?.n ?? 0 };
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'idx-org', urn: 'idx2199' } })).id;
  admin = await db.user.create({ data: { githubId: 219901, githubUsername: 'idx-admin', handle: 'idx-admin', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
});
afterAll(() => { resetEmbeddingClientForTests(); delete process.env.EMBEDDING_API_URL; });

describe('the one definition', () => {
  it('system ⇒ always indexed with the summary; the setting only adds passages; others unchanged', () => {
    const sys = (flag: boolean, source: string) => embeddingKindsWanted({ class: 'system', vectorIndexEnabled: flag, embeddingSource: source });
    expect(sys(false, 'abstract')).toEqual({ abstract: true, chunks: false });
    expect(sys(false, 'both')).toEqual({ abstract: true, chunks: false }); // setting off ⇒ no passages
    expect(sys(true, 'abstract')).toEqual({ abstract: true, chunks: false });
    expect(sys(true, 'contentChunks')).toEqual({ abstract: true, chunks: true });
    expect(sys(true, 'both')).toEqual({ abstract: true, chunks: true });
    const k = (flag: boolean, source: string) => embeddingKindsWanted({ class: 'knowledge', vectorIndexEnabled: flag, embeddingSource: source });
    expect(k(false, 'both')).toEqual({ abstract: false, chunks: false });
    expect(k(true, 'abstract')).toEqual({ abstract: true, chunks: false });
    expect(k(true, 'contentChunks')).toEqual({ abstract: false, chunks: true });
    expect(memoryIsVectorIndexed({ class: 'system', vectorIndexEnabled: false })).toBe(true);
    for (const cls of ['knowledge', 'app', 'personal', 'private', 'group']) {
      expect(memoryIsVectorIndexed({ class: cls, vectorIndexEnabled: false })).toBe(false);
    }
  });
});

describe('embedding a system memory node (settings × source matrix)', () => {
  const cells: [boolean, 'abstract' | 'contentChunks' | 'both', { abstract: number; chunk: boolean }][] = [
    [false, 'abstract', { abstract: 1, chunk: false }],
    [false, 'contentChunks', { abstract: 1, chunk: false }],
    [false, 'both', { abstract: 1, chunk: false }],
    [true, 'abstract', { abstract: 1, chunk: false }],
    [true, 'contentChunks', { abstract: 1, chunk: true }],
    [true, 'both', { abstract: 1, chunk: true }],
  ];
  it.each(cells)('system, setting %s, source %s ⇒ summary always, chunks only when opted in', async (flag, source, want) => {
    const m = await memory({ cls: 'system', flag, source });
    const n = await node(m, 'role:task', 'A summary of the task.');
    expect(await embedNode(db, n.id)).toBe('embedded');
    const got = await kinds(n.id);
    expect(got.abstract).toBe(want.abstract);
    expect(got.chunk > 0).toBe(want.chunk);
  });

  it('non-system controls are unchanged: knowledge off ⇒ nothing; abstract ⇒ summary; contentChunks ⇒ passages only', async () => {
    const off = await node(await memory({ cls: 'knowledge', flag: false, source: 'both' }), 'k', 'sum');
    expect(await embedNode(db, off.id)).toBe('skipped');
    expect(await kinds(off.id)).toEqual({ abstract: 0, chunk: 0 });
    const abs = await node(await memory({ cls: 'knowledge', flag: true, source: 'abstract' }), 'k', 'sum');
    await embedNode(db, abs.id);
    expect(await kinds(abs.id)).toMatchObject({ abstract: 1, chunk: 0 });
    const chunks = await node(await memory({ cls: 'knowledge', flag: true, source: 'contentChunks' }), 'k', 'sum');
    await embedNode(db, chunks.id);
    const c = await kinds(chunks.id);
    expect(c.abstract).toBe(0);
    expect(c.chunk).toBeGreaterThan(0);
  });

  it('a node with no summary has no summary vector (no content fallback); with passages on, its chunk hits stay valid', async () => {
    const off = await node(await memory({ cls: 'system', flag: false, source: 'abstract' }), 'x', null);
    await embedNode(db, off.id);
    expect(await kinds(off.id)).toEqual({ abstract: 0, chunk: 0 });
    const blank = await node(await memory({ cls: 'system', flag: false, source: 'abstract' }), 'y', '   ');
    await embedNode(db, blank.id);
    expect(await kinds(blank.id)).toEqual({ abstract: 0, chunk: 0 });
    const opted = await node(await memory({ cls: 'system', flag: true, source: 'both' }), 'z', null);
    await embedNode(db, opted.id);
    const o = await kinds(opted.id);
    expect(o.abstract).toBe(0);
    expect(o.chunk).toBeGreaterThan(0);
  });
});

describe('enqueue, drain and refresh', () => {
  it('a write to a system memory with the setting off is queued; the same write to a knowledge memory is not', async () => {
    const sys = await node(await memory({ cls: 'system', flag: false }), 'a', 'sum');
    await db.node.update({ where: { id: sys.id }, data: { embeddingPendingAt: null } });
    await enqueueNodeEmbedding(db, { nodeId: sys.id, memoryId: sys.memoryId, plaintext: {} });
    expect((await db.node.findUniqueOrThrow({ where: { id: sys.id } })).embeddingPendingAt).not.toBeNull();
    const k = await node(await memory({ cls: 'knowledge', flag: false }), 'a', 'sum');
    await db.node.update({ where: { id: k.id }, data: { embeddingPendingAt: null } });
    await enqueueNodeEmbedding(db, { nodeId: k.id, memoryId: k.memoryId, plaintext: {} });
    expect((await db.node.findUniqueOrThrow({ where: { id: k.id } })).embeddingPendingAt).toBeNull();
  });

  it('an edit refreshes the summary vector through the drain (eventual)', async () => {
    const n = await node(await memory({ cls: 'system', flag: false }), 'a', 'first');
    await drainEmbeddingQueue(db, { client: stub });
    expect(await kinds(n.id)).toMatchObject({ abstract: 1 });
    const before = await db.$queryRaw<{ v: string }[]>`SELECT embedding::text AS v FROM node_embeddings WHERE node_id = ${n.id}`;
    await db.node.update({ where: { id: n.id }, data: { abstract: 'a much longer second summary', embeddingPendingAt: new Date() } });
    await drainEmbeddingQueue(db, { client: stub });
    const after = await db.$queryRaw<{ v: string }[]>`SELECT embedding::text AS v FROM node_embeddings WHERE node_id = ${n.id}`;
    expect(after[0]!.v).not.toBe(before[0]!.v);
  });

  it('retryFailedEmbeddings works on a system memory whose setting is off', async () => {
    const m = await memory({ cls: 'system', flag: false });
    const n = await node(m, 'a', 'sum');
    await db.node.update({ where: { id: n.id }, data: { embeddingPendingAt: null, embeddingFailedAt: new Date(), embeddingError: 'x' } });
    const count = await (resolvers.Mutation as any).retryFailedEmbeddings({}, { memoryRef: m }, adminCtx());
    expect(count).toBe(1);
  });
});

describe('changing the setting or the source never loses the summary', () => {
  const update = (id: string, input: Record<string, unknown>) =>
    (resolvers.Mutation as any).updateMemory({}, { id, ...input }, adminCtx());

  it('disabling passages keeps summary vectors and drops chunks; re-enabling restores chunks', async () => {
    const m = await memory({ cls: 'system', flag: true, source: 'both' });
    const n = await node(m, 'a', 'sum');
    await embedNode(db, n.id);
    expect((await kinds(n.id)).chunk).toBeGreaterThan(0);
    await update(m, { vectorIndexEnabled: false });
    expect(await kinds(n.id)).toMatchObject({ abstract: 1, chunk: 0 });
    expect((await db.memory.findUniqueOrThrow({ where: { id: m } })).vectorIndexEnabled).toBe(false); // stored value unchanged by the rule
    await update(m, { vectorIndexEnabled: true });
    await drainEmbeddingQueue(db, { client: stub });
    expect((await kinds(n.id)).chunk).toBeGreaterThan(0);
  });

  it('a source change away from passages keeps the summary; to abstract-only drops chunks only', async () => {
    const m = await memory({ cls: 'system', flag: true, source: 'both' });
    const n = await node(m, 'a', 'sum');
    await embedNode(db, n.id);
    await update(m, { embeddingSource: 'abstract' });
    expect(await kinds(n.id)).toMatchObject({ abstract: 1, chunk: 0 });
    await update(m, { embeddingSource: 'contentChunks' });
    await drainEmbeddingQueue(db, { client: stub });
    const k = await kinds(n.id);
    expect(k.abstract).toBe(1); // contentChunks on a system memory still carries the summary
    expect(k.chunk).toBeGreaterThan(0);
  });

  it('non-system control: disabling a knowledge memory still drops everything', async () => {
    const m = await memory({ cls: 'knowledge', flag: true, source: 'both' });
    const n = await node(m, 'a', 'sum');
    await embedNode(db, n.id);
    await update(m, { vectorIndexEnabled: false });
    expect(await kinds(n.id)).toEqual({ abstract: 0, chunk: 0 });
  });
});

describe('search scope', () => {
  const find = (memoryIds: string[]) =>
    (resolvers.Query as any).findNodes(null, { query: 'q', mode: 'vector', filter: { memoryIds } }, { db, roles: ['ADMIN'], userId: 'admin-idx' } as Context);

  it('a system memory with the setting off is vector-searchable by explicit scope; a knowledge memory with it off is not', async () => {
    const sys = await node(await memory({ cls: 'system', flag: false }), 'a', 'q');
    const kn = await node(await memory({ cls: 'knowledge', flag: false }), 'a', 'q');
    await embedNode(db, sys.id); await embedNode(db, kn.id);
    expect((await find([sys.memoryId])).hits.map((h: any) => h.node.id)).toEqual([sys.id]);
    expect((await find([kn.memoryId])).hits).toEqual([]);
  });
});

describe('other sites that decide whether a write is queued', () => {
  it('a node moved into a system memory (setting off) is queued; into a knowledge memory (setting off) it is not', async () => {
    const src = await memory({ cls: 'knowledge', flag: false });
    const sys = await memory({ cls: 'system', flag: false });
    const kn = await memory({ cls: 'knowledge', flag: false });
    const a = await node(src, 'mv-a', 'sum');
    const b = await node(src, 'mv-b', 'sum');
    await db.node.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { embeddingPendingAt: null } });
    const M = resolvers.Mutation as any;
    const intoSys = await M.moveNode(null, { sourceRef: a.id, targetMemoryRef: sys }, adminCtx());
    const intoKn = await M.moveNode(null, { sourceRef: b.id, targetMemoryRef: kn }, adminCtx());
    expect((await db.node.findUniqueOrThrow({ where: { id: intoSys.id } })).embeddingPendingAt).not.toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: intoKn.id } })).embeddingPendingAt).toBeNull();
  });

  it('reviving an old embed on a system memory re-queues it; on a knowledge memory with the setting off it does not', async () => {
    const { pendingAtForRevival } = await import('../services/embedding/enqueue.js');
    expect(pendingAtForRevival(null, memoryIsVectorIndexed({ class: 'system', vectorIndexEnabled: false }))).toBeInstanceOf(Date);
    expect(pendingAtForRevival(null, memoryIsVectorIndexed({ class: 'knowledge', vectorIndexEnabled: false }))).toBeNull();
  });
});

describe('the provisioning seam: promoting a memory to system stamps its existing nodes', () => {
  it('createAgent with a systemMemoryId and updateAgent promote queue the memory\'s nodes', async () => {
    const m1 = await memory({ cls: 'knowledge', flag: false });
    const n1 = await node(m1, 'a', 'sum');
    await db.node.update({ where: { id: n1.id }, data: { embeddingPendingAt: null } });
    const agent = await (resolvers.Mutation as any).createAgent({}, { orgId, name: 'Promoter', systemMemoryId: m1 }, adminCtx());
    expect(agent.systemMemoryId).toBe(m1);
    expect((await db.node.findUniqueOrThrow({ where: { id: n1.id } })).embeddingPendingAt).not.toBeNull();

    const m2 = await memory({ cls: 'knowledge', flag: false });
    const n2 = await node(m2, 'a', 'sum');
    await db.node.update({ where: { id: n2.id }, data: { embeddingPendingAt: null } });
    // an agent with no system memory yet (first attach is the promote path)
    const plain = await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: 'idx2199:plain', name: 'Plain' } });
    await (resolvers.Mutation as any).updateAgent({}, { ref: plain.id, systemMemoryId: m2 }, adminCtx());
    expect((await db.memory.findUniqueOrThrow({ where: { id: m2 } })).class).toBe('system');
    expect((await db.node.findUniqueOrThrow({ where: { id: n2.id } })).embeddingPendingAt).not.toBeNull();
  });
});

describe('the bounded, resumable backfill', () => {
  async function seed(count: number, opts: { blank?: number } = {}) {
    const m = await memory({ cls: 'system', flag: false });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const n = await db.node.create({ data: { id: generateId(), memoryId: m, loc: `n${String(i).padStart(3, '0')}`, name: `n${i}`, abstract: i < (opts.blank ?? 0) ? '  ' : `abstract ${i}`, content: 'c' } });
      ids.push(n.id);
    }
    return { m, ids };
  }

  it('one batch inspects at most the limit, stamps the eligible, and the cursor advances over skipped rows', async () => {
    const { m } = await seed(10, { blank: 4 });
    const a = await stampMemoryEmbeddingsBatch(db, m, { limit: 4 });
    expect(a).toMatchObject({ inspected: 4, eligible: 0, stamped: 0, done: false }); // all four blank: still progress
    const b = await stampMemoryEmbeddingsBatch(db, m, { limit: 4, afterNodeId: a.nextAfterNodeId });
    expect(b).toMatchObject({ inspected: 4, eligible: 4, stamped: 4, done: false });
    const c = await stampMemoryEmbeddingsBatch(db, m, { limit: 4, afterNodeId: b.nextAfterNodeId });
    expect(c).toMatchObject({ inspected: 2, stamped: 2, done: true });
    expect(await db.node.count({ where: { memoryId: m, embeddingPendingAt: { not: null } } })).toBe(6);
  });

  it('idempotent: nothing is stamped twice; a node already embedded, queued, failed, deleted or abstract-less is left alone', async () => {
    const { m, ids } = await seed(5);
    await db.node.update({ where: { id: ids[0]! }, data: { embeddingPendingAt: new Date() } }); // queued
    await db.node.update({ where: { id: ids[1]! }, data: { embeddingFailedAt: new Date() } }); // failed
    await db.node.update({ where: { id: ids[2]! }, data: { deletedAt: new Date() } }); // deleted
    await embedNode(db, ids[3]!); // already has its summary vector (drains as a system memory)
    const first = await stampMemoryEmbeddingsBatch(db, m, { limit: 50 });
    expect(first.eligible).toBe(1); // only ids[4] qualifies, before the guarded write even runs
    expect(first.stamped).toBe(1);
    const again = await stampMemoryEmbeddingsBatch(db, m, { limit: 50 });
    expect(again.stamped).toBe(0);
  });

  it('dry run writes nothing and reports the same counts an apply would stamp', async () => {
    const { m } = await seed(6);
    const dry = await stampMemoryEmbeddingsBatch(db, m, { limit: 50, dryRun: true });
    expect(dry).toMatchObject({ eligible: 6, stamped: 0 });
    expect(await db.node.count({ where: { memoryId: m, embeddingPendingAt: { not: null } } })).toBe(0);
  });

  it('a node that was queued after the read is not touched (guarded write)', async () => {
    const { m, ids } = await seed(3);
    const spy = vi.spyOn(db, '$queryRaw');
    spy.mockImplementationOnce((async () => {
      await db.node.update({ where: { id: ids[0]! }, data: { embeddingPendingAt: new Date(Date.now() - 5000) } });
      spy.mockRestore();
      return [{ id: ids[0]!, eligible: true }, { id: ids[1]!, eligible: true }, { id: ids[2]!, eligible: true }];
    }) as never);
    const r = await stampMemoryEmbeddingsBatch(db, m, { limit: 10 });
    spy.mockRestore();
    expect(r.eligible).toBe(3);
    expect(r.stamped).toBe(2); // ids[0] was queued meanwhile
  });

  it('the job walks memories under a node budget, resumes from its cursor, finishes, and a re-run does nothing', async () => {
    const a = await seed(7);
    const b = await seed(5);
    const user = await memory({ cls: 'knowledge', flag: true });
    await node(user, 'k', 'must never be a target'); // a user's memory is never a target
    await db.node.updateMany({ where: { memoryId: { in: [a.m, b.m, user] } }, data: { embeddingPendingAt: null } });
    const ordered = [a.m, b.m].sort();
    let cursor: string | null = null;
    let runs = 0;
    let stamped = 0;
    do {
      const r = await backfillSystemMemoryEmbeddings(db, { apply: true, nodeLimit: 5, batch: 3, after: cursor });
      expect(r.inspected).toBeLessThanOrEqual(5);
      stamped += r.stamped;
      cursor = r.cursor;
      runs += 1;
      expect(runs).toBeLessThan(10);
      if (r.complete) break;
    } while (cursor);
    expect(stamped).toBe(12);
    expect(runs).toBeGreaterThan(1); // partial results were disclosed and resumed
    expect(await db.node.count({ where: { memoryId: user, embeddingPendingAt: { not: null } } })).toBe(0);
    expect(ordered).toHaveLength(2);
    const rerun = await backfillSystemMemoryEmbeddings(db, { apply: true, nodeLimit: 500 });
    expect(rerun).toMatchObject({ stamped: 0, complete: true, cursor: null });
  });

  it('dry run by default writes nothing; the cursor parses; deleted and non-system memories are never listed', async () => {
    const { m } = await seed(4);
    const gone = await seed(2);
    await db.memory.update({ where: { id: gone.m }, data: { deletedAt: new Date() } });
    const r = await backfillSystemMemoryEmbeddings(db, {});
    expect(r.mode).toBe('dry-run');
    expect(r.stamped).toBe(0);
    expect(r.perMemory.map((p) => p.memoryId)).toEqual([m]);
    expect(await db.node.count({ where: { memoryId: m, embeddingPendingAt: { not: null } } })).toBe(0);
    expect(parseCursor('mem:node')).toEqual({ memoryId: 'mem', nodeId: 'node' });
    expect(parseCursor(null)).toBeNull();
  });

  it('"blank" is what the drain says it is: SQL eligibility equals JS trim() for tab, newline, NBSP, line separators, BOM', async () => {
    const m = await memory({ cls: 'system', flag: false });
    const samples = [' ', '\n', '\t', '\r\n', '\u00a0', '\u2028', '\u2029', '\ufeff', '\u3000', '\u2003', ' \n\t ', 'x', ' x ', '\nx\n', '\u200b', 'a b'];
    for (const [i, a] of samples.entries()) {
      await db.node.create({ data: { id: generateId(), memoryId: m, loc: `b${String(i).padStart(2, '0')}`, name: `b${i}`, abstract: a, content: 'c' } });
    }
    const dry = await stampMemoryEmbeddingsBatch(db, m, { limit: 100, dryRun: true });
    expect(dry.eligible).toBe(samples.filter((a) => a.trim() !== '').length);
    // and the loop the old check allowed cannot happen: stamp, drain, re-run ⇒ nothing left to stamp
    await stampMemoryEmbeddingsBatch(db, m, { limit: 100 });
    await drainEmbeddingQueue(db, { client: stub });
    const again = await stampMemoryEmbeddingsBatch(db, m, { limit: 100 });
    expect(again).toMatchObject({ eligible: 0, stamped: 0 });
  });

  it('the parent is revalidated: a memory soft-deleted or no longer system after the inventory is not stamped', async () => {
    for (const change of [{ deletedAt: new Date() }, { class: 'knowledge', visibility: 'ORGANIZATION', acceptsUploads: true }] as const) {
      const { m, ids } = await seed(3);
      const spy = vi.spyOn(db, '$queryRaw');
      spy.mockImplementationOnce((async () => {
        await db.memory.update({ where: { id: m }, data: change as never });
        spy.mockRestore();
        return ids.map((id) => ({ id, eligible: true }));
      }) as never);
      const r = await stampMemoryEmbeddingsBatch(db, m, { limit: 10 });
      spy.mockRestore();
      expect(r.eligible).toBe(3);
      expect(r.stamped).toBe(0);
      expect(await db.node.count({ where: { memoryId: m, embeddingPendingAt: { not: null } } })).toBe(0);
    }
    // and a memory that is already gone is not even inspected
    const { m } = await seed(2);
    await db.memory.update({ where: { id: m }, data: { deletedAt: new Date() } });
    expect(await stampMemoryEmbeddingsBatch(db, m, { limit: 10 })).toMatchObject({ inspected: 0, done: true });
  });

  it('the command line is strict: unknown flags and non-integers are refused, never silently dropped', () => {
    expect(parseBackfillArgs(['--apply', '--node-limit', '200', '--batch', '50', '--after', 'm1:n9'])).toEqual({ apply: true, nodeLimit: 200, batch: 50, after: 'm1:n9' });
    for (const bad of [['--batch', 'abc'], ['--node-limit', '0'], ['--node-limit', '-5'], ['--node-limit', '1e3'], ['--memory-limit'], ['--x=v'], ['--aply'], ['--after', 'nocolon']]) {
      expect(() => parseBackfillArgs(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('every job query runs under the statement timeout, the first memory listing included; the report counts encrypted system memories', async () => {
    await seed(1);
    const seen: string[] = [];
    const orig = db.$transaction.bind(db) as any;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: any, opts: any) =>
      orig(async (tx: any) => fn(new Proxy(tx, {
        get(target, key) {
          if (key === '$executeRawUnsafe') return (q: string, ...a: unknown[]) => { seen.push(q); return target.$executeRawUnsafe(q, ...a); };
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      })), opts)) as any);
    const r = await backfillSystemMemoryEmbeddings(db, {});
    spy.mockRestore();
    expect(r.encryptedSystemMemories).toBe(0);
    // one SET LOCAL for the memory listing + one per batch
    expect(seen.filter((q) => /statement_timeout/.test(q)).length).toBeGreaterThanOrEqual(2);
  });
});
