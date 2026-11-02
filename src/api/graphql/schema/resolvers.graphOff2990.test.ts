/**
 * #2990 — graph view OFF (temporary degradation, Holger 2026-10-31): `memoryNodes` / `memoryEdges` answer the empty page
 * before any read while `GRAPH_VIEW_DISABLED` is on (the default), so lifting it is a config change. Readable,
 * unreadable and missing memories answer the byte-identical page (no existence oracle); with the flag off the queries
 * behave as before. The test suite pins the flag OFF in vitest.config.ts, so these pins set it explicitly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const ctx = (o: Partial<Context> = {}): Context => ({ db, ...o });
const EMPTY_NODES = '{"nodes":[],"total":0}';
const EMPTY_EDGES = '{"edges":[],"total":0}';
/** A db that fails the test on ANY use: the flagged path must return before touching the database at all. */
const untouchable = (): Context => ({
  db: new Proxy({}, { get: (_t, prop) => { throw new Error(`db.${String(prop)} touched with the graph view off`); } }) as never,
  userId: 'someone', roles: ['ADMIN'],
});

let mem: { id: string; urn: string };
let readerCtx: Context;
let strangerCtx: Context;

beforeEach(async () => {
  delete process.env.GRAPH_VIEW_DISABLED;
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'go-org', graphName: 'go/graph' });
  mem = { id: made.graph.id, urn: made.graph.urn };
  const a = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'n.a', name: 'a', tags: [] } as any });
  const b = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'n.b', name: 'b', tags: [] } as any });
  await db.edge.create({ data: { id: generateId(), memoryId: mem.id, loc: 'e.ab', sourceId: a.id, targetId: b.id } as any });
  const other = await createDbOrgAndGraph(db, { orgName: 'go-other', graphName: 'goo/graph' });
  const stranger = await db.user.create({ data: { githubId: 6290, githubUsername: 'go-stranger', roles: [] } });
  await db.orgMember.create({ data: { organizationId: other.org.id, userId: stranger.id, role: 'READER' } });
  strangerCtx = ctx({ userId: stranger.id, roles: [] });
  readerCtx = ctx({ roles: ['ADMIN'], userId: 'admin-go' });
});

afterEach(() => {
  delete process.env.GRAPH_VIEW_DISABLED;
});

describe('#2990 the flag is ON by default', () => {
  it('memoryNodes and memoryEdges answer the empty page for a readable memory that has rows', async () => {
    expect(JSON.stringify(await Q.memoryNodes(null, { memoryRef: mem.id }, readerCtx))).toBe(EMPTY_NODES);
    expect(JSON.stringify(await Q.memoryEdges(null, { memoryRef: mem.id }, readerCtx))).toBe(EMPTY_EDGES);
  });

  it('answers before any database read: no node, edge or memory row is touched', async () => {
    for (const args of [{ memoryRef: mem.id }, { memoryRef: mem.urn, limit: 0 }, { memoryRef: 'no-such', limit: 50, offset: 10 }]) {
      expect(JSON.stringify(await Q.memoryNodes(null, args, untouchable()))).toBe(EMPTY_NODES);
      expect(JSON.stringify(await Q.memoryEdges(null, args, untouchable()))).toBe(EMPTY_EDGES);
    }
  });

  it('readable, unreadable and missing memories answer the byte-identical page (no existence oracle, no readability leak)', async () => {
    const refs: [string, Context][] = [[mem.id, readerCtx], [mem.id, strangerCtx], ['missing-memory-ref', readerCtx], [mem.urn, ctx()]];
    for (const [memoryRef, c] of refs) {
      expect(JSON.stringify(await Q.memoryNodes(null, { memoryRef }, c))).toBe(EMPTY_NODES);
      expect(JSON.stringify(await Q.memoryEdges(null, { memoryRef }, c))).toBe(EMPTY_EDGES);
    }
  });

  it('limit: 0 does not reveal a count either', async () => {
    expect(JSON.stringify(await Q.memoryNodes(null, { memoryRef: mem.id, limit: 0 }, readerCtx))).toBe(EMPTY_NODES);
  });

  it('only the exact value "false" lifts it; empty, junk and other casings keep the degradation', async () => {
    for (const v of ['', 'off', 'FALSE', 'False', '0', 'no', ' false', 'true']) {
      process.env.GRAPH_VIEW_DISABLED = v;
      expect(JSON.stringify(await Q.memoryNodes(null, { memoryRef: mem.id }, readerCtx)), JSON.stringify(v)).toBe(EMPTY_NODES);
      expect(JSON.stringify(await Q.memoryEdges(null, { memoryRef: mem.id }, readerCtx)), JSON.stringify(v)).toBe(EMPTY_EDGES);
    }
  });
});

describe('#2990 with GRAPH_VIEW_DISABLED=false the queries behave as before', () => {
  beforeEach(() => { process.env.GRAPH_VIEW_DISABLED = 'false'; });

  it('a readable memory returns its rows and totals', async () => {
    const nodes = await Q.memoryNodes(null, { memoryRef: mem.id }, readerCtx);
    expect(nodes.total).toBe(2);
    expect(nodes.nodes.map((n: any) => n.loc)).toEqual(['n.a', 'n.b']);
    const edges = await Q.memoryEdges(null, { memoryRef: mem.id }, readerCtx);
    expect(edges.total).toBe(1);
    expect(edges.edges.map((e: any) => e.loc)).toEqual(['e.ab']);
  });

  it('limit: 0 still returns just the total', async () => {
    const page = await Q.memoryNodes(null, { memoryRef: mem.id, limit: 0 }, readerCtx);
    expect(page).toEqual({ nodes: [], total: 2 });
  });

  it('an unreadable or missing memory still returns the identical empty page (no oracle with the flag off either)', async () => {
    for (const [memoryRef, c] of [[mem.id, strangerCtx], [generateId(), readerCtx]] as [string, Context][]) {
      expect(JSON.stringify(await Q.memoryNodes(null, { memoryRef }, c))).toBe(EMPTY_NODES);
      expect(JSON.stringify(await Q.memoryEdges(null, { memoryRef }, c))).toBe(EMPTY_EDGES);
    }
  });

  it('the flag is read per call: turning it back on empties the page without a restart', async () => {
    expect((await Q.memoryNodes(null, { memoryRef: mem.id }, readerCtx)).total).toBe(2);
    delete process.env.GRAPH_VIEW_DISABLED;
    expect(JSON.stringify(await Q.memoryNodes(null, { memoryRef: mem.id }, readerCtx))).toBe(EMPTY_NODES);
  });
});
