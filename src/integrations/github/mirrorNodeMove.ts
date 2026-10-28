/**
 * Move-aware git mirror (#1095).
 *
 * A move is the one node write that changes a node's ADDRESS, and an address is
 * a file path in the mirror. Every other write path reshapes one file in place;
 * a move has to remove files at the locs the nodes LEFT and write them at the
 * locs they now hold — possibly in a DIFFERENT repository.
 *
 * Until this existed, `moveNodeSubtree` simply REFUSED any cross-memory move
 * touching a git-backed memory, because the alternative was a silent
 * divergence: the source repo keeps a file for a node that has left the memory,
 * so the next repo-wins sync re-mints it as a duplicate; and the destination
 * repo never learns the node arrived. This module closes both halves, which is
 * what let that refusal go.
 *
 * It also covers the SAME-memory move, which was never refused and had the same
 * defect in miniature: a rename left the old path in the repo, and the next
 * sync — id-first and move-aware since #576 — dutifully moved the node back.
 *
 * **Fire-and-forget, like every mirror.** Nothing here throws: the DB move has
 * already committed, and a repository that is unreachable, uncloned, or
 * rejecting pushes must not retroactively fail it. Callers do not await a
 * result they can act on.
 *
 * Running after the commit is what makes the two rules below load-bearing, since
 * the world can change underneath this (PR #1098 review):
 *   - REMOVALS ARE DRIVEN BY `moved`, captured inside the transaction — never by
 *     the post-move DB read. A node that moved AGAIN before this ran drops out of
 *     that read, and keying removal off it would strand the file forever.
 *   - REMOVALS ARE GATED ON NODE IDENTITY. The vacated loc may already hold a
 *     DIFFERENT node's mirrored file; `removeNodeFile` deletes a path only when
 *     its frontmatter names the moved node, so the mirror can never erase a
 *     live node it does not own.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { deserializeTags } from '../db/provider.js';
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { logEncryptedGitSyncRefusal } from './encryptedGitSync.js';
import type { MirrorObligationRef } from './mirrorObligations.js';
import { removeNodeFile, writeNodeFile, nodePayloadHasCiphertext, type NodeForGit } from './writeNodeToGit.js';

/** One relocated node: its stable id and the loc it occupied before the move. */
export interface MovedNodeRef {
  id: string;
  previousLoc: string;
}

/**
 * Mirror a completed move into the affected repositories.
 *
 * Cross-memory: up to two commits, one per side — the destination gains the
 * nodes' files at their new locs, the source loses them at their old ones.
 * Same-memory: ONE commit that does both.
 *
 * `moved` must list EVERY relocated node (the named node and its rebased
 * descendants), each with the loc it left; that is exactly what
 * `moveNodeSubtree` returns. Nodes are re-read from the DB at their post-move
 * address rather than passed in as content — the same posture as the
 * `node.written` subscriber, so a duplicate call just mirrors the same latest
 * state.
 *
 * ENCRYPTED memories take no part in either direction (R206, cor:sec:040:05):
 * not as the destination of a write, and not as the source of a path-only
 * removal. Each refusal is logged as ENCRYPTED_GIT_SYNC_UNAVAILABLE; the move
 * itself stands.
 */
export async function mirrorNodeMoveToGit(
  db: PrismaClient,
  opts: {
    srcMemoryId: string;
    destMemoryId: string;
    moved: MovedNodeRef[];
    clientId?: string | null;
  },
): Promise<void> {
  // Callers fire this with `void` — an escaping rejection would be an unhandled
  // one, and `withMirrorCheckout` is not the only thing here that can throw (the
  // memory/node reads below can, on a DB blip). Enforce the never-throws
  // contract at the boundary rather than trusting every line inside it.
  try {
    await mirrorMove(db, opts);
  } catch (err) {
    console.error('[mirrorNodeMove] Mirroring the move failed (the move itself stands):', err);
  }
}

async function mirrorMove(
  db: PrismaClient,
  opts: {
    srcMemoryId: string;
    destMemoryId: string;
    moved: MovedNodeRef[];
    clientId?: string | null;
  },
): Promise<void> {
  const { srcMemoryId, destMemoryId, moved, clientId } = opts;
  if (moved.length === 0) return;
  const crossMemory = srcMemoryId !== destMemoryId;

  const [srcMem, destMem] = await Promise.all([
    db.memory.findUnique({
      where: { id: srcMemoryId },
      select: { urn: true, source: true, isEncrypted: true },
    }),
    crossMemory
      ? db.memory.findUnique({
          where: { id: destMemoryId },
          select: { urn: true, source: true, isEncrypted: true },
        })
      : null,
  ]);
  const destination = crossMemory ? destMem : srcMem;

  // `source != null` records which repo a memory BELONGS to, not that a mirror
  // is currently running — withMirrorCheckout still skips (loudly) when the
  // clone is absent. Bail early only when neither side claims a repo at all.
  // R206: an encrypted memory takes no part in Git sync in either direction —
  // not as the destination of a write, and not as the source of a path-only
  // removal. Each refusal is an observable typed skip.
  const writesToRepo = destination?.source != null && !destination.isEncrypted;
  const removesFromRepo = srcMem?.source != null && !srcMem.isEncrypted;
  if (destination?.source != null && destination.isEncrypted) logEncryptedGitSyncRefusal('[mirrorNodeMove] write', destMemoryId);
  if (srcMem?.source != null && srcMem.isEncrypted) logEncryptedGitSyncRefusal('[mirrorNodeMove] removal', srcMemoryId);
  if (!writesToRepo && !removesFromRepo) return;

  const label = moved.length === 1
    ? `node ${moved[0].previousLoc}`
    : `${moved.length} nodes under ${moved[0].previousLoc}`;

  if (writesToRepo) {
    await withMirrorCheckout(
      {
        memoryId: destMemoryId,
        clientId,
        commitSubject: crossMemory
          ? `Move in ${label} from ${srcMem?.urn ?? 'another memory'}`
          : `Move ${label}`,
        logPrefix: '[mirrorNodeMove]',
        // #430: the destination owes each moved node's file at its new loc, and (same memory) the removal of every old loc,
        // one REMOVE row per (node, old loc) so a node moved twice while a push keeps failing owes both vacated paths.
        obligations: [
          ...moved.map((m): MirrorObligationRef => ({ nodeId: m.id, kind: 'WRITE' })),
          ...(crossMemory ? [] : removals(moved)),
        ],
      },
      async ({ localPath, memoryUrn }) => {
        // Re-read only after the checkout lock is held. A later Node/Edge
        // write or another move may have committed while this job waited;
        // carrying a pre-lock row would write its old path/content last.
        const currentMemory = await db.memory.findUnique({
          where: { id: destMemoryId }, select: { isEncrypted: true },
        });
        if (!currentMemory || currentMemory.isEncrypted) return false;
        const rows = await db.node.findMany({
          where: { id: { in: moved.map((m) => m.id) }, deletedAt: null },
          include: { outgoingEdges: { include: { target: true } } },
        });
        const live = rows.filter((r) => r.memoryId === destMemoryId);
        // The flag can change while rows load. Apply the shared payload belt
        // to the whole batch before removing ANY old paths (#1273).
        if (live.some(nodePayloadHasCiphertext)) {
          console.warn(`[git-mirror] Deferring move into memory ${destMemoryId}: ciphertext payload`);
          return false;
        }
        // Same-memory: the old paths live in THIS repo, so remove them in the
        // same commit.
        //
        // Driven by `moved` — captured INSIDE the transaction — and never by the
        // post-move DB read: a node that moved AGAIN before this ran (or moved
        // out to another memory entirely) drops out of `live`, and keying the
        // removal off `live` would strand its old file forever, to be re-minted
        // by the next repo-wins sync (PR #1098 review, Copilot).
        //
        // Remove BEFORE writing — a subtree rebase can send one moved node onto
        // another moved node's old loc (moving `a:b` up to `a` puts grandchild
        // `a:b:b` on the vacated `a:b`), and removing after writing would delete
        // the file just written.
        if (!crossMemory) {
          for (const m of moved) removeNodeFile(localPath, m.previousLoc, m.id, memoryUrn);
        }
        for (const row of live) writeNodeFile(localPath, toNodeForGit(row), memoryUrn);
      },
    );
  }

  if (crossMemory && removesFromRepo) {
    await withMirrorCheckout(
      {
        memoryId: srcMemoryId,
        clientId,
        commitSubject: `Move out ${label} to ${destination?.urn ?? 'another memory'}`,
        logPrefix: '[mirrorNodeMove]',
        // #430: the source repository still owes the removal of each old path.
        obligations: removals(moved),
      },
      ({ localPath, memoryUrn }) => {
        for (const m of moved) removeNodeFile(localPath, m.previousLoc, m.id, memoryUrn);
      },
    );
  }
}

/** The REMOVE obligations of a move. A root has no loc to vacate (removeNodeFile refuses it), so it owes nothing. */
function removals(moved: readonly MovedNodeRef[]): MirrorObligationRef[] {
  return moved.filter((m) => m.previousLoc !== '').map((m) => ({ nodeId: m.id, kind: 'REMOVE', removeLoc: m.previousLoc }));
}

/** Project a loaded node row onto the mirror's write payload. */
function toNodeForGit(
  row: {
    id: string; loc: string; name: string; nodeType: string | null; objectType: string | null;
    alias: string | null; description: string | null; abstract: string | null;
    abstractOriginHash: string | null; contentHash: string | null; content: string | null;
    tags: string[] | string; seq: number | null; data: unknown; properties: unknown;
    role?: string | null; isRunnable?: boolean | null; isPlaceholder?: boolean;
    outgoingEdges?: NodeForGit['outgoingEdges'];
  },
): NodeForGit {
  return {
    id: row.id,
    loc: row.loc,
    name: row.name,
    nodeType: row.nodeType,
    objectType: row.objectType,
    alias: row.alias,
    description: row.description,
    abstract: row.abstract,
    abstractOriginHash: row.abstractOriginHash,
    contentHash: row.contentHash,
    content: row.content,
    tags: deserializeTags(row.tags) as string[],
    seq: row.seq,
    data: row.data,
    properties: row.properties,
    // #1218 — the mirror carries the governed signals so a memory rebuilt from
    // its repo is not rebuilt ungoverned.
    role: row.role ?? null,
    isRunnable: row.isRunnable ?? null,
    isPlaceholder: row.isPlaceholder ?? false,
    outgoingEdges: row.outgoingEdges ?? [],
  };
}
