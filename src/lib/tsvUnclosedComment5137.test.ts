/**
 * #5137: a node write was quadratic in an unclosed `<!--` (the default parser rescans to the end of the text for a `-->`
 * from every opener, through the `tsv` generated column). Judged by outcome: the write finishes inside a bound at a pinned size
 * and at one doubling, the stored tsvector is what the unfixed expression gives (search signal unchanged), and nothing new refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from './id.js';

const BOUND_MS = 1000; // end to end, one node write
const SIZE = 49_152; // 49 KB of `<!--`: about 2.5 s on main
const OPENERS = SIZE / 4;

let memoryId: string;

beforeEach(async () => {
  await cleanDb(db);
  memoryId = (await createDbOrgAndGraph(db)).graph.id;
});

const timed = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

/** The pre-#5137 expression, written out: the reference the stored column must still equal. */
const referenceTsv = async (id: string) => {
  const rows = await db.$queryRaw<{ same: boolean }[]>`
    SELECT n.tsv = (
      setweight(to_tsvector('english', coalesce(n.name, '') || ' ' || coalesce(n.alias, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(n.loc, '') || ' ' || array_to_string(coalesce(n.tags, ARRAY[]::text[]), ' ')), 'B') ||
      setweight(to_tsvector('english', coalesce(n.description, '') || ' ' || coalesce(n.abstract, '')), 'C') ||
      setweight(to_tsvector('english', left(coalesce(n.content, '') || ' ' || coalesce(n.properties::text, '') || ' ' || coalesce(n.data::text, ''), 1000000)), 'D')
    ) AS same FROM nodes n WHERE n.id = ${id}`;
  return rows[0].same;
};

describe('a node write with an unclosed <!-- body', () => {
  it(`creates inside ${BOUND_MS} ms at ${SIZE} bytes and at one doubling`, async () => {
    for (const size of [SIZE, SIZE * 2]) {
      const ms = await timed(() => db.node.create({ data: { id: generateId(), memoryId, loc: `a${size}`, name: 'n', content: '<!--'.repeat(size / 4) } }));
      expect(ms, `${size} bytes`).toBeLessThan(BOUND_MS);
    }
  });

  it(`updates inside ${BOUND_MS} ms, in the name and description legs too`, async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'u', name: 'n', content: 'x' } });
    const ms = await timed(() => db.node.update({ where: { id: n.id }, data: { content: '<!--'.repeat(OPENERS), description: '<!--'.repeat(OPENERS), name: '<!--'.repeat(OPENERS) } }));
    expect(ms).toBeLessThan(BOUND_MS * 2);
  });

  it('indexes as nothing, as before', async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'e', name: 'n', content: '<!--'.repeat(100) } });
    const [{ d }] = await db.$queryRaw<{ d: string }[]>`SELECT tsv::text AS d FROM nodes WHERE id = ${n.id}`;
    expect(d).toBe("'e':2B 'n':1A"); // loc + name only; the content leg contributes nothing
    expect(await referenceTsv(n.id)).toBe(true);
  });
});

describe('the search signal does not change', () => {
  const shapes = [
    'foo <!-- bar baz',
    'foo <!-- bar --> baz',
    'a <!-- b --> c <!-- d <!-- e',
    '<!-- x --> y <!-- z',
    '<!---->hello<!-- world',
    '<!--> tricky <!-- open',
    'plain words with <a href="x">link</a> and &amp; entity',
    '<!-- one --> <!-- two --> three <!-- four <!-- five',
    '--> stray closer <!-- opener',
    'trailing <!--',
  ];
  it.each(shapes)('stored tsv equals the unfixed expression: %s', async (content) => {
    const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'p', name: 'Name <!-- here', description: 'desc <!-- d', content } });
    expect(await referenceTsv(n.id)).toBe(true);
  });

  it('a findNodes-style text match still hits the words after an unclosed opener', async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'm', name: 'n', content: 'before <!-- zebrawordxyz after' } });
    const hit = await db.$queryRaw<{ id: string }[]>`SELECT id FROM nodes WHERE id = ${n.id} AND tsv @@ plainto_tsquery('english', 'zebrawordxyz')`;
    expect(hit).toHaveLength(1);
  });
});

describe('the helper', () => {
  it('leaves text with no opener, and an opener before the last closer, untouched', async () => {
    const rows = await db.$queryRaw<{ a: string; b: string; c: string }[]>`
      SELECT hadron_tsv_unclosed_comment('no markup') AS a,
             hadron_tsv_unclosed_comment('x <!-- y --> z') AS b,
             hadron_tsv_unclosed_comment('x <!-- y --> z <!-- w') AS c`;
    expect(rows[0]).toEqual({ a: 'no markup', b: 'x <!-- y --> z', c: 'x <!-- y --> z <!- w' });
  });
});
