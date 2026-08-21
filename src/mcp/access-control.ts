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

import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { isActiveAgentSubscription } from '../lib/agentSubscription.js';
import { isLifecycleActive } from '@hadron-memory/access-control';
import { isAgentInstalled } from '../lib/appAgent.js';
import { resolveUserApps } from '../auth/user-app-resolution.js';
import { appTeamSpaceFilter } from '../api/graphql/schema/resolvers.helpers.js';
import { getOrgReadableMemoryIds } from '../lib/auth/orgReadableMemory.js';

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
 * Cross-org gate: if the App's org and the Agent's org differ, an active
 * AgentOrgGrant(App.organization_id, primary-agent.id) is required.
 * Same-org installations auto-pass.
 */
export async function getAppMemoryAccess(
  db: PrismaClient,
  appId: string,
  opts: { includeTeamSpace?: boolean; callerUserId?: string | null } = {},
): Promise<Map<string, string>> {
  const app = await db.app.findUnique({
    where: { id: appId },
    select: {
      id: true,
      organizationId: true,
      ownerUserId: true,
      appAgents: {
        orderBy: { createdAt: 'asc' },
        take: 1,
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
                select: { memoryId: true, role: true, memory: { select: { ownerUserId: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!app) return new Map();

  const access = await getPrimaryAgentAccess(db, app);

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
        memory: { ownerUserId: string | null } | null;
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
 * READ_ONLY, deliberately: the reported failure is a READ gate, and the writes
 * this memory receives (team chat, worklog) go through their own participant
 * gates rather than the map. Granting READ_WRITE here would additionally open
 * the generic node-mutation tools on the team space — a widening nobody asked
 * for.
 */
async function getAppTeamSpaceAccess(
  db: PrismaClient,
  app: AppAccessRow,
  callerUserId: string | null,
): Promise<Map<string, string>> {
  const rows = await db.memory.findMany({
    // #1031: the shared `appTeamSpaceFilter`. This copy was the CORRECT one —
    // all four clauses — which is exactly why it should be the definition
    // rather than the best of three drifting duplicates.
    where: appTeamSpaceFilter(app.id),
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
 * installed Agent's system memory + memoryItems, behind the cross-org
 * AgentOrgGrant gate. Empty when the App's primary Agent doesn't resolve.
 */
async function getPrimaryAgentAccess(
  db: PrismaClient,
  app: AppAccessRow,
): Promise<Map<string, string>> {
  const primary = app.appAgents[0]?.agent ?? null;
  if (!primary || primary.deletedAt) return new Map();

  // Cross-org gate: require active AgentOrgGrant when App and Agent live in
  // different orgs. Same-org installs auto-pass — the Agent owner has implicit
  // license to deploy it. The active-status predicate is shared across
  // AgentSubscription + AgentOrgGrant via isLifecycleActive (008 R-2).
  // spec 047: the cross-org AgentOrgGrant gate is org-scoped. A user-owned App
  // has no org — its install license rides the owner's AgentSubscription
  // (Phase 2c-2), so the org-grant gate doesn't apply.
  if (app.organizationId !== null && app.organizationId !== primary.organizationId) {
    const grant = await db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: app.organizationId, agentId: primary.id } },
    });
    if (!grant || !isLifecycleActive(grant)) return new Map();
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

  const systemMemoryId = foreignUserOwned(primary.ownerUserId) ? null : primary.systemMemoryId;
  const memoryItems = primary.memoryItems
    .filter((item) => !foreignUserOwned((item as { memory?: { ownerUserId: string | null } }).memory?.ownerUserId))
    .map((item) => ({
      memoryId: item.memoryId,
      role: (item as { role?: string | null }).role ?? 'read',
    }));

  return foldAgentIntoAccessMap({ systemMemoryId, memoryItems });
}

// ---------------------------------------------------------------------------
// Public API used by MCP tool handlers
// ---------------------------------------------------------------------------

export async function getMemoryAccess(
  db: PrismaClient,
  auth: AuthContext,
): Promise<Map<string, string>> {
  const access = new Map<string, string>();

  // ── Base: App-derived access ────────────────────────────────────────────
  // App Key callers (auth.appId, no userId) and user callers with a resolved
  // active App both start from the App's installed-Agent memory map.
  //
  // Spec 026 / D-2026-05-21-003 advisory branch: a user with NO active App
  // selected gets the union across every App they're a member of — App
  // identity is a focusing concern, not access control; the user's App-derived
  // access is bounded by their AppMember rows regardless of which App is in
  // focus.
  //
  // #1003 (Codex P1) / #934: a PURE App-key principal bound to an active
  // session is hard-isolated to `sessionScopedMemoryIds` — the session's own
  // memory plus the bound agent's reach. That boundary is what keeps a
  // multi-user agent's end-user session from reading anything else the App can
  // see, and unlike the GraphQL `getAccessibleMemoryIds` (which checks it
  // FIRST) this module has no session branch: `hadron_get_node` gates on
  // `canReadMemory` alone. So the App's team space — never in the session
  // scope — must NOT be folded in for that shape, or an anonymous end-user
  // session could read `chats:team` and `worklog` by URN.
  //
  // Narrowed to the pure App-key shape (`!auth.userId`), mirroring #934: a user
  // credential's session binding is heartbeat attribution, never a scope
  // change, so a team member's own binding must not cost them their team space.
  // Only the team-space fold is gated — the agent-derived half is left exactly
  // as it was, so this change cannot narrow any pre-existing reach.
  if (auth.appId) {
    const sessionIsolated = Boolean(auth.sessionId) && !auth.userId;
    for (const [memoryId, level] of await getAppMemoryAccess(db, auth.appId, {
      includeTeamSpace: !sessionIsolated,
      callerUserId: auth.userId ?? null,
    })) {
      access.set(memoryId, level);
    }
  } else if (auth.userId) {
    const apps = await resolveUserApps(auth.userId, db);
    const perAppMaps = await Promise.all(
      apps.map((app) => getAppMemoryAccess(db, app.id, { callerUserId: auth.userId })),
    );
    for (const perApp of perAppMaps) {
      for (const [memoryId, level] of perApp) {
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
  // Granted READ_ONLY: org membership confers read; write stays gated by the
  // App/agent path above (so an org member with no App membership gets read,
  // not write — the canWriteToMemory map check below sees READ_ONLY). Gated
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
    select: { class: true, userId: true, userMemoryOfAgentId: true, appId: true, ownerUserId: true },
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

  // Non-personal memory: standard checks. Per D-2026-05-21-003, when
  // auth.appId is unset (multi-App OAuth caller without selection),
  // getMemoryAccess unions across all the user's accessible Apps —
  // the access map answers the question "does the caller have RW on
  // this memory via *any* of their App memberships?"
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;

  const access = await getMemoryAccess(db, auth);
  return access.get(memoryId) === 'READ_WRITE';
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
): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, userId: true, userMemoryOfAgentId: true, appId: true, ownerUserId: true },
  });
  if (!memory) return false;

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
        if (
          !memory.userMemoryOfAgentId ||
          !(await isAgentInstalled(db, auth.appId, memory.userMemoryOfAgentId))
        ) {
          return false;
        }
      }

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
  const access = await getMemoryAccess(db, auth);
  return access.has(memoryId);
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
