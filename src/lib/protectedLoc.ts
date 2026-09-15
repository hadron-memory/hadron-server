/**
 * Spec 049 §2 S4 — the protected-loc write gate (shape B: the Channel table is
 * its only predicate source until D-2026-08-25-004 adds `Memory.protectedLocs`
 * as a second one).
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
 *     one an owning operation must PASS (`ownedByChannel`), so omitting it
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

export interface ProtectedLoc {
  loc: string;
  name: string;
  channelId: string;
}

/** Two locs overlap when one IS the other or one is inside the other's subtree. */
export function locsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

/** Every protected address in a memory — live AND tombstoned Channels (see the header). */
export async function protectedLocsIn(db: ChannelReader, memoryId: string): Promise<ProtectedLoc[]> {
  const rows = await db.channel.findMany({
    where: { memoryId },
    select: { id: true, loc: true, name: true },
  });
  return rows.map((r) => ({ loc: r.loc, name: r.name, channelId: r.id }));
}

/** The typed refusal — `extensions.code: 'LOC_PROTECTED'`, naming the Channel and the owning surface. */
export class LocProtectedError extends GraphQLError {
  constructor(
    public readonly loc: string,
    public readonly channel: ProtectedLoc,
    public readonly op: string,
  ) {
    super(
      `"${loc}" is protected: it is the address of Channel "${channel.name}" (${channel.loc}), which only its own operations may ${op}. Post with createTeamChatMessage / hadron_team_chat_post; the generic node surface does not reach it.`,
      { extensions: { code: 'LOC_PROTECTED', loc, channelLoc: channel.loc, channelId: channel.channelId, op } },
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
): Promise<void> {
  const list = Array.isArray(locs) ? locs : [locs];
  if (list.length === 0) return;
  const protectedLocs = await protectedLocsIn(db, memoryId);
  if (protectedLocs.length === 0) return;
  for (const loc of list) {
    const hit = protectedLocs.find((p) => locsOverlap(p.loc, loc));
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
    const hit = protectedLocs.find((p) => locsOverlap(p.loc, loc));
    if (hit) refused.push({ loc, channel: hit });
    else allowed.push(loc);
  }
  return { allowed, refused };
}
