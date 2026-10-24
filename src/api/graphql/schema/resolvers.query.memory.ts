// memoryQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { GraphQLError } from 'graphql';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import {
  getUsageActivity,
  isValidTimeZone,
  resolveWindow,
  MAX_MEMORY_SCOPE_REFS,
  type UsageActivityBucketSize,
} from '../../../lib/usageActivity.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { deserializeTags } from '../../../integrations/db/provider.js';
import {
  type Context,
  requireRole,
  clampListTake,
  granteeShareAccess,
  canReadMemoryRecord,
  getAccessibleMemoryIds,
  resolveOrgScope,
  resolveReadableMemoryId,
  resolveNodeReadableMemoryRef,
  MEMORY_INCLUDE,
} from './resolvers.helpers.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import { validateMemoryNodes } from '../../../lib/memoryValidation.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { activeAgentInstallLicenseIds, isGrantedAgentMemoryRole } from '../../../lib/appAgent.js';
import { findInstallMemory, resolveInstallTarget } from './installMemory.js';
import { listableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { AgentNotFoundError, AppNotFoundError } from '../../../lib/entityRef/errors.js';

/** Compose a node URN, tolerating a memory urn the flat v2 shape can't express. */
function safeCanonicalNodeUrn(memoryUrn: string, loc: string): string | null {
  try {
    return emitNodeUrnV2(memoryUrn, loc);
  } catch {
    return null;
  }
}

// Graph-view fetch (issue #466): default page size + hard cap for the slim
// memoryNodes / memoryEdges lists. Large enough to fill the graph in a few
// round trips, capped so a single page stays bounded.
export const GRAPH_PAGE_DEFAULT = 20;
const GRAPH_PAGE_MAX = 2000;

/**
 * Clamp a graph page size: omitted → the default; otherwise the caller's value
 * clamped to [0, MAX]. `limit: 0` is preserved (not bumped to 1) so a caller can
 * fetch only `total` — the cheap "how big is this memory?" node/edge count — or
 * suppress the payload during init, the standard limit-0 pattern.
 */
export function clampGraphTake(limit?: number | null): number {
  if (limit == null) return GRAPH_PAGE_DEFAULT;
  return Math.min(GRAPH_PAGE_MAX, Math.max(0, limit));
}

export const memoryQueries = {
    /**
     * #796 — read/write activity counts bucketed by time. #805 widened the
     * memory scope from one memory to a union of several.
     *
     * Two scopes. Default (no `memoryRefs`): the caller's OWN events across
     * everything they touched — needs only an authenticated user, since a user
     * reading their own activity discloses nothing. With `memoryRefs`: every
     * user's events attributed to ANY of those memories, each ref gated on
     * MEMORY READ ACCESS — the same gate `memoryUsageSummary` and
     * `usageEvents(memoryId:)` use, so the three memory-scoped usage surfaces
     * stay in parity. That reveals other users' activity VOLUMES to any reader
     * of the memory — a deliberate call (Holger, #796), and strictly less than
     * the per-node counts `memoryUsageSummary` already exposes to the same
     * audience.
     *
     * Denied and nonexistent are indistinguishable — a ref the caller can't
     * read is silently DROPPED from the union rather than failing the query
     * (#805), which keeps the anti-enumeration posture: a list of 3 refs
     * answers identically whether the third is foreign, deleted, or a PK that
     * never existed. Consequence worth knowing at the call site: the result
     * doesn't say WHICH refs contributed. A malformed ref still throws — a
     * shape error discloses nothing about what exists.
     *
     * Passing `memoryRefs` at all selects the memory scope, so an explicitly
     * EMPTY list is the empty union (`[]`), never a silent fallback to own
     * activity — that would mislabel one user's data as the memories'.
     */
    usageActivity: async (
      _: unknown,
      {
        from,
        to,
        bucket,
        memoryRefs,
        timeZone,
      }: {
        from?: string | null;
        to?: string | null;
        bucket?: UsageActivityBucketSize | null;
        memoryRefs?: string[] | null;
        timeZone?: string | null;
      },
      ctx: Context,
    ) => {
      const tz = timeZone ?? 'UTC';
      if (!isValidTimeZone(tz)) {
        throw new GraphQLError(`Unknown IANA time zone: ${tz}`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const window = resolveWindow(from, to);
      if (!window) {
        throw new GraphQLError(
          'Invalid window: `from` and `to` must be ISO-8601 timestamps with from < to.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }

      const scope = { ...window, bucket: bucket ?? 'DAY', timeZone: tz } as const;

      if (memoryRefs) {
        // Loud on the QUERY path: an over-long list is caller error, and the
        // gate below is one resolve + one access check per ref. The widget
        // provider truncates instead — its list is untrusted config JSON.
        if (memoryRefs.length > MAX_MEMORY_SCOPE_REFS) {
          throw new GraphQLError(
            `Too many memoryRefs (max ${MAX_MEMORY_SCOPE_REFS}).`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        // Two dedupes, doing different jobs. The first drops byte-identical
        // repeats so they aren't resolved twice (cheap, not load-bearing). The
        // second is the one that matters: PK and URN forms of the SAME memory
        // are distinct strings, so both survive the first and both resolve —
        // only deduping the RESOLVED ids keeps that memory out of the `IN` list
        // twice (PR #808 review, Copilot).
        const resolved = await Promise.all(
          [...new Set(memoryRefs)].map((ref) => resolveReadableMemoryId(ctx, ref)),
        );
        const memoryIds = [...new Set(resolved.filter((id): id is string => id !== null))];
        if (memoryIds.length === 0) return [];
        return getUsageActivity(ctx.db, { ...scope, memoryIds });
      }

      // Own-activity scope. An App-key caller has no userId, so there is no
      // "own activity" to report — empty, not an error (as dashboardWidgets).
      // #876 class sweep: this fallback aggregates the target's activity
      // across ALL memories and orgs, so it is identity-scoped too. (The
      // memory-scoped branch above is gated by resolveReadableMemoryId and
      // stays available.)
      if (!ctx.userId || ctx.impersonation) return [];
      return getUsageActivity(ctx.db, { ...scope, userId: ctx.userId });
    },

    /**
     * #819 — the memory health audit, previously MCP-only. Runs the SAME
     * checks as `hadron_validate` via the shared `validateMemoryNodes`, so the
     * two surfaces cannot drift on what "healthy" means.
     *
     * Typed findings rather than the tool's prose: a caller has to be able to
     * branch, and `hadron memory validate` has to be able to gate CI on a
     * count.
     *
     * Findings are CAPPED (default 200, max 1000) because a large memory can
     * produce thousands, but `totalFindings` always reports the true count —
     * so a gate is never fooled by truncation, and `truncated` says plainly
     * that there is more.
     */
    validateMemory: async (
      _: unknown,
      { memoryRef, limit }: { memoryRef: string; limit?: number | null },
      ctx: Context,
    ) => {
      // #859 review (Codex P1): the NODE-CONTENT gate, not the record-level
      // one. This query returns node ids, locs, counts and operational error
      // details — node-level data. `canReadMemoryRecord` keeps an org-member
      // fast path that admits app/system-class memories which
      // getAccessibleMemoryIds deliberately excludes from node access, so
      // gating on it would let an ordinary org member enumerate App-internal
      // nodes. (This is the SAME record-vs-node-content distinction as #846,
      // and the opposite answer: there the payload was Memory scalars, here it
      // is node data.) Denied ≡ not-found — and since #1316 the SAME
      // not-found: the old `NOT_FOUND` here differed from the missing
      // branch's `MEMORY_NOT_FOUND`, which kept the oracle open.
      const { id: memoryId } = await resolveNodeReadableMemoryRef(ctx, memoryRef);
      const memory = await ctx.db.memory.findFirst({
        where: { id: memoryId, deletedAt: null },
        select: { id: true, urn: true },
      });
      // resolveMemoryRef already excludes deleted rows; this only guards the
      // read-then-read race, answering it as the missing branch does.
      if (!memory) throw new MemoryNotFoundError(memoryRef);

      const cap = Math.min(Math.max(limit ?? 200, 0), 1000);
      // The cap is pushed DOWN so findings past it are counted but never
      // retained — building the whole array to slice it defeats the bound
      // (#859 review, Copilot).
      const report = await validateMemoryNodes(ctx.db, memory.id, cap);
      const findings = report.findings.map((f) => ({
        kind: f.kind,
        nodeId: f.nodeId,
        nodeLoc: f.nodeLoc,
        nodeUrn: safeCanonicalNodeUrn(memory.urn, f.nodeLoc),
        detail: f.detail,
      }));
      return {
        memoryId: memory.id,
        nodesChecked: report.nodesChecked,
        findings,
        totalFindings: report.totalFindings,
        truncated: report.totalFindings > findings.length,
        skippedChecks: report.skippedChecks,
        // A skipped check makes `ok` false even with zero findings — you
        // cannot claim health for a check you did not run.
        ok: report.totalFindings === 0 && report.skippedChecks.length === 0,
      };
    },

    memoryUsageSummary: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      // 007-entity-id-or-urn: memoryRef may be ID, bare URN, or prefixed URN.
      // Access control (#250, extended from usageEvents): the node-content
      // gate (getAccessibleMemoryIds — principals + the spec-034 class rules).
      // Previously this resolver had no gate at all — any authenticated caller
      // could read any tenant's per-node usage counts. #1316: a denied memory
      // used to answer `[]` while a missing one threw MEMORY_NOT_FOUND, so the
      // `[]` itself disclosed existence; both now throw the same error.
      const { id: resolvedMemoryId } = await resolveNodeReadableMemoryRef(ctx, memoryRef);

      // #796: scope on the `memoryId` COLUMN. This was #253's UsageEvent→Node
      // relation join, which kept the FK precision the older `nodeLoc: { in: locs }`
      // scoping lacked (a node named `alpha` in another memory no longer inflates
      // this memory's counts) but paid for it with silent data loss: `nodeId` is
      // SetNull, so deleting a node erased its whole read/write history from the
      // memory. The column is FK-precise AND survives node deletion, so counts
      // can only go UP relative to the join — never down. Events written before
      // the backfill whose node was already gone stay unattributable.
      //
      // `nodeLoc: { not: null }` still guards the schema: the result feeds
      // UsageSummaryEntry.nodeLoc (String!), and an event can carry a memoryId
      // with a null nodeLoc.
      const rows = await ctx.db.usageEvent.groupBy({
        by: ['nodeLoc', 'type'],
        where: { memoryId: resolvedMemoryId, nodeLoc: { not: null } },
        _count: { id: true },
      });
      return rows.map((r: { nodeLoc: string | null; type: string; _count: { id: number } }) => ({
        // nodeLoc is non-null here (guarded in the where above); Prisma's
        // groupBy result type still widens it to string | null.
        nodeLoc: r.nodeLoc as string,
        type: r.type,
        count: r._count.id,
      }));
    },

    // #2044 (cor:agt:040:06): the App's install memory for an Agent. Creates nothing; a
    // customisation that does not exist and one the record gate does not open are the same null.
    installMemory: async (_: unknown, args: { appRef: string; agentRef: string }, ctx: Context) => {
      let target: { appId: string; agentId: string };
      try {
        target = await resolveInstallTarget(ctx.db, { appRef: args.appRef, agentRef: args.agentRef });
      } catch (e) {
        if (e instanceof AppNotFoundError || e instanceof AgentNotFoundError) return null;
        throw e;
      }
      const row = await findInstallMemory(ctx.db, target.appId, target.agentId);
      if (!row) return null;
      const memory = await ctx.db.memory.findUnique({ where: { id: row.id }, include: MEMORY_INCLUDE });
      if (!memory || memory.deletedAt) return null;
      return (await canReadMemoryRecord(ctx, memory)) ? memory : null;
    },

    memory: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      // 007-entity-id-or-urn: ref may be an ID or a URN. A raw ID needs no
      // resolution (skip the extra lookup); a URN is resolved to its id. Only a
      // genuine miss (MemoryNotFoundError) collapses to null — malformed URNs
      // and unexpected DB/runtime errors propagate rather than masking as a
      // misleading not-found (mirrors the effectiveAccess resolver).
      let resolvedId = ref;
      if (!isId(ref)) {
        try {
          ({ id: resolvedId } = await resolveMemoryRef(ctx.db, ref));
        } catch (e) {
          if (!(e instanceof MemoryNotFoundError)) throw e;
          return null;
        }
      }
      const memory = await ctx.db.memory.findUnique({
        where: { id: resolvedId },
        include: MEMORY_INCLUDE,
      });
      if (!memory || memory.deletedAt) return null;
      // The record-level read gate, shared with Agent.memoryItems (#759) so the
      // two cannot drift — see `canReadMemoryRecord` for the full ordering
      // rationale (personal/private share carve-out #778, spec-047 user-owned
      // strictness ahead of the admin path #676, and the #362 fallback that
      // keeps record reads in step with node reads).
      // #1316: unreadable and missing are the same bare-null response. Memory
      // URNs are guessable, so an error only on the existing branch is a
      // cross-tenant name oracle. Malformed refs and DB faults still propagate
      // normally; only the shared record gate's ordinary denial is concealed.
      if (!(await canReadMemoryRecord(ctx, memory))) return null;
      return memory;
    },

    // #473 — the uniform paginated memory list. Replaces myMemories (the
    // caller's union), publicMemories (filter.visibility: PUBLIC), and
    // orgSystemMemories (orgId + filter.memoryClasses: [system]).
    memories: async (
      _: unknown,
      {
        filter,
        orgId,
        limit,
        offset,
      }: {
        filter?: {
          memoryClasses?: string[] | null;
          visibility?: string | null;
          sharedWithMe?: boolean | null;
          ownedByMe?: boolean | null;
        } | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const empty = { items: [], total: 0 };
      const f = filter ?? {};
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);

      // Class filter (mirrors findNodes NodeFilter.memoryClasses): when given,
      // restrict to exactly the listed classes; when omitted, hide the noisy
      // agent `system` class by default (the portal's list page relies on it).
      const classSet =
        f.memoryClasses && f.memoryClasses.length > 0 ? new Set(f.memoryClasses) : null;
      const classFilter = classSet
        ? { class: { in: [...classSet] as any } }
        : { class: { not: 'system' as const } };

      const page = async (where: Record<string, unknown>) => {
        const [total, items] = await Promise.all([
          ctx.db.memory.count({ where }),
          take === 0
            ? Promise.resolve([])
            : ctx.db.memory.findMany({
                where,
                include: MEMORY_INCLUDE,
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                skip,
                take,
              }),
        ]);
        return { items, total };
      };

      // #1179 — filter.ownedByMe: the caller's OWN user-owned (org-less)
      // memories, `organizationId IS NULL AND ownerUserId = ctx.userId`. The
      // memory twin of agents(filter.ownedByMe) / apps(filter.ownedByMe) (#782),
      // and deliberately the SAME predicate as those two so the three read
      // identically (cor:api:120:03 — slices are filters, and an owner slice
      // constrains even a platform admin rather than bypassing anything).
      //
      // Keyed on `ownerUserId`, the spec-047 user TENANT owner — NOT on
      // `userId` (the personal/private strict owner) and NOT on `class`.
      // `class IN (personal, private)` was only ever a PROXY for ownership,
      // correct while every user-owned memory was personal (#1176): a
      // `knowledge`-class memory under a user root is user-owned today, so a
      // class-keyed filter would omit exactly the rows this issue was reported
      // for. The columns are two independent axes (`chk_memory_owner_xor` for
      // this one, `chk_personal_visibility_user` for the other).
      //
      // Ahead of `resolveOrgScope` because the slice is org-less by definition,
      // so `orgId` is not consulted — matching the sibling filters, which skip
      // the scope resolution entirely. A foreign orgId therefore neither empties
      // this slice nor discloses anything: every row it returns is the caller's
      // own and belongs to no org.
      if (f.ownedByMe) {
        // App-key callers have no user context, and user-owned memories are
        // identity-scoped, so an impersonated support session sees none of the
        // target's (#876 — the same drop `getAccessibleMemoryIds` and the
        // sibling filters make).
        if (!ctx.userId || ctx.impersonation) return empty;
        // A user-owned memory is never in the marketplace slice (#758 pins
        // `ownerUserId: null` there), so this combination is empty by
        // construction rather than by a silent predicate collision — the same
        // reasoning that kept `ownedByMe` off PublicAgentFilter (#782).
        if (f.visibility === 'PUBLIC') return empty;
        return page({
          deletedAt: null,
          // LOAD-BEARING, and it was not in the first version of this branch.
          // While the slice keyed on `ownerUserId` alone this was redundant
          // under `chk_memory_owner_xor` (owner set implies org NULL) and said
          // so. The strict-owner arm below keys on `userId`, which an ORG-owned
          // personal memory also carries — so this clause is now the only thing
          // keeping such a row out of an "org-less" slice. Pinned by "excludes
          // an ORG-owned personal memory the caller is the strict owner of".
          organizationId: null,
          // "Owned" means what the RECORD GATE means by it, per class — not one
          // column (@codex, PR #1215). `canReadMemoryRecord` branches first on
          // personal/private and admits `userId` there, falling through to
          // `ownerUserId` for every other class; the two columns are
          // independent, so a slice keyed on `ownerUserId` alone would hand the
          // tenant owner a personal memory whose strict owner is someone else.
          //
          // Codex asked for the non-personal restriction ALONE here, which would
          // have been the other half of the same mistake: the portal's "My
          // memories" is mostly personal rows, so an owner slice without the
          // strict-owner arm would have emptied the page this filter exists to
          // fill. Both arms, split exactly where the read gate splits.
          //
          // In the aligned case — `ownerUserId === userId`, the only shape in
          // production (15 of 15) — the two arms are indistinguishable from the
          // single-column form.
          OR: [
            { class: { in: ['personal', 'private'] as any }, userId: ctx.userId },
            { class: { notIn: ['personal', 'private'] as any }, ownerUserId: ctx.userId },
          ],
          // Per-user agent holdings stay out of the regular memory list
          // (cor:api:120:03), so the owner slice excludes them too — a filter
          // that surfaced rows the default list hides would WIDEN rather than
          // narrow. No live row is both today (measured: 0 of 24 user-owned
          // rows carry `userMemoryOfAgentId`); the clause keeps it that way.
          userMemoryOfAgentId: null,
          ...(f.visibility ? { visibility: f.visibility as any } : {}),
          ...classFilter,
          // A memory the caller owns AND was granted: narrows this slice
          // instead of replacing it, so the two clauses compose by AND like
          // every other pair.
          ...(f.sharedWithMe ? { shares: { some: { granteeId: ctx.userId } } } : {}),
        });
      }

      // #463 / cor:api:100:01 — optional single-org narrowing ("active
      // organization"): member -> scope, non-member/unresolvable -> empty
      // page with no org-existence disclosure, no platform-admin bypass.
      const scope = await resolveOrgScope(ctx, orgId);
      if (!scope) return empty;

      // #778 — filter.sharedWithMe: the distinct set of personal memories shared
      // WITH the caller via MemoryShare (the caller is a grantee) — the portal's
      // "Memories shared with me" tab. This is its OWN slice, not part of the
      // owned/org union: a grantee is never their own grantor, so it naturally
      // excludes owned memories. Only `personal` is shareable, so the class is
      // fixed (the default classFilter is subsumed). The membership gate mirrors
      // granteeShareAccess / the create rule — an org-owned personal share shows
      // only while the caller is a current member of that org, so the list stays
      // in lockstep with what Query.memory will actually open (a legacy/revoked
      // cross-org share is neither listed nor openable). App-key callers
      // (ctx.appId, no ctx.userId) get an empty page — sharing is user-to-user.
      if (f.sharedWithMe) {
        if (!ctx.userId) return empty;
        // Impersonation: personal shares are identity-scoped — invisible to
        // the shared-org-only session even though the TARGET is the grantee.
        if (ctx.impersonation) return empty;
        const memberOrgIds = await getMemberOrgIds(ctx.db, ctx.userId);
        return page({
          deletedAt: null,
          class: 'personal',
          userMemoryOfAgentId: null,
          ...(f.visibility ? { visibility: f.visibility as any } : {}),
          // `shares` is the Prisma relation field on Memory → MemoryShare.
          shares: { some: { granteeId: ctx.userId } },
          OR: [{ organizationId: null }, { organizationId: { in: memberOrgIds } }],
        });
      }

      // filter.visibility: PUBLIC — the marketplace slice (the old
      // publicMemories): every PUBLIC memory, readable by any caller, so the
      // scope selection never widens access. Still class-filtered and
      // org-narrowable like the default slice.
      if (f.visibility === 'PUBLIC') {
        return page({
          visibility: 'PUBLIC',
          deletedAt: null,
          userMemoryOfAgentId: null,
          // #653: an app-scoped knowledge/group row is App-internal — never in
          // the public "marketplace" slice, even if its visibility was set PUBLIC.
          appId: null,
          // #758: and neither is a USER-owned row. This branch RETURNS EARLY,
          // ahead of both the App-key fold and the JWT union below, so it needs
          // the spec-047 owner guard in its own right — a caller passing
          // `filter.visibility: PUBLIC` would otherwise reach a user-owned
          // memory that every other listing surface now excludes. The owner
          // reaches their own rows through the default (unfiltered) slice.
          ownerUserId: null,
          ...classFilter,
          ...(scope.scopedOrgId ? { organizationId: scope.scopedOrgId } : {}),
        });
      }

      // 023-app-shape Phase 2b: App-key callers get the union of their
      // installed Agents' memoryItems (App↔Agent is N:M via AppAgent). The
      // union is assembled in memory — App memory sets are small — then
      // class-filtered, sorted, and page-sliced with an exact total.
      if (ctx.appId) {
        const app = await ctx.db.app.findUnique({
          where: { id: ctx.appId },
          select: {
            organizationId: true,
            ownerUserId: true,
            deletedAt: true,
            uninstalledAt: true,
            appAgents: {
              select: {
                agent: {
                  include: {
                    memoryItems: {
                      where: { deletedAt: null, memory: { deletedAt: null } },
                      include: { memory: { include: MEMORY_INCLUDE } },
                    },
                  },
                },
              },
            },
          },
        });
        if (!app || app.deletedAt || app.uninstalledAt || app.appAgents.length === 0) return empty;
        // #758 — the twin of the #676 blocker-2 fix, which landed only in the
        // MCP `getAppMemoryAccess`. spec 047: a USER-owned memory is strictly
        // owner-only, so one owned by someone other than this App's owner must
        // never fold into the App-key listing. Org-owned memories
        // (ownerUserId NULL) are unaffected.
        const foreignUserOwned = (owner: string | null | undefined): boolean =>
          owner != null && owner !== app.ownerUserId;
        const licensedAgentIds = await activeAgentInstallLicenseIds(
          ctx.db, app,
          app.appAgents.map((row) => row.agent).filter((agent) => agent.deletedAt === null),
        );
        const memoryMap = new Map<string, any>();
        for (const aa of app.appAgents) {
          if (!licensedAgentIds.has(aa.agent.id)) continue;
          for (const item of aa.agent.memoryItems) {
            if (!isGrantedAgentMemoryRole(item.role)) continue;
            if (classSet ? !classSet.has(item.memory.class) : item.memory.class === 'system') continue;
            if (f.visibility && item.memory.visibility !== f.visibility) continue;
            // AgentMemoryItem is global to the Agent. An App-scoped memory
            // contributes only to its own App, even when the same Agent is
            // installed elsewhere (#1357 review).
            if (item.memory.appId != null && item.memory.appId !== ctx.appId) continue;
            if (item.memory.userMemoryOfAgentId != null) continue;
            if (foreignUserOwned(item.memory.ownerUserId)) continue;
            // #1626: an agent attachment is not a record-read grant. In
            // particular, app-class worker rows keep their holder/manager
            // audience even if an agent carries one as a memory item.
            if (!(await canReadMemoryRecord(ctx, item.memory))) continue;
            memoryMap.set(item.memory.id, item.memory);
          }
        }
        const all = Array.from(memoryMap.values()).sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        );
        return { items: take === 0 ? [] : all.slice(skip, skip + take), total: all.length };
      }

      // JWT/OAuth user — the caller's union:
      //   (1) their OWN owner-owned personal/private memories — ALWAYS,
      //       independent of the active org (they're user-owned, not part of
      //       any org's collection; selecting an active org must not hide
      //       your own notes),
      //   (1b) their OWN user-owned memories of ANY class (`ownerUserId`),
      //       on the same always-visible terms as (1) — see below,
      //   (2) memories their member orgs OWN,
      //   (3) memories their member orgs SUBSCRIBE to.
      // Per-user agent memories (userMemoryOfAgentId) are excluded — they
      // belong to the chatbot flow, not the regular memory list. 034:
      // owner-owned personal/private never come in via the org.
      if (ctx.userId) {
        // A caller with zero memberships still gets their own personal/private
        // memories: `in: []` in the org clauses simply matches nothing.
        const orgIds = scope.memberOrgIds;
        // #3595: the group membership clause is bounded to the shared org
        // under impersonation (the session sees ONE org — the target's
        // MemoryMember rows elsewhere must not list) and to the explicitly
        // selected org when `orgId` is supplied (a slice is a filter — an
        // orgId=A page must not include the caller's group memory in B).
        // Ordinary unscoped calls stay unbounded: cross-org MemoryMember
        // reach, mirroring the shared read gate's restrictToOrgId posture.
        const groupOrgBound = scope.scopedOrgId ?? ctx.impersonation?.orgId ?? null;
        // #1626 / cor:acl:010:01: app-class records use the shared content
        // audience (participants for team rows, holders/managers for worker
        // rows). Resolve that set before paging so totals and offsets cannot
        // include concealed records. Preserve the helper's unrestricted-set
        // sentinel if supplied; current admin sets retain strict-owner limits.
        const accessibleIds = await getAccessibleMemoryIds(ctx);
        const installListable = await listableInstallMemoryIds(ctx.db, ctx);
        // DS (Holger, 2026-10-05): the default listing is a membership slice,
        // including for platform admins whose direct-record reach is wider.
        // External AppMembers still discover their own App's readable rows.
        const memberApps = ctx.impersonation ? [] : await ctx.db.appMember.findMany({
          where: { userId: ctx.userId }, select: { appId: true },
        });
        return page({
          deletedAt: null,
          ...(f.visibility ? { visibility: f.visibility as any } : {}),
          userMemoryOfAgentId: null,
          AND: [classFilter],
          OR: [
            // #2044: an install memory is NOT an org-wide record (its customisation is the App's):
            // the org clause skips it, and the clause below lists it to its own audience alone.
            { organizationId: { in: orgIds }, class: { notIn: ['personal', 'private', 'group', 'app'] as any }, isInstallMemory: false },
            { class: 'system' as any, isInstallMemory: true, id: { in: installListable } },
            {
              class: 'app' as any,
              ...(accessibleIds === null ? {} : { id: { in: accessibleIds } }),
              OR: [
                { organizationId: { in: orgIds } },
                { appId: { in: memberApps.map(row => row.appId) } },
              ],
              ...(groupOrgBound ? { organizationId: groupOrgBound } : {}),
            },
            // #1208 / cor:acl:010:01 — group records list only through
            // MemoryMember (reader/writer/owner), mirroring the shared read
            // gate exactly: NOT nested under orgIds for ordinary calls (a
            // cross-org MemoryMember lists theirs), `appId: null` so an
            // app-scoped group row's metadata stays App-internal (#653,
            // record-side parity with the node gate), per-user holdings and
            // user-owned rows excluded (#758). MemoryMember rows hard-delete
            // (FR-038), so `some` is liveness.
            { class: 'group' as any, appId: null, userMemoryOfAgentId: null, ownerUserId: null, ...(groupOrgBound ? { organizationId: groupOrgBound } : {}), memberships: { some: { userId: ctx.userId } } },
            // GROUP excluded (#3781): a group-subscription row is API-invalid
            // state (createMemorySubscription admits PUBLIC only; group
            // visibility is CHECK-forced to GROUP) — never a listing grant.
            { class: { notIn: ['personal', 'private', 'group', 'app'] as any }, subscriptions: { some: { organizationId: { in: orgIds } } } },
            // Admin impersonation: the identity-scoped clauses are dropped —
            // the shared-org session never lists the target's personal/private
            // or user-owned memories (matches getAccessibleMemoryIds).
            ...(ctx.impersonation
              ? []
              : [
                  { class: { in: ['personal', 'private'] as any }, userId: ctx.userId },
                  // #1176 — the caller's own USER-OWNED rows, of any class.
                  // This list had no `ownerUserId` clause at all, so a
                  // user-owned memory outside `personal`/`private` was absent
                  // from the only surface that enumerates a user's memories,
                  // while `getAccessibleMemoryIds` (every node read),
                  // `canReadMemoryRecord` (`memory(ref:)`), MCP's
                  // `getMemoryAccess` and `scopes.ts` all admitted it. That is
                  // the whole of the reported bug: `hrn:mem:holger:holgers-gear`
                  // is `knowledge`-class with `organization_id` NULL and
                  // `owner_user_id` set, so it was readable by URN, returned by
                  // `hadron_list_memories`, and missing from the portal's list —
                  // reachable only by direct link. cor:api:120:03 makes
                  // "default = accessible set" durable, so the omission was a
                  // spec violation, not a missing capability; nothing about the
                  // DATA needed changing (the owner XOR means a free-standing
                  // memory always HAS an owner, and 24 of 24 live rows do).
                  //
                  // Unscoped by org for the same reason as the personal clause
                  // above: cor:api:120:03 — "selecting an active org must not
                  // hide your own notes". This is where the memory surface
                  // deliberately differs from `agents()`, which drops its
                  // user-owned fold under an explicit orgId; a memory the
                  // caller owns is theirs in every org context.
                  //
                  // NON-personal classes only (@codex, PR #1215). The two owner
                  // columns are independent, so `ownerUserId = A, userId = B` is
                  // a legal row — nothing constrains them to agree — and for
                  // personal/private `canReadMemoryRecord` returns at its FIRST
                  // branch, admitting only `userId` (or a share grantee) and
                  // never reaching its own `ownerUserId` branch. An unrestricted
                  // arm here would therefore list B's personal memory to A, with
                  // `description` / `data` / `source` on the row, while
                  // `memory(ref:)` correctly refused the same caller — the list
                  // BROADER than the point read, which is the direction that
                  // leaks. The strict-owner clause above governs those classes,
                  // so nothing is lost: an aligned row (the only shape in
                  // production — 15 of 15 measured) still reaches its owner
                  // through it. MCP's `getMemoryAccess` has drawn this exact
                  // line since spec 047 ("the map is personal-free by design");
                  // this is the GraphQL side catching up, not a new rule.
                  { class: { notIn: ['personal', 'private'] as any }, ownerUserId: ctx.userId },
                ]),
          ],
        });
      }
      throw new Error('Unauthenticated');
    },

    // #466: slim, paginated node list for the graph view. Phase one — the
    // client loads these to completion, renders nodes, then loads memoryEdges.
    // Returns only what a node-link graph draws (no content/abstract/data), so
    // the payload is a fraction of the full node fragment.
    memoryNodes: async (
      _: unknown,
      { memoryRef, limit, offset }: { memoryRef: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const resolvedId = await resolveReadableMemoryId(ctx, memoryRef);
      if (!resolvedId) return { nodes: [], total: 0 };

      const take = clampGraphTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const where = { memoryId: resolvedId, deletedAt: null };
      const [total, rows] = await Promise.all([
        ctx.db.node.count({ where }),
        ctx.db.node.findMany({
          where,
          orderBy: { loc: 'asc' }, // loc is unique per memory → stable paging
          skip,
          take,
          // #513: seq / isRunnable / description are small scalars the portal's
          // tree + graph render (sibling order, action dot, tooltip). Kept in
          // the slim projection — the heavy body (content/abstract/data) stays out.
          select: {
            id: true,
            loc: true,
            name: true,
            nodeType: true,
            tags: true,
            seq: true,
            isRunnable: true,
            description: true,
          },
        }),
      ]);
      return {
        total,
        // GraphNode is a distinct slim type (not Node), so it has no Node.tags
        // field resolver — deserialize the stored tags here. name/nodeType/tags
        // are NOT NULL columns (nodeType defaults to 'info'), so they're typed
        // non-null here to match GraphNode's String! / [String!]! — no null path.
        // seq/isRunnable/description are nullable columns → passed through as-is
        // (GraphQL Int / Boolean / String, all nullable).
        nodes: rows.map(
          (r: {
            id: string;
            loc: string;
            name: string;
            nodeType: string;
            tags: string[] | string;
            seq: number | null;
            isRunnable: boolean | null;
            description: string | null;
          }) => ({
            id: r.id,
            loc: r.loc,
            name: r.name,
            nodeType: r.nodeType,
            tags: deserializeTags(r.tags),
            seq: r.seq,
            isRunnable: r.isRunnable,
            description: r.description,
          }),
        ),
      };
    },

    // #466: slim, paginated edge list for the graph view. Phase two — endpoint
    // IDs only; the client already holds the nodes by the time it draws edges.
    // Scoped by the edge's denormalized memoryId (edges whose SOURCE is in the
    // memory); a cross-memory edge's target may fall outside this memory and is
    // dropped client-side as a dangling endpoint.
    memoryEdges: async (
      _: unknown,
      { memoryRef, limit, offset }: { memoryRef: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const resolvedId = await resolveReadableMemoryId(ctx, memoryRef);
      if (!resolvedId) return { edges: [], total: 0 };

      const take = clampGraphTake(limit);
      const skip = Math.max(0, offset ?? 0);
      // Only edges whose BOTH endpoints are live nodes. deleteNode soft-deletes
      // just the node row and leaves its edges live (only `hard` cascades), so
      // an edge to/from a soft-deleted node would otherwise dangle — memoryNodes
      // omits deleted nodes, so the client would draw a link to a node not in
      // the set. Filtering the endpoints here (not edge.deletedAt alone) keeps
      // the graph consistent and total accurate, without changing delete
      // semantics. (A cross-memory edge's target may still fall outside this
      // memory's node page — that legitimate dangling is dropped client-side.)
      const where = {
        memoryId: resolvedId,
        deletedAt: null,
        source: { deletedAt: null },
        target: { deletedAt: null },
      };
      const [total, edges] = await Promise.all([
        ctx.db.edge.count({ where }),
        ctx.db.edge.findMany({
          where,
          orderBy: { loc: 'asc' }, // edge loc is unique per memory → stable paging
          skip,
          take,
          select: { id: true, loc: true, name: true, sourceId: true, targetId: true, governedKind: true },
        }),
      ]);
      return { total, edges };
    },
};
