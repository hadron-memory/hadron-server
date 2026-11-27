/**
 * #5259 (V1 of #5209) — the hosts of a team App: the platform's own record that a machine is a host of the App, and
 * that host's settings (hrn:node:hadronmemory.com:specs:cor:agt:070:01, the host itself and its settings, Proposed).
 * The doors are in src/api/graphql/schema/resolvers.agentTeamHost.ts; this file holds the rules they share.
 *
 * A host is LIVE while its row exists with no `removedAt`. Joining creates it (or revives a removed one, gate decision
 * Q6); removing stamps it. Placing a worker on a host and granting a key `host:operate` for a host need a live row
 * (HOST_NOT_FOUND otherwise). `registerHost` does not read the row (gate decision Q5): a removed host's keys are
 * revoked, which is what refuses it.
 *
 * LOCK ORDER (src/lib/hostOperations/assignments.ts, the host-setup lock): every writer of a row holds the App's
 * authority anchor, then the App's host-setup lock EXCLUSIVE, then the row FOR UPDATE. Removal adds, after the lapse
 * count (taken before the host-setup lock, as fenceHostDecision takes it), every registration of the App FOR SHARE, the
 * host's registration FOR UPDATE, then each open operation of the host FOR UPDATE and, for a `worker.end`, its session
 * FOR UPDATE (settleAsFailedReport), then the host's keys. See removeTeamHost.
 */

import { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { appendHostEvent } from '../agentTasks/events.js';
import { HOST_ID_PATTERN } from './types.js';
import { sessionRunsOn } from './agentlessEnd.js';
import { settleAsFailedReport } from './settle.js';

export const TEAM_HOST_LABEL_MAX = 128;
export const TEAM_HOST_POLL_SECONDS_MAX = 86_400;

/**
 * The failure reason an open operation of a removed host is settled with: a leading closed code (the context reset's
 * and AGENT_ABSENT's convention for a coded reason), then the words. hrn:node:hadronmemory.com:specs:cor:agt:070:02
 * (Proposed: removing a host fails its issued and collected operations, with a reason saying the host was removed).
 */
export const HOST_REMOVED_REASON = 'HOST_REMOVED: The host was removed from the team before this finished.';

/** A row of agent_team_hosts as the doors return it. */
export type TeamHostRow = {
  id: string; appId: string; hostId: string; label: string; pollIntervalSeconds: number | null; deliveryEnabled: boolean | null;
  createdByUserId: string | null; createdAt: Date; updatedAt: Date; removedAt: Date | null; removedByUserId: string | null;
};

/** The caller's own input was not a host token, label or setting. Code BAD_AGENT_TEAM_HOST_ARGS; the message repeats no input. */
export class TeamHostArgsError extends Error {
  readonly code = 'BAD_AGENT_TEAM_HOST_ARGS';
  constructor(message: string) {
    super(message);
    this.name = 'TeamHostArgsError';
  }
}

/** A host id from a label: lower case, every run of other characters one `-`, no leading or trailing `-`, 128 at most. */
export function hostIdFromLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 128).replace(/-+$/, '');
}

/** The join's host id and label: either may be omitted, not both; the host id defaults to a slug of the label, the label to the host id. */
export function joinIdentity(input: { hostId?: string | null; label?: string | null }): { hostId: string; label: string; labelGiven: boolean } {
  const labelGiven = input.label != null;
  const label = labelGiven ? input.label!.trim() : null;
  if (label !== null && (label === '' || label.length > TEAM_HOST_LABEL_MAX)) {
    throw new TeamHostArgsError(`label is 1 to ${TEAM_HOST_LABEL_MAX} characters.`);
  }
  const hostId = input.hostId != null ? input.hostId.trim() : label !== null ? hostIdFromLabel(label) : '';
  if (!HOST_ID_PATTERN.test(hostId)) {
    throw new TeamHostArgsError('hostId is a host token: letters, digits, ".", "_", ":" or "-", up to 128 characters, starting with a letter or digit. Give it, or a label it can be made from.');
  }
  return { hostId, label: label ?? hostId, labelGiven };
}

/** A setting change: omitted keeps, null clears to the default. The label is never cleared. */
export type TeamHostSettings = { label?: string; pollIntervalSeconds?: number | null; deliveryEnabled?: boolean | null };

export function validateSettings(input: { label?: string | null; pollIntervalSeconds?: number | null; deliveryEnabled?: boolean | null }): TeamHostSettings {
  const out: TeamHostSettings = {};
  if (input.label !== undefined) {
    const label = input.label === null ? '' : input.label.trim();
    if (label === '' || label.length > TEAM_HOST_LABEL_MAX) throw new TeamHostArgsError(`label is 1 to ${TEAM_HOST_LABEL_MAX} characters; it cannot be cleared.`);
    out.label = label;
  }
  if (input.pollIntervalSeconds !== undefined) {
    const p = input.pollIntervalSeconds;
    if (p !== null && (!Number.isInteger(p) || p < 1 || p > TEAM_HOST_POLL_SECONDS_MAX)) {
      throw new TeamHostArgsError(`pollIntervalSeconds is a whole number from 1 to ${TEAM_HOST_POLL_SECONDS_MAX}, or null for the default.`);
    }
    out.pollIntervalSeconds = p;
  }
  if (input.deliveryEnabled !== undefined) out.deliveryEnabled = input.deliveryEnabled;
  return out;
}

const ROW_SQL = Prisma.sql`id, app_id AS "appId", host_id AS "hostId", label, poll_interval_seconds AS "pollIntervalSeconds",
  delivery_enabled AS "deliveryEnabled", created_by_user_id AS "createdByUserId", created_at AS "createdAt", updated_at AS "updatedAt",
  removed_at AS "removedAt", removed_by_user_id AS "removedByUserId"`;

/**
 * Insert-or-lock the App's row for `hostId`, never read-then-insert: of two writers that race, one inserts and the other
 * conflicts on (app_id, host_id) and then waits on the row. Returns the row, locked FOR UPDATE, and whether this call
 * created it. The doors call it under the App's anchor and host-setup lock, which already serialize them; the unique
 * index is what holds without them.
 */
export async function insertOrLockTeamHost(
  tx: Prisma.TransactionClient,
  a: { appId: string; hostId: string; label: string; createdByUserId: string; now: Date },
): Promise<{ row: TeamHostRow; created: boolean }> {
  const at = toNaiveUtc(a.now);
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO agent_team_hosts (id, app_id, host_id, label, created_by_user_id, created_at, updated_at)
    VALUES (${generateId()}, ${a.appId}, ${a.hostId}, ${a.label}, ${a.createdByUserId}, ${at}::timestamp, ${at}::timestamp)
    ON CONFLICT (app_id, host_id) DO NOTHING
    RETURNING id`;
  const row = await lockTeamHost(tx, a.appId, a.hostId);
  // Only the App's cascade deletes a row, and the caller's App anchor excludes it. Should a delete path ever appear,
  // fail the transaction loudly rather than hand back a row that is not there.
  if (!row) throw new Error(`insertOrLockTeamHost: the host row (app ${a.appId}, host ${a.hostId}) vanished between the insert and the lock`);
  return { row, created: inserted.length > 0 };
}

/** The App's row for `hostId`, live or removed, locked FOR UPDATE; null when there is none. */
export async function lockTeamHost(tx: Prisma.TransactionClient, appId: string, hostId: string): Promise<TeamHostRow | null> {
  const [row] = await tx.$queryRaw<TeamHostRow[]>`
    SELECT ${ROW_SQL} FROM agent_team_hosts WHERE app_id = ${appId} AND host_id = ${hostId} FOR UPDATE`;
  return row ?? null;
}

/** Is there a live row for `hostId` in the App? */
export async function isLiveTeamHost(db: Prisma.TransactionClient, appId: string, hostId: string): Promise<boolean> {
  const row = await db.agentTeamHost.findFirst({ where: { appId, hostId, removedAt: null }, select: { id: true } });
  return row !== null;
}

/** The App's live rows, by host id; or the one host's, when `hostId` is given. */
export function loadLiveTeamHosts(db: Prisma.TransactionClient, appId: string, hostId?: string): Promise<TeamHostRow[]> {
  return db.agentTeamHost.findMany({ where: { appId, removedAt: null, ...(hostId !== undefined ? { hostId } : {}) }, orderBy: { hostId: 'asc' } });
}

/**
 * The live keys of the App that hold a live `host:operate` for `hostId` (one live grant per key, so revoking them
 * touches no other host). Revoked with `revokedAt = now` when `revoke` is set. Returns their ids.
 */
export async function liveHostKeyIds(tx: Prisma.TransactionClient, appId: string, hostId: string): Promise<string[]> {
  const rows = await tx.appKey.findMany({
    where: { appId, revokedAt: null, scopes: { some: { scope: 'host:operate', hostId, revokedAt: null } } },
    select: { id: true }, orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.id);
}

export async function revokeKeys(tx: Prisma.TransactionClient, ids: string[], now: Date): Promise<void> {
  if (ids.length) await tx.appKey.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: now } });
}

/**
 * Gate decision Q4: does a worker of `hostId` have an open session? One predicate, {@link sessionRunsOn}'s: over the
 * App's unended sessions of a worker, a host-launched one runs on the host it was launched on, a hand-started one on
 * its worker's sole live registration. The caller holds the lapse count and every registration of the App FOR SHARE
 * (sessionRunsOn's requirement), and takes no session row lock: a session bound concurrently is an accepted residual
 * (its host's keys are revoked in the same act).
 */
export async function hostHasOpenSession(
  tx: Prisma.TransactionClient,
  at: { appId: string; hostId: string; now: Date; checkIns: number },
): Promise<boolean> {
  const open = await tx.session.findMany({
    where: { appId: at.appId, workerId: { not: null }, endedAt: null, deletedAt: null },
    select: { workerId: true, launchHostId: true },
    orderBy: { id: 'asc' },
  });
  for (const s of open) {
    if (await sessionRunsOn(tx, { appId: at.appId, workerId: s.workerId!, hostId: at.hostId, now: at.now, checkIns: at.checkIns }, s)) return true;
  }
  return false;
}

/**
 * The rest of a removal, after the door's gate, under the App's anchor (exclusive), the lapse count, the host-setup lock
 * and the row: end the host's registration (`host.lost`, so its workers stop counting as launchable at once,
 * hrn:node:hadronmemory.com:specs:cor:agt:070:01), fail its issued and collected operations with {@link HOST_REMOVED_REASON}
 * through the settle writer (builder's note N1: an operation whose effect already happened reads succeeded, as on a
 * lapse), revoke its keys and remove its assignments.
 */
export async function endRemovedHost(tx: Prisma.TransactionClient, a: { appId: string; hostId: string; now: Date }): Promise<void> {
  const [reg] = await tx.$queryRaw<{ id: string; lostAt: Date | null }[]>`
    SELECT id, lost_at AS "lostAt" FROM host_registrations WHERE app_id = ${a.appId} AND host_id = ${a.hostId} FOR UPDATE`;
  if (reg && reg.lostAt === null) {
    await tx.hostRegistration.update({ where: { id: reg.id }, data: { lostAt: a.now } });
    const workerCount = await tx.hostRegistrationWorker.count({ where: { registrationId: reg.id } });
    await appendHostEvent(tx, { appId: a.appId, type: 'host.lost', registrationId: reg.id, hostId: a.hostId, workerCount, createdAt: a.now });
  }
  const open = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM host_operations WHERE app_id = ${a.appId} AND host_id = ${a.hostId} AND status IN ('issued', 'collected') ORDER BY id`;
  for (const { id } of open) {
    // As settleOne: the row locked, then judged again (a report that committed first is seen, one later waits).
    const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM host_operations WHERE id = ${id} FOR UPDATE`;
    if (!locked || (locked.status !== 'issued' && locked.status !== 'collected')) continue;
    const op = await tx.hostOperation.findUniqueOrThrow({ where: { id } });
    await settleAsFailedReport(tx, op, HOST_REMOVED_REASON, a.now);
  }
  await revokeKeys(tx, await liveHostKeyIds(tx, a.appId, a.hostId), a.now);
  await tx.hostWorkerAssignment.deleteMany({ where: { appId: a.appId, hostId: a.hostId } });
}
