/**
 * 023-app-shape US5 acceptance test — AgentSubscription is a license,
 * not a memory grant.
 *
 * Codifies and verifies FR-013/FR-014: subscribing a User to an Agent
 * confers zero memory access on its own. Per-memory authorization
 * (MemoryShare for personal; MemoryMember for group; AppMember for app)
 * is the only path to access. The narrowing closes spec-008 §FR-006's
 * implication that AgentSubscription doubled as a memory grant.
 *
 * Quickstart US5 walkthrough end-to-end:
 *   - personal-class: subscribed-but-unshared user is DENIED;
 *     adding MemoryShare unlocks; revoking the subscription re-denies
 *     at the license layer (the share is irrelevant when the license
 *     itself fails).
 *   - app-class: subscription alone is not the gate — AppMember is.
 *   - group-class: subscription alone is not the gate — MemoryMember is.
 *
 * The license layer (Step 1 of the predicate) only fires for
 * personal-class memory, where AgentSubscription is the identified
 * scoping Agent's license. Other classes skip the subscription check
 * entirely — they have no Agent in the addressing tuple.
 *
 * Spec: spec-kits/specs/023-app-shape/spec.md §FR-013–FR-016 +
 *       quickstart.md "US5".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import {
  resolveMemoryAuthorization,
  type MemoryForAuth,
} from '../../lib/auth/resolveMemoryAuthorization.js';
import { prismaAuthDeps } from '../../lib/auth/prismaAuthDeps.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────

interface Fixture {
  orgId: string;
  appId: string;
  agentId: string;
  aliceId: string;
  /** The subscribed-but-otherwise-unrelated user `u` from the quickstart. */
  uId: string;
  /** Alice's solo personal Memory — no shares; for the FR-013/FR-014 demo. */
  memSoloId: string;
  /** A group-class Memory; alice is owner, u has no membership row. */
  memGroupId: string;
  /** An app-class Memory; alice is AppMember, u is NOT. */
  memAppId: string;
}

async function setupFixture(): Promise<Fixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'license-org', urn: 'license-org' },
  });
  const make = async (handle: string, githubId: number) =>
    db.user.create({ data: { id: generateId(), handle, githubId } });
  const alice = await make('alice', 73001);
  const u = await make('u-subscribed', 73002);

  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:coaching`,
      name: 'coaching',
      visibility: 'PRIVATE',
      installationPolicy: {
        maxMembers: 'unlimited',
        memberRoles: ['mentee', 'mentor'],
      },
    },
  });
  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:coaching-app`,
      name: 'Coaching App',
      appAgents: { create: { agentId: agent.id } },
    },
  });

  // Both users are subscribed to the Agent (the license layer would
  // otherwise short-circuit before we test the per-memory paths).
  // Only Alice is an AppMember — `u` is the "subscribed but otherwise
  // unrelated" user from the quickstart.
  await db.agentSubscription.createMany({
    data: [
      { userId: alice.id, agentId: agent.id, activatedAt: new Date() },
      { userId: u.id, agentId: agent.id, activatedAt: new Date() },
    ],
  });
  await db.appMember.create({
    data: { appId: app.id, userId: alice.id, role: 'mentee' },
  });

  // Alice's solo personal Memory — no MemoryShare grants. Under spec
  // 008's implied semantics, a subscriber `u` would have been able
  // to read this. Under spec 023, the subscription is license-only
  // and `u` is denied for lack of a MemoryShare.
  const memSolo = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${app.id}:alice:solo`,
      name: 'alice solo',
      class: 'personal',
      visibility: 'PERSONAL',
      userId: alice.id,
      appId: app.id,
      userMemoryOfAgentId: agent.id,
    },
  });

  // Group-class Memory — alice as the bootstrap owner; u has no
  // MemoryMember row.
  const memGroup = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:team-brain`,
      name: 'team brain',
      class: 'group',
      visibility: 'GROUP',
      userId: null,
      memberships: { create: { userId: alice.id, role: 'owner' } },
    },
  });

  // App-class Memory — alice is AppMember; u is not.
  const memApp = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${app.id}:app-brain`,
      name: 'app brain',
      class: 'app',
      visibility: 'PRIVATE',
      appId: app.id,
    },
  });

  return {
    orgId: org.id,
    appId: app.id,
    agentId: agent.id,
    aliceId: alice.id,
    uId: u.id,
    memSoloId: memSolo.id,
    memGroupId: memGroup.id,
    memAppId: memApp.id,
  };
}

function userCtx(userId: string): Context {
  return { db, userId };
}

async function authorize(memoryId: string, userId: string, op: 'read' | 'write' = 'read') {
  const memory = (await db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: {
      id: true,
      class: true,
      visibility: true,
      userId: true,
      appId: true,
      userMemoryOfAgentId: true,
    },
  })) as MemoryForAuth;
  return resolveMemoryAuthorization(
    prismaAuthDeps(db),
    memory,
    { callerUserId: userId, callingAppId: null },
    op,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('US5: AgentSubscription is a license, not a memory grant', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await setupFixture();
  });

  // ─── personal-class: the headline FR-013/FR-014 case ──────────────────

  it('personal — subscribed-but-unshared user is DENIED with no-share', async () => {
    // `u` has an active AgentSubscription. Under spec 008, this row
    // would have implied memory access — the very leak FR-013/FR-014
    // closes. Under spec 023, the subscription passes the license
    // gate but the per-memory authorization (MemoryShare) is absent,
    // so the predicate denies.
    const result = await authorize(fx.memSoloId, fx.uId);
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toBe('no-share');
  });

  it('personal — adding a MemoryShare unlocks access for the same subscriber', async () => {
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memSoloId, granteeId: fx.uId, role: 'reader' },
      userCtx(fx.aliceId),
    );
    const result = await authorize(fx.memSoloId, fx.uId);
    expect(result.allowed).toBe(true);
  });

  it('personal — revoking the subscription denies at the LICENSE layer (FR-013)', async () => {
    // First grant the share so the only remaining barrier is the
    // license itself.
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memSoloId, granteeId: fx.uId, role: 'reader' },
      userCtx(fx.aliceId),
    );
    // Confirm baseline: share + active subscription = allowed.
    expect((await authorize(fx.memSoloId, fx.uId)).allowed).toBe(true);

    // Hard-delete the subscription (the active-status predicate from
    // spec 005 also treats `revokedAt IS NOT NULL` as inactive; we
    // use deletion here for simplicity since it produces the same
    // observable behavior — the row is no longer "active").
    await db.agentSubscription.delete({
      where: { userId_agentId: { userId: fx.uId, agentId: fx.agentId } },
    });

    const result = await authorize(fx.memSoloId, fx.uId);
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Critical: denial is at the license layer, not the share layer.
    // The share is irrelevant — the license must hold first.
    expect(result.reason).toBe('no-subscription');
  });

  // ─── group-class: subscription is NOT consulted; MemoryMember is the gate ─

  it('group — subscribed user without a MemoryMember row is DENIED (no-membership)', async () => {
    // `u` has the subscription but no MemoryMember row on the group
    // memory. FR-014: group access flows through MemoryMember alone.
    const result = await authorize(fx.memGroupId, fx.uId);
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toBe('no-membership');
  });

  it('group — adding a MemoryMember unlocks read regardless of subscription state', async () => {
    await db.memoryMember.create({
      data: { memoryId: fx.memGroupId, userId: fx.uId, role: 'reader' },
    });
    // Subscription unchanged; per-memory grant is what flips the bit.
    expect((await authorize(fx.memGroupId, fx.uId)).allowed).toBe(true);

    // Drop the subscription — group access STILL holds. Group memory
    // has no scoping Agent so the predicate's Step 1 license check
    // doesn't fire for it. This is the strongest demonstration that
    // subscription is not the gate.
    await db.agentSubscription.delete({
      where: { userId_agentId: { userId: fx.uId, agentId: fx.agentId } },
    });
    expect((await authorize(fx.memGroupId, fx.uId)).allowed).toBe(true);
  });

  // ─── app-class: subscription is NOT consulted; AppMember is the gate ──

  it('app — subscribed user without AppMember is DENIED (not-app-member)', async () => {
    const result = await authorize(fx.memAppId, fx.uId);
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toBe('not-app-member');
  });

  it('app — adding AppMember unlocks regardless of subscription state', async () => {
    await db.appMember.create({
      data: { appId: fx.appId, userId: fx.uId, role: 'mentee' },
    });
    expect((await authorize(fx.memAppId, fx.uId)).allowed).toBe(true);

    // Subscription drop must not affect app-class access — Step 1's
    // license check is gated on memory.class === 'personal'.
    await db.agentSubscription.delete({
      where: { userId_agentId: { userId: fx.uId, agentId: fx.agentId } },
    });
    expect((await authorize(fx.memAppId, fx.uId)).allowed).toBe(true);
  });

  // ─── Cross-class summary assertion ────────────────────────────────────

  it('summary — having ONLY an AgentSubscription grants access to NO Memory across personal/app/group', async () => {
    // `u` has just the subscription; no MemoryShare, no MemoryMember,
    // no AppMember. The single per-Memory primitive missing in each
    // case is what denies access. This is the FR-013/FR-014 contract
    // in a single assertion across the three classes that have a
    // per-Memory authorization primitive.
    expect((await authorize(fx.memSoloId, fx.uId)).allowed).toBe(false);
    expect((await authorize(fx.memGroupId, fx.uId)).allowed).toBe(false);
    expect((await authorize(fx.memAppId, fx.uId)).allowed).toBe(false);
  });
});
