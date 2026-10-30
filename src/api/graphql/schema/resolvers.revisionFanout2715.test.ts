/**
 * #2715 Slice 2: `Node.revision` on a `nodeBatch` list no longer opens one interactive transaction per parent all at
 * once. Each field's reconcile (`reconciledNodeForParent` -> `withReconciledNodeRead`, maxWait 2000 ms) is queued
 * app-side, at most NODE_RECONCILE_CONCURRENCY in flight per request, so a 200-node batch cannot exhaust the pool's
 * start-wait window (Prisma P2028 at `nodeBatch.nodes.<i>.revision`, the production fault).
 *
 * Red first. On main the field fan-out requests all N transactions at once (the structural pin), and a burst of 200-node
 * batches at the production-equivalent pool P=5 fails with P2028 (the burst pin; Slice 1 receipt, issue comment
 * 6485113027: P=5 is Prisma 6.19.2's default on production's 2 physical cores, Hugo #43495). The CONTROLS are green on
 * main and must stay green: snapshot pairing of revision and content, authorization, and no reconcile writes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const N = 200;
/** Production-equivalent pool (Slice 1). */
const P = 5;
/** A 200-node batch runs its serial pre-reconcile and the bounded fields; slow CI runners need more than vitest's 5 s. */
const SLOW = { timeout: 60_000 };

const schema = buildSchema(typeDefs);
const fieldResolver = (parent: any, args: any, context: any, info: any) => {
  const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
  const fn = fields?.[info.fieldName];
  return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
};

let pool: PrismaClient;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', String(P));
  pool = new PrismaClient({ datasourceUrl: url.toString() });
});
afterAll(async () => { await pool.$disconnect(); });

let memoryId: string;
let userId: string;
let foreignNodeId: string;
beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'fan2715', graphName: 'fanmem' });
  memoryId = graph.id;
  const user = await db.user.create({ data: { handle: 'fan2715' } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  await db.node.createMany({ data: Array.from({ length: N }, (_, i) => ({
    memoryId, loc: `batch:n${String(i).padStart(3, '0')}`, name: `n${i}`, nodeType: 'record', content: `body ${i}`,
  })) as never });
  // Another user's personal memory: its node is the denied case (ADMIN does not bypass personal ownership).
  const other = await db.user.create({ data: { handle: 'fan2715-other' } });
  const personal = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'fan2715:mine', name: 'mine', userId: other.id, class: 'personal', visibility: null } as never });
  foreignNodeId = (await db.node.create({ data: { memoryId: personal.id, loc: 'secret', name: 'secret', nodeType: 'record', content: 'theirs' } as never })).id;
  // Warm: reconcile the fixture once, so the measured batches are unchanged rows (production's steady state).
  await batch(ctxFor(db), 'id revision');
}, 120_000);

/** A ctx.db whose field-reconcile transactions (maxWait 2000) are counted while requested and not yet settled. */
function ctxFor(client: PrismaClient | typeof db, track?: { inFlight: number; max: number }) {
  const tx = (fn: unknown, opts?: { maxWait?: number }) => {
    if (!track || typeof fn !== 'function' || opts?.maxWait !== 2_000) return (client.$transaction as any)(fn, opts);
    track.inFlight++;
    track.max = Math.max(track.max, track.inFlight);
    return (client.$transaction as any)(fn, opts).finally(() => { track.inFlight--; });
  };
  const proxied = new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction') return tx;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: proxied, roles: [], userId } as unknown as Context;
}

const batch = (ctx: Context, sel: string, args = `memory: "${'$m'}", locPrefix: "batch"`) =>
  graphql({ schema, fieldResolver, contextValue: ctx,
    source: `query($m: ID!) { nodeBatch(${args.replace('"$m"', '$m')}) { nodes { ${sel} } unavailable } }`,
    variableValues: { m: memoryId } });

describe('#2715 the Node.revision fan-out is bounded per request', () => {
  it('a 200-node batch never has more than a handful of field reconcile transactions requested at once', SLOW, async () => {
    const track = { inFlight: 0, max: 0 };
    const res = await batch(ctxFor(db, track), 'id revision');
    expect(res.errors).toBeUndefined();
    expect((res.data!.nodeBatch as any).nodes).toHaveLength(N);
    expect(track.max).toBeGreaterThan(0);
    expect(track.max).toBeLessThanOrEqual(4); // NODE_RECONCILE_CONCURRENCY
  });

  it(`a burst of 20 batches of ${N} at the production-equivalent pool P=${P} returns every node and revision, with no P2028`, { timeout: 180_000 }, async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => batch(ctxFor(pool), 'id revision')));
    const errors = all.flatMap((r) => r.errors ?? []);
    expect(errors.map((e) => `${e.path?.join('.')}: ${String((e.originalError as { code?: string })?.code ?? e.message).slice(0, 60)}`)).toEqual([]);
    for (const r of all) {
      const nodes = (r.data!.nodeBatch as any).nodes as Array<{ id: string; revision: number | null }>;
      expect(nodes).toHaveLength(N);
      expect(nodes.every((n) => typeof n.revision === 'number')).toBe(true);
    }
  });
});

describe('#2715 CONTROLS: what the bound must not change', () => {
  it('an unchanged batch makes no reconcile writes', SLOW, async () => {
    const before = await db.nodeRevision.count({ where: { node: { memoryId } } });
    const res = await batch(ctxFor(db), 'id revision content');
    expect(res.errors).toBeUndefined();
    expect(await db.nodeRevision.count({ where: { node: { memoryId } } })).toBe(before);
  });

  it('a raw writer\'s drift is reconciled once, and each node pairs its revision with its own content', SLOW, async () => {
    const drifted = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'batch:n007' } });
    await db.$executeRaw`UPDATE nodes SET content = 'raw edit' WHERE id = ${drifted.id}`;
    const res = await batch(ctxFor(db), 'id revision content');
    expect(res.errors).toBeUndefined();
    const nodes = (res.data!.nodeBatch as any).nodes as Array<{ id: string; revision: number; content: string }>;
    const after = await db.node.findMany({ where: { memoryId }, select: { id: true, revSeq: true, content: true } });
    const live = new Map(after.map((n) => [n.id, n]));
    for (const n of nodes) expect([n.revision, n.content]).toEqual([live.get(n.id)!.revSeq, live.get(n.id)!.content]);
    expect(nodes.find((n) => n.id === drifted.id)).toMatchObject({ content: 'raw edit', revision: drifted.revSeq + 1 });
  });

  it('a denied node and a missing ref stay unavailable, with nothing of theirs returned', SLOW, async () => {
    const mine = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'batch:n000' } });
    const missing = generateId();
    const res = await graphql({ schema, fieldResolver, contextValue: ctxFor(db),
      source: `query($r: [ID!]!) { nodeBatch(refs: $r) { nodes { id revision content } unavailable } }`,
      variableValues: { r: [mine.id, foreignNodeId, missing] } });
    expect(res.errors).toBeUndefined();
    const out = res.data!.nodeBatch as any;
    expect(out.nodes.map((n: any) => n.id)).toEqual([mine.id]);
    expect(out.unavailable).toEqual([foreignNodeId, missing]);
    expect(JSON.stringify(out)).not.toContain('theirs');
  });
});

describe('#2721 a rejected reconcile releases its slot', () => {
  /** Distinct parents, more than NODE_RECONCILE_CONCURRENCY, so some queue behind the cap. */
  const K = 10;
  /** Diagnostic bound on each wait: a stranded queue fails here with a message, not at the test timeout. */
  const HANG_MS = 10_000;
  const sentinel = new Error('#2721 sentinel: reconcile rejected');
  const turn = () => new Promise((r) => setImmediate(r));

  /** A request whose field reconciles (maxWait 2000, requested from inside a limiter slot) are held at a gate until released. */
  function gatedRequest() {
    const track = { inFlight: 0, max: 0 };
    const held: Array<{ go: () => void; fail: () => void }> = [];
    const settled: Array<Promise<unknown>> = [];
    let releasing = false;
    let onStart = () => {};
    let ctx: Context;
    const gated = new Proxy(db, {
      get(target, prop) {
        if (prop !== '$transaction') return Reflect.get(target, prop, target);
        return (fn: unknown, opts?: { maxWait?: number }) => {
          if (typeof fn !== 'function' || opts?.maxWait !== 2_000 || !ctx.nodeReconcileSlots?.active) {
            return (target.$transaction as any)(fn, opts);
          }
          const p = new Promise((resolve, reject) => {
            // Each gate opens once, either way, so releasing twice (the scenario, then its cleanup) is a no-op.
            let open = false;
            const once = (f: () => void) => () => { if (!open) { open = true; f(); } };
            const go = once(() => { (target.$transaction as any)(fn, opts).then(resolve, reject); });
            held.push({ go, fail: once(() => reject(sentinel)) });
            if (releasing) go();
          });
          settled.push(p);
          onStart();
          return p;
        };
      },
    }) as typeof db;
    ctx = ctxFor(gated, track);
    const starts = (n: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stranded: ${held.length} of ${n} reconciles started, slots ${JSON.stringify(ctx.nodeReconcileSlots && { active: ctx.nodeReconcileSlots.active, waiting: ctx.nodeReconcileSlots.waiting.length })}`)), HANG_MS);
      onStart = () => { if (held.length >= n) { clearTimeout(timer); resolve(); } };
      onStart();
    });
    /** Open every gate, now and for later starts. */
    const releaseAll = () => {
      releasing = true;
      for (const h of held) h.go();
    };
    return { ctx, track, held, settled, starts, releaseAll };
  }

  /**
   * Hold four, reject the earliest, release the rest. `interruptAt` throws at that stage, as a failing assertion
   * would, so the cleanup path is exercised too.
   */
  async function rejectionScenario(r: ReturnType<typeof gatedRequest>, interruptAt?: 'cap' | 'rejected') {
    const response = batch(r.ctx, 'id revision', `memory: "$m", locPrefix: "batch:n00"`);
    // The cap: four held, and the rest wait app-side rather than reaching the pool.
    await r.starts(4);
    await turn();
    expect(r.held).toHaveLength(4);
    expect(r.ctx.nodeReconcileSlots!.waiting).toHaveLength(K - 4);
    if (interruptAt === 'cap') throw new Error('#2889 injected failure at the cap');

    // Reject the earliest. Its slot must pass to the next queued reconcile before any other one settles.
    r.held[0].fail();
    await r.starts(5);
    expect(r.held).toHaveLength(5);
    if (interruptAt === 'rejected') throw new Error('#2889 injected failure after the rejection');

    // Release everything else, in order; later starts run as they arrive.
    r.releaseAll();
    await r.starts(K);
    const res = await response;
    const outcomes = await Promise.allSettled(r.settled);
    // The response does not wait for siblings of a failed non-null field; after the last transaction only microtasks
    // remain (the fast path does no further I/O), so one turn lets every slot's finally run.
    await turn();
    return { res, outcomes };
  }

  it('an early rejection frees its slot at once; every other queued reconcile settles, at most 4 in flight, slots drained', SLOW, async () => {
    const r = gatedRequest();
    const { res, outcomes } = await rejectionScenario(r);

    expect(res.errors?.map((e) => [e.originalError, e.path?.slice(0, 2), e.path?.at(-1)])).toEqual([[sentinel, ['nodeBatch', 'nodes'], 'revision']]);
    expect(outcomes).toHaveLength(K);
    expect(outcomes[0]).toEqual({ status: 'rejected', reason: sentinel });
    expect(outcomes.slice(1).map((o) => o.status)).toEqual(Array(K - 1).fill('fulfilled'));
    expect(r.track.max).toBeLessThanOrEqual(4); // NODE_RECONCILE_CONCURRENCY
    expect(r.track.inFlight).toBe(0);
    expect(r.ctx.nodeReconcileSlots).toEqual({ active: 0, waiting: [] });
  });

  // #2889: a failure inside the hold window must not strand the held and queued reconciles.
  it.each(['cap', 'rejected'] as const)('a failure at the %s stage still releases every held reconcile; all launched work settles, slots drained', SLOW, async (stage) => {
    const r = gatedRequest();
    await expect(rejectionScenario(r, stage)).rejects.toThrow(/#2889 injected failure/);

    expect(r.held).toHaveLength(K);
    const outcomes = await Promise.allSettled(r.settled);
    expect(outcomes.map((o) => o.status)).toEqual(stage === 'cap'
      ? Array(K).fill('fulfilled')
      : ['rejected', ...Array(K - 1).fill('fulfilled')]);
    expect(r.track.max).toBeLessThanOrEqual(4); // NODE_RECONCILE_CONCURRENCY
    expect(r.track.inFlight).toBe(0);
    expect(r.ctx.nodeReconcileSlots).toEqual({ active: 0, waiting: [] });
  });
});
