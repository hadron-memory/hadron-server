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
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { deserializeTags } from '../db/provider.js';
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { removeNodeFile, writeNodeFile, type NodeForGit } from './writeNodeToGit.js';

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
 * ENCRYPTED memories are punted on the WRITE side only: rendering a node's file
 * needs plaintext, and this runs after the request that held the session key.
 * The REMOVE side has no such need — deleting a stale path requires no
 * decryption — so a node leaving an encrypted git-backed memory still stops
 * being re-minted by the next sync.
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
  const writesToRepo = destination?.source != null && !destination.isEncrypted;
  const removesFromRepo = srcMem?.source != null;
  if (!writesToRepo && !removesFromRepo) return;

  const previousLocById = new Map(moved.map((m) => [m.id, m.previousLoc]));

  // Re-read at the POST-move address. A node deleted (or moved again) between
  // the commit and now is skipped rather than mirrored to a stale path.
  const rows = writesToRepo
    ? await db.node.findMany({
        where: { id: { in: moved.map((m) => m.id) }, deletedAt: null },
        include: { outgoingEdges: { include: { target: true } } },
      })
    : [];
  const live = rows.filter((r) => r.memoryId === destMemoryId);

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
      },
      ({ localPath }) => {
        // Same-memory: the old paths live in THIS repo, so remove them in the
        // same commit. Remove BEFORE writing — a subtree rebase can send one
        // moved node onto another moved node's old loc (moving `a:b` up to `a`
        // puts grandchild `a:b:b` on the vacated `a:b`), and removing after
        // writing would delete the file just written.
        if (!crossMemory) {
          for (const row of live) {
            const prev = previousLocById.get(row.id);
            if (prev != null && prev !== row.loc) removeNodeFile(localPath, prev);
          }
        }
        for (const row of live) writeNodeFile(localPath, toNodeForGit(row));
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
      },
      ({ localPath }) => {
        for (const m of moved) removeNodeFile(localPath, m.previousLoc);
      },
    );
  }
}

/** Project a loaded node row onto the mirror's write payload. */
function toNodeForGit(
  row: {
    id: string; loc: string; name: string; nodeType: string | null; objectType: string | null;
    alias: string | null; description: string | null; abstract: string | null;
    abstractOriginHash: string | null; contentHash: string | null; content: string | null;
    tags: string[] | string; seq: number | null; data: unknown; properties: unknown;
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
    outgoingEdges: row.outgoingEdges ?? [],
  };
}
