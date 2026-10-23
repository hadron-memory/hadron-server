import { isRawChatNode } from '../services/embedding/rawChat.js';
import { randomUUID } from 'node:crypto';
/**
 * Spec 049 Phase 4 — Channel creation and the App's default Channel
 * (D-2026-09-13-006 / -007 D2).
 *
 * ONE creation core for every path that makes a Channel: `createApp`'s eager
 * provisioning, the team-chat bootstrap (a root that exists gets its row on
 * touch), the `createChannel` mutation, and the one-shot backfill. A Channel
 * row, its chat root and the App default link are made in the SAME
 * transaction (eager one-to-one is load-bearing — D-006's adversarial round;
 * a root committed before its row is an unprotected address for the length
 * of the gap, Codex/Copilot on PR #1165), under the ancestor lock the chat
 * surface already takes. A soft-deleted root is restored at its unique
 * address; tombstoned structural rows are archived before a fresh row takes
 * theirs (#1463).
 *
 * Under that lock the core also decides the two things only the lock can
 * decide: that no other Channel's address overlaps this one (the resolver's
 * preflight cannot — two creates can both pass it), and that the address is
 * not occupied by a LIVE node that is not a chat root (a Channel adopting an
 * arbitrary record would later delete a node nobody made a Channel).
 *
 * The audience is the host memory's (`cor:acl:030:01`), and since #1196 that is
 * the WHOLE rule: a Channel may be hosted in a memory of ANY class. The
 * `class !== 'app'` refusal is gone and `CHANNEL_HOST_NOT_APP_CLASS` is RETIRED
 * rather than repurposed — a refusal code outliving its refusal is the
 * stale-error-map half of `findings:removing-a-mechanism-leaves-prose-describing-it`.
 *
 * Holger's ruling (#1193): *"I see no disadvantage to hosting a channel in any
 * class memory. The choice will affect access, but that's the owner's problem.
 * Why close doors? Say the owner wants a channel in a private memory where only
 * the owner has access to. Why not? Have two personal agents chat there."*
 *
 * That is safe ONLY because the chat surfaces now gate on the host memory
 * instead of on App membership — before #1196 a Channel in someone's `personal`
 * memory was readable and postable by every AppMember of whichever App happened
 * to be in context, which is why the class gate could not simply be deleted on
 * its own (#1194 is this change's draft ancestor).
 */

import { sessionKeyReleasedHint } from './sessionKeyCache.js';
import { GraphQLError } from 'graphql';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import type { InputJsonValue } from '../generated/prisma/runtime/library.js';
import { generateId } from './id.js';
import { escapePrismaLikePattern } from './literalLocPrefix.js';
import { ancestorLocs, lockAncestorsForCreateMany } from './nodeSubtreeLock.js';
import { getMemoryEncryptionInfo, decryptNodeFields, encryptNodeFields, type MemoryEncryptionInfo } from './nodeCrypto.js';
import { locsOverlap } from './protectedLoc.js';
import { ensureInstallRegisterRows } from './registerInstall.js';
import { resolveAppTeamSpaceMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { pendingAtForRevival } from '../services/embedding/enqueue.js';
import { assertNoMintedSpecRemoval } from './mintedSpecPermanence.js';
import { archivedTombstoneLoc } from './tombstoneArchive.js';
import { memoryIsVectorIndexed } from './embedding/indexing.js';

/** The name of every App's default Channel — the row `chats:team` became. */
export const DEFAULT_CHANNEL_NAME = 'team';

export interface ChannelRow {
  id: string;
  memoryId: string;
  loc: string;
  name: string;
  chatRootNodeId: string;
  lastSeq: number;
  incarnation: number;
  deletedAt: Date | null;
}

/** Preserve the public typed-error contract across every crypto step. */
function translateSessionExpired<T>(memoryId: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SESSION_EXPIRED')) {
      throw new GraphQLError(
        `SESSION_EXPIRED: memory ${memoryId} is encrypted but no active session key is available. ${sessionKeyReleasedHint()}`,
        { extensions: { code: 'SESSION_EXPIRED', memoryId } },
      );
    }
    throw e;
  }
}

/**
 * The memory-level advisory lock Channel creation and `deleteMemory` share,
 * so "is this memory live?" / "does this memory host a Channel?" cannot be
 * answered on both sides at once (Copilot on PR #1165, round 2). The
 * one-argument form keys a different space from the (memory, loc) pairs the
 * subtree locks use, so it never contends with them.
 */
export async function lockMemoryForChannelChange(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'channel-host:' + memoryId}))`;
}

/**
 * Refuse an address that overlaps another Channel's in this memory (live or
 * tombstoned — the reservation is what protection means). The SAME address is
 * not a clash: that is the idempotent create-or-restore case. Run it under the
 * ancestor lock, where the answer is authoritative.
 */
export async function assertNoChannelOverlap(
  db: PrismaClient | Prisma.TransactionClient,
  memoryId: string,
  loc: string,
): Promise<void> {
  const rows = await db.channel.findMany({ where: { memoryId }, select: { loc: true, name: true } });
  const clash = rows.find((c) => c.loc !== loc && locsOverlap(c.loc, loc));
  if (clash) {
    throw new GraphQLError(`"${loc}" overlaps Channel "${clash.name}" (${clash.loc}).`, {
      extensions: { code: 'LOC_OVERLAPS_CHANNEL', loc, channelLoc: clash.loc },
    });
  }
}

/**
 * Give an EXISTING chat root its Channel row (create-or-restore, idempotent),
 * and make it the App's default when the App has none. Used by the creation
 * core (inside its transaction, under the lock) and by the one-shot backfill;
 * the team-chat path deliberately routes even a pre-Channel root through the
 * creation core so a stale live-root lookup cannot revive only this row.
 * `lastSeq` is left to the caller (the backfill seeds it, the allocator
 * maintains it).
 *
 * Outside a lock two first posts can race to the row: the loser's P2002 is
 * absorbed and the winner's row used. Inside a transaction that P2002 would
 * poison the transaction — so a transactional caller MUST hold the ancestor
 * lock, which serializes the race away.
 */
export async function ensureChannelRow(
  db: PrismaClient | Prisma.TransactionClient,
  args: {
    rootId: string;
    memoryId: string;
    loc: string;
    name: string;
    description?: string | null;
    createdBy: string | null;
    asDefaultOfAppId?: string | null;
    lastSeq?: number;
    /** Reusing a tombstoned address starts a new, empty Channel incarnation. */
    resetForReuse?: boolean;
  },
): Promise<ChannelRow> {
  let row = await db.channel.findUnique({ where: { chatRootNodeId: args.rootId } });
  if (!row) {
    try {
      row = await db.channel.create({
        data: {
          id: generateId(),
          memoryId: args.memoryId,
          loc: args.loc,
          name: args.name,
          kind: 'CHAT',
          description: args.description ?? null,
          chatRootNodeId: args.rootId,
          lastSeq: args.lastSeq ?? 0,
          createdBy: args.createdBy,
        },
      });
    } catch (e) {
      // A concurrent first post won the race — use its row.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      row = await db.channel.findUniqueOrThrow({ where: { chatRootNodeId: args.rootId } });
    }
    // #1430: stamp membership for any live chat-message children this Channel
    // adopted (pre-Channel rows under the messages prefix — the one-time
    // migration cannot cover Channels created after it). Centralized here so
    // both ensureChannelWithRoot and jobs/backfillChannels are covered.
    // The prefix is ESCAPED (Andi #3279): Prisma's startsWith compiles to
    // LIKE '…%', where an unescaped `_`/`%` in the Channel loc matches foreign
    // rows (`chats_team` would claim `chatsXteam:messages:*`).
    const prefix = `${args.loc}:messages:`;
    // Wake stamps are written only by the server when a message is posted into a Channel (#1748, N3). A row that
    // pre-dates the Channel was written some other way, so whatever stamps it carries were never decided by that
    // rule: they are cleared as the row is adopted, not trusted (Rook, #1751 P3-1).
    await db.$executeRaw(Prisma.sql`
      UPDATE nodes SET data = data - 'broadcastWakes' - 'managerPost'
      WHERE memory_id = ${args.memoryId} AND starts_with(loc, ${prefix}) AND node_type = 'chat-message'
        AND deleted_at IS NULL AND message_channel_id IS NULL
        AND jsonb_typeof(data) = 'object' AND (data ? 'broadcastWakes' OR data ? 'managerPost')`);
    await db.node.updateMany({
      where: {
        memoryId: args.memoryId,
        loc: { startsWith: escapePrismaLikePattern(prefix) },
        nodeType: 'chat-message',
        deletedAt: null,
        messageChannelId: null,
      },
      data: { messageChannelId: row.id },
    });
  } else if (row.deletedAt || args.resetForReuse) {
    // The root was restored. Its allocator counter stays on the root so the
    // next message never reuses an old seq, but the Channel watermark describes
    // the NEW incarnation: empty until a fresh message lands. Existing read
    // cursors may therefore stay where they are without producing phantom
    // attention now or hiding the next message (#1226).
    row = await db.channel.update({
      where: { id: row.id },
      data: {
        deletedAt: null,
        deletedBy: null,
        ...(args.resetForReuse
          ? { lastSeq: 0, lastMessageAt: null, incarnation: { increment: 1 } }
          : {}),
      },
    });
  }
  if (args.asDefaultOfAppId) {
    const set = await db.app.updateMany({
      where: { id: args.asDefaultOfAppId, defaultChannelId: null },
      data: { defaultChannelId: row.id },
    });
    // Spec 049 Phase 5 (D2): the moment an App gets its default Channel,
    // every live install gets its materialised register row.
    if (set.count > 0) await ensureInstallRegisterRows(db, args.asDefaultOfAppId, { createdBy: args.createdBy });
  }
  return row;
}

/**
 * Start a tombstoned Channel address as a clean incarnation (#1226).
 *
 * The root's `messageCount` is allocator history and survives, so a seq is
 * never reused. The old transcript and `lastMessageAt` are incarnation state
 * and do not survive. The descendant tombstone is one parameterized set write:
 * `starts_with` is literal (`_` / `%` are not wildcards) and keeps the filter
 * in Postgres instead of transferring every live loc to JavaScript.
 */
async function resetReusedChannel(
  tx: Prisma.TransactionClient,
  args: {
    memoryId: string;
    rootId: string;
    messagesLoc: string;
    deletedBy: string | null;
    memEncInfo: MemoryEncryptionInfo;
    vectorIndexEnabled: boolean;
  },
): Promise<void> {
  const now = new Date();
  const root = await tx.node.findUniqueOrThrow({
    where: { id: args.rootId },
    select: { abstract: true, content: true, data: true, embeddingPendingAt: true, embeddingWorkToken: true, nodeType: true, loc: true },
  });
  const encrypted = translateSessionExpired(args.memoryId, () => {
    const plain = decryptNodeFields(root, args.memEncInfo);
    const rootData = { ...((plain.data as Record<string, unknown> | null) ?? {}) };
    delete rootData.lastMessageAt;
    // Pre-#1196 team-chat roots stamped this retired audience marker. Reuse is
    // the canonical migration point: a new Channel derives access solely from
    // its host memory and must not inherit the legacy assertion.
    delete rootData.scope;
    return encryptNodeFields({ abstract: null, content: null, data: rootData }, args.memEncInfo);
  });

  await tx.node.update({
    where: { id: args.rootId },
    data: {
      abstract: encrypted.abstract ?? null,
      abstractOriginHash: null,
      content: encrypted.content ?? null,
      contentHash: null,
      data: (encrypted.data ?? null) as InputJsonValue,
      // On a vector-indexed host the fresh marker from restoreOrCreate must
      // survive this payload reset; an old worker may still be in flight.
      embeddingPendingAt: args.vectorIndexEnabled && !isRawChatNode(root) ? root.embeddingPendingAt : null,
      embeddingWorkToken: args.vectorIndexEnabled && !isRawChatNode(root) ? root.embeddingWorkToken : null,
      embeddingFailedAt: null,
      embeddingAttempts: 0,
      embeddingError: null,
      tokens: null,
      updatedBy: args.deletedBy,
    },
  });
  // A live root is eligible for vector search again. Old abstract/chunk rows
  // can retain the previous incarnation's plaintext in `chunk_text`, so they
  // must leave atomically with the payload reset.
  await tx.nodeEmbedding.deleteMany({ where: { nodeId: args.rootId } });
  // #1468 (Codex on #1475) — a node under `:messages:` is an ordinary node
  // until this reset tombstones it, and one can carry the spec marker in a
  // minted corpus (written before the Channel existed, or before the mint).
  // Lock and check the live descendants first; the tombstone below takes
  // only these rows, so nothing unchecked is removed.
  const doomed = (await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM nodes
    WHERE memory_id = ${args.memoryId}
      AND deleted_at IS NULL
      AND starts_with(loc, ${`${args.messagesLoc}:`})`).map((r) => r.id);
  await assertNoMintedSpecRemoval(tx, args.memoryId, doomed, 'reuse the Channel address over');
  // Reply edges are first-class rows with their own liveness. Tombstoning
  // only the endpoint nodes is insufficient: edge reads can still resolve
  // deleted endpoints by stable id and expose the old message payload.
  await tx.$executeRaw`
    UPDATE edges AS e
    SET deleted_at = ${now}, deleted_by = ${args.deletedBy}, updated_at = ${now}
    WHERE e.deleted_at IS NULL
      AND (
        e.source_id IN (
          SELECT id FROM nodes
          WHERE memory_id = ${args.memoryId}
            AND starts_with(loc, ${`${args.messagesLoc}:`})
        )
        OR e.target_id IN (
          SELECT id FROM nodes
          WHERE memory_id = ${args.memoryId}
            AND starts_with(loc, ${`${args.messagesLoc}:`})
        )
      )
  `;
  await tx.$executeRaw`
    UPDATE nodes
    SET deleted_at = ${now}, deleted_by = ${args.deletedBy}, updated_at = ${now}
    WHERE memory_id = ${args.memoryId}
      AND deleted_at IS NULL
      AND id = ANY(${doomed}::text[])
  `;
}

/**
 * A structural tombstone belongs to the previous Channel occupancy. Move it
 * and every incident edge out of the reusable address while preserving their
 * IDs and history on tombstones. This runs under the host memory's edge
 * endpoint key and the structural address lock. Every edge writer naming this
 * node needs that host key, including one whose source lives elsewhere.
 */
async function archiveChannelStructuralRow(
  tx: Prisma.TransactionClient,
  row: { id: string; loc: string; memoryId: string },
  deletedBy: string | null,
): Promise<void> {
  // Re-stamping a protected spec would make its permanent citation name a
  // blank successor. The old row is still a tombstone, but its address is
  // part of the minted contract (#1475); check before moving it (#1519).
  await assertNoMintedSpecRemoval(tx, row.memoryId, [row.id], 'reuse the Channel address over');
  // Re-stamp first: the row UPDATE waits for any earlier edge insert's FK
  // KEY SHARE lock. A fresh READ COMMITTED edge listing then includes it.
  await tx.node.update({
    where: { id: row.id },
    data: { loc: archivedTombstoneLoc(row.loc, row.id), embeddingPendingAt: null, embeddingWorkToken: null },
  });
  await tx.nodeEmbedding.deleteMany({ where: { nodeId: row.id } });
  // Derived include edges (#2040) are re-derivable from content, and the
  // governed-edge trigger refuses to soft-delete them: drop them outright.
  await tx.edge.deleteMany({ where: { governedKind: 'INCLUDE', OR: [{ sourceId: row.id }, { targetId: row.id }] } });
  const edges = await tx.edge.findMany({
    where: { OR: [{ sourceId: row.id }, { targetId: row.id }] },
    select: { id: true, loc: true, deletedAt: true },
  });
  const now = new Date();
  for (const edge of edges) {
    await tx.edge.update({
      where: { id: edge.id },
      data: {
        loc: archivedTombstoneLoc(edge.loc, edge.id),
        ...(edge.deletedAt ? {} : { deletedAt: now, deletedBy }),
      },
    });
  }
}

/**
 * Create a Channel WITH its chat root — parents, root, `:messages` child, the
 * row and the App default link — in one transaction under the ancestor lock.
 * A tombstoned root is restored; tombstoned ancestors and :messages rows are
 * archived and replaced so prior history cannot attach to the new Channel.
 *
 * Refuses a host memory that does not exist (`NOT_FOUND`), an address
 * overlapping another Channel's (`LOC_OVERLAPS_CHANNEL`), and a live occupant
 * that is not a chat root (`LOC_OCCUPIED`).
 *
 * It does NOT refuse a host by CLASS — that precondition is retired (#1196,
 * Holger's #1193 ruling); see the module header. Do not reinstate it on the
 * strength of an older caller comment.
 */
export async function ensureChannelWithRoot(
  db: PrismaClient,
  args: {
    memoryId: string;
    loc: string;
    name: string;
    description?: string | null;
    createdBy: string | null;
    asDefaultOfAppId?: string | null;
    /** For the root's `description`. */
    hostLabel?: string;
    /** Recheck an API caller's write grant after transfer serialization. */
    authorizeLockedHost?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
): Promise<{ channel: ChannelRow; rootId: string }> {
  const memory = await db.memory.findFirst({
    where: { id: args.memoryId, deletedAt: null },
    select: { id: true, class: true },
  });
  if (!memory) throw new GraphQLError('Host memory not found.', { extensions: { code: 'NOT_FOUND' } });
  const memEncInfo = await getMemoryEncryptionInfo(db, args.memoryId);
  // Storage keys top-level (D-2026-08-10-004). `data.scope` is GONE
  // (D-2026-08-10-005, #1196): it stamped `'shared'` to satisfy the
  // `shared ⇔ app` invariant, which a Channel in a `private` memory makes not
  // merely derivable but MEANINGLESS — it is neither of the marker's two
  // values. Nothing on the Channel path read it; `nodeSubtreeMove` did, and
  // now keys on `nodeType: 'chat'` instead (see its header).
  const rootFields = translateSessionExpired(args.memoryId, () =>
    encryptNodeFields(
      { content: null, data: { messageCount: 0, createdAt: new Date().toISOString() } },
      memEncInfo,
    ),
  );
  const messagesLoc = `${args.loc}:messages`;
  return db.$transaction(async (tx) => {
    // The Channel OWNS this address: it passes the gate every generic writer is
    // refused by. The lock set always includes `args.loc` itself (the
    // `:messages` child's parent), so a concurrent generic write of the root
    // and a concurrent Channel create on an overlapping address both queue
    // here and re-check after the grant.
    await lockMemoryForChannelChange(tx, args.memoryId);
    // Transfer takes FOR UPDATE on this row. FOR SHARE fences it through
    // Channel create/restore while allowing concurrent posts to take the FK's
    // KEY SHARE lock after their path lock (FOR UPDATE deadlocks with that path).
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${args.memoryId} FOR SHARE`;
    // Re-checked under that lock: the preflight above ran outside it.
    const live = await tx.memory.findFirst({
      where: { id: args.memoryId, deletedAt: null },
      select: { id: true, vectorIndexEnabled: true, class: true },
    });
    if (!live) throw new GraphQLError('Host memory not found.', { extensions: { code: 'NOT_FOUND' } });
    await args.authorizeLockedHost?.(tx);
    await lockAncestorsForCreateMany(tx, args.memoryId, [args.loc, messagesLoc], { owns: 'channel' });
    await assertNoChannelOverlap(tx, args.memoryId, args.loc);
    const indexNode = (nodeType: string, loc: string) => memoryIsVectorIndexed(live) && !isRawChatNode({ nodeType, loc });
    const restoreOrCreate = async (
      loc: string,
      create: () => Promise<{ id: string }>,
      accept: (row: { nodeType: string; deletedAt: Date | null }) => boolean = () => true,
      structural = false,
    ): Promise<string> => {
      const existing = await tx.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: args.memoryId } },
        select: { id: true, deletedAt: true, nodeType: true, embeddingPendingAt: true },
      });
      if (existing) {
        if (!accept(existing)) {
          throw new GraphQLError(
            `"${loc}" is occupied by a live ${existing.nodeType} node; a Channel adopts only a chat root. Move or delete it first.`,
            { extensions: { code: 'LOC_OCCUPIED', loc, nodeType: existing.nodeType } },
          );
        }
        if (existing.deletedAt) {
          if (structural) {
            await archiveChannelStructuralRow(tx, {
              id: existing.id, loc, memoryId: args.memoryId,
            }, args.createdBy);
            return (await create()).id;
          }
          // Channel creation may also revive tombstoned ancestor and
          // :messages nodes; their vectors belong to the old incarnation.
          await tx.nodeEmbedding.deleteMany({ where: { nodeId: existing.id } });
          await tx.node.update({
            where: { id: existing.id },
            data: {
              deletedAt: null, deletedBy: null,
              embeddingPendingAt: pendingAtForRevival(existing.embeddingPendingAt, indexNode(existing.nodeType, loc)),
              embeddingWorkToken: indexNode(existing.nodeType, loc) ? randomUUID() : null,
            },
          });
        }
        return existing.id;
      }
      return (await create()).id;
    };
    for (const parent of ancestorLocs(args.loc)) {
      await restoreOrCreate(parent, () =>
        tx.node.create({
          data: { id: generateId(), memoryId: args.memoryId, loc: parent, name: parent.split(':').pop()!, nodeType: 'record', createdBy: args.createdBy,
            embeddingPendingAt: indexNode('record', parent) ? new Date() : null,
            embeddingWorkToken: indexNode('record', parent) ? randomUUID() : null },
          select: { id: true },
        }),
        () => true,
        true,
      );
    }
    // #1226 — was the root a TOMBSTONE before this call? A resurrection means
    // the address is being REUSED, and everything under it is the previous
    // Channel's transcript.
    const priorRoot = await tx.node.findUnique({
      where: { loc_memoryId: { loc: args.loc, memoryId: args.memoryId } },
      select: { deletedAt: true },
    });
    const reusingDeadAddress = priorRoot?.deletedAt != null;
    const rootId = await restoreOrCreate(
      args.loc,
      () =>
        tx.node.create({
          data: {
            id: generateId(),
            memoryId: args.memoryId,
            loc: args.loc,
            name: args.name === DEFAULT_CHANNEL_NAME ? 'Team chat' : args.name,
            nodeType: 'chat',
            description: args.description ?? (args.hostLabel ? `Channel — ${args.hostLabel}` : null),
            data: (rootFields.data ?? null) as InputJsonValue,
            // Provenance, never a gate (cor:acl:030:01).
            createdBy: args.createdBy,
          },
          select: { id: true },
        }),
      // A chat root (live or tombstoned) is adopted; anything else live is a
      // collision — a tombstoned non-chat is restored AS the root only if it
      // was a chat, so it is refused too.
      (row) => row.nodeType === 'chat',
    );
    await restoreOrCreate(messagesLoc, () =>
      tx.node.create({
        data: { id: generateId(), memoryId: args.memoryId, loc: messagesLoc, name: 'messages', nodeType: 'record', createdBy: args.createdBy,
          embeddingPendingAt: indexNode('record', messagesLoc) ? new Date() : null,
            embeddingWorkToken: indexNode('record', messagesLoc) ? randomUUID() : null },
        select: { id: true },
      }),
      () => true,
      true,
    );
    // #1226 — a Channel created at a tombstoned address starts CLEAN.
    //
    // `@@unique([loc, memoryId])` carries no `deletedAt`, so the root tombstone
    // holds the loc and is restored in place. Resurrecting it lifts the transitive hide
    // that `cor:dmo:010:04` relies on ("removing a parent transitively hides
    // its children"), and the previous Channel's messages — never tombstoned
    // by `deleteChannel` — become visible again under a new Channel.
    //
    // @Jonas measured that: four messages read back after a delete (#1226).
    // The address is the ONLY thing the new Channel shares with the old one,
    // and re-creating at a known address is an ordinary thing to do, so the
    // inheritance is a confidentiality edge and not just a surprise.
    //
    // Tombstoning the old messages restores the hide the resurrection lifted.
    // This mirrors an App's `uninstalledAt` reinstall (same spec): the address
    // is vacated and reused, the prior record retained rather than adopted.
    //
    // The root's allocator history (`messageCount`) is deliberately retained,
    // while the Channel's current-transcript watermarks (`lastSeq` and
    // `lastMessageAt`) are reset. The empty incarnation therefore has no
    // phantom attention, but its first post receives seq N+1. Any read cursor
    // retained from the previous incarnation is below that fresh seq and
    // cannot hide the new message as already read.
    if (reusingDeadAddress) {
      await resetReusedChannel(tx, {
        memoryId: args.memoryId,
        rootId,
        messagesLoc,
        deletedBy: args.createdBy ?? null,
        memEncInfo,
        vectorIndexEnabled: memoryIsVectorIndexed(live),
      });
    }
    const channel = await ensureChannelRow(tx, { ...args, rootId, resetForReuse: reusingDeadAddress });
    return { channel, rootId };
  });
}

/**
 * The App's team-space memory — the app-class memory hosting `chats:team` —
 * for a Channel to be provisioned in. Uses the canonical team-space resolver
 * (`resolveAppTeamSpaceMemoryIds`): a bare `appId + class:'app'` would admit
 * a Worker's casting memory or a name-addressable App memory (Copilot on PR
 * #1165). Oldest wins when several qualify — the order `locateTeamChatRoot`
 * uses for the root itself.
 */
export async function resolveTeamSpaceMemoryForApp(db: PrismaClient, appId: string): Promise<string | null> {
  const ids = await resolveAppTeamSpaceMemoryIds(db, appId);
  return ids[0] ?? null;
}

/**
 * The App's default Channel, created EAGERLY at App creation (D-006: nothing
 * is unprotected before the first post) in the App's team-space memory —
 * the memory `provisionAppSharedMemory` makes for the founding Agent. Skips,
 * rather than fails, an App with no such memory yet (an Agent declaring
 * `appMemory: 'user' | 'none'`): the first post's bootstrap provisions both.
 */
export async function ensureDefaultChannelForApp(
  db: PrismaClient,
  app: { id: string; name: string },
  createdBy: string | null,
): Promise<ChannelRow | null> {
  const existing = await db.app.findUnique({ where: { id: app.id }, select: { defaultChannelId: true } });
  if (existing?.defaultChannelId) {
    return db.channel.findUnique({ where: { id: existing.defaultChannelId } });
  }
  const memoryId = await resolveTeamSpaceMemoryForApp(db, app.id);
  if (!memoryId) return null;
  const { channel } = await ensureChannelWithRoot(db, {
    memoryId,
    loc: 'chats:team',
    name: DEFAULT_CHANNEL_NAME,
    description: `Team chat — ${app.name}`,
    createdBy,
    asDefaultOfAppId: app.id,
    hostLabel: app.name,
  });
  return channel;
}
