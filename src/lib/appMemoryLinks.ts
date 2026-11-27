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
 *  - For `personal` and `private` the link reaches the key only when the memory's owner is the App's owner AND the owner made
 *    the link (a user-owned App whose owner linked their own memory). In an organization's App, or for another person's memory shared with the attacher,
 *    the link grants nothing (Victor's reading of Holger's rulings, Proposed in the spec). A run never reads a `private`
 *    memory, linked or not (#1719 R5a).
 *  - Any other USER-OWNED memory (`ownerUserId` set, #5345) is inert for the key — cor:dmo:060:22 (D-2026-11-26): attaching
 *    gives no access, the interim key read of #5258/#5185 covering own personal/private only; and a list must equal the reads
 *    on every surface (cor:api:120:03). What main did differed by CLASS, though the refusal here keys on the tenant-owner
 *    axis, not `userId` and not the class: a knowledge/group row had no link arm in the record gate's `ownerUserId` branch
 *    (`canReadMemoryRecord` returns false before any link is judged — GraphQL refused while this judge admitted: the
 *    disagreement #5345 closes), while an app-class row fell through that branch to the shared accessible set, whose link
 *    arm IS this judge — so an owner-linked user-owned app-class memory (a user-owned App's own, linked into itself,
 *    included) reached every read on main, and refusing it here removes those GraphQL reads too: wider than "the read gate
 *    is unchanged", and still the Decided rule. An organization-owned link is unaffected. The row stays, inert like a
 *    lapsed one (nothing restores it but a transfer of the memory out of the user tenant); detach works as before.
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
let warnedNoReader = false;
export function registerOwnRightReader(reader: OwnRightReader | null): void {
  ownRightReader = reader;
  if (reader) warnedNoReader = false;
}

/** The principal shape the link reach applies to: an App key or a userless run, nothing else. */
export function isPureAppKeyShape(auth: {
  appId?: string | null; userId?: string | null; sessionId?: string | null; impersonation?: unknown; sessionBindingRefused?: boolean;
}): boolean {
  return Boolean(auth.appId) && !auth.userId && !auth.sessionId && !auth.sessionBindingRefused && !auth.impersonation;
}

/** One link row and whether it counts right now (the judgement above), for a key that is not a run. */
export type JudgedLink = { memoryId: string; attachedBy: string; active: boolean };

/**
 * Judge the App's link rows (or those of `onlyMemoryIds`) at use. A row whose App is deleted or uninstalled, whose memory is
 * gone or `system`, whose attacher no longer reads the memory in their own right, (personal/private) whose memory is not
 * the App owner's, or (#5345) whose memory is user-owned of another class is inactive; it is still returned, so a listing
 * can say so.
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
      memory: { select: { class: true, userId: true, ownerUserId: true, deletedAt: true } },
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
      // The consent is the owner's own: the link was made by the App's owner, of their own memory. A grantee's or an admin's
      // attach of the owner's memory grants the key nothing.
      return app!.ownerUserId !== null && link.memory.userId === app!.ownerUserId && link.attachedBy === app!.ownerUserId;
    }
    // #5345: a user-owned memory of any other class never reaches a key through a link (cor:dmo:060:22 — attaching gives
    // no access, the #5258/#5185 interim covering own personal/private only; cor:api:120:03 — a list equals the reads on
    // every surface). The refusal keys on the tenant-owner axis, not `userId` and not the class: on main a knowledge/group
    // row had no link arm in the record gate's `ownerUserId` branch (GraphQL refused while this judge admitted), while an
    // app-class row fell through to the accessible set, whose link arm is this judge — so this refusal also removes that
    // app-class read (wider than "the read gate is unchanged", still the Decided rule). An organization-owned link is
    // unaffected. The row stays, inert like a lapsed one.
    if (link.memory.ownerUserId !== null) return false;
    return true;
  };
  const holds = ownRightReader;
  if (holds === null && !warnedNoReader) {
    warnedNoReader = true;
    console.warn(JSON.stringify({ event: 'app_memory_links.no_own_right_reader', note: 'links count for nothing until the GraphQL helpers have loaded' }));
  }
  // One judgement per distinct (attacher, memory), at most 8 at a time: a link is cheap to add, and a pool is not.
  const verdicts = new Map<string, Promise<boolean>>();
  const pairs = [...new Map(links.filter(eligible).map((l) => [`${l.attachedBy}:${l.memoryId}`, l])).values()];
  let next = 0;
  const worker = async () => {
    while (next < pairs.length) {
      const link = pairs[next++]!;
      const verdict = holds === null ? Promise.resolve(false) : holds(
        { db, userId: link.attachedBy, roles: link.attacher.roles as never },
        link.memoryId,
      );
      // A judgement that throws makes that link inert (fail closed); it never fails the whole listing.
      const safe = verdict.catch(() => false);
      verdicts.set(`${link.attachedBy}:${link.memoryId}`, safe);
      await safe;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pairs.length) }, worker));
  return Promise.all(links.map(async (link) => ({
    memoryId: link.memoryId,
    attachedBy: link.attachedBy,
    active: eligible(link) && (await verdicts.get(`${link.attachedBy}:${link.memoryId}`)) === true,
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
  auth: { appId?: string | null; userId?: string | null; sessionId?: string | null; impersonation?: unknown; sessionBindingRefused?: boolean; clientId?: string | null },
  onlyMemoryIds?: readonly string[],
): Promise<Set<string>> {
  if (!isPureAppKeyShape(auth)) return new Set();
  return linkedMemoryReach(db, auth.appId!, { onlyMemoryIds, run: isRunPrincipal(auth) });
}
