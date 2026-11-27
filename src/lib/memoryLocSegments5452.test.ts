/**
 * #5452 (cor:api:090:02, cor:api:090:05): `includeSystemNodes` lifts `system` from the default node-type
 * exclusion, for findNodes and for the loc-segments read.
 *
 * - One function: `defaultExcludedNodeTypes(filter)` is the only reader of the shared list in production
 *   code, so the two findNodes default sites and the segments read cannot drift, and a third site cannot
 *   appear unnoticed.
 * - A second partial index: the flagged segments read needs an index that holds `system` rows and still no
 *   `chat-message` or comment rows. Its WHERE clause is the flagged walk's predicate byte for byte, in the
 *   migration (built CONCURRENTLY, alone in its file) and in post-push.sql (the plain form).
 * - Reachability and cost: on a fixture with a 3000-message chat root, every scan of the flagged walk reads
 *   that index, and a flagged page touches a handful of rows, never the messages.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from './id.js';
import * as defaults from './retrieval/defaultNodeTypes.js';
import * as segments from './memoryLocSegments.js';
import { locSegmentsWalkSql, readLocSegments, segmentEligibleSql, SEGMENT_ELIGIBLE_INDEX } from './memoryLocSegments.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const prismaDir = new URL('../../prisma/', import.meta.url);
const WITH_SYSTEM_INDEX = 'nodes_memory_segment_key_with_system_idx';
const MIGRATION = 'migrations/20261127234000_nodes_segment_key_with_system_index/migration.sql';
/** The flagged predicate, spelled out: system rows are in, chat-message and comment rows are not. */
const WITH_SYSTEM_PREDICATE = `deleted_at IS NULL AND node_type <> ALL(ARRAY['chat-message','comment']) AND loc <> ''`;

type ExcludedFn = (filter?: { includeSystemNodes?: unknown } | null) => readonly string[];
const defaultExcludedNodeTypes = (defaults as unknown as { defaultExcludedNodeTypes?: ExcludedFn }).defaultExcludedNodeTypes;
const flaggedSql = (alias?: string) =>
  (segmentEligibleSql as unknown as (alias?: string, opts?: { includeSystemNodes?: boolean | null }) => string)(alias, { includeSystemNodes: true });

describe('#5452 one function decides the default node-type exclusion', () => {
  it('returns system and chat-message by default, and chat-message alone for exactly true', () => {
    expect(defaultExcludedNodeTypes, 'defaultExcludedNodeTypes is exported').toBeTypeOf('function');
    const fn = defaultExcludedNodeTypes!;
    for (const filter of [undefined, null, {}, { includeSystemNodes: undefined }, { includeSystemNodes: null }, { includeSystemNodes: false }]) {
      expect(fn(filter), JSON.stringify(filter)).toEqual(['system', 'chat-message']);
    }
    expect(fn({ includeSystemNodes: true })).toEqual(['chat-message']);
    // Only the boolean true lifts: a truthy stand-in from a loosely typed caller keeps the default.
    for (const value of ['true', 1, 'false', {}, []]) {
      expect(fn({ includeSystemNodes: value }), JSON.stringify(value)).toEqual(['system', 'chat-message']);
    }
    // chat-message is excluded on every answer, and a caller cannot edit the shared list.
    expect(fn({ includeSystemNodes: true })).toContain('chat-message');
    expect(Object.isFrozen(fn())).toBe(true);
    expect(Object.isFrozen(fn({ includeSystemNodes: true }))).toBe(true);
    expect(fn()).toEqual([...defaults.UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES]);
  });

  it('no production code reads UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES directly: every site asks the function', () => {
    const SKIP_DIRS = new Set(['node_modules', 'generated', '.git', 'dist']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !/\.test\.(ts|mts|js|mjs)$/.test(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    };
    walk(join(repoRoot, 'src'));
    walk(join(repoRoot, 'scripts'));
    expect(files.length).toBeGreaterThan(500); // the walk really covered the tree
    const readers = files
      .filter((file) => readFileSync(file, 'utf8').includes('UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES'))
      .map((file) => relative(repoRoot, file));
    expect(readers).toEqual(['src/lib/retrieval/defaultNodeTypes.ts']);
  });

  it('the segments read derives both of its lists from that function, plus comment', () => {
    const fn = defaultExcludedNodeTypes!;
    expect(segments.SEGMENT_INELIGIBLE_NODE_TYPES).toEqual([...fn(), 'comment']);
    const ineligible = (segments as unknown as { segmentIneligibleNodeTypes?: ExcludedFn }).segmentIneligibleNodeTypes;
    expect(ineligible, 'segmentIneligibleNodeTypes is exported').toBeTypeOf('function');
    expect(ineligible!()).toEqual([...fn(), 'comment']);
    expect(ineligible!({ includeSystemNodes: true })).toEqual([...fn({ includeSystemNodes: true }), 'comment']);
    expect(ineligible!({ includeSystemNodes: false })).toEqual([...fn(), 'comment']);
  });
});

describe('#5452 the with-system partial index: lockstep and predicate', () => {
  const statementOf = (sql: string, concurrently: boolean): string => {
    const m = sql.match(new RegExp(`CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${WITH_SYSTEM_INDEX}\\b[^;]*;`));
    if (!m) throw new Error(`no ${WITH_SYSTEM_INDEX} statement`);
    return m[0];
  };
  const read = (path: string) => readFileSync(new URL(path, prismaDir), 'utf8');

  it('the walk predicate with the flag leaves out chat-message and comment only; without it, nothing changed', () => {
    expect(flaggedSql()).toBe(WITH_SYSTEM_PREDICATE);
    expect(flaggedSql('n')).toBe(WITH_SYSTEM_PREDICATE.replace(/\b(deleted_at|node_type|loc) /g, 'n.$1 '));
    const unflagged = `deleted_at IS NULL AND node_type <> ALL(ARRAY['system','chat-message','comment']) AND loc <> ''`;
    expect(segmentEligibleSql()).toBe(unflagged);
    const loose = segmentEligibleSql as unknown as (alias?: string, opts?: { includeSystemNodes?: boolean | null }) => string;
    expect(loose(undefined, { includeSystemNodes: false })).toBe(unflagged);
    expect(loose(undefined, { includeSystemNodes: null })).toBe(unflagged);
    expect(loose(undefined, {})).toBe(unflagged);
  });

  it('the migration is one CREATE INDEX CONCURRENTLY statement and nothing else', () => {
    const body = read(MIGRATION).split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim();
    expect(body).toBe(statementOf(read(MIGRATION), true));
    expect(body.match(/;/g)).toHaveLength(1);
  });

  it('post-push.sql carries the same definition, byte for byte, in the plain form', () => {
    const migration = statementOf(read(MIGRATION), true);
    const postPush = statementOf(read('post-push.sql'), false);
    expect(postPush).toBe(migration.replace('CREATE INDEX CONCURRENTLY ', 'CREATE INDEX '));
    expect(migration).toContain(`ON nodes (memory_id, ((replace(loc, ':', chr(1))) COLLATE "C"))`);
    expect(migration.endsWith(`WHERE ${flaggedSql()};`)).toBe(true);
    expect(migration.endsWith(`WHERE ${WITH_SYSTEM_PREDICATE};`)).toBe(true);
  });

  it('the name the walk relies on is the one both files create', () => {
    expect((segments as unknown as { SEGMENT_WITH_SYSTEM_INDEX?: string }).SEGMENT_WITH_SYSTEM_INDEX).toBe(WITH_SYSTEM_INDEX);
  });

  it('the database built from post-push.sql holds the index, valid, with that predicate and key', async () => {
    const [row] = await db.$queryRaw<Array<{ def: string | null; valid: boolean | null }>>`
      SELECT pg_get_indexdef(c.oid) AS def, i.indisvalid AS valid
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ${WITH_SYSTEM_INDEX} AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`;
    expect(row, `${WITH_SYSTEM_INDEX} exists`).toBeDefined();
    expect(row.valid).toBe(true);
    expect(row.def).toContain(`(memory_id, (replace(loc, ':'::text, chr(1))) COLLATE "C")`);
    expect(row.def).toContain(`'chat-message'::text`);
    expect(row.def).toContain(`'comment'::text`);
    expect(row.def).not.toContain(`'system'`);
    expect(row.def).toContain('deleted_at IS NULL');
  });
});

/** server_version_num of PostgreSQL 16.0, the first release with EXPLAIN (GENERIC_PLAN). */
const MIN_GENERIC_PLAN_VERSION_NUM = 160000;
/** The churn is 20k inserts and a DELETE: on a busy shard that exceeds the default 10s hook budget. */
const CHURN_HOOK_TIMEOUT_MS = 60_000;
const MESSAGES = 3000;

type PlanNode = {
  'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[];
  'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number;
};
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];
/** EXPLAIN reports per-loop averages; this estimates tuples a scan handled, returned or filtered away. */
const tupleVisits = (n: PlanNode): number =>
  ((n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) * (n['Actual Loops'] ?? 0);

describe('#5452 the flagged walk reads the with-system index and never the messages', () => {
  let memoryId: string;

  // #3650 (as memoryLocSegments2836.test.ts): make the partial indexes' dead-page history the fixture's own,
  // so this file cannot pass only because it ran first in its worker.
  beforeAll(async () => {
    await cleanDb(db);
    const churn = ((await createDbOrgAndGraph(db, { orgName: 'seg-5452-churn', graphName: 'seg5452/churn' })).graph as { id: string }).id;
    await db.$executeRaw`
      INSERT INTO nodes (id, memory_id, loc, name, updated_at)
      SELECT 'churn5452-' || g, ${churn}, 'churn:' || lpad(g::text, 6, '0'), 'n', now() FROM generate_series(1, 20000) g`;
    await db.$executeRaw`DELETE FROM nodes WHERE memory_id = ${churn}`;
  }, CHURN_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanDb(db);
    memoryId = ((await createDbOrgAndGraph(db, { orgName: 'seg-5452', graphName: 'seg5452/m' })).graph as { id: string }).id;
    const base = { memoryId, name: 'n' };
    await db.node.createMany({
      data: [
        { ...base, id: generateId(), loc: 'doc' },
        { ...base, id: generateId(), loc: 'conversations', nodeType: 'system' },
        { ...base, id: generateId(), loc: 'conversations:intro', nodeType: 'system' },
        { ...base, id: generateId(), loc: 'conversations:outro', nodeType: 'system' },
        { ...base, id: generateId(), loc: 'prompts:intro:greet', nodeType: 'system' },
        { ...base, id: generateId(), loc: 'team-chat', nodeType: 'chat' },
        { ...base, id: generateId(), loc: 'zz' },
        ...Array.from({ length: MESSAGES }, (_, i) => ({
          ...base, id: generateId(), loc: `team-chat:messages:${String(i).padStart(5, '0')}`, nodeType: 'chat-message', seq: i + 1,
        })),
      ],
    });
    await db.$executeRawUnsafe('ANALYZE nodes');
  });

  const flaggedWalk = (parent: string) => (locSegmentsWalkSql as unknown as (args: Record<string, unknown>) => { text: string; values: unknown[] })(
    { memoryIds: [memoryId], excludeNodeIds: [], parent, limit: 20, after: null, includeSystemNodes: true });

  it('the fixture answers as the contract says: system branches listed, the message branch still not node-backed below the root', async () => {
    const read = (parent: string, includeSystemNodes?: boolean) =>
      readLocSegments(db, { memoryIds: [memoryId], excludeNodeIds: [], parent, limit: 20, after: null, includeSystemNodes } as never);
    const names = async (parent: string, flag?: boolean) => (await read(parent, flag)).items.map((i) => `${i.segment}:${i.hasNode}`);
    expect(await names('')).toEqual(['doc:true', 'team-chat:true', 'zz:true']);
    expect(await names('', true)).toEqual(['conversations:true', 'doc:true', 'prompts:false', 'team-chat:true', 'zz:true']);
    expect(await names('conversations', true)).toEqual(['intro:true', 'outro:true']);
    expect(await names('team-chat', true)).toEqual([]);
    expect(await names('team-chat:messages', true)).toEqual([]);
  });

  it.for([['root', ''], ['a system branch', 'conversations'], ['a message-only branch', 'team-chat'], ['the messages prefix', 'team-chat:messages']] as const)(
    '%s: every scan of nodes is an index scan of the with-system index (generic plan, full index out of reach)',
    async ([, parent], ctx) => {
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      let plan: PlanNode;
      try {
        const serverVersionNum = Number((await pg.query('SHOW server_version_num')).rows[0].server_version_num);
        // EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16+ (#3639): skipped visibly below that, as the #2836 pin is.
        if (serverVersionNum < MIN_GENERIC_PLAN_VERSION_NUM) {
          ctx.skip(`EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16+; this server is ${serverVersionNum}`);
        }
        const q = flaggedWalk(parent);
        // The flagged predicate does not imply the first partial index's (that one leaves system rows out), so
        // with the full index dropped only the with-system index can serve the ordered probes. A predicate the
        // planner cannot prove from the inlined literal leaves a seq scan or a sort, and the checks below fail.
        await pg.query('BEGIN');
        await pg.query('DROP INDEX IF EXISTS nodes_memory_segment_key_idx');
        await pg.query('SET LOCAL enable_seqscan = off');
        await pg.query('SET LOCAL enable_sort = off');
        await pg.query('SET LOCAL enable_bitmapscan = off');
        plan = (await pg.query(`EXPLAIN (FORMAT JSON, GENERIC_PLAN) ${q.text}`)).rows[0]['QUERY PLAN'][0].Plan;
      } finally {
        await pg.query('ROLLBACK').catch(() => {});
        await pg.end();
      }
      const scans = flatten(plan).filter((n) => n['Relation Name'] === 'nodes');
      // Hybrid walk: chooser + two skip legs + flat seed/continuation.
      expect(scans).toHaveLength(5);
      for (const s of scans) {
        expect(s['Node Type']).toBe('Index Scan');
        expect(s['Index Name']).toBe(WITH_SYSTEM_INDEX);
        expect(s['Index Name']).not.toBe(SEGMENT_ELIGIBLE_INDEX);
      }
    },
  );

  it.for([['root', '', 5], ['the chat root', 'team-chat', 0], ['the messages prefix', 'team-chat:messages', 0]] as const)(
    '%s: a flagged page handles a handful of tuples while 3000 messages sit under the chat root',
    async ([, parent, rows]) => {
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      let plan: PlanNode;
      let answer: unknown[];
      try {
        const q = flaggedWalk(parent);
        await pg.query('BEGIN');
        await pg.query('DROP INDEX IF EXISTS nodes_memory_segment_key_idx');
        plan = (await pg.query({ text: `EXPLAIN (ANALYZE, FORMAT JSON) ${q.text}`, values: q.values })).rows[0]['QUERY PLAN'][0].Plan;
        answer = (await pg.query({ text: q.text, values: q.values })).rows;
      } finally {
        await pg.query('ROLLBACK').catch(() => {});
        await pg.end();
      }
      expect(answer).toHaveLength(rows);
      const scans = flatten(plan).filter((n) => n['Relation Name'] === 'nodes');
      expect(scans.length).toBeGreaterThan(0);
      // Seven eligible rows exist in the memory; a walk that had to step over the messages would handle thousands.
      expect(scans.reduce((sum, n) => sum + tupleVisits(n), 0)).toBeLessThanOrEqual(40);
    },
  );
});
