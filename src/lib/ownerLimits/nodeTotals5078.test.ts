/**
 * #5078 (Billing A7d): an owner's `nodes` figure from per-memory totals kept by triggers on `nodes`. Every pin compares the stored figure
 * with a recount, per memory and per owner, after a write through the real door.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, makeTmpDir } from '../../test/helpers.js';
import { approvedMergeProof } from '../../test/mergeConsent.js';
import { expectNodeTotalsExact } from '../../test/nodeTotals.js';
import { mergeUsers } from '../../controller/operations/mergeUsers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from '../../integrations/github/syncGraphFromGithub.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../id.js';
import type { OwnerRef } from '../owner.js';
import { reloadOwnerDefaultLimitsForTests } from './defaults.js';
import { OwnerLimitReachedError } from './errors.js';
import { requireOwnerHeadroom } from './gate.js';
import { countOwnerNodesOnDemand, OWNER_LIMIT_KEYS } from './keys.js';
import { main as reconcile } from '../../../scripts/db/reconcile-memory-node-totals.js';

let graphsPath = '';
vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as (...a: unknown[]) => void)(null, { stdout: (args[1] as string[]).includes('rev-list') ? '0\n' : '', stderr: '' });
}) }));
vi.mock('../../integrations/github/githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fake'), toHttpsUrl: vi.fn((s: string) => s) }));
vi.mock('../../config.js', async (original) => ({ ...await original<typeof import('../../config.js')>(), get GRAPHS_PATH() { return graphsPath; } }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let admin: string;
let orgA: string;
let orgB: string;
let a1: { id: string; urn: string };
let a2: { id: string; urn: string };
let b1: { id: string; urn: string };

const ctx = (): Context => ({ db, userId: admin, roles: [], clientId: `user:${admin}` }) as unknown as Context;
const node = (memoryId: string, loc: string, data: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `Body ${loc}`, ...data } as never });
const used = (owner: OwnerRef) => OWNER_LIMIT_KEYS.nodes.count(db, owner);
const A = (): OwnerRef => ({ organizationId: orgA });
const B = (): OwnerRef => ({ organizationId: orgB });

/** Per memory and per owner, from the stored figure and from the rows. */
async function expectExact(...owners: OwnerRef[]) {
  await expectNodeTotalsExact(db);
  for (const owner of [A(), B(), ...owners]) expect(await used(owner)).toBe(await countOwnerNodesOnDemand(db, owner));
}
/** The write moved the owner's figure by this much, and it is still exact. */
async function moves(owner: OwnerRef, by: bigint, write: () => Promise<unknown>) {
  const before = await used(owner);
  await write();
  expect(await used(owner) - before).toBe(by);
  await expectExact(owner);
}

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  admin = (await db.user.create({ data: { id: generateId(), handle: 'nt-admin', roles: ['READER'] } })).id;
  [orgA, orgB] = [generateId(), generateId()];
  for (const [id, urn] of [[orgA, 'nt-a'], [orgB, 'nt-b']] as const) {
    await db.organization.create({ data: { id, name: urn, urn } });
    await db.orgMember.create({ data: { organizationId: id, userId: admin, role: 'OWNER' } });
  }
  const memory = (organizationId: string, root: string, slug: string) =>
    db.memory.create({ data: { id: generateId(), name: slug, urn: `${root}:${slug}`, class: 'knowledge', organizationId } });
  a1 = await memory(orgA, 'nt-a', 'one');
  a2 = await memory(orgA, 'nt-a', 'two');
  b1 = await memory(orgB, 'nt-b', 'one');
});
afterEach(() => { vi.unstubAllEnvs(); reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5078 every kind of write keeps the figure equal to a recount', () => {
  it('a node created through GraphQL and through MCP', async () => {
    await moves(A(), 1n, () => M.createNode({}, { input: { memoryId: a1.id, loc: 'g', name: 'g', content: 'x' } }, ctx()));
    const mcp = createTestableMcpServer({ userId: admin, roles: [], clientId: `user:${admin}` });
    await moves(A(), 1n, () => mcp.callToolText('hadron_create_node', { urn: `hrn:node:${a1.urn}:m`, name: 'm', content: 'x' }));
  });

  it('a soft delete, a restore and a revive at the tombstone\'s loc', async () => {
    const n = await node(a1.id, 'n');
    await moves(A(), -1n, () => M.deleteNode({}, { nodeRef: n.id }, ctx()));
    await moves(A(), 1n, () => M.restoreNode({}, { nodeRef: n.id }, ctx()));
    await moves(A(), -1n, () => M.deleteNode({}, { nodeRef: n.id }, ctx()));
    await moves(A(), 1n, () => M.createNode({}, { input: { memoryId: a1.id, loc: 'n', name: 'again', content: 'x' } }, ctx()));
  });

  it('a recursive soft delete and a hard delete, of live rows and of tombstones', async () => {
    const p = await node(a1.id, 'p');
    await node(a1.id, 'p:x');
    await node(a1.id, 'p:y', { deletedAt: new Date() });
    await moves(A(), -2n, () => M.deleteNode({}, { nodeRef: p.id, recursive: true }, ctx()));
    const q = await node(a1.id, 'q');
    await node(a1.id, 'q:x');
    await node(a1.id, 'q:y', { deletedAt: new Date() });
    await moves(A(), -2n, () => M.deleteNode({}, { nodeRef: q.id, hard: true, recursive: true }, ctx()));
  });

  it('a move inside one owner, to another owner, of one node and of a subtree', async () => {
    const n = await node(a1.id, 'n');
    const p = await node(a1.id, 'p');
    await node(a1.id, 'p:x');
    await moves(A(), 0n, () => M.moveNode(null, { sourceRef: n.id, targetMemoryRef: a2.id }, ctx()));
    expect(await db.node.count({ where: { memoryId: a2.id } })).toBe(1);
    await moves(A(), -2n, () => M.moveNode(null, { sourceRef: p.id, targetMemoryRef: b1.id }, ctx()));
    expect(await used(B())).toBe(2n);
  });

  it('mergeNodes and mergeMemories', async () => {
    const s = await node(a1.id, 's');
    const t = await node(a2.id, 't');
    await moves(A(), -1n, () => M.mergeNodes({}, { input: { source: s.id, target: t.id, deleteSource: true } }, ctx()));
    await node(a1.id, 't');
    await node(a1.id, 'u');
    await moves(A(), -1n, () => M.mergeMemories(null, { input: { source: a1.id, target: a2.id } }, ctx()));
    expect(await db.node.count({ where: { memoryId: a1.id, deletedAt: null } })).toBe(0);
  });

  it('cloneNode and cloneMemory', async () => {
    const n = await node(a1.id, 'n');
    await node(a1.id, 'dead', { deletedAt: new Date() });
    await moves(A(), 1n, () => M.cloneNode({}, { sourceRef: n.id, targetUrn: `hrn:node:${a1.urn}:copy` }, ctx()));
    const before = await used(A());
    await M.cloneMemory(null, { ref: a1.id, targetUrn: 'hrn:mem:nt-a:clone' }, ctx());
    expect(await used(A())).toBeGreaterThan(before);
    await expectExact();
  });

  it('a GitHub sync that adds and deletes', async () => {
    const tmp = makeTmpDir();
    graphsPath = tmp.dir;
    try {
      await db.organization.update({ where: { id: orgA }, data: { githubInstallationId: 5078 } });
      const graph = await db.memory.update({
        where: { id: a1.id }, data: { source: 'git@github.com:test/repo.git', readBranch: 'main' }, include: { organization: true },
      }) as MemoryWithOrg;
      const repo = join(graphsPath, 'nt-a', 'one');
      mkdirSync(repo, { recursive: true });
      const file = (f: string) => writeFileSync(join(repo, `${f}.md`), `---\nname: ${f}\n---\nBody ${f}`);
      file('x');
      file('y');
      expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
      expect(await used(A())).toBeGreaterThanOrEqual(2n);
      await expectExact();
      rmSync(join(repo, 'x.md'));
      file('z');
      expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
      expect(await db.node.findFirst({ where: { memoryId: a1.id, loc: 'z', deletedAt: null } })).not.toBeNull();
      await expectExact();
    } finally { tmp.cleanup(); }
  });

  it('raw statements over many rows, a mixed upsert, and a write that changes neither column', async () => {
    for (let i = 0; i < 6; i++) await node(i % 2 ? a1.id : b1.id, `n${i}`);
    await db.$executeRaw`UPDATE nodes SET memory_id = ${a2.id} WHERE memory_id IN (${a1.id}, ${b1.id})`;
    await expectExact();
    expect(await used(B())).toBe(0n);
    await db.$executeRaw`UPDATE nodes SET deleted_at = now() WHERE loc IN ('n0', 'n1', 'n2')`;
    await expectExact();
    await db.$executeRaw`UPDATE nodes SET deleted_at = CASE WHEN deleted_at IS NULL THEN now() END, memory_id = ${a1.id}`;
    await expectExact();
    await db.$executeRaw`UPDATE nodes SET deleted_at = now() + interval '1 day' WHERE deleted_at IS NOT NULL`;
    await db.$executeRaw`UPDATE nodes SET content = 'edited', memory_id = memory_id`;
    await expectExact();
    expect(await used(A())).toBe(3n);
    const [live] = await db.node.findMany({ where: { memoryId: a1.id, deletedAt: null }, take: 1 });
    await db.$executeRaw`
      INSERT INTO nodes (id, memory_id, loc, name, updated_at)
      VALUES (${generateId()}, ${a1.id}, 'fresh', 'f', now()), (${live.id}, ${a1.id}, ${live.loc}, 'f', now())
      ON CONFLICT (id) DO UPDATE SET deleted_at = now()`;
    await expectExact();
    expect(await used(A())).toBe(3n);
  });

  it('a memory\'s hard delete leaves no figure, and a TRUNCATE zeroes them all', async () => {
    await node(a1.id, 'n');
    await node(a2.id, 'n');
    await db.memory.delete({ where: { id: a1.id } });
    expect(await db.memoryNodeTotal.findMany({ select: { memoryId: true } })).toEqual([{ memoryId: a2.id }]);
    await expectExact();
    await db.$executeRaw`TRUNCATE nodes CASCADE`;
    await expectExact();
    expect(await used(A())).toBe(0n);
  });
});

describe('#5078 an owner-level change needs no write to the totals', () => {
  it('a memory soft-deleted, and an organization soft-deleted', async () => {
    await node(a1.id, 'n');
    await node(a2.id, 'n');
    await moves(A(), -1n, () => M.deleteMemory({}, { ref: a1.id }, ctx()));
    await M.deleteOrganization({}, { ref: orgA }, ctx());
    await expectExact();
  });

  it('transferMemoryOwnership and an account merge', async () => {
    const [p, q] = await Promise.all(['nt-p', 'nt-q'].map(async (handle) =>
      (await db.user.create({ data: { id: generateId(), handle, roles: ['READER'] } })).id));
    const P: OwnerRef = { userId: p };
    const Q: OwnerRef = { userId: q };
    await db.orgMember.create({ data: { organizationId: orgB, userId: p, role: 'ADMIN' } });
    const personal = (slug: string) => db.memory.create({ data: {
      id: generateId(), name: slug, urn: `nt-p:${slug}`, class: 'private', ownerUserId: p, userId: p, organizationId: null,
    } });
    const given = await personal('given');
    await node(given.id, 'n');
    await node((await personal('kept')).id, 'n');
    const asP = { db, userId: p, roles: ['READER'] } as unknown as Context;
    const input = { memoryRef: given.id, orgRef: orgB, targetClass: 'knowledge' };
    const { newUrn } = await M.transferMemoryOwnership(null, { ...input, dryRun: true }, asP);
    await M.transferMemoryOwnership(null, { ...input, expectedNewUrn: newUrn }, asP);
    expect([await used(P), await used(B())]).toEqual([1n, 1n]);
    await expectExact(P, Q);
    await mergeUsers(db, { sourceUserId: p, targetUserId: q, actorUserId: admin, consentProof: await approvedMergeProof(db, p, q, admin) });
    expect([await used(P), await used(Q)]).toEqual([0n, 1n]);
    await expectExact(P, Q);
  });
});

describe('#5078 concurrency', () => {
  it('20 inserts into one memory, and 20 into different memories of one owner, end exact', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => db.$transaction((tx) =>
      tx.node.create({ data: { id: generateId(), memoryId: a1.id, loc: `n${i}`, name: 'n' } }), { maxWait: 30_000 })));
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => db.memory.create({ data: {
      id: generateId(), name: `m${i}`, urn: `nt-a:m${i}`, class: 'knowledge', organizationId: orgA } })));
    await Promise.all(many.map((m) => db.$transaction((tx) =>
      tx.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'n', name: 'n' } }), { maxWait: 30_000 })));
    expect(await used(A())).toBe(40n);
    await expectExact();
  });

  it('two subtrees moved A to B and B to A at once both commit', async () => {
    for (let round = 0; round < 5; round++) {
      const [x, y] = [await node(a1.id, `x${round}`), await node(b1.id, `y${round}`)];
      for (let i = 0; i < 5; i++) {
        await node(a1.id, `x${round}:c${i}`);
        await node(b1.id, `y${round}:c${i}`);
      }
      await Promise.all([
        M.moveNode(null, { sourceRef: x.id, targetMemoryRef: b1.id }, ctx()),
        M.moveNode(null, { sourceRef: y.id, targetMemoryRef: a1.id }, ctx()),
      ]);
      await expectExact();
    }
  });

  it('a rolled-back insert leaves the figure unchanged; inside the transaction its own writes count', async () => {
    await node(a1.id, 'n');
    await expect(db.$transaction(async (tx) => {
      await tx.node.create({ data: { id: generateId(), memoryId: a1.id, loc: 'gone', name: 'n' } });
      expect(await OWNER_LIMIT_KEYS.nodes.count(tx, A())).toBe(2n);
      await tx.node.updateMany({ where: { memoryId: a1.id }, data: { deletedAt: new Date() } });
      expect(await OWNER_LIMIT_KEYS.nodes.count(tx, A())).toBe(0n);
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect(await used(A())).toBe(1n);
    await expectExact();
  });

  it('two concurrent gated inserts at one below the limit end with exactly one pass', async () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '{"organization":{"nodes":3}}' });
    await node(a1.id, 'n1');
    await node(a2.id, 'n2');
    const write = (memoryId: string, loc: string) => db.$transaction(async (tx) => {
      await requireOwnerHeadroom(tx, { owner: A(), key: 'nodes', caller: null });
      await tx.node.create({ data: { id: generateId(), memoryId, loc, name: 'n' } });
    }, { maxWait: 30_000, timeout: 30_000 });
    const results = await Promise.allSettled([write(a1.id, 'x'), write(a2.id, 'y'), write(a1.id, 'z')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(OwnerLimitReachedError);
    expect(await used(A())).toBe(3n);
    await expectExact();
  });
});

describe('#5078 the switch and the reconcile script', () => {
  const corrupt = () => db.$executeRaw`UPDATE memory_node_totals SET live_nodes = live_nodes + 40 WHERE memory_id = ${a1.id}`;
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await reconcile(argv, { env: process.env, log: (l) => lines.push(l) });
    return { code, lines };
  };
  /** Every write in here happens with the triggers off. */
  async function untracked(write: () => Promise<unknown>) {
    const triggers = await db.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname::text FROM pg_trigger WHERE tgrelid = 'nodes'::regclass AND tgname LIKE 'memory_node_total%'`;
    expect(triggers.length).toBeGreaterThanOrEqual(4);
    for (const t of triggers) await db.$executeRawUnsafe(`ALTER TABLE nodes DISABLE TRIGGER ${t.tgname}`);
    try { await write(); } finally {
      for (const t of triggers) await db.$executeRawUnsafe(`ALTER TABLE nodes ENABLE TRIGGER ${t.tgname}`);
    }
  }

  it('only the exact value on-demand counts the rows, read per call, in the helper too', async () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '{"organization":{"nodes":2}}' });
    await node(a1.id, 'n');
    await corrupt();
    const gate = () => db.$transaction((tx) => requireOwnerHeadroom(tx, { owner: A(), key: 'nodes', caller: null }));
    for (const value of ['', 'ON-DEMAND', 'on-demand ', 'true']) {
      vi.stubEnv('OWNER_NODE_COUNT_SOURCE', value);
      expect(await used(A())).toBe(41n);
      await expect(gate()).rejects.toBeInstanceOf(OwnerLimitReachedError);
    }
    vi.stubEnv('OWNER_NODE_COUNT_SOURCE', 'on-demand');
    expect(await used(A())).toBe(1n);
    await gate();
  });

  it('reports exactly the drifted memories, repairs them, and then reports nothing', async () => {
    const [n] = [await node(a1.id, 'n'), await node(b1.id, 'ok')];
    await untracked(async () => {
      await db.node.delete({ where: { id: n.id } });
      for (let i = 0; i < 3; i++) await node(a2.id, `n${i}`);
    });
    const tag = 'db.memory_node_totals_reconcile';
    const drift = [[a1.id, 1, 0], [a2.id, 0, 3]].sort(([x], [y]) => (x! < y! ? -1 : 1))
      .map(([id, stored, counted]) => `${tag}.drift memory=${id} stored=${stored} counted=${counted}`);
    expect(await run()).toEqual({ code: 1, lines: [...drift, `${tag} dry_run drifted=2`] });
    expect(await run('--apply')).toEqual({ code: 0, lines: [...drift, `${tag} applied drifted=2`] });
    await expectExact();
    expect(await run()).toEqual({ code: 0, lines: [`${tag} dry_run drifted=0`] });
  });

  it('a negative figure never fails a delete and is reported', async () => {
    const n = await node(a1.id, 'n');
    await db.$executeRaw`UPDATE memory_node_totals SET live_nodes = 0 WHERE memory_id = ${a1.id}`;
    await db.node.delete({ where: { id: n.id } });
    expect((await run()).lines[0]).toContain('stored=-1 counted=0');
  });

  it('--apply racing concurrent inserts into the same memory ends exact', async () => {
    await untracked(async () => { for (let i = 0; i < 5; i++) await node(a1.id, `n${i}`); });
    await Promise.all([run('--apply'), ...Array.from({ length: 15 }, (_, i) => db.$transaction((tx) =>
      tx.node.create({ data: { id: generateId(), memoryId: a1.id, loc: `r${i}`, name: 'n' } }), { maxWait: 30_000 }))]);
    expect(await used(A())).toBe(20n);
    await expectExact();
  });

  it('refuses unknown arguments and a missing URL, and never prints the URL on a failure', async () => {
    expect((await run('--force')).code).toBe(2);
    const lines: string[] = [];
    const io = (env: NodeJS.ProcessEnv) => ({ env, log: (l: string) => lines.push(l) });
    expect(await reconcile([], io({}))).toBe(2);
    expect(await reconcile([], io({ DATABASE_URL: 'postgresql://nobody:hunter2@127.0.0.1:1/none' }))).toBe(1);
    expect(lines.join('\n')).not.toMatch(/hunter2|127\.0\.0\.1/);
  });
});
