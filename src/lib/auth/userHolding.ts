import type { Prisma } from '../../generated/prisma/index.js';
import { isRunPrincipal } from './runPrincipal.js';

/**
 * A per-user chat "holding" (cor:cht:010:02, ruling 0226 and Holger's 2026-11-27 decision "User only", which supersedes ruling 0232 Q1;
 * Q2 and 0232's exclusions stand): a memory kept for one user's chat with an Agent
 * (`userMemoryOfAgentId` set), readable by the user it serves and by nobody else, whatever the reader's organisation
 * membership or global role. Once personal, private, system and app records are set aside (each has its own audience), the
 * classes that can carry the marker are knowledge and group.
 *
 * Shapes: every path that sets the marker makes a personal/private row (its own audience), an app-class anonymous row, or the
 * startChat no-App knowledge row (App null). Only the last is a holding in this sense. A group-class or App-attached knowledge row
 * carrying the marker is created by no shipped path; the creator arms (the node-access set, the MCP `readsOwnNoAppHolding`) are
 * knowledge-only, so such a row fails closed for everybody. If one is ever created, widening those arms is a decision for that change.
 *
 * One DENY rule for every surface: the record gate (`canReadMemoryRecord`), the platform-admin "see all" filters
 * (`foreignIdentityScopedMemoryFilter`), the MCP point and batch gates (`canReadMemoryRow`) and the write gates ask the predicates
 * below, so no role shortcut admits a non-creator. The creator ALLOW side is not one copy: the record gate uses
 * `userHoldingCreatorMayRead`; the node-access set (`getAccessibleMemoryIds`, knowledge holdings, no run principal; impersonation
 * returns earlier) and MCP `readsOwnNoAppHolding` (no App, no bound worker session) are narrower arms. Each is at most as wide
 * as the record gate, so nothing leaks; a creator of a shape the arms do not cover fails closed.
 */
export const USER_HOLDING_CLASSES = ['knowledge', 'group'] as const;

/** Is this row a per-user chat holding? A pure function of the row. */
export function isUserHolding(row: { class: string; userMemoryOfAgentId: string | null }): boolean {
  return row.userMemoryOfAgentId != null && (USER_HOLDING_CLASSES as readonly string[]).includes(row.class);
}

/**
 * May this principal read a holding as its creator? The creator is the user the row names in `createdBy` (never an App or
 * client id; `clientId` here is only what `isRunPrincipal` reads). An impersonated session, an App key (no user) and a run principal never read by virtue of this rule, even when
 * they carry the creator's user id.
 */
export function userHoldingCreatorMayRead(
  auth: { userId?: string | null; impersonation?: unknown; clientId?: string | null },
  row: { createdBy: string | null },
): boolean {
  return !!auth.userId && !auth.impersonation && !isRunPrincipal(auth) && row.createdBy === auth.userId;
}

/**
 * Is this row a holding that somebody OTHER than `viewerUserId` created (one with no recorded creator included)? The platform
 * ADMIN/OWNER shortcuts of the WRITE doors stop here: they read as well as write (an update echoes the node, a dry-run
 * replace lists it), so a global role reaches a holding through none of them. Restrict-only: the creator's own path is unchanged.
 */
export function isForeignUserHolding(
  row: { class: string; userMemoryOfAgentId: string | null; createdBy: string | null },
  viewerUserId: string | null | undefined,
): boolean {
  return isUserHolding(row) && (!viewerUserId || row.createdBy !== viewerUserId);
}

/**
 * The DB form of the same rule, for the platform-admin "see all" sets: a holding whose creator is anybody but the viewer
 * (a holding with no recorded creator included, which fails closed). Use below `NOT`, with the other foreign-identity clauses.
 */
export function foreignUserHoldingFilter(viewerUserId: string | null | undefined): Prisma.MemoryWhereInput {
  // '__none__' is safe only because ids are generated, never typed: it matches no creator, so every holding is foreign. Do not
  // "simplify" it into `{ not: null }`, which would miss a holding with no recorded creator.
  const viewer = viewerUserId ?? '__none__';
  return {
    class: { in: [...USER_HOLDING_CLASSES] },
    userMemoryOfAgentId: { not: null },
    OR: [{ createdBy: null }, { createdBy: { not: viewer } }],
  };
}
