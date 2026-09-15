/**
 * Spec 049 Phase 1 — the active-organization ladder (D-2026-09-13-003).
 *
 * The portal has forced an active organization since spec 014 (URL › last
 * active › first membership). The CLI and MCP had no way to set one, and a
 * `Session` carries an App but no org — so the org-scoped view `cor:api:100`
 * defines was portal-only. This is the ONE resolution used by every non-portal
 * surface, so the CLI (through GraphQL) and MCP cannot drift.
 *
 * The ladder, strongest first:
 *
 *   1. an organization NAMED IN THE CALL — membership-gated, no admin bypass
 *      (`cor:api:100:01`); a non-member naming an org is refused, never widened;
 *   2. the ACTIVE APP's organization, only when the App is org-owned AND the
 *      caller is a member of that org. A personal (user-owned, spec 047) App has
 *      no organization at all — Holger's correction in the design session. An
 *      AppMember of an org-owned App need not be an OrgMember, and the existing
 *      org narrowing in `findNodes` / `globalSearch` requires membership, so a
 *      non-member FALLS THROUGH to the next rung rather than being widened to
 *      the whole org (Copilot on PR #1154);
 *   3. the EXPLICITLY SELECTED organization (`hadron_set_active_org`, the CLI's
 *      `hadron org use`), re-authorized here rather than trusted from storage;
 *   4. the caller's SINGLE membership;
 *   5. and the two ends of the membership count. ZERO memberships resolve to
 *      the user-owned view — spec 048 made org-less users ordinary, and their
 *      `cor:api:100` view is simply their own memories, so refusing them would
 *      block search for everyone without an org. TWO OR MORE with nothing
 *      selected is the refusal, carrying the member list so the next call can
 *      name one. (The zero case is a partial reversal of the decision's step 5,
 *      confirmed on PR #1154.)
 *
 * Selecting an org activates the `cor:api:100` org view; it is NOT a named
 * scope and there is no "org default scope" — organization and scope are two
 * composed levels (the org picks the tenancy, the scope picks the view).
 *
 * Read-only and App-key-blind like `getMemberOrgIds`: an App key's org is its
 * credential (`cor:api:100`), so callers short-circuit before reaching here.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { getMemberOrgIds } from './memberOrgIds.js';

/** Which rung of the ladder produced the organization. */
export type ActiveOrgSource = 'named' | 'app' | 'selection' | 'single-membership';

export type ActiveOrgResolution =
  /** An organization the caller is a member of, and how it was chosen. */
  | { kind: 'org'; organizationId: string; source: ActiveOrgSource }
  /** No memberships at all: the caller's own user-owned memories are the view. */
  | { kind: 'user-owned' }
  /**
   * Nothing chose an org and the caller belongs to several — or a named org the
   * caller is not a member of. `memberOrgIds` is the list to choose from.
   */
  | { kind: 'required'; reason: 'ambiguous' | 'named_not_member'; memberOrgIds: string[] };

export interface ResolveActiveOrgArgs {
  userId: string;
  /** Rung 1 — an org id the caller named (already resolved from its ref). */
  namedOrgId?: string | null;
  /** Rung 2 — the active App, if any; its org is read here, not trusted from the caller. */
  activeAppId?: string | null;
  /** Rung 3 — the stored explicit selection, if any. */
  selectedOrgId?: string | null;
  /** Admin impersonation collapses membership to the one shared org (see getMemberOrgIds). */
  restrictToOrgId?: string;
}

/**
 * Resolve the caller's active organization by the ladder in the module header.
 *
 * Every rung is checked against the caller's CURRENT memberships — a named
 * org, an App's org and a stored selection are all inputs the caller controls
 * or that can outlive the membership that justified them, so none is trusted.
 */
export async function resolveActiveOrg(
  db: PrismaClient,
  args: ResolveActiveOrgArgs,
): Promise<ActiveOrgResolution> {
  const memberOrgIds = await getMemberOrgIds(db, args.userId, args.restrictToOrgId);
  const isMember = (orgId: string): boolean => memberOrgIds.includes(orgId);

  // 1. Named in the call — a refusal here is final: the caller asked for an org
  //    they cannot see into, and falling through would silently answer a
  //    different question than the one asked.
  if (args.namedOrgId) {
    return isMember(args.namedOrgId)
      ? { kind: 'org', organizationId: args.namedOrgId, source: 'named' }
      : { kind: 'required', reason: 'named_not_member', memberOrgIds };
  }

  // 2. The active App's organization — org-owned Apps only, members only.
  if (args.activeAppId) {
    const app = await db.app.findFirst({
      where: { id: args.activeAppId, deletedAt: null },
      select: { organizationId: true },
    });
    if (app?.organizationId && isMember(app.organizationId)) {
      return { kind: 'org', organizationId: app.organizationId, source: 'app' };
    }
  }

  // 3. The explicit selection — re-authorized, never trusted from storage.
  if (args.selectedOrgId && isMember(args.selectedOrgId)) {
    return { kind: 'org', organizationId: args.selectedOrgId, source: 'selection' };
  }

  // 4 / 5. The membership count decides.
  if (memberOrgIds.length === 1) {
    return { kind: 'org', organizationId: memberOrgIds[0], source: 'single-membership' };
  }
  if (memberOrgIds.length === 0) {
    return { kind: 'user-owned' };
  }
  return { kind: 'required', reason: 'ambiguous', memberOrgIds };
}
