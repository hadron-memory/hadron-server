/**
 * Integration tests for the `where` predicate compiler (#719): compile a
 * predicate, execute the generated SQL against a real Postgres over seeded
 * nodes, assert which rows come back. This is what flips the compiler from
 * string-tested (nodeWhere.test.ts) to actually-executing — it proves the
 * generated SQL is valid, the guard functions from the migration exist and
 * behave (junk stored values / bad bounds drop the row instead of raising a
 * cast error → 500), and that quoted values are safely parameterized end to end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { compileNodeWhere, type NodeWhere } from './nodeWhere.js';

let memId: string;

async function mkNode(loc: string, fields: Record<string, unknown>) {
  await db.node.create({ data: { id: generateId(), memoryId: memId, loc, name: loc, ...fields } as any });
}

/** Compile `pred` and run `SELECT loc ... WHERE memory_id AND <pred>` — returns matching locs, sorted. */
async function run(pred: NodeWhere): Promise<string[]> {
  const params: unknown[] = [];
  const bind = (v: unknown) => `$${params.push(v)}`;
  const expr = compileNodeWhere(pred, bind);
  const mem = bind(memId);
  const sql = `SELECT loc FROM nodes WHERE memory_id = ${mem} AND deleted_at IS NULL AND ${expr} ORDER BY loc`;
  const rows = await db.$queryRawUnsafe<{ loc: string }[]>(sql, ...params);
  return rows.map((r) => r.loc);
}

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'nw-org', graphName: 'nw/graph' });
  memId = made.graph.id;

  await mkNode('insight.a', {
    properties: { sourceKind: 'substack', extractedAt: '2026-07-10T00:00:00Z', confidence: '0.9', actors: ['acme', 'globex'] },
  });
  await mkNode('insight.b', {
    properties: { sourceKind: 'reddit', extractedAt: '2026-06-01T00:00:00Z', confidence: '0.4' },
  });
  // Junk date + junk number — must be dropped by the guards, NOT 500.
  await mkNode('insight.c', {
    properties: { sourceKind: 'substack', extractedAt: 'not-a-date', confidence: 'high' },
  });
  // Missing extractedAt / confidence / actors entirely.
  await mkNode('insight.d', { properties: { sourceKind: 'substack' } });
  // Apostrophe in a value — proves the bound RHS is safely parameterized.
  await mkNode('insight.e', { properties: { sourceKind: "o'brien & co" } });
  // data-column node.
  await mkNode('flow.x', { properties: {}, data: { tools: ['web_search', 'hadron_find_nodes'] } });
});

describe('nodeWhere — executes against Postgres', () => {
  it('eq on a text property', async () => {
    expect(await run({ path: ['sourceKind'], eq: 'substack' })).toEqual(['insight.a', 'insight.c', 'insight.d']);
  });

  it('safely parameterizes a value containing a quote', async () => {
    expect(await run({ path: ['sourceKind'], eq: "o'brien & co" })).toEqual(['insight.e']);
  });

  it('datetime range: junk and missing dates drop out (no cast-error 500)', async () => {
    // Only insight.a has a valid date >= the bound; insight.c ('not-a-date')
    // and insight.d (missing) must silently drop via hadron_safe_timestamptz.
    const locs = await run({
      and: [
        { path: ['sourceKind'], eq: 'substack' },
        { path: ['extractedAt'], as: 'datetime', gte: '2026-07-01T00:00:00Z' },
      ],
    });
    expect(locs).toEqual(['insight.a']);
  });

  it('number comparison: junk numeric drops out (no cast-error 500)', async () => {
    // b=0.4 matches; a=0.9 doesn't; c='high' and d/e/flow (no confidence) drop.
    expect(await run({ path: ['confidence'], as: 'number', lt: 0.5 })).toEqual(['insight.b']);
  });

  it('exists: key present', async () => {
    expect(await run({ path: ['actors'], exists: true })).toEqual(['insight.a']);
  });

  it('contains: array membership via @>', async () => {
    expect(await run({ path: ['actors'], contains: ['acme'] })).toEqual(['insight.a']);
  });

  it('in: multi-value text match', async () => {
    expect(await run({ path: ['sourceKind'], in: ['reddit', 'substack'] })).toEqual([
      'insight.a',
      'insight.b',
      'insight.c',
      'insight.d',
    ]);
  });

  it('data column selector: contains over data.tools', async () => {
    expect(await run({ field: 'data', path: ['tools'], contains: 'web_search' })).toEqual(['flow.x']);
  });

  it('or composition across columns', async () => {
    const locs = await run({
      or: [
        { path: ['sourceKind'], eq: 'reddit' },
        { field: 'data', path: ['tools'], contains: 'web_search' },
      ],
    });
    expect(locs).toEqual(['flow.x', 'insight.b']);
  });
});
