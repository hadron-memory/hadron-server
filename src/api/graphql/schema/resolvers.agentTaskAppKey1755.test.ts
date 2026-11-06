import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1755 — the App's own key may read its tasks and events (cor:agt:050:21).
 * READ-ONLY: it never creates, assigns or cancels, and never acts as a worker.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let member: { id: string };
let appX: { id: string; urn: string };
let appY: { id: string; urn: string };
let keyX: { id: string };
let agentId: string;
let anne: { id: string };

const userCtx = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const keyCtx = (extra: Partial<Context> = {}): Context => ({ db, appId: appX.id, appKeyId: keyX.id, roles: [], ...extra });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'ak-org', urn: `ak-org-${suffix}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 98_100, githubUsername: `ak-${suffix}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  await db.appMember.create({ data: { appId: appX.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appY.id, userId: member.id, role: 'member' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, userCtx());
  agentId = agent.id;
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appX.id, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
});

const mk = (appRef: string, title: string) =>
  M.createAgentTask({}, { input: { appRef, title } }, userCtx());

describe('an App key reads its OWN App\'s tasks and events (#1755)', () => {
  it('lists, gets and trees the tasks of its App, and reads its event stream', async () => {
    const t = await mk(appX.id, 'on X');
    await mk(appY.id, 'on Y');
    const list = await Q.agentTasks({}, { appRef: appX.id }, keyCtx());
    expect(list.map((r: { id: string }) => r.id)).toEqual([t.id]);
    expect((await Q.agentTask({}, { id: t.id }, keyCtx()))?.id).toBe(t.id);
    expect((await Q.agentTaskTree({}, { root: t.id }, keyCtx()))?.map((r: { id: string }) => r.id)).toEqual([t.id]);
    const events = await Q.agentTeamEvents({}, { appRef: appX.urn }, keyCtx());
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: { appId: string }) => e.appId === appX.id)).toBe(true);
  });

  it('another App answers like a missing one, for lists, gets, trees and events', async () => {
    const y = await mk(appY.id, 'on Y');
    await expectCode(Q.agentTasks({}, { appRef: appY.id }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(Q.agentTeamEvents({}, { appRef: appY.id }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(Q.agentTasks({}, { appRef: generateId() }, keyCtx()), 'APP_NOT_FOUND');
    expect(await Q.agentTask({}, { id: y.id }, keyCtx())).toBeNull();
    expect(await Q.agentTaskTree({}, { root: y.id }, keyCtx())).toBeNull();
  });

  it('a revoked key reads nothing, at once', async () => {
    const t = await mk(appX.id, 'on X');
    await db.appKey.update({ where: { id: keyX.id }, data: { revokedAt: new Date() } });
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx()), 'APP_NOT_FOUND');
    expect(await Q.agentTask({}, { id: t.id }, keyCtx())).toBeNull();
  });

  it('a deleted App reads as missing', async () => {
    const t = await mk(appX.id, 'on X');
    await db.app.update({ where: { id: appX.id }, data: { deletedAt: new Date() } });
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx()), 'APP_NOT_FOUND');
    expect(await Q.agentTask({}, { id: t.id }, keyCtx())).toBeNull();
  });

  it('a key carrying a session is refused, never narrowed or run as the worker', async () => {
    await mk(appX.id, 'on X');
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx({ sessionId: generateId() })), 'APP_KEY_SESSION_BOUND');
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx({ sessionBindingRefused: true })), 'APP_KEY_SESSION_BOUND');
    await expectCode(
      runAsActor({ workerId: anne.id, agentId }, () => Q.agentTasks({}, { appRef: appX.id }, keyCtx())),
      'APP_KEY_SESSION_BOUND',
    );
    // A foreign App is still "not found" first, not a session refusal.
    await expectCode(Q.agentTasks({}, { appRef: appY.id }, keyCtx({ sessionId: generateId() })), 'APP_NOT_FOUND');
  });

  it('is read-only: every write is refused and nothing is written', async () => {
    const t = await mk(appX.id, 'on X');
    const before = await db.agentTeamEvent.count();
    await expectCode(M.createAgentTask({}, { input: { appRef: appX.id, title: 'nope' } }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(M.cancelAgentTask({}, { taskId: t.id }, keyCtx()), 'TASK_NOT_FOUND');
    await expectCode(M.assignAgentTask({}, { taskId: t.id, assignee: { worker: anne.id } }, keyCtx()), 'TASK_NOT_FOUND');
    await expectCode(
      runAsActor({ workerId: anne.id, agentId }, () => M.createAgentTask({}, { input: { appRef: appX.id, title: 'nope' } }, keyCtx())),
      'APP_NOT_FOUND',
    );
    expect(await db.agentTask.count({ where: { handle: { not: 'AT0' } } })).toBe(1);
    expect(await db.agentTeamEvent.count()).toBe(before);
  });

  it('no appKeyId at all, a key id with no row, and another App\'s key are three distinct refusals', async () => {
    await mk(appX.id, 'on X');
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, { db, appId: appX.id, roles: [] }), 'APP_NOT_FOUND');
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx({ appKeyId: generateId() })), 'APP_NOT_FOUND');
    const keyY = await db.appKey.create({ data: { id: generateId(), appId: appY.id, keyHash: `h-${generateId()}`, keyPreview: 'wxyz' }, select: { id: true } });
    // Key Y presented with App X's id as its App: the row says Y, so X's tasks are not its to read.
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx({ appKeyId: keyY.id })), 'APP_NOT_FOUND');
    expect(await Q.agentTasks({}, { appRef: appY.id }, { db, appId: appY.id, appKeyId: keyY.id, roles: [] })).toEqual([]);
  });

  it('an App whose org is deleted reads as missing', async () => {
    await mk(appX.id, 'on X');
    await db.organization.updateMany({ data: { deletedAt: new Date() } });
    await expectCode(Q.agentTasks({}, { appRef: appX.id }, keyCtx()), 'APP_NOT_FOUND');
  });

  it('malformed and unknown task ids read as null', async () => {
    expect(await Q.agentTask({}, { id: 'nope' }, keyCtx())).toBeNull();
    expect(await Q.agentTask({}, { id: generateId() }, keyCtx())).toBeNull();
  });
});

describe('isolation: a key never reaches another App\'s rows (#1785 cycle 1)', () => {
  it('a tree never includes a descendant that belongs to another App', async () => {
    const root = await mk(appX.id, 'root');
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: root.id } });
    const foreign = await db.agentTask.create({ data: { ...row, id: generateId(), appId: appY.id, parentTaskId: root.id, title: "foreign child", handle: `${row.handle}.${row.taskNumber}` } as any });
    const tree = await Q.agentTaskTree({}, { root: root.id }, keyCtx());
    expect(tree.map((t: { id: string }) => t.id)).toEqual([root.id]);
    expect(await Q.agentTask({}, { id: foreign.id }, keyCtx())).toBeNull();
    // Listing X by that child's parent still never returns Y's row.
    const kids = await Q.agentTasks({}, { appRef: appX.id, parentTaskId: root.id }, keyCtx());
    expect(kids).toEqual([]);
  });

  it('events: another App\'s events, cursor and task filter never widen the stream', async () => {
    const x = await mk(appX.id, 'on X');
    const y = await mk(appY.id, 'on Y');
    const yEvents = await db.agentTeamEvent.findMany({ where: { appId: appY.id } });
    expect(yEvents.length).toBeGreaterThan(0);
    const seen = await Q.agentTeamEvents({}, { appRef: appX.id }, keyCtx());
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e: { appId: string }) => e.appId === appX.id)).toBe(true);
    await expectCode(Q.agentTeamEvents({}, { appRef: appX.id, after: yEvents[0]!.id }, keyCtx()), 'BAD_USER_INPUT');
    expect(await Q.agentTeamEvents({}, { appRef: appX.id, taskId: y.id }, keyCtx())).toEqual([]);
    expect((await Q.agentTeamEvents({}, { appRef: appX.id, taskId: x.id }, keyCtx())).length).toBeGreaterThan(0);
  });
});

describe('every task-domain write is refused for a key (#1785 cycle 1)', () => {
  it('no mutation of the task domain succeeds, and nothing is written', async () => {
    const t = await mk(appX.id, 'on X');
    const names = Object.keys(M).filter((n) => /agenttask|alarm|availability|ticker/i.test(n));
    expect(names.length).toBeGreaterThan(8);
    const args = {
      taskId: t.id, id: t.id, appRef: appX.id, workerRef: anne.id, worker: anne.id, assignee: { worker: anne.id },
      input: { appRef: appX.id, taskId: t.id, title: 'x', name: 'x' }, result: { outcome: 'succeeded' },
    };
    // #2553: the task number counters are part of "nothing is written"; their BigInts serialize as strings.
    const snapshot = async () => JSON.stringify([
      await db.agentTask.findMany({ orderBy: { id: 'asc' } }),
      await db.agentTaskCounter.findMany({ orderBy: { id: 'asc' } }),
      await db.agentTeamEvent.count(),
      await db.worker.findMany({ orderBy: { id: 'asc' } }),
    ], (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const before = await snapshot();
    for (const name of names) {
      await expect(M[name]({}, args, keyCtx()), name).rejects.toBeInstanceOf(Error);
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('a revocation or deletion that lands DURING a key\'s read still wins (#1785 cycle 1, P1)', () => {
  /** Hold the App\'s anchor exclusively the way a revoker does, run `change` in it, and commit only after the read has had its chance. */
  async function duringRead<T>(change: (tx: any) => Promise<void>, read: () => Promise<T>): Promise<T | Error> {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const isLocked = new Promise<void>((r) => { locked = r; });
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: appX.id }], 'exclusive');
      locked();
      await held;
      await change(tx);
    }, { timeout: 20_000 });
    await isLocked;
    const outcome = read().then((v) => v, (e) => e as Error);
    // The read must be waiting on the anchor, not already answered from the pre-change state.
    const early = await Promise.race([outcome.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 400))]);
    expect(early).toBe('waiting');
    release();
    await revoker;
    return outcome;
  }

  it('a key revoked mid-read gets nothing: list, get, tree and events', async () => {
    const t = await mk(appX.id, 'on X');
    const revoke = (tx: any) => tx.appKey.update({ where: { id: keyX.id }, data: { revokedAt: new Date() } });
    const list = await duringRead(revoke, () => Q.agentTasks({}, { appRef: appX.id }, keyCtx()));
    expect((list as GraphQLError).extensions?.code).toBe('APP_NOT_FOUND');
    for (const [name, read] of [
      ['get', () => Q.agentTask({}, { id: t.id }, keyCtx())],
      ['tree', () => Q.agentTaskTree({}, { root: t.id }, keyCtx())],
    ] as const) {
      await db.appKey.update({ where: { id: keyX.id }, data: { revokedAt: null } });
      expect(await duringRead(revoke, read), name).toBeNull();
    }
    await db.appKey.update({ where: { id: keyX.id }, data: { revokedAt: null } });
    const ev = await duringRead(revoke, () => Q.agentTeamEvents({}, { appRef: appX.id }, keyCtx()));
    expect((ev as GraphQLError).extensions?.code).toBe('APP_NOT_FOUND');
  });

  it('an App deleted mid-read gets nothing', async () => {
    await mk(appX.id, 'on X');
    const del = (tx: any) => tx.app.update({ where: { id: appX.id }, data: { deletedAt: new Date() } });
    const list = await duringRead(del, () => Q.agentTasks({}, { appRef: appX.id }, keyCtx()));
    expect((list as GraphQLError).extensions?.code).toBe('APP_NOT_FOUND');
  });

  it('a read that wins the race is served (the lock is shared, not a refusal)', async () => {
    await mk(appX.id, 'on X');
    expect(await Q.agentTasks({}, { appRef: appX.id }, keyCtx())).toHaveLength(1);
  });
});
