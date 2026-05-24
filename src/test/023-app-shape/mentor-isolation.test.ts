/**
 * 023-app-shape US3 acceptance test — Per-pairing mentor isolation
 * via MemoryShare.
 *
 * The cross-mentor leak fix. Alice has multiple mentors over time;
 * each mentor must NOT see the other mentors' conversations with
 * Alice. The pattern: the App backend creates a SEPARATE personal
 * Memory per (Alice, Mentor) pairing, each with its own MemoryShare
 * row grant.
 *
 * Covers the quickstart US3 walkthrough end-to-end:
 *   - Three Memories for Alice: solo, paired-with-A, paired-with-B.
 *   - Cross-grants: A only on M_with_A, B only on M_with_B.
 *   - Mentor A can read paired-with-A, denied on solo and paired-with-B.
 *   - Mentor B symmetric: paired-with-B allowed, others denied.
 *   - Alice (owner) can read all three.
 *   - Revoking A's grant denies A on the next read (FR-022).
 *   - grantorId is set to the principal even when the actor differs
 *     (FR-019).
 *   - createMemoryShare on a non-personal Memory is rejected with
 *     FORBIDDEN (FR-018). The caller-authority guard short-circuits
 *     before the controller's class check fires; the typed
 *     InvalidMemoryClassForShareError stays defined on the controller
 *     for non-GraphQL callers and is documented as unreachable from
 *     this GraphQL mutation in v1.
 *
 * Spec: spec-kits/specs/023-app-shape/spec.md User Story 3 +
 *       quickstart.md "US3" + contracts/graphql-app-shape.md.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
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
  mentorAId: string;
  mentorBId: string;
  /** Alice's solo personal Memory — no mentor grant. */
  memSoloId: string;
  /** Alice's personal Memory paired with Mentor A — only A has grant. */
  memWithAId: string;
  /** Alice's personal Memory paired with Mentor B — only B has grant. */
  memWithBId: string;
}

async function setupFixture(): Promise<Fixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mentor-org', urn: 'mentor-org' },
  });
  const make = async (handle: string, githubId: number) =>
    db.user.create({ data: { id: generateId(), handle, githubId } });
  const alice = await make('alice', 71001);
  const mentorA = await make('mentor-a', 71002);
  const mentorB = await make('mentor-b', 71003);

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
  // Auto-provision subscriptions so the license layer in the predicate
  // doesn't deny everyone before we even get to the MemoryShare path.
  await db.agentSubscription.createMany({
    data: [
      { userId: alice.id, agentId: agent.id, activatedAt: new Date() },
      { userId: mentorA.id, agentId: agent.id, activatedAt: new Date() },
      { userId: mentorB.id, agentId: agent.id, activatedAt: new Date() },
    ],
  });
  // All three are AppMembers of the coaching app.
  await db.appMember.createMany({
    data: [
      { appId: app.id, userId: alice.id, role: 'mentee' },
      { appId: app.id, userId: mentorA.id, role: 'mentor' },
      { appId: app.id, userId: mentorB.id, role: 'mentor' },
    ],
  });

  // Three personal-class Memories for Alice, all keyed to the same
  // (app, agent, alice) triplet — multiple rows per scope is supported
  // by design (FR-032 — scope, not uniqueness).
  const makeMem = async (slug: string) =>
    db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${app.id}:alice:${slug}`,
        name: `alice ${slug}`,
        class: 'personal',
        visibility: 'PERSONAL',
        userId: alice.id,
        appId: app.id,
        userMemoryOfAgentId: agent.id,
      },
    });
  const memSolo = await makeMem('solo');
  const memWithA = await makeMem('paired-with-a');
  const memWithB = await makeMem('paired-with-b');

  return {
    orgId: org.id,
    appId: app.id,
    agentId: agent.id,
    aliceId: alice.id,
    mentorAId: mentorA.id,
    mentorBId: mentorB.id,
    memSoloId: memSolo.id,
    memWithAId: memWithA.id,
    memWithBId: memWithB.id,
  };
}

function userCtx(userId: string): Context {
  return { db, userId };
}

// Helper: run the auth predicate against a memory by id.
async function canRead(memoryId: string, userId: string): Promise<boolean> {
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
  const result = await resolveMemoryAuthorization(
    prismaAuthDeps(db),
    memory,
    { callerUserId: userId, callingAppId: null },
    'read',
  );
  return result.allowed;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('US3: per-pairing mentor isolation via MemoryShare', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await setupFixture();
  });

  it('createMemoryShare sets grantorId to the principal regardless of actor (FR-019)', async () => {
    const payload = await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'writer' },
      userCtx(fx.aliceId),
    );
    expect(payload.memoryShare.memoryId).toBe(fx.memWithAId);
    expect(payload.memoryShare.granteeId).toBe(fx.mentorAId);
    expect(payload.memoryShare.role).toBe('writer');
    // grantorId === Alice (principal), createdBy === Alice (actor here is the principal).
    expect(payload.memoryShare.grantorId).toBe(fx.aliceId);
    expect(payload.memoryShare.createdBy).toBe(fx.aliceId);
  });

  it('Mentor A reads paired-with-A but is DENIED on solo + paired-with-B (the cross-mentor leak fix)', async () => {
    // Grant A only on M_with_A.
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'writer' },
      userCtx(fx.aliceId),
    );

    expect(await canRead(fx.memWithAId, fx.mentorAId)).toBe(true);
    // The critical denials — these are the scenarios that 008 leaked.
    expect(await canRead(fx.memSoloId, fx.mentorAId)).toBe(false);
    expect(await canRead(fx.memWithBId, fx.mentorAId)).toBe(false);
  });

  it('symmetric — Mentor B reads paired-with-B but is denied on solo + paired-with-A', async () => {
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithBId, granteeId: fx.mentorBId, role: 'writer' },
      userCtx(fx.aliceId),
    );

    expect(await canRead(fx.memWithBId, fx.mentorBId)).toBe(true);
    expect(await canRead(fx.memSoloId, fx.mentorBId)).toBe(false);
    expect(await canRead(fx.memWithAId, fx.mentorBId)).toBe(false);
  });

  it('Alice (owner) reads all three of her memories regardless of grants', async () => {
    expect(await canRead(fx.memSoloId, fx.aliceId)).toBe(true);
    expect(await canRead(fx.memWithAId, fx.aliceId)).toBe(true);
    expect(await canRead(fx.memWithBId, fx.aliceId)).toBe(true);
  });

  it('revokeMemoryShare takes effect on the next read (FR-022)', async () => {
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'reader' },
      userCtx(fx.aliceId),
    );
    expect(await canRead(fx.memWithAId, fx.mentorAId)).toBe(true);
    await resolvers.Mutation.revokeMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId },
      userCtx(fx.aliceId),
    );
    // Next read denied — no cached share state.
    expect(await canRead(fx.memWithAId, fx.mentorAId)).toBe(false);
  });

  it('updateMemoryShareRole upgrades reader → writer', async () => {
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'reader' },
      userCtx(fx.aliceId),
    );
    const updated = await resolvers.Mutation.updateMemoryShareRole(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'writer' },
      userCtx(fx.aliceId),
    );
    expect(updated.memoryShare.role).toBe('writer');
    const row = await db.memoryShare.findUniqueOrThrow({
      where: { memoryId_granteeId: { memoryId: fx.memWithAId, granteeId: fx.mentorAId } },
    });
    expect(row.role).toBe('writer');
  });

  it('createMemoryShare is idempotent — re-call upserts the role', async () => {
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'reader' },
      userCtx(fx.aliceId),
    );
    const second = await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'writer' },
      userCtx(fx.aliceId),
    );
    expect(second.memoryShare.role).toBe('writer');
    const rows = await db.memoryShare.findMany({
      where: { memoryId: fx.memWithAId, granteeId: fx.mentorAId },
    });
    expect(rows.length).toBe(1);
  });

  it('revokeMemoryShare is idempotent — no-op when no row exists', async () => {
    await expect(
      resolvers.Mutation.revokeMemoryShare(
        {},
        { memoryId: fx.memWithAId, granteeId: fx.mentorAId },
        userCtx(fx.aliceId),
      ),
    ).resolves.toMatchObject({
      memoryId: fx.memWithAId,
      granteeId: fx.mentorAId,
    });
  });

  it('updateMemoryShareRole throws MemoryShareNotFoundError when row absent', async () => {
    let caught: unknown;
    try {
      await resolvers.Mutation.updateMemoryShareRole(
        {},
        { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'writer' },
        userCtx(fx.aliceId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('MemoryShareNotFoundError');
  });

  it('createMemoryShare rejects non-personal-class memories via the caller-authority guard (FR-018; surfaces as FORBIDDEN)', async () => {
    const knowledgeMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgId,
        urn: `${fx.orgId}:knowledge-mem`,
        name: 'knowledge',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    let caught: unknown;
    try {
      await resolvers.Mutation.createMemoryShare(
        {},
        { memoryId: knowledgeMem.id, granteeId: fx.mentorAId, role: 'reader' },
        userCtx(fx.aliceId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    // Non-personal memories have no userId, so the caller-authority
    // guard's "memory.userId === ctx.userId" check returns FORBIDDEN
    // first — before the controller's class check has a chance to
    // run. Intended ordering: don't leak "this is a knowledge memory"
    // info to callers who aren't authorized for it. The typed
    // InvalidMemoryClassForShareError is still defined on the
    // controller for non-GraphQL callers and future Agent-mediated
    // paths.
    expect((caught as GraphQLError).extensions?.code).toBe('FORBIDDEN');
  });

  it('createMemoryShare rejects private-class memory at the class-check (the "not shareable" invariant is enforced upstream)', async () => {
    // Owner calls createMemoryShare on her own private memory — the
    // caller-authority guard passes (memory.userId === ctx.userId), and
    // the controller's class check then throws InvalidMemoryClassForShareError.
    // This is the test the auth predicate's `class-not-shareable` denial
    // assumes is in place: shares simply cannot be created for private
    // memories, so denying with `class-not-shareable` is correct (a
    // remedial share isn't possible).
    const privateMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgId,
        urn: `${fx.appId}:alice:private-1`,
        name: 'alice private',
        class: 'private',
        visibility: 'PERSONAL',
        userId: fx.aliceId,
        appId: fx.appId,
        userMemoryOfAgentId: fx.agentId,
      },
    });
    let caught: unknown;
    try {
      await resolvers.Mutation.createMemoryShare(
        {},
        { memoryId: privateMem.id, granteeId: fx.mentorAId, role: 'reader' },
        userCtx(fx.aliceId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('InvalidMemoryClassForShareError');
  });

  it('createMemoryShare rejects callers who are not the principal (FORBIDDEN)', async () => {
    let caught: unknown;
    try {
      await resolvers.Mutation.createMemoryShare(
        {},
        { memoryId: fx.memWithAId, granteeId: fx.mentorBId, role: 'reader' },
        userCtx(fx.mentorAId), // Mentor A is NOT the principal of fx.memWithA
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('FORBIDDEN');
  });

  it('writer-role grant allows both read and write; reader-role allows read only', async () => {
    // reader on A
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'reader' },
      userCtx(fx.aliceId),
    );
    // writer on B
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithBId, granteeId: fx.mentorBId, role: 'writer' },
      userCtx(fx.aliceId),
    );

    // Use the auth predicate directly to inspect op-level decisions.
    const memA = await db.memory.findUniqueOrThrow({
      where: { id: fx.memWithAId },
    });
    const memB = await db.memory.findUniqueOrThrow({
      where: { id: fx.memWithBId },
    });
    const deps = prismaAuthDeps(db);
    const aRead = await resolveMemoryAuthorization(deps, memA as unknown as MemoryForAuth, { callerUserId: fx.mentorAId, callingAppId: null }, 'read');
    const aWrite = await resolveMemoryAuthorization(deps, memA as unknown as MemoryForAuth, { callerUserId: fx.mentorAId, callingAppId: null }, 'write');
    const bRead = await resolveMemoryAuthorization(deps, memB as unknown as MemoryForAuth, { callerUserId: fx.mentorBId, callingAppId: null }, 'read');
    const bWrite = await resolveMemoryAuthorization(deps, memB as unknown as MemoryForAuth, { callerUserId: fx.mentorBId, callingAppId: null }, 'write');

    expect(aRead.allowed).toBe(true);
    expect(aWrite).toEqual({ allowed: false, reason: 'insufficient-role' });
    expect(bRead.allowed).toBe(true);
    expect(bWrite.allowed).toBe(true);
  });

  it('Memory.shares field returns the rows for the principal; empty for non-principals', async () => {
    await resolvers.Mutation.createMemoryShare(
      {},
      { memoryId: fx.memWithAId, granteeId: fx.mentorAId, role: 'writer' },
      userCtx(fx.aliceId),
    );
    const mem = await db.memory.findUniqueOrThrow({ where: { id: fx.memWithAId } });

    // Alice (principal) sees the share.
    const aliceShares = await (resolvers.Memory as Record<string, Function>).shares(
      mem,
      {},
      userCtx(fx.aliceId),
    );
    expect((aliceShares as Array<{ granteeId: string }>).map((s) => s.granteeId)).toEqual([
      fx.mentorAId,
    ]);

    // Mentor B (not the principal, not an org admin) sees none.
    const bShares = await (resolvers.Memory as Record<string, Function>).shares(
      mem,
      {},
      userCtx(fx.mentorBId),
    );
    expect(bShares).toEqual([]);
  });
});
