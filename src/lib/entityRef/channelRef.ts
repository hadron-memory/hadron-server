/**
 * resolveChannelRefId — convert a `channelRef` to a definite Channel id
 * (#1171). See `memoryRef.ts` for the broader convention (spec 007,
 * `cor:api:140`).
 *
 * **Two forms resolve, and the second is what this module exists for:**
 *
 *   - `<id>`                                   the Channel's PK (as before)
 *   - `hrn:node:<org>:<memory>:<loc>`          its CHAT ROOT's node URN — the
 *                                              address `createChannel` accepts
 *                                              as `(memoryRef, loc)`, in one
 *                                              string
 *
 * Spec 049 shipped a Channel that could be CREATED by name and never named
 * again: `createChannel(memoryRef, loc)` took a human address and every
 * operation after it accepted only the ULID, so `channel create` took a URN
 * while `channel read` demanded an id pasted out of a listing. The remedy is
 * server-side on purpose (`conventions:logic-lives-in-the-server-unless-it-must-run-without-one`):
 * a client-side "list, filter by memory, match loc" is four lines the CLI, the
 * portal and MCP would each carry a private copy of — and two Channels named
 * `team` at `chats:team` in different memories already exist, so three copies
 * of that rule is three chances to open the wrong chat.
 *
 * **Why the chat root's NODE urn rather than a new `hrn:channel:` kind.** A
 * Channel IS the entity for exactly one chat root (`chatRootNodeId @unique`),
 * so that node's URN already names it, resolves in every URN parser we ship,
 * and needs no grammar change across the four of them. A first-class Channel
 * URN (and the `resolveUrn` branch it would enable) is a cross-repo grammar
 * decision, deliberately left to one — this resolver is additive, so accepting
 * one later costs a branch here and nothing at any call site.
 *
 * **A miss is silent, and that is the contract, not an oversight.** The
 * Channel surface hides existence — *"a Channel you may not read, or one that
 * does not exist, is `CHANNEL_NOT_FOUND`, identically"* — so this returns
 * `null` for a malformed ref, an unparseable URN, a URN naming a node that is
 * not a chat root, and a Channel that does not exist alike, and every caller
 * folds that into its own uniform denial (`cor:api:140:02`). It deliberately
 * does NOT surface `resolveNodeRef`'s typed `NODE_NOT_FOUND` /
 * `UrnNotQualifiedError`: either one would answer, about a Channel, the
 * question its gate refuses to answer. Those two classes are the WHOLE of what
 * "names nothing" means here, and nothing else is swallowed — a Prisma failure
 * propagates, because an outage reported as a missing Channel is an outage
 * nobody goes looking for.
 *
 * **Liveness stays with the caller.** This returns an id, never a row, so each
 * site keeps its own `deletedAt: null` filter and its own read gate — the
 * widening is what a ref may SAY, never what it may reach (`cor:api:140:01`:
 * widening an argument to accept a URN is a re-authorization event, so the
 * gate must still run on the RESOLVED row).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { NodeNotFoundError, UrnNotQualifiedError } from './errors.js';
import { resolveNodeRef } from './nodeRef.js';

type ChannelRefDb = Pick<PrismaClient, 'channel' | 'node' | 'memory' | 'urnAlias'>;

/**
 * Resolve a `channelRef` to a Channel id, or `null` when it names nothing.
 *
 * An ID-shaped ref is returned as-is WITHOUT a lookup: the caller's own query
 * (which carries the read gate and the soft-delete filter) decides whether it
 * exists, exactly as before this widening — so the id path gains no round trip
 * and no new failure mode.
 */
export async function resolveChannelRefId(db: ChannelRefDb, ref: string): Promise<string | null> {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) return null;
  if (isId(trimmed)) return trimmed;
  let nodeId: string;
  try {
    // API-boundary call: no contextMemoryId (spec 022 FR-007a), so the input
    // must be a fully-qualified node URN. The resolver's two INPUT-miss
    // classes cover every way an address can name nothing — a wrong-type
    // prefix, a relative form and a malformed one are `UrnNotQualifiedError`;
    // an unknown memory and a missing or soft-deleted node are
    // `NodeNotFoundError` — and both leave here as the same `null`.
    nodeId = (await resolveNodeRef(db, trimmed)).id;
  } catch (e) {
    // Anything else is the DATABASE failing, not the ref missing (Copilot on
    // PR #1172). `resolveNodeRef` reads Prisma, so a blanket catch would turn
    // a connection error or a timeout into "no such Channel" — an outage
    // rendered as a bad ref on every address-addressed read, and the two ref
    // forms failing differently under the same fault, since the id form
    // propagates its caller's error. Rethrow.
    if (e instanceof NodeNotFoundError || e instanceof UrnNotQualifiedError) return null;
    throw e;
  }
  // A node that is not a chat root has no Channel, and a Channel is never
  // reachable through a second node: `chatRootNodeId` is unique.
  const row = await db.channel.findFirst({ where: { chatRootNodeId: nodeId }, select: { id: true } });
  return row?.id ?? null;
}
