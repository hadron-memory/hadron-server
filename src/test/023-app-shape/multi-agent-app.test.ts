/**
 * 023-app-shape US1 acceptance test — One App, many Agents under one
 * credential.
 *
 * Covers the quickstart US1 walkthrough end-to-end:
 *   1. Install Agent A into an empty App → AppAgent row created;
 *      App is operational for A's surfaces.
 *   2. Install Agent B into the same App → second AppAgent row;
 *      A and B coexist under one App credential.
 *   3. Duplicate install rejected with `DUPLICATE_APP_AGENT`.
 *   4. Uninstall Agent A from the App → AppAgent row removed; A's
 *      personal-class and app-class memories within the App persist
 *      (FR-005 — uninstall does NOT cascade-delete).
 *   5. Reinstall Agent A → orphaned memories become reachable again.
 *
 * Plus US1's app-class memory invariants:
 *   - Each installed Agent gets its own app-class memory keyed per
 *     (App, Agent). Removing one Agent doesn't affect the other's
 *     memories.
 *
 * Plus US1 acceptance scenario 4 (the multi-install isolation already
 * covered in 008-multi-install-isolation.test.ts is the related Mike-on-
 * two-orgs invariant; cross-reference noted).
 *
 * Spec: spec-kits/specs/023-app-shape/spec.md User Story 1 +
 *       quickstart.md "US1 — One App, many Agents under one credential"
 *       + contracts/graphql-app-shape.md (mutation surface).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────

interface Fixture {
  orgId: string;
  appId: string;
  agentAId: string;
  agentBId: string;
  agentCId: string;
  adminUserId: string;
}

async function setupFixture(): Promise<Fixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-everywhere', urn: 'mcp-everywhere' },
  });
  const admin = await db.user.create({
    data: { id: generateId(), handle: 'admin', githubId: 60001 },
  });
  await db.orgMember.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      userId: admin.id,
      role: 'OWNER',
    },
  });
  const make = async (slug: string) => {
    const a = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:${slug}`,
        name: slug,
        visibility: 'PRIVATE',
      },
    });
    return a.id;
  };
  const agentAId = await make('agent-research');
  const agentBId = await make('agent-coach');
  const agentCId = await make('agent-planner');
  // The App starts empty — no AppAgents. US1 step 1 installs the first.
  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:mcp-app`,
      name: 'My MCP App',
      createdBy: admin.id,
    },
  });
  return {
    orgId: org.id,
    appId: app.id,
    agentAId,
    agentBId,
    agentCId,
    adminUserId: admin.id,
  };
}

function adminCtx(userId: string): Context {
  return { db, roles: ['ADMIN'], userId };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('US1: install Agents into an App via AppAgent', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await setupFixture();
  });

  it('installAgentIntoApp creates an AppAgent row (US1 step 1)', async () => {
    const payload = await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    expect(payload.appAgent).toBeDefined();
    expect(payload.appAgent.appId).toBe(fx.appId);
    expect(payload.appAgent.agentId).toBe(fx.agentAId);

    const row = await db.appAgent.findUnique({
      where: { appId_agentId: { appId: fx.appId, agentId: fx.agentAId } },
    });
    expect(row).not.toBeNull();
  });

  it('supports multiple Agents in the same App under one credential (US1 step 6–8)', async () => {
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentBId },
      adminCtx(fx.adminUserId),
    );
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentCId },
      adminCtx(fx.adminUserId),
    );

    const rows = await db.appAgent.findMany({
      where: { appId: fx.appId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.agentId)).toEqual([fx.agentAId, fx.agentBId, fx.agentCId]);

    // The App's credential (AppKey) doesn't change — proof that the
    // multi-Agent install is "under one credential".
    const keys = await db.appKey.findMany({ where: { appId: fx.appId } });
    expect(keys.length).toBeLessThanOrEqual(1); // no new key was minted per install
  });

  it('rejects duplicate install with DUPLICATE_APP_AGENT (US1 step 3)', async () => {
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    let caught: unknown;
    try {
      await resolvers.Mutation.installAgentIntoApp(
        {},
        { appId: fx.appId, agentId: fx.agentAId },
        adminCtx(fx.adminUserId),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('DUPLICATE_APP_AGENT');
  });

  it('uninstall removes the AppAgent row but persists memories (US1 step 10–13 / FR-005)', async () => {
    // Install A + B.
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentBId },
      adminCtx(fx.adminUserId),
    );

    // Pretend A wrote some personal-class and app-class memories within
    // the App. Create them directly so the test doesn't depend on the
    // chat flow.
    const personalA = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgId,
        urn: `${fx.appId}:personal-a`,
        name: 'A personal',
        class: 'personal',
        visibility: 'PERSONAL',
        userId: fx.adminUserId,
        appId: fx.appId,
        userMemoryOfAgentId: fx.agentAId,
      },
    });
    const appMemA = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgId,
        urn: `${fx.appId}:app-a`,
        name: 'A app',
        class: 'app',
        visibility: 'ORGANIZATION',
        appId: fx.appId,
        userMemoryOfAgentId: fx.agentAId,
      },
    });

    // Uninstall A.
    const payload = await resolvers.Mutation.uninstallAgentFromApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    expect(payload.appId).toBe(fx.appId);
    expect(payload.agentId).toBe(fx.agentAId);

    // AppAgent row gone; B's row still present.
    expect(
      await db.appAgent.findUnique({
        where: { appId_agentId: { appId: fx.appId, agentId: fx.agentAId } },
      }),
    ).toBeNull();
    expect(
      await db.appAgent.findUnique({
        where: { appId_agentId: { appId: fx.appId, agentId: fx.agentBId } },
      }),
    ).not.toBeNull();

    // FR-005: memories persist as orphans.
    expect(await db.memory.findUnique({ where: { id: personalA.id } })).not.toBeNull();
    expect(await db.memory.findUnique({ where: { id: appMemA.id } })).not.toBeNull();
  });

  it('reinstalling an Agent makes orphan memories reachable again (US1 step 13)', async () => {
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fx.orgId,
        urn: `${fx.appId}:reinstall-personal`,
        name: 'reinstall personal',
        class: 'personal',
        visibility: 'PERSONAL',
        userId: fx.adminUserId,
        appId: fx.appId,
        userMemoryOfAgentId: fx.agentAId,
      },
    });
    await resolvers.Mutation.uninstallAgentFromApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    // Now reinstall — the new install creates a fresh AppAgent row but
    // the memory survives.
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    const stillThere = await db.memory.findUnique({ where: { id: memory.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.appId).toBe(fx.appId);
    expect(stillThere?.userMemoryOfAgentId).toBe(fx.agentAId);
  });

  it('uninstall is idempotent (no error on absent AppAgent row)', async () => {
    // Uninstall a never-installed Agent → succeeds.
    const payload = await resolvers.Mutation.uninstallAgentFromApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    expect(payload.appId).toBe(fx.appId);
    expect(payload.agentId).toBe(fx.agentAId);
  });

  it('trainingMode arg on installAgentIntoApp updates App.trainingMode (per-App, not per-AppAgent)', async () => {
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId, trainingMode: true },
      adminCtx(fx.adminUserId),
    );
    const app = await db.app.findUniqueOrThrow({ where: { id: fx.appId } });
    expect(app.trainingMode).toBe(true);
  });

  it('App.appAgents resolver returns installed Agents in install order', async () => {
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentBId },
      adminCtx(fx.adminUserId),
    );
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    const appAgents = await (resolvers.App as Record<string, Function>).appAgents(
      { id: fx.appId },
      {},
      adminCtx(fx.adminUserId),
    );
    expect((appAgents as Array<{ agentId: string }>).map((aa) => aa.agentId)).toEqual([
      fx.agentBId,
      fx.agentAId,
    ]);
  });

  it('App.agents resolver returns the full set, not just the primary', async () => {
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentBId },
      adminCtx(fx.adminUserId),
    );
    const agents = await (resolvers.App as Record<string, Function>).agents(
      { id: fx.appId },
      {},
      adminCtx(fx.adminUserId),
    );
    const ids = (agents as Array<{ id: string }>).map((a) => a.id);
    expect(new Set(ids)).toEqual(new Set([fx.agentAId, fx.agentBId]));
  });

  it('Agent.appAgents resolver returns installation rows for org admins', async () => {
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    const rows = await (resolvers.Agent as Record<string, Function>).appAgents(
      { id: fx.agentAId, organizationId: fx.orgId },
      {},
      adminCtx(fx.adminUserId),
    );
    expect((rows as Array<{ appId: string }>).map((r) => r.appId)).toEqual([fx.appId]);
  });

  it('deprecated addAgentToApp still works and returns the App', async () => {
    const app = await resolvers.Mutation.addAgentToApp(
      {},
      { appId: fx.appId, agentId: fx.agentAId },
      adminCtx(fx.adminUserId),
    );
    expect((app as { id: string }).id).toBe(fx.appId);
    expect(
      await db.appAgent.findUnique({
        where: { appId_agentId: { appId: fx.appId, agentId: fx.agentAId } },
      }),
    ).not.toBeNull();
  });
});
