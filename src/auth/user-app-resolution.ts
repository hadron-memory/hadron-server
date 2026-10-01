/**
 * App-identification regime helpers used at the MCP boundary.
 *
 * Spec 025-oauth-for-mcp FR-020 shipped the **single-App default**
 * (regime a): `resolveUserApps` + `resolveAppForRequest` below.
 *
 * Spec 026-app-identification-regimes adds **directory-aware** (regime b,
 * via MCP `initialize` capability parameter) and **session-scoped**
 * (regime c, via `hadron_set_active_app` MCP tool). Both depend on a richer
 * identifier resolver — `resolveAppIdentifier` below — that takes a
 * user-supplied string (URN or short form) and answers which App (if any)
 * the user means.
 *
 * **v1 dispatch behavior** (resolved at the MCP boundary in
 * `handleMcpRequest`, per spec 026 §FR-010 priority order):
 *   1. Session-scoped selection (regime c) — checked first.
 *   2. Directory-aware identity from `initialize` (regime b) — seeded into
 *      the same per-session map as regime c.
 *   3. `resolveAppForRequest` returns `'resolved'` for single-App users
 *      (regime a).
 *   4. `resolveAppForRequest` returns `'multi-app'` → session opens (the
 *      spec-025 HTTP 409 at session-init is gone per spec 026 FR-010 +
 *      R-N reversal). Per-strict-tool dispatch then surfaces either a
 *      typed `[no_active_app]` envelope (engaged session — has used
 *      `hadron_list_apps` / `hadron_set_active_app` / regime-b initialize-param)
 *      or a `[multiple_apps_resolved]` envelope (un-engaged session,
 *      FR-016 fall-through with the literal token preserved for SC-003
 *      log-grep). Advisory tools (`hadron_list_memories`, `hadron_find_nodes`,
 *      URN-input reads/writes) ignore the multi-app state and proceed
 *      with the cross-App union access per D-2026-05-21-003.
 *   5. `resolveAppForRequest` returns `'no-app'` → existing zero-App
 *      fall-through unchanged.
 *
 * All resolvers in this module are pure (DB reads only; no side effects);
 * HTTP-shaped errors and the in-memory selection map live in
 * `src/mcp/server.ts`.
 */

import type { PrismaClient } from '../generated/prisma/index.js';

/** Minimal App shape needed to populate the auth context downstream. */
export interface ResolvedUserApp {
  id: string;
  organizationId: string | null;
}

/**
 * Three-shape dispatch result for FR-020 at the MCP boundary.
 * Callers (e.g., `handleMcpRequest`) act on each kind:
 *  - `'resolved'`: populate `auth.appId` + `auth.organizationId`.
 *  - `'no-app'`: pass through; downstream tool calls handle the
 *    no-App state with their existing errors.
 *  - `'multi-app'`: session opens; the dispatch caches the resolution
 *    and `requireAppScope()` (called by strict-list tool bodies)
 *    surfaces the `[no_active_app]` / `[multiple_apps_resolved]`
 *    envelope per the engagement heuristic. Advisory tools ignore it.
 */
export type AppResolution =
  | { kind: 'resolved'; appId: string; organizationId: string | null }
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
 * Could this user select this App? The same admission `resolveUserApps` and
 * `hadron_set_active_app` apply: a live AppMember row on an App that is
 * neither soft-deleted nor uninstalled.
 *
 * #1503 uses it to evaluate an explicit reference to the user's own
 * App-scoped personal memory as that memory's App (`cor:acl:020:01`): the
 * substitution is admitted only when the user could have selected that App
 * themselves.
 */
export async function isAppSelectableBy(
  userId: string,
  appId: string,
  db: PrismaClient,
): Promise<boolean> {
  const member = await db.appMember.findFirst({
    where: { userId, appId, app: { is: { deletedAt: null, uninstalledAt: null } } },
    select: { appId: true },
  });
  return member !== null;
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

// ─── Spec 026: richer resolver for regime (b) / (c) ────────────────────

/** App row enriched with the fields the new regimes need (urn, name, role). */
export interface ResolvedUserAppWithMeta {
  id: string;
  urn: string;
  name: string;
  organizationId: string | null;
  role: string;
}

/**
 * Same active-Apps filter as `resolveUserApps`, but returns the richer
 * shape consumed by `hadron_list_apps`, `hadron_set_active_app`, and
 * `resolveAppIdentifier`. Kept as a sibling helper rather than extending
 * `resolveUserApps` so spec-025 callers (regime a dispatch) continue to
 * select only the minimal fields they need.
 */
export async function resolveUserAppsWithMeta(
  userId: string,
  db: PrismaClient,
): Promise<ResolvedUserAppWithMeta[]> {
  const memberships = await db.appMember.findMany({
    where: {
      userId,
      app: { is: { deletedAt: null, uninstalledAt: null } },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      role: true,
      app: {
        select: { id: true, urn: true, name: true, organizationId: true },
      },
    },
  });
  return memberships.map((m) => ({
    id: m.app.id,
    urn: m.app.urn,
    name: m.app.name,
    organizationId: m.app.organizationId,
    role: m.role,
  }));
}

/**
 * Spec 026 §Clarifications Q2 + research R-3 — short-form matcher rules.
 *
 * Accepts the App's canonical URN (bare or `urn:app:`-prefixed) OR a
 * display name. Matching:
 *   1. Trim + check for URN form (`urn:app:<bare>` or bare `<bare>`).
 *      Bare URNs are matched directly against `App.urn`. Prefixed URNs
 *      have the `urn:app:` stripped first.
 *   2. If the trimmed input doesn't look like a URN, treat it as a short
 *      form and case-insensitively compare against `App.name` of each
 *      accessible App.
 *
 * Returns a discriminated union covering every failure mode the new
 * tools and the dispatch surface:
 *   - `'resolved'`: exactly one match; App is active and the caller is a
 *     member.
 *   - `'ambiguous'`: short form matched 2+ accessible Apps. The caller
 *     receives the URN candidates to disambiguate.
 *   - `'unavailable'`: the matched App was soft-deleted (`'deleted'`) or
 *     soft-uninstalled (`'uninstalled'`). For the URN path this means
 *     the lookup found a row in `apps` but it failed the lifecycle
 *     filter; for the short-form path this can only fire if the user
 *     names an App they once had access to that has since been removed
 *     (in practice this collapses to `'not-found'`).
 *   - `'not-member'`: the matched App exists and is active but the
 *     caller has no active `AppMember` row. URN path only.
 *   - `'not-found'`: no match.
 *
 * **No side effects**: pure DB-read. Caller (the MCP tool body) maps
 * the resolution to a typed-error envelope.
 */
export type AppIdentifierResolution =
  | { kind: 'resolved'; app: ResolvedUserAppWithMeta }
  | {
      kind: 'ambiguous';
      candidates: Array<{ id: string; urn: string; name: string }>;
    }
  | { kind: 'unavailable'; reason: 'deleted' | 'uninstalled' }
  | { kind: 'not-member' }
  | { kind: 'not-found' };

// Canonical `hrn:app:` plus the legacy `urn:app:` scheme, accepted forever
// (issue #239).
const URN_APP_PREFIXES = ['hrn:app:', 'urn:app:'];

function isUrnForm(input: string): boolean {
  // Bare URN form for an App: `<org>:<slug>` (colon-separated, no spaces,
  // at least one colon). Display names can contain spaces and rarely
  // colons. Heuristic: contains ':' AND no whitespace → URN form.
  // Prefixed URN form: `hrn:app:<bare>` / `urn:app:<bare>` — matched first.
  if (URN_APP_PREFIXES.some((p) => input.startsWith(p))) return true;
  return input.includes(':') && !/\s/.test(input);
}

function stripUrnPrefix(input: string): string {
  const prefix = URN_APP_PREFIXES.find((p) => input.startsWith(p));
  return prefix ? input.slice(prefix.length) : input;
}

export async function resolveAppIdentifier(
  input: string,
  userId: string,
  db: PrismaClient,
): Promise<AppIdentifierResolution> {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) {
    return { kind: 'not-found' };
  }

  // URN-form path: look up by `App.urn` directly. This sidesteps the
  // user's accessible-Apps list so we can distinguish "the URN names a
  // real App you're not a member of" from "the URN names nothing".
  //
  // **Spec 021 partial-uniqueness**: `App.urn` is unique only across
  // active rows (`apps_urn_active_uniq WHERE uninstalled_at IS NULL`,
  // declared in the 021 migration; see `prisma/schema.prisma` line
  // ~1583 for the schema-side comment). A re-installed App produces an
  // active row + 1+ uninstalled history rows sharing the same URN.
  // `findFirst({ where: { urn: bare } })` could non-deterministically
  // return any of them, misclassifying an active App as
  // `unavailable.uninstalled`. Two-step lookup matches PR #124's
  // pattern: prefer the active row; fall back to history rows only to
  // distinguish 'not-found' from 'unavailable'.
  if (isUrnForm(trimmed)) {
    const bare = stripUrnPrefix(trimmed);

    const active = await db.app.findFirst({
      where: { urn: bare, uninstalledAt: null, deletedAt: null },
      select: { id: true, urn: true, name: true, organizationId: true },
    });
    if (active) {
      const member = await db.appMember.findUnique({
        where: { appId_userId: { appId: active.id, userId } },
        select: { role: true },
      });
      if (!member) return { kind: 'not-member' };
      return {
        kind: 'resolved',
        app: {
          id: active.id,
          urn: active.urn,
          name: active.name,
          organizationId: active.organizationId,
          role: member.role,
        },
      };
    }

    // No active row → check history rows to distinguish 'not-found'
    // from 'unavailable' (deleted vs. uninstalled). Prefer the most
    // recent row to surface the latest lifecycle event.
    const history = await db.app.findFirst({
      where: { urn: bare },
      orderBy: { createdAt: 'desc' },
      select: { deletedAt: true, uninstalledAt: true },
    });
    if (!history) return { kind: 'not-found' };
    if (history.deletedAt) return { kind: 'unavailable', reason: 'deleted' };
    if (history.uninstalledAt) return { kind: 'unavailable', reason: 'uninstalled' };

    // Defensive: a row exists with neither deletedAt nor uninstalledAt,
    // yet didn't match the active-row query above. Shouldn't happen.
    return { kind: 'not-found' };
  }

  // Short-form path: case-insensitive trim match against the caller's
  // accessible Apps' display names. Ambiguity returns the URN candidates
  // so the caller can disambiguate without re-running discovery.
  const accessible = await resolveUserAppsWithMeta(userId, db);
  const needle = trimmed.toLowerCase();
  const matches = accessible.filter((a) => a.name.toLowerCase() === needle);

  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length === 1) return { kind: 'resolved', app: matches[0] };
  return {
    kind: 'ambiguous',
    candidates: matches.map((m) => ({ id: m.id, urn: m.urn, name: m.name })),
  };
}
