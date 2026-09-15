/**
 * #1012 — durable MCP selections (active App, active memory) for a client
 * instance, so they survive the reconnect that #1005 discovered wipes them.
 *
 * ## Why this exists
 *
 * `activeAppByMcpSession` and `activeMemoryUrn` live for exactly one MCP
 * TRANSPORT session. Clients re-initialize transparently after a server
 * restart, so both silently evaporate mid-conversation. #1009 made that loss
 * legible, and recoverable for callers holding a Hadron session id
 * (`adoptAppFromSession`). This module is the remedy for everyone the session
 * anchor does not reach — most importantly plain memory work, which has no
 * session at all and whose only prior remedy was "re-select after every
 * restart, forever".
 *
 * ## The key
 *
 * `(userId, clientKey)`, never the MCP session id — that id is precisely what
 * does not survive. `clientKey` is the CALLER'S OWN stable instance id, sent as
 * the `X-Hadron-Client-Id` header; the server treats it as opaque.
 *
 * Per-CLIENT, not per-user (Holger, 2026-08-16): one person may drive Claude
 * Desktop, Cursor and the CLI at once. A per-user row would let one of them
 * switch the others' active App mid-conversation — turning a LOST selection
 * into a SILENTLY WRONG one, which is a worse failure than the one being fixed.
 *
 * A client that sends no header is not persisted at all and keeps the pre-#1012
 * in-memory behaviour, so opting out costs nothing and nothing regresses for
 * clients that never opt in.
 *
 * ## Storage is not authorization
 *
 * A stored selection is a CACHE OF A CHOICE. It can outlive the membership that
 * justified it, so both pointers are re-authorized on every load — the App
 * through the SHARED `isAppParticipant` predicate (the #1007 review finding: a
 * bespoke member-row check drifts from the gate beside it), the memory through
 * the same read gate every other MCP read uses. A pointer that fails
 * re-authorization is dropped from the result and left alone in the row: the
 * caller simply has no selection, exactly as if they had never made one.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import type { Context } from '../api/graphql/schema/resolvers.js';
import { isAppParticipant } from '../api/graphql/schema/resolvers.helpers.js';
import { canReadMemory } from '../mcp/access-control.js';
import { getMemberOrgIds } from './auth/memberOrgIds.js';
import { canReadScope } from './scopes.js';

/** Header carrying the caller's stable client-instance id. */
export const CLIENT_KEY_HEADER = 'x-hadron-client-id';

/**
 * Longest accepted `clientKey`. Opaque to us, so the only real constraint is
 * that a caller cannot use it to write unbounded data.
 */
const MAX_CLIENT_KEY_LEN = 200;

/**
 * Normalize a caller-supplied client id, or `null` when it is unusable.
 *
 * Whitespace-only and over-long values are rejected rather than truncated: a
 * silently truncated key would collide two client instances onto one row, which
 * is the multi-client stomping this design exists to prevent.
 */
export function normalizeClientKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CLIENT_KEY_LEN) return null;
  return trimmed;
}

/** A re-authorized selection. Absent fields mean "nothing usable stored". */
export interface RestoredMcpSelection {
  appId?: string;
  /** The restored App's OWN organization (null for a user-owned App) — not a selection. */
  organizationId?: string | null;
  memoryUrn?: string;
  /**
   * Spec 049 Phase 1 — the EXPLICIT `hadron_set_active_org` selection, present
   * only while the caller is still a member of it. Distinct from
   * `organizationId` above, which is derived from the App and outranks this in
   * the ladder (`lib/auth/activeOrg.ts`).
   */
  activeOrgId?: string;
  /** Spec 049 Phase 3 — the `hadron_set_active_scope` selection, present only while the caller may still read it. */
  activeScopeId?: string;
}

/**
 * Load and RE-AUTHORIZE this client's stored selections.
 *
 * Never throws on a storage or authorization problem: a selection is a
 * convenience, and failing a session's boot over one would be a worse outcome
 * than starting without it.
 */
export async function loadMcpSessionState(
  db: PrismaClient,
  auth: AuthContext,
  clientKey: string | null,
): Promise<RestoredMcpSelection> {
  if (!clientKey || !auth.userId) return {};

  try {
    const row = await db.mcpSessionState.findUnique({
      where: { userId_clientKey: { userId: auth.userId, clientKey } },
      select: {
        app: {
          select: {
            id: true,
            organizationId: true,
            ownerUserId: true,
            deletedAt: true,
            uninstalledAt: true,
          },
        },
        memory: { select: { id: true, urn: true, deletedAt: true } },
        organization: { select: { id: true, deletedAt: true } },
        scope: true,
      },
    });
    if (!row) return {};

    const restored: RestoredMcpSelection = {};

    // ── The active scope: lifecycle, then the scope READ gate ───────────────
    if (row.scope && !row.scope.deletedAt) {
      const ctx = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      } as Context;
      if (await canReadScope(ctx, row.scope)) restored.activeScopeId = row.scope.id;
    }

    // ── The explicit organization: lifecycle, then CURRENT membership ───────
    // The same shared helper the org-scoped queries gate on (`getMemberOrgIds`),
    // so a stored selection can never outlive the membership that justified it.
    const org = row.organization;
    if (org && !org.deletedAt) {
      const memberOrgIds = await getMemberOrgIds(db, auth.userId, auth.impersonation?.orgId);
      if (memberOrgIds.includes(org.id)) restored.activeOrgId = org.id;
    }

    // ── The App: lifecycle, then the SHARED participation gate ──────────────
    const app = row.app;
    if (app && !app.deletedAt && !app.uninstalledAt) {
      const ctx = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      } as Context;
      if (await isAppParticipant(ctx, app)) {
        restored.appId = app.id;
        restored.organizationId = app.organizationId;
      }
    }

    // ── The memory: the ordinary read gate ──────────────────────────────────
    // Checked against the caller as they are NOW, and deliberately AFTER the
    // App is restored above, since canReadMemory consults App-derived access:
    // restoring the App first is what lets an app-scoped memory selection
    // survive alongside it.
    const memory = row.memory;
    if (memory && !memory.deletedAt) {
      const authForRead: AuthContext = restored.appId
        ? { ...auth, appId: restored.appId, organizationId: restored.organizationId ?? undefined }
        : auth;
      if (await canReadMemory(db, authForRead, memory.id)) {
        restored.memoryUrn = memory.urn;
      }
    }

    return restored;
  } catch {
    // A restore is best-effort by construction — see the doc comment.
    return {};
  }
}

/**
 * Persist this client's active-App selection. No-op without a `clientKey`
 * (the client did not opt in) or a user principal.
 *
 * Best-effort: the in-memory selection has already been applied by the caller,
 * so a storage failure must not fail the tool call the user actually made. It
 * degrades to pre-#1012 behaviour — the selection holds for this connection and
 * is simply not restored after the next reconnect.
 */
export async function saveActiveApp(
  db: PrismaClient,
  auth: AuthContext,
  clientKey: string | null,
  appId: string,
): Promise<void> {
  await upsertSelection(db, auth, clientKey, { appId });
}

/** Persist this client's active-memory selection. Same contract as {@link saveActiveApp}. */
export async function saveActiveMemory(
  db: PrismaClient,
  auth: AuthContext,
  clientKey: string | null,
  memoryId: string,
): Promise<void> {
  await upsertSelection(db, auth, clientKey, { memoryId });
}

/**
 * Persist — or with `null`, CLEAR — this client's explicit active-organization
 * selection (spec 049 Phase 1). Same contract as {@link saveActiveApp}.
 */
export async function saveActiveOrg(
  db: PrismaClient,
  auth: AuthContext,
  clientKey: string | null,
  organizationId: string | null,
): Promise<void> {
  await upsertSelection(db, auth, clientKey, { organizationId });
}

/** Persist — or with `null`, CLEAR — this client's active-scope selection (spec 049 Phase 3). */
export async function saveActiveScope(
  db: PrismaClient,
  auth: AuthContext,
  clientKey: string | null,
  scopeId: string | null,
): Promise<void> {
  await upsertSelection(db, auth, clientKey, { scopeId });
}

/** Shared upsert for the selections — one row per (user, client instance). */
async function upsertSelection(
  db: PrismaClient,
  auth: AuthContext,
  clientKey: string | null,
  patch: { appId?: string; memoryId?: string; organizationId?: string | null; scopeId?: string | null },
): Promise<void> {
  if (!clientKey || !auth.userId) return;
  try {
    await db.mcpSessionState.upsert({
      where: { userId_clientKey: { userId: auth.userId, clientKey } },
      create: { userId: auth.userId, clientKey, ...patch },
      update: patch,
    });
  } catch {
    // See the doc comment: never fail the caller's actual operation.
  }
}
