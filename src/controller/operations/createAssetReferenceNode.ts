/**
 * createAssetReferenceNode — attach an existing Asset to the graph by
 * creating a `reference` node that points at it.
 *
 * This is the user-driven counterpart to what `hadron_store_file`
 * already does for headless runs: every stored file gets a reference
 * node so it is discoverable and citable in the graph. The node's
 * `data.asset` shape is deliberately IDENTICAL to the one storeTools
 * writes (`{ id, urn, filename, mimeType, sizeBytes }`) — one shape,
 * so every reader (portal, CLI, search) handles both origins.
 *
 * **Why a reference node rather than a schema link.** cor:dmo:060:10
 * binds an Asset to a Memory and explicitly RESERVES the schema-level
 * Asset→Node cross-reference (`Asset.attachedNodeId` / a join table).
 * Holger's call (2026-08-06) is to stay on the convention: no
 * migration, no spec supersession, and the reference node is a real
 * node — it gets edges, search, revisions and the git mirror for free.
 *
 * The tradeoff the convention buys us is the absence of an FK, so a
 * deleted asset leaves a dangling `data.asset.id`. Readers must treat
 * the pointer as soft: `Node.asset` resolves it and returns null when
 * the asset is gone, rather than assuming it is live.
 *
 * **Authorization is two-sided** and both sides are required, because
 * the source and target memory need not be the same one: the caller
 * must be able to READ the asset's holding memory and to WRITE the
 * memory the reference node lands in. Checking only the write side
 * would let a caller copy a file handle out of a memory they cannot
 * read into one they can.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { canReadMemory, canWriteToMemory } from '../../mcp/access-control.js';
import { resolveMemoryRef } from '../../lib/entityRef/memoryRef.js';
import { writeNodeCore } from '../../api/graphql/schema/resolvers.mutation.node.js';
import { splitNodeUrn } from '../../lib/urn.js';
import { splitWholeNodeUrn } from '../../lib/splitNodeUrnTolerant.js';
import { emitAssetUrnV2 } from '../../lib/urnEmit.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContextV2 } from './beginAssetUpload.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

export interface CreateAssetReferenceNodeInput {
  /**
   * Asset id, or its URN (`hrn:asset:<root>:<mem...>:assets:<asset.id>`, plus
   * the two degraded shapes `Asset.urn` can emit — see its SDL docstring).
   * Parsed by {@link assetIdFromRef}, which only needs the `assets` marker.
   */
  assetRef: string;
  /**
   * Fully-qualified node URN (`hrn:node:<root>:<memory>:<loc>`) for the
   * reference node. Its memory is where the node lands — which need
   * not be the asset's own memory.
   */
  nodeUrn: string;
  /** Node name. Defaults to the asset's filename. */
  name?: string;
  /** Node description. Defaults to the asset's own description. */
  description?: string;
}

/**
 * Extract an asset id from an id or a `…:assets:<id>` URN. Anything
 * without the `assets` marker is treated as a raw id — the caller's
 * lookup fails loudly if it is neither.
 *
 * Takes the atom immediately AFTER the marker rather than the last atom
 * of the ref. For a canonical `…:assets:<id>` the two coincide, but
 * keying on the marker means a ref with anything trailing resolves the
 * id or nothing — never some unrelated trailing atom that would look up
 * the wrong asset (PR #888 review, Copilot).
 */
export function assetIdFromRef(ref: string): string {
  const atoms = ref.split(':');
  const marker = atoms.lastIndexOf('assets');
  if (marker >= 0 && marker < atoms.length - 1) {
    return atoms[marker + 1]!;
  }
  return ref;
}

export async function createAssetReferenceNode(
  db: PrismaClient,
  caller: AssetCallerContextV2,
  ctx: Context,
  input: CreateAssetReferenceNodeInput,
) {
  // ── 1. Resolve the asset and gate on its memory's READ access ──
  const asset = await db.asset.findUnique({
    where: { id: assetIdFromRef(input.assetRef) },
  });
  if (!asset || asset.deletedAt) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
  }
  if (!asset.memoryId) {
    throw new AssetUploadError(
      'NOT_FOUND',
      'asset is staged (not attached to a memory)',
    );
  }

  const callerAuth = {
    userId: caller.userId,
    appId: caller.appId,
    roles: caller.roles,
    organizationId: caller.organizationId,
  };

  // Unreadable reports NOT_FOUND, matching mintAssetDownloadUrl — a
  // distinct "exists but forbidden" answer is an existence oracle over
  // asset ids.
  if (!(await canReadMemory(db, callerAuth, asset.memoryId))) {
    throw new AssetUploadError('NOT_FOUND', 'asset not found');
  }

  // ── 2. Gate on the TARGET memory's WRITE access ──
  const { memoryUrn, loc } = splitWholeNodeUrn(input.nodeUrn);
  let targetMemoryId: string;
  try {
    ({ id: targetMemoryId } = await resolveMemoryRef(db, memoryUrn));
  } catch {
    throw new AssetUploadError('NOT_FOUND', 'target memory not found');
  }
  if (!(await canWriteToMemory(db, callerAuth, targetMemoryId))) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      `memory not writable for "${input.nodeUrn}"`,
    );
  }

  // ── 3. Write the reference node ──
  // #697 Stage 2: emit the flat v2 asset URN (matching the GraphQL
  // Asset.urn read surface); fall back to the bare form when the
  // stored memory urn can't compose, as storeTools does.
  const assetMemory = await db.memory.findUniqueOrThrow({
    where: { id: asset.memoryId },
    select: { urn: true },
  });
  let assetUrn: string;
  try {
    assetUrn = emitAssetUrnV2(assetMemory.urn, asset.id);
  } catch {
    assetUrn = `${assetMemory.urn}:assets:${asset.id}`;
  }

  const node = await writeNodeCore(
    {
      memoryId: targetMemoryId,
      loc,
      name: input.name ?? asset.filename,
      nodeType: 'reference',
      description: input.description ?? asset.description ?? undefined,
      content:
        `Stored file **${asset.filename}** ` +
        `(${asset.mimeType}, ${asset.sizeBytes} bytes).\n\n` +
        `Asset URN: \`${assetUrn}\``,
      data: {
        asset: {
          id: asset.id,
          urn: assetUrn,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
        },
      },
      reason: `asset reference (${assetUrn})`,
    } as never,
    ctx,
    'create',
  );

  logAssetEvent({
    operation: 'referenced',
    assetId: asset.id,
    memoryId: targetMemoryId,
    userId: caller.userId,
    appId: caller.appId ?? null,
    reason: `reference node ${input.nodeUrn}`,
  });

  return node;
}
