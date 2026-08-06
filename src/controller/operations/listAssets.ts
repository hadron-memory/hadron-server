/**
 * listAssets — the uniform cross-memory asset list (#891).
 *
 * `memoryAssets(memoryId:)` answers "files in THIS memory". This answers
 * "every file I can reach", which is what a top-level Assets section
 * needs: its tabs are all cross-memory (my uploads / everything readable
 * / this org's), so they are FILTERS over one list rather than three
 * queries. Shape follows `conventions:uniform-read-surface` (spec
 * `cor:api:120`): `{ items, total }`, `clampListTake`, `resolveOrgScope`.
 *
 * **The gate is the holding memory's, per asset.** An Asset is bound to a
 * Memory (cor:dmo:060:10), so the scope is exactly "assets in memories I
 * can read" — which is `getAccessibleMemoryIds`, the SHARED predicate,
 * not a hand-rolled one. `findings:query-memory-ignores-public-visibility`
 * is what happens when a per-resolver gate drifts from it.
 *
 * Scoping is on the **`Asset.memoryId` column**, never a `memory { … }`
 * relation join — the same trap as `UsageEvent.nodeId` in #796/#799.
 * Staged assets (`memoryId` NULL) therefore never appear, which is right:
 * they are not in a memory yet, so no memory's gate can admit them.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import {
  clampListTake,
  resolveOrgScope,
  getAccessibleMemoryIds,
  type Context,
} from '../../api/graphql/schema/resolvers.helpers.js';
import { resolveMemoryRef } from '../../lib/entityRef/memoryRef.js';
import { UrnNotQualifiedError } from '../../lib/entityRef/errors.js';
import { logAssetEvent } from '../../lib/asset/audit.js';

export interface AssetFilterInput {
  /** Narrow to these memories. Empty list = the empty scope, never "all". */
  memoryRefs?: string[] | null;
  /** Only the caller's own uploads. A filter, never the gate. */
  mine?: boolean | null;
  mimeType?: string | null;
  scanStatus?: 'PENDING' | 'CLEAN' | 'BLOCKED' | null;
  includeDeleted?: boolean | null;
}

export interface ListAssetsInput {
  filter?: AssetFilterInput | null;
  orgId?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export interface AssetsPage {
  items: Asset[];
  total: number;
}

const EMPTY: AssetsPage = { items: [], total: 0 };

export async function listAssets(ctx: Context, input: ListAssetsInput): Promise<AssetsPage> {
  const db = ctx.db as PrismaClient;
  const f = input.filter ?? {};
  const take = clampListTake(input.limit);
  const skip = Math.max(0, input.offset ?? 0);

  // cor:api:100:01 — optional single-org narrowing. A failed gate
  // (unresolvable ref OR non-member) returns the EMPTY page, never an
  // error: no org-existence disclosure, no platform-admin bypass.
  // #876 / cor:acl:100:03 — assets are identity-scoped and invisible to an
  // impersonated session. The GraphQL resolver also throws Forbidden (a
  // louder signal at the API edge); this is the backstop, because THIS
  // function is the reusable unit and carries the identity predicate
  // (`uploadedBy: ctx.userId`) while living outside the directory
  // resolvers.impersonationSweep.test.ts scans. A future caller — an MCP
  // tool, a CLI surface — would otherwise reach it unguarded.
  if (ctx.impersonation) return EMPTY;

  const scope = await resolveOrgScope(ctx, input.orgId);
  if (!scope) return EMPTY;

  // `mine` is "uploaded by ME", so a caller with no user identity (an App
  // key) has no answer to give. Empty page rather than every asset —
  // silently ignoring the filter would widen the result, which is the
  // wrong direction to fail.
  if (f.mine && !ctx.userId) return EMPTY;

  // The shared read gate. null = unrestricted (platform admin without an
  // owner-only carve-out); otherwise the explicit accessible set.
  const accessible = await getAccessibleMemoryIds(ctx);

  // Org narrowing has to be expressed as a memory-id set too, because the
  // scope is per-ASSET via its memory. Only applied when an orgId was
  // actually requested — without one, the accessible set already IS the
  // caller's reach and must not be narrowed to org-owned memories (that
  // would drop user-owned and shared ones).
  let allowed: string[] | null = accessible;
  if (scope.scopedOrgId) {
    const orgMemories = await db.memory.findMany({
      where: {
        organizationId: scope.scopedOrgId,
        deletedAt: null,
        ...(accessible === null ? {} : { id: { in: accessible } }),
      },
      select: { id: true },
    });
    allowed = orgMemories.map((m) => m.id);
  }

  // filter.memoryRefs — `conventions:multi-ref-scope-args`: unreadable and
  // unknown refs are silently DROPPED (keeping the anti-enumeration
  // posture), a MALFORMED ref still throws, and an explicitly EMPTY list
  // is the empty scope rather than a fallback to the default scope.
  // Dedupe on the RESOLVED id, not the ref string.
  if (f.memoryRefs) {
    if (f.memoryRefs.length === 0) return EMPTY;
    const resolved = new Set<string>();
    for (const ref of f.memoryRefs) {
      let id: string;
      try {
        ({ id } = await resolveMemoryRef(db, ref));
      } catch (err) {
        // A malformed/relative URN is a caller bug — fail loudly. A ref
        // that merely doesn't resolve to anything the caller may see is
        // dropped, exactly like an unreadable one.
        if (err instanceof UrnNotQualifiedError) throw err;
        continue;
      }
      if (allowed === null || allowed.includes(id)) resolved.add(id);
    }
    if (resolved.size === 0) return EMPTY;
    allowed = [...resolved];
  }

  const where: Record<string, unknown> = {
    // Scope on the COLUMN. `allowed === null` (unrestricted admin) still
    // requires a non-null memoryId so staged assets stay out.
    ...(allowed === null ? { memoryId: { not: null } } : { memoryId: { in: allowed } }),
    ...(f.includeDeleted ? {} : { deletedAt: null }),
    ...(f.mine ? { uploadedBy: ctx.userId } : {}),
    ...(f.mimeType ? { mimeType: f.mimeType } : {}),
    ...(f.scanStatus ? { scanStatus: f.scanStatus } : {}),
  };

  // Newest-first, not the convention's name-asc default: recency is the
  // useful order for files, and it matches `memoryAssets`. `id` breaks
  // ties so paging is stable.
  const [total, items] = await Promise.all([
    db.asset.count({ where }),
    take === 0
      ? Promise.resolve([] as Asset[])
      : db.asset.findMany({
          where,
          orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
          skip,
          take,
        }),
  ]);

  logAssetEvent({
    operation: 'listed',
    userId: ctx.userId ?? null,
    appId: ctx.appId ?? null,
    count: items.length,
    reason: 'assets() cross-memory list',
  });

  return { items, total };
}
