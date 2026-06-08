/**
 * Memory authorization predicate — spec 023-app-shape.
 *
 * Spec 023 narrows `AgentSubscription` from a triple-duty entity (license
 * + memory-access + import-authority) to license-only. Memory access is
 * now resolved via three primitives:
 *
 *   1. Class/visibility rules for `system`, `app`, `knowledge`.
 *   2. `MemoryShare` — asymmetric cross-user grants on `personal`-class.
 *   3. `MemoryMember` — symmetric team membership on `group`-class.
 *
 * Plus the implicit Agent-write rule (FR-034): an Agent installed in
 * an App is authorized to read/write `personal`-class memories scoped
 * to (App, Agent, principal) when the principal is an AppMember of
 * the App.
 *
 * Centralizing the decision tree in this module keeps the rules
 * unit-testable in isolation and prevents resolver drift. New code
 * MUST route Memory read/write decisions through this function. Legacy
 * call sites in `src/mcp/access-control.ts` continue to use their
 * own gates until the Phase 2b retrofit lands.
 *
 * Spec: `spec-kits/specs/023-app-shape/contracts/authorization-predicate.md`.
 */

import { isLifecycleActive, type LifecycleLike } from '../lifecycle.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type Op = 'read' | 'write';

/**
 * Caller context. `callerUserId` is the User making the request.
 * `actingForUserId` is set when an Agent is acting on behalf of a
 * principal (App-bound session attribution); it MUST equal
 * `callerUserId` for direct user calls (or be left undefined).
 *
 * Owner-bypass (Step 3a) is gated on `actingForUserId IS NULL` —
 * Agent-mediated access, even on behalf of the owner, MUST flow
 * through Step 3b's AppMember + AppAgent gates per FR-034. Using
 * `actingForUserId` for owner-bypass would let any Agent claiming
 * `actingForUserId === memory.userId` bypass the trust boundary.
 */
export type AuthContext = {
  callerUserId: string;
  callingAppId: string | null;
  callingAgentId?: string | null;
  /**
   * Set when an Agent is acting on behalf of a principal. `null` and
   * `undefined` both mean "no acting context" — the predicate uses
   * `== null` checks throughout so callers can safely round-trip the
   * field through JSON without worrying about which absent-value form
   * arrives.
   */
  actingForUserId?: string | null;
};

export type AuthAllow = { allowed: true };

export type AuthDeny = {
  allowed: false;
  reason:
    | 'no-subscription' // license check failed
    | 'no-share' // personal-class read/write requires MemoryShare, none found
    | 'no-membership' // group-class read/write requires MemoryMember, none found
    | 'not-app-member' // app-class read/write requires AppMember of memory's App
    | 'insufficient-role' // membership exists but role doesn't permit op (e.g., reader → write)
    | 'wrong-class' // op is invalid for class (e.g., write to system)
    | 'class-not-shareable' // private-class denied to non-owner; share is not a possible remedy
    | 'invalid-context'; // request context is malformed
};

export type AuthResult = AuthAllow | AuthDeny;

/** Minimal Memory shape needed by the predicate. */
export type MemoryForAuth = {
  id: string;
  class: 'system' | 'app' | 'knowledge' | 'personal' | 'group' | 'private';
  // 035-visibility-enum-cleanup: visibility is meaningful only for knowledge
  // (PUBLIC/ORGANIZATION) and group (GROUP); NULL for every other class.
  visibility: 'PUBLIC' | 'ORGANIZATION' | 'GROUP' | null;
  userId: string | null;
  appId: string | null;
  /** Legacy column name from spec 005; semantically the Memory's Agent id. */
  userMemoryOfAgentId: string | null;
};

/**
 * Injectable DB dependencies. Production wires these to Prisma via
 * `prismaAuthDeps(db)`; tests can pass deterministic fakes.
 */
export interface AuthDeps {
  /** Returns the row + active-status flag, or null if no row exists. */
  getAgentSubscription(
    userId: string,
    agentId: string,
  ): Promise<LifecycleLike | null>;

  /** Returns the AppMember row (with its free-form role string), or null. */
  getAppMember(
    appId: string,
    userId: string,
  ): Promise<{ role: string } | null>;

  /** Returns true if an AppAgent row exists for (appId, agentId). */
  getAppAgent(appId: string, agentId: string): Promise<{ exists: true } | null>;

  /** Returns the MemoryShare row, or null. */
  getMemoryShare(
    memoryId: string,
    granteeId: string,
  ): Promise<{ role: 'reader' | 'writer' } | null>;

  /** Returns the MemoryMember row, or null. */
  getMemoryMember(
    memoryId: string,
    userId: string,
  ): Promise<{ role: 'reader' | 'writer' | 'owner' } | null>;

  /**
   * Hook for the existing `knowledge`-class access logic (visibility
   * rules: PUBLIC / ORGANIZATION). The Phase 2b retrofit
   * will fold this into the predicate; until then, callers wire it
   * to the existing helper.
   */
  evaluateKnowledgeAccess?(
    memory: MemoryForAuth,
    ctx: AuthContext,
    op: Op,
  ): Promise<AuthResult>;
}

// ─── Decision tree ──────────────────────────────────────────────────────

/**
 * Resolve whether `ctx` is authorized to perform `op` on `memory`.
 * Pure function over (memory, ctx, op) + the injected `deps`.
 */
export async function resolveMemoryAuthorization(
  deps: AuthDeps,
  memory: MemoryForAuth,
  ctx: AuthContext,
  op: Op,
): Promise<AuthResult> {
  // ─── Step 1: (removed — license check is now per-path) ────────────────
  //
  // 034-memory-class-access: the `AgentSubscription` license check used to
  // run up-front for every `personal`/`private` access. It no longer does —
  // a **free-standing** (user-owned, app-less, agent-less) personal/private
  // memory has no agent to license, and a **direct owner** call needs no
  // license at all. The check now lives ONLY in the agent-on-behalf branch
  // (Step 3b) of `resolvePersonalAccess` / `resolvePrivateAccess`, where an
  // installed Agent acts for the user — there it still gates access so an
  // Agent can't reach a user's memory without the user's active subscription.

  // ─── Step 2: Class-based dispatch ───────────────────────────────────────
  switch (memory.class) {
    case 'system': {
      // System memory is read-only to every licensed caller.
      if (op === 'write') return { allowed: false, reason: 'wrong-class' };
      return { allowed: true };
    }

    case 'app': {
      if (memory.appId === null) return { allowed: false, reason: 'invalid-context' };
      const principal = ctx.actingForUserId ?? ctx.callerUserId;
      const member = await deps.getAppMember(memory.appId, principal);
      if (member === null) return { allowed: false, reason: 'not-app-member' };
      // v1: AppMember existence permits both read and write at the
      // predicate layer. Role-string semantics (validated against
      // `Agent.installation_policy.memberRoles` from spec 008) are
      // enforced by the write resolver, not here.
      return { allowed: true };
    }

    case 'knowledge': {
      if (deps.evaluateKnowledgeAccess === undefined) {
        // **Permissive** default during the Phase 2a transition — knowledge
        // access still goes through the legacy gate in
        // `src/mcp/access-control.ts` (which enforces PUBLIC / PRIVATE /
        // ORGANIZATION). Phase 2b will wire that helper in here as
        // `evaluateKnowledgeAccess`, at which point the visibility rules
        // run inside this predicate. Until then, this branch MUST NOT be
        // reached by callers that are using the predicate as their sole
        // gate for knowledge-class memory — pass `evaluateKnowledgeAccess`
        // to enforce the visibility rules.
        return { allowed: true };
      }
      return deps.evaluateKnowledgeAccess(memory, ctx, op);
    }

    case 'personal':
      return resolvePersonalAccess(deps, memory, ctx, op);

    case 'group':
      return resolveGroupAccess(deps, memory, ctx, op);

    case 'private':
      return resolvePrivateAccess(deps, memory, ctx, op);

    default: {
      // Exhaustiveness check. If `MemoryClass` gains another value, the
      // type-checker flags this branch as unreachable removal.
      const _exhaustive: never = memory.class;
      void _exhaustive;
      return { allowed: false, reason: 'invalid-context' };
    }
  }
}

async function resolvePersonalAccess(
  deps: AuthDeps,
  memory: MemoryForAuth,
  ctx: AuthContext,
  op: Op,
): Promise<AuthResult> {
  if (memory.userId === null) {
    // Every personal-class memory MUST carry an owner (chk_personal_visibility_user).
    // 034-memory-class-access: `appId` / `userMemoryOfAgentId` may now be NULL
    // for a free-standing (user-owned, app-less) personal memory — only the
    // owner is required. The agent-on-behalf branch below re-checks that the
    // app/agent scope is present before granting agent-mediated access.
    return { allowed: false, reason: 'invalid-context' };
  }

  // 3a. Owner-bypass — direct user calls ONLY.
  //
  // The `actingForUserId == null` gate is load-bearing: it prevents
  // an Agent claiming `actingForUserId === memory.userId` from
  // bypassing Step 3b's AppMember + AppAgent gates and reading the
  // owner's memory from a context the owner has not consented to.
  // Agent-mediated owner access MUST flow through Step 3b.
  // We use `== null` (loose) so both `undefined` and `null` count as
  // "no acting context" — the type accepts both for JSON round-trip
  // safety.
  if (ctx.callerUserId === memory.userId && ctx.actingForUserId == null) {
    return { allowed: true };
  }

  const effectiveCaller = ctx.actingForUserId ?? ctx.callerUserId;

  // 3b. Implicit Agent-write (FR-034) — physician's-office boundary.
  //
  // All five conditions must hold for the implicit grant:
  //   1. Agent is acting for the Memory's principal.
  //   2. The App in context matches the Memory's scoping App.
  //   3. The Agent in context matches the Memory's scoping Agent.
  //   4. The Agent is installed in the calling App (AppAgent row exists).
  //   5. The principal is an AppMember of the Memory's App (consent).
  //
  // When conditions 1–3 hold but 4 or 5 fails, return `no-share`
  // directly: `effectiveCaller === memory.userId` in this branch, so
  // a MemoryShare lookup would be "did the owner share with themselves"
  // — vacuously null. Skipping it saves a DB round-trip and makes the
  // denial reason map cleanly to the AppMember/AppAgent absence.
  if (
    ctx.actingForUserId != null &&
    ctx.actingForUserId === memory.userId &&
    ctx.callingAppId !== null &&
    ctx.callingAppId === memory.appId &&
    ctx.callingAgentId != null &&
    ctx.callingAgentId === memory.userMemoryOfAgentId
  ) {
    // 034-memory-class-access: the AgentSubscription license check (moved out
    // of the old Step 1) lives here — an Agent acting on the user's behalf
    // MUST hold the user's active subscription to the scoping Agent.
    const [appAgent, appMember, sub] = await Promise.all([
      deps.getAppAgent(ctx.callingAppId, ctx.callingAgentId),
      deps.getAppMember(memory.appId, memory.userId),
      deps.getAgentSubscription(memory.userId, memory.userMemoryOfAgentId),
    ]);
    if (sub === null || !isLifecycleActive(sub)) {
      return { allowed: false, reason: 'no-subscription' };
    }
    if (appAgent !== null && appMember !== null) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'no-share' };
  }

  // 3c. Cross-user (FR-035 path): consult MemoryShare.
  //
  // License-first for an AGENT-SCOPED personal memory (spec 023 FR-013): a
  // cross-user grantee still needs an active subscription to the scoping Agent
  // before the share is honored. 034-memory-class-access only lifted the
  // license requirement from the DIRECT-OWNER path and from FREE-STANDING
  // (no-agent) memories — so this check is gated on `userMemoryOfAgentId`.
  if (memory.userMemoryOfAgentId !== null) {
    const sub = await deps.getAgentSubscription(effectiveCaller, memory.userMemoryOfAgentId);
    if (sub === null || !isLifecycleActive(sub)) {
      return { allowed: false, reason: 'no-subscription' };
    }
  }
  const share = await deps.getMemoryShare(memory.id, effectiveCaller);
  if (share === null) {
    return { allowed: false, reason: 'no-share' };
  }
  // `reader` permits `read`; `writer` permits `read` and `write`.
  if (op === 'read' || share.role === 'writer') {
    return { allowed: true };
  }
  return { allowed: false, reason: 'insufficient-role' };
}

async function resolveGroupAccess(
  deps: AuthDeps,
  memory: MemoryForAuth,
  ctx: AuthContext,
  op: Op,
): Promise<AuthResult> {
  const effectiveCaller = ctx.actingForUserId ?? ctx.callerUserId;
  const member = await deps.getMemoryMember(memory.id, effectiveCaller);
  if (member === null) return { allowed: false, reason: 'no-membership' };
  // `reader` permits `read`; `writer`/`owner` permit `read` and `write`.
  if (op === 'read') return { allowed: true };
  if (member.role === 'writer' || member.role === 'owner') return { allowed: true };
  return { allowed: false, reason: 'insufficient-role' };
}

/**
 * `private`-class access: single owner, not shareable.
 *
 * Same (App, Agent, User) scope shape as personal, so the up-front
 * license check in `resolveMemoryAuthorization` covers both. The
 * difference from personal is that `private` has **no MemoryShare
 * path** — the class is single-owner by design. Owner-bypass and the
 * Agent-on-behalf branch (with the same AppAgent/AppMember revocation
 * checks as personal) still apply; without the Agent-mediated branch
 * the data would be unreachable from any MCP session.
 *
 * `op` is accepted for signature parity with the other resolvers and
 * to future-proof the contract; the policy here is read/write-symmetric
 * today (the allowing branches grant both), but a future spec may
 * tighten writes — keep the param wired so callers don't churn.
 */
async function resolvePrivateAccess(
  deps: AuthDeps,
  memory: MemoryForAuth,
  ctx: AuthContext,
  _op: Op,
): Promise<AuthResult> {
  if (memory.userId === null) {
    // 034-memory-class-access: only the owner is required; `appId` /
    // `userMemoryOfAgentId` may be NULL for a free-standing private memory.
    return { allowed: false, reason: 'invalid-context' };
  }
  // Direct user call: owner-bypass.
  if (ctx.callerUserId === memory.userId && ctx.actingForUserId == null) {
    return { allowed: true };
  }
  // Agent-mediated: principal must be acting for themselves, the
  // calling (App, Agent) must match the Memory's scoping (App, Agent),
  // both revocation checks (Agent still installed, principal still an
  // AppMember) must pass, AND the user must hold an active subscription to
  // the scoping Agent (license check, moved here from the old Step 1) —
  // same physician's-office boundary as personal class.
  if (
    ctx.actingForUserId != null &&
    ctx.actingForUserId === memory.userId &&
    ctx.callingAppId !== null &&
    ctx.callingAppId === memory.appId &&
    ctx.callingAgentId != null &&
    ctx.callingAgentId === memory.userMemoryOfAgentId
  ) {
    const [appAgent, appMember, sub] = await Promise.all([
      deps.getAppAgent(ctx.callingAppId, ctx.callingAgentId),
      deps.getAppMember(memory.appId, memory.userId),
      deps.getAgentSubscription(memory.userId, memory.userMemoryOfAgentId),
    ]);
    if (sub === null || !isLifecycleActive(sub)) {
      return { allowed: false, reason: 'no-subscription' };
    }
    if (appAgent !== null && appMember !== null) {
      return { allowed: true };
    }
  }
  // No share path — `private` is single-owner by design. Use the
  // distinct `class-not-shareable` reason so observability can tell
  // "no share row found" (personal) apart from "share is impossible
  // by class invariant" (private). Adding a share is not a valid
  // remedy for this denial.
  return { allowed: false, reason: 'class-not-shareable' };
}
