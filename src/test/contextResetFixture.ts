/**
 * #2162 (cor:agt:050:27) — the shared fixture of the context-reset tests: an App with a manager, a holder, two workers
 * of one Agent (Ada, and Kit who reports to her), Kit's working memory, an `host:operate` key for host `orca1`, and
 * that host registered with Kit and the `worker.reset-context` capability. Kit has one open session. The Agent has
 * `resetContextAfterTask` on unless a test turns it off.
 *
 * Callers mock `writeNodeToGit` and the bus themselves (vi.mock is hoisted per test file).
 */

import { expect } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';
import { runAsActor } from '../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';

export const M = resolvers.Mutation as any;
export const MIN = 60_000;

export const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

/** The GraphQL error code a call rejects with, or undefined when it resolves. */
export async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

export type ResetFixture = {
  orgId: string;
  app: { id: string };
  agentId: string;
  manager: { id: string };
  holder: { id: string };
  ada: { id: string };
  kit: { id: string };
  kitMemory: { id: string };
  orca1: { id: string };
  session: { id: string };
  keyCtx: (k?: { id: string }) => Context;
  asWorker: <T>(w: { id: string }, fn: () => Promise<T>) => Promise<T>;
  bind: (w: { id: string }, startedAt?: Date) => Promise<{ id: string }>;
  /** A key for another host of the same App, with `host:operate` for `hostId`. */
  hostKey: (hostId: string) => Promise<{ id: string }>;
  register: (k: { id: string }, opts?: { capabilities?: string[] | null; workers?: string[]; pollIntervalSeconds?: number }) => Promise<unknown>;
  /** A task assigned to Kit and started by Kit (the `task.started` event names Kit). */
  startedTask: (opts?: { close?: boolean; assignee?: { id: string } }) => Promise<{ id: string }>;
  finish: (taskId: string, w?: { id: string }) => Promise<unknown>;
  cancel: (taskId: string) => Promise<unknown>;
  /** Finish a started task and return the reset it requested, with the operation collected by orca1. */
  collectedReset: () => Promise<{ taskId: string; resetId: string; operationId: string }>;
  checkpoint: (memoryId?: string) => Promise<{ id: string }>;
  step: (name: string, input: Record<string, unknown>, k?: { id: string }) => Promise<any>;
};

export const PROC = { pid: 4242, startTime: '1729550000.12' };
export const NEW_PROC = { pid: 4343, startTime: '1729550099.50' };

export async function setUpResetFixture(): Promise<ResetFixture> {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Reset', urn: `ctxreset-${n}.example` } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `cr-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  const manager = await u(81, 'manager');
  const holder = await u(82, 'holder');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent', resetContextAfterTask: true }, ctx(manager.id));
  const agentId = agent.id as string;
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  const kitMemory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, appId: app.id, urn: `${org.urn}:kit-memory`, name: 'Kit memory', class: 'app' },
    select: { id: true },
  });
  const ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: holder.id }, select: { id: true } });
  const kit = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id, reportsToWorkerId: ada.id, memoryId: kitMemory.id },
    select: { id: true },
  });
  const keyCtx = (k: { id: string } = orca1): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;
  const hostKey = async (hostId: string) => {
    const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) }, select: { id: true } });
    await M.grantAppKeyScope({}, { id: key.id, scope: 'host:operate', hostId }, ctx(manager.id));
    return key;
  };
  const orca1 = await hostKey('orca1');
  const register: ResetFixture['register'] = (k, opts = {}) =>
    M.registerHost({}, {
      input: {
        appRef: app.id, label: 'Orca', pollIntervalSeconds: opts.pollIntervalSeconds ?? 600,
        workers: (opts.workers ?? [kit.id]).map((w) => ({ worker: w, family: 'claude', worktrees: [] })),
        capabilities: opts.capabilities === undefined ? ['worker.reset-context'] : opts.capabilities,
      },
    }, keyCtx(k));
  await register(orca1);
  const bind = (w: { id: string }, startedAt = new Date(Date.now() - MIN)) =>
    db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId, userId: holder.id, startedAt, updatedAt: startedAt }, select: { id: true } });
  const session = await bind(kit);
  const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);

  const startedTask: ResetFixture['startedTask'] = async (opts = {}) => {
    const who = opts.assignee ?? kit;
    const t = await db.agentTask.create({
      data: {
        appId: app.id, title: 'Build #2162', ownerUserId: manager.id, assigneeWorkerId: who.id, status: 'pending',
        assignedAt: new Date(), closeSessionWhenDone: opts.close ?? false,
      },
      select: { id: true },
    });
    await asWorker(who, () => M.startAgentTask({}, { taskId: t.id }, ctx(holder.id)));
    return t;
  };
  const finish = (taskId: string, w: { id: string } = kit) =>
    asWorker(w, () => M.finishAgentTask({}, { taskId, result: { outcome: 'succeeded' } }, ctx(holder.id)));
  const cancel = (taskId: string) => M.cancelAgentTask({}, { taskId }, ctx(manager.id));
  const collectedReset = async () => {
    const t = await startedTask();
    await finish(t.id);
    const r = await db.contextReset.findUniqueOrThrow({ where: { taskId: t.id } });
    await M.collectHostOperations({}, { appRef: app.id }, keyCtx());
    return { taskId: t.id, resetId: r.id, operationId: r.hostOperationId! };
  };
  const checkpoint = (memoryId = kitMemory.id) =>
    db.node.create({ data: { id: generateId(), memoryId, loc: `sheds:${generateId()}`, name: 'Checkpoint', content: 'handoff' }, select: { id: true } });
  const step: ResetFixture['step'] = (name, input, k = orca1) => M[name]({}, { input: { appRef: app.id, ...input } }, keyCtx(k));

  return {
    orgId: org.id, app, agentId, manager, holder, ada, kit, kitMemory, orca1, session,
    keyCtx, asWorker, bind, hostKey, register, startedTask, finish, cancel, collectedReset, checkpoint, step,
  };
}
