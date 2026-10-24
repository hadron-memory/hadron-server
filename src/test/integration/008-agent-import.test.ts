import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
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
import { getPrimaryAgentId } from '../../lib/appAgent.js';
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

async function subscribe(orgId: string, ...agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) await createDbAgentOrgGrant(db, orgId, agentId);
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

  // Bea's org gets grants for the dependencies it bundles. Subscriber orgs
  // explicitly license each Agent before installing it (cor:dmo:050:07).
  await createDbAgentOrgGrant(db, beaOrg.id, calendar.id);
  await createDbAgentOrgGrant(db, beaOrg.id, notes.id);
});

// ─────────────────────────────────────────────────────────────────────────
// T062 — cascade install (required vs optional)
// ─────────────────────────────────────────────────────────────────────────

describe('T062: cascade install — required deps cascade; optional deps gate on installOptional', () => {
  it('installs Calendar (required) but NOT Notes (optional) when installOptional is empty', async () => {
    await subscribe(orgX.id, suite.id, calendar.id);
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
      { orgRef: orgX.id, agentRef: suite.id, name: 'Suite @ X' },
      adminCtx(bea.id),
    );
    expect((await getPrimaryAgentId(db, suiteApp.id))).toBe(suite.id);

    const xApps = await db.app.findMany({
      where: { organizationId: orgX.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const agentIds = await Promise.all(
      xApps.map((a) => getPrimaryAgentId(db, a.id)),
    );
    expect(agentIds).toContain(suite.id);
    expect(agentIds).toContain(calendar.id); // required → cascaded
    expect(agentIds).not.toContain(notes.id); // optional → skipped
  });

  it('installs Notes too when installOptional includes Notes', async () => {
    await subscribe(orgX.id, suite.id, calendar.id, notes.id);
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
        orgRef: orgX.id,
        agentRef: suite.id,
        name: 'Suite @ X',
        installOptional: [notes.id],
      },
      adminCtx(bea.id),
    );

    const xApps = await db.app.findMany({
      where: { organizationId: orgX.id, deletedAt: null },
    });
    const agentIds = new Set(
      await Promise.all(xApps.map((a) => getPrimaryAgentId(db, a.id))),
    );
    expect(agentIds).toEqual(new Set([suite.id, calendar.id, notes.id]));
  });

  it('cascade-installed dep Apps use their existing active AgentOrgGrant', async () => {
    await subscribe(orgX.id, suite.id, calendar.id);
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
    });

    await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: suite.id, name: 'Suite @ X' },
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
    await subscribe(orgX.id, suite.id, calendar.id);
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
    });

    // Org X already has a standalone Calendar install.
    const standaloneCalendar = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: calendar.id, name: 'Calendar (standalone)' },
      adminCtx(bea.id),
    );

    // Now install Suite. The cascade should reuse the existing Calendar App
    // rather than creating a second one.
    await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: suite.id, name: 'Suite @ X' },
      adminCtx(bea.id),
    );

    const calendarApps = await db.app.findMany({
      where: { organizationId: orgX.id, appAgents: { some: { agentId: calendar.id } }, deletedAt: null },
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
    await subscribe(orgX.id, suite.id, calendar.id);
    await subscribe(orgY.id, suite.id);
    await publishAgentImport(db, {
      parentAgentId: suite.id,
      importedAgentId: calendar.id,
      position: 100,
    });

    // First install (in Org X) cascades Calendar.
    await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: suite.id, name: 'Suite @ X' },
      adminCtx(bea.id),
    );
    expect(
      await db.app.count({
        where: { organizationId: orgX.id, appAgents: { some: { agentId: calendar.id } }, deletedAt: null },
      }),
    ).toBe(1);

    // Bea removes the import. The existing Apps in Org X are untouched.
    await removeAgentImport(db, suite.id, calendar.id);

    expect(
      await db.app.count({
        where: { organizationId: orgX.id, appAgents: { some: { agentId: calendar.id } }, deletedAt: null },
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
      { orgRef: orgY.id, agentRef: suite.id, name: 'Suite @ Y' },
      adminCtx(bea.id),
    );
    const yCalendarApps = await db.app.findMany({
      where: { organizationId: orgY.id, appAgents: { some: { agentId: calendar.id } }, deletedAt: null },
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
    await subscribe(orgX.id, suite.id, calendar.id, notes.id);
    await subscribe(orgY.id, suite.id, calendar.id);
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
        orgRef: orgX.id,
        agentRef: suite.id,
        name: 'Suite @ X',
        installOptional: [notes.id],
      },
      adminCtx(bea.id),
    );

    const apps = await db.app.findMany({
      where: { organizationId: orgX.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    expect(new Set(await Promise.all(apps.map((a) => getPrimaryAgentId(db, a.id))))).toEqual(
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
      { orgRef: orgY.id, agentRef: suite.id, name: 'Suite @ Y' },
      adminCtx(bea.id),
    );
    const yApps = await db.app.findMany({
      where: { organizationId: orgY.id, deletedAt: null },
    });
    expect(new Set(await Promise.all(yApps.map((a) => getPrimaryAgentId(db, a.id))))).toEqual(
      new Set([suite.id, calendar.id]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #974 — a deleted App's Worker castings keep its URN reserved
// ─────────────────────────────────────────────────────────────────────────

describe('App-tombstone URN reclaim respects Worker castings (#974, cor:agt:020:02)', () => {
  it("refuses WORKER_NAMES_RESERVED while the soft-deleted App still has Worker rows", async () => {
    await subscribe(orgX.id, suite.id);
    // `Worker.appId` is onDelete: Cascade, so hard-deleting the tombstone
    // would silently take the castings with it and recycle their permanently
    // reserved names (PR trailers and chat archives reference them). The
    // reclaim path must refuse instead.
    const retired = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        name: 'Suite @ X',
        urn: `${orgX.urn}:suite-x`, // the slug createApp derives from the name
        deletedAt: new Date(),
      },
    });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: retired.id, agentId: suite.id, name: 'Iris', slug: 'iris' },
    });

    await expect(
      resolvers.Mutation.createApp(
        {},
        { orgRef: orgX.id, agentRef: suite.id, name: 'Suite @ X' },
        adminCtx(bea.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'WORKER_NAMES_RESERVED' } });

    // The tombstone and its casting both survive the refused reclaim.
    expect(await db.app.findUnique({ where: { id: retired.id } })).not.toBeNull();
    expect(await db.worker.count({ where: { appId: retired.id } })).toBe(1);
  });
});
