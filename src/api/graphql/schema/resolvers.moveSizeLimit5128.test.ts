/**
 * #5128 (cor:api:190:01, Holger 2026-11-25) — a subtree move of more than N nodes (default 5,000, `MOVE_NODE_MAX_NODES`)
 * is refused before any write with a typed refusal naming N and the count, on every door; the edge lookup no longer
 * fails above the 32,767 bind-variable cap. The limit is lowered through the env so the pins run on small subtrees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import {
  moveNodeMaxNodes,
  MOVE_NODE_MAX_NODES_DEFAULT,
  MOVE_NODE_MAX_NODES_CEILING,
  assertMoveWithinSizeLimit,
} from '../../../lib/moveSizeLimit.js';
import { findLiveEdgesTouching, EDGE_LOOKUP_CHUNK } from '../../../lib/nodeSubtreeMove.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
let src: { id: string; urn: string };
let dest: { id: string; urn: string };
let userId: string;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const auth = (): AuthContext => ({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
const nodeUrn = (memory: { urn: string }, loc: string) => `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:${loc}`;

/** A root `big` and `children` descendants, so the subtree has children + 1 nodes. */
async function subtree(memoryId: string, root: string, children: number) {
  const top = await createDbNode(db, { memoryId, loc: root });
  for (let i = 0; i < children; i++) await createDbNode(db, { memoryId, loc: `${root}:c${i}` });
  return top;
}

const snapshot = async () => ({
  nodes: await db.node.findMany({ orderBy: { id: 'asc' } }),
  edges: await db.edge.findMany({ orderBy: { id: 'asc' } }),
  revisions: await db.nodeRevision.count(),
  aliases: await db.urnAlias.count(),
});

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('MOVE_NODE_MAX_NODES', '5');
  userId = (await db.user.create({ data: { githubId: 5128, githubUsername: 'mv5128', roles: ['ADMIN'] } })).id;
  const made = await createDbOrgAndGraph(db, { orgName: 'mv5128', graphName: 'src' });
  src = made.graph;
  dest = await resolvers.Mutation.createMemory({}, { orgRef: made.org.id, name: 'dest' }, ctx());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the limit setting', () => {
  it('defaults to 5,000 and accepts only a plain positive integer', () => {
    expect(MOVE_NODE_MAX_NODES_DEFAULT).toBe(5000);
    const at = (v: string | undefined) => moveNodeMaxNodes({ MOVE_NODE_MAX_NODES: v } as NodeJS.ProcessEnv);
    expect(at(undefined)).toBe(5000);
    for (const bad of ['', '0', '-1', '1.5', '1e3', '0x10', '+7', ' 7', '99999999999', String(MOVE_NODE_MAX_NODES_CEILING + 1)]) expect(at(bad)).toBe(5000);
    expect(at('7')).toBe(7);
    // The ceiling stays under Postgres's 32,767 bind cap: the move's other lookups bind one id per node.
    expect(MOVE_NODE_MAX_NODES_CEILING).toBeLessThan(32_767);
    expect(at(String(MOVE_NODE_MAX_NODES_CEILING))).toBe(MOVE_NODE_MAX_NODES_CEILING);
  });
});

describe.each([
  ['cross-memory', true],
  ['same-memory', false],
])('%s moveNode', (_name, cross) => {
  const target = (loc: string) => nodeUrn(cross ? dest : src, loc);

  it('refuses an over-limit subtree typed, naming the limit and the count, and changes nothing', async () => {
    const root = await subtree(src.id, 'big', 5); // 6 nodes > 5
    const before = await snapshot();
    const err = await M.moveNode(null, { sourceRef: root.id, targetUrn: target('moved') }, ctx()).catch((e: unknown) => e);
    expect(err.extensions).toMatchObject({ code: 'MOVE_TOO_LARGE', limit: 5, count: 6 });
    expect(err.message).not.toMatch(/prisma|bind|invocation/i);
    expect(await snapshot()).toEqual(before);
  });

  it('never reaches a lock, a write or the edge lookup for an over-limit subtree', async () => {
    const root = await subtree(src.id, 'big', 5);
    const calls: string[] = [];
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation((async (work: any, options: any) => transaction(async tx => {
      for (const method of ['$queryRaw', '$executeRaw'] as const) {
        const original = tx[method].bind(tx);
        vi.spyOn(tx, method).mockImplementation(((...args: any[]) => {
          calls.push(String(args[0]));
          return (original as any)(...args);
        }) as any);
      }
      for (const name of ['edge.findMany', 'node.update', 'node.updateMany', 'nodeRevision.create', 'nodeRevision.createMany'] as const) {
        const [model, op] = name.split('.') as [string, string];
        const original = (tx as any)[model][op].bind((tx as any)[model]);
        vi.spyOn((tx as any)[model], op).mockImplementation(((...args: any[]) => {
          calls.push(name);
          return original(...args);
        }) as any);
      }
      return work(tx);
    }, options)) as any);
    const started = Date.now();
    await expect(M.moveNode(null, { sourceRef: root.id, targetUrn: target('moved') }, ctx())).rejects.toMatchObject({
      extensions: { code: 'MOVE_TOO_LARGE' },
    });
    expect(Date.now() - started).toBeLessThan(5000);
    // No node row lock, no write, no revision and no edge lookup. (The memory-level advisory locks the door takes before
    // its gates are not the move's work and run before the count by design: the count must follow the gates.)
    expect(calls.filter(c => /^(edge|node|nodeRevision)\./.test(c) || /FROM nodes|FROM "nodes"/i.test(c))).toEqual([]);
  });

  it('answers a plan with the same refusal as the real move', async () => {
    const root = await subtree(src.id, 'big', 5);
    const args = { sourceRef: root.id, targetUrn: target('moved') };
    const real = await M.moveNode(null, args, ctx()).catch((e: unknown) => e);
    await expect(M.planNodeMove(null, args, ctx())).rejects.toMatchObject({ message: real.message, extensions: real.extensions });
  });

  it('moves a subtree of exactly the limit, with its edges and rebased locs', async () => {
    const root = await subtree(src.id, 'big', 4); // 5 nodes
    const outside = await createDbNode(db, { memoryId: src.id, loc: 'outside' });
    const inner = await db.node.findFirstOrThrow({ where: { memoryId: src.id, loc: 'big:c0' } });
    await db.edge.create({ data: { id: generateId(), memoryId: src.id, sourceId: inner.id, targetId: outside.id, loc: 'big:c0:ref:outside', name: 'ref' } });
    await db.edge.create({ data: { id: generateId(), memoryId: src.id, sourceId: outside.id, targetId: inner.id, loc: 'outside:ref:big:c0', name: 'back' } });
    await M.moveNode(null, { sourceRef: root.id, targetUrn: target('moved') }, ctx());
    const locs = (await db.node.findMany({ where: { id: { in: [root.id, inner.id] } }, orderBy: { loc: 'asc' } })).map(n => [n.memoryId, n.loc]);
    const destId = cross ? dest.id : src.id;
    expect(locs).toEqual([[destId, 'moved'], [destId, 'moved:c0']]);
    expect(await db.node.count({ where: { memoryId: destId, loc: { startsWith: 'moved' }, deletedAt: null } })).toBe(5);
    expect(await db.edge.count({ where: { deletedAt: null, OR: [{ sourceId: inner.id }, { targetId: inner.id }] } })).toBe(2);
    // These edges are authored (the default), so they keep their locs on every move (ruling 0154); both survive, unchanged.
    const edgeLocs = (await db.edge.findMany({ where: { OR: [{ sourceId: inner.id }, { targetId: inner.id }] }, select: { loc: true } })).map(e => e.loc).sort();
    expect(edgeLocs).toEqual(['big:c0:ref:outside', 'outside:ref:big:c0']);
  });

  it('small moves are unchanged', async () => {
    for (const n of [0, 1, 3]) {
      const root = await subtree(src.id, `s${n}`, n);
      await M.moveNode(null, { sourceRef: root.id, targetUrn: target(`t${n}`) }, ctx());
      expect((await db.node.findUniqueOrThrow({ where: { id: root.id } })).loc).toBe(`t${n}`);
    }
  });
});

describe('MCP hadron_move_node', () => {
  it('refuses an over-limit subtree with the same limit and count, and moves one at the limit', async () => {
    const big = await subtree(src.id, 'mbig', 5);
    const before = await snapshot();
    const text = await createTestableMcpServer(auth()).callToolText('hadron_move_node', {
      urn: nodeUrn(src, 'mbig'), targetUrn: nodeUrn(dest, 'moved'),
    });
    expect(text).toMatch(/move_too_large/);
    expect(text).toMatch(/limit 5, count 6/);
    expect(text).not.toMatch(/prisma|bind variables/i);
    expect(await snapshot()).toEqual(before);
    // The occupant is not evicted by a refused move either.
    await createDbNode(db, { memoryId: dest.id, loc: 'occupied' });
    const withOverwrite = await createTestableMcpServer(auth()).callToolText('hadron_move_node', {
      urn: nodeUrn(src, 'mbig'), targetUrn: nodeUrn(dest, 'occupied'), overwrite: true,
    });
    expect(withOverwrite).toMatch(/move_too_large/);
    expect((await db.node.findFirstOrThrow({ where: { memoryId: dest.id, loc: 'occupied' } })).deletedAt).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: big.id } })).memoryId).toBe(src.id);

    const ok = await subtree(src.id, 'mok', 4);
    await createTestableMcpServer(auth()).callToolText('hadron_move_node', { urn: nodeUrn(src, 'mok'), targetUrn: nodeUrn(dest, 'mok') });
    expect((await db.node.findUniqueOrThrow({ where: { id: ok.id } })).memoryId).toBe(dest.id);
  });
});

describe('no size oracle: the gates answer before the count', () => {
  it('a caller who cannot read the source gets the small-subtree answer for a big one', async () => {
    const outsider = await db.user.create({ data: { githubId: 51281, githubUsername: 'mv5128-out', roles: [] } });
    const outCtx = (): Context => ({ db, userId: outsider.id, roles: [] });
    const small = await subtree(src.id, 'small', 0);
    const big = await subtree(src.id, 'large', 5);
    const answer = async (id: string, loc: string) => {
      const e = await M.moveNode(null, { sourceRef: id, targetUrn: nodeUrn(dest, loc) }, outCtx()).catch((x: any) => x);
      return { code: e.extensions?.code, message: String(e.message).split(id).join('<id>') };
    };
    const a = await answer(small.id, 'x');
    const b = await answer(big.id, 'x');
    expect(a.code).not.toBe('MOVE_TOO_LARGE');
    expect(b).toEqual(a);
  });

  it('a caller who can read but not write gets the small-subtree answer for a big one', async () => {
    await db.memory.update({ where: { id: src.id }, data: { visibility: 'PUBLIC' } as never });
    const reader = await db.user.create({ data: { githubId: 51282, githubUsername: 'mv5128-read', roles: [] } });
    const readCtx = (): Context => ({ db, userId: reader.id, roles: [] });
    const small = await subtree(src.id, 'small2', 0);
    const big = await subtree(src.id, 'large2', 5);
    const answer = async (id: string) => {
      const e = await M.moveNode(null, { sourceRef: id, targetUrn: nodeUrn(dest, 'y') }, readCtx()).catch((x: any) => x);
      return { code: e.extensions?.code, message: String(e.message).split(id).join('<id>') };
    };
    const a = await answer(small.id);
    expect(a.code).not.toBe('MOVE_TOO_LARGE');
    expect(await answer(big.id)).toEqual(a);
  });
});

describe('no size oracle: a caller who may write the source but not the destination', () => {
  it('gets the small-subtree answer for a big one', async () => {
    const other = await createDbOrgAndGraph(db, { orgName: 'mv5128-other', graphName: 'foreign', visibility: 'PUBLIC' });
    const srcOrg = (await db.memory.findUniqueOrThrow({ where: { id: src.id }, select: { organizationId: true } })).organizationId!;
    const writer = await db.user.create({ data: { githubId: 51283, githubUsername: 'mv5128-writer', roles: [] } });
    await db.orgMember.create({ data: { organizationId: srcOrg, userId: writer.id, role: 'ADMIN' } });
    const writerCtx = (): Context => ({ db, userId: writer.id, roles: [] });
    const small = await subtree(src.id, 'small3', 0);
    const big = await subtree(src.id, 'large3', 5);
    const answer = async (id: string) => {
      const e = await M.moveNode(null, { sourceRef: id, targetUrn: nodeUrn(other.graph, 'z') }, writerCtx()).catch((x: any) => x);
      return { code: e.extensions?.code, message: String(e.message).split(id).join('<id>') };
    };
    const a = await answer(small.id);
    expect(a.code).toBeDefined();
    expect(a.code).not.toBe('MOVE_TOO_LARGE');
    expect(await answer(big.id)).toEqual(a);
  });
});

describe('assertMoveWithinSizeLimit', () => {
  it('counts only live descendants on a path boundary', async () => {
    const root = await subtree(src.id, 'r', 3);
    await createDbNode(db, { memoryId: src.id, loc: 'r-sibling' });
    const gone = await createDbNode(db, { memoryId: src.id, loc: 'r:gone' });
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    // 4 live nodes: r + 3 children; r-sibling and the deleted child are not counted.
    await expect(assertMoveWithinSizeLimit(db as never, root)).resolves.toBeUndefined();
    vi.stubEnv('MOVE_NODE_MAX_NODES', '3');
    await expect(assertMoveWithinSizeLimit(db as never, root)).rejects.toMatchObject({ limit: 3, count: 4 });
  });
});

describe('the edge lookup at any size (independent of the limit)', () => {
  const fakeIds = (n: number) => Array.from({ length: n }, () => generateId());

  it('does not hit the bind-variable cap with 40,000 ids (more than 32,767)', async () => {
    await expect(findLiveEdgesTouching(db as never, fakeIds(4 * EDGE_LOOKUP_CHUNK))).resolves.toEqual([]);
  });

  it('finds an edge whose endpoint is in a later chunk, once, even when both endpoints are in different chunks', async () => {
    const a = await createDbNode(db, { memoryId: src.id, loc: 'ea' });
    const b = await createDbNode(db, { memoryId: src.id, loc: 'eb' });
    const edge = await db.edge.create({ data: { id: generateId(), memoryId: src.id, sourceId: a.id, targetId: b.id, loc: 'ea:ref:eb', name: 'ref' } });
    const ids = [a.id, ...fakeIds(EDGE_LOOKUP_CHUNK), b.id, ...fakeIds(5)];
    const found = await findLiveEdgesTouching(db as never, ids);
    expect(found.map(e => e.id)).toEqual([edge.id]);
    expect((await findLiveEdgesTouching(db as never, [...fakeIds(EDGE_LOOKUP_CHUNK + 500), b.id])).map(e => e.id)).toEqual([edge.id]);
  });
});
