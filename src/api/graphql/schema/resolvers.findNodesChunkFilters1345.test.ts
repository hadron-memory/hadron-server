import { randomUUID } from 'node:crypto';
/**
 * #1345 review (@codex P2, echoed by Copilot) — chunk-granularity passages honor
 * every structured node filter, not just #719's `where`.
 *
 * `hadron_find_nodes` promises `role` (#1322) and `isRunnable` "in every mode";
 * the chunk branch applied neither, so `role: "spec"` returned passages from
 * parents of any role. The fix applies the node path's own `structuredWhere`
 * to each passage's PARENT, and does it BEFORE paging, so a filtered-out
 * passage neither appears in the page nor consumes one of its slots.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const DIM = 768;
// Every chunk and the query embed identically, so every chunk is a vector hit.
const stub: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map(() => {
      const v = new Array(DIM).fill(0);
      v[1] = 1;
      return v;
    });
  },
};

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-cf' } as Context);
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());
const chunks = (filter: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  findNodes({ query: 'q', mode: 'vector', granularity: 'chunk', filter: { memoryIds: [memId], ...filter }, ...extra });
const parentsOf = (res: { passages: { parentNodeId: string }[] }) => new Set(res.passages.map((p) => p.parentNodeId));

let memId: string;
const ids: Record<string, string> = {};
async function seed(loc: string, fields: Record<string, unknown>) {
  const id = generateId();
  await db.node.create({
    data: { id, memoryId: memId, loc, name: loc, content: `${loc} content body about memory`, embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date(), ...fields } as any,
  });
  expect(await embedNode(db, id)).toBe('embedded');
  ids[loc] = id;
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stub);
  const made = await createDbOrgAndGraph(db, { orgName: 'cf-org', graphName: 'cf/graph' });
  memId = made.graph.id;
  await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  await seed('s1', { role: 'spec' });
  await seed('s2', { role: 'spec.rule' });
  await seed('sp', { role: 'special' });
  await seed('rv', { role: 'review', properties: { k: 'v' } });
  await seed('pl', {});
  await seed('tk', { isRunnable: true });
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

describe('#1345 — structured filters apply to chunk passages', () => {
  it('role "spec" returns passages only from the spec family, on a dot boundary', async () => {
    const res = await chunks({ role: 'spec' });
    expect(parentsOf(res)).toEqual(new Set([ids.s1, ids.s2]));
  });

  it('isRunnable is honored too (the older "every mode" promise)', async () => {
    expect(parentsOf(await chunks({ isRunnable: true }))).toEqual(new Set([ids.tk]));
  });

  it('filters BEFORE paging: a filtered-out passage never consumes a slot', async () => {
    // One matching parent among six. With paging first, a limit-1 page could be
    // a non-spec passage that the filter then removes, returning nothing.
    const res = await chunks({ role: 'spec.rule' }, { limit: 1 });
    expect(res.passages).toHaveLength(1);
    expect(res.passages[0].parentNodeId).toBe(ids.s2);
  });

  it('CONTROL: with no filter, every parent can surface', async () => {
    const res = await chunks({}, { limit: 50 });
    expect(parentsOf(res)).toEqual(new Set(Object.values(ids)));
  });

  it('composes with #719 where: both must hold', async () => {
    const res = await chunks({ role: 'review', where: { path: ['k'], eq: 'v' } });
    expect(parentsOf(res)).toEqual(new Set([ids.rv]));
    expect((await chunks({ role: 'spec', where: { path: ['k'], eq: 'v' } })).passages).toEqual([]);
  });
});
