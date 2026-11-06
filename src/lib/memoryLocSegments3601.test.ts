/** #3601: control characters are data, never structural separators. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { readLocSegments, decodeLocSegmentsCursor, SEGMENT_KEY_SQL, segmentKey } from './memoryLocSegments.js';

let memoryId: string;
beforeAll(async () => {
  await cleanDb(db);
  memoryId = (await createDbOrgAndGraph(db, { orgName:'collision3601', graphName:'collision3601' })).graph.id;
});
beforeEach(async () => { await db.node.deleteMany({ where:{ memoryId } }); });
afterAll(async () => { await cleanDb(db); });
const read = (parent = '', limit = 200, after: ReturnType<typeof decodeLocSegmentsCursor> = null) =>
  db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
    return readLocSegments(tx, { memoryIds:[memoryId], excludeNodeIds:[], parent, limit, after });
  });
async function seed(locs: string[]) {
  await db.node.createMany({ data:locs.map((loc,i) => ({ id:`collision3601-${i}`, memoryId, loc, name:'fixture' })) });
}
describe('#3601 collision-safe loc keys', () => {
  it('migration and post-push share the exact indexed runtime expression and retain the old index', () => {
    const ddl = `CREATE INDEX IF NOT EXISTS nodes_memory_segment_key_v2_idx\n  ON nodes (memory_id, (${SEGMENT_KEY_SQL}));`;
    const migration = readFileSync(new URL('../../prisma/migrations/20261106040000_nodes_segment_key_index_v2/migration.sql', import.meta.url), 'utf8');
    const postPush = readFileSync(new URL('../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(migration).toContain(ddl);
    expect(postPush).toContain(ddl);
    expect(migration).not.toMatch(/DROP\s+INDEX/i);
    expect(postPush).toContain('CREATE INDEX IF NOT EXISTS nodes_memory_segment_key_idx');
  });
  it('prechange raw tuple cursor continues across control-character siblings', async () => {
    await seed(['before', 'p\u0001:child', 'p\u0002:child', '😀:leaf']);
    const raw = Buffer.from(JSON.stringify([memoryId, null, 'before'])).toString('base64url');
    const page = await read('', 1, decodeLocSegmentsCursor(raw));
    expect(page.items).toEqual([{ segment:'p\u0001', hasNode:false, memoryId }]);
    const next = await read('', 1, decodeLocSegmentsCursor(page.endCursor!));
    expect(next.items).toEqual([{ segment:'p\u0002', hasNode:false, memoryId }]);
  });
  it('TS keys match the indexed SQL expression for control, prefix and astral data', async () => {
    const values = ['', ':', 'a:b', 'a\u0001b', 'a\u0002b', 'a\u00021b', 'a\u00022b', '😀:x', '\u0002\u0001:'];
    let frontier = [''];
    for (let length=0; length<4; length++) {
      frontier = frontier.flatMap(prefix => ['x', ':', '\u0001', '\u0002', '😀'].map(char => prefix + char));
      values.push(...frontier.filter(value => !values.includes(value)));
    }
    const rows = await db.$queryRawUnsafe<Array<{loc:string; key:string}>>(
      `SELECT loc, ${SEGMENT_KEY_SQL} AS key FROM unnest($1::text[]) AS fixture(loc)`, values);
    expect(rows.map(r => r.key)).toEqual(values.map(segmentKey));
    expect(new Set(rows.map(r => r.key)).size).toBe(values.length);
  });
  it('deep walk retains a node-less branch beside a literal chr(1) sibling', async () => {
    await seed(['a:b:c', 'a\u0001b']);
    expect((await read()).items).toEqual([
      { segment:'a', hasNode:false, memoryId },
      { segment:'a\u0001b', hasNode:true, memoryId },
    ]);
  });
  it('deep walk visits control-bearing parents and excludes their similarly prefixed siblings', async () => {
    await seed(['a:b', 'a:c', 'a\u0001b', 'a\u0001b:child', 'a\u0002b:leaf', 'a\u00021b:other', 'z']);
    expect((await read()).items.map(x => x.segment)).toEqual(['a','a\u00021b','a\u0001b','a\u0002b','z']);
    expect((await read('a\u0001b')).items.map(x => x.segment)).toEqual(['child']);
    expect((await read('a\u0002b')).items.map(x => x.segment)).toEqual(['leaf']);
  });
  it('control-bearing parent uses the same chooser, walk and bounded-flat key', async () => {
    await seed(['p\u0001:branch:leaf', 'p\u0001:other', ...Array.from({length:70}, (_,i) => `p\u0002:n${i}`)]);
    expect((await read('p\u0001')).items).toEqual([
      { segment:'branch', hasNode:false, memoryId }, { segment:'other', hasNode:true, memoryId },
    ]);
    expect((await read('p\u0002')).items).toHaveLength(70);
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
