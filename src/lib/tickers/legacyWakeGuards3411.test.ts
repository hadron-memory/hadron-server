/**
 * #3411: outcome pins for the three guards of `authorizeLegacyWakeWorkers` (src/lib/tickers/wakeKeyScope.ts) that #3402's
 * private-database mutant run found unpinned (Riana, #3402 comment 6623472050):
 *
 *   w08  the worker rows are locked in id order (`ORDER BY id`),
 *   w09  the host registration row is held FOR SHARE through the answer,
 *   w10  the helper takes the App's `wakebudget` lock before the worker rows.
 *
 * Every pin runs REAL code on two or three connections with explicit barriers, and asserts only OUTCOMES: nobody deadlocks
 * or aborts, an answer is consistent with ONE registration state (before OR after a change, never a mix, cor:agt:080:22), each
 * admitted App-key read leaves exactly one record, and the App never spends past its daily budget (cor:agt:080:15). Which
 * side of a race wins is never asserted, and lock order is evidence of the guard here, not law (Victor's FIT, #3411
 * comment 6624598618). Blocking is proven from pg_stat_activity / pg_blocking_pids, never by sleeping.
 *
 * Pure-`.sort()` removal on `ids` is deliberately not a separate target: the statement's own `ORDER BY id` decides the lock
 * order, the JavaScript sort only fixes the IN-list text, so it cannot change an outcome (equivalent mutant, w08 below).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { appendChatMessage } from '../chatRoot.js';
import { getMemoryEncryptionInfo } from '../nodeCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../../api/graphql/schema/resolvers.teamChat.js';
import { registerHost, sweepLostHosts } from '../agentTasks/hosts.js';
import type { Prisma } from '../../generated/prisma/index.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const HOST = 'hx';

type World = {
  orgId: string; appId: string; userId: string; agentId: string; keyId: string; hostKeyId: string;
  channel: { id: string; memoryId: string; loc: string; chatRootNodeId: string };
  /** Worker ids, in the order their rows were INSERTED (the heap order a plan without ORDER BY would lock in). */
  inserted: string[];
};
let w: World;
let post: ReturnType<typeof vi.spyOn>;

const latch = () => {
  let release!: () => void;
  return { promise: new Promise<void>((r) => { release = r; }), release: () => release() };
};
const settle = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));
const keyCtx = (keyId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], appId: w.appId, appKeyId: keyId, organizationId: w.orgId, ...extra }) as Context;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => (e as { extensions?: { code?: string } } | null)?.extensions?.code;

/** Workers are INSERTED in `insertOrder` (explicit ids), so the heap order is the one the test chose. */
async function build(opts: { workerIds: string[]; watch: boolean; hostKey: boolean }): Promise<void> {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { name: 'guards3411', urn: `g3411-${suffix}.example` } });
  const user = await db.user.create({ data: { githubId: 3411001, githubUsername: `g3411-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Role', urn: `${org.urn}:role`, visibility: 'ORGANIZATION' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, wakeDailyBudget: 5 } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const memory = await db.memory.create({ data: { organizationId: org.id, urn: `${org.urn}:shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'chats:team', createdBy: user.id });
  const channel = { id: made.channel.id, memoryId: memory.id, loc: 'chats:team', chatRootNodeId: made.rootId };
  for (const [n, id] of opts.workerIds.entries()) {
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId: app.id, agentId: agent.id, name: `W${n}`, slug: `w${n}`, heldByUserId: user.id, heldAt: new Date() } });
    if (opts.watch) await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: channel.id, attendeeWorkerId: id, role: 'BOTH' } });
  }
  const mkKey = async (host: boolean) => {
    const id = generateId();
    const key = await db.appKey.create({ data: { appId: app.id, label: host ? 'host reader' : 'wake reader', keyHash: id, keyPreview: id.slice(-4) } });
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: user.id } });
    if (host) await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'host:operate', hostId: HOST, grantedByUserId: user.id } });
    return key.id;
  };
  w = { orgId: org.id, appId: app.id, userId: user.id, agentId: agent.id, channel, inserted: opts.workerIds,
    keyId: await mkKey(false), hostKeyId: opts.hostKey ? await mkKey(true) : '' };
}

const register = (hostId: string, workerIds: string[]) => registerHost(db, {
  appId: w.appId, hostId, label: hostId, pollIntervalSeconds: 600, workers: workerIds.map((workerId) => ({ workerId, family: 'claude' })),
});
async function mention(...slugs: string[]) {
  const enc = await getMemoryEncryptionInfo(db, w.channel.memoryId);
  return appendChatMessage(db, { id: w.channel.chatRootNodeId, memoryId: w.channel.memoryId, loc: w.channel.loc }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: w.channel.memoryId, loc: `${w.channel.loc}:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq,
      messageChannelId: w.channel.id, content: 'hi', data: { mentions: slugs } } }), { asChannel: true });
}
const due = (c: Context) => Q.dueWakes({}, { appRef: w.appId }, c);
const readRecords = (keyId: string) => db.appKeyWakeRead.count({ where: { appKeyId: keyId } });

type Hooks = {
  /** After this raw statement returns inside a transaction of the traced db (one-shot): its SQL text and its backend pid. */
  afterRaw?: { when: (sql: string) => boolean; run: (pid: number) => Promise<void> };
  /** Before the deciding transaction writes the read record, i.e. after its authorization has passed (one-shot). */
  beforeRecord?: (pid: number) => Promise<void>;
};
/** The request's db: real transactions, with the named one-shot barriers. Nothing else is altered. */
function traced(hooks: Hooks): Context['db'] {
  let rawDone = false, recordDone = false;
  const wrap = (tx: Prisma.TransactionClient) => new Proxy(tx, {
    get(t, p) {
      if (p === '$queryRaw') return async (...args: any[]) => {
        const out = await (t.$queryRaw as any)(...args);
        const sql = Array.isArray(args[0]) ? args[0].join('?') : '';
        if (hooks.afterRaw && !rawDone && hooks.afterRaw.when(sql)) {
          rawDone = true;
          await hooks.afterRaw.run((await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
        }
        return out;
      };
      if (p === 'appKeyWakeRead' && hooks.beforeRecord) {
        const model = Reflect.get(t, p) as any;
        return new Proxy(model, {
          get(m, q) {
            if (q !== 'create') return Reflect.get(m, q);
            return async (...args: any[]) => {
              if (!recordDone) {
                recordDone = true;
                await hooks.beforeRecord!((await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
              }
              return m.create(...args);
            };
          },
        });
      }
      const value = Reflect.get(t, p);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== '$transaction') {
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
        target.$transaction(async (tx) => fn(wrap(tx)), options as any);
    },
  }) as unknown as Context['db'];
}

/** A backend of this database that `pid` currently blocks (the proof that a participant is really waiting). */
async function blockedBy(pid: number): Promise<number | null> {
  const rows = await db.$queryRaw<{ pid: number }[]>`
    SELECT a.pid FROM pg_stat_activity a WHERE a.datname = current_database() AND ${pid} = ANY(pg_blocking_pids(a.pid))`;
  return rows[0]?.pid ?? null;
}
async function until<T>(what: string, probe: () => Promise<T | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function barrier<T>(what: string, reached: Promise<T>, ...others: Promise<unknown>[]): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reached,
      ...others.map((o) => o.then(() => { throw new Error(`${what}: the participant finished before the barrier`); })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: barrier not reached`)), 10_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

beforeEach(() => { post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never); });
afterEach(() => post.mockRestore());

describe('w08: overlapping worker sets lock in id order', () => {
  // Rows are INSERTED high id first: a plan without `ORDER BY id` (a bitmap heap scan, EXPLAIN-checked) locks in that heap order, the
  // opposite of registerHost's `ORDER BY id FOR SHARE`. A third connection (E) holds the LOW row so the reader is parked mid-lock.
  it('a host-key read and a registerHost over the same two workers, in opposite natural orders, both commit', async () => {
    const [lo, hi] = [generateId(), generateId()].sort();
    await build({ workerIds: [hi, lo], watch: false, hostKey: true });
    await register(HOST, [lo, hi]);
    const held = latch(), gate = latch();
    let ePid = 0;
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${lo} FOR SHARE`;
      ePid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
      held.release();
      await gate.promise;
    }).then(() => null, (e: unknown) => e);
    await barrier('E holds the low worker row', held.promise);
    let rPid = 0;
    const reading = settle(due(keyCtx(w.hostKeyId)));
    try {
      rPid = await until('the read to be parked on the low worker row', () => blockedBy(ePid));
      const registering = settle(register('hy', [lo, hi]));
      let finished = false;
      void registering.then(() => { finished = true; });
      // Either side of the register is fine: it completes alone, or it waits on the read. Both are proven, never slept on.
      await until('registerHost to finish or to wait on the read', async () => finished || (await blockedBy(rPid)) !== null);
      gate.release();
      const [r, h, e] = await Promise.all([reading, registering, blocker]);
      expect(e, 'blocker transaction').toBeNull();
      expect(errText(h.error), 'registerHost must commit, not deadlock').toBe('null');
      expect(errText(r.error), 'the read must be answered, not deadlock').toBe('null');
      expect(await readRecords(w.hostKeyId)).toBe(1);
      expect(await db.hostRegistrationWorker.count({ where: { registration: { hostId: 'hy' } } })).toBe(2);
    } finally { gate.release(); await Promise.all([reading, blocker]); }
  }, 30_000);
});

describe('w09: the host registration is held through the deciding answer', () => {
  // `loss` has no worker lock at all and `removal` is an empty worker list, so neither is fenced by the worker rows: the registration
  // FOR SHARE is the only thing between the read's decision and its commit. The rule asserted is only that the answer matches ONE state.
  it.each(['loss', 'removal'] as const)('a read decided before a host %s is answered from one registration state', async (change) => {
    const target = generateId();
    await build({ workerIds: [target], watch: true, hostKey: true });
    await register(HOST, [target]);
    if (change === 'loss') await db.hostRegistration.updateMany({ where: { appId: w.appId, hostId: HOST }, data: { refreshedAt: new Date(Date.now() - 30 * 86_400_000) } });
    await mention('w0');
    const decided = latch(), resume = latch();
    let rPid = 0;
    const reader = settle(due(keyCtx(w.hostKeyId, { db: traced({ beforeRecord: async (pid) => { rPid = pid; decided.release(); await resume.promise; } }) })));
    let changeDone = false;
    let changing: Promise<{ value: unknown; error: unknown }> | undefined;
    try {
      await barrier('the read passed its deciding authorization', decided.promise, reader);
      changing = settle<unknown>(change === 'loss' ? sweepLostHosts(db, new Date()) : register(HOST, []));
      void changing.then(() => { changeDone = true; });
      // The change either lands now (and the read must then refuse) or waits on the read. Neither side is required to win.
      await until('the change to finish or to wait on the read', async () => changeDone || (await blockedBy(rPid)) !== null);
    } finally {
      const committedBeforeRead = changeDone;
      resume.release();
      const [r, c] = await Promise.all([reader, changing ?? Promise.resolve({ value: null, error: null })]);
      expect(errText(c.error), `${change} must commit`).toBe('null');
      const answered = r.error === null;
      const listsTarget = answered && (r.value as any).wakes.some((x: any) => x.worker.id === target);
      if (committedBeforeRead) {
        expect(listsTarget, `an answer committed after the ${change} must not list the host's worker (a mix of two states)`).toBe(false);
        expect(await readRecords(w.hostKeyId)).toBe(answered ? 1 : 0);
      } else {
        expect(r.error, 'a read decided before the change is answered from the earlier state').toBeNull();
        expect(listsTarget).toBe(true);
        expect(await readRecords(w.hostKeyId)).toBe(1);
      }
    }
    // The change is real, and a read after it sees only the later state.
    const after = await settle(due(keyCtx(w.hostKeyId)));
    if (change === 'loss') expect(codeOf(after.error)).toBe('APP_KEY_SCOPE_REQUIRED');
    else expect((after.value as any).wakes).toEqual([]);
  }, 30_000);

  it.each(['loss', 'removal'] as const)('control: a read that starts after the %s, and one with no change, answer from a single state', async (change) => {
    const target = generateId();
    await build({ workerIds: [target], watch: true, hostKey: true });
    await register(HOST, [target]);
    await mention('w0');
    const plain = await due(keyCtx(w.hostKeyId));
    expect(plain.wakes.map((x: any) => x.worker.id)).toEqual([target]);
    expect(await readRecords(w.hostKeyId)).toBe(1);
    if (change === 'loss') {
      await db.hostRegistration.updateMany({ where: { appId: w.appId, hostId: HOST }, data: { refreshedAt: new Date(Date.now() - 30 * 86_400_000) } });
      expect(await sweepLostHosts(db, new Date())).toBe(1);
    } else await register(HOST, []);
    const after = await settle(due(keyCtx(w.hostKeyId)));
    if (change === 'loss') { expect(codeOf(after.error)).toBe('APP_KEY_SCOPE_REQUIRED'); expect(await readRecords(w.hostKeyId)).toBe(1); }
    else { expect((after.value as any).wakes).toEqual([]); expect(await readRecords(w.hostKeyId)).toBe(2); }
  }, 30_000);
});

describe('w10: issuance takes the budget lock before the worker rows', () => {
  // An acknowledgement takes budget, THEN the workers. An issue whose helper took the workers first and the budget after (dueWakes
  // takes it again at :730) would cycle with it. R is parked after its worker rows are locked; A (the acknowledgement) then starts.
  it('an issue of a new wake and an acknowledgement of an outstanding one over the same workers both commit, within budget', async () => {
    const [a, b] = [generateId(), generateId()].sort();
    await build({ workerIds: [a, b], watch: true, hostKey: false });
    await mention('w0');
    const first = await due(keyCtx(w.keyId));
    const proof = first.wakes.find((x: any) => x.worker.id === a).proof as string;
    await mention('w1');
    const locked = latch(), resume = latch();
    let rPid = 0;
    const hooks: Hooks = { afterRaw: {
      when: (sql) => sql.includes('FROM workers') && sql.includes('FOR NO KEY UPDATE'),
      run: async (pid) => { rPid = pid; locked.release(); await resume.promise; },
    } };
    const reading = settle(due(keyCtx(w.keyId, { db: traced(hooks) })));
    try {
      await barrier('the issue locked its workers', locked.promise, reading);
      const acking = settle(M.acknowledgeWakes({}, { proofs: [proof] }, keyCtx(w.keyId)));
      await until('the acknowledgement to wait on the issue', async () => (await blockedBy(rPid)) !== null);
      resume.release();
      const [r, k] = await Promise.all([reading, acking]);
      expect(errText(r.error), 'the issue must commit, not deadlock').toBe('null');
      expect(errText(k.error), 'the acknowledgement must commit, not deadlock').toBe('null');
      const ids = (r.value as any).wakes.map((x: any) => x.worker.id);
      expect(ids).toContain(b);
      expect((k.value as any).acknowledged + (k.value as any).unchanged).toBe(1);
      // cor:agt:080:15: nothing past the daily budget, and every admitted read is recorded once.
      const day = await db.appWakeDay.findMany({ where: { appId: w.appId } });
      const reserved = await db.appWakeReservation.count({ where: { appId: w.appId } });
      expect(day.reduce((n, d) => n + d.wakes, 0) + reserved).toBeLessThanOrEqual(5);
      expect(await readRecords(w.keyId)).toBe(2);
    } finally { resume.release(); await reading; }
  }, 30_000);
});
