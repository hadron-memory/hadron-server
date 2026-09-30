/**
 * MCP access-control: which memories can the caller read/write?
 *
 * Callers authenticate via an App Key and resolve to an `appId`; access is
 * gated by the App's installed Agents (via the `AppAgent` N:M join from
 * 023-app-shape; the pre-023 direct `App.agentId` FK was dropped in Phase 2b).
 * Per Constitution Principle V (Zero-Trust Apps), every read and write is
 * checked server-side here — Apps cannot self-attest.
 *
 * After 023-app-shape Phase 2b:
 *   - App ↔ Agent is N:M via `app_agents`. This module reads the "primary"
 *     (first installed) Agent for legacy single-Agent paths; multi-Agent
 *     dispatch ships with the US1 resolvers in their own PR.
 *   - The new authorization predicate (`src/lib/auth/resolveMemoryAuthorization`)
 *     is the long-term home for these decisions. The retrofit that delegates
 *     `canReadMemory` / `canWriteToMemory` to the predicate is a separate
 *     follow-up; this module keeps its own logic for now but uses the
 *     AppAgent helpers from `src/lib/appAgent.ts`.
 *
 * Carried forward from 008-agent-installation:
 *   - System memory is universally read-only from any App context
 *     (DEVELOP-from-App is gone). Per-attached-memory write caps remain
 *     governed by AgentMemoryItem.role.
 *   - Cross-org App↔Agent uses requires an active AgentOrgGrant; same-org
 *     installs auto-pass.
 */

import type { AgentSubscription, Memory, PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { isActiveAgentSubscription } from '../lib/agentSubscription.js';
import { participantAppIds } from '../lib/auth/appParticipation.js';
import { activeAgentInstallLicenseIds, isAgentInstalled, isGrantedAgentMemoryRole } from '../lib/appAgent.js';
import { resolveUserApps } from '../auth/user-app-resolution.js';
import { getOrgReadableMemoryIds } from '../lib/auth/orgReadableMemory.js';
import { sessionScopedMemoryIds } from '../lib/auth/sessionScopedMemoryIds.js';

// ---------------------------------------------------------------------------
// Shared fold algorithm
// ---------------------------------------------------------------------------

/**
 * Fold an Agent's system memory + memoryItems into an effective
 * `memoryId → READ_ONLY|READ_WRITE` map.
 *
 * After 008-agent-installation:
 *   - System memory: always READ_ONLY from an App context (DEVELOP-from-App
 *     is gone). The Agent ownership surface is the only path to edit it.
 *   - Knowledge memoryItems: governed by AgentMemoryItem.role
 *     (read | read-write); no AppAgent-level cap exists.
 */
type AgentLike = {
  systemMemoryId?: string | null;
  memoryItems: Array<{ memoryId: string; role?: 'read' | 'read-write' | string | null }>;
};

export function foldAgentIntoAccessMap(agent: AgentLike): Map<string, string> {
  const access = new Map<string, string>();

  const systemMemoryId = agent.systemMemoryId ?? null;
  if (systemMemoryId) {
    access.set(systemMemoryId, 'READ_ONLY');
  }

  for (const item of agent.memoryItems) {
    const agentRole = item.role ?? 'read';
    // The persisted column is a free string. A malformed legacy value is no
    // grant at all; mapping it to READ_ONLY would make invalid rows readable.
    if (!isGrantedAgentMemoryRole(agentRole)) continue;
    const effective = agentRole === 'read-write' ? 'READ_WRITE' : 'READ_ONLY';
    const existing = access.get(item.memoryId);
    if (!existing || effective === 'READ_WRITE') {
      access.set(item.memoryId, effective);
    }
  }

  return access;
}

// ---------------------------------------------------------------------------
// App-keyed resolver
// ---------------------------------------------------------------------------

/**
 * Memory access for an App principal — reads the App's primary installed
 * Agent (via the `app_agents` join from 023-app-shape Phase 2b), then folds
 * that Agent's system memory + memoryItems into the access map. #1003 adds
 * the App's own TEAM SPACE on top (see {@link getAppTeamSpaceAccess}).
 *
 * "Primary" is the first installed Agent (ordered by AppAgent.createdAt).
 * Multi-Agent dispatch — where the URN in the request selects which
 * installed Agent to evaluate — is the US1 work; this legacy path keeps
 * single-Agent semantics until then.
 *
 * The Agent path requires a live App, Agent, and install license.
 */
export async function getAppMemoryAccess(
  db: PrismaClient,
  appId: string,
  opts: { includeTeamSpace?: boolean; callerUserId?: string | null; allAgents?: boolean } = {},
): Promise<Map<string, string>> {
  const app = await db.app.findUnique({
    where: { id: appId },
    select: {
      id: true,
      organizationId: true,
      organization: { select: { deletedAt: true } },
      ownerUserId: true,
      deletedAt: true,
      uninstalledAt: true,
      appAgents: {
        orderBy: { createdAt: 'asc' },
        ...(opts.allAgents ? {} : { take: 1 }),
        select: {
          agent: {
            select: {
              id: true,
              organizationId: true,
              ownerUserId: true,
              systemMemoryId: true,
              deletedAt: true,
              memoryItems: {
                where: { deletedAt: null, memory: { deletedAt: null } },
                select: {
                  memoryId: true,
                  role: true,
                  memory: { select: { class: true, ownerUserId: true, appId: true, userMemoryOfAgentId: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!app || app.deletedAt || app.uninstalledAt || app.organization?.deletedAt) return new Map();

  const agents = app.appAgents
    .map((install) => install.agent)
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null && agent.deletedAt === null);
  const licensedAgentIds = await activeAgentInstallLicenseIds(db, app, agents);
  const systemIds = agents
    .filter((agent) => licensedAgentIds.has(agent.id) && agent.systemMemoryId !== null)
    .map((agent) => agent.systemMemoryId!);
  const liveSystemRows = systemIds.length
    ? await db.memory.findMany({
        where: { id: { in: systemIds }, deletedAt: null }, select: { id: true },
      })
    : [];
  const liveSystemIds = new Set(liveSystemRows.map((row) => row.id));
  const access = new Map<string, string>();
  for (const install of app.appAgents) {
    const agentAccess = getPrimaryAgentAccess(
      { ...app, appAgents: [install] }, licensedAgentIds, liveSystemIds,
    );
    for (const [memoryId, level] of agentAccess) {
      if (level === 'READ_WRITE' || !access.has(memoryId)) access.set(memoryId, level);
    }
  }

  // ── #1003: the App's OWN team space ─────────────────────────────────────
  // Folded in AFTER, and independently of, the agent walk above — the team
  // space belongs to the App, not to any installed Agent, so neither an
  // uninstalled/soft-deleted primary Agent nor a lapsed cross-org grant on
  // someone else's Agent is a reason to withhold an App's own memory. Never
  // downgrades a level the agent path already granted.
  //
  // `includeTeamSpace: false` is the session-isolation opt-out — see the
  // caller in getMemoryAccess. Default ON, because every OTHER caller of this
  // function is a non-session principal that should see the team space.
  if (opts.includeTeamSpace ?? true) {
    for (const [memoryId, level] of await getAppTeamSpaceAccess(
      db,
      app,
      opts.callerUserId ?? null,
    )) {
      if (!access.has(memoryId)) access.set(memoryId, level);
    }
  }

  return access;
}

/** The App row both halves of {@link getAppMemoryAccess} read, loaded once. */
type AppAccessRow = {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  deletedAt: Date | null;
  uninstalledAt: Date | null;
  appAgents: Array<{
    agent: {
      id: string;
      organizationId: string | null;
      ownerUserId: string | null;
      systemMemoryId: string | null;
      deletedAt: Date | null;
      memoryItems: Array<{
        memoryId: string;
        role: string | null;
        memory: { class: string; ownerUserId: string | null; appId: string | null; userMemoryOfAgentId: string | null } | null;
      }>;
    } | null;
  }>;
};

/**
 * The App's TEAM SPACE — the app-class memory hosting `chats:team` and the
 * `worklog` ledger — as a `memoryId → READ_ONLY` map (#1003).
 *
 * `getAppMemoryAccess` historically reached memories only by walking the App's
 * **Agents**, so it never saw a row linked by `Memory.appId` — which
 * `chk_memory_class_app_id` makes REQUIRED for `class='app'`. The team space is
 * exactly such a row, so a team's own App members could not read the memory
 * hosting their team chat: `canReadMemory` fell through to this map and
 * `hadron_get_node` answered the no-existence-oracle `Memory not found`. Only a
 * global ADMIN got through, via the bypass that sits above the map check — which
 * is why the gap first read as enumeration-only (#990 item 3).
 *
 * FOUR shapes of app-class row can carry this App's `appId`, and the selector
 * has to admit the first two while excluding the last two:
 *
 *   | Kind                  | sharedMemoryOfAgentId | userMemoryOfAgentId | workerOf |
 *   |-----------------------|-----------------------|---------------------|----------|
 *   | Team space (adopted)  | set                   | null                | none     |
 *   | Team space (legacy)   | null                  | null                | none     |
 *   | Worker working memory | null                  | null                | one      |
 *   | Session memory        | null                  | SET                 | none     |
 *
 *   - `appId + class='app'` is the base: it catches ADOPTED and LEGACY team
 *     spaces alike. Keying on `sharedMemoryOfAgentId: { not: null }` instead
 *     would miss the pre-#723 unkeyed rows `sharedMemoryAdoption.ts` exists to
 *     find — leaving those Apps with the very symptom this fixes.
 *   - `workerOf: { none: {} }` excludes a Worker's casting-scoped working memory
 *     (#974) — the idiom `locateWorklogRoot` and the `App.sharedMemory` field
 *     resolver already use for this distinction, kept in lockstep with both.
 *     Whether those are readable by every App member or only by whoever drives
 *     that worker is an open policy question; it stays answered by
 *     `maySeeWorkerInternals`, not settled silently by a read-gate fix.
 *   - `userMemoryOfAgentId: null` excludes SESSION memories — the anonymous
 *     scratch memory and the app-user memory `startAgentSession` provisions,
 *     which reuse `class='app'` for the App's bucket of records-through-an-agent.
 *     Those are reachable ONLY through a session binding (`sessionScopedMemoryIds`),
 *     and that module's contract states this map "excludes per-user memories
 *     entirely". Admitting them would hand every App member every anonymous
 *     end-user session — breaking the #934/#967 narrow-never-grant isolation.
 *     Legacy team spaces are safely on the null side: the pre-#723 mint set
 *     `userId: null` and never touched this column.
 *
 * This fold stays READ_ONLY for pure App keys. getMemoryAccess upgrades these
 * rows for human App participants, whose generic node-write audience now
 * matches their read audience. Team chat and worklog still use their own gates.
 */
async function getAppTeamSpaceAccess(
  db: PrismaClient,
  // Only the App's identity and ownership are read, so the type is narrowed to
  // those two fields (#1196): `participantTeamSpaceFolds` calls this WITHOUT
  // loading the App's installed agents, which only the agent-derived half needs.
  app: Pick<AppAccessRow, 'id' | 'ownerUserId'>,
  callerUserId: string | null,
): Promise<Map<string, string>> {
  const rows = await db.memory.findMany({
    // #1031: deliberately NOT `appTeamSpaceFilter`. That predicate answers
    // "which memory IS the team space" — an IDENTITY question that must pick
    // exactly one row, so it requires the #723 shared key and thereby excludes
    // both name-addressable createMemoryInApp memories and legacy rows.
    //
    // This is the READ-ACCESS question, and it is legitimately broader: every
    // app-class row this App owns, except the two that are scoped to somebody
    // narrower than the App (a Worker's casting memory, a per-user session).
    // A named app memory and a LEGACY team space both belong to the App and
    // both must stay readable by its members — #1003 exists because they were
    // not, and `access-control.appClassRead.test.ts` pins the legacy case.
    //
    // The two predicates are column-indistinguishable for legacy vs named rows,
    // which is exactly why they must not share a definition: over-admitting is
    // right here and wrong there.
    where: {
      appId: app.id,
      class: 'app',
      deletedAt: null,
      workerOf: { none: {} },
      userMemoryOfAgentId: null,
    },
    select: { id: true, ownerUserId: true },
  });

  const access = new Map<string, string>();
  for (const row of rows) {
    // spec 047: a USER-owned App's team space is minted with the owner on it
    // (chat-scope.ts owner-XOR), and a user-owned memory is STRICTLY owner-only.
    // Two separate exclusions, both required:
    //
    //   1. blocker 2 (#676 review) — a row owned by someone other than this
    //      App's owner never folds into the App's map at all.
    //   2. Copilot on PR #1004 — nor does the App's OWN owner's row fold into a
    //      CO-MEMBER's map. This map IS the listing surface: hadron_list_memories
    //      re-checks canReadMemory only for the personal rows it folds in
    //      separately, so a map entry is listed as-is. Leaving it in would
    //      disclose the owner's memory name + urn to every co-member, even
    //      though canReadMemory's strict owner-only branch denies the read —
    //      the "never lean on the parent gate to protect a child's secrets"
    //      rule (#552). A caller-less principal (an App KEY, callerUserId null)
    //      acts for the App itself, whose owner exclusion 1 already matched.
    if (row.ownerUserId != null) {
      if (row.ownerUserId !== app.ownerUserId) continue;
      if (callerUserId != null && callerUserId !== row.ownerUserId) continue;
    }
    access.set(row.id, 'READ_ONLY');
  }
  return access;
}

/**
 * The agent-derived half of {@link getAppMemoryAccess} — the App's primary
 * installed Agent's system memory + memoryItems, behind the active install
 * license. Empty when the App's primary Agent doesn't resolve.
 */
function getPrimaryAgentAccess(
  app: AppAccessRow,
  licensedAgentIds: ReadonlySet<string>,
  liveSystemIds: ReadonlySet<string>,
): Map<string, string> {
  const primary = app.appAgents[0]?.agent ?? null;
  if (!primary || primary.deletedAt) return new Map();

  // Org Apps require a live AgentOrgGrant for a foreign Agent; personal Apps
  // require their owner's live AgentSubscription for a foreign Agent. Both
  // license shapes share isLifecycleActive (008 R-2).
  if (!licensedAgentIds.has(primary.id)) {
    return new Map();
  }

  // spec 047 (blocker 2, #676 review): a USER-owned memory folds into an App's
  // access map ONLY when the App shares its owner. A user-owned memory owned by
  // someone other than the App's owner must never enter this map — otherwise an
  // App's members/keys would gain a listing grant on it (canRead/canWriteToMemory
  // strict-gate the actual read per-memory, so this is the listing-surface half).
  // Org-owned memories (ownerUserId NULL) are unaffected. The agent's system
  // memory shares the agent's owner by construction, so `primary.ownerUserId`
  // stands in for it (no extra query).
  const appOwner = app.ownerUserId;
  const foreignUserOwned = (owner: string | null | undefined): boolean =>
    owner != null && owner !== appOwner;

  const systemMemoryId = foreignUserOwned(primary.ownerUserId) ||
    !primary.systemMemoryId || !liveSystemIds.has(primary.systemMemoryId)
    ? null : primary.systemMemoryId;
  const memoryItems = primary.memoryItems
    .filter((item) => item.memory != null &&
      // Personal/private rows remain candidates for appNodes' per-memory
      // owner + subscription gate; legacy knowledge/app holdings never do.
      (item.memory.userMemoryOfAgentId == null ||
        item.memory.class === 'personal' || item.memory.class === 'private') &&
      (item.memory.appId == null || item.memory.appId === app.id) &&
      !foreignUserOwned(item.memory.ownerUserId))
    .map((item) => ({
      memoryId: item.memoryId,
      role: (item as { role?: string | null }).role ?? 'read',
    }));

  return foldAgentIntoAccessMap({ systemMemoryId, memoryItems });
}

// ---------------------------------------------------------------------------
// Public API used by MCP tool handlers
// ---------------------------------------------------------------------------

/**
 * THE App-derived half of a principal's memory reach — "what does this caller
 * reach by virtue of an App?", as a `memoryId → READ_ONLY|READ_WRITE` map.
 *
 * Extracted (#1092) so the MCP gate below and the GraphQL node-content gate
 * (`getAccessibleMemoryIds`) compute an **identical** App-derived set and cannot
 * re-diverge — the same reason `getOrgReadableMemoryIds` was extracted for the
 * ORG-derived half after the 2026-06-13 Micromentor onboarding incident. Before
 * this, GraphQL enumeration had no App branch for a user principal at all: an
 * external AppMember was granted the App's memories by `Query.memory`, by
 * `appNodes` and by MCP's point read, and got nothing from `findNodes` scoped to
 * those same memories. Three surfaces yes, one no.
 *
 * The two arms are EXCLUSIVE, and deliberately so:
 *
 *   - **An active App is in focus** (`appId`) → that App alone. Spec 026 /
 *     D-2026-05-21-003: the selection focuses the request.
 *   - **No App in focus** → the union across every App the user is a member of.
 *     App identity is a focusing concern, not access control; the user's
 *     App-derived reach is bounded by their AppMember rows regardless of which
 *     App is in focus.
 *
 * #1003 (Codex P1) / #934: a PURE App-key principal bound to an active session
 * is hard-isolated to `sessionScopedMemoryIds` — the session's own memory plus
 * the bound agent's reach. That boundary is what keeps a multi-user agent's
 * end-user session from reading anything else the App can see, and unlike the
 * GraphQL gate (which checks the session branch FIRST) the MCP module has no
 * session branch: `hadron_get_node` gates on `canReadMemory` alone. So the App's
 * team space — never in the session scope — must NOT be folded in for that
 * shape, or an anonymous end-user session could read `chats:team` and `worklog`
 * by URN. Only the TEAM-SPACE fold is gated: the agent-derived half is untouched,
 * so this can never narrow a pre-existing reach.
 *
 * Narrowed to the pure App-key shape (`!userId`), mirroring #934: a user
 * credential's session binding is heartbeat attribution, never a scope change,
 * so a team member's own binding must not cost them their team space.
 *
 * **Personal-free by design, and relied upon.** Nothing here folds a
 * strict-owner (`personal`/`private`) row *intentionally* — but nothing in this
 * module ENFORCES it either, because `canReadMemory` strict-gates those classes
 * ABOVE the map. A caller that consumes this map WITHOUT such a per-row check
 * (the GraphQL gate turns it straight into `memoryId IN (…)`) must apply its own
 * strict-owner filter rather than inherit the assumption.
 *
 * #1196 adds a THIRD fold on top of the two exclusive arms:
 * {@link participantTeamSpaceFolds}, the App-PARTICIPATION arms no AppMember
 * row can express. It is additive and team-space-only — see that function for
 * why widening the App list instead would have been the wrong fix.
 */
export async function getPrincipalAppMemoryAccess(
  db: PrismaClient,
  principal: {
    userId?: string | null;
    appId?: string | null;
    sessionId?: string | null;
    impersonation?: { orgId: string } | null;
  },
): Promise<Map<string, string>> {
  const folds: Array<{ appId: string; map: Map<string, string> }> = [];

  if (principal.appId) {
    const sessionIsolated = Boolean(principal.sessionId) && !principal.userId;
    folds.push({
      appId: principal.appId,
      map: await getAppMemoryAccess(db, principal.appId, {
        includeTeamSpace: !sessionIsolated,
        callerUserId: principal.userId ?? null,
      }),
    });
  } else if (principal.userId) {
    const apps = await resolveUserApps(principal.userId, db);
    const maps = await Promise.all(
      apps.map((app) => getAppMemoryAccess(db, app.id, { callerUserId: principal.userId })),
    );
    apps.forEach((app, i) => folds.push({ appId: app.id, map: maps[i] }));
  }

  // #1196 — the participation arms neither branch above can see. Additive, and
  // run for BOTH shapes: an App SELECTION focuses a request and never narrows
  // what its driver may read (`cor:acl:020:01`), so a user who selected App B
  // keeps the team space of App A they contribute to.
  folds.push(
    ...(await participantTeamSpaceFolds(
      db,
      principal,
      folds.map((f) => f.appId),
    )),
  );

  const admitted = await admissibleFoldRows(db, principal.userId ?? null, folds);

  const access = new Map<string, string>();
  for (const { appId, map } of folds) {
    for (const [memoryId, level] of map) {
      if (!admitted.get(memoryId)?.has(appId)) continue;
      const existing = access.get(memoryId);
      // READ_WRITE wins over READ_ONLY when the same memory appears via
      // multiple App memberships (defensive — the data model makes this
      // unlikely but not impossible if a user has two roles across two
      // Apps that share a memory item).
      if (!existing || (existing === 'READ_ONLY' && level === 'READ_WRITE')) {
        access.set(memoryId, level);
      }
    }
  }
  return access;
}

/**
 * #1196 — the App-PARTICIPATION arms an `AppMember` row cannot express: an org
 * `CONTRIBUTOR`+ on the App's org, and the owner of a user-owned App.
 *
 * [`cor:acl:010:01`](hrn:node:hadronmemory.com:specs:cor:acl:010:01) states the
 * team space's audience as PARTICIPATION — *"an App member at any role, an org
 * `CONTRIBUTOR`+ on the App's org, or the owner of a user-owned App. A gate
 * keyed on the member row alone silently excludes the latter two"* — and names
 * *"re-keying the team space's audience off participation (e.g. onto the member
 * table alone)"* as invalidating it. Both fold arms above reach Apps through
 * `resolveUserApps`, which is `appMember.findMany` and nothing else, so both
 * of those arms were missing; and no other branch of the gate covers them,
 * because `getOrgReadableMemoryIds` is `class IN (knowledge, group)` AND
 * `appId: null`, which an app-class row can never satisfy.
 *
 * Measured before it was fixed, not inferred: an org CONTRIBUTOR who is not an
 * AppMember returned `isAppParticipant = true` and was ABSENT from
 * `getAccessibleMemoryIds` for the same App's team space. So the team-chat gate
 * was right and this one had drifted — which is why #1196's unification widens
 * the memory gate rather than narrowing the chat.
 *
 * **Team space only, and the narrowness is the point.** These principals get
 * {@link getAppTeamSpaceAccess} — the App's own app-class rows, always
 * `READ_ONLY`, with the spec-047 exclusions intact — and NOT
 * {@link getAppMemoryAccess}, whose agent-derived half can carry `READ_WRITE`
 * from an install's granted role and answers to a different audience (the
 * per-class rules). Widening the App LIST instead is the one-line version of
 * this fix and would have handed an org CONTRIBUTOR WRITE on an Agent's memory
 * items.
 *
 * **Impersonation narrows it, exactly as `isAppParticipant` narrows** (#876
 * class — `userId` is the TARGET, so an unbounded arm answers a question about
 * the target's memberships anywhere): the org arm is bounded to the support
 * session's ONE shared org, and the owner arm is denied outright because it is
 * identity-scoped and a user-owned App has no org to match.
 *
 * No platform-ADMIN arm, deliberately: `getAccessibleMemoryIds` answers that
 * principal in its own branch above the App fold, so an arm here would be
 * unreachable code carrying real risk. {@link isAppParticipant} keeps its
 * admin arm via `requireOrgRole`; the differential test between the two is
 * scoped to non-admin principals and says so.
 */
async function participantTeamSpaceFolds(
  db: PrismaClient,
  principal: { userId?: string | null; impersonation?: { orgId: string } | null },
  alreadyFolded: string[],
): Promise<Array<{ appId: string; map: Map<string, string> }>> {
  const userId = principal.userId;
  // No user identity: a pure App-key (or anonymous) principal has no
  // participation to derive. This is also what keeps the session-isolated
  // shape out — it is `appId + sessionId + !userId` by definition.
  if (!userId) return [];

  // The shared SET form of the audience (`participantAppIds`), so this fold and
  // `chatLocFilter` cannot drift into two spellings of one rule — which is the
  // defect class #1196 exists to remove, not to add a third instance of.
  const ids = (await participantAppIds(db, principal))
    // An App already folded by a branch above keeps that branch's (possibly
    // wider) map; re-folding it team-space-only could not add anything and
    // would only make the max-merge below do redundant work.
    .filter((id) => !alreadyFolded.includes(id));
  if (ids.length === 0) return [];

  const apps = await db.app.findMany({ where: { id: { in: ids } }, select: { id: true, ownerUserId: true } });
  const maps = await Promise.all(apps.map((app) => getAppTeamSpaceAccess(db, app, userId)));
  return apps.map((app, i) => ({ appId: app.id, map: maps[i] }));
}

/**
 * The two rules a folded row must satisfy to stay in a principal's App-derived
 * reach — applied here, in the SHARED predicate, so both gates that consume it
 * enforce them identically (PR #1102 review: @codex P1 + @copilot).
 *
 * Returns `memoryId → set of App ids that may contribute it`, resolved in ONE
 * query for every fold rather than one per App.
 *
 * **1. App scope.** An Agent's `memoryItems` are GLOBAL to the Agent, so an
 * Agent installed in Apps A and B carries BOTH Apps' app-scoped rows. Folding
 * B's install therefore yielded A's App-internal memories, and a B-only member
 * enumerated them. `appNodes` filters this downstream and says so
 * (`resolvers.query.node.ts`, "THIS App's memories only"); doing it here instead
 * means the MCP gate gets the same correction, rather than GraphQL alone —
 * fixing it on one side would have re-created a parity break inside the change
 * that exists to remove one. A row with `appId IS NULL` (an ordinary org
 * knowledge memory the Agent carries) is App-agnostic and always admissible.
 * This is the enumeration half of #1097.
 *
 * **2. Spec-047 strict ownership.** `ownerUserId` is a SECOND owner-only axis,
 * orthogonal to `class`: `canReadMemory` and `canWriteToMemory` both enforce it
 * as a bare `auth.userId === ownerUserId` with no ADMIN, org or App path. But
 * `getPrimaryAgentAccess` drops a user-owned row only when its owner differs
 * from the APP's owner — it takes no caller into account at all — so a
 * user-owned App's OWNER's memories folded in for every member. An App-key
 * principal (no `userId`) never matches an owner, and is denied by the point
 * gates for exactly that reason, so it is denied here too.
 *
 * **3. Legacy per-user holdings.** A `userMemoryOfAgentId` pointer confines
 * a row to its creating user even when its class is knowledge and its
 * visibility column is PUBLIC. An App-derived fold never grants that user.
 *
 * **4. Strict-owner classes.** `personal`/`private` never enter an App-derived
 * map. Their identity, selected-App and subscription checks live in the
 * canonical per-memory gate; discovery callers consume this map directly and
 * cannot safely reproduce those checks. `hadron_list_memories` folds the
 * caller's own strict-owner rows in separately through that gate.
 */
async function admissibleFoldRows(
  db: PrismaClient,
  callerUserId: string | null,
  folds: Array<{ appId: string; map: Map<string, string> }>,
): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(folds.flatMap(({ map }) => [...map.keys()]))];
  const admitted = new Map<string, Set<string>>();
  if (ids.length === 0) return admitted;

  const rows = await db.memory.findMany({
    where: { id: { in: ids } },
    select: { id: true, class: true, appId: true, ownerUserId: true, userMemoryOfAgentId: true },
  });
  for (const row of rows) {
    if (row.userMemoryOfAgentId != null) continue;
    // Rule 3 — a fold is never authority for a strict-owner class.
    if (row.class === 'personal' || row.class === 'private') continue;
    // Rule 2 — strict ownership admits the owner alone, nobody else, and no
    // credential-only principal.
    if (row.ownerUserId != null && row.ownerUserId !== callerUserId) continue;
    // Rule 1 — an app-scoped row is contributed only by ITS App.
    admitted.set(
      row.id,
      new Set(
        row.appId == null
          ? folds.map((f) => f.appId)
          : folds.filter((f) => f.appId === row.appId).map((f) => f.appId),
      ),
    );
  }
  return admitted;
}

export async function getMemoryAccess(
  db: PrismaClient,
  auth: AuthContext,
): Promise<Map<string, string>> {
  // A pure App key inside a session is confined to that session's verified
  // reach on point reads as well as GraphQL enumeration. The ordinary App
  // fold may include sibling AgentMemoryItems, so it cannot answer this shape.
  if (auth.appId && auth.sessionId && !auth.userId) {
    const ids = await sessionScopedMemoryIds(db, auth.appId, auth.sessionId);
    const session = await db.session.findUnique({
      where: { id: auth.sessionId }, select: { appId: true, memoryId: true },
    });
    if (!session || session.appId !== auth.appId || ids.length === 0) return new Map();
    const rows = await db.memory.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, class: true, userMemoryOfAgentId: true, workerOf: { select: { id: true } } },
    });
    const scoped = new Map<string, string>();
    for (const row of rows) {
      // A session row misbound to the team's or a Worker's app-class memory
      // passes the read-scope provenance check; it is not session memory.
      if (row.class === 'app' &&
        (row.id !== session.memoryId || row.userMemoryOfAgentId === null || row.workerOf.length > 0)) continue;
      scoped.set(row.id, row.class === 'app' ? 'READ_WRITE' : 'READ_ONLY');
    }
    return scoped;
  }

  const access = new Map<string, string>();

  // ── Base: App-derived access ────────────────────────────────────────────
  // Delegated to the shared predicate above (#1092) — see its header for the
  // focus/union split and the session-isolation rule. Merged rather than
  // assigned so the max-merge below governs uniformly; `access` is empty here,
  // so this is the same result the two inlined arms produced.
  for (const [memoryId, level] of await getPrincipalAppMemoryAccess(db, auth)) {
    const existing = access.get(memoryId);
    if (!existing || (existing === 'READ_ONLY' && level === 'READ_WRITE')) {
      access.set(memoryId, level);
    }
  }

  // The team-space read fold remains READ_ONLY for a pure App key. A USER who
  // participates in an App may also write generic nodes into its team space
  // and free-standing app memories; the Worker and session shapes stay out.
  if (auth.userId) {
    const participantIds = await participantAppIds(db, auth, { includeMemberships: true });
    if (participantIds.length > 0) {
      const writable = await db.memory.findMany({
        where: {
          appId: { in: participantIds }, class: 'app', deletedAt: null,
          workerOf: { none: {} }, userMemoryOfAgentId: null,
          OR: [{ ownerUserId: null }, { ownerUserId: auth.userId }],
        },
        select: { id: true },
      });
      for (const row of writable) access.set(row.id, 'READ_WRITE');
    }
  }

  // ── Direct org-read — parity with the portal getAccessibleMemoryIds ─────
  // A User principal can read org / public / subscription memories by virtue
  // of org membership, INDEPENDENT of App membership. This closes the
  // portal/MCP divergence that left a freshly-onboarded org member seeing
  // memories in the portal but none over MCP until they installed an Agent
  // (the 2026-06-13 Micromentor onboarding incident). The shared
  // getOrgReadableMemoryIds helper guarantees the two surfaces compute the
  // same set.
  //
  // Granted READ_ONLY: org membership confers read; writes on ordinary org
  // memories stay gated by the App/agent path above. The separate participant
  // upgrade above handles app-class team rows. Gated
  // on auth.userId, so App Key callers (no userId) are unaffected — their
  // App/session isolation is unchanged. personal/private memories are never
  // in this set; their strict-owner path in canReadMemory / canWriteToMemory
  // is the sole gate and runs before this map is consulted.
  if (auth.userId) {
    for (const memoryId of await getOrgReadableMemoryIds(db, auth.userId)) {
      // Don't downgrade a READ_WRITE already granted via the App path.
      if (!access.has(memoryId)) access.set(memoryId, 'READ_ONLY');
    }
  }

  // ── spec 047: user-owned (non-personal) memories ────────────────────────
  // A user-owned memory (ownerUserId === caller) is STRICTLY owner-only and
  // grants READ_WRITE to its owner. Only NON-personal classes go in this map
  // — the map is personal-free by design (hadron_list_memories folds the
  // caller's own personal/private rows in separately, and getAccessibleMemoryIds
  // consumers rely on it staying personal-free). App-Key callers (no userId)
  // never match, preserving per-App isolation. canReadMemory / canWriteToMemory
  // remain the canonical per-memory gates (strict owner-only, no admin bypass).
  if (auth.userId) {
    const owned = await db.memory.findMany({
      where: {
        ownerUserId: auth.userId,
        class: { notIn: ['personal', 'private'] },
        deletedAt: null,
      },
      select: { id: true },
    });
    for (const { id } of owned) access.set(id, 'READ_WRITE');
  }

  return access;
}

/**
 * Check if a caller has write access to a specific memory.
 *
 * Personal-class memories (FR-016 + 008 FR-011): strict ownership — only
 * Memory.userId can write, no ADMIN/OWNER bypass; App-keyed callers
 * additionally need (a) Memory.app_id === auth.appId (per-App isolation),
 * and (b) an active AgentSubscription(user, app.agent_id).
 *
 * Private-class memories (added 2026-05-24): same gates as personal in
 * this legacy access-control layer — strict ownership, App-isolation,
 * AgentSubscription. The "not shareable" semantic is enforced one layer
 * up (the MemoryShare create path rejects non-personal classes), so the
 * gates here are identical to personal's.
 *
 * Other memory classes: ADMIN/OWNER bypass + App.agent_id-derived membership +
 * AgentMemoryItem.role caps.
 */
export async function canWriteToMemory(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: {
      class: true, userId: true, userMemoryOfAgentId: true, appId: true,
      ownerUserId: true, workerOf: { select: { id: true } },
    },
  });

  if (!memory) return false;

  if (memory.class === 'personal' || memory.class === 'private') {
    if (auth.userId !== memory.userId) return false;

    // 034-memory-class-access: a FREE-STANDING personal/private memory
    // (app_id AND agent both NULL — user-owned, created outside any App) is
    // owner-only with no App/agent scope, so the strict-owner check above is
    // the whole gate. Mirror of canReadMemory — see the rationale there.
    if (memory.appId === null && memory.userMemoryOfAgentId === null) {
      return true;
    }

    if (auth.appId) {
      // Per-App isolation: a session through App A cannot write the personal
      // memory at (B.id, user.id) for some other App B of the same Agent.
      // Existing rows that pre-date the migration may have appId = NULL —
      // accept them ONLY when the calling App has the memory's Agent
      // installed via AppAgent. Without that guard, an App for Agent Y could
      // satisfy the AgentSubscription check (using one of its installed
      // Agents) and then touch a legacy memory that was actually created
      // for Agent X.
      if (memory.appId !== null) {
        if (memory.appId !== auth.appId) return false;
      } else {
        // Legacy row: require the calling App to have the memory's Agent
        // installed. If userMemoryOfAgentId is null (pre-005 ghost row) we
        // can't prove the match, so deny — backfilling app_id is the path
        // forward.
        //
        // Perf note: this branch performs an extra PK lookup per check
        // (N+1 for bulk operations). The cost is bounded — it only fires
        // for legacy rows with `memory.appId IS NULL`, a strictly
        // shrinking set as new writes always populate app_id. Adding a
        // request-scoped (appId, agentId) cache on AuthContext is the
        // long-term answer; deferred until the predicate retrofit
        // (Phase 2c) lands its own cache.
        if (
          !memory.userMemoryOfAgentId ||
          !(await isAgentInstalled(db, auth.appId, memory.userMemoryOfAgentId))
        ) {
          return false;
        }
      }

      // AgentSubscription check uses the memory's own Agent (chk_memory_personal_agent_id
      // guarantees `userMemoryOfAgentId` is non-null for personal-class rows
      // created post-023; legacy null rows already denied above).
      if (!memory.userMemoryOfAgentId || !memory.userId) return false;
      const sub = await db.agentSubscription.findUnique({
        where: {
          userId_agentId: {
            userId: memory.userId,
            agentId: memory.userMemoryOfAgentId,
          },
        },
      });
      if (!sub || !isActiveAgentSubscription(sub)) return false;
    }
    return true;
  }

  // spec 047: a USER-owned non-personal memory (ownerUserId set — e.g. a
  // user-owned agent's system/knowledge memory) is STRICTLY owner-only. No
  // ADMIN/OWNER bypass, no App/org path; an App-Key caller (no userId) never
  // matches, so is denied. Personal/private user-owned rows are already handled
  // by the block above (strict on userId + per-App isolation).
  if (memory.ownerUserId !== null) {
    return auth.userId === memory.ownerUserId;
  }

  if (memory.class === 'app') {
    // A session-bound App key may write only its own bound memory. The scope
    // helper rechecks the live App, install and memory provenance; its other
    // admissible row (the agent's system memory) is deliberately not writable.
    if (auth.appId && auth.sessionId && !auth.userId) {
      if (memory.workerOf.length > 0 || memory.userMemoryOfAgentId === null) return false;
      const session = await db.session.findUnique({
        where: { id: auth.sessionId },
        select: { appId: true, memoryId: true },
      });
      return session?.appId === auth.appId && session.memoryId === memoryId &&
        (await sessionScopedMemoryIds(db, auth.appId, auth.sessionId)).includes(memoryId);
    }
    // Worker and session rows are not App-wide generic-write targets. In
    // particular, an org CONTRIBUTOR or AppMember may not turn participation
    // into a write on another principal's working/scratch memory.
    if (memory.workerOf.length > 0 || memory.userMemoryOfAgentId !== null) {
      return auth.roles?.includes('ADMIN') === true || auth.roles?.includes('OWNER') === true;
    }
    if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;
    if (!auth.userId || !memory.appId) return false;
    return (await participantAppIds(db, auth, { includeMemberships: true })).includes(memory.appId);
  }

  // Non-personal memory: standard checks. Per D-2026-05-21-003, when
  // auth.appId is unset (multi-App OAuth caller without selection),
  // getMemoryAccess unions across all the user's accessible Apps —
  // the access map answers the question "does the caller have RW on
  // this memory via *any* of their App memberships?"
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;

  const access = await getMemoryAccess(db, auth);
  return access.get(memoryId) === 'READ_WRITE';
}

type MemoryReadRow = Pick<
  Memory,
  'id' | 'class' | 'userId' | 'userMemoryOfAgentId' | 'appId' | 'ownerUserId'
>;
type SubscriptionReadRow = Pick<AgentSubscription, 'activatedAt' | 'expiresAt' | 'revokedAt'>;

interface MemoryReadRowOptions {
  access?: Map<string, string>;
  installedAgentIds?: ReadonlySet<string>;
  subscriptionsByAgentId?: ReadonlyMap<string, SubscriptionReadRow>;
}

/** Apply the canonical MCP memory-read gate to a row that is already loaded. */
async function canReadMemoryRow(
  db: PrismaClient,
  auth: AuthContext,
  memory: MemoryReadRow,
  opts: MemoryReadRowOptions = {},
): Promise<boolean> {
  if (memory.class === 'personal' || memory.class === 'private') {
    if (auth.userId !== memory.userId) return false;

    // 034-memory-class-access: a FREE-STANDING personal/private memory
    // (app_id AND agent both NULL — user-owned, created outside any App) is
    // owner-only with no App/agent scope, so the strict-owner check above is
    // the whole gate. Without this short-circuit an owner operating through an
    // active App (auth.appId set) is wrongly denied their OWN memory: the
    // app_id-NULL branch below assumes a *legacy* agent-scoped row and demands
    // an installed agent, which a free-standing row (agent NULL) can't satisfy.
    if (memory.appId === null && memory.userMemoryOfAgentId === null) {
      return true;
    }

    if (auth.appId) {
      // Same legacy guard as canWriteToMemory: when memory.appId is NULL,
      // require the calling App to have the memory's Agent installed via
      // AppAgent.
      if (memory.appId !== null) {
        if (memory.appId !== auth.appId) return false;
      } else {
        if (!memory.userMemoryOfAgentId) return false;
        const installed = opts.installedAgentIds
          ? opts.installedAgentIds.has(memory.userMemoryOfAgentId)
          : await isAgentInstalled(db, auth.appId, memory.userMemoryOfAgentId);
        if (!installed) return false;
      }

      if (!memory.userMemoryOfAgentId || !memory.userId) return false;
      const sub = opts.subscriptionsByAgentId
        ? opts.subscriptionsByAgentId.get(memory.userMemoryOfAgentId)
        : await db.agentSubscription.findUnique({
            where: {
              userId_agentId: {
                userId: memory.userId,
                agentId: memory.userMemoryOfAgentId,
              },
            },
          });
      if (!sub || !isActiveAgentSubscription(sub)) return false;
    }
    return true;
  }

  // spec 047: a USER-owned non-personal memory (ownerUserId set) is STRICTLY
  // owner-only to read — no ADMIN/OWNER bypass, no App/org path. An App-Key
  // caller (no userId) never matches. Personal/private user-owned rows are
  // already handled above.
  if (memory.ownerUserId !== null) {
    return auth.userId === memory.ownerUserId;
  }

  // Non-personal memory: ADMIN/OWNER bypass + access map check.
  // Per D-2026-05-21-003, when auth.appId is unset (multi-App OAuth caller
  // without selection), getMemoryAccess unions across all the user's
  // accessible Apps — the access map answers "does the caller have read
  // on this memory via *any* of their App memberships?"
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;
  // `opts.access` is a REQUEST-SCOPED memo of this same call for this same
  // auth, nothing more — a caller checking many memories at once would
  // otherwise rebuild the whole App fold per memory.
  const access = opts.access ?? (await getMemoryAccess(db, auth));
  return access.has(memory.id);
}

/**
 * Check if a caller has read access to a specific memory.
 *
 * Personal-class memories enforce strict ownership (FR-016) — even ADMIN/OWNER
 * cannot read another user's personal memory. The 008 per-App isolation
 * (Memory.app_id === auth.appId) also applies. Private-class memories
 * (added 2026-05-24) follow the same rules in this layer.
 */
export async function canReadMemory(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
  opts: { access?: Map<string, string> } = {},
): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: {
      id: true,
      class: true,
      userId: true,
      userMemoryOfAgentId: true,
      appId: true,
      ownerUserId: true,
    },
  });
  if (!memory) return false;
  // A caller-supplied App fold cannot override a bound session's hard scope.
  const sessionBoundKey = Boolean(auth.appId && auth.sessionId && !auth.userId);
  return canReadMemoryRow(db, auth, memory,
    sessionBoundKey ? { access: await getMemoryAccess(db, auth) } : opts);
}

/**
 * Batch the canonical MCP memory-read gate across a candidate set.
 *
 * This is the bulk companion to {@link canReadMemory}: it loads Memory rows
 * once, builds the non-admin access map once, and batches the two
 * personal/private side lookups (legacy AppAgent installs and subscriptions).
 * The final decision stays in `canReadMemoryRow`, so discovery surfaces cannot
 * replace the real gate with an ownership-only predicate.
 * Callers with a narrower or multi-Agent App fold may pass it as `opts.access`.
 */
export async function filterReadableMemoryIds(
  db: PrismaClient,
  auth: AuthContext,
  memoryIds: Iterable<string>,
  opts: { access?: Map<string, string> } = {},
): Promise<Set<string>> {
  const ids = [...new Set(memoryIds)];
  if (ids.length === 0) return new Set();

  const memories = await db.memory.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      class: true,
      userId: true,
      userMemoryOfAgentId: true,
      appId: true,
      ownerUserId: true,
    },
  });

  const isPlatformAdmin = auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER');
  const sessionBoundKey = Boolean(auth.appId && auth.sessionId && !auth.userId);
  const access = sessionBoundKey
    ? await getMemoryAccess(db, auth)
    : opts.access ?? (isPlatformAdmin ? undefined : await getMemoryAccess(db, auth));
  let installedAgentIds: Set<string> | undefined;
  let subscriptionsByAgentId: Map<string, SubscriptionReadRow> | undefined;

  if (auth.appId && auth.userId) {
    const ownedPersonal = memories.filter(
      (memory) =>
        (memory.class === 'personal' || memory.class === 'private') &&
        memory.userId === auth.userId &&
        memory.userMemoryOfAgentId !== null,
    );
    const legacyAgentIds = [
      ...new Set(
        ownedPersonal
          .filter((memory) => memory.appId === null)
          .map((memory) => memory.userMemoryOfAgentId!),
      ),
    ];
    const installed = legacyAgentIds.length
      ? await db.appAgent.findMany({
          where: { appId: auth.appId, agentId: { in: legacyAgentIds } },
          select: { agentId: true },
        })
      : [];
    installedAgentIds = new Set(installed.map((row) => row.agentId));

    const subscriptionAgentIds = [
      ...new Set(
        ownedPersonal
          .filter(
            (memory) =>
              memory.appId === auth.appId ||
              (memory.appId === null && installedAgentIds!.has(memory.userMemoryOfAgentId!)),
          )
          .map((memory) => memory.userMemoryOfAgentId!),
      ),
    ];
    const subscriptions = subscriptionAgentIds.length
      ? await db.agentSubscription.findMany({
          where: { userId: auth.userId, agentId: { in: subscriptionAgentIds } },
          select: { agentId: true, activatedAt: true, expiresAt: true, revokedAt: true },
        })
      : [];
    subscriptionsByAgentId = new Map(
      subscriptions.map(({ agentId, ...subscription }) => [agentId, subscription]),
    );
  }

  const readable = new Set<string>();
  for (const memory of memories) {
    if (
      await canReadMemoryRow(db, auth, memory, {
        access,
        installedAgentIds,
        subscriptionsByAgentId,
      })
    ) {
      readable.add(memory.id);
    }
  }
  return readable;
}

/**
 * Get the set of memory IDs the caller can see.
 * Returns null to mean "all" (for ADMIN/OWNER) — but personal-class
 * memories never appear in an ADMIN/OWNER's "see all" list (FR-016
 * strict ownership applies), so callers MUST additionally apply the
 * personal-class filter when iterating memories.
 */
export async function getAccessibleMemoryIds(
  db: PrismaClient,
  auth: AuthContext,
): Promise<string[] | null> {
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return null;

  // Per D-2026-05-21-003 advisory branch: when no active App is selected
  // but the caller is an authenticated user, getMemoryAccess unions across
  // all the user's accessible Apps. Returns [] for unauthenticated callers
  // and for users with no App memberships.
  const access = await getMemoryAccess(db, auth);
  return [...access.keys()];
}
