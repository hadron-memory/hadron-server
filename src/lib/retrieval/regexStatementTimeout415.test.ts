/**
 * #415 Slice 1: the regex search statement runs under a transaction-local
 * database time budget.
 *
 * The fixture that holds the statement past the budget is a lock, not a
 * pathological pattern. A second connection takes ACCESS EXCLUSIVE on
 * `nodes`, so the regex SELECT parks in the lock queue. `statement_timeout`
 * counts that wait, so the database cancels the real statement, which
 * pg_stat_activity can see, rather than a promise being abandoned. Postgres's
 * regex engine rejects most backreference blow-ups in under a millisecond, so
 * a CPU-bound pattern would be neither deterministic nor portable.
 *
 * Connection reuse is proven with a dedicated client capped at ONE pooled
 * connection: whatever runs next necessarily runs on the connection that just
 * committed or timed out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from 'pg';
import { PrismaClient } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { postgresRetrievalProvider as provider } from './postgres.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { regexSearchTimeoutMs, REGEX_SEARCH_TIMEOUT_DEFAULT_MS } from './regexTimeout.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const BUDGET_MS = 250;
/** Scheduling tolerance on top of the budget: CI runners are shared and slow. */
const TOLERANCE_MS = 2_000;
/** How long the red run waits before calling the statement unbounded. */
const UNBOUNDED_AFTER_MS = BUDGET_MS + TOLERANCE_MS + 1_500;

/** A distinctive pattern, so a leak check can't pass by accident. */
const PATTERN = 'zq7ban(ana)?';

function clientWithPool(limit: number): PrismaClient {
  const base = process.env.DATABASE_URL!;
  const url = `${base}${base.includes('?') ? '&' : '?'}connection_limit=${limit}`;
  return new PrismaClient({ datasourceUrl: url });
}

/** Park every reader of `nodes` until released. */
async function holdNodesLock(): Promise<{ locker: Client; release: () => Promise<void> }> {
  const locker = new Client({ connectionString: process.env.DATABASE_URL });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('LOCK TABLE nodes IN ACCESS EXCLUSIVE MODE');
  let released = false;
  return {
    locker,
    release: async () => {
      if (released) return;
      released = true;
      await locker.query('ROLLBACK');
      await locker.end();
    },
  };
}

type Settled<T> = { kind: 'ok'; value: T; ms: number } | { kind: 'err'; error: unknown; ms: number } | { kind: 'pending' };

/** Settle `p`, or report it still pending after `ms`. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  const started = Date.now();
  return Promise.race([
    p.then(
      (value) => ({ kind: 'ok' as const, value, ms: Date.now() - started }),
      (error) => ({ kind: 'err' as const, error, ms: Date.now() - started }),
    ),
    new Promise<Settled<T>>((r) => setTimeout(() => r({ kind: 'pending' }), ms)),
  ]);
}

/** Backends (other than `self`) still running a regex search statement. */
async function activeRegexStatements(observer: Client): Promise<number> {
  const { rows } = await observer.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state = 'active' AND query LIKE '%~*%'`,
  );
  return rows[0].n;
}

async function backendState(observer: Client, pid: number): Promise<string | null> {
  const { rows } = await observer.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
  return rows[0]?.state ?? null;
}

let graphId: string;
let bananaId: string;
let memUrn: string;
let adminId: string;

beforeEach(async () => {
  process.env.REGEX_SEARCH_TIMEOUT_MS = String(BUDGET_MS);
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'rx415-org', graphName: 'rx415/graph' });
  graphId = made.graph.id;
  memUrn = (await db.memory.findUniqueOrThrow({ where: { id: graphId } })).urn;
  const mk = (loc: string, name: string) =>
    db.node.create({ data: { id: generateId(), memoryId: graphId, loc, name } as never });
  bananaId = (await mk('rx-banana', 'zq7banana')).id;
  await mk('rx-orange', 'orange');
  const admin = await db.user.create({ data: { githubId: 415001, githubUsername: 'rx415-admin', roles: ['ADMIN'] } });
  adminId = admin.id;
});

afterEach(() => {
  delete process.env.REGEX_SEARCH_TIMEOUT_MS;
});

const regex = (client: PrismaClient, pattern = PATTERN) =>
  provider.regexSearch({ db: client, pattern, memoryIds: [graphId], limit: 10 });

describe('#415 regex search statement budget', () => {
  it('cancels the DB statement within budget, rolls back, and the connection is reused at once', async () => {
    const lone = clientWithPool(1);
    const { locker, release } = await holdNodesLock();
    let search: Promise<unknown> | undefined;
    try {
      const [{ pid }] = await lone.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      search = regex(lone);
      const outcome = await settleWithin(search, UNBOUNDED_AFTER_MS);

      // Red on main: nothing bounds the statement, so it is still waiting.
      expect(outcome.kind).toBe('err');
      if (outcome.kind !== 'err') return;
      expect(outcome.ms).toBeLessThan(BUDGET_MS + TOLERANCE_MS);
      expect(String((outcome.error as Error).message)).toMatch(/57014|statement timeout/);

      // The DATABASE cancelled it: no backend is still running the statement,
      // and the pooled connection is idle, not stuck in a transaction.
      expect(await activeRegexStatements(locker)).toBe(0);
      expect(await backendState(locker, pid)).toBe('idle');
    } finally {
      await release();
      await search?.catch(() => undefined);
    }

    // Same connection (pool of one): no inherited budget, ordinary work runs,
    // including a statement that outlives the regex budget.
    const [{ timeout }] = await lone.$queryRaw<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
    expect(timeout).toBe('0');
    await lone.$executeRaw`SELECT pg_sleep(${(BUDGET_MS * 2) / 1000})`;
    expect((await regex(lone)).map((h) => h.nodeId)).toEqual([bananaId]);
    await lone.$disconnect();
  }, 20_000);

  it('a successful regex search leaves no budget on its connection', async () => {
    const lone = clientWithPool(1);
    expect((await regex(lone)).map((h) => h.nodeId)).toEqual([bananaId]);
    const [{ timeout }] = await lone.$queryRaw<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
    expect(timeout).toBe('0');
    await lone.$executeRaw`SELECT pg_sleep(${(BUDGET_MS * 2) / 1000})`;
    await lone.$disconnect();
  }, 20_000);

  it('a concurrent ordinary search waiting longer than the budget is not cancelled', async () => {
    const pool = clientWithPool(3);
    const { release } = await holdNodesLock();
    let search: Promise<unknown> | undefined;
    let keyword: Promise<{ nodeId: string }[]> | undefined;
    try {
      search = regex(pool);
      keyword = provider.lexicalSearch({ db: pool, query: 'orange', memoryIds: [graphId], limit: 10 });
      const outcome = await settleWithin(search, UNBOUNDED_AFTER_MS);
      expect(outcome.kind).toBe('err');
      // Well past the budget, the keyword search is still waiting, uncancelled,
      // and the pool still serves other work with no budget on it.
      await new Promise((r) => setTimeout(r, BUDGET_MS * 3));
      expect((await settleWithin(keyword, 10)).kind).toBe('pending');
      const [{ timeout }] = await pool.$queryRaw<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
      expect(timeout).toBe('0');
    } finally {
      await release();
      await search?.catch(() => undefined);
    }
    expect((await keyword!).length).toBe(1);
    await pool.$disconnect();
  }, 20_000);
});

describe('#415 through GraphQL findNodes and delegated MCP hadron_find_nodes (no broker)', () => {
  const findNodes = (args: Record<string, unknown>) =>
    (resolvers.Query as any).findNodes(null, args, { db, roles: ['ADMIN'], userId: adminId } as Context);
  const mcp = (args: Record<string, unknown>) =>
    createTestableMcpServer({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` }).callToolText(
      'hadron_find_nodes',
      args,
    );

  it('normal regex hits and the invalid-regex refusal are unchanged', async () => {
    const res = await findNodes({ query: PATTERN, mode: 'regex' });
    expect(res.hits.map((h: any) => h.node.id)).toEqual([bananaId]);
    await expect(findNodes({ query: 'ban(ana', mode: 'regex' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect(await mcp({ query: PATTERN, mode: 'regex', memoryUrn: memUrn })).toContain('rx-banana');
    expect(await mcp({ query: 'ban(ana', mode: 'regex', memoryUrn: memUrn })).toMatch(/^Invalid regex/);
  });

  it('a held statement is cancelled on both paths, and neither refusal echoes the pattern or internals', async () => {
    const { release } = await holdNodesLock();
    let gql: Promise<unknown> | undefined;
    let tool: Promise<string> | undefined;
    try {
      gql = findNodes({ query: PATTERN, mode: 'regex' });
      tool = mcp({ query: PATTERN, mode: 'regex', memoryUrn: memUrn });
      const g = await settleWithin(gql!, UNBOUNDED_AFTER_MS);
      const t = await settleWithin(tool!, UNBOUNDED_AFTER_MS);

      expect(g.kind).toBe('err');
      if (g.kind === 'err') {
        const wire = formatGraphQLError({ message: (g.error as Error).message }, g.error);
        expect(wire.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
        expect(JSON.stringify(wire)).not.toContain('zq7');
        expect(JSON.stringify(wire)).not.toMatch(/57014|statement_timeout|statement timeout|prisma|~\*/i);
      }

      expect(t.kind).toBe('ok');
      if (t.kind === 'ok') {
        expect(t.value).not.toContain('zq7');
        expect(t.value).not.toMatch(/57014|statement_timeout|statement timeout|prisma|~\*/i);
      }
    } finally {
      await release();
      await gql?.catch(() => undefined);
      await tool?.catch(() => undefined);
    }
  }, 20_000);
});

describe('#415 budget configuration', () => {
  it('reads REGEX_SEARCH_TIMEOUT_MS per call and never disables the bound', () => {
    expect(regexSearchTimeoutMs({})).toBe(REGEX_SEARCH_TIMEOUT_DEFAULT_MS);
    expect(regexSearchTimeoutMs({ REGEX_SEARCH_TIMEOUT_MS: '1200' })).toBe(1200);
    // 0 would mean "no timeout" to Postgres; junk must not widen the bound.
    for (const bad of ['0', '-5', 'abc', '1.5', '', ' ']) {
      expect(regexSearchTimeoutMs({ REGEX_SEARCH_TIMEOUT_MS: bad })).toBe(REGEX_SEARCH_TIMEOUT_DEFAULT_MS);
    }
  });
});
