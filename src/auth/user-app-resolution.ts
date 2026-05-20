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
 * Returns the set of Hadron Apps the given user has access to via
 * AppMember rows. Order is by `createdAt` ascending (deterministic
 * but not load-bearing — the caller cares about cardinality).
 *
 * Returns an empty array for users who exist but have no AppMember
 * rows (e.g., brand-new users, users whose AppMember rows were all
 * removed).
 */
export async function resolveUserApps(
  userId: string,
  db: PrismaClient,
): Promise<ResolvedUserApp[]> {
  const memberships = await db.appMember.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: {
      app: {
        select: { id: true, organizationId: true },
      },
    },
  });
  return memberships.map((m) => m.app);
}
