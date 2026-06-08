/**
 * 023-app-shape US4 acceptance test — Group-class Memory governance
 * via MemoryMember.
 *
 * The "Company Brain" pattern: a team-shared Memory governed by a list
 * of members with reader/writer/owner roles. Closes the gap that the
 * four legacy classes (system/app/knowledge/personal) didn't cover —
 * team-shared collaborative memory with symmetric membership.
 *
 * Covers the quickstart US4 walkthrough end-to-end:
 *   - Create a group-class Memory → creator becomes first owner.
 *   - Add members (reader / writer / owner) → role enforcement.
 *   - Update role; remove member.
 *   - Bidirectional invariant: class=group ⇔ visibility=GROUP.
 *   - **FR-038** last-owner protection: removing or demoting the
 *     sole remaining owner is rejected.
 *   - **FR-031** last-non-owner removal preserves the Memory.
 *
 * Spec: spec-kits/specs/023-app-shape/spec.md User Story 4 +
 *       quickstart.md "US4" + contracts/graphql-app-shape.md.
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
  orgUrn: string;
  ownerUserId: string;
  u1Id: string;
  u2Id: string;
  u3Id: string;
  u4Id: string;
}

async function setupFixture(): Promise<Fixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'company-x', urn: 'company-x' },
  });
  const make = async (handle: string, githubId: number) =>
    db.user.create({ data: { id: generateId(), handle, githubId } });
  const owner = await make('org-owner', 72001);
  const u1 = await make('u1', 72002);
  const u2 = await make('u2', 72003);
  const u3 = await make('u3', 72004);
  const u4 = await make('u4', 72005);
  await db.orgMember.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      userId: owner.id,
      role: 'OWNER',
    },
  });
  return {
    orgId: org.id,
    orgUrn: org.urn,
    ownerUserId: owner.id,
    u1Id: u1.id,
    u2Id: u2.id,
    u3Id: u3.id,
    u4Id: u4.id,
  };
}

function adminCtx(userId: string): Context {
  return { db, userId, roles: ['ADMIN'] };
}

function userCtx(userId: string): Context {
  return { db, userId };
}

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

async function canWrite(memoryId: string, userId: string): Promise<boolean> {
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
    'write',
  );
  return result.allowed;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('US4: group memory governance via MemoryMember', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await setupFixture();
  });

  it('createMemory(memoryClass: group) bootstraps the creator as the first owner', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      {
        orgId: fx.orgId,
        name: 'team-alpha-brain',
        memoryClass: 'group',
        visibility: 'GROUP',
      },
      adminCtx(fx.ownerUserId),
    );
    expect(mem.class).toBe('group');
    expect(mem.visibility).toBe('GROUP');
    expect(mem.userId).toBeNull();

    const members = await db.memoryMember.findMany({ where: { memoryId: mem.id } });
    expect(members.length).toBe(1);
    expect(members[0].userId).toBe(fx.ownerUserId);
    expect(members[0].role).toBe('owner');
  });

  it('createMemory rejects class=group with non-GROUP visibility', async () => {
    let caught: unknown;
    try {
      await resolvers.Mutation.createMemory(
        {},
        {
          orgId: fx.orgId,
          name: 'bad-group',
          memoryClass: 'group',
          visibility: 'ORGANIZATION',
        },
        adminCtx(fx.ownerUserId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('INVALID_GROUP_MEMORY_VISIBILITY');
  });

  it('createMemory rejects visibility=GROUP with non-group class', async () => {
    let caught: unknown;
    try {
      await resolvers.Mutation.createMemory(
        {},
        {
          orgId: fx.orgId,
          name: 'bad-knowledge-group',
          memoryClass: 'knowledge',
          visibility: 'GROUP',
        },
        adminCtx(fx.ownerUserId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('INVALID_GROUP_MEMORY_VISIBILITY');
  });

  it('addMemoryMember + role enforcement: reader/writer/owner per the predicate', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-roles', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'reader' },
      userCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u2Id, role: 'writer' },
      userCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u3Id, role: 'owner' },
      userCtx(fx.ownerUserId),
    );

    // Reader: read yes, write no
    expect(await canRead(mem.id, fx.u1Id)).toBe(true);
    expect(await canWrite(mem.id, fx.u1Id)).toBe(false);
    // Writer: read + write
    expect(await canRead(mem.id, fx.u2Id)).toBe(true);
    expect(await canWrite(mem.id, fx.u2Id)).toBe(true);
    // Owner: read + write
    expect(await canRead(mem.id, fx.u3Id)).toBe(true);
    expect(await canWrite(mem.id, fx.u3Id)).toBe(true);
    // Non-member: denied
    expect(await canRead(mem.id, fx.u4Id)).toBe(false);
  });

  it('add → remove cycle: u4 added, can read; then removed, denied on next read', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-cycle', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u4Id, role: 'reader' },
      userCtx(fx.ownerUserId),
    );
    expect(await canRead(mem.id, fx.u4Id)).toBe(true);
    await resolvers.Mutation.removeMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u4Id },
      userCtx(fx.ownerUserId),
    );
    expect(await canRead(mem.id, fx.u4Id)).toBe(false);
  });

  it('updateMemoryMemberRole upgrades reader → writer', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-update', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'reader' },
      userCtx(fx.ownerUserId),
    );
    const updated = await resolvers.Mutation.updateMemoryMemberRole(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'writer' },
      userCtx(fx.ownerUserId),
    );
    expect(updated.memoryMember.role).toBe('writer');
  });

  it('FR-038 last-owner protection — remove rejects the sole owner', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-last-owner', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    // owner is the sole owner. Removing them must fail.
    let caught: unknown;
    try {
      await resolvers.Mutation.removeMemoryMember(
        {},
        { memoryId: mem.id, userId: fx.ownerUserId },
        userCtx(fx.ownerUserId), // self-removal
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('LastOwnerProtectedError');
  });

  it('FR-038 last-owner protection — demote rejects the sole owner', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-demote-last-owner', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    let caught: unknown;
    try {
      await resolvers.Mutation.updateMemoryMemberRole(
        {},
        { memoryId: mem.id, userId: fx.ownerUserId, role: 'writer' },
        userCtx(fx.ownerUserId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('LastOwnerProtectedError');
  });

  it('FR-038 — second owner makes original owner removable', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-two-owners', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'owner' },
      userCtx(fx.ownerUserId),
    );
    // Now ownerUser can self-remove because u1 is still an owner.
    await resolvers.Mutation.removeMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.ownerUserId },
      userCtx(fx.ownerUserId),
    );
    const owners = await db.memoryMember.findMany({
      where: { memoryId: mem.id, role: 'owner' },
    });
    expect(owners.length).toBe(1);
    expect(owners[0].userId).toBe(fx.u1Id);
  });

  it('FR-031 — removing the last NON-OWNER preserves the Memory', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-last-nonowner', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'reader' },
      userCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.removeMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id },
      userCtx(fx.ownerUserId),
    );
    const stillThere = await db.memory.findUnique({ where: { id: mem.id } });
    expect(stillThere).not.toBeNull();
    // Owner is still on the memory.
    const owners = await db.memoryMember.findMany({
      where: { memoryId: mem.id, role: 'owner' },
    });
    expect(owners.length).toBe(1);
  });

  it('addMemoryMember rejected for non-owner caller (FORBIDDEN)', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-no-non-owner-add', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'writer' },
      userCtx(fx.ownerUserId),
    );
    let caught: unknown;
    try {
      // u1 is a writer, not an owner. Adding another member must be denied.
      await resolvers.Mutation.addMemoryMember(
        {},
        { memoryId: mem.id, userId: fx.u2Id, role: 'reader' },
        userCtx(fx.u1Id),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('FORBIDDEN');
  });

  it('removeMemoryMember permits self-removal even by a non-owner', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-self-remove', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'reader' },
      userCtx(fx.ownerUserId),
    );
    // u1 self-removes — permitted.
    await resolvers.Mutation.removeMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id },
      userCtx(fx.u1Id),
    );
    expect(
      await db.memoryMember.findUnique({
        where: { memoryId_userId: { memoryId: mem.id, userId: fx.u1Id } },
      }),
    ).toBeNull();
  });

  it('addMemoryMember is idempotent — re-call upserts the role', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-idempotent', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'reader' },
      userCtx(fx.ownerUserId),
    );
    const second = await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'writer' },
      userCtx(fx.ownerUserId),
    );
    expect(second.memoryMember.role).toBe('writer');
    const rows = await db.memoryMember.findMany({
      where: { memoryId: mem.id, userId: fx.u1Id },
    });
    expect(rows.length).toBe(1);
  });

  it('Memory.members field returns rows for current members; empty for non-members', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-visibility', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: mem.id, userId: fx.u1Id, role: 'reader' },
      userCtx(fx.ownerUserId),
    );
    const m = await db.memory.findUniqueOrThrow({ where: { id: mem.id } });

    // u1 (a member) sees the list.
    const u1Members = await (resolvers.Memory as Record<string, Function>).members(
      m,
      {},
      userCtx(fx.u1Id),
    );
    expect((u1Members as Array<{ userId: string }>).length).toBe(2);

    // u4 (not a member, not an org admin) sees empty.
    const u4Members = await (resolvers.Memory as Record<string, Function>).members(
      m,
      {},
      userCtx(fx.u4Id),
    );
    expect(u4Members).toEqual([]);
  });

  it('two teams in the same org with separate group memories — no cross-read', async () => {
    const teamAlpha = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-alpha', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    const teamBeta = await resolvers.Mutation.createMemory(
      {},
      { orgId: fx.orgId, name: 'team-beta', memoryClass: 'group', visibility: 'GROUP' },
      adminCtx(fx.ownerUserId),
    );
    // u1 → alpha; u2 → beta.
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: teamAlpha.id, userId: fx.u1Id, role: 'writer' },
      userCtx(fx.ownerUserId),
    );
    await resolvers.Mutation.addMemoryMember(
      {},
      { memoryId: teamBeta.id, userId: fx.u2Id, role: 'writer' },
      userCtx(fx.ownerUserId),
    );

    // Cross-reads denied.
    expect(await canRead(teamAlpha.id, fx.u2Id)).toBe(false);
    expect(await canRead(teamBeta.id, fx.u1Id)).toBe(false);
  });
});
