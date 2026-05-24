/**
 * Unit tests for `resolveMemoryAuthorization` — spec 023-app-shape.
 *
 * Covers the 16 cases enumerated in
 * `spec-kits/specs/023-app-shape/contracts/authorization-predicate.md`
 * §"Test plan for this module". Two critical regression tests are
 * explicitly named:
 *
 *   - "FR-034 trust boundary" — Agent acting for owner who is NOT an
 *     AppMember of the Memory's App MUST be denied (`no-share`). Catches
 *     the security bug where Step 3a's owner-bypass would otherwise let
 *     an Agent claiming `actingForUserId === memory.userId` bypass
 *     Step 3b's AppMember + AppAgent gates.
 *
 *   - "FR-035 cross-user denial" — Agent acting for user A reads user
 *     B's Memory → denied (B's Memory has no MemoryShare for A).
 *
 * The predicate is a pure function over the injected `AuthDeps`, so
 * tests use deterministic in-memory fakes — no DB required.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveMemoryAuthorization,
  type AuthContext,
  type AuthDeps,
  type AuthResult,
  type MemoryForAuth,
  type Op,
} from './resolveMemoryAuthorization.js';
import type { LifecycleLike } from '../lifecycle.js';

// ─── Fake AuthDeps builder ─────────────────────────────────────────────

type FakeState = {
  subscriptions: Map<string, LifecycleLike>;
  appMembers: Map<string, { role: string }>;
  appAgents: Set<string>;
  memoryShares: Map<string, { role: 'reader' | 'writer' }>;
  memoryMembers: Map<string, { role: 'reader' | 'writer' | 'owner' }>;
  knowledgeResult?: AuthResult;
};

function emptyState(): FakeState {
  return {
    subscriptions: new Map(),
    appMembers: new Map(),
    appAgents: new Set(),
    memoryShares: new Map(),
    memoryMembers: new Map(),
  };
}

function makeDeps(state: FakeState): AuthDeps {
  return {
    getAgentSubscription: async (userId, agentId) =>
      state.subscriptions.get(`${userId}:${agentId}`) ?? null,
    getAppMember: async (appId, userId) =>
      state.appMembers.get(`${appId}:${userId}`) ?? null,
    getAppAgent: async (appId, agentId) =>
      state.appAgents.has(`${appId}:${agentId}`) ? { exists: true } : null,
    getMemoryShare: async (memoryId, granteeId) =>
      state.memoryShares.get(`${memoryId}:${granteeId}`) ?? null,
    getMemoryMember: async (memoryId, userId) =>
      state.memoryMembers.get(`${memoryId}:${userId}`) ?? null,
    evaluateKnowledgeAccess: async () =>
      state.knowledgeResult ?? { allowed: true },
  };
}

const PAST = new Date('2026-04-01T00:00:00Z');
const ACTIVE_SUB: LifecycleLike = { activatedAt: PAST, revokedAt: null, expiresAt: null };

// Memory factories.
function personalMemory(overrides: Partial<MemoryForAuth> = {}): MemoryForAuth {
  return {
    id: 'mem-personal-1',
    class: 'personal',
    visibility: 'PERSONAL',
    userId: 'alice',
    appId: 'app-juno-mm',
    userMemoryOfAgentId: 'juno',
    ...overrides,
  };
}

function appMemory(overrides: Partial<MemoryForAuth> = {}): MemoryForAuth {
  return {
    id: 'mem-app-1',
    class: 'app',
    visibility: 'ORGANIZATION',
    userId: null,
    appId: 'app-1',
    userMemoryOfAgentId: 'juno',
    ...overrides,
  };
}

function systemMemory(overrides: Partial<MemoryForAuth> = {}): MemoryForAuth {
  return {
    id: 'mem-system-1',
    class: 'system',
    visibility: 'PRIVATE',
    userId: null,
    appId: null,
    userMemoryOfAgentId: null,
    ...overrides,
  };
}

function groupMemory(overrides: Partial<MemoryForAuth> = {}): MemoryForAuth {
  return {
    id: 'mem-group-1',
    class: 'group',
    visibility: 'GROUP',
    userId: null,
    appId: 'app-1',
    userMemoryOfAgentId: null,
    ...overrides,
  };
}

function knowledgeMemory(overrides: Partial<MemoryForAuth> = {}): MemoryForAuth {
  return {
    id: 'mem-knowledge-1',
    class: 'knowledge',
    visibility: 'ORGANIZATION',
    userId: null,
    appId: null,
    userMemoryOfAgentId: null,
    ...overrides,
  };
}

function privateMemory(overrides: Partial<MemoryForAuth> = {}): MemoryForAuth {
  return {
    id: 'mem-private-1',
    class: 'private',
    visibility: 'PERSONAL',
    userId: 'alice',
    appId: 'app-juno-mm',
    userMemoryOfAgentId: 'juno',
    ...overrides,
  };
}

function ctx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    callerUserId: 'alice',
    callingAppId: null,
    ...overrides,
  };
}

async function run(state: FakeState, memory: MemoryForAuth, c: AuthContext, op: Op = 'read') {
  return resolveMemoryAuthorization(makeDeps(state), memory, c, op);
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('resolveMemoryAuthorization', () => {
  // Helper: most personal-class cases require an active subscription
  // for alice→juno. Group/app/system/knowledge cases don't depend on
  // a subscription for the license check.
  function stateWithAliceSub(): FakeState {
    const s = emptyState();
    s.subscriptions.set('alice:juno', ACTIVE_SUB);
    return s;
  }

  // 1. License denial.
  it('denies any personal-class op when no AgentSubscription exists', async () => {
    const result = await run(emptyState(), personalMemory(), ctx({ callerUserId: 'alice' }));
    expect(result).toEqual({ allowed: false, reason: 'no-subscription' });
  });

  // 2. System read.
  it('allows read on system memory (no license needed for system)', async () => {
    const result = await run(emptyState(), systemMemory(), ctx(), 'read');
    expect(result).toEqual({ allowed: true });
  });

  // 3. System write denied.
  it('denies write on system memory (wrong-class)', async () => {
    const result = await run(emptyState(), systemMemory(), ctx(), 'write');
    expect(result).toEqual({ allowed: false, reason: 'wrong-class' });
  });

  // 4. App: AppMember allowed.
  it('allows app-class read/write when caller is an AppMember', async () => {
    const s = emptyState();
    s.appMembers.set('app-1:alice', { role: 'guide' });
    expect(await run(s, appMemory(), ctx({ callerUserId: 'alice' }), 'read')).toEqual({ allowed: true });
    expect(await run(s, appMemory(), ctx({ callerUserId: 'alice' }), 'write')).toEqual({ allowed: true });
  });

  // 5. App: non-AppMember denied.
  it('denies app-class when caller is not an AppMember', async () => {
    const result = await run(emptyState(), appMemory(), ctx({ callerUserId: 'mallory' }));
    expect(result).toEqual({ allowed: false, reason: 'not-app-member' });
  });

  // 6. Knowledge: defers to evaluateKnowledgeAccess.
  it('defers knowledge-class to the injected evaluateKnowledgeAccess hook', async () => {
    const s = emptyState();
    s.knowledgeResult = { allowed: false, reason: 'invalid-context' };
    const result = await run(s, knowledgeMemory(), ctx());
    expect(result).toEqual({ allowed: false, reason: 'invalid-context' });
  });

  // 7. Personal — owner (direct call) allowed.
  it('allows owner direct-call on personal memory (Step 3a — owner-bypass)', async () => {
    const s = stateWithAliceSub();
    const result = await run(s, personalMemory({ userId: 'alice' }), ctx({ callerUserId: 'alice' }), 'write');
    expect(result).toEqual({ allowed: true });
  });

  // 8. CRITICAL — FR-034 trust boundary regression test.
  // Agent acts for owner alice on alice's memory, but alice is NOT an
  // AppMember of the Memory's App. Owner-bypass (Step 3a) MUST NOT fire
  // because actingForUserId is set; Step 3b's AppMember gate denies; the
  // MemoryShare fallback (Step 3c) finds nothing → no-share.
  it('denies Agent-acting-for-owner when the principal is NOT an AppMember (FR-034)', async () => {
    const s = stateWithAliceSub();
    s.appAgents.add('app-juno-mm:juno'); // Agent is installed
    // No app_members entry for alice in app-juno-mm
    const result = await run(
      s,
      personalMemory(),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'juno',
        actingForUserId: 'alice',
      }),
    );
    expect(result).toEqual({ allowed: false, reason: 'no-share' });
  });

  // 9. Personal — implicit Agent-write happy path.
  it('allows implicit Agent-write when all five FR-034 conditions hold', async () => {
    const s = stateWithAliceSub();
    s.appAgents.add('app-juno-mm:juno');
    s.appMembers.set('app-juno-mm:alice', { role: 'mentee' });
    const result = await run(
      s,
      personalMemory(),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'juno',
        actingForUserId: 'alice',
      }),
      'write',
    );
    expect(result).toEqual({ allowed: true });
  });

  // 10. Personal — implicit fails when AppAgent missing.
  it('denies implicit Agent-write when AppAgent row is missing', async () => {
    const s = stateWithAliceSub();
    s.appMembers.set('app-juno-mm:alice', { role: 'mentee' });
    // No app_agents entry — Agent is not installed in this App.
    const result = await run(
      s,
      personalMemory(),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'juno',
        actingForUserId: 'alice',
      }),
    );
    expect(result).toEqual({ allowed: false, reason: 'no-share' });
  });

  // 11. Personal — implicit fails when calling-context Agent mismatches.
  it('denies implicit Agent-write when callingAgentId does not match the Memory Agent', async () => {
    const s = stateWithAliceSub();
    s.appAgents.add('app-juno-mm:juno');
    s.appAgents.add('app-juno-mm:tickfinder');
    s.appMembers.set('app-juno-mm:alice', { role: 'mentee' });
    const result = await run(
      s,
      personalMemory({ userMemoryOfAgentId: 'juno' }),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'tickfinder', // mismatched
        actingForUserId: 'alice',
      }),
    );
    expect(result).toEqual({ allowed: false, reason: 'no-share' });
  });

  // 12. Personal — cross-user MemoryShare reader.
  it('allows cross-user read via MemoryShare(reader); denies write with insufficient-role', async () => {
    const s = stateWithAliceSub();
    s.subscriptions.set('mentor-a:juno', ACTIVE_SUB);
    s.memoryShares.set('mem-personal-1:mentor-a', { role: 'reader' });
    const readResult = await run(
      s,
      personalMemory({ id: 'mem-personal-1' }),
      ctx({ callerUserId: 'mentor-a' }),
      'read',
    );
    expect(readResult).toEqual({ allowed: true });
    const writeResult = await run(
      s,
      personalMemory({ id: 'mem-personal-1' }),
      ctx({ callerUserId: 'mentor-a' }),
      'write',
    );
    expect(writeResult).toEqual({ allowed: false, reason: 'insufficient-role' });
  });

  // 13. Personal — cross-user MemoryShare writer.
  it('allows both read and write via MemoryShare(writer)', async () => {
    const s = stateWithAliceSub();
    s.subscriptions.set('mentor-a:juno', ACTIVE_SUB);
    s.memoryShares.set('mem-personal-1:mentor-a', { role: 'writer' });
    expect(
      await run(s, personalMemory({ id: 'mem-personal-1' }), ctx({ callerUserId: 'mentor-a' }), 'read'),
    ).toEqual({ allowed: true });
    expect(
      await run(s, personalMemory({ id: 'mem-personal-1' }), ctx({ callerUserId: 'mentor-a' }), 'write'),
    ).toEqual({ allowed: true });
  });

  // 14. CRITICAL — FR-035 cross-user denial regression test.
  // Agent acts for user A reads user B's Memory. A is NOT a grantee on
  // B's Memory. Implicit Agent-write (Step 3b) does not fire because
  // `actingForUserId (A) !== memory.userId (B)`. Step 3c finds no
  // MemoryShare → no-share. This is the closure of the cross-mentor
  // leak from spec 008.
  it('denies Agent acting for user A reading user B Memory without explicit MemoryShare (FR-035)', async () => {
    const s = stateWithAliceSub();
    s.subscriptions.set('bob:juno', ACTIVE_SUB);
    s.appAgents.add('app-juno-mm:juno');
    s.appMembers.set('app-juno-mm:bob', { role: 'mentee' });
    // Memory is owned by bob; Agent claims to act for alice.
    const bobsMemory = personalMemory({ id: 'mem-bob-personal', userId: 'bob' });
    const result = await run(
      s,
      bobsMemory,
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'juno',
        actingForUserId: 'alice', // Agent claims to act for alice, but Memory is bob's
      }),
    );
    expect(result).toEqual({ allowed: false, reason: 'no-share' });
  });

  // 15. Group — non-member.
  it('denies group-class read when caller has no MemoryMember row', async () => {
    const result = await run(emptyState(), groupMemory(), ctx({ callerUserId: 'mallory' }));
    expect(result).toEqual({ allowed: false, reason: 'no-membership' });
  });

  // Defensive: personal-class with null agent fails closed (fails the
  // license check rather than silently bypassing it).
  it('returns invalid-context when personal-class memory has null userMemoryOfAgentId', async () => {
    const result = await run(
      stateWithAliceSub(),
      personalMemory({ userMemoryOfAgentId: null }),
      ctx({ callerUserId: 'alice' }),
    );
    expect(result).toEqual({ allowed: false, reason: 'invalid-context' });
  });

  // Defensive: personal-class scope-invariant break in resolvePersonalAccess
  // covers all three required scoping columns.
  it('returns invalid-context when personal-class memory has null appId', async () => {
    // Note: the license check passes (userMemoryOfAgentId is non-null), so
    // the invariant guard in resolvePersonalAccess is what fires.
    const result = await run(
      stateWithAliceSub(),
      personalMemory({ appId: null, userId: 'mallory' }), // userId differs to skip owner-bypass
      ctx({ callerUserId: 'alice' }),
    );
    expect(result).toEqual({ allowed: false, reason: 'invalid-context' });
  });

  // ─── Private-class tests (added 2026-05-24) ──────────────────────────
  //
  // Private is single-owner and not shareable by design — same scoping
  // shape as personal (App, Agent, User), same license gate, same
  // owner-bypass + Agent-on-behalf branch, but NO MemoryShare fallback.
  // The distinct `class-not-shareable` denial reason lets observability
  // tell "no share row found" (personal) apart from "share is impossible
  // by class invariant" (private).

  it('private: license denial fires before any per-class branch', async () => {
    const result = await run(emptyState(), privateMemory(), ctx({ callerUserId: 'alice' }));
    expect(result).toEqual({ allowed: false, reason: 'no-subscription' });
  });

  it('private: owner direct-call is allowed (owner-bypass mirror of personal)', async () => {
    const s = stateWithAliceSub();
    expect(await run(s, privateMemory({ userId: 'alice' }), ctx({ callerUserId: 'alice' }), 'read')).toEqual({
      allowed: true,
    });
    expect(await run(s, privateMemory({ userId: 'alice' }), ctx({ callerUserId: 'alice' }), 'write')).toEqual({
      allowed: true,
    });
  });

  it('private: non-owner direct-call is denied with class-not-shareable (no share path)', async () => {
    // mentor-a has a valid sub but is NOT the owner; private has no
    // MemoryShare path, so even adding a share row should not change the
    // result — the rejection reason names the class invariant.
    const s = stateWithAliceSub();
    s.subscriptions.set('mentor-a:juno', ACTIVE_SUB);
    s.memoryShares.set('mem-private-1:mentor-a', { role: 'writer' }); // would help personal
    const result = await run(s, privateMemory({ userId: 'alice' }), ctx({ callerUserId: 'mentor-a' }));
    expect(result).toEqual({ allowed: false, reason: 'class-not-shareable' });
  });

  it('private: Agent-mediated happy path allows when (App, Agent) match + AppAgent + AppMember present', async () => {
    const s = stateWithAliceSub();
    s.appAgents.add('app-juno-mm:juno');
    s.appMembers.set('app-juno-mm:alice', { role: 'mentee' });
    const result = await run(
      s,
      privateMemory(),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'juno',
        actingForUserId: 'alice',
      }),
      'write',
    );
    expect(result).toEqual({ allowed: true });
  });

  it('private: Agent-mediated denies when callingAppId mismatches Memory App', async () => {
    const s = stateWithAliceSub();
    s.appAgents.add('app-other:juno');
    s.appMembers.set('app-other:alice', { role: 'mentee' });
    const result = await run(
      s,
      privateMemory({ appId: 'app-juno-mm' }),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-other', // mismatched
        callingAgentId: 'juno',
        actingForUserId: 'alice',
      }),
    );
    expect(result).toEqual({ allowed: false, reason: 'class-not-shareable' });
  });

  it('private: Agent-mediated denies when AppAgent revocation check fails', async () => {
    const s = stateWithAliceSub();
    // No app_agents entry — Agent uninstalled / never installed in this App.
    s.appMembers.set('app-juno-mm:alice', { role: 'mentee' });
    const result = await run(
      s,
      privateMemory(),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'juno',
        actingForUserId: 'alice',
      }),
    );
    expect(result).toEqual({ allowed: false, reason: 'class-not-shareable' });
  });

  it('private: Agent-mediated denies when AppMember revocation check fails', async () => {
    const s = stateWithAliceSub();
    s.appAgents.add('app-juno-mm:juno');
    // No app_members entry for alice — principal has been removed from the App.
    const result = await run(
      s,
      privateMemory(),
      ctx({
        callerUserId: 'app-backend',
        callingAppId: 'app-juno-mm',
        callingAgentId: 'juno',
        actingForUserId: 'alice',
      }),
    );
    expect(result).toEqual({ allowed: false, reason: 'class-not-shareable' });
  });

  it('private: null appId or null userMemoryOfAgentId yields invalid-context', async () => {
    const s = stateWithAliceSub();
    // userId differs from caller so we don't short-circuit via owner-bypass.
    const r1 = await run(s, privateMemory({ appId: null, userId: 'mallory' }), ctx({ callerUserId: 'alice' }));
    expect(r1).toEqual({ allowed: false, reason: 'invalid-context' });
    // userMemoryOfAgentId NULL trips the license guard before per-class dispatch.
    const r2 = await run(
      s,
      privateMemory({ userMemoryOfAgentId: null }),
      ctx({ callerUserId: 'alice' }),
    );
    expect(r2).toEqual({ allowed: false, reason: 'invalid-context' });
  });

  // 16. Group — role enforcement (reader/writer/owner).
  it('enforces group-class roles: reader=read, writer=read+write, owner=read+write', async () => {
    const s = emptyState();
    s.memoryMembers.set('mem-group-1:u1', { role: 'reader' });
    s.memoryMembers.set('mem-group-1:u2', { role: 'writer' });
    s.memoryMembers.set('mem-group-1:u3', { role: 'owner' });

    // u1 reader
    expect(await run(s, groupMemory(), ctx({ callerUserId: 'u1' }), 'read')).toEqual({ allowed: true });
    expect(await run(s, groupMemory(), ctx({ callerUserId: 'u1' }), 'write')).toEqual({
      allowed: false,
      reason: 'insufficient-role',
    });

    // u2 writer
    expect(await run(s, groupMemory(), ctx({ callerUserId: 'u2' }), 'read')).toEqual({ allowed: true });
    expect(await run(s, groupMemory(), ctx({ callerUserId: 'u2' }), 'write')).toEqual({ allowed: true });

    // u3 owner
    expect(await run(s, groupMemory(), ctx({ callerUserId: 'u3' }), 'read')).toEqual({ allowed: true });
    expect(await run(s, groupMemory(), ctx({ callerUserId: 'u3' }), 'write')).toEqual({ allowed: true });
  });
});
