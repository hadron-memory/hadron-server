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
 * still protects: the address stays reserved while either the row or its root
 * exists, so a soft-deleted team chat cannot be overwritten by a generic
 * create and then "restored" over.
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
    select: { id: true, loc: true, name: true },
  });
  return channels.map((r) => ({
    loc: r.loc,
    name: r.name,
    source: 'channel',
    channelId: r.id,
    owner: 'createTeamChatMessage / hadron_team_chat_post',
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

/** The remedy sentence — what a refused caller should use INSTEAD, when anything can. */
function protectedRemedy(op: string): string {
  return CHANNEL_BACKED_OPS.has(op)
    ? `Post with createTeamChatMessage / hadron_team_chat_post; the generic node surface does not reach it.`
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
      `"${loc}" is protected: it is the address of Channel "${channel.name}" (${channel.loc}), which only its own operations may ${op}. ${protectedRemedy(op)}`,
      {
        extensions: {
          code: 'LOC_PROTECTED',
          loc,
          protectedLoc: channel.loc,
          channelLoc: channel.channelId ? channel.loc : undefined,
          channelId: channel.channelId ?? undefined,
          owner: channel.owner,
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
  for (const loc of list) {
    const hit = protectedLocs.find((p) => protectedLocCovers(p, loc));
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
 * protected row — git-sync cleanup and `replaceSubtree` both delete by
 * `ownerRepo`, not by the locs they were handed, so checking the INCOMING locs
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
  const notClauses = protectedLocs.flatMap((p) => {
    const ancestors = ancestorsOf(p.loc);
    return [
      { loc: p.loc },
      { loc: { startsWith: `${p.loc}:` } },
      ...(ancestors.length ? [{ loc: { in: ancestors } }] : []),
    ];
  });
  return { notClauses };
}
