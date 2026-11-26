/**
 * #5185 (A3 of #5182; cor:dmo:060:20, Exceptions, "An attached memory"): what an App's links let its key read.
 *
 * `attachMemoryToApp` writes a row in `app_memory_links` and changes nothing on the memory. This module is the ONE place that
 * judges those rows, at use, for both read surfaces (GraphQL's `getAccessibleMemoryIds` and MCP's `getPrincipalAppMemoryAccess`
 * and `canReadMemoryRow`):
 *
 *  - The reach is READ only, and only for a PURE App key or a userless run of the App: no user (with or without the App
 *    selected), no impersonation, no session-bound key (session isolation stays whole), and no run that carries a user id.
 *  - A link counts only while the App is live and installed, the memory is live and not `system`, and the ATTACHER can read
 *    the memory NOW in their own right (not through any App-derived reach: `holdsContentReadIndependently`, #1349). A row whose
 *    attacher lost read stays, inert; restoring the read restores the reach.
 *  - For `personal` and `private` the link reaches the key only when the memory's owner is the App's owner (a user-owned App
 *    whose owner linked their own memory). In an organization's App, or for another person's memory shared with the attacher,
 *    the link grants nothing (Victor's reading of Holger's rulings, Proposed in the spec). A run never reads a `private`
 *    memory, linked or not (#1719 R5a).
 *
 * A link deliberately bypasses the strict-owner folds (`admissibleFoldRows` rules 2 and 3, the `appDerivedMemoryIds` class
 * filter, the `ownerUserId` early return of `canReadMemoryRow`): the attach is the only consent step, and this module is the
 * only judge, so a caller of it must not re-derive the rule.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { isRunPrincipal } from './auth/runPrincipal.js';

/**
 * "Reads it in their own right" is `holdsContentReadIndependently` (#1349), which lives with the GraphQL read gate. This module
 * sits under the MCP gate, so it must not import that one (the leaf import-graph guard); the helpers register it at load.
 */
type OwnRightReader = (ctx: { db: PrismaClient; userId: string; roles: never }, memoryId: string) => Promise<boolean>;
let ownRightReader: OwnRightReader | null = null;
export function registerOwnRightReader(reader: OwnRightReader): void {
  ownRightReader = reader;
}

/** The principal shape the link reach applies to: an App key or a userless run, nothing else. */
export function isPureAppKeyShape(auth: {
  appId?: string | null; userId?: string | null; sessionId?: string | null; impersonation?: unknown;
}): boolean {
  return Boolean(auth.appId) && !auth.userId && !auth.sessionId && !auth.impersonation;
}

/** One link row and whether it counts right now (the judgement above), for a key that is not a run. */
export type JudgedLink = { memoryId: string; attachedBy: string; active: boolean };

/**
 * Judge the App's link rows (or those of `onlyMemoryIds`) at use. A row whose App is deleted or uninstalled, whose memory is
 * gone or `system`, whose attacher no longer reads the memory in their own right, or (personal/private) whose memory is not
 * the App owner's is inactive; it is still returned, so a listing can say so.
 */
export async function judgeAppLinks(
  db: PrismaClient,
  appId: string,
  opts: { onlyMemoryIds?: readonly string[] } = {},
): Promise<JudgedLink[]> {
  if (opts.onlyMemoryIds && opts.onlyMemoryIds.length === 0) return [];
  // Links first: most Apps have none, and this runs for every read of a pure App key.
  const links = await db.appMemoryLink.findMany({
    where: { appId, ...(opts.onlyMemoryIds ? { memoryId: { in: [...opts.onlyMemoryIds] } } : {}) },
    select: {
      memoryId: true, attachedBy: true,
      memory: { select: { class: true, userId: true, deletedAt: true } },
      attacher: { select: { roles: true, deletedAt: true } },
    },
  });
  if (links.length === 0) return [];
  const app = await db.app.findUnique({
    where: { id: appId },
    select: { deletedAt: true, uninstalledAt: true, ownerUserId: true, organization: { select: { deletedAt: true } } },
  });
  const appLive = Boolean(app) && !app!.deletedAt && !app!.uninstalledAt && !app!.organization?.deletedAt;
  const eligible = (link: (typeof links)[number]): boolean => {
    if (!appLive || link.memory.deletedAt || link.attacher.deletedAt || link.memory.class === 'system') return false;
    if (link.memory.class === 'personal' || link.memory.class === 'private') {
      return app!.ownerUserId !== null && link.memory.userId === app!.ownerUserId;
    }
    return true;
  };
  const holds = ownRightReader;
  return Promise.all(links.map(async (link) => ({
    memoryId: link.memoryId,
    attachedBy: link.attachedBy,
    // Fails closed when no reader is registered (nothing loaded the GraphQL helpers): a link then counts for nothing.
    active: eligible(link) && holds !== null && await holds(
      { db, userId: link.attachedBy, roles: link.attacher.roles as never },
      link.memoryId,
    ),
  })));
}

/**
 * The ids, among the App's links (or among `onlyMemoryIds`), that its key may read through a link right now. `run`: the
 * principal is a run, which never reads a `private` memory (#1719 R5a), linked or not.
 */
export async function linkedMemoryReach(
  db: PrismaClient,
  appId: string,
  opts: { onlyMemoryIds?: readonly string[]; run?: boolean } = {},
): Promise<Set<string>> {
  const judged = await judgeAppLinks(db, appId, opts);
  const ids = new Set(judged.filter((l) => l.active).map((l) => l.memoryId));
  if (opts.run && ids.size > 0) {
    const privateRows = await db.memory.findMany({ where: { id: { in: [...ids] }, class: 'private' }, select: { id: true } });
    for (const row of privateRows) ids.delete(row.id);
  }
  return ids;
}

/** Every id the pure-key shape may read through links, for a fold or a listing; empty for any other shape. */
export async function linkedReachFor(
  db: PrismaClient,
  auth: { appId?: string | null; userId?: string | null; sessionId?: string | null; impersonation?: unknown; clientId?: string | null },
  onlyMemoryIds?: readonly string[],
): Promise<Set<string>> {
  if (!isPureAppKeyShape(auth)) return new Set();
  return linkedMemoryReach(db, auth.appId!, { onlyMemoryIds, run: isRunPrincipal(auth) });
}
