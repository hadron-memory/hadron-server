/**
 * #2190 (cor:dmo:050:17) — an App's memory scope: the memories `appNodes`
 * reads for a caller, with the reason each one is there.
 *
 * {@link resolveAppNodeScope} is the ONE admission-and-scope computation;
 * `appNodes` and `appMemoryScope` both call it, so the node list and the
 * memory list can never disagree about who is admitted or what is in scope.
 * The body was moved out of `appNodes` unchanged.
 *
 * `appMemoryScope` is a top-level query taking `appRef`, as `appNodes` is, and
 * deliberately NOT a field on `App`: an App object is reachable only through
 * `Query.app`'s org-member gate, so a field there could never answer the
 * external App participant (or the soft-deleted org) that `appNodes` admits.
 * Widening `Query.app` instead would hand those callers every other App field
 * (#552). (#2196 QA, Clark; Xan's CHECKED amendment.)
 */

import { GraphQLError } from 'graphql';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { effectiveScope, type EffectiveScope } from '../../../lib/effectiveSystemMemory.js';
import { getAppMemoryAccess, filterReadableMemoryIds, type AgentProvenance } from '../../../mcp/access-control.js';
import { type AuthContext } from '../../../middleware/auth.js';
import {
  clampListTake,
  isAppParticipant,
  isOwnerOrOrgMember,
  requireMemoryWriteAccess,
  requireOwnerOrOrgRole,
  resolveAppFreeStandingMemoryIds,
  resolveAppTeamSpaceMemoryIds,
  safeCanonicalUrn,
  type Context,
} from './resolvers.helpers.js';

/** Why a memory is in an App's scope (cor:dmo:050:17). */
export type AppMemorySourceKind = 'AGENT_SYSTEM' | 'AGENT_LINK' | 'INHERITED_BASE' | 'TEAM_SPACE' | 'APP_MEMORY';
export type AppMemorySource = { kind: AppMemorySourceKind; agentId: string | null };

/** The caller's App memory scope, or null when nothing is in it. */
export type AppNodeScope = {
  appId: string;
  inheritance: EffectiveScope;
  /** Every memory in scope, inherited bases included, with its sources in the documented order. */
  sources: Map<string, AppMemorySource[]>;
};

const SOURCE_RANK: Record<AppMemorySourceKind, number> = { AGENT_SYSTEM: 0, AGENT_LINK: 1, INHERITED_BASE: 2, TEAM_SPACE: 3, APP_MEMORY: 4 };

/**
 * Admit the caller to an App's nodes and compute the memories they read.
 * Throws the `appNodes` refusal for a caller who is not admitted; returns
 * null when nothing is in scope, including an App in a soft-deleted org.
 */
export async function resolveAppNodeScope(ctx: Context, appRef: string): Promise<AppNodeScope | null> {
  // 007-entity-id-or-urn: appRef may be ID, bare URN, or prefixed URN.
  const { id: resolvedAppId } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findUniqueOrThrow({
    where: { id: resolvedAppId },
    include: { organization: { select: { deletedAt: true } } },
  });
  if (app.organization?.deletedAt) return null;
  // Auth: an App PARTICIPANT, or org membership at READER+ on the App's
  // org; platform ADMIN/OWNER bypasses.
  //
  // #1070 — the participant arm closes a drift, and it is worth being
  // precise that it is a drift rather than a widening. This gate used to be
  // `requireOwnerOrOrgRole` alone, which admits org members and the App's
  // owner but NOT an AppMember with no role in the owning org — the
  // external / B2C participant shape. `isAppParticipant`
  // (`cor:agt:020:00` §3) does admit them, and so does the MCP access map:
  // `getMemoryAccess` folds the App's installed-agent memories
  // (systemMemoryId READ_ONLY + memoryItems) and its team space for exactly
  // this principal (`mcp/access-control.ts`, #1003).
  //
  // So the same person, in the same App, could read this material through
  // MCP and got FORBIDDEN here — which is the `effectiveAccess` tell for a
  // hand-rolled gate falling out of sync with the shared predicate (#362).
  // Admitting them grants nothing the platform does not already grant them;
  // it stops two surfaces disagreeing about one question.
  //
  // Org READER remains an admission arm, without the team space. The
  // installed-Agent enumeration below applies current link liveness.
  const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
  // Resolved ONCE: the gate here and the team-space scope below ask the
  // same question, and two calls would be two identical queries per read.
  //
  // #1094 REMOVED a `!ctx.impersonation &&` veto that used to sit here. It
  // was a deliberate stopgap from PR #1093 (Codex P1): `isAppParticipant`
  // guarded impersonation on its owner branch and not its AppMember branch,
  // so this caller vetoed the whole arm rather than change a shared
  // predicate mid-PR — and said so, "filed separately". That filing was
  // #1094, and the predicate is now bounded to the session's shared org.
  //
  // Keeping the veto would not be defence in depth, it would be a WRONG
  // ANSWER: it denies the arm for in-scope sessions too, so a support
  // session lost the team chat, worklog and epics of an App inside the very
  // org it was scoped to — while the dedicated surfaces admitted them. A
  // second copy of a rule that has since been fixed properly one level down
  // is exactly the stale-mechanism shape this repo keeps finding.
  const participant = await isAppParticipant(ctx, app);
  // ADMISSION only, and the distinction is load-bearing. A soft-uninstalled
  // App must not be revived by a retained `AppMember` row: `resolveAppRef`
  // resolves the historical row by id on purpose, membership survives
  // uninstall, and `resolveUserApps` excludes exactly those memberships
  // from every active-App access map (PR #1093 review, Codex P1).
  //
  // An org-authorized caller can still see the retired App's team space;
  // installed-Agent memories follow the live App access fold below.
  const admitAsParticipant = participant && !app.uninstalledAt;
  // Org authorization is tracked, not just enforced, because it decides the
  // SCOPE below as well as admission (PR #1093 review, Codex P1).
  //
  // The BOOLEAN form, not try/catch around the throwing one (PR #1093
  // review, Copilot). A catch wide enough to hold "Forbidden" also holds a
  // DB error from inside the predicate, and swallowing that would silently
  // downgrade an org member to the participant scope — a narrower answer
  // returned as though it were the right one. `isOwnerOrOrgMember` is the
  // same predicate `requireOwnerOrOrgRole` throws on, and it answers.
  const orgAuthorized = !!isPlatformAdmin || (await isOwnerOrOrgMember(ctx, app));
  if (!orgAuthorized && !admitAsParticipant) {
    // Unchanged refusal, from the original predicate, for anyone who is
    // neither — so the error a stranger sees is the one they saw before.
    await requireOwnerOrOrgRole(ctx, app, 'READER');
  }
  // Keep appNodes' historical multi-Agent scope while using the same live
  // item, stored-role, App-scope and install-license fold as MCP reads.
  // The raw AppAgent walk retained revoked links after a PUBLIC memory was
  // narrowed, because only the join row was soft-deleted.
  // #2190: the fold also reports which installed Agent put each memory here.
  const provenance = new Map<string, AgentProvenance[]>();
  const installedAccess = await getAppMemoryAccess(ctx.db, resolvedAppId, {
    allAgents: orgAuthorized, includeTeamSpace: false, callerUserId: ctx.userId ?? null, provenance,
  });
  // #1647: carry impersonation into the read filter, or a support session regains direct-owner identity privilege.
  const scopedAuth = {
    userId: ctx.userId, appId: resolvedAppId, roles: ctx.roles, impersonation: ctx.impersonation,
  } as AuthContext;
  const agentMemoryIds = [...await filterReadableMemoryIds(
    ctx.db as never, scopedAuth, installedAccess.keys(), { access: installedAccess },
  )];

  // #1031 — the App's own TEAM SPACE, which is structurally unreachable
  // through the installed-agent walk above: it is an app-class memory keyed
  // by (appId, sharedMemoryOfAgentId), not an entry in any agent's
  // memoryItems. Without it the App page can see `roles:*` and not the team
  // chat, the worklog, or the epics that live beside them.
  //
  // ADMITTED ONLY FOR A PARTICIPANT, and that condition is the whole care
  // in this change. `appNodes` gates on org READER+, while the team space's
  // audience is the App PARTICIPANT — AppMember at any role, org
  // CONTRIBUTOR+, or a user-owned App's owner (`cor:agt:020:00` §3). Those
  // are NOT the same set: an org READER passes this resolver's gate and is
  // NOT a participant. Adding the team space unconditionally would hand
  // every org reader the team's chat and worklog, which is precisely the
  // widening-a-read-gate leak this resolver would otherwise introduce
  // (`findings:broadening-read-gate-leaks-nested-objects`).
  //
  // So the scope is principal-dependent, deliberately: an org reader keeps
  // exactly the results they get today, and a participant additionally sees
  // the space they are already entitled to read.
  const teamSpaceIds = participant
    ? await resolveAppTeamSpaceMemoryIds(ctx.db, resolvedAppId)
    : [];

  // #2861 (cor:dmo:050:17 S6/S7) — the App's free-standing app memories
  // (`createAppMemory`), under exactly the team space's admission and for the
  // same reason: the audience is the App PARTICIPANT, which an org READER
  // is not. Same `participant` value, so the two arms cannot drift apart.
  // The App-isolation filter below still drops any other App's row.
  const freeStandingIds = participant
    ? await resolveAppFreeStandingMemoryIds(ctx.db, resolvedAppId, teamSpaceIds)
    : [];

  // Org readers retain the resolver's multi-Agent scope. Participants
  // outside that group receive the primary Agent fold used by MCP reads.
  const candidateMemoryIds = [...new Set([...agentMemoryIds, ...teamSpaceIds, ...freeStandingIds])];

  // Keep this App's memories only. An Agent installed in two Apps can link
  // memories scoped to each; the shared fold already applies this rule,
  // and the final filter also covers the separately added team space.
  // App-agnostic system and knowledge memories remain in scope.
  // Short-circuit before the query, not after it (PR #1132 review,
  // @copilot): an App with no installed Agents reaches here with an empty
  // candidate set, and `findMany({ id: { in: [] } })` is a round-trip whose
  // answer is already known.
  if (candidateMemoryIds.length === 0) return null;
  const scoped = await ctx.db.memory.findMany({
    where: {
      id: { in: candidateMemoryIds },
      OR: [{ appId: null }, { appId: resolvedAppId }],
    },
    select: { id: true },
  });
  if (scoped.length === 0) return null;
  // #1885 (cor:dmo:050:14) — an installed Agent's system memory reads as
  // its effective memory: inherited nodes join, marked, under their own
  // URNs; a base's overridden nodes and boot prompts stay out.
  const inheritance = await effectiveScope(ctx.db, scoped.map((m) => m.id));

  // Provenance, in install order within each kind (the fold walks installs in
  // createdAt order). An Agent's link to its own system memory is one source.
  const sources = new Map<string, AppMemorySource[]>();
  const add = (memoryId: string, source: AppMemorySource) => {
    const list = sources.get(memoryId) ?? [];
    list.push(source);
    sources.set(memoryId, list);
  };
  const teamSpace = new Set(teamSpaceIds);
  const freeStanding = new Set(freeStandingIds);
  for (const { id } of scoped) {
    for (const p of provenance.get(id) ?? []) add(id, { kind: p.system ? 'AGENT_SYSTEM' : 'AGENT_LINK', agentId: p.agentId });
    if (teamSpace.has(id)) add(id, { kind: 'TEAM_SPACE', agentId: null });
    if (freeStanding.has(id)) add(id, { kind: 'APP_MEMORY', agentId: null });
  }
  // A base memory is listed only when at least one of its nodes is inherited
  // into the scope: a fully overridden base shows nothing on appNodes.
  const bases = [...inheritance.inheritedFrom.keys()];
  if (bases.length > 0) {
    const shown = await ctx.db.node.findMany({
      where: {
        memoryId: { in: bases },
        deletedAt: null,
        ...(inheritance.excludeNodeIds.length > 0 ? { id: { notIn: inheritance.excludeNodeIds } } : {}),
      },
      select: { memoryId: true },
      distinct: ['memoryId'],
    });
    for (const { memoryId } of shown) add(memoryId, { kind: 'INHERITED_BASE', agentId: inheritance.inheritedFrom.get(memoryId)!.agentId });
  }
  for (const list of sources.values()) list.sort((a, b) => SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind]);
  return { appId: resolvedAppId, inheritance, sources };
}

/** One row of `appMemoryScope`: a leaf, never a nested Memory or Agent (cor:dmo:050:17). */
export type AppScopedMemoryRow = {
  memoryId: string;
  memoryUrn: string;
  name: string;
  class: string;
  sources: AppMemorySource[];
  viewerCanWrite: boolean;
};

/**
 * `appMemoryScope(appRef, limit, offset)`: the caller's App memory scope, one page,
 * ordered by memory URN (unique, so pages never drop or repeat a row). Paged
 * per cor:api:120:04 with the shared list clamp. `viewerCanWrite` runs the
 * exact `createNode` gate with this request's own context, for the page's rows
 * only: a FORBIDDEN denial reads false, and any other failure fails the field.
 */
export async function appMemoryScopePage(
  ctx: Context,
  appRef: string,
  limit?: number | null,
  offset?: number | null,
): Promise<{ items: AppScopedMemoryRow[]; total: number }> {
  const scope = await resolveAppNodeScope(ctx, appRef);
  if (!scope) return { items: [], total: 0 };
  const rows = await ctx.db.memory.findMany({
    where: { id: { in: [...scope.sources.keys()] } },
    select: { id: true, urn: true, name: true, class: true },
  });
  const ordered = rows
    .map((m) => ({ ...m, memoryUrn: safeCanonicalUrn('memory', m.urn) }))
    .sort((a, b) => (a.memoryUrn < b.memoryUrn ? -1 : a.memoryUrn > b.memoryUrn ? 1 : 0));
  const skip = Math.max(0, offset ?? 0);
  const page = ordered.slice(skip, skip + clampListTake(limit));
  const items: AppScopedMemoryRow[] = [];
  for (const m of page) {
    items.push({
      memoryId: m.id,
      memoryUrn: m.memoryUrn,
      name: m.name,
      class: m.class,
      sources: scope.sources.get(m.id)!,
      viewerCanWrite: await viewerCanWrite(ctx, m.id),
    });
  }
  return { items, total: ordered.length };
}

/**
 * The `createNode` write gate as a boolean: only its FORBIDDEN denial is false.
 *
 * An impersonation session is read-only before any resolver runs:
 * `impersonationReadOnlyPlugin` refuses every mutation but `stopImpersonation`
 * at the transport, so `createNode` never reaches `requireMemoryWriteAccess`.
 * That plugin is part of the authority this flag reports, so the answer there
 * is false for every row (#2196 QA, Clark).
 */
async function viewerCanWrite(ctx: Context, memoryId: string): Promise<boolean> {
  if (ctx.impersonation) return false;
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
    return true;
  } catch (err) {
    if (err instanceof GraphQLError && err.extensions?.code === 'FORBIDDEN') return false;
    throw err;
  }
}
