/**
 * #4247 (for hadron-cli#2060, C5) — RELAUNCH_REFUSED and RELAUNCH_FAILED, each with a closed reason and the attempt.
 * Same host key, same notice poster and same once-per-episode marker as the #4041 outcomes.
 */
import { settleRepairNotices } from '../../../lib/agentTasks/hostRepairNotice.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { buildASTSchema, parse } from 'graphql';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let manager: { id: string };
let lead: { id: string }; // the worker kit reports to
let kit: { id: string };
let solo: { id: string }; // reports to nobody
let channel: { id: string };
let key: { id: string };

const ago = (min: number) => new Date(Date.now() - min * 60_000);
// The notices post off the request path (Belinda P2-2), so a helper that reads the chat settles them first.
const send = async (reports: unknown[]) => {
  const r = await M.setHostWorkerTerminals({}, { input: { appRef: app.id, reports } }, { db, appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as Context);
  await settleRepairNotices();
  return r;
};
const dark = (worker: string, extra: Record<string, unknown> = {}) => ({
  worker, status: 'dark', prompt: 'unknown', reason: 'bare_shell', lastTurnAt: null, checkedAt: ago(1), ...extra,
});
const posts = async () =>
  (await db.node.findMany({ where: { messageChannelId: channel.id, nodeType: 'chat-message' }, orderBy: { seq: 'asc' } })) as any[];
const keyOf = (id: string) => db.worker.findUniqueOrThrow({ where: { id }, select: { repairNoticeKey: true } }).then((w) => w.repairNoticeKey);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Repair', urn: `repair-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 91_000_000 + n, githubUsername: `rp-manager-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  channel = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id })).channel;
  const w = (name: string, reportsTo: string | null = null) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), reportsToWorkerId: reportsTo }, select: { id: true } });
  lead = await w('Mara');
  kit = await w('Kit', lead.id);
  solo = await w('Solo');
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: key.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.registerHost(
    {},
    { input: { appRef: app.id, label: 'Orca One', pollIntervalSeconds: 60, workers: [lead, kit, solo].map((x) => ({ worker: x.id, family: 'claude' })) } },
    { db, appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as Context,
  );
});


const REFUSED = ['IDENTITY_MISMATCH', 'DUPLICATE_AGENT', 'PAUSED', 'HALTED', 'LEAVE_ALONE', 'NO_LAUNCHER_PROFILE'] as const;
const FAILED = ['LAUNCH_EXIT_NONZERO', 'TERMINAL_CREATE_REFUSED', 'TIMEOUT'] as const;
const refused = (worker: string, extra: Record<string, unknown> = {}) =>
  dark(worker, { repair: 'RELAUNCH_REFUSED', repairReason: 'PAUSED', attempt: 1, ...extra });
const failed = (worker: string, extra: Record<string, unknown> = {}) =>
  dark(worker, { repair: 'RELAUNCH_FAILED', repairReason: 'TIMEOUT', attempt: 1, ...extra });

describe('each new outcome is accepted with each of its reasons and posts one alert to the chain', () => {
  for (const reason of REFUSED) {
    it(`RELAUNCH_REFUSED / ${reason}`, async () => {
      const r = await send([refused(kit.id, { repairReason: reason, attempt: 2 })]);
      expect(r.refused).toEqual([]);
      expect(r.stored.map((s: any) => s.id)).toEqual([kit.id]);
      const [p, ...rest] = await posts();
      expect(rest).toEqual([]);
      expect(p.content).toMatch(/^Kit is dark on Orca One and was not relaunched \(attempt 2\): .+\.$/);
      expect(p.data.mentions).toEqual(['mara']);
    });
  }
  for (const reason of FAILED) {
    it(`RELAUNCH_FAILED / ${reason}`, async () => {
      const r = await send([failed(kit.id, { repairReason: reason, attempt: 3 })]);
      expect(r.refused).toEqual([]);
      const [p, ...rest] = await posts();
      expect(rest).toEqual([]);
      expect(p.content).toMatch(/^The relaunch of Kit on Orca One failed \(attempt 3\): .+\.$/);
      expect(p.data.mentions).toEqual(['mara']);
    });
  }
  const TEXT: Record<string, string> = {
    IDENTITY_MISMATCH: 'its identity does not match its launch snapshot',
    DUPLICATE_AGENT: 'another agent is already running there',
    PAUSED: 'it is paused',
    HALTED: 'it is halted',
    LEAVE_ALONE: 'it is marked leave-alone',
    NO_LAUNCHER_PROFILE: 'it has no launcher profile',
    LAUNCH_EXIT_NONZERO: 'the launcher exited with an error',
    TERMINAL_CREATE_REFUSED: 'Orca refused to create the terminal',
    TIMEOUT: 'the relaunch timed out',
  };
  for (const reason of REFUSED) {
    it(`RELAUNCH_REFUSED / ${reason} reads exactly`, async () => {
      await send([refused(kit.id, { repairReason: reason })]);
      expect((await posts())[0].content).toBe(`Kit is dark on Orca One and was not relaunched (attempt 1): ${TEXT[reason]}.`);
    });
  }
  for (const reason of FAILED) {
    it(`RELAUNCH_FAILED / ${reason} reads exactly`, async () => {
      await send([failed(kit.id, { repairReason: reason })]);
      expect((await posts())[0].content).toBe(`The relaunch of Kit on Orca One failed (attempt 1): ${TEXT[reason]}.`);
    });
  }
  it('with no reporting line, mentions whoever manages the App', async () => {
    await send([failed(solo.id)]);
    const [p] = await posts();
    expect(p.data.mentions.length).toBeGreaterThan(0);
  });
  it('is posted by the platform system author, never the key or a worker', async () => {
    await send([refused(kit.id)]);
    const [p] = await posts();
    expect(p.createdBy).not.toBe(manager.id);
    expect(p.data.managerPost).toBeUndefined();
  });
});

describe('once per (worker, outcome, reason) per episode', () => {
  it('a repeat of the same outcome and reason posts nothing, and a replayed batch posts nothing', async () => {
    const batch = [refused(kit.id, { checkedAt: ago(5) })];
    await send(batch);
    await send(batch);
    await send([refused(kit.id, { checkedAt: ago(4), attempt: 2 })]);
    expect(await posts()).toHaveLength(1);
    expect(await keyOf(kit.id)).toBe('RELAUNCH_REFUSED:PAUSED');
  });
  it('another reason, or the other outcome, is another alert', async () => {
    await send([refused(kit.id, { checkedAt: ago(5) })]);
    await send([refused(kit.id, { repairReason: 'HALTED', checkedAt: ago(4) })]);
    await send([failed(kit.id, { checkedAt: ago(3) })]);
    expect(await posts()).toHaveLength(3);
  });
  it('re-arms after a report with no repair outcome, and after a relaunch', async () => {
    await send([failed(kit.id, { checkedAt: ago(8) })]);
    await send([dark(kit.id, { checkedAt: ago(7) })]);
    expect(await keyOf(kit.id)).toBeNull();
    await send([failed(kit.id, { checkedAt: ago(6) })]);
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 2, checkedAt: ago(5) })]);
    expect(await keyOf(kit.id)).toMatch(/^relaunched:/);
    await send([failed(kit.id, { checkedAt: ago(4) })]);
    expect(await posts()).toHaveLength(4);
  });
  it('a delayed older alert cannot claim after a newer report re-armed the marker', async () => {
    await send([dark(kit.id, { checkedAt: ago(1) })]);
    const r = await send([failed(kit.id, { checkedAt: ago(9) })]);
    expect(r.refused).toEqual([{ worker: kit.id, code: 'TERMINAL_REPORT_STALE' }]);
    expect(await posts()).toHaveLength(0);
  });
  it('is once per worker: another worker alerts on its own', async () => {
    await send([failed(kit.id), failed(solo.id)]);
    expect(await posts()).toHaveLength(2);
  });
});

describe('the reason and the attempt are judged per worker, the rest of the batch stands', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['RELAUNCH_REFUSED with a failure reason', refused('', { repairReason: 'TIMEOUT' }), 'REPAIR_REASON_INVALID'],
    ['RELAUNCH_FAILED with a refusal reason', failed('', { repairReason: 'PAUSED' }), 'REPAIR_REASON_INVALID'],
    ['RELAUNCH_REFUSED with no reason', refused('', { repairReason: undefined }), 'REPAIR_REASON_INVALID'],
    ['RELAUNCH_FAILED with a null reason', failed('', { repairReason: null }), 'REPAIR_REASON_INVALID'],
    ['a reason with RELAUNCHED', dark('', { repair: 'RELAUNCHED', attempt: 1, repairReason: 'PAUSED' }), 'REPAIR_REASON_INVALID'],
    ['a reason with NO_SNAPSHOT', dark('', { repair: 'NO_SNAPSHOT', repairReason: 'TIMEOUT' }), 'REPAIR_REASON_INVALID'],
    ['a reason with no repair', dark('', { repairReason: 'PAUSED' }), 'REPAIR_REASON_INVALID'],
    ['RELAUNCH_REFUSED with no attempt', refused('', { attempt: undefined }), 'REPAIR_ATTEMPT_INVALID'],
    ['RELAUNCH_FAILED with attempt 0', failed('', { attempt: 0 }), 'REPAIR_ATTEMPT_INVALID'],
    ['RELAUNCH_FAILED with a negative attempt', failed('', { attempt: -1 }), 'REPAIR_ATTEMPT_INVALID'],
    ['RELAUNCH_REFUSED with a fractional attempt', refused('', { attempt: 1.5 }), 'REPAIR_ATTEMPT_INVALID'],
  ];
  for (const [name, report, code] of bad) {
    it(`${name}: ${code}, nothing stored or posted for it`, async () => {
      const r = await send([{ ...report, worker: kit.id }, dark(solo.id)]);
      expect(r.refused).toEqual([{ worker: kit.id, code }]);
      expect(r.stored.map((s: any) => s.id)).toEqual([solo.id]);
      expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).terminal).toBeNull();
      expect(await posts()).toHaveLength(0);
    });
  }
  for (const status of ['busy', 'idle', 'locked'] as const) {
    for (const make of [refused, failed]) {
      it(`on a ${status} report: REPAIR_NOT_DARK`, async () => {
        const reason = status === 'locked' ? 'rate_limited' : null;
        const r = await send([{ ...make(kit.id), status, prompt: 'empty', reason }, dark(solo.id)]);
        expect(r.refused).toEqual([{ worker: kit.id, code: 'REPAIR_NOT_DARK' }]);
        expect(await posts()).toHaveLength(0);
      });
    }
  }
  it('a reason outside the closed set is refused as a whole-batch input error', async () => {
    await expect(send([refused(kit.id, { repairReason: 'BECAUSE' })])).rejects.toBeInstanceOf(GraphQLError);
    await expect(send([refused(kit.id, { repairReason: 'paused' })])).rejects.toBeInstanceOf(GraphQLError);
    expect(await posts()).toHaveLength(0);
    expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).terminal).toBeNull();
  });
  it('a reason that is not a string is a whole-batch input error', async () => {
    await expect(send([refused(kit.id, { repairReason: 7 })])).rejects.toBeInstanceOf(GraphQLError);
  });
});

describe('the existing outcomes are unchanged', () => {
  it('RELAUNCHED, NO_SNAPSHOT and CAP_REACHED still work with no reason', async () => {
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 1, checkedAt: ago(5) })]);
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(4) })]);
    await send([dark(kit.id, { repair: 'CAP_REACHED', checkedAt: ago(3) })]);
    expect((await posts()).map((p) => p.content)).toEqual([
      'Kit was relaunched on Orca One (attempt 1).',
      'Kit is dark on Orca One and was not relaunched: it has no launch snapshot.',
    ]);
    expect(await keyOf(kit.id)).toBe('alert');
  });
  it('the new outcome after NO_SNAPSHOT is its own alert', async () => {
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(5) })]);
    await send([failed(kit.id, { checkedAt: ago(4) })]);
    expect(await posts()).toHaveLength(2);
  });
});

describe('the SDL', () => {
  it('lists the two outcomes, a closed reason enum and the input field', async () => {
    const { typeDefs } = await import('./typeDefs.js');
    const sdl = String(typeDefs);
    const repair = /enum WorkerTerminalRepair \{([^}]*)\}/.exec(sdl)![1]!;
    for (const v of ['RELAUNCHED', 'NO_SNAPSHOT', 'CAP_REACHED', 'RELAUNCH_REFUSED', 'RELAUNCH_FAILED']) expect(repair).toContain(v);
    const reasons = /enum WorkerTerminalRepairReason \{([^}]*)\}/.exec(sdl)![1]!;
    for (const v of [...REFUSED, ...FAILED]) expect(reasons).toContain(v);
    expect(/input WorkerTerminalReportInput \{[^}]*repairReason: WorkerTerminalRepairReason/s.test(sdl)).toBe(true);
  });
});

const view = async (id: string) => (resolvers as any).Worker.terminal(await db.worker.findUniqueOrThrow({ where: { id } }), {}, ctx(manager.id));

describe('once per episode means once per (worker, outcome, reason), whatever came between', () => {
  it('A, B, A posts A once: the third report is the same alert as the first', async () => {
    await send([refused(kit.id, { repairReason: 'PAUSED', checkedAt: ago(5) })]);
    await send([refused(kit.id, { repairReason: 'HALTED', checkedAt: ago(4) })]);
    await send([refused(kit.id, { repairReason: 'PAUSED', checkedAt: ago(3) })]);
    expect((await posts()).map((p) => p.content.replace(/^.*: /, ''))).toEqual(['it is paused.', 'it is halted.']);
  });
  it('across the two outcomes: REFUSED/PAUSED, FAILED/TIMEOUT, REFUSED/PAUSED posts twice', async () => {
    await send([refused(kit.id, { checkedAt: ago(5) })]);
    await send([failed(kit.id, { checkedAt: ago(4) })]);
    await send([refused(kit.id, { checkedAt: ago(3) })]);
    expect(await posts()).toHaveLength(2);
  });
  it('NO_SNAPSHOT, a new outcome, NO_SNAPSHOT again: two posts (the old alert is one token of the set)', async () => {
    await send([dark(kit.id, { repair: 'NO_SNAPSHOT', checkedAt: ago(5) })]);
    await send([failed(kit.id, { checkedAt: ago(4) })]);
    await send([dark(kit.id, { repair: 'CAP_REACHED', checkedAt: ago(3) })]);
    expect(await posts()).toHaveLength(2);
  });
  it('a report with no repair outcome ends the episode: the same alert posts again', async () => {
    await send([refused(kit.id, { checkedAt: ago(6) })]);
    await send([failed(kit.id, { checkedAt: ago(5) })]);
    await send([dark(kit.id, { checkedAt: ago(4) })]);
    await send([refused(kit.id, { checkedAt: ago(3) })]);
    await send([failed(kit.id, { checkedAt: ago(2) })]);
    expect(await posts()).toHaveLength(4);
  });
  it('a relaunch ends the episode too', async () => {
    await send([refused(kit.id, { checkedAt: ago(6) })]);
    await send([failed(kit.id, { checkedAt: ago(5) })]);
    await send([dark(kit.id, { repair: 'RELAUNCHED', attempt: 2, checkedAt: ago(4) })]);
    await send([refused(kit.id, { checkedAt: ago(3) })]);
    expect(await posts()).toHaveLength(4);
  });
  it('a replayed batch of an earlier A posts nothing', async () => {
    const a = [refused(kit.id, { checkedAt: ago(5) })];
    await send(a);
    await send([refused(kit.id, { repairReason: 'HALTED', checkedAt: ago(4) })]);
    await send(a);
    expect(await posts()).toHaveLength(2);
  });
});

describe('the new outcomes are stored on the report and shown on Worker.terminal', () => {
  it('RELAUNCH_REFUSED is read back with its reason and attempt', async () => {
    await send([refused(kit.id, { repairReason: 'HALTED', attempt: 4 })]);
    const t = await view(kit.id);
    expect(t).toMatchObject({ status: 'dark', repair: 'RELAUNCH_REFUSED', repairReason: 'HALTED', repairAttempt: 4 });
    const stored = (await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).terminal as any;
    expect(Object.keys(stored).sort()).toEqual(['checkedAt', 'contextMeasuredAt', 'contextTokens', 'host', 'lastTurnAt', 'prompt', 'reason', 'repair', 'repairAttempt', 'repairReason', 'reportedAt', 'status']);
  });
  it('RELAUNCH_FAILED likewise', async () => {
    await send([failed(kit.id, { repairReason: 'LAUNCH_EXIT_NONZERO', attempt: 2 })]);
    expect(await view(kit.id)).toMatchObject({ repair: 'RELAUNCH_FAILED', repairReason: 'LAUNCH_EXIT_NONZERO', repairAttempt: 2 });
  });
  it('the next report replaces it: no outcome means null', async () => {
    await send([failed(kit.id, { checkedAt: ago(3) })]);
    await send([dark(kit.id, { checkedAt: ago(2) })]);
    expect(await view(kit.id)).toMatchObject({ repair: null, repairReason: null, repairAttempt: null });
  });
  it('the existing three are still not stored, and read null', async () => {
    for (const [i, extra] of [{ repair: 'RELAUNCHED', attempt: 1 }, { repair: 'NO_SNAPSHOT' }, { repair: 'CAP_REACHED' }].entries()) {
      await send([dark(kit.id, { ...extra, checkedAt: ago(9 - i) })]);
      const stored = (await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).terminal as any;
      expect(Object.keys(stored)).not.toContain('repair');
      expect(await view(kit.id)).toMatchObject({ repair: null, repairReason: null, repairAttempt: null });
    }
  });
  it('a reader who may not see the terminal sees none of it', async () => {
    await send([failed(kit.id)]);
    const outsider = await db.user.create({ data: { githubId: 92_000_000 + Math.floor(Math.random() * 1e6), githubUsername: `rp-out-${Date.now()}`, roles: ['READER'] }, select: { id: true } });
    expect(await (resolvers as any).Worker.terminal(await db.worker.findUniqueOrThrow({ where: { id: kit.id } }), {}, ctx(outsider.id))).toBeNull();
  });
});

describe('the database refuses a raw write the resolver would not make', () => {
  const raw = (v: unknown) => db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify(v)}::jsonb WHERE id = ${kit.id}`;
  const at = new Date().toISOString();
  const base = {
    host: { id: 'orca1', label: 'Orca' }, status: 'dark', prompt: 'unknown', reason: 'bare_shell',
    lastTurnAt: null, checkedAt: at, reportedAt: at,
  };
  const no = /chk_workers_terminal_shape/;
  it('accepts each outcome with its own reasons, and a row with none of the three keys', async () => {
    await expect(raw(base)).resolves.toBe(1);
    for (const r of REFUSED) await expect(raw({ ...base, repair: 'RELAUNCH_REFUSED', repairReason: r, repairAttempt: 1 })).resolves.toBe(1);
    for (const r of FAILED) await expect(raw({ ...base, repair: 'RELAUNCH_FAILED', repairReason: r, repairAttempt: 2147483647 })).resolves.toBe(1);
  });
  it('rejects a wrong-set reason, a missing key, a bad attempt, another outcome, a non-dark status and extra text', async () => {
    const ok = { ...base, repair: 'RELAUNCH_REFUSED', repairReason: 'PAUSED', repairAttempt: 1 };
    await expect(raw({ ...ok, repairReason: 'TIMEOUT' })).rejects.toThrow(no);
    await expect(raw({ ...ok, repair: 'RELAUNCH_FAILED' })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairReason: 'BECAUSE' })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairReason: null })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairAttempt: null })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairAttempt: 0 })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairAttempt: 1.5 })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairAttempt: 2147483648 })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairAttempt: '1' })).rejects.toThrow(no);
    await expect(raw({ ...ok, repair: 'RELAUNCHED' })).rejects.toThrow(no);
    await expect(raw({ ...ok, repair: 'NO_SNAPSHOT', repairReason: null, repairAttempt: null })).rejects.toThrow(no);
    await expect(raw({ ...ok, status: 'idle', reason: null })).rejects.toThrow(no);
    await expect(raw({ ...base, repairReason: 'PAUSED' })).rejects.toThrow(no);
    await expect(raw({ ...base, repairAttempt: 1 })).rejects.toThrow(no);
    await expect(raw({ ...ok, repairNote: 'the screen said' })).rejects.toThrow(no);
  });
});

describe('the SDL: WorkerTerminal shows the outcome', () => {
  it('carries repair, repairReason and repairAttempt, all nullable, and no text', () => {
    const t = (buildASTSchema(parse(typeDefs)).getType('WorkerTerminal') as any).getFields();
    expect(String(t.repair?.type)).toBe('WorkerTerminalRepair');
    expect(String(t.repairReason?.type)).toBe('WorkerTerminalRepairReason');
    expect(String(t.repairAttempt?.type)).toBe('Int');
  });
});
