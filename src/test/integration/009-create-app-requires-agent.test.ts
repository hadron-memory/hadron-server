/**
 * 009-install-agent-flow — Server contract tests for `createApp`.
 *
 * Per spec.md US2 + contracts/graphql-createApp.md "Test surface":
 *   (a) Same-org install succeeds: App.agentId set, AgentOrgGrant
 *       auto-provisioned, AppMember(installer, 'owner') created.
 *   (b) Multi-install (same Agent, same org, second time): two App rows,
 *       one grant (idempotent), two member rows.
 *   (c) Soft-deleted Agent: resolveAgentRef throws AgentNotFoundError.
 *   (d) Non-ADMIN/OWNER caller: requireOrgRole throws Forbidden.
 *
 * Cross-org install is intentionally NOT gated server-side in 009 (revised
 * mid-implement per research.md R-2): the portal hides the affordance while
 * the server preserves 008's auto-grant behavior. The marketplace spec adds
 * the hard server gate.
 *
 * The "agentId is required" gate is enforced by the GraphQL schema
 * (`agentId: ID!` — the parser rejects requests missing it before the
 * resolver runs). Resolver-direct test calls in this file pass agentId in
 * every case below; coverage of the schema-level rejection lives at the
 * GraphQL execution layer, not here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { AgentNotFoundError } from '../../lib/entityRef/errors.js';

let bea: { id: string };
let beaOrg: { id: string; urn: string };
let outsider: { id: string };

function adminCtx(userId: string, overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId, ...overrides };
}

// Context for a non-admin caller: org-membership is the only authority gate.
function userCtx(userId: string, overrides: Partial<Context> = {}): Context {
  return { db, roles: [], userId, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  const orgRow = await db.organization.create({
    data: { id: generateId(), name: "Bea's Bakery", urn: 'beas-bakery' },
  });
  beaOrg = { id: orgRow.id, urn: orgRow.urn };
  bea = await db.user.create({
    data: { id: generateId(), handle: 'bea', githubId: 90001, name: 'Bea' },
  });
  outsider = await db.user.create({
    data: { id: generateId(), handle: 'outsider', githubId: 90002, name: 'Outsider' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: beaOrg.id, userId: bea.id, role: 'OWNER' },
  });
});

describe('009 createApp install path (same-org)', () => {
  it('succeeds: App.agentId set, AgentOrgGrant auto-provisioned, AppMember(owner) created', async () => {
    const mealplan = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Mealplan', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );

    // Pre-state: no grant, no member.
    expect(
      await db.agentOrgGrant.findUnique({
        where: { orgId_agentId: { orgId: beaOrg.id, agentId: mealplan.id } },
      }),
    ).toBeNull();

    const app = await resolvers.Mutation.createApp(
      {},
      { orgId: beaOrg.id, agentId: mealplan.id, name: 'Mealplan @ Bea' },
      adminCtx(bea.id),
    );

    expect(app.agentId).toBe(mealplan.id);
    expect(app.organizationId).toBe(beaOrg.id);

    const grant = await db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: beaOrg.id, agentId: mealplan.id } },
    });
    expect(grant).not.toBeNull();
    expect(grant!.activatedAt).not.toBeNull();
    expect(grant!.revokedAt).toBeNull();

    const member = await db.appMember.findUnique({
      where: { appId_userId: { appId: app.id, userId: bea.id } },
    });
    expect(member).not.toBeNull();
    expect(member!.role).toBe('owner');
  });

  it('multi-install: two Apps, one grant (idempotent), two member rows', async () => {
    const mealplan = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Mealplan', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );

    const appA = await resolvers.Mutation.createApp(
      {},
      { orgId: beaOrg.id, agentId: mealplan.id, name: 'Mealplan A' },
      adminCtx(bea.id),
    );
    const appB = await resolvers.Mutation.createApp(
      {},
      { orgId: beaOrg.id, agentId: mealplan.id, name: 'Mealplan B' },
      adminCtx(bea.id),
    );

    expect(appA.id).not.toBe(appB.id);
    expect(appA.agentId).toBe(mealplan.id);
    expect(appB.agentId).toBe(mealplan.id);

    const grants = await db.agentOrgGrant.findMany({
      where: { orgId: beaOrg.id, agentId: mealplan.id },
    });
    expect(grants).toHaveLength(1);

    const members = await db.appMember.findMany({
      where: { userId: bea.id, appId: { in: [appA.id, appB.id] } },
    });
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.role === 'owner')).toBe(true);
  });
});

describe('009 createApp install path (rejection cases)', () => {
  it('rejects soft-deleted Agent with AgentNotFoundError', async () => {
    const mealplan = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Mealplan', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );
    await db.agent.update({
      where: { id: mealplan.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      resolvers.Mutation.createApp(
        {},
        { orgId: beaOrg.id, agentId: mealplan.id, name: 'Should Fail' },
        adminCtx(bea.id),
      ),
    ).rejects.toBeInstanceOf(AgentNotFoundError);

    expect(
      await db.app.findFirst({ where: { name: 'Should Fail' } }),
    ).toBeNull();
  });

  it('rejects non-ADMIN/OWNER caller with Forbidden (existing requireOrgRole)', async () => {
    const mealplan = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Mealplan', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );

    await expect(
      resolvers.Mutation.createApp(
        {},
        { orgId: beaOrg.id, agentId: mealplan.id, name: 'Outsider App' },
        // Outsider is not a member of beaOrg, and userCtx has no global
        // ADMIN role bypass — requireOrgRole reaches the OrgMember query.
        userCtx(outsider.id),
      ),
    ).rejects.toThrow(/[Ff]orbidden/);
  });
});
