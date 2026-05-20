/**
 * Spec 025-oauth-for-mcp FR-020 / research §R-6 — single-App default
 * App-identification regime.
 *
 * The MCP boundary must resolve "which Hadron App is active for this
 * request" for user-credential callers (callers whose auth context
 * has `userId` set but `appId` unset — i.e., a JWT or hdr_user_<…>
 * Bearer token). The other two regimes from D-2026-05-17-003
 * (directory-aware `.hadron/config.json`, session-scoped MCP tool)
 * are carved out to sibling spec `02X-app-identification-regimes`.
 *
 * **v1 behavior:**
 * - User has **exactly one** App → resolve to that App automatically.
 * - User has **two or more** Apps → the MCP handler returns HTTP 409
 *   with a typed `multiple_apps_resolved` error (per research §R-6).
 *   No silent default-picking is permitted; the sibling spec is
 *   where multi-App disambiguation regimes will be introduced.
 * - User has **zero** Apps → the handler proceeds without setting
 *   `appId`. Downstream tool calls that need an App will fail with
 *   App-specific errors (existing JWT-without-App behavior is
 *   preserved). Zero-App handling is intentionally not in FR-020's
 *   scope — most workflows are App-scoped, but a user without an
 *   App is a legitimate edge case while the platform is onboarding.
 *
 * This module's resolver is pure (DB read; no side effects beyond
 * the query) so it's testable in isolation; the HTTP-shaped error
 * lives in the MCP handler (`src/mcp/server.ts`) where it belongs.
 */

import type { PrismaClient } from '../generated/prisma/index.js';

/** Minimal App shape needed to populate the auth context downstream. */
export interface ResolvedUserApp {
  id: string;
  organizationId: string;
}

/**
 * Three-shape dispatch result for FR-020 at the MCP boundary.
 * Callers (e.g., `handleMcpRequest`) act on each kind:
 *  - `'resolved'`: populate `auth.appId` + `auth.organizationId`.
 *  - `'no-app'`: pass through; downstream tool calls handle the
 *    no-App state with their existing errors.
 *  - `'multi-app'`: emit HTTP 409 + `multiple_apps_resolved`.
 */
export type AppResolution =
  | { kind: 'resolved'; appId: string; organizationId: string }
  | { kind: 'no-app' }
  | { kind: 'multi-app' };

/**
 * Returns the **active** Hadron Apps the given user has access to via
 * AppMember rows. Order is by `createdAt` ascending (deterministic
 * but not load-bearing — the caller cares about cardinality).
 *
 * "Active" = neither soft-deleted (`app.deletedAt IS NULL`) nor
 * soft-uninstalled (`app.uninstalledAt IS NULL`, per spec 021 FR-025).
 * AppMember rows can persist past App lifecycle events; without the
 * filter, a user with one active App and one historical (deleted or
 * uninstalled) App would be 409'd by FR-020's multi-App dispatch
 * — a false positive.
 *
 * Returns an empty array for users who exist but have no active
 * AppMember rows.
 */
export async function resolveUserApps(
  userId: string,
  db: PrismaClient,
): Promise<ResolvedUserApp[]> {
  // TODO(post-Phase-1): consider per-userId caching with a short TTL
  // (e.g., 30s). Today this runs once per user-credential MCP request;
  // for the OAuth-Bearer hot path under Phase 2, a request-context
  // memoization or short-TTL cache would shed the per-request DB hop.
  // Revocation latency becomes the TTL, which is acceptable for
  // App-scope changes (rare). Tracked here so the next eyes know
  // it's been considered.
  const memberships = await db.appMember.findMany({
    where: {
      userId,
      app: { is: { deletedAt: null, uninstalledAt: null } },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      app: {
        select: { id: true, organizationId: true },
      },
    },
  });
  return memberships.map((m) => m.app);
}

/**
 * Wraps `resolveUserApps` in the FR-020 dispatch shape. Pure
 * (no side effects beyond the DB read) so the handler's dispatch
 * branches are testable in isolation — production code asserts on
 * the returned `AppResolution`, tests do the same.
 */
export async function resolveAppForRequest(
  userId: string,
  db: PrismaClient,
): Promise<AppResolution> {
  const apps = await resolveUserApps(userId, db);
  if (apps.length === 0) return { kind: 'no-app' };
  if (apps.length === 1) {
    return {
      kind: 'resolved',
      appId: apps[0].id,
      organizationId: apps[0].organizationId,
    };
  }
  return { kind: 'multi-app' };
}
