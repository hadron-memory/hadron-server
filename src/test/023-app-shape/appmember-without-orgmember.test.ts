/**
 * 023-app-shape US2 acceptance test — AppMember without OrgMember.
 *
 * The B2C / therapy / consumer affordance: a user can be an
 * AppMember of an App without being an OrgMember of the App's owning
 * Organization. Daisy enrolls in her therapist's Know Yourself App
 * without joining Org-Therapist; Alice uses MicroMentor's Juno App
 * without being a MicroMentor employee.
 *
 * Covers the quickstart US2 walkthrough:
 *   1. joinApp adds an AppMember row with no OrgMember check (FR-009).
 *   2. AppMember.isOrgExternal === true for an org-external user
 *      (FR-011), and === false for an OrgMember of the App's org.
 *   3. leaveApp deletes the row idempotently (FR-015 — Memory
 *      persistence is verified separately).
 *   4. joinApp is idempotent (no duplicate row).
 *   5. joinApp respects installation_policy.maxMembers via the
 *      reused ensureAppMember helper.
 *
 * The audit of org-scoped resolvers (myOrganizations / Organization.members
 * / org-scoped Memories) for org-external AppMember leak is a focused
 * follow-up — flagged in the spec as FR-010 / T032 but not part of
 * this PR's scope.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { isOrgExternalAppMember } from '../../lib/auth/isOrgExternalAppMember.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixture: the Daisy / Org-Therapist scenario
// ─────────────────────────────────────────────────────────────────────────

interface Fixture {
  orgTherapistId: string;
  orgTherapistUrn: string;
  daisyOrgId: string;
  therapistUserId: string;
  daisyUserId: string;
  knowYourselfAgentId: string;
  therapyAppId: string;
}

async function setupFixture(): Promise<Fixture> {
  const therapistOrg = await db.organization.create({
    data: { id: generateId(), name: 'Org Therapist', urn: 'org-therapist' },
  });
  const daisyOrg = await db.organization.create({
    data: { id: generateId(), name: 'Personal Daisy', urn: 'personal-daisy' },
  });
  const therapist = await db.user.create({
    data: { id: generateId(), handle: 'therapist', githubId: 70001 },
  });
  const daisy = await db.user.create({
    data: { id: generateId(), handle: 'daisy', githubId: 70002 },
  });
  // therapist is OWNER of org-therapist; daisy is OWNER of her personal
  // org but has NO membership in org-therapist.
  await db.orgMember.createMany({
    data: [
      {
        id: generateId(),
        organizationId: therapistOrg.id,
        userId: therapist.id,
        role: 'OWNER',
      },
      {
        id: generateId(),
        organizationId: daisyOrg.id,
        userId: daisy.id,
        role: 'OWNER',
      },
    ],
  });
  const knowYourself = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: therapistOrg.id,
      urn: `${therapistOrg.urn}:know-yourself`,
      name: 'Know Yourself',
      visibility: 'PERSONAL',
      installationPolicy: {
        maxMembers: 'unlimited',
        memberRoles: ['client', 'therapist'],
      },
    },
  });
  const therapyApp = await db.app.create({
    data: {
      id: generateId(),
      organizationId: therapistOrg.id,
      urn: `${therapistOrg.urn}:therapy-app`,
      name: 'Therapy App',
      createdBy: therapist.id,
      appAgents: {
        create: { agentId: knowYourself.id, createdBy: therapist.id },
      },
    },
  });
  return {
    orgTherapistId: therapistOrg.id,
    orgTherapistUrn: therapistOrg.urn,
    daisyOrgId: daisyOrg.id,
    therapistUserId: therapist.id,
    daisyUserId: daisy.id,
    knowYourselfAgentId: knowYourself.id,
    therapyAppId: therapyApp.id,
  };
}

function userCtx(userId: string): Context {
  return { db, userId };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('US2: AppMember without OrgMember', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await setupFixture();
  });

  it('joinApp creates an AppMember without an OrgMember check (FR-009)', async () => {
    // Daisy is NOT an OrgMember of org-therapist. Spec 023 FR-009
    // permits her to be an AppMember of an App in that org anyway.
    const payload = await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    expect(payload.appMember.appId).toBe(fx.therapyAppId);
    expect(payload.appMember.userId).toBe(fx.daisyUserId);
    // Default role is the first value in installation_policy.memberRoles.
    expect(payload.appMember.role).toBe('client');

    const row = await db.appMember.findUnique({
      where: {
        appId_userId: { appId: fx.therapyAppId, userId: fx.daisyUserId },
      },
    });
    expect(row).not.toBeNull();
    expect(row?.role).toBe('client');
  });

  it('joinApp is idempotent — re-joining returns the existing row, role unchanged', async () => {
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    // Manually change role to verify re-join doesn't overwrite it.
    await db.appMember.update({
      where: {
        appId_userId: { appId: fx.therapyAppId, userId: fx.daisyUserId },
      },
      data: { role: 'therapist' },
    });
    const second = await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    expect(second.appMember.role).toBe('therapist');
    const rows = await db.appMember.findMany({
      where: { appId: fx.therapyAppId, userId: fx.daisyUserId },
    });
    expect(rows.length).toBe(1);
  });

  it('joinApp accepts URN as appId', async () => {
    await resolvers.Mutation.joinApp(
      {},
      { appId: `${fx.orgTherapistUrn}:therapy-app` },
      userCtx(fx.daisyUserId),
    );
    const row = await db.appMember.findUnique({
      where: {
        appId_userId: { appId: fx.therapyAppId, userId: fx.daisyUserId },
      },
    });
    expect(row).not.toBeNull();
  });

  it('joinApp rejects unauthenticated callers with UNAUTHENTICATED', async () => {
    let caught: unknown;
    try {
      await resolvers.Mutation.joinApp({}, { appId: fx.therapyAppId }, { db });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('joinApp enforces installation_policy.maxMembers via the typed error', async () => {
    // Tighten the policy to maxMembers=1, then have therapist self-join
    // (consuming the only seat) and confirm Daisy is rejected.
    await db.agent.update({
      where: { id: fx.knowYourselfAgentId },
      data: {
        installationPolicy: {
          maxMembers: 1,
          memberRoles: ['client'],
        },
      },
    });
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.therapistUserId),
    );
    let caught: unknown;
    try {
      await resolvers.Mutation.joinApp(
        {},
        { appId: fx.therapyAppId },
        userCtx(fx.daisyUserId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('MaxMembersExceededError');
  });

  it('AppMember.isOrgExternal is true for an org-external User (FR-011)', async () => {
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    const row = await db.appMember.findUniqueOrThrow({
      where: {
        appId_userId: { appId: fx.therapyAppId, userId: fx.daisyUserId },
      },
    });
    const isExternal = await (resolvers.AppMember as Record<string, Function>)
      .isOrgExternal(row, {}, userCtx(fx.daisyUserId));
    expect(isExternal).toBe(true);
  });

  it('AppMember.isOrgExternal is false for an OrgMember of the App org', async () => {
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.therapistUserId),
    );
    const row = await db.appMember.findUniqueOrThrow({
      where: {
        appId_userId: { appId: fx.therapyAppId, userId: fx.therapistUserId },
      },
    });
    const isExternal = await (resolvers.AppMember as Record<string, Function>)
      .isOrgExternal(row, {}, userCtx(fx.therapistUserId));
    expect(isExternal).toBe(false);
  });

  it('isOrgExternalAppMember predicate verifies BOTH AppMember-exists AND OrgMember-absent', async () => {
    // Without an AppMember row, the predicate is false even though
    // daisy is not an OrgMember of org-therapist. This matches the
    // function's name: "org-external **AppMember**" — both halves
    // must hold.
    expect(
      await isOrgExternalAppMember(db, {
        userId: fx.daisyUserId,
        appId: fx.therapyAppId,
        organizationId: fx.orgTherapistId,
      }),
    ).toBe(false);

    // Add the AppMember row → predicate flips to true.
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    expect(
      await isOrgExternalAppMember(db, {
        userId: fx.daisyUserId,
        appId: fx.therapyAppId,
        organizationId: fx.orgTherapistId,
      }),
    ).toBe(true);

    // therapist joining their own App stays "not org-external" because
    // they're an OrgMember of the App's owning org.
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.therapistUserId),
    );
    expect(
      await isOrgExternalAppMember(db, {
        userId: fx.therapistUserId,
        appId: fx.therapyAppId,
        organizationId: fx.orgTherapistId,
      }),
    ).toBe(false);

    // organizationId is optional — works without it.
    expect(
      await isOrgExternalAppMember(db, {
        userId: fx.daisyUserId,
        appId: fx.therapyAppId,
      }),
    ).toBe(true);
  });

  it('leaveApp deletes the AppMember row idempotently', async () => {
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    const payload = await resolvers.Mutation.leaveApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    expect(payload.appId).toBe(fx.therapyAppId);
    expect(payload.userId).toBe(fx.daisyUserId);
    expect(
      await db.appMember.findUnique({
        where: {
          appId_userId: { appId: fx.therapyAppId, userId: fx.daisyUserId },
        },
      }),
    ).toBeNull();
    // Idempotent re-call — succeeds even though row is gone.
    await expect(
      resolvers.Mutation.leaveApp(
        {},
        { appId: fx.therapyAppId },
        userCtx(fx.daisyUserId),
      ),
    ).resolves.toMatchObject({ appId: fx.therapyAppId, userId: fx.daisyUserId });
  });

  it('leaveApp preserves the user\'s personal-class Memory (FR-015 orphan retention)', async () => {
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    // Daisy has a personal-class Memory in the App (the kind the chat
    // flow would auto-provision). Create it directly so the test
    // doesn't depend on the chat path.
    const personalMemory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgTherapistId,
        urn: `${fx.therapyAppId}:daisy-personal`,
        name: 'daisy personal',
        class: 'personal',
        visibility: null,
        userId: fx.daisyUserId,
        appId: fx.therapyAppId,
        userMemoryOfAgentId: fx.knowYourselfAgentId,
      },
    });

    await resolvers.Mutation.leaveApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );

    // FR-015: Memory persists as an orphan.
    const stillThere = await db.memory.findUnique({ where: { id: personalMemory.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.userId).toBe(fx.daisyUserId);
  });

  it('leaveApp rejects unauthenticated callers with UNAUTHENTICATED', async () => {
    let caught: unknown;
    try {
      await resolvers.Mutation.leaveApp({}, { appId: fx.therapyAppId }, { db });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('joinApp surfaces NoMemberRolesError when the policy has no roles', async () => {
    await db.agent.update({
      where: { id: fx.knowYourselfAgentId },
      data: {
        installationPolicy: { maxMembers: 'unlimited', memberRoles: [] },
      },
    });
    let caught: unknown;
    try {
      await resolvers.Mutation.joinApp(
        {},
        { appId: fx.therapyAppId },
        userCtx(fx.daisyUserId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('NoMemberRolesError');
  });

  it('joinApp throws AppNotFoundError when a stale AppMember row exists for a soft-deleted App', async () => {
    // First join Daisy successfully, then soft-delete the App. The
    // existing AppMember row should NOT be returned as a stale success
    // — joinApp's pre-checks reject the soft-deleted App.
    await resolvers.Mutation.joinApp(
      {},
      { appId: fx.therapyAppId },
      userCtx(fx.daisyUserId),
    );
    await db.app.update({
      where: { id: fx.therapyAppId },
      data: { deletedAt: new Date() },
    });
    let caught: unknown;
    try {
      await resolvers.Mutation.joinApp(
        {},
        { appId: fx.therapyAppId },
        userCtx(fx.daisyUserId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    // resolveAppRef catches soft-deleted Apps before joinApp runs, so
    // the surfaced code is AppNotFoundError (resolveAppRef's path),
    // not the controller's redundant check. Either way, the user-
    // visible behavior is "App not found" rather than "stale row
    // returned" — that's what matters.
    expect((caught as GraphQLError).extensions?.code).toBe('AppNotFoundError');
  });
});
