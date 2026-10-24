/**
 * #1707 — host registrations (cor:agt:070:01): which workers a host can launch
 * in its team App, each with the model family it would run as.
 *
 * THE HOST'S IDENTITY COMES FROM ITS KEY, NEVER FROM THE REQUEST. The public
 * `registerHost` mutation (#1709, src/api/graphql/schema/resolvers.hostOperation.ts)
 * takes the host id from the calling key's `host:operate` scope row, which
 * names one App and one host (cor:agt:070:04), and re-checks that scope inside
 * this writer's transaction through `authorize`. Server code and tests call
 * this writer directly and are trusted to supply the host id.
 *
 * A registration is LIVE while it has been refreshed within its App's lapse
 * count of its own poll intervals (cor:agt:070:01, #1763: 2 to 10, default
 * HOST_LAPSE_CHECK_INS_DEFAULT; the App's stall schedule holds it). Liveness is
 * derived at read time, like a session's; `sweepLostHosts` only writes down
 * that one lapsed (`host.lost`, once, stamping `lostAt`).
 */

import { afterWaits, anchorNow, lockStopFence } from '../stopSignals/state.js';
import { reconcileStopCoverage } from '../stopSignals/lifecycle.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { appendHostEvent } from './events.js';
import { FAMILY_PATTERN } from './availability.js';
import { normalizeFamily } from './family.js';
import { HOST_CAPABILITIES, HOST_WORKTREES_MAX, isHostCapability, isHostToken } from '../hostOperations/types.js';

/**
 * cor:agt:070:01 (#1763; Holger, team chat #10405) — a registration lapses
 * after its App's number of poll intervals without a refresh: a whole number
 * from MIN to MAX, set on the App's stall schedule, DEFAULT when unset.
 */
export const HOST_LAPSE_CHECK_INS_DEFAULT = 3;
export const HOST_LAPSE_CHECK_INS_MIN = 2;
export const HOST_LAPSE_CHECK_INS_MAX = 10;

/** The App's lapse count, in SQL: `s` is a LEFT JOIN of agent_task_stall_schedule on the registration's App. */
const LAPSE_SQL = Prisma.sql`COALESCE(s.host_lapse_check_ins, ${HOST_LAPSE_CHECK_INS_DEFAULT})`;
export const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const HOST_LABEL_MAX = 128;
export const HOST_POLL_SECONDS_MAX = 86_400;
/** At most this many workers per registration. */
export const HOST_WORKERS_MAX = 500;

type Db = PrismaClient | Prisma.TransactionClient;

/** A registration refused by its shape or its workers; nothing was written. */
export class HostRegistrationError extends Error {
  constructor(readonly code: 'BAD_HOST_REGISTRATION' | 'APP_NOT_LIVE', message: string) {
    super(message);
    this.name = 'HostRegistrationError';
  }
}

/** When a registration lapses: its last refresh plus `checkIns` of its poll intervals (its App's count). */
export function registrationLapsesAt(
  r: { refreshedAt: Date; pollIntervalSeconds: number },
  checkIns: number = HOST_LAPSE_CHECK_INS_DEFAULT,
): Date {
  return new Date(r.refreshedAt.getTime() + checkIns * r.pollIntervalSeconds * 1000);
}

/** Is the registration live at `now`, under its App's lapse count? Inclusive, like a session's window. */
export function isRegistrationLive(
  r: { refreshedAt: Date; pollIntervalSeconds: number },
  now: Date,
  checkIns: number = HOST_LAPSE_CHECK_INS_DEFAULT,
): boolean {
  return registrationLapsesAt(r, checkIns).getTime() >= now.getTime();
}

export type HostRegistrationInput = {
  appId: string;
  /** The host's id within its App. From T6, taken from the host's key, never the request. */
  hostId: string;
  label: string;
  pollIntervalSeconds: number;
  /** #1709: `worktrees` are the worker's existing worktrees on this host (cor:agt:070:06, :08); none when omitted. */
  workers: { workerId: string; family: string; worktrees?: string[] }[];
  /**
   * #2162 (cor:agt:070:01, Proposed): the capability-gated operation types this host performs. Every refresh states
   * them in full; omitted means none, so a host that stops declaring one is never issued it again.
   */
  capabilities?: string[];
};

/** #1709: hooks a key-authenticated caller runs inside the registration's transaction, after the App's anchor. */
export type RegisterHostHooks = {
  /** Re-check the caller's authority under the anchor; throws to refuse (nothing is written). */
  authorize?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Runs after the write, in the same transaction (the host-key use record). */
  afterWrite?: (tx: Prisma.TransactionClient, r: { registrationId: string; workerCount: number }) => Promise<void>;
};

/**
 * Register or refresh a host (cor:agt:070:01). INTERNAL: see the file header.
 *
 * Replaces the host's worker list with `workers`, each a worker of the App
 * that is not retired, with a family token. Writes `host.registered` when the
 * host is new, or was lapsed; an ordinary refresh writes nothing. Runs under
 * the App's authority anchor (shared), so an uninstall or delete either
 * committed first and is refused here, or waits for this write.
 */
export async function registerHost(
  db: PrismaClient,
  input: HostRegistrationInput,
  now = new Date(),
  hooks: RegisterHostHooks = {},
): Promise<{ registrationId: string; registered: boolean }> {
  const hostId = (input.hostId ?? '').trim();
  const label = (input.label ?? '').trim();
  if (!HOST_ID_PATTERN.test(hostId)) {
    throw new HostRegistrationError('BAD_HOST_REGISTRATION', 'hostId is a token: letters, digits, ".", "_", ":" or "-", up to 128 characters.');
  }
  if (label === '' || label.length > HOST_LABEL_MAX) {
    throw new HostRegistrationError('BAD_HOST_REGISTRATION', `label is 1 to ${HOST_LABEL_MAX} characters.`);
  }
  if (!Number.isInteger(input.pollIntervalSeconds) || input.pollIntervalSeconds < 1 || input.pollIntervalSeconds > HOST_POLL_SECONDS_MAX) {
    throw new HostRegistrationError('BAD_HOST_REGISTRATION', `pollIntervalSeconds is a whole number from 1 to ${HOST_POLL_SECONDS_MAX}.`);
  }
  if (input.workers.length > HOST_WORKERS_MAX) {
    throw new HostRegistrationError('BAD_HOST_REGISTRATION', `A host registers at most ${HOST_WORKERS_MAX} workers.`);
  }
  const capabilities = [...new Set(input.capabilities ?? [])].sort();
  for (const c of capabilities) {
    if (!isHostCapability(c)) {
      throw new HostRegistrationError('BAD_HOST_REGISTRATION', `A host declares only these capabilities: ${HOST_CAPABILITIES.join(', ')}.`);
    }
  }
  const workers = new Map<string, { family: string; worktrees: string[] }>();
  for (const w of input.workers) {
    const family = normalizeFamily(w.family);
    if (!family || !FAMILY_PATTERN.test(family)) {
      throw new HostRegistrationError('BAD_HOST_REGISTRATION', `${w.family} is not a model family token.`);
    }
    if (workers.has(w.workerId)) {
      throw new HostRegistrationError('BAD_HOST_REGISTRATION', `Worker ${w.workerId} is listed twice; a host launches a worker as one family.`);
    }
    const worktrees = w.worktrees ?? [];
    if (worktrees.length > HOST_WORKTREES_MAX) {
      throw new HostRegistrationError('BAD_HOST_REGISTRATION', `A worker has at most ${HOST_WORKTREES_MAX} worktrees on one host.`);
    }
    if (new Set(worktrees).size !== worktrees.length) {
      throw new HostRegistrationError('BAD_HOST_REGISTRATION', `Worker ${w.workerId} lists a worktree twice.`);
    }
    for (const t of worktrees) {
      if (!isHostToken(t)) {
        throw new HostRegistrationError(
          'BAD_HOST_REGISTRATION',
          'A worktree is a name token: letters, digits and . _ / @ + -, starting with a letter or digit, with no "..", "//" or trailing "/".',
        );
      }
    }
    workers.set(w.workerId, { family, worktrees });
  }

  // `now` is the caller's sample, taken just before this call (it defaults to one here): its monotonic half.
  const anchor = anchorNow();
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: input.appId }], 'shared');
    if (hooks.authorize) await hooks.authorize(tx);
    // #2022: the stop fence, exclusive, before the lapse lock (src/lib/stopSignals/state.ts): a host signal covers the
    // workers this registration lists (R84), so a change of the list is a change of coverage, recorded below.
    await lockStopFence(tx, input.appId, 'exclusive');
    // #1863: the App's lapse count, stable for this transaction, taken BEFORE
    // the registration row (the lock order of recordHostLost).
    const checkIns = await lockAppLapseCheckIns(tx, input.appId);
    const app = await tx.app.findUnique({ where: { id: input.appId }, select: { deletedAt: true, uninstalledAt: true } });
    if (!app || app.deletedAt || app.uninstalledAt) {
      throw new HostRegistrationError('APP_NOT_LIVE', 'The App does not exist or is uninstalled.');
    }
    if (workers.size) {
      // FOR SHARE: a concurrent retire either committed first (and is refused
      // here) or waits for this registration.
      const rows = await tx.$queryRaw<{ id: string; appId: string; retiredAt: Date | null }[]>`
        SELECT id, app_id AS "appId", retired_at AS "retiredAt" FROM workers
        WHERE id IN (${Prisma.join([...workers.keys()])}) FOR SHARE`;
      const ok = new Set(rows.filter((r) => r.appId === input.appId && !r.retiredAt).map((r) => r.id));
      const bad = [...workers.keys()].filter((id) => !ok.has(id));
      if (bad.length) {
        throw new HostRegistrationError('BAD_HOST_REGISTRATION', `Not a worker of this App that is not retired: ${bad.join(', ')}.`);
      }
    }

    const nowNaive = toNaiveUtc(now);
    // Insert-or-lock, never read-then-insert: a second registration of the
    // same host conflicts on (app_id, host_id) and then waits on the row.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO host_registrations (id, app_id, host_id, label, poll_interval_seconds, registered_at, refreshed_at)
      VALUES (${generateId()}, ${input.appId}, ${hostId}, ${label}, ${input.pollIntervalSeconds},
              ${nowNaive}::timestamp, ${nowNaive}::timestamp)
      ON CONFLICT (app_id, host_id) DO NOTHING
      RETURNING id`;
    const [cur] = await tx.$queryRaw<{ id: string; refreshedAt: Date; pollIntervalSeconds: number; lostAt: Date | null }[]>`
      SELECT id, refreshed_at AS "refreshedAt", poll_interval_seconds AS "pollIntervalSeconds", lost_at AS "lostAt"
      FROM host_registrations WHERE app_id = ${input.appId} AND host_id = ${hostId} FOR UPDATE`;
    const isNew = inserted.length > 0;
    const wasLapsed = !isNew && (cur.lostAt !== null || !isRegistrationLive(cur, now, checkIns));
    await tx.hostRegistration.update({
      where: { id: cur.id },
      data: { label, pollIntervalSeconds: input.pollIntervalSeconds, refreshedAt: now, lostAt: null, capabilities },
    });
    await tx.hostRegistrationWorker.deleteMany({ where: { registrationId: cur.id } });
    if (workers.size) {
      await tx.hostRegistrationWorker.createMany({
        data: [...workers].map(([workerId, w]) => ({ registrationId: cur.id, workerId, family: w.family, worktrees: w.worktrees })),
      });
    }
    if (hooks.afterWrite) await hooks.afterWrite(tx, { registrationId: cur.id, workerCount: workers.size });
    // The coverage history at the moment after this registration's waits (Xan #2166 LOCAL-1).
    await reconcileStopCoverage(tx, input.appId, afterWaits(now, anchor));
    const registered = isNew || wasLapsed;
    if (registered) {
      await appendHostEvent(tx, {
        appId: input.appId, type: 'host.registered', registrationId: cur.id, hostId, workerCount: workers.size, createdAt: now,
      });
    }
    return { registrationId: cur.id, registered };
  });
}

/**
 * The families each worker is launchable as through a LIVE registration
 * (cor:agt:060:04 for an unbound worker): workerId → families, sorted. #1709:
 * only a held, unretired worker with an existing worktree on that host is
 * launchable (060:05: a host launches only a worker someone holds; 070:06).
 */
export async function loadLaunchableFamilies(
  db: Db,
  scope: { appId: string } | { workerIds: string[] },
  now: Date,
): Promise<Map<string, string[]>> {
  if ('workerIds' in scope && scope.workerIds.length === 0) return new Map();
  const where = 'appId' in scope
    ? Prisma.sql`r.app_id = ${scope.appId}`
    : Prisma.sql`w.worker_id IN (${Prisma.join(scope.workerIds)})`;
  const rows = await db.$queryRaw<{ workerId: string; family: string }[]>`
    SELECT DISTINCT w.worker_id AS "workerId", w.family
    FROM host_registration_workers w
    JOIN host_registrations r ON r.id = w.registration_id
    -- #1709 (cor:agt:060:05, 070:08): a host launches only a worker someone holds, in a worktree it already has.
    JOIN workers wk ON wk.id = w.worker_id AND wk.held_by_user_id IS NOT NULL AND wk.retired_at IS NULL
      AND cardinality(w.worktrees) > 0
    JOIN apps a ON a.id = r.app_id AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
    LEFT JOIN agent_task_stall_schedule s ON s.app_id = r.app_id
    WHERE ${where}
      AND r.refreshed_at + make_interval(secs => r.poll_interval_seconds * ${LAPSE_SQL}) >= ${toNaiveUtc(now)}::timestamp
    ORDER BY 1, 2`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const family = normalizeFamily(r.family);
    if (!family) continue;
    const list = out.get(r.workerId) ?? [];
    if (!list.includes(family)) list.push(family);
    out.set(r.workerId, list);
  }
  return out;
}

/**
 * Write down every registration that has lapsed since it was last seen live:
 * `host.lost` once, stamping `lostAt` (a conditional update on the row as
 * read, so a concurrent refresh or a second pass wins cleanly). Returns how
 * many it recorded.
 */
export async function sweepLostHosts(db: PrismaClient, now: Date): Promise<number> {
  let lost = 0;
  for (const r of await readLostCandidates(db, now)) {
    if (await recordHostLost(db, r, now)) lost += 1;
  }
  return lost;
}

type LostCandidate = { id: string; appId: string; hostId: string; workerCount: number };

/** The sweep's read: registrations that looked lapsed under their App's count at `now` (at most 500). */
async function readLostCandidates(db: PrismaClient, now: Date): Promise<LostCandidate[]> {
  return db.$queryRaw<LostCandidate[]>`
    SELECT r.id, r.app_id AS "appId", r.host_id AS "hostId",
           (SELECT count(*)::int FROM host_registration_workers w WHERE w.registration_id = r.id) AS "workerCount"
    FROM host_registrations r
    LEFT JOIN agent_task_stall_schedule s ON s.app_id = r.app_id
    WHERE r.lost_at IS NULL
      AND r.refreshed_at + make_interval(secs => r.poll_interval_seconds * ${LAPSE_SQL}) < ${toNaiveUtc(now)}::timestamp
    ORDER BY r.id
    LIMIT 500`;
}

/**
 * The sweep's write for one candidate: stamp `lostAt` and write `host.lost`,
 * only if the registration is STILL lapsed when decided again under locks.
 *
 * The candidate was read under the App's lapse count as it was then; a manager
 * may have raised it since (#1863 review, Anne P2). So the App's count is read
 * again under {@link lockAppLapseCheckIns} (a concurrent change either committed
 * first and is seen, or waits for this transaction, whether or not the App had
 * a schedule row yet), the registration is locked FOR UPDATE, and the lapse is
 * re-decided on both, so a refresh since the read leaves it alone too, as does
 * an earlier stamp. Lock order, here and in registerHost: the App's lapse lock,
 * then the registration.
 */
async function recordHostLost(db: PrismaClient, r: LostCandidate, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const checkIns = await lockAppLapseCheckIns(tx, r.appId);
    const [cur] = await tx.$queryRaw<{ refreshedAt: Date; pollIntervalSeconds: number; lostAt: Date | null }[]>`
      SELECT refreshed_at AS "refreshedAt", poll_interval_seconds AS "pollIntervalSeconds", lost_at AS "lostAt"
      FROM host_registrations WHERE id = ${r.id} FOR UPDATE`;
    if (!cur || cur.lostAt !== null) return false;
    if (isRegistrationLive(cur, now, checkIns)) return false;
    await tx.hostRegistration.update({ where: { id: r.id }, data: { lostAt: now } });
    await appendHostEvent(tx, {
      appId: r.appId, type: 'host.lost', registrationId: r.id, hostId: r.hostId, workerCount: r.workerCount, createdAt: now,
    });
    return true;
  });
}

/**
 * #1863 — the App's host-lapse lock: `exclusive` for a writer of the App's
 * lapse count (setAgentTaskStallSchedule), `shared` for a reader deciding a
 * lapse from it. An advisory lock, not a row lock, because an App that has
 * never set its schedule has no row to lock: a `SELECT … FOR SHARE` that finds
 * nothing locks nothing, and the App's FIRST setting would slip past it (Anne's
 * round-2 P2). Transaction-scoped; re-entrant; never upgrade.
 */
export async function lockAppHostLapse(tx: Prisma.TransactionClient, appId: string, mode: 'exclusive' | 'shared'): Promise<void> {
  const key = 'host-lapse:' + appId;
  if (mode === 'shared') await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * The App's lapse count for a lapse decision, stable until the transaction
 * ends: the host-lapse lock SHARED, then the schedule row FOR SHARE (which also
 * holds off a writer that skips the advisory lock, e.g. direct SQL).
 */
async function lockAppLapseCheckIns(tx: Prisma.TransactionClient, appId: string): Promise<number> {
  await lockAppHostLapse(tx, appId, 'shared');
  const [row] = await tx.$queryRaw<{ checkIns: number | null }[]>`
    SELECT host_lapse_check_ins AS "checkIns" FROM agent_task_stall_schedule WHERE app_id = ${appId} FOR SHARE`;
  return row?.checkIns ?? HOST_LAPSE_CHECK_INS_DEFAULT;
}

/** The sweep's read and per-candidate write, apart, so a test can change the App's count between them. */
export const __lostHostTesting = { readLostCandidates, recordHostLost };
