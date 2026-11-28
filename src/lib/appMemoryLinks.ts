/**
 * #5185 (A3 of #5182; cor:dmo:060:20, Exceptions, "An attached memory"), narrowed by #5321 (cor:dmo:060:22, cor:acl:140:02): an
 * App's links are its scope list, and give no access. Since #5321 the App reads outside its own memories only through a
 * `memory.read` grant (src/lib/grants/readGrant.ts), never through a link; the reach this module once gave a pure key or a
 * userless run (`linkedMemoryReach`, `linkedReachFor`) is gone.
 *
 * What stays here: `judgeAppLinks`, which says whether each link is ACTIVE (shown as `AppAttachedMemory.active`): the App is live
 * and installed, the memory is live and not `system`, and the ATTACHER can read the memory NOW in their own right
 * (`holdsContentReadIndependently`, #1349, registered by the GraphQL helpers; with none registered every link is inactive, failing
 * closed). For `personal` and `private` a link is active only when the memory's owner is the App's owner and made the link.
 * Since #5345 a link to any other USER-OWNED memory (`ownerUserId` set) is inactive too; with #5321 that changes only what
 * `active` shows, since no link reads. `isPureAppKeyShape` and `readsInOwnRight` are shared with the grant judge.
 */
import type { PrismaClient } from '../generated/prisma/index.js';

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

/**
 * #5321: does `userId` read `memoryId` NOW in their own right (`holdsContentReadIndependently`)? The read-grant judge
 * (src/lib/grants/readGrant.ts) asks it of a grant's giver at every read. False while the GraphQL helpers have not
 * registered the reader, and false when the judgement throws (fail closed).
 */
export async function readsInOwnRight(db: PrismaClient, userId: string, roles: unknown, memoryId: string): Promise<boolean> {
  const holds = ownRightReader;
  if (holds === null) return false;
  return holds({ db, userId, roles: roles as never }, memoryId).catch(() => false);
}

/** The principal shape a grant read applies to: an App key or a userless run, nothing else. */
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
    // every surface). The refusal keys on the tenant-owner axis, not `userId` and not the class. On main the record gate
    // refused a knowledge/group row (no link arm in its `ownerUserId` branch), but node reads and `findNodes` read the
    // accessible set, whose link arm is this judge, so they returned its nodes; an app-class row reached every read. This
    // refusal removes all of those reads. An organization-owned link is unaffected. The row stays, inert like a lapsed one.
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
