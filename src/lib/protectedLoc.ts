/**
 * Spec 049 §2 S4 — the protected-loc write gate. ONE predicate source: the
 * Channel table (shape B, #1047).
 *
 * THIS MODULE IS ABOUT *WHERE* A WRITE LANDS, and only that. #1180 briefly
 * added `Memory.protectedLocs` as a second source so a corpus could declare its
 * own addresses; #1201 removed it, because governing AUTHORED KINDS by address
 * was the wrong axis — a task node is dangerous because it is RUNNABLE, not
 * because of where it sits. That job moved to `src/lib/governedRole.ts`, which
 * keys on what a write PRODUCES.
 *
 * Keep the two apart. A Channel's protection is a SECURITY BOUNDARY about an
 * operation owning an address: #1047 existed because chat authorship was
 * forgeable and not tamper-evident, and `createChannelMessage` derives
 * authorship the caller cannot supply. The governed-role gate is about what a
 * node IS. A caller exempt from one is fully subject to the other — which is
 * what stops a kind door writing under `chats:team` and forging chat
 * authorship (#1190 shipped a single boolean covering both; @codex + @copilot
 * flagged it P1).
 *
 * A Channel row declares an address (`chats:team`) whose subtree is written by
 * ONE owning operation (`createTeamChatMessage` and its Channel-addressed
 * successors) and by nothing else — that is hadron-server#1047's closure: the
 * team chat's guarantees (atomic seq, derived authorship, write-time mentions)
 * were enforced by one write path while the loc stayed writable by several,
 * so authorship was forgeable and not tamper-evident.
 *
 * WRITE-ONLY, and OVERLAP in both directions (plan §2 S4): a create/update
 * under the address, a recursive delete of an ANCESTOR that contains it, a
 * move whose SOURCE subtree contains it or whose DESTINATION enters it — all
 * refused. Reads stay memory-wide (D-2026-08-25-004). A tombstoned Channel
 * still RESERVES its address — so a soft-deleted team chat cannot be
 * overwritten by a generic create and then "restored" over — but since #1226 it
 * no longer blocks DELETE. Reservation is a claim about who may PUT something
 * there; enforcing it against removal produced a gate with no exit, because
 * `deleteChannel` leaves the message subtree behind and the refusal named
 * operations of a Channel that was gone. See `CLEANUP_OPS`.
 *
 * The check lives in TWO places, deliberately (a-gate-a-caller-can-omit):
 *   - inside the subtree LOCK helpers (`nodeSubtreeLock.ts`) — every create,
 *     delete and move takes one, and the parameter that bypasses the check is
 *     one an owning operation must PASS (`ownedByOperation`), so omitting it
 *     refuses rather than admits;
 *   - explicitly in the in-place update paths, which take no lock.
 *
 * Sits ABOVE the platform-admin early-returns exactly as `chatLocFilter`'s
 * team-chat refusal does (#1030): admins skip entitlement narrowing and would
 * otherwise be the one principal still able to write under a Channel.
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { escapePrismaLikePattern } from './literalLocPrefix.js';

/** Any client that can read the Channel table — the root client or a transaction. */
export type ChannelReader = Pick<Prisma.TransactionClient, 'channel'>;

/**
 * Which predicate source protects an address. One member today, and it stays a
 * union rather than collapsing to a boolean **on purpose**: the bypass must be
 * keyed on the source a caller OWNS, so that adding a second source later
 * cannot silently make an existing caller exempt from it. #1190 shipped the
 * boolean form and it let an authoring door write under `chats:team`
 * (@codex + @copilot, both P1).
 */
export type ProtectedSource = 'channel';

export interface ProtectedLoc {
  loc: string;
  /** The Channel's name, for the refusal message. */
  name: string;
  /** Which predicate source declared this address. */
  source: ProtectedSource;
  /** The Channel row's id. Nullable only because a second source may return null again. */
  channelId: string | null;
  /**
   * Is the owning Channel still live? #1226 — a TOMBSTONED Channel keeps its
   * address RESERVED but stops blocking cleanup; see `CLEANUP_OPS`.
   */
  live: boolean;
  /** Which authoring surface owns this address, named in the refusal. */
  owner: string;
}

/** Two locs overlap when one IS the other or one is inside the other's subtree. */
export function locsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

/**
 * Every protected address in a memory: Channel rows, live AND tombstoned (see
 * the header for why a tombstone still protects).
 */
export async function protectedLocsIn(db: ChannelReader, memoryId: string): Promise<ProtectedLoc[]> {
  const channels = await db.channel.findMany({
    where: { memoryId },
    select: { id: true, loc: true, name: true, deletedAt: true },
  });
  return channels.map((r) => ({
    loc: r.loc,
    name: r.name,
    source: 'channel',
    channelId: r.id,
    live: r.deletedAt === null,
    owner: 'createTeamChatMessage / hadron team chat post',
  }));
}

/**
 * Does a protected entry cover `loc`? Subtree overlap in both directions.
 *
 * EXPORTED, and the only correct way to ask, even though it is now a one-line
 * delegation. It carried a `*` whole-memory case for `Memory.protectedLocs`
 * (#1190) and two consumers that called `locsOverlap` directly silently ignored
 * it — `locsOverlap('*', x)` is false — so git sync and search-replace could
 * delete rows in a memory declared wholly protected (@codex + @copilot, both
 * P1). #1201 removed the wildcard with the column, but the lesson is why this
 * stays the single entry point rather than being inlined back: the next case it
 * learns must reach every consumer, and that only works if there is one.
 */
export function protectedLocCovers(entry: ProtectedLoc, loc: string): boolean {
  return locsOverlap(entry.loc, loc);
}

/**
 * The ops a Channel's owning operation can actually perform.
 * `createTeamChatMessage` / `createChannelMessage` POST a message: they create,
 * and they do not delete, move or restore a node.
 *
 * A CAPABILITY list, not a display-verb list, and the distinction is the whole
 * point (@copilot, PR #1198). The verb a caller passes is chosen for the
 * message — `deleteNode` passed 'write' — so keying the remedy on it offered a
 * post mutation as the way to delete. An op not in this list gets the
 * no-bypass wording, which under-promises rather than sending someone to an
 * operation that cannot help; keep it in step with the callers' verbs.
 *
 * #1201 removed the second, DECLARED arm of this function along with
 * `Memory.protectedLocs`. The lesson it left is recorded on its replacement
 * (`governedRole.ts`): a test I wrote for the declared arm asserted the Channel
 * arm always names its operation, and passed, pinning the defect as intended
 * behaviour. A fixture is only as good as the belief behind it.
 */
const CHANNEL_BACKED_OPS = new Set(['write', 'create', 'create under']);

/**
 * The ops a TOMBSTONED Channel stops blocking (#1226).
 *
 * A tombstoned Channel must keep its address RESERVED — that is this module's
 * original reason and it still holds: without it a generic `create` could
 * occupy a soft-deleted team chat's loc and then be "restored" over. But
 * reservation is a claim about who may PUT something there, and it was being
 * enforced against REMOVING what is already there.
 *
 * The result was a gate with no exit. `deleteChannel` tombstones the Channel
 * and its chat root but not the message subtree, so the survivors were
 * refused by a gate naming "the Channel's own operations" — operations of a
 * Channel that no longer exists. @Jonas measured 7 such nodes, later 14, that
 * no available operation could remove (#1226).
 *
 * It is also a spec violation as written: `cor:dmo:010:04` makes "reads treat a
 * removed record as not-found" DURABLE, and this gate read a soft-deleted row
 * and acted on it.
 *
 * So the carve-out is by OP, not by liveness alone — the narrowest change that
 * both rescues the stranded nodes and keeps the reservation the header argues
 * for. A live Channel still owns every op; a dead one owns only the ops that
 * would REPOPULATE its address.
 */
const CLEANUP_OPS = new Set(['delete', 'delete under']);

/** Does a dead Channel release its strict descendants for this operation? */
export function releasesDeadChannelDescendants(entry: ProtectedLoc, op: string): boolean {
  return !entry.live && CLEANUP_OPS.has(op);
}

/**
 * Does a TOMBSTONED Channel's reservation still cover `loc` for a cleanup op?
 *
 * Only STRICT DESCENDANTS are released — never the reserved root itself, and
 * never an ancestor of it. @codex, PR #1257, P1: `Channel.chatRoot` is
 * `onDelete: Cascade`, so a `deleteNode(hard: true)` on the tombstoned root (or
 * a recursive hard delete of an ancestor) physically removes the node, cascades
 * the CHANNEL ROW away, and takes the reservation with it — after which a
 * generic writer can occupy the former Channel address.
 *
 * That is the exact property the carve-out promises to preserve, defeated
 * through the one delete that is not a soft delete. The orphaned subtree is
 * what needs removing; the root is what needs keeping.
 */
function deadReservationCovers(entry: ProtectedLoc, loc: string): boolean {
  // `loc` is the entry itself, or an ancestor of it (deleting `chats` would
  // take `chats:team` with it). A strict descendant is released.
  return loc === entry.loc || entry.loc.startsWith(`${loc}:`);
}

/**
 * THE predicate — does `entry` protect `loc` against `op`? Use this, never
 * `protectedLocCovers` plus a liveness test of your own.
 *
 * It exists because #1226's tombstone rule had to be applied in THREE gates and
 * I shipped it in one, then two (@codex and @copilot, PR #1257, three rounds).
 * That is the same defect this module's header already warns about from the
 * other side — "the check lives in TWO places, deliberately" — and the answer
 * is the answer `protectedDeletionFilter` already gives: ask this function, do
 * not rebuild it. A fourth gate gets the rule for free; one that reimplements
 * it gets the rule of its author's memory.
 */
export function protectedCoversForOp(entry: ProtectedLoc, loc: string, op: string): boolean {
  return releasesDeadChannelDescendants(entry, op)
    ? deadReservationCovers(entry, loc)
    : protectedLocCovers(entry, loc);
}

/**
 * The remedy sentence — what a refused caller should use INSTEAD, when anything can.
 *
 * `live` matters, and getting it wrong is the defect #1226 was filed for.
 * `createTeamChatMessage` / `hadron team chat post` resolve only LIVE Channels,
 * so offering them for a TOMBSTONED one names an operation the caller cannot
 * reach — the original complaint, which survived the op carve-out because a
 * dead Channel still refuses `create` (@copilot, PR #1257). A dead address has
 * no owning operation at all; what it has is a reservation, and the only thing
 * a caller can do about it is recreate the Channel.
 */
function protectedRemedy(op: string, live: boolean): string {
  if (!live) {
    return `The Channel is DELETED, so none of its operations can be reached — the address stays reserved so it cannot be occupied and then restored over. Recreate the Channel (createChannel) to write here, or delete what it orphaned.`;
  }
  return CHANNEL_BACKED_OPS.has(op)
    ? `Post with createTeamChatMessage / hadron team chat post; the generic node surface does not reach it.`
    : `There is no operation that may ${op} here — the Channel's own operation posts messages, so this operation has no bypass.`;
}

/** The typed refusal — `extensions.code: 'LOC_PROTECTED'`, naming the Channel and the owning surface. */
export class LocProtectedError extends GraphQLError {
  constructor(
    public readonly loc: string,
    public readonly channel: ProtectedLoc,
    public readonly op: string,
  ) {
    super(
      `"${loc}" is protected: it is the address of ${channel.live ? '' : 'the DELETED '}Channel "${channel.name}" (${channel.loc})${channel.live ? ', which only its own operations may ' + op : ''}. ${protectedRemedy(op, channel.live)}`,
      {
        extensions: {
          code: 'LOC_PROTECTED',
          loc,
          protectedLoc: channel.loc,
          channelLoc: channel.channelId ? channel.loc : undefined,
          channelId: channel.channelId ?? undefined,
          owner: channel.owner,
          // #1226 — so a client distinguishes "reserved by a dead Channel" from
          // "owned by a live one" WITHOUT parsing the message
          // (`conventions:the-error-code-is-the-contract-the-prose-is-not`).
          channelLive: channel.live,
          op,
        },
      },
    );
    this.name = 'LocProtectedError';
  }
}

/**
 * Refuse a generic write touching any protected address. `locs` are the
 * addresses the operation writes, deletes, moves FROM or moves TO.
 */
export async function assertLocWritable(
  db: ChannelReader,
  memoryId: string,
  locs: string | string[],
  op: string,
  /**
   * The predicate source this caller OWNS, if any. Entries from that source are
   * skipped; entries from every other source still refuse. Omit it — as every
   * generic writer does — and nothing is skipped.
   */
  owns?: ProtectedSource,
): Promise<void> {
  const list = Array.isArray(locs) ? locs : [locs];
  if (list.length === 0) return;
  const all = await protectedLocsIn(db, memoryId);
  const protectedLocs = owns ? all.filter((p) => p.source !== owns) : all;
  if (protectedLocs.length === 0) return;
  // #1226: a tombstoned Channel does not block cleanup of what it ORPHANED —
  // but it still reserves its own address and the path to it, because a hard
  // delete of the root cascades the Channel row away (see
  // `deadReservationCovers`).
  for (const loc of list) {
    const hit = protectedLocs.find((p) => protectedCoversForOp(p, loc, op));
    if (hit) throw new LocProtectedError(loc, hit, op);
  }
}

/**
 * Split a batch into the locs a generic writer may touch and the ones it may
 * not — for bulk surfaces (git sync, search-replace) that SKIP and report
 * rather than fail the whole batch on one protected address.
 */
export async function partitionProtected(
  db: ChannelReader,
  memoryId: string,
  locs: string[],
): Promise<{ allowed: string[]; refused: Array<{ loc: string; channel: ProtectedLoc }> }> {
  const protectedLocs = await protectedLocsIn(db, memoryId);
  const allowed: string[] = [];
  const refused: Array<{ loc: string; channel: ProtectedLoc }> = [];
  for (const loc of locs) {
    const hit = protectedLocs.find((p) => protectedLocCovers(p, loc));
    if (hit) refused.push({ loc, channel: hit });
    else allowed.push(loc);
  }
  return { allowed, refused };
}

/** The strict ancestors of a loc, root→leaf. Local copy to keep this module dependency-free. */
function ancestorsOf(loc: string): string[] {
  const parts = loc.split(':');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(':'));
}

/**
 * The exclusion a DELETING bulk surface must apply so it never removes a
 * protected row — git-sync cleanup deletes by `ownerRepo` (as the retired
 * `replaceSubtree` did before #454), not by the locs it was handed, so checking the INCOMING locs
 * protects nothing on the way out.
 *
 * THE WHOLE POINT OF THIS LIVING HERE: a consumer that rebuilds the predicate
 * learns a new case late. The wildcard was missed twice that way — `loc = '*'`
 * and `startsWith '*:'` match nothing, so a memory declared wholly protected
 * had its rows deleted by the very query meant to spare them (@copilot,
 * PR #1190, rounds 1 and 2). #1201 removed the wildcard with
 * `Memory.protectedLocs`, and with it the `wholeMemory` return this function
 * used to carry — but the rule stands: ask this function, do not rebuild it.
 *
 * Pass `notClauses` as `NOT: { OR: notClauses }`.
 */
export function protectedDeletionFilter(protectedLocs: ProtectedLoc[]): {
  notClauses: Array<{ loc: string } | { loc: { startsWith: string } } | { loc: { in: string[] } }>;
} {
  // Callers MUST hold `lockMemoryForChannelChange` from before they read
  // `protectedLocs` through the delete: otherwise a dead Channel can be
  // resurrected after this filter releases its descendants and before the
  // write consumes the stale verdict (#1257 review).
  //
  // #1226 — this is a DELETION filter, so the tombstone carve-out applies here
  // exactly as it does in `assertLocWritable`. Without it, cleanup through git
  // sync (or the since-retired `replaceSubtree`, #454) stayed blocked while the single-loc path allowed
  // it: the same rule enforced differently by two callers of the same module,
  // which is what its header warns about in the other direction (@codex, PR
  // #1257). Filtering HERE rather than at the two call sites is the point —
  // `ask this function, do not rebuild it`.
  const notClauses = protectedLocs.flatMap((p) => {
    const ancestors = ancestorsOf(p.loc);
    // A DEAD Channel releases only its orphaned DESCENDANTS: the reserved root
    // and the path to it stay excluded, or a bulk hard delete cascades the
    // Channel row away and frees the address (@codex, PR #1257, P1).
    if (!p.live) {
      return [{ loc: p.loc }, ...(ancestors.length ? [{ loc: { in: ancestors } }] : [])];
    }
    return [
      { loc: p.loc },
      { loc: { startsWith: escapePrismaLikePattern(`${p.loc}:`) } },
      ...(ancestors.length ? [{ loc: { in: ancestors } }] : []),
    ];
  });
  return { notClauses };
}
