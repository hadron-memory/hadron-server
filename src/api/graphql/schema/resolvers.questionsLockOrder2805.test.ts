/**
 * #2805 — the question doors take the channel-host key before the drift reconcile.
 *
 * On a drifted log or question the reconcile writes a revision that names a worker,
 * which takes worker_reference_fences F(W). writeNodeCore asks for channel-host:<m>
 * only after that, so with #443's per-memory root-seq key K the schedule
 *   A (root create) holds K, waits F(W)
 *   T (a question door) holds F(W), waits channel(m)
 *   B (edge-carrying root create) holds channel(m), waits K
 * is a three-party cycle (40P01). The schedule is the one Ralion reproduced on #2597 (P3-6).
 */
import { setImmediate } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { lockMemoriesForChannelChange } from '../../../lib/channels.js';
import { lockRootSiblings } from '../../../lib/nodeSeq.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let admin: { id: string };
let memory: { id: string };
let W: string;
const as = (extra: Partial<Context> = {}): Context => ({ db, userId: admin.id, roles: [], ...extra });
const outcome = (p: Promise<unknown>) =>
  p.then(() => 'ok', (e) => `ERR:${(e as { code?: string })?.code ?? ''}:${String((e as Error)?.message).slice(0, 160)}`);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Lock Org', urn: 'lock2805.example' } });
  admin = await db.user.create({ data: { githubId: 280501, githubUsername: 'lo-admin', handle: 'lo-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'lock-shared' }, as());
  W = generateId();
  await createDbWorkerAttribution(db as never, admin.id, W);
});

const channelKey = async (mem: string) => {
  const [{ k }] = await db.$queryRaw<Array<{ k: number }>>`SELECT hashtext(${'channel-host:' + mem}) AS k`;
  return k;
};

async function advisoryWaiterOn(objid: number, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((classid::bigint << 32) | objid::bigint) = ${BigInt(objid)}::bigint`;
    if (rows.length) return true;
    await setImmediate();
  }
  return false;
}

type Door = {
  name: string;
  drift: 'log' | 'question';
  run: (logId: string, questionId: string, revSeq: number) => Promise<unknown>;
};

const doors: Door[] = [
  {
    name: 'askQuestion',
    drift: 'log',
    run: (logId) => M.askQuestion(null, {
      logRef: logId,
      input: { title: 'Q?', parts: [{ question: 'Yes?', yesno: true, recommendation: { key: 'yes', reason: 'ready' } }] },
    }, as()),
  },
  {
    name: 'setQuestionLogDeciders',
    drift: 'log',
    run: (logId, _d, revSeq) => M.setQuestionLogDeciders(null,
      { logRef: logId, defaultDeciders: [admin.id], expectedRevision: revSeq, reason: 'cycle pin' }, as()),
  },
  {
    name: 'amendQuestion',
    drift: 'question',
    run: (_l, questionId, revSeq) => M.amendQuestion(null,
      { ref: questionId, input: { title: 'Q2?' }, expectedRevision: revSeq, reason: 'cycle pin' }, as()),
  },
  {
    name: 'withdrawQuestion',
    drift: 'question',
    run: (_l, questionId, revSeq) => M.withdrawQuestion(null,
      { ref: questionId, reason: 'cycle pin', expectedRevision: revSeq }, as()),
  },
  {
    name: 'purgeUnansweredQuestion',
    drift: 'question',
    run: (_l, questionId) => M.purgeUnansweredQuestion(null, { ref: questionId, reason: 'cycle pin' }, as({ roles: ['ADMIN'] })),
  },
];

describe('#2805 question doors vs a root create through the root-seq key', () => {
  it.each(doors)('$name does not deadlock with A (K holder naming W) and B (channel holder awaiting K)', async (door) => {
    const log = await M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: [admin.id] }, as());
    // Asked by worker W, so the question's own snapshots name W.
    const asked = await runAsActor({ workerId: W, agentId: null }, () => M.askQuestion(null, {
      logRef: log.row.id,
      input: { title: 'First?', parts: [{ question: 'Ok?', yesno: true, recommendation: { key: 'yes', reason: 'ready' } }] },
    }, as()));
    const questionId = asked.row.id as string;

    // Drift (an out-of-band write, no revision) whose reconcile snapshot names W.
    if (door.drift === 'log') {
      const row = await db.node.findUniqueOrThrow({ where: { id: log.row.id } });
      const d = row.data as any;
      await db.node.update({ where: { id: log.row.id }, data: { data: { ...d, lastAction: { ...d.lastAction, by: { ...d.lastAction.by, workerId: W } } } as never } });
    } else {
      // Harmless drift (a raw tag edit), reconciled under the door's lock.
      await db.$executeRaw`UPDATE nodes SET tags = ARRAY['drift'] WHERE id = ${questionId}`;
    }
    // m is W's working memory, so any node insert in m names W.
    await db.worker.update({ where: { id: W }, data: { memoryId: memory.id } });
    const revSeq = (await db.node.findUniqueOrThrow({ where: { id: door.drift === 'log' ? log.row.id : questionId } })).revSeq;

    let bHasChannel!: () => void;
    let goK!: () => void;
    let endB!: () => void;
    const bHeld = new Promise<void>((r) => { bHasChannel = r; });
    const kGate = new Promise<void>((r) => { goK = r; });
    const endGate = new Promise<void>((r) => { endB = r; });
    // B: an edge-carrying root create's first lock, then K(m).
    const B = outcome(db.$transaction(async (tx) => {
      await lockMemoriesForChannelChange(tx, [memory.id]);
      bHasChannel();
      await kGate;
      await lockRootSiblings(tx, memory.id);
      await endGate;
    }, { timeout: 30000 }));
    await bHeld;

    const T = outcome(door.run(log.row.id, questionId, revSeq));
    const tWaitsOnChannel = await advisoryWaiterOn(await channelKey(memory.id));

    // A: a real root create that takes K and then waits on F(W) if T holds it.
    const A = outcome(resolvers.Mutation.createNode(null, { input: { memoryId: memory.id, loc: 'rootA', name: 'rootA' } }, as()));
    const settle = async (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) await setImmediate(); };
    await settle(600);
    goK();
    await settle(2500);
    endB();
    const results = { B: await B, T: await T, A: await A };

    expect({ tWaitsOnChannel, results }).toMatchObject({ tWaitsOnChannel: true });
    expect(results).toEqual({ B: 'ok', T: 'ok', A: 'ok' });
  }, 60000);
});
