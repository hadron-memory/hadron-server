/** #3601: control characters are data, never structural separators. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { readLocSegments, decodeLocSegmentsCursor } from './memoryLocSegments.js';

let memoryId: string;
beforeAll(async () => {
  await cleanDb(db);
  memoryId = (await createDbOrgAndGraph(db, { orgName:'collision3601', graphName:'collision3601' })).graph.id;
});
beforeEach(async () => { await db.node.deleteMany({ where:{ memoryId } }); });
afterAll(async () => { await cleanDb(db); });
const read = (parent = '', limit = 200, after: ReturnType<typeof decodeLocSegmentsCursor> = null) =>
  readLocSegments(db, { memoryIds:[memoryId], excludeNodeIds:[], parent, limit, after });
async function seed(locs: string[]) {
  await db.node.createMany({ data:locs.map((loc,i) => ({ id:`collision3601-${i}`, memoryId, loc, name:'fixture' })) });
}
describe('#3601 collision-safe loc keys', () => {
  it('deep walk retains a node-less branch beside a literal chr(1) sibling', async () => {
    await seed(['a:b:c', 'a\u0001b']);
    expect((await read()).items).toEqual([
      { segment:'a', hasNode:false, memoryId },
      { segment:'a\u0001b', hasNode:true, memoryId },
    ]);
  });
  it('deep walk visits control-bearing parents and excludes their similarly prefixed siblings', async () => {
    await seed(['a:b', 'a:c', 'a\u0001b', 'a\u0001b:child', 'a\u0002b:leaf', 'a\u00021b:other', 'z']);
    expect((await read()).items.map(x => x.segment)).toEqual(['a','a\u0001b','a\u00021b','a\u0002b','z']);
    expect((await read('a\u0001b')).items.map(x => x.segment)).toEqual(['child']);
    expect((await read('a\u0002b')).items.map(x => x.segment)).toEqual(['leaf']);
  });
  it('flat block continuation and raw tuple cursors retain every control/astral sibling once', async () => {
    const locs = Array.from({length:130}, (_,i) => `flat:n${String(i).padStart(3,'0')}`);
    locs.push('flat:a\u0001b','flat:a\u0002b','flat:a\u00021b','flat:😀');
    await seed(locs);
    const seen: string[] = [];
    let after: ReturnType<typeof decodeLocSegmentsCursor> = null;
    for (let pages=0; pages<100; pages++) {
      const page = await read('flat', 7, after);
      seen.push(...page.items.map(x => x.segment));
      if (!page.hasMore) break;
      after = decodeLocSegmentsCursor(page.endCursor!);
      expect(after).not.toBeNull();
    }
    // Independent SQL uses raw locs, not the key under test.
    const expected = await db.$queryRaw<Array<{segment:string}>>`SELECT substr(loc,6) AS segment FROM nodes WHERE memory_id=${memoryId} ORDER BY segment`;
    expect(seen).toEqual(expected.map(x => x.segment));
    expect(new Set(seen).size).toBe(locs.length);
  });
});
