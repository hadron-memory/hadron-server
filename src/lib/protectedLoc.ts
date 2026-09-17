/**
 * Spec 049 §2 S4 — the protected-loc write gate. TWO predicate sources now:
 * the Channel table (shape B, shipped with #1047) and `Memory.protectedLocs`
 * (D-2026-08-25-004, added by #1180).
 *
 * STRENGTHS DIFFER BY SOURCE, and that must not be forgotten because they
 * share one mechanism and one error code. A Channel's protection is a SECURITY
 * BOUNDARY: #1047 existed because chat authorship was forgeable and not
 * tamper-evident, and the owning operation derives authorship the caller cannot
 * supply. A `Memory.protectedLocs` entry is a GUARDRAIL: `authorProtectedNode`
 * is PURE ROUTING — it writes what it is given and validates nothing (Holger,
 * 2026-09-17: "I can't think of any validation needed. It should protect the
 * special nodes from being created and edited by non-specific tools, that is
 * all"). So a determined caller can still author a malformed spec node THROUGH
 * that door; what is refused is the ACCIDENTAL generic write — which is the
 * threat, since the door is deliberately absent from the MCP tool surface an
 * agent reaches for. Do not let a later reader assume a spec node's provenance
 * is as tamper-evident as a chat message's.
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

/**
 * Any client that can read the two predicate sources — the root client or a
 * transaction.
 */
export type ChannelReader = Pick<Prisma.TransactionClient, 'channel' | 'memory'>;

/** The wildcard entry in `Memory.protectedLocs` meaning "this whole memory". */
export const PROTECT_WHOLE_MEMORY = '*';

/**
 * Which predicate source protects an address. The bypass is keyed on this and
 * is NEVER universal: an operation exempts itself from the source it OWNS and
 * stays subject to the other.
 *
 * That matters because the two sources are not equally strong. A Channel's
 * protection is a SECURITY boundary — the owning operation derives authorship
 * the caller cannot supply (#1047) — while a declared `Memory.protectedLocs`
 * entry is a GUARDRAIL fronted by pure routing. A single boolean bypass would
 * let the guardrail's door walk through the boundary: `authorProtectedNode`
 * could write under `chats:team` and forge chat authorship (@codex + @copilot,
 * both P1, PR #1190).
 */
export type ProtectedSource = 'channel' | 'declared';

export interface ProtectedLoc {
  loc: string;
  /** Human name for the refusal message — a Channel's name, or the memory's. */
  name: string;
  /** Which predicate source declared this address. */
  source: ProtectedSource;
  /** Set when the source is a Channel; null for a declared `Memory.protectedLocs` entry. */
  channelId: string | null;
  /** Which authoring surface owns this address, named in the refusal. */
  owner: string;
}

/** Two locs overlap when one IS the other or one is inside the other's subtree. */
export function locsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

/**
 * Every protected address in a memory, from BOTH predicate sources:
 *
 *   - Channel rows — live AND tombstoned (see the header);
 *   - `Memory.protectedLocs` — declared per memory (D-2026-08-25-004, #1180).
 *
 * A `*` entry protects the whole memory and is represented as a loc that
 * overlaps everything, so `locsOverlap` needs no special case at the call sites.
 */
export async function protectedLocsIn(db: ChannelReader, memoryId: string): Promise<ProtectedLoc[]> {
  const [channels, memory] = await Promise.all([
    db.channel.findMany({ where: { memoryId }, select: { id: true, loc: true, name: true } }),
    db.memory.findUnique({ where: { id: memoryId }, select: { name: true, protectedLocs: true } }),
  ]);

  const out: ProtectedLoc[] = channels.map((r) => ({
    loc: r.loc,
    name: r.name,
    source: 'channel',
    channelId: r.id,
    owner: 'createTeamChatMessage / hadron_team_chat_post',
  }));

  for (const declared of memory?.protectedLocs ?? []) {
    out.push({
      loc: declared,
      name: memory?.name ?? 'this memory',
      source: 'declared',
      channelId: null,
      // BOTH doors, because this one string is all a refused caller gets and
      // the refusal does not know whether they were creating or editing
      // (`assertLocWritable` is called with op 'write' from every path). Naming
      // only the create door sent an authoring client that hit this while
      // EDITING to a create/upsert mutation — wrong API, and the kind of
      // confident wrong answer that costs more than no answer (@copilot, #1198).
      owner:
        'authorProtectedNode (create) / updateProtectedNode (edit) — the memory-specific authoring tools',
    });
  }
  return out;
}

/**
 * Does a protected entry cover `loc`? `*` covers everything in its memory;
 * otherwise the ordinary subtree overlap applies.
 *
 * EXPORTED, and the only correct way to ask. `locsOverlap(p.loc, loc)` is NOT
 * equivalent — `locsOverlap('*', 'anything')` is false, so a consumer that
 * matches raw would silently ignore a whole-memory declaration. That bit the
 * bulk paths in this PR's first revision (@codex + @copilot, both P1): git sync
 * and search-replace could rewrite and delete nodes in a memory declared
 * wholly protected. Two copies of a predicate, one of which learned a new case.
 */
export function protectedLocCovers(entry: ProtectedLoc, loc: string): boolean {
  return entry.loc === PROTECT_WHOLE_MEMORY || locsOverlap(entry.loc, loc);
}

/**
 * The ops the authoring doors can actually perform. `authorProtectedNode`
 * creates (so a create under a protected ancestor is reachable) and
 * `updateProtectedNode` edits; neither deletes and neither moves.
 *
 * This is a CAPABILITY list, not a display-verb list, and the distinction is
 * the whole point (@copilot, PR #1198, second round). An earlier version keyed
 * the remedy on `op === 'write'` and was wrong in BOTH directions, because the
 * verb a caller passes is chosen for the message and not for this:
 *
 *   - `deleteNode` passed 'write', so a protected DELETE was sent to two
 *     mutations that cannot delete;
 *   - `updateNodeData` / `updateNodeProperties` pass 'update', so an edit —
 *     which `updateProtectedNode` performs — was told no door existed.
 *
 * `deleteNode`'s verb is now 'delete', which fixes its message too ("the only
 * thing that may delete here" rather than "write"). Keep this list and the
 * callers' verbs in step: a new op defaults to NO bypass, which under-promises
 * rather than sending someone to a door that cannot help.
 */
const DOOR_BACKED_OPS = new Set(['write', 'create', 'update', 'create under']);

/**
 * The same question for the CHANNEL source, whose owning operation is
 * `createTeamChatMessage` — a message POST. It creates; it does not delete,
 * move or restore a node.
 *
 * This list exists because the first version of the op-aware remedy fixed only
 * the declared arm, and a `deleteNode` refusal at a Channel address still said
 * "Post with createTeamChatMessage" — a post mutation offered as the way to
 * delete (@copilot, PR #1198, third round). Worse, the test I wrote for the
 * declared fix asserted the Channel arm ALWAYS names its operation, pinning the
 * defect as intended behaviour. A fixture is only as good as the belief behind
 * it.
 */
const CHANNEL_BACKED_OPS = new Set(['write', 'create', 'create under']);

/**
 * The remedy sentence, which depends on the predicate SOURCE and on what the
 * caller is trying to do (@copilot, PR #1198).
 *
 * Naming an operation for something it cannot perform is a confident wrong
 * answer: the caller follows the advice to a mutation that refuses them
 * differently. Saying plainly that there is no bypass is more useful.
 *
 * `update` gets its own sentence rather than the shared `owner` string, because
 * `owner` names BOTH doors and `authorProtectedNode` cannot edit an existing
 * node — so an edit refusal that printed it would offer a create door for an
 * update. The generic `write` verb keeps naming both, since `writeNodeCore`
 * genuinely reaches this gate for creates and updates alike and the gate cannot
 * tell them apart.
 */
function protectedRemedy(entry: ProtectedLoc, op: string): string {
  if (entry.channelId) {
    return CHANNEL_BACKED_OPS.has(op)
      ? `Post with createTeamChatMessage / hadron_team_chat_post; the generic node surface does not reach it.`
      : `There is no operation that may ${op} here — the Channel's own operation posts messages, so this operation has no bypass.`;
  }
  // Name the ONE door that performs this operation. `entry.owner` advertises
  // both, so printing it for a create offers an edit door that cannot create
  // the missing node, and for an edit offers a create door that cannot edit an
  // existing one (@copilot, PR #1198, rounds 3 and 4). It is only correct for
  // the ambiguous 'write' verb, which covers both — and writeNodeCore no longer
  // passes that, so the shared string is now the fallback rather than the rule.
  if (op === 'update') {
    return `Use updateProtectedNode (the memory-specific authoring tool's edit door); the generic node surface does not reach it.`;
  }
  if (op === 'create' || op === 'create under') {
    return `Use authorProtectedNode (the memory-specific authoring tool's create door); the generic node surface does not reach it.`;
  }
  return DOOR_BACKED_OPS.has(op)
    ? `Use ${entry.owner}; the generic node surface does not reach it.`
    : `There is no authoring door for "${op}" at a declared address — the authoring tools only create and edit, so this operation has no bypass.`;
}

/** The typed refusal — `extensions.code: 'LOC_PROTECTED'`, naming the Channel and the owning surface. */
export class LocProtectedError extends GraphQLError {
  constructor(
    public readonly loc: string,
    public readonly channel: ProtectedLoc,
    public readonly op: string,
  ) {
    super(
      channel.channelId
        ? `"${loc}" is protected: it is the address of Channel "${channel.name}" (${channel.loc}), which only its own operations may ${op}. ${protectedRemedy(channel, op)}`
        : `"${loc}" is protected: memory "${channel.name}" declares ${channel.loc === '*' ? 'its whole address space' : `"${channel.loc}"`} as written only by its own authoring tool, which is the only thing that may ${op} here. ${protectedRemedy(channel, op)}`,
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
 * THE WHOLE POINT OF THIS LIVING HERE: the wildcard has now been missed twice
 * by consumers building their own clauses — `loc = '*'` and
 * `startsWith '*:'` match nothing, so a memory declared wholly protected had
 * its rows deleted by the very query meant to spare them (@copilot, PR #1190,
 * rounds 1 and 2). Ask this function; do not rebuild the predicate.
 *
 *   - `wholeMemory: true`  ⇒ delete NOTHING in this memory.
 *   - otherwise `notClauses` ⇒ pass as `NOT: { OR: notClauses }`.
 */
export function protectedDeletionFilter(protectedLocs: ProtectedLoc[]): {
  wholeMemory: boolean;
  notClauses: Array<{ loc: string } | { loc: { startsWith: string } } | { loc: { in: string[] } }>;
} {
  if (protectedLocs.some((p) => p.loc === PROTECT_WHOLE_MEMORY)) {
    return { wholeMemory: true, notClauses: [] };
  }
  const notClauses = protectedLocs.flatMap((p) => {
    const ancestors = ancestorsOf(p.loc);
    return [
      { loc: p.loc },
      { loc: { startsWith: `${p.loc}:` } },
      ...(ancestors.length ? [{ loc: { in: ancestors } }] : []),
    ];
  });
  return { wholeMemory: false, notClauses };
}
