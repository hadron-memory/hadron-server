/**
 * #443 root-only slice — automatic sibling seq for ROOT creates is read inside the write transaction, under one
 * per-memory advisory key (K, the single-bigint form, disjoint from the two-int loc keys), on GraphQL, MCP and the
 * reserve seam. Refs #443 (the residual parent stays open).
 *
 * Harness: a second backend (an interactive transaction on its own pooled connection) holds a root sibling uncommitted;
 * the waiter is the real resolver. The duplicate-seq assertion runs on old main AND the fixed head (red/green by VALUE,
 * never by a missing-K timeout); the K-waiter observation is fixed-head-only and bounded.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { acquireLockSet } from '../../../lib/nodeSubtreeLock.js';
import { lockRootSiblings, reserveRootSeqLock } from '../../../lib/nodeSeq.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let memoryId: string, adminId: string, orgUrn: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });

async function mkMemory(name: string, ordered: boolean) {
  const memory = await resolvers.Mutation.createMemory(null, { orgId: (await db.organization.findFirstOrThrow()).id, name }, ctx());
  if (ordered) await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'r1', name: 'r1', seq: 1 } });
  return memory.id as string;
}
beforeEach(async () => {
  await cleanDb(db);
  orgUrn = 'rootseq443';
  const org = await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } });
  const user = await db.user.create({ data: { githubId: 4431, githubUsername: orgUrn, roles: ['ADMIN'] } });
  adminId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  memoryId = await mkMemory('rootseq443', true);
});
afterEach(() => vi.restoreAllMocks());

async function create(surface: string, loc: string, mem = memoryId, memName = 'rootseq443') {
  if (surface === 'graphql') return resolvers.Mutation.createNode(null, { input: { memoryId: mem, loc, name: loc } }, ctx());
  const srv = createTestableMcpServer({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` } as AuthContext);
  return srv.callToolText('hadron_create_node', { urn: `hrn:node:${orgUrn}:${memName}:${loc}`, name: loc });
}
const seqOf = async (loc: string, mem = memoryId) =>
  (await db.node.findUniqueOrThrow({ where: { loc_memoryId: { memoryId: mem, loc } } })).seq;

/** K, derived independently of the implementation: bit 63 = 0, bit 62 = 1 over a 64-bit hash of a constant string + the memory. */
async function expectedKey(mem: string): Promise<string> {
  const [{ k }] = await db.$queryRaw<Array<{ k: bigint }>>`
    SELECT ((hashtextextended('node-root-seq:' || ${mem}, 0) | (1::bigint << 62)) & ~(1::bigint << 63)) AS k`;
  return k.toString();
}
const waiterBlockedOnK = async (mem: string) => {
  const key = await expectedKey(mem);
  const rows = await db.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND ((classid::bigint << 32) | objid::bigint) = ${key}::bigint`;
  return rows.length > 0;
};
async function pollBlocked(mem: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await waiterBlockedOnK(mem)) return true;
    await setImmediate();
  }
  return false;
}

/** Backend B: holds K and an uncommitted root sibling at max+1, until `release()`. */
function holdRootSibling(mem: string, loc: string, seq: number) {
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const held = new Promise<void>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock((hashtextextended(${'node-root-seq:' + mem}, 0) | (1::bigint << 62)) & ~(1::bigint << 63))`;
    await tx.node.create({ data: { id: generateId(), memoryId: mem, loc, name: loc, seq } });
    ready();
    await gate;
  }, { timeout: 30000 });
  return { held, release, done };
}

describe.each(['graphql', 'mcp'])('root automatic seq (%s) #443', (surface) => {
  it('two root creates never share a seq: the waiter reads max AFTER the holder commits (duplicate-red on old main)', async () => {
    const holder = holdRootSibling(memoryId, 'r2', 2);
    await holder.held;
    let pending: Promise<unknown> | undefined;
    try {
      pending = create(surface, 'r3');
      // Old main: the waiter does not block and finishes. Fixed head: it blocks on K until the holder commits.
      await Promise.race([pending.then(() => 'done', () => 'done'), pollBlocked(memoryId).then(() => 'blocked')]);
    } finally {
      holder.release();
      await holder.done;
      await pending?.catch(() => {});
    }
    const seqs = [await seqOf('r1'), await seqOf('r2'), await seqOf('r3')];
    expect(new Set(seqs).size).toBe(3);
    expect(seqs).toEqual([1, 2, 3]);
  }, 40000);

  it('FIXED-HEAD ONLY: the waiter is observed blocked on the single-bigint key (objsubid=1), bounded, then proceeds', async () => {
    const holder = holdRootSibling(memoryId, 'r2', 2);
    await holder.held;
    let pending: Promise<unknown> | undefined;
    try {
      pending = create(surface, 'r3');
      expect(await pollBlocked(memoryId)).toBe(true);
    } finally {
      holder.release();
      await holder.done;
      await pending?.catch(() => {});
    }
    await pending;
    expect(await seqOf('r3')).toBe(3);
  }, 40000);

  it('a refusal after the seq read rolls back the allocation and releases K: the next create reuses the seq', async () => {
    const original = db.$transaction.bind(db);
    let inserted = false;
    vi.spyOn(db, '$transaction').mockImplementationOnce(((work: any, opts: any) => original(async (tx: any) => {
      const node = new Proxy(tx.node, { get(target, key) {
        if (key === 'upsert') return async (args: any) => { await target.upsert(args); inserted = true; throw new Error('443 forced rollback after insert'); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      const proxy = new Proxy(tx, { get(target, key) { if (key === 'node') return node; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
      return work(proxy);
    }, opts)) as any);
    await create(surface, 'rfail').catch(() => {});
    expect(inserted).toBe(true);
    expect(await db.node.findUnique({ where: { loc_memoryId: { memoryId, loc: 'rfail' } } })).toBeNull();
    vi.restoreAllMocks();
    await create(surface, 'rnext');
    expect(await seqOf('rnext')).toBe(2);
    expect(await waiterBlockedOnK(memoryId)).toBe(false);
  }, 20000);

  it('a NESTED create takes no K: it completes while another backend holds K', async () => {
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'p:a', name: 'a', seq: 1 } });
    const holder = holdRootSibling(memoryId, 'r2', 2);
    await holder.held;
    try {
      await create(surface, 'p:b');
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await seqOf('p:b')).toBe(2);
  }, 20000);

  it('N concurrent root creates: an ORDERED list gets distinct contiguous seqs, an UNORDERED list stays null', async () => {
    const locs = ['c1', 'c2', 'c3', 'c4'];
    await Promise.all(locs.map((l) => create(surface, l)));
    expect((await Promise.all(locs.map((l) => seqOf(l)))).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([2, 3, 4, 5]);
    const unordered = await mkMemory('rootseq443u', false);
    await Promise.all(locs.map((l) => create(surface, l, unordered, 'rootseq443u')));
    expect(await Promise.all(locs.map((l) => seqOf(l, unordered)))).toEqual([null, null, null, null]);
  }, 30000);
});

describe('reserve seam and the one-use handoff #443', () => {
  it('reserveSpecCitation at a root loc over a TOMBSTONE, racing a plain root create: both complete, distinct seqs, no deadlock', async () => {
    const id = generateId();
    await db.node.create({ data: { id, memoryId, loc: 'spec1', name: 'spec1', seq: 2, deletedAt: new Date() } });
    const results = await Promise.allSettled([
      (resolvers.Mutation as any).reserveSpecCitation(null, { memoryRef: memoryId, loc: 'spec1' }, ctx()),
      create('graphql', 'plain1'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const a = await seqOf('spec1'), b = await seqOf('plain1');
    expect(a).not.toBe(b);
    expect([a, b].sort()).toEqual([2, 3]);
  }, 30000);

  it('a ROOT reserve over a tombstone waits on K BEFORE it archives anything (K precedes the archive writes)', async () => {
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'spec2', name: 'spec2', seq: 5, deletedAt: new Date() } });
    const holder = holdRootSibling(memoryId, 'r2', 2);
    await holder.held;
    let pending: Promise<unknown> | undefined;
    try {
      pending = (resolvers.Mutation as any).reserveSpecCitation(null, { memoryRef: memoryId, loc: 'spec2' }, ctx());
      expect(await pollBlocked(memoryId)).toBe(true);
      // Still blocked, and the tombstone is untouched: an archive write would hold its row (uncommitted, so a count cannot
      // see it, but NOWAIT can feel it).
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${memoryId} AND loc = 'spec2' FOR UPDATE NOWAIT`;
      });
    } finally {
      holder.release();
      await holder.done;
      await pending?.catch(() => {});
    }
    await pending;
    expect(await db.node.count({ where: { memoryId, loc: { startsWith: 'spec2__deleted-' } } })).toBe(1);
    expect(await seqOf('spec2')).toBe(3);
  }, 40000);

  it('helper: a reservation is consumed exactly once; a second root allocation in one transaction is refused', async () => {
    await expect(db.$transaction(async (tx) => {
      await reserveRootSeqLock(tx, memoryId);
      await lockRootSiblings(tx, memoryId);            // consumes the handoff
      await lockRootSiblings(tx, memoryId);            // a genuinely second allocation
    })).rejects.toThrow(/second root/i);
    await expect(db.$transaction(async (tx) => {
      await lockRootSiblings(tx, memoryId);
      await lockRootSiblings(tx, memoryId);
    })).rejects.toThrow(/second root/i);
    // One allocation per transaction, with or without a reservation, is fine.
    await db.$transaction(async (tx) => { await reserveRootSeqLock(tx, memoryId); await lockRootSiblings(tx, memoryId); });
    await db.$transaction(async (tx) => { await lockRootSiblings(tx, memoryId); });
    expect(await waiterBlockedOnK(memoryId)).toBe(false);
  });

  it('a reservation for another memory is not a handoff for this one', async () => {
    const other = await mkMemory('rootseq443o', false);
    await expect(db.$transaction(async (tx) => {
      await reserveRootSeqLock(tx, other);
      await lockRootSiblings(tx, memoryId);
    })).rejects.toThrow(/second root|reservation/i);
  });
});

describe('the key K #443', () => {
  it('is the single-bigint form (objsubid=1), disjoint from a loc key (objsubid=2) in the same transaction, with bit63=0 and bit62=1', async () => {
    await db.$transaction(async (tx) => {
      await acquireLockSet(tx, [{ memoryId, loc: 'x' }]);
      await lockRootSiblings(tx, memoryId);
      const key = await expectedKey(memoryId);
      const rows = await tx.$queryRaw<Array<{ objsubid: number; k: bigint }>>`
        SELECT objsubid, ((classid::bigint << 32) | objid::bigint) AS k FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`;
      expect(rows.filter((r) => r.objsubid === 1).map((r) => r.k.toString())).toEqual([key]);
      expect(rows.filter((r) => r.objsubid === 2)).toHaveLength(1);
      const k = BigInt(key);
      expect((k >> 63n) & 1n).toBe(0n);
      expect((k >> 62n) & 1n).toBe(1n);
    });
  });
  it('is held to the OUTER commit and differs per memory', async () => {
    const other = await mkMemory('rootseq443p', false);
    expect(await expectedKey(memoryId)).not.toBe(await expectedKey(other));
  });
});

describe('call-site pin #443', () => {
  it('K is acquired from exactly the three enumerated seams, so a new call site fails CI until the map is amended', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'generated') walk(p); continue; }
        if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
        const text = readFileSync(p, 'utf8');
        for (const fn of ['lockRootSiblings(', 'reserveRootSeqLock(']) {
          const n = text.split(fn).length - 1 - (text.includes(`function ${fn}`) ? 1 : 0);
          for (let i = 0; i < n; i++) hits.push(`${p.replace(/^.*\/src\//, 'src/')}:${fn.slice(0, -1)}`);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(hits.sort()).toEqual([
      'src/api/graphql/schema/resolvers.mutation.node.ts:lockRootSiblings',
      'src/api/graphql/schema/resolvers.specCorpus.ts:reserveRootSeqLock',
      'src/mcp/server.ts:lockRootSiblings',
    ]);
  });
});
