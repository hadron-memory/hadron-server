/**
 * #2044 (S7), cor:agt:040:06 / cor:acl:010:01 — the AUDIENCE of an App's
 * INSTALL MEMORY: the per-(App, Agent) `class='system'` memory holding the
 * App's customisation of an installed Agent (`Memory.installOfAgentId`).
 *
 * ONE definition, asked by every enforcement site (the MCP access map and point
 * gates, the GraphQL record/write gates, the effective-access audit, the delete
 * gate), so the arms cannot drift between copies. It is its own arm INSIDE the
 * shared gates, keyed only on `installOfAgentId`; an Agent's own system memory
 * (which has no such column) takes exactly the path it always did, and nothing
 * about it widens.
 *
 *   | Act      | Live App                         | Soft-deleted App                   |
 *   |----------|----------------------------------|------------------------------------|
 *   | content  | the App's participants           | NOBODY (participation died)        |
 *   | record   | participants + managers          | managers only (R45: find + delete) |
 *   | write    | managers, Agent still installed  | NOBODY                             |
 *   | delete   | managers (R45)                   | managers (R45)                     |
 *
 * "Managers" is `managesApp` (the App's owner, OWNER-role members, org admins,
 * platform admins for an org App; cor:acl:010:01): R45 supersedes the earlier
 * admin-only cleanup audience. Metadata ("record") admission never confers node
 * access; the content gate is independent.
 *
 * Identity-scoped like `managesApp`: an App key (no user), an impersonation and
 * an AppRun principal (which carries its on-behalf-of user's id but acts for its
 * own App) are never admitted here. A revoked membership never authorizes
 * (`LIVE_ORG_MEMBERSHIP`, the participation predicate's own `deletedAt` rules).
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { managesApp } from './appManagement.js';
import { participantAppWhere } from './appParticipation.js';
import { isRunPrincipal } from './runPrincipal.js';

export type InstallPrincipal = {
  userId?: string | null;
  roles?: readonly string[];
  impersonation?: { orgId: string } | null;
  clientId?: string | null;
  /** A pure App key bound to a session: confined to its session reach, never an install memory. */
  appId?: string | null;
  sessionId?: string | null;
};

export type InstallAudience = {
  /** Node content: the App's live participants. */
  read: boolean;
  /** The row itself (metadata), which `concealUnreadableDenial` consults. */
  record: boolean;
  /** Source writes: managers of a live App whose Agent is still installed. */
  write: boolean;
  /** Manual deletion (R45): managers, also after the App was soft-deleted. */
  delete: boolean;
};

export const NO_INSTALL_AUDIENCE: InstallAudience = Object.freeze({
  read: false, record: false, write: false, delete: false,
});

export type InstallMemoryRow = {
  id: string;
  class: string;
  appId: string | null;
  installOfAgentId: string | null;
  organizationId: string | null;
  ownerUserId: string | null;
};

/** True for a row that IS an install memory (the discriminator every gate branches on). */
export function isInstallMemoryRow(row: { class: string; installOfAgentId?: string | null }): boolean {
  return row.class === 'system' && (row.installOfAgentId ?? null) !== null;
}

type AppForInstall = {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  deletedAt: Date | null;
  uninstalledAt: Date | null;
};

/**
 * The audience of one install memory for one principal. `db` may be a
 * transaction client; a write decided inside the writer's transaction should go
 * through {@link ensureInstallMemory}, which holds the authority rows locked.
 */
export async function installMemoryAudience(
  db: PrismaClient | Prisma.TransactionClient,
  principal: InstallPrincipal,
  memory: InstallMemoryRow,
): Promise<InstallAudience> {
  if (!isInstallMemoryRow(memory) || !memory.appId) return NO_INSTALL_AUDIENCE;
  if (!principal.userId || isRunPrincipal(principal)) return NO_INSTALL_AUDIENCE;
  // A bound pure App key has no userId and is rejected above; a hybrid
  // principal with a session is judged on the user alone, like the team space.
  const client = db as PrismaClient;
  const app = await client.app.findUnique({
    where: { id: memory.appId },
    select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
  });
  // The memory must sit in its App's own tenancy (a drifted owner is no admission path).
  if (!app || app.organizationId !== memory.organizationId || app.ownerUserId !== memory.ownerUserId) {
    return NO_INSTALL_AUDIENCE;
  }
  const manages = await managesApp(
    { db: client, userId: principal.userId, impersonation: principal.impersonation ?? undefined, roles: principal.roles },
    app,
  );
  const live = app.deletedAt === null && app.uninstalledAt === null;
  if (!live) {
    // Participation died with the App; only a manager may still find and delete the record.
    return { read: false, record: manages, write: false, delete: manages };
  }
  const participates = (await participantAppIds(client, principal, app)).length > 0;
  const installed = manages
    ? (await client.appAgent.count({ where: { appId: app.id, agentId: memory.installOfAgentId! } })) > 0
    : false;
  return {
    read: participates,
    record: participates || manages,
    write: manages && installed,
    delete: manages,
  };
}

/** Is the principal a live participant of THIS App (the register's attendee rule)? */
async function participantAppIds(
  db: PrismaClient,
  principal: InstallPrincipal,
  app: AppForInstall,
): Promise<string[]> {
  const where = await participantAppWhere(db, principal, { includeMemberships: true });
  if (!where) return [];
  const rows = await db.app.findMany({ where: { AND: [{ id: app.id }, where] }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * The install memories a principal may READ the content of (a map for the MCP
 * fold and the GraphQL accessible-id set): every live install memory of an App
 * the user participates in. A soft-deleted App contributes nothing.
 */
export async function readableInstallMemoryIds(
  db: PrismaClient,
  principal: InstallPrincipal,
): Promise<string[]> {
  if (!principal.userId || isRunPrincipal(principal)) return [];
  const where = await participantAppWhere(db, principal, { includeMemberships: true });
  if (!where) return [];
  const rows = await db.memory.findMany({
    where: {
      class: 'system', deletedAt: null, installOfAgentId: { not: null }, appId: { not: null },
      app: { is: where },
    },
    select: { id: true, appId: true, organizationId: true, ownerUserId: true, app: { select: { organizationId: true, ownerUserId: true } } },
  });
  return rows
    .filter((r) => r.app && r.app.organizationId === r.organizationId && r.app.ownerUserId === r.ownerUserId)
    .map((r) => r.id);
}

/** The install memories a principal may WRITE (managers of a live App with the Agent installed). */
export async function writableInstallMemoryIds(
  db: PrismaClient,
  principal: InstallPrincipal,
): Promise<string[]> {
  if (!principal.userId || isRunPrincipal(principal) || principal.impersonation) return [];
  const ids = await readableInstallMemoryIds(db, principal);
  const out: string[] = [];
  for (const id of ids) {
    const row = await db.memory.findUnique({
      where: { id },
      select: { id: true, class: true, appId: true, installOfAgentId: true, organizationId: true, ownerUserId: true },
    });
    if (row && (await installMemoryAudience(db, principal, row)).write) out.push(id);
  }
  return out;
}
