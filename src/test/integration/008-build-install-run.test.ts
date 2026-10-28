/**
 * 008-agent-installation — User Story 1 acceptance test (T043).
 *
 * Walks the build → install → run flow end-to-end:
 *   (a) Bea creates Agent "Mealplan" with declarative knobs.
 *   (b) Org-X explicitly subscribes to Mealplan, then creates an App.
 *   (c) Org-X invites Mike as a member through ensureAppMember.
 *   (d) The App's AI override supersedes the Agent's default for resolution.
 *   (e) maxMembers is enforced at invite-acceptance time (SC-004 cross-check).
 *
 * Per spec.md User Story 1 + Spec FR-001/FR-002/FR-008/FR-009/FR-016.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getPrimaryAgentId } from '../../lib/appAgent.js';
import { db } from '../../integrations/db/client.js';
import {
  cleanDb,
  createDbAppMember,
  createDbAgentOrgGrant,
} from '../helpers.js';
import { generateId } from '../../lib/id.js';
import {
  ensureAppMember,
  MaxMembersExceededError,
} from '../../controller/operations/ensureAppMember.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

let beaOrg: { id: string; urn: string };
let orgX: { id: string; urn: string };
let bea: { id: string };
let mike: { id: string };
let dana: { id: string };

function adminCtx(userId: string, overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  const beaOrgRow = await db.organization.create({
    data: { id: generateId(), name: 'Bea\'s Bakery', urn: 'beas-bakery' },
  });
  const orgXRow = await db.organization.create({
    data: { id: generateId(), name: 'Org X', urn: 'org-x' },
  });
  beaOrg = { id: beaOrgRow.id, urn: beaOrgRow.urn };
  orgX = { id: orgXRow.id, urn: orgXRow.urn };

  bea = await db.user.create({
    data: { id: generateId(), handle: 'bea', githubId: 30001, name: 'Bea' },
  });
  mike = await db.user.create({
    data: { id: generateId(), handle: 'mike', githubId: 30002, name: 'Mike' },
  });
  dana = await db.user.create({
    data: { id: generateId(), handle: 'dana', githubId: 30003, name: 'Dana' },
  });

  // Bea owns her bakery org; Mike + Dana are admins in Org X (so they can
  // both manage the Mealplan App they install).
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: beaOrg.id, userId: bea.id, role: 'OWNER' },
      { id: generateId(), organizationId: orgX.id, userId: mike.id, role: 'OWNER' },
      { id: generateId(), organizationId: orgX.id, userId: dana.id, role: 'ADMIN' },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step (a): Bea creates Mealplan agent
// ─────────────────────────────────────────────────────────────────────────

describe('US1 Step (a): Bea creates Mealplan agent (FR-001 / FR-008 / FR-009)', () => {
  it('persists memoryProvisioning and installationPolicy with the requested values', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      {
        orgId: beaOrg.id,
        name: 'Mealplan',
        description: 'Family meal planner',
        visibility: 'PUBLIC',
      },
      adminCtx(bea.id),
    );
    // Default knobs: memoryProvisioning from the column default; #2171 (R211)
    // a new Agent offers owner and member.
    expect(agent.memoryProvisioning).toEqual({ appMemory: 'shared' });
    expect(agent.installationPolicy).toEqual({
      maxMembers: 'unlimited',
      memberRoles: ['owner', 'member'],
    });

    // Bea then refines the policy. createAgent doesn't take these knobs in
    // the v1 surface; they're set via direct row update post-creation.
    // (A future spec may add explicit args.) The portal does this through
    // the Agent definition view.
    await db.agent.update({
      where: { id: agent.id },
      data: {
        memoryProvisioning: { appMemory: 'shared' },
        installationPolicy: {
          maxMembers: 'unlimited',
          memberRoles: ['owner', 'cook', 'eater'],
        },
      },
    });
    const refined = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect((refined.installationPolicy as { memberRoles: string[] }).memberRoles).toEqual([
      'owner',
      'cook',
      'eater',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step (b): Org-X subscribes before installing cross-org Mealplan
// ─────────────────────────────────────────────────────────────────────────

describe('US1 Step (b): Org-X installs Mealplan via createApp (T032)', () => {
  it('requires an explicit AgentOrgGrant(orgX.id, mealplan.id) before createApp', async () => {
    const mealplan = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Mealplan', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );

    // Pre-state: no grant exists yet.
    const before = await db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: orgX.id, agentId: mealplan.id } },
    });
    expect(before).toBeNull();

    await expect(resolvers.Mutation.createApp(
      {}, { orgRef: orgX.id, agentRef: mealplan.id, name: 'Mealplan @ Org X' }, adminCtx(mike.id),
    )).rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_REQUIRED' } });
    await resolvers.Mutation.createAgentOrgGrant(
      {}, { orgRef: orgX.id, agentRef: mealplan.id }, adminCtx(mike.id),
    );

    // The explicit grant now licenses the App.
    const app = await resolvers.Mutation.createApp(
      {},
      {
        orgRef: orgX.id,
        agentRef: mealplan.id,
        name: 'Mealplan @ Org X',
      },
      adminCtx(mike.id),
    );
    expect((await getPrimaryAgentId(db, app.id))).toBe(mealplan.id);
    expect(app.organizationId).toBe(orgX.id);
    expect(app.surfaces).toEqual(['chat']); // schema default

    const grant = await db.agentOrgGrant.findUniqueOrThrow({
      where: { orgId_agentId: { orgId: orgX.id, agentId: mealplan.id } },
    });
    expect(grant.activatedAt).not.toBeNull();
    expect(grant.revokedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step (c): Org-X invites Mike as 'cook' through ensureAppMember
// ─────────────────────────────────────────────────────────────────────────

describe('US1 Step (c): ensureAppMember adds Mike as a cook (FR-004)', () => {
  it('creates an AppMember with the requested role; AppMember.role validated against installationPolicy.memberRoles', async () => {
    const mealplan = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Mealplan', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );
    await db.agent.update({
      where: { id: mealplan.id },
      data: {
        installationPolicy: {
          maxMembers: 'unlimited',
          memberRoles: ['owner', 'cook', 'eater'],
        },
      },
    });
    await createDbAgentOrgGrant(db, orgX.id, mealplan.id);
    const app = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: mealplan.id, name: 'Mealplan @ Org X' },
      adminCtx(mike.id),
    );

    const member = await resolvers.Mutation.ensureAppMember(
      {},
      { appId: app.id, userId: mike.id, role: 'cook' },
      adminCtx(mike.id),
    );
    expect(member.role).toBe('cook');
    expect(member.appId).toBe(app.id);
    expect(member.userId).toBe(mike.id);

    // Invalid role rejected with InvalidRoleError code on the GraphQL error.
    await expect(
      resolvers.Mutation.ensureAppMember(
        {},
        { appId: app.id, userId: dana.id, role: 'principal' },
        adminCtx(mike.id),
      ),
    ).rejects.toThrow(/Role "principal"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step (d): App AI override supersedes Agent default
// ─────────────────────────────────────────────────────────────────────────

describe('US1 Step (d): App.aiProvider overrides Agent default for that App\'s sessions', () => {
  it('createApp accepts ai* args and stores them on the App row', async () => {
    const mealplan = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Mealplan', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );
    // Bea sets a default AI config on the Agent (the platform-recommended one).
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      {
        agentId: mealplan.id,
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-default',
      },
      adminCtx(bea.id),
    );
    await createDbAgentOrgGrant(db, orgX.id, mealplan.id);

    // Org-X installs and overrides with their own provider.
    const app = await resolvers.Mutation.createApp(
      {},
      {
        orgRef: orgX.id,
        agentRef: mealplan.id,
        name: 'Mealplan @ Org X',
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-4-6',
        aiApiKey: 'sk-orgx-override',
      },
      adminCtx(mike.id),
    );
    // 036-ai-service-config: the App-level override is the App's 'default'
    // registry config; the Agent's own 'default' config is untouched.
    const appConfig = await db.aiServiceConfig.findFirstOrThrow({
      where: { appId: app.id, name: 'default' },
    });
    expect(appConfig.provider).toBe('anthropic');
    expect(appConfig.model).toBe('claude-sonnet-4-6');
    expect(appConfig.apiKeyEncrypted).not.toBeNull();
    expect(appConfig.apiKeyEncrypted).not.toBe('sk-orgx-override'); // encrypted

    // Agent's default config is unchanged.
    const agentConfig = await db.aiServiceConfig.findFirstOrThrow({
      where: { agentId: mealplan.id, name: 'default' },
    });
    expect(agentConfig.provider).toBe('openai');
    expect(agentConfig.model).toBe('gpt-4o');
  });

  it('an unusable legacy AI provider is refused BEFORE the App exists (#1389 review)', async () => {
    const agent = await resolvers.Mutation.createAgent({}, { orgId: beaOrg.id, name: 'Compat', visibility: 'PUBLIC' }, adminCtx(bea.id));
    const before = await db.app.count();
    const err = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: agent.id, name: 'Compat @ Org X', aiProvider: 'openai-compatible', aiModel: 'm', aiApiKey: 'k' },
      adminCtx(mike.id),
    ).catch((e: unknown) => e);
    expect((err as { extensions?: { code?: string } }).extensions?.code).toBe('AiConfigValidationError');
    // Nothing half-made: no App row, so a retry cannot collide with a reserved URN.
    expect(await db.app.count()).toBe(before);
    // A keyless glm through the same legacy args: refused before the App, too.
    const keyless = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: agent.id, name: 'Keyless @ Org X', aiProvider: 'glm', aiModel: 'm' },
      adminCtx(mike.id),
    ).catch((e: unknown) => e);
    expect((keyless as { extensions?: { code?: string } }).extensions?.code).toBe('AiConfigValidationError');
    expect(await db.app.count()).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step (e): maxMembers is enforced at invite-acceptance time (SC-004)
// ─────────────────────────────────────────────────────────────────────────

describe('US1 Step (e): installationPolicy.maxMembers=2 rejects the third member (SC-004)', () => {
  it('Know-Yourself-shaped agent (maxMembers=2) lets 2 members join, blocks the 3rd', async () => {
    const knowYourself = await resolvers.Mutation.createAgent(
      {},
      { orgId: beaOrg.id, name: 'Know Yourself', visibility: 'PUBLIC' },
      adminCtx(bea.id),
    );
    await db.agent.update({
      where: { id: knowYourself.id },
      data: {
        installationPolicy: {
          maxMembers: 2,
          memberRoles: ['principal', 'guide'],
        },
      },
    });
    await createDbAgentOrgGrant(db, orgX.id, knowYourself.id);
    const app = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgX.id, agentRef: knowYourself.id, name: 'KY @ Org X' },
      adminCtx(mike.id),
    );

    await ensureAppMember(db, app.id, mike.id, 'principal');
    await ensureAppMember(db, app.id, dana.id, 'guide');

    const u3 = await db.user.create({
      data: { id: generateId(), handle: 'eric', githubId: 30099, name: 'Eric' },
    });
    await expect(
      ensureAppMember(db, app.id, u3.id, 'guide'),
    ).rejects.toBeInstanceOf(MaxMembersExceededError);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step (f): system memory is read-only from any App context (FR-007 / R-10)
// ─────────────────────────────────────────────────────────────────────────

describe('US1 Step (f): system memory is universally read-only from an App context', () => {
  it('Agent.systemMemory is read-only via getAppMemoryAccess for the installing App', async () => {
    const { getAppMemoryAccess } = await import('../../mcp/access-control.js');

    // Build an Agent with a system memory + attach it.
    const sysMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: beaOrg.id,
        urn: `${beaOrg.urn}:mealplan-sys`,
        name: 'mealplan-sys',
        class: 'system',
      },
    });
    const mealplan = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: beaOrg.id,
        urn: `${beaOrg.urn}:mealplan`,
        name: 'Mealplan',
        visibility: 'PUBLIC',
        systemMemoryId: sysMem.id,
      },
    });
    // Org-X's App is cross-org → it needs an active grant for gate 1 to pass.
    await createDbAgentOrgGrant(db, orgX.id, mealplan.id);
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${orgX.urn}:mealplan`,
        name: 'Mealplan @ Org X',
        appAgents: { create: { agentId: mealplan.id } },
      },
    });
    await createDbAppMember(db, app.id, mike.id, 'owner');

    const access = await getAppMemoryAccess(db, app.id);
    expect(access.get(sysMem.id)).toBe('READ_ONLY');
    // No code path within an App context grants READ_WRITE on system memory
    // — DEVELOP-from-App is dropped per R-10.
  });
});
