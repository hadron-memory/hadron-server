/**
 * 008-agent-installation — User Story 3 (T062–T065).
 *
 * The Suite/Calendar/Notes scenario: a parent Agent ("Productivity Suite")
 * imports two deps. Installing the parent cascades installs of required
 * deps; optional deps install only when the caller opts in. Reusing an
 * existing App for the same (org, dep) is the v1 contract (one install
 * per (org, Agent) pair — no per-bundle namespacing).
 *
 * Verifies SC-006 (publish-time grant gate), the cascade behavior, the
 * existing-App reuse, and the no-effect-on-existing-Apps semantics of
 * removeAgentImport.
 *
 * Per spec.md User Story 3 + FR-005 / FR-024-ish.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import {
  cleanDb,
  createDbAgentOrgGrant,
  createDbAgentImport,
} from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { publishAgentImport } from '../../controller/operations/publishAgentImport.js';
import { removeAgentImport } from '../../controller/operations/removeAgentImport.js';

let bea: { id: string };
let beaOrg: { id: string; urn: string };
let orgX: { id: string; urn: string };
let orgY: { id: string; urn: string };
let suite: { id: string; urn: string };
let calendar: { id: string; urn: string };
let notes: { id: string; urn: string };

function adminCtx(userId: string, organizationId?: string): Context {
  return { db, roles: ['ADMIN'], userId, organizationId };
}

beforeEach(async () => {
  await cleanDb(db);

  const beaOrgRow = await db.organization.create({
    data: { id: generateId(), name: 'Bea Org', urn: 'bea-org' },
  });
  const orgXRow = await db.organization.create({
    data: { id: generateId(), name: 'Org X', urn: 'org-x' },
  });
  const orgYRow = await db.organization.create({
    data: { id: generateId(), name: 'Org Y', urn: 'org-y' },
  });
  beaOrg = { id: beaOrgRow.id, urn: beaOrgRow.urn };
  orgX = { id: orgXRow.id, urn: orgXRow.urn };
  orgY = { id: orgYRow.id, urn: orgYRow.urn };

  bea = await db.user.create({
    data: { id: generateId(), handle: 'bea', githubId: 90001 },
  });
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: beaOrg.id, userId: bea.id, role: 'OWNER' },
      // Bea is also an admin in Org X / Y so the createApp resolver passes
      // its requireOrgRole check during install.
      { id: generateId(), organizationId: orgX.id, userId: bea.id, role: 'ADMIN' },
      { id: generateId(), organizationId: orgY.id, userId: bea.id, role: 'ADMIN' },
    ],
  });

  // Three Agents in Bea's org. Suite imports Calendar (required) and Notes
  // (optional). All public so other orgs can install them.
  const make = async (slug: string) => {
    const a = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: beaOrg.id,
        urn: `${beaOrg.urn}:${slug}`,
        name: slug,
        visibility: 'PUBLIC',
      },
    });
    return { id: a.id, urn: a.urn };
  };
  suite = await make('suite');
  calendar = await make('calendar');
  notes = await make('notes');

  // Bea's org gets grants for its own Agents (same-org auto-provisioning;
  // ensureAgentOrgGrant would do this on first contact, but seeding it
  // directly skips that resolver call here).
  await createDbAgentOrgGrant(db, beaOrg.id, calendar.id);
  await createDbAgentOrgGrant(db, beaOrg.id, notes.id);
});

// ─────────────────────────────────────────────────────────────────────────
// T062 — cascade install (required vs optional)
// ─────────────────────────────────────────────────────────────────────────

describe('T062: cascade install — required deps cascade; optional deps gate on installOptional', () => {
  it('installs Calendar (required) but NOT Notes (optional) when installOptional is empty', async () => {
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
      required: true,
    });
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: notes.id,
      position: 200,
      required: false,
    });

    // Org X installs Suite without opting into Notes.
    const suiteApp = await resolvers.Mutation.createApp(
      {},
      { orgId: orgX.id, agentId: suite.id, name: 'Suite @ X' },
      adminCtx(bea.id),
    );
    expect(suiteApp.agentId).toBe(suite.id);

    const xApps = await db.app.findMany({
      where: { organizationId: orgX.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const agentIds = xApps.map((a) => a.agentId);
    expect(agentIds).toContain(suite.id);
    expect(agentIds).toContain(calendar.id); // required → cascaded
    expect(agentIds).not.toContain(notes.id); // optional → skipped
  });

  it('installs Notes too when installOptional includes Notes', async () => {
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
      required: true,
    });
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: notes.id,
      position: 200,
      required: false,
    });

    await resolvers.Mutation.createApp(
      {},
      {
        orgId: orgX.id,
        agentId: suite.id,
        name: 'Suite @ X',
        installOptional: [notes.id],
      },
      adminCtx(bea.id),
    );

    const xApps = await db.app.findMany({
      where: { organizationId: orgX.id, deletedAt: null },
    });
    const agentIds = new Set(xApps.map((a) => a.agentId));
    expect(agentIds).toEqual(new Set([suite.id, calendar.id, notes.id]));
  });

  it('cascade-installed dep Apps get an auto-provisioned AgentOrgGrant', async () => {
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
    });

    await resolvers.Mutation.createApp(
      {},
      { orgId: orgX.id, agentId: suite.id, name: 'Suite @ X' },
      adminCtx(bea.id),
    );

    // Both grants exist + active.
    const suiteGrant = await db.agentOrgGrant.findUniqueOrThrow({
      where: { orgId_agentId: { orgId: orgX.id, agentId: suite.id } },
    });
    const calendarGrant = await db.agentOrgGrant.findUniqueOrThrow({
      where: { orgId_agentId: { orgId: orgX.id, agentId: calendar.id } },
    });
    expect(suiteGrant.activatedAt).not.toBeNull();
    expect(calendarGrant.activatedAt).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T063 — existing-App reuse: one install per (org, dep agent)
// ─────────────────────────────────────────────────────────────────────────

describe('T063: cascade reuses an existing App in the same org for the same dep', () => {
  it('does not create a second Calendar App when Org X already has one', async () => {
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
    });

    // Org X already has a standalone Calendar install.
    const standaloneCalendar = await resolvers.Mutation.createApp(
      {},
      { orgId: orgX.id, agentId: calendar.id, name: 'Calendar (standalone)' },
      adminCtx(bea.id),
    );

    // Now install Suite. The cascade should reuse the existing Calendar App
    // rather than creating a second one.
    await resolvers.Mutation.createApp(
      {},
      { orgId: orgX.id, agentId: suite.id, name: 'Suite @ X' },
      adminCtx(bea.id),
    );

    const calendarApps = await db.app.findMany({
      where: { organizationId: orgX.id, agentId: calendar.id, deletedAt: null },
    });
    expect(calendarApps.length).toBe(1);
    expect(calendarApps[0].id).toBe(standaloneCalendar.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T064 — removeAgentImport: existing Apps unaffected; future installs skip
// ─────────────────────────────────────────────────────────────────────────

describe('T064: removeAgentImport leaves existing Apps in place; future installs skip the dep', () => {
  it('Apps already cascaded continue to function; new installs into other orgs do NOT cascade', async () => {
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
    });

    // First install (in Org X) cascades Calendar.
    await resolvers.Mutation.createApp(
      {},
      { orgId: orgX.id, agentId: suite.id, name: 'Suite @ X' },
      adminCtx(bea.id),
    );
    expect(
      await db.app.count({
        where: { organizationId: orgX.id, agentId: calendar.id, deletedAt: null },
      }),
    ).toBe(1);

    // Bea removes the import. The existing Apps in Org X are untouched.
    await removeAgentImport(db, suite.id, calendar.id);

    expect(
      await db.app.count({
        where: { organizationId: orgX.id, agentId: calendar.id, deletedAt: null },
      }),
    ).toBe(1);
    // The AgentImport edge is gone.
    const remaining = await db.agentImport.findMany({
      where: { parentAgentId: suite.id },
    });
    expect(remaining.length).toBe(0);

    // A new install into Org Y does NOT cascade Calendar (the import edge
    // is gone).
    await resolvers.Mutation.createApp(
      {},
      { orgId: orgY.id, agentId: suite.id, name: 'Suite @ Y' },
      adminCtx(bea.id),
    );
    const yCalendarApps = await db.app.findMany({
      where: { organizationId: orgY.id, agentId: calendar.id, deletedAt: null },
    });
    expect(yCalendarApps.length).toBe(0);
  });

  it('removeAgentImport is idempotent (deleting a missing edge is a no-op)', async () => {
    // No edge exists; remove should not throw.
    await expect(
      removeAgentImport(db, suite.id, calendar.id),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T065 — integration: full Suite/Calendar/Notes scenario (SC-006)
// ─────────────────────────────────────────────────────────────────────────

describe('T065: integration — full Suite/Calendar/Notes scenario (SC-006)', () => {
  it('publishing Suite without a grant for Calendar fails; with the grant, Org X gets cascaded installs', async () => {
    // SC-006: publish-time grant gate. Drop the calendar grant first so
    // Bea has no license to bundle Calendar. Publishing should fail.
    await db.agentOrgGrant.delete({
      where: { orgId_agentId: { orgId: beaOrg.id, agentId: calendar.id } },
    });
    await expect(
      publishAgentImport(db, {
        parentAgentId: suite.id,
        importedAgentId: calendar.id,
        position: 100,
      }),
    ).rejects.toThrow(/license to bundle/);

    // Restore the grant. Publish succeeds.
    await createDbAgentOrgGrant(db, beaOrg.id, calendar.id);
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
      required: true,
    });
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: notes.id,
      position: 200,
      required: false,
    });

    // Org X installs Suite with Notes opted-in.
    await resolvers.Mutation.createApp(
      {},
      {
        orgId: orgX.id,
        agentId: suite.id,
        name: 'Suite @ X',
        installOptional: [notes.id],
      },
      adminCtx(bea.id),
    );

    const apps = await db.app.findMany({
      where: { organizationId: orgX.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    expect(new Set(apps.map((a) => a.agentId))).toEqual(
      new Set([suite.id, calendar.id, notes.id]),
    );

    // The full picture for Org X: 3 Apps, 3 grants, all consistent.
    const grants = await db.agentOrgGrant.findMany({
      where: { orgId: orgX.id },
    });
    expect(new Set(grants.map((g) => g.agentId))).toEqual(
      new Set([suite.id, calendar.id, notes.id]),
    );

    // Org Y installs Suite without opting into Notes — only Suite + Calendar.
    await resolvers.Mutation.createApp(
      {},
      { orgId: orgY.id, agentId: suite.id, name: 'Suite @ Y' },
      adminCtx(bea.id),
    );
    const yApps = await db.app.findMany({
      where: { organizationId: orgY.id, deletedAt: null },
    });
    expect(new Set(yApps.map((a) => a.agentId))).toEqual(
      new Set([suite.id, calendar.id]),
    );
  });
});
