/**
 * #1709 (Task Management T6, slice 2) — starting a worker through its host.
 *
 * Holger's rulings (via Vera): the credential is A (#10761); the six launch
 * points (#10773); a manager may start a held worker with no task (#10774);
 * anything that changed between issue and redemption refuses the bind, with no
 * force override (#10775). Rook's conditions (#10734) are pinned in the tests.
 *
 * WHO STARTS (cor:agt:070:05, :08): whoever manages the App, by hand, with or
 * without a task; and the platform, when a task is assigned (by hand or by
 * matching) to a held worker with no live session that has an existing
 * worktree on a live host. A worker nobody holds is never started. Without such
 * a worktree nothing is issued and the task waits (the not-started alarm tells
 * its owner). Nothing here creates a worktree (cor:agt:070:06).
 *
 * THE GRANT (A): the agent a host starts runs on the HOLDER's own token,
 * already configured on that host. The host passes it a single-use grant, minted
 * when the host collects the operation (no secret is ever stored in it), bound
 * to (worker, host, task, holder), short-lived, kept only as a hash. The agent
 * redeems it at startSession, which binds an ordinary worker session on the
 * holder's behalf and records the launching host, operation and task. The grant
 * is checked against the caller's token, never trusted for identity; the
 * host:operate key can neither redeem one nor drive the session.
 *
 * NO PLAN CREDENTIAL (cor:sec:050:01, Holger via Vera #10777): the launch
 * command and any AI-plan login are the host's own configuration. Nothing here
 * carries, stores or returns one: an operation names a worktree and a family.
 */

import { normalizeFamily } from '../agentTasks/family.js';
import { afterWaits, anchorNow, coveringSignals, lockStopFence } from '../stopSignals/state.js';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { HOST_LAPSE_CHECK_INS_DEFAULT, lockAppHostLapse } from '../agentTasks/hosts.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

/** A grant lives this long after it is minted (Proposed: long enough to start an agent, short enough to be useless later). */
export const LAUNCH_GRANT_TTL_MS = 10 * 60_000;
export const LAUNCH_GRANT_PREFIX = 'hlg_';

type Db = PrismaClient | Prisma.TransactionClient;

export const hashLaunchGrant = (raw: string): string => createHash('sha256').update(raw).digest('hex');

/** Why a start cannot be issued now: a typed code and the reason. */
export class LaunchRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LaunchRefusal';
  }
}

/** The live registrations of `hostId` (or every host) that list the worker, with its family and worktrees. */
export async function liveRegistrationsFor(
  db: Db,
  appId: string,
  workerId: string,
  now: Date,
  hostId?: string,
): Promise<{ hostId: string; family: string; worktrees: string[] }[]> {
  const rows = await db.$queryRaw<{ hostId: string; family: string; worktrees: string[] }[]>`
    SELECT r.host_id AS "hostId", w.family, w.worktrees
    FROM host_registrations r
    JOIN host_registration_workers w ON w.registration_id = r.id AND w.worker_id = ${workerId}
    LEFT JOIN agent_task_stall_schedule s ON s.app_id = r.app_id
    WHERE r.app_id = ${appId}
      ${hostId ? Prisma.sql`AND r.host_id = ${hostId}` : Prisma.empty}
      AND r.refreshed_at + make_interval(secs => r.poll_interval_seconds * COALESCE(s.host_lapse_check_ins, ${HOST_LAPSE_CHECK_INS_DEFAULT})) >= ${toNaiveUtc(now)}::timestamp
    ORDER BY r.host_id`;
  return rows.flatMap((r) => {
    const family = normalizeFamily(r.family);
    return family ? [{ ...r, family }] : [];
  });
}

/** Does the worker have a live session now (cor:agt:020:11, the roster's and the bind's one predicate)? */
async function hasLiveSession(db: Db, workerId: string, now: Date): Promise<boolean> {
  const { loadWorkersActivity } = await import('../../api/graphql/schema/resolvers.worker.js');
  return (await loadWorkersActivity({ db } as unknown as Context, [workerId], now)).get(workerId)?.hasLiveSession ?? false;
}

/**
 * The checks every start shares, on the transaction client with the worker row
 * locked FOR UPDATE (so two starts of one worker serialize): the worker is of
 * the App, not retired, held, has no live session and no start in flight. Throws
 * {@link LaunchRefusal}.
 */
export async function lockStartableWorker(tx: Prisma.TransactionClient, appId: string, workerId: string, now: Date): Promise<StartHold> {
  const [w] = await tx.$queryRaw<{ appId: string; retiredAt: Date | null; heldByUserId: string | null; heldAt: Date | null }[]>`
    SELECT app_id AS "appId", retired_at AS "retiredAt", held_by_user_id AS "heldByUserId", held_at AS "heldAt"
    FROM workers WHERE id = ${workerId} FOR UPDATE`;
  if (!w || w.appId !== appId) throw new LaunchRefusal('WORKER_NOT_FOUND', 'Worker not found.');
  if (w.retiredAt) throw new LaunchRefusal('WORKER_RETIRED', 'This worker is retired.');
  // cor:agt:070:08: a worker nobody holds is never started; there is nobody to bind it on behalf of.
  if (!w.heldByUserId) throw new LaunchRefusal('WORKER_NOT_HELD', 'Nobody holds this worker, so no host starts it.');
  if (await hasLiveSession(tx, workerId, now)) throw new LaunchRefusal('WORKER_LIVE', 'This worker already has a live session.');
  const pending = await tx.hostOperation.findFirst({
    where: { workerId, type: 'worker.start', status: { in: ['issued', 'collected'] } },
    select: { id: true },
  });
  if (pending) throw new LaunchRefusal('WORKER_START_PENDING', 'A start of this worker is already in flight.');
  return { userId: w.heldByUserId, at: w.heldAt };
}

/** The hold that authorizes a start: its holder and when the hold was taken (a re-hold changes it). */
export type StartHold = { userId: string; at: Date | null };

/** Is the worker's hold now exactly the one a start was issued under (#1883 review, Diego P2-1)? */
export function sameHold(issued: { holdUserId: string | null; holdAt: Date | null }, now: { userId: string | null; at: Date | null }): boolean {
  return issued.holdUserId !== null && issued.holdUserId === now.userId && (issued.holdAt?.getTime() ?? null) === (now.at?.getTime() ?? null);
}

/**
 * Fence the host decision a start makes, through its insert (#1883 review, Diego P2-2; the #1877 fallback's
 * protocol): the App's host-lapse lock SHARED with its count (a count change waits), then every registration of the
 * App FOR SHARE (a refresh that would drop the worker or its worktree waits), BEFORE the separate read of which hosts
 * are live and list the worker. Taken after the worker row: registerHost takes the workers it lists FOR SHARE before
 * its registration row, so the orders never cycle.
 */
export async function fenceHostDecision(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  await lockAppHostLapse(tx, appId, 'shared');
  await tx.$queryRaw`SELECT app_id FROM agent_task_stall_schedule WHERE app_id = ${appId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${appId} ORDER BY id FOR SHARE`;
}

/** Insert a worker.start for a validated host, worktree and family. */
export async function insertWorkerStart(
  tx: Prisma.TransactionClient,
  a: {
    appId: string; hostId: string; workerId: string; worktree: string; family: string; taskId: string | null;
    issuer: { issuedBy: 'platform' } | { issuedBy: 'user'; issuedByUserId: string; issuedByAgentId: string | null };
    hold: StartHold;
  },
): Promise<string> {
  const id = generateId();
  await tx.hostOperation.create({
    data: {
      id,
      appId: a.appId,
      hostId: a.hostId,
      type: 'worker.start',
      args: { workerId: a.workerId, worktree: a.worktree, family: a.family, ...(a.taskId ? { taskId: a.taskId } : {}) },
      workerId: a.workerId,
      ...a.issuer,
      holdUserId: a.hold.userId,
      holdAt: a.hold.at,
    },
  });
  return id;
}

/**
 * cor:agt:070:08 — the platform's start for an assignment: if the task's worker
 * assignee is held, has no live session and an existing worktree on a live host,
 * issue `worker.start` there (the first such host by id, and the first worktree
 * it lists: Proposed). Otherwise nothing is issued and the task waits. Runs
 * AFTER the assignment committed, in its own transaction; never fails the
 * assignment. Returns the operation id, or null.
 */
export async function launchForAssignment(
  db: PrismaClient,
  a: { appId: string; taskId: string; workerId: string; family?: string },
  now = new Date(),
  /** `now`'s monotonic half (`anchorNow`), when `now` came from a pass; by default taken here, beside `now`. */
  anchor: number = anchorNow(),
): Promise<string | null> {
  try {
    const owner = await db.app.findUnique({ where: { id: a.appId }, select: { organizationId: true, ownerUserId: true } });
    return await db.$transaction(async (tx) => {
      // The App's authority anchor SHARED: an uninstall or delete committed first and is seen, or waits.
      await lockAuthorityAnchors(tx, [
        { kind: 'app', id: a.appId },
        ...(owner?.organizationId ? [{ kind: 'org' as const, id: owner.organizationId }] : []),
        ...(owner?.ownerUserId ? [{ kind: 'user' as const, id: owner.ownerUserId }] : []),
      ], 'shared');
      const app = await tx.app.findUnique({ where: { id: a.appId }, select: { deletedAt: true, uninstalledAt: true } });
      if (!app || app.deletedAt || app.uninstalledAt) return null;
      // #2022 (cor:agt:090:03 edge case): a worker a live stop signal covers is never started for a task. The fence
      // orders this with a signal set after the assignment committed; a manager's own start is not this path.
      await lockStopFence(tx, a.appId, 'shared');
      if ((await coveringSignals(tx, a.appId, [a.workerId], afterWaits(now, anchor))).has(a.workerId)) return null;
      // Still this worker's open task: a reassignment or an end since the assignment launches nothing.
      const task = await tx.agentTask.findUnique({ where: { id: a.taskId }, select: { assigneeWorkerId: true, status: true } });
      if (!task || task.assigneeWorkerId !== a.workerId || !['pending', 'started'].includes(task.status)) return null;
      let hold: StartHold;
      try {
        hold = await lockStartableWorker(tx, a.appId, a.workerId, now);
      } catch (e) {
        if (e instanceof LaunchRefusal) return null;
        throw e;
      }
      await fenceHostDecision(tx, a.appId);
      const reg = (await liveRegistrationsFor(tx, a.appId, a.workerId, now)).find((r) => r.worktrees.length > 0 && (!a.family || r.family === normalizeFamily(a.family)));
      if (!reg) return null;
      return insertWorkerStart(tx, {
        appId: a.appId, hostId: reg.hostId, workerId: a.workerId, worktree: reg.worktrees[0]!, family: reg.family,
        taskId: a.taskId, issuer: { issuedBy: 'platform' }, hold,
      });
    });
  } catch (err) {
    console.error('[host-launch] launching an assigned worker failed:', a, err);
    return null;
  }
}

/**
 * At collection: a fresh grant for each `worker.start` collected, bound to the
 * holder the start was ISSUED under (#1883 review, Diego P2-1: never a
 * replacement holder adopted now). An operation whose worker's hold is no
 * longer exactly that one (released, moved, or released and re-held), or whose
 * worker is retired, fails instead, with the reason; that check runs on EVERY
 * collect, so a live grant is revoked with its start.
 *
 * #1928: a re-collect must not break a launch in flight. While the start's
 * grant is live (unconsumed, unrevoked, unexpired) the start is held back from
 * the answer (`withheld`) and nothing is minted; once it has expired, the
 * expired one is revoked and a fresh one minted. A consumed grant (the session
 * bound) mints nothing: the start is delivered without a grant, so a restarted
 * host can still report it. `grants` maps operation id → raw grant (shown
 * once), or null for a bound start.
 */
export async function mintLaunchGrants(
  tx: Prisma.TransactionClient,
  ops: { id: string; appId: string; hostId: string; workerId: string; args: Prisma.JsonValue; holdUserId: string | null; holdAt: Date | null }[],
  now: Date,
): Promise<{ grants: Map<string, string | null>; withheld: Set<string> }> {
  const out = new Map<string, string | null>();
  const withheld = new Set<string>();
  for (const op of ops) {
    if (await tx.launchGrant.findFirst({ where: { operationId: op.id, consumedAt: { not: null } }, select: { id: true } })) {
      out.set(op.id, null);
      continue;
    }
    const [w] = await tx.$queryRaw<{ heldByUserId: string | null; heldAt: Date | null; retiredAt: Date | null }[]>`
      SELECT held_by_user_id AS "heldByUserId", held_at AS "heldAt", retired_at AS "retiredAt" FROM workers WHERE id = ${op.workerId} FOR SHARE`;
    const live = await tx.launchGrant.findFirst({
      where: { operationId: op.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    if (live && w && !w.retiredAt && sameHold(op, { userId: w.heldByUserId, at: w.heldAt })) {
      withheld.add(op.id);
      continue;
    }
    await tx.launchGrant.updateMany({ where: { operationId: op.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
    if (!w || w.retiredAt) {
      await failOperation(tx, op.id, now, 'The worker was retired before its start was collected.');
      continue;
    }
    if (!sameHold(op, { userId: w.heldByUserId, at: w.heldAt })) {
      await failOperation(tx, op.id, now, 'The hold changed after this start was issued.');
      continue;
    }
    const raw = LAUNCH_GRANT_PREFIX + randomBytes(32).toString('hex');
    const args = op.args as { taskId?: string };
    await tx.launchGrant.create({
      data: {
        id: generateId(), appId: op.appId, operationId: op.id, workerId: op.workerId, hostId: op.hostId,
        taskId: args.taskId ?? null, holderUserId: op.holdUserId!, tokenHash: hashLaunchGrant(raw),
        issuedAt: now, expiresAt: new Date(now.getTime() + LAUNCH_GRANT_TTL_MS),
      },
    });
    out.set(op.id, raw);
  }
  return { grants: out, withheld };
}

/**
 * Fail a collected operation with the platform's reason, and the outcome event
 * (#1709: a refused bind fails its start, Holger via Vera #10775). A no-op
 * unless it is still collected.
 */
export async function failOperation(tx: Prisma.TransactionClient, operationId: string, now: Date, reason: string): Promise<boolean> {
  const n = await tx.hostOperation.updateMany({
    where: { id: operationId, status: 'collected' },
    data: { status: 'failed', finishedAt: now, failureReason: reason.slice(0, 2000) },
  });
  if (n.count === 0) return false;
  const op = await tx.hostOperation.findUniqueOrThrow({ where: { id: operationId }, select: { appId: true, hostId: true, type: true, workerId: true } });
  const { appendHostOperationEvent } = await import('../agentTasks/events.js');
  await appendHostOperationEvent(tx, {
    appId: op.appId, type: 'host.operation.failed', operationId, hostId: op.hostId, operationType: op.type, workerId: op.workerId, createdAt: now,
  });
  await tx.launchGrant.updateMany({ where: { operationId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
  return true;
}

export type LoadedGrant = Prisma.LaunchGrantGetPayload<Record<string, never>>;

/**
 * The live grant a raw token names, or null: unknown, consumed, revoked,
 * expired, or its operation no longer collected all read the same (no oracle).
 */
export async function loadLiveGrant(db: Db, raw: string, now: Date): Promise<LoadedGrant | null> {
  if (typeof raw !== 'string' || !raw.startsWith(LAUNCH_GRANT_PREFIX)) return null;
  const g = await db.launchGrant.findUnique({ where: { tokenHash: hashLaunchGrant(raw) } });
  if (!g || g.consumedAt || g.revokedAt || g.expiresAt.getTime() <= now.getTime()) return null;
  const op = await db.hostOperation.findUnique({ where: { id: g.operationId }, select: { status: true, type: true } });
  if (!op || op.status !== 'collected' || op.type !== 'worker.start') return null;
  return g;
}

/** Consume a grant for the session it binds: atomically, so of two concurrent redemptions exactly one wins. */
export async function consumeGrant(tx: Prisma.TransactionClient, grantId: string, sessionId: string, now: Date): Promise<boolean> {
  const n = await tx.launchGrant.updateMany({
    where: { id: grantId, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now, sessionId },
  });
  return n.count === 1;
}
