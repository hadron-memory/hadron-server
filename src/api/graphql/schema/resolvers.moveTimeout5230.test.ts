/**
 * #5230 (cor:api:190:01) — the move's content-link and edge-slot lookups no longer fail above Postgres's 32,767
 * bind-variable cap, and a move whose transaction expires answers the typed `MOVE_TIMED_OUT` refusal on every door,
 * having written nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { findLiveNodesByLoc, findHeldEdgeLocs } from '../../../lib/nodeSubtreeMove.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const MESSAGE = 'The move ran out of time and was rolled back, so nothing was moved. Move it in smaller parts.';
let src: { id: string; urn: string };
let dest: { id: string; urn: string };
let userId: string;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const auth = (): AuthContext => ({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
const nodeUrn = (memory: { urn: string }, loc: string) => `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:${loc}`;
const pad = (n: number) => Array.from({ length: n }, (_, i) => `absent-${i}`);

// Two tests here seed tens of thousands of rows, and clearing them outlasts the 10 s default hook timeout on a CI
// runner: both the next test's cleanup and the one that leaves the worker's database empty for the next file get longer.
const CLEANUP_TIMEOUT = 120_000;

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { githubId: 5230, githubUsername: 'mv5230', roles: ['ADMIN'] } })).id;
  const made = await createDbOrgAndGraph(db, { orgName: 'mv5230', graphName: 'src' });
  src = made.graph;
  dest = await resolvers.Mutation.createMemory({}, { orgRef: made.org.id, name: 'dest' }, ctx());
}, CLEANUP_TIMEOUT);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => cleanDb(db), CLEANUP_TIMEOUT);

describe('the content-link target lookup at any size', () => {
  it('takes more targets than the bind cap', async () => {
    await expect(findLiveNodesByLoc(db as never, src.id, pad(40_000))).resolves.toEqual([]);
  });

  it('returns the rows one unchunked query returns, wherever they sit in the list', async () => {
    const a = await createDbNode(db, { memoryId: src.id, loc: 'ta' });
    const b = await createDbNode(db, { memoryId: src.id, loc: 'tb' });
    const gone = await createDbNode(db, { memoryId: src.id, loc: 'tgone' });
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await createDbNode(db, { memoryId: dest.id, loc: 'tother' });
    const small = ['ta', 'tb', 'tgone', 'tother', 'absent'];
    const unchunked = await db.node.findMany({ where: { memoryId: src.id, loc: { in: small }, deletedAt: null }, select: { id: true, loc: true } });
    const byLoc = (rows: Array<{ loc: string }>) => [...rows].sort((x, y) => x.loc.localeCompare(y.loc));
    expect(byLoc(await findLiveNodesByLoc(db as never, src.id, small))).toEqual(byLoc(unchunked));
    const far = ['ta', ...pad(25_000), 'tgone', 'tother', 'tb'];
    expect(byLoc(await findLiveNodesByLoc(db as never, src.id, far))).toEqual([{ id: a.id, loc: 'ta' }, { id: b.id, loc: 'tb' }]);
    expect(await findLiveNodesByLoc(db as never, src.id, [])).toEqual([]);
  });

  it('plans and performs a cross-memory move of content with more link targets than the bind cap', { timeout: 180_000 }, async () => {
    const locs = Array.from({ length: 33_000 }, (_, i) => `t${i}`);
    // The targets live in both memories, so neither lookup falls through to the per-target alias search.
    for (const memoryId of [src.id, dest.id]) {
      for (let i = 0; i < locs.length; i += 5_000) {
        await db.node.createMany({ data: locs.slice(i, i + 5_000).map((loc) => ({ id: generateId(), memoryId, loc, name: loc, nodeType: 'info' })) });
      }
    }
    const root = await createDbNode(db, { memoryId: src.id, loc: 'linker' });
    await db.node.update({ where: { id: root.id }, data: { content: locs.map((l) => `[[${l}]]`).join(' ') } });
    const args = { sourceRef: root.id, targetUrn: nodeUrn(dest, 'linker') };
    const plan = await M.planNodeMove(null, args, ctx());
    expect(plan.linkWarnings).toHaveLength(33_000);
    const moved = await M.moveNode(null, args, ctx());
    expect(moved.moveLinkWarnings).toHaveLength(33_000);
    expect(new Set(moved.moveLinkWarnings.map((w: { status: string }) => w.status))).toEqual(new Set(['RETARGETED']));
    expect((await db.node.findUniqueOrThrow({ where: { id: root.id } })).memoryId).toBe(dest.id);
  });
});

describe('the edge-slot lookup at any size', () => {
  it('takes more bases than half the bind cap', async () => {
    await expect(findHeldEdgeLocs(db as never, src.id, pad(40_000))).resolves.toEqual(new Set());
  });

  it('returns the locs one unchunked query returns, wherever the bases sit in the list', async () => {
    const a = await createDbNode(db, { memoryId: src.id, loc: 'ha' });
    const b = await createDbNode(db, { memoryId: src.id, loc: 'hb' });
    const edge = (loc: string, memoryId = src.id, deletedAt: Date | null = null) =>
      db.edge.create({ data: { id: generateId(), memoryId, sourceId: a.id, targetId: b.id, loc, name: loc, deletedAt } });
    for (const loc of ['p', 'p:2', 'p:q:3', 'q', 'q-x', 'other']) await edge(loc);
    await edge('r:2', src.id, new Date());
    await edge('s', dest.id);
    const small = ['p', 'p:q', 'q', 'r', 's', 'absent'];
    const unchunked = await db.edge.findMany({
      where: { memoryId: src.id, OR: [{ loc: { in: small } }, ...small.map((x) => ({ loc: { startsWith: `${x}:` } }))] },
      select: { loc: true },
    });
    const expected = new Set(['p', 'p:2', 'p:q:3', 'q', 'r:2']);
    expect(new Set(unchunked.map((r) => r.loc))).toEqual(expected);
    expect(await findHeldEdgeLocs(db as never, src.id, small)).toEqual(expected);
    expect(await findHeldEdgeLocs(db as never, src.id, ['p', ...pad(12_000), 'p:q', 'q', ...pad(6_000), 'r', 's'])).toEqual(expected);
    expect(await findHeldEdgeLocs(db as never, src.id, [])).toEqual(new Set());
  });

  it('moves a subtree with more rebased bases than the lookup could bind, and rebases them as before', { timeout: 300_000 }, async () => {
    const root = await createDbNode(db, { memoryId: src.id, loc: 'many' });
    const child = await createDbNode(db, { memoryId: src.id, loc: 'many:c' });
    const names = Array.from({ length: 16_500 }, (_, i) => `n${i}`);
    for (let i = 0; i < names.length; i += 5_000) {
      await db.edge.createMany({ data: names.slice(i, i + 5_000).map((name) => ({
        id: generateId(), memoryId: src.id, sourceId: root.id, targetId: child.id, name, locAuthored: false,
        loc: deriveEdgeLoc('many', name, 'many:c'),
      })) });
    }
    // A soft-deleted edge already holds one landing slot in the LAST chunk: its mover takes the numbered suffix.
    const heldBase = deriveEdgeLoc('moved', 'n16499', 'moved:c');
    await db.edge.create({ data: { id: generateId(), memoryId: src.id, sourceId: child.id, targetId: root.id, loc: heldBase, name: 'held', deletedAt: new Date() } });
    await M.moveNode(null, { sourceRef: root.id, targetUrn: nodeUrn(src, 'moved') }, ctx());
    const rows = await db.edge.findMany({ where: { sourceId: root.id }, select: { name: true, loc: true } });
    expect(rows).toHaveLength(16_500);
    const wrong = rows.filter((r) => r.loc !== deriveEdgeLoc('moved', r.name!, 'moved:c') + (r.name === 'n16499' ? ':2' : ''));
    expect(wrong).toEqual([]);
  });
});

describe('a move whose transaction expires', () => {
  /** The installed engine's own expiry errors, captured from real interactive transactions. */
  const real: Record<string, unknown> = {};
  beforeAll(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const capture = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      db.$transaction(work, { timeout: 100 }).then(() => { throw new Error('the transaction did not expire'); }, (e: unknown) => e);
    real.query = await capture(async (tx) => { await sleep(300); await tx.node.count(); });
    real.statement = await capture(async (tx) => { await tx.$queryRaw`SELECT pg_sleep(0.4)::text`; });
    real.commit = await capture(() => sleep(300));
  });

  const known = (message: string, code = 'P2028') => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
  const NOT_FOUND = 'Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn\'t have information about anymore, or was obtained before disconnecting.';

  /** Run the move's real transaction to the end of its work, roll it back, then throw `fault` in its place. */
  function expireMove(fault: () => unknown) {
    const transaction = db.$transaction.bind(db);
    const ran = { work: 0 };
    vi.spyOn(db, '$transaction').mockImplementation((async (work: any, options: any) => {
      if (typeof work !== 'function' || !(options?.timeout > 100_000)) return transaction(work, options);
      const rollback = new Error('rollback');
      return transaction(async (tx) => { await work(tx); ran.work++; throw rollback; }, options)
        .catch((e: unknown) => { throw e === rollback ? fault() : e; });
    }) as never);
    return ran;
  }

  const snapshot = async () => ({
    nodes: await db.node.findMany({ orderBy: { id: 'asc' } }),
    edges: await db.edge.findMany({ orderBy: { id: 'asc' } }),
    revisions: await db.nodeRevision.findMany({ orderBy: { id: 'asc' } }),
    aliases: await db.urnAlias.findMany({ orderBy: { id: 'asc' } }),
  });

  async function fixture() {
    const root = await createDbNode(db, { memoryId: src.id, loc: 'big' });
    const child = await createDbNode(db, { memoryId: src.id, loc: 'big:c' });
    await createDbNode(db, { memoryId: dest.id, loc: 'occupied' });
    await db.edge.create({ data: { id: generateId(), memoryId: src.id, sourceId: root.id, targetId: child.id, name: 'ref', locAuthored: false, loc: deriveEdgeLoc('big', 'ref', 'big:c') } });
    return root;
  }

  const doors = {
    moveNode: (id: string) => M.moveNode(null, { sourceRef: id, targetUrn: nodeUrn(dest, 'moved') }, ctx()),
    planNodeMove: (id: string) => M.planNodeMove(null, { sourceRef: id, targetUrn: nodeUrn(dest, 'moved') }, ctx()),
  };
  const mcpMove = (target: string, overwrite = false) => createTestableMcpServer(auth()).callToolText('hadron_move_node', {
    urn: nodeUrn(src, 'big'), targetUrn: nodeUrn(dest, target), overwrite,
  });

  const expiries: Array<[string, () => unknown]> = [
    ['a query on the expired transaction', () => real.query],
    ['a statement running past the expiry', () => real.statement],
    ['a commit after the expiry', () => real.commit],
    ['a transaction the engine no longer knows', () => known(NOT_FOUND)],
  ];

  describe.each(expiries)('%s', (_name, fault) => {
    it.each(['moveNode', 'planNodeMove'] as const)('%s answers MOVE_TIMED_OUT and nothing changed', async (door) => {
      const root = await fixture();
      const before = await snapshot();
      const ran = expireMove(fault);
      const err = await doors[door](root.id).then(() => null, (e: unknown) => e as any);
      expect(ran.work).toBe(1);
      expect(err.extensions).toEqual({ code: 'MOVE_TIMED_OUT' });
      expect(err.message).toBe(MESSAGE);
      expect(err.originalError ?? null).toBeNull();
      expect(await snapshot()).toEqual(before);
    });

    it('MCP answers [move_timed_out] and nothing changed, an overwritten occupant included', async () => {
      await fixture();
      const before = await snapshot();
      const ran = expireMove(fault);
      expect(await mcpMove('moved')).toBe(`[move_timed_out] ${MESSAGE}`);
      expect(await mcpMove('occupied', true)).toBe(`[move_timed_out] ${MESSAGE}`);
      expect(ran.work).toBe(2);
      expect(await snapshot()).toEqual(before);
    });
  });

  const others: Array<[string, () => unknown]> = [
    ['P2028 that never started a transaction', () => known('Transaction API error: Unable to start a transaction in the given time.')],
    ['another P2028', () => known('Transaction API error: Transaction API error of another kind.')],
    ['a query on a committed transaction', () => known('Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.')],
    ['another code with the same words', () => known('Transaction already closed', 'P2025')],
    ['a plain error with the same words', () => new Error('Transaction already closed')],
    ['an error that only looks like Prisma\'s', () => Object.assign(new Error('Transaction already closed'), { code: 'P2028' })],
  ];

  it.each(others)('does not map %s', async (_name, fault) => {
    const root = await fixture();
    const thrown = fault();
    expireMove(() => thrown);
    for (const door of ['moveNode', 'planNodeMove'] as const) await expect(doors[door](root.id)).rejects.toBe(thrown);
    const text = await mcpMove('moved').catch((e: unknown) => String(e));
    expect(text).not.toMatch(/move_timed_out|nothing was moved/i);
  });

  it('a move that commits is not reported as timed out', async () => {
    const root = await fixture();
    await expect(doors.moveNode(root.id)).resolves.toMatchObject({ loc: 'moved' });
  });
});
