/**
 * #2999 (cor:api:060:04, cor:dmo:060:03): runnability is tri-state. On every
 * filtered path `isRunnable: false` returns ONLY rows explicitly marked not
 * runnable; a never-marked (NULL) row matches neither `true` nor `false`, and
 * only an omitted filter returns it. These pins lock today's behavior in: they
 * are green on main by design and go red when a path treats `false` as NULL.
 *
 * Paths: edges, findNodes filter-only list, appNodes, and ranked retrieval
 * (findNodes with a query, in keyword and hybrid modes).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { postgresRetrievalProvider as provider } from '../../../lib/retrieval/postgres.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-tristate' });
const Q = resolvers.Query as any;

let memoryId: string;
let appId: string;
const LOCS = { unset: 'tri.unset', no: 'tri.no', yes: 'tri.yes' } as const;
const ALL = [LOCS.no, LOCS.unset, LOCS.yes].sort();

beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'tri-org', graphName: 'tri/graph' });
  memoryId = graph.id;
  const mk = (loc: string, isRunnable?: boolean) =>
    db.node.create({
      data: {
        id: generateId(), memoryId, loc, name: `tristate marker ${loc}`,
        ...(isRunnable === undefined ? {} : { isRunnable }),
      } as any,
    });
  const unset = await mk(LOCS.unset);
  const no = await mk(LOCS.no, false);
  const yes = await mk(LOCS.yes, true);
  // Edges: one per state, each from a distinct source so locs differ.
  const mkEdge = (loc: string, from: string, isRunnable?: boolean) =>
    db.edge.create({
      data: {
        id: generateId(), memoryId, sourceId: from, targetId: unset.id, name: 'tri', loc,
        ...(isRunnable === undefined ? {} : { isRunnable }),
      } as any,
    });
  await mkEdge('e.unset', no.id);
  await mkEdge('e.no', yes.id, false);
  await mkEdge('e.yes', no.id, true);
  // appNodes needs the memory installed through an agent on an app.
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.id}:tri-agent`, name: 'tri-agent' },
  });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId, role: 'read-write' } });
  const { app } = await createDbAppWithKey(db, 'tri-app', org.id);
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  appId = app.id;
});

/** The filter variants: false, true, omitted. */
const variants: Array<[string, boolean | undefined, string[]]> = [
  ['false returns only the explicit-false row', false, [LOCS.no]],
  ['true returns only the true row', true, [LOCS.yes]],
  ['an omitted filter returns all three', undefined, ALL],
];
const runnable = (v: boolean | undefined) => (v === undefined ? {} : { isRunnable: v });

describe('edges', () => {
  const edgeLocs = (res: any) => res.items.map((e: any) => e.loc).sort();
  for (const [name, v, want] of variants) {
    it(name, async () => {
      const res = await Q.edges(null, { filter: { memoryId, ...runnable(v) } }, admin());
      const map: Record<string, string> = { [LOCS.unset]: 'e.unset', [LOCS.no]: 'e.no', [LOCS.yes]: 'e.yes' };
      expect(edgeLocs(res)).toEqual(want.map((l) => map[l]!).sort());
    });
  }
});

describe('findNodes filter-only list', () => {
  for (const [name, v, want] of variants) {
    it(name, async () => {
      const res = await Q.findNodes(null, { filter: { memoryIds: [memoryId], ...runnable(v) } }, admin());
      expect(res.hits.map((h: any) => h.node.loc).sort()).toEqual(want);
    });
  }
});

describe('appNodes', () => {
  for (const [name, v, want] of variants) {
    it(name, async () => {
      const nodes = await Q.appNodes(null, { appRef: appId, filter: runnable(v) }, admin());
      expect(nodes.map((n: any) => n.loc).sort()).toEqual(want);
    });
  }
});

describe('ranked retrieval (findNodes with a query)', () => {
  for (const mode of ['keyword', 'hybrid'] as const) {
    describe(mode, () => {
      for (const [name, v, want] of variants) {
        it(name, async () => {
          const res = await Q.findNodes(
            null,
            { query: 'tristate marker', mode, filter: { memoryIds: [memoryId], ...runnable(v) } },
            admin(),
          );
          expect(res.hits.map((h: any) => h.node.loc).sort()).toEqual(want);
        });
      }
    });
  }
});

// findNodes re-applies the same filter when it hydrates ranked hits, so the
// retrieval layer's own `is_runnable` clause (postgres.ts filterClause, shared
// by every mode's query) is shadowed there. Pin it directly, per query shape.
describe('retrieval provider filterClause', () => {
  const idsToLocs = async (ids: string[]) =>
    (await db.node.findMany({ where: { id: { in: ids } }, select: { loc: true } })).map((n) => n.loc).sort();
  for (const [name, v, want] of variants) {
    describe(name, () => {
      const filter = v === undefined ? {} : { isRunnable: v };
      it('lexicalSearch (ranked)', async () => {
        const hits = await provider.lexicalSearch({ db, query: 'tristate', memoryIds: [memoryId], filter, limit: 50 } as any);
        expect(await idsToLocs(hits.map((h) => h.nodeId))).toEqual(want);
      });
      it('filterSearch (browse)', async () => {
        const ids = await provider.filterSearch({ db, memoryIds: [memoryId], filter, limit: 50 });
        expect(await idsToLocs(ids)).toEqual(want);
      });
      it('filterCount', async () => {
        expect(await provider.filterCount({ db, memoryIds: [memoryId], filter })).toBe(want.length);
      });
    });
  }
});
