/**
 * 036-ai-service-config — integration tests.
 *
 * Covers, per tasks.md:
 *  - T009  DB invariants: chk_ai_service_config_owner + partial unique
 *          (owner, name) indexes (Constitution S5 regression guard).
 *  - T012  US1: resolveAIConfig precedence matrix (App > Agent > Org >
 *          Host), disabled-skip, absent-level skip, fallback + typed
 *          error, auth gates, effective-org selection.
 *  - T015  US2: CRUD per owner level, duplicate-name rejection, masked
 *          exposure on every management response (SC-003), key-preserve
 *          on update, auth matrix.
 *  - T018  US3: legacy shims (updateAgentAIConfig / clearAgentAIConfig /
 *          agentAIConfig / appAIConfig / field resolvers) over the
 *          registry, incl. the fresh-migration "nothing configured" state.
 *  - T019  US4: consumer name-reference contract (hit, miss→default,
 *          miss→NoAiConfigAvailableError).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';

import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { decryptToken, encryptToken } from '../../lib/tokenCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let outsider: { id: string };
let agent: { id: string };
let app: { id: string };
let server: { id: string };

function ctxFor(userId: string, overrides: Partial<Context> = {}): Context {
  return { db, roles: [], userId, ...overrides };
}

function platformAdminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

async function createConfig(
  owner: { agentId?: string; appId?: string; organizationId?: string; hadronServerId?: string },
  name: string,
  opts: { provider?: string; model?: string; apiKey?: string | null; enabled?: boolean } = {},
) {
  return db.aiServiceConfig.create({
    data: {
      ...owner,
      name,
      provider: opts.provider ?? 'anthropic',
      model: opts.model ?? 'claude-opus-4-6',
      ...(opts.apiKey === null
        ? {}
        : {
            apiKeyEncrypted: encryptToken(opts.apiKey ?? `sk-${name}-${Object.keys(owner)[0]}`),
            apiKeyPreview: '…test',
          }),
      enabled: opts.enabled ?? true,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const orgRow = await db.organization.create({
    data: { id: generateId(), name: 'Acme', urn: 'acme-036' },
  });
  const otherOrgRow = await db.organization.create({
    data: { id: generateId(), name: 'Rival', urn: 'rival-036' },
  });
  org = { id: orgRow.id };
  otherOrg = { id: otherOrgRow.id };
  admin = await db.user.create({
    data: { id: generateId(), handle: 'cfg-admin', githubId: 36001, name: 'Admin' },
  });
  outsider = await db.user.create({
    data: { id: generateId(), handle: 'cfg-outsider', githubId: 36002, name: 'Outsider' },
  });
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: otherOrg.id, userId: outsider.id, role: 'ADMIN' },
    ],
  });
  agent = await db.agent.create({
    data: { id: generateId(), name: 'Juno', urn: 'acme-036:juno', organizationId: org.id },
  });
  app = await db.app.create({
    data: { id: generateId(), name: 'Juno @ Acme', urn: 'acme-036:juno-app', organizationId: org.id },
  });
  server = await db.hadronServer.create({
    data: { id: generateId(), url: 'https://test.hadron.local' },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T009 — DB invariants (Constitution S5)
// ─────────────────────────────────────────────────────────────────────────

describe('DB invariants', () => {
  it('chk_ai_service_config_owner exists in the test schema', async () => {
    const rows = await db.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname = 'chk_ai_service_config_owner'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a config with zero owners', async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO ai_service_configs (id, name, provider, model) VALUES ('x036a', 'default', 'anthropic', 'm')`,
      ),
    ).rejects.toThrow(/chk_ai_service_config_owner/);
  });

  it('rejects a config with two owners', async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO ai_service_configs (id, name, provider, model, agent_id, app_id)
         VALUES ('x036b', 'default', 'anthropic', 'm', '${agent.id}', '${app.id}')`,
      ),
    ).rejects.toThrow(/chk_ai_service_config_owner/);
  });

  it('rejects a duplicate (owner, name) via the partial unique index', async () => {
    await createConfig({ agentId: agent.id }, 'fast');
    await expect(createConfig({ agentId: agent.id }, 'fast')).rejects.toThrow();
    // Same name on a different owner is fine.
    await expect(createConfig({ appId: app.id }, 'fast')).resolves.toBeTruthy();
  });

  it('cascades config deletion when the owner entity is deleted (FR-016)', async () => {
    await createConfig({ appId: app.id }, 'default');
    await db.app.delete({ where: { id: app.id } });
    expect(await db.aiServiceConfig.findFirst({ where: { appId: app.id } })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T012 — US1: resolution precedence
// ─────────────────────────────────────────────────────────────────────────

describe('resolveAIConfig precedence (US1)', () => {
  it('App-level config wins over Agent, Org, and Host for the same name', async () => {
    await createConfig({ appId: app.id }, 'default', { apiKey: 'sk-app' });
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-agent' });
    await createConfig({ organizationId: org.id }, 'default', { apiKey: 'sk-org' });
    await createConfig({ hadronServerId: server.id }, 'default', { apiKey: 'sk-host' });

    const resolved = await resolvers.Query.resolveAIConfig(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(resolved.ownerType).toBe('APP');
    expect(resolved.apiKey).toBe('sk-app');
  });

  it('falls back outward level by level as inner configs disappear', async () => {
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-agent' });
    await createConfig({ organizationId: org.id }, 'default', { apiKey: 'sk-org' });
    await createConfig({ hadronServerId: server.id }, 'default', { apiKey: 'sk-host' });

    const viaAgent = await resolvers.Query.resolveAIConfig(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(viaAgent.ownerType).toBe('AGENT');
    expect(viaAgent.apiKey).toBe('sk-agent');

    await db.aiServiceConfig.deleteMany({ where: { agentId: agent.id } });
    const viaOrg = await resolvers.Query.resolveAIConfig(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(viaOrg.ownerType).toBe('ORGANIZATION');
    expect(viaOrg.apiKey).toBe('sk-org');

    await db.aiServiceConfig.deleteMany({ where: { organizationId: org.id } });
    const viaHost = await resolvers.Query.resolveAIConfig(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(viaHost.ownerType).toBe('HADRON_SERVER');
    expect(viaHost.apiKey).toBe('sk-host');
  });

  it('skips a disabled config and continues outward (FR-008)', async () => {
    await createConfig({ appId: app.id }, 'default', { apiKey: 'sk-app', enabled: false });
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-agent' });
    const resolved = await resolvers.Query.resolveAIConfig(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(resolved.ownerType).toBe('AGENT');
  });

  it('agent-only context consults the Agent org (FR-017 absent-level skip)', async () => {
    await createConfig({ organizationId: org.id }, 'default', { apiKey: 'sk-org' });
    const resolved = await resolvers.Query.resolveAIConfig(
      {},
      { agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(resolved.ownerType).toBe('ORGANIZATION');
  });

  it('App context consults the App org, not the Agent builder org (Juno pattern)', async () => {
    // Agent lives in otherOrg (the builder); App installs it in org.
    const foreignAgent = await db.agent.create({
      data: { id: generateId(), name: 'Foreign', urn: 'rival-036:foreign', organizationId: otherOrg.id },
    });
    await createConfig({ organizationId: org.id }, 'default', { apiKey: 'sk-install-org' });
    await createConfig({ organizationId: otherOrg.id }, 'default', { apiKey: 'sk-builder-org' });
    const resolved = await resolvers.Query.resolveAIConfig(
      {},
      { appRef: app.id, agentRef: foreignAgent.id },
      ctxFor(admin.id),
    );
    expect(resolved.apiKey).toBe('sk-install-org');
  });

  it('explicit name miss falls back to default; default miss is the typed error (FR-007)', async () => {
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-default' });
    const fallback = await resolvers.Query.resolveAIConfig(
      {},
      { name: 'fast', agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(fallback.name).toBe('default');

    await db.aiServiceConfig.deleteMany({});
    await expect(
      resolvers.Query.resolveAIConfig({}, { name: 'fast', agentRef: agent.id }, ctxFor(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'NoAiConfigAvailableError' } });
  });

  it('a resolvable config without a key is unusable (typed error, no key material)', async () => {
    await createConfig({ agentId: agent.id }, 'default', { apiKey: null });
    await expect(
      resolvers.Query.resolveAIConfig({}, { agentRef: agent.id }, ctxFor(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'NoAiConfigAvailableError' } });
  });

  it('denies non-admins of the effective org, and host-only contexts to non-platform-admins', async () => {
    await createConfig({ agentId: agent.id }, 'default');
    await expect(
      resolvers.Query.resolveAIConfig({}, { agentRef: agent.id }, ctxFor(outsider.id)),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      resolvers.Query.resolveAIConfig({}, {}, ctxFor(admin.id)),
    ).rejects.toThrow(/Forbidden/);
    // Platform admin may resolve host-only contexts.
    await createConfig({ hadronServerId: server.id }, 'default', { apiKey: 'sk-host' });
    const resolved = await resolvers.Query.resolveAIConfig({}, {}, platformAdminCtx());
    expect(resolved.ownerType).toBe('HADRON_SERVER');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveAiServiceConfigs — masked resolvable set (chatbot config picker)
// ─────────────────────────────────────────────────────────────────────────

describe('resolveAiServiceConfigs (masked picker)', () => {
  // The picker is gated on APP MEMBERSHIP, not org-admin rights: any member
  // of the App may list the configs their chat context can resolve. `member`
  // is an ordinary App member with no org role; the App installs the Agent
  // (023 N:M join) so agent-only contexts resolve membership too.
  let member: { id: string };
  beforeEach(async () => {
    member = await db.user.create({
      data: { id: generateId(), handle: 'cfg-member', githubId: 36003, name: 'Member' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    // Role is arbitrary here — the gate is membership, not the member role.
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  });

  it('returns the resolvable set deduped by name (innermost wins), masked', async () => {
    await createConfig({ appId: app.id }, 'default', { apiKey: 'sk-app' });
    // Shadowed by the App-level 'default' above:
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-agent' });
    await createConfig({ agentId: agent.id }, 'fast', { apiKey: 'sk-fast' });
    await createConfig({ organizationId: org.id }, 'frontier', { apiKey: 'sk-frontier' });
    await createConfig({ hadronServerId: server.id }, 'cheap', { apiKey: 'sk-host' });

    const list = await resolvers.Query.resolveAiServiceConfigs(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(member.id),
    );

    // One entry per name, sorted; 'default' came from the App (innermost).
    expect(list.map((c) => c.name)).toEqual(['cheap', 'default', 'fast', 'frontier']);
    const byName = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(byName.default.ownerType).toBe('APP');
    expect(byName.fast.ownerType).toBe('AGENT');
    expect(byName.frontier.ownerType).toBe('ORGANIZATION');
    expect(byName.cheap.ownerType).toBe('HADRON_SERVER');

    // Masked: hasApiKey + preview only; raw key material never present (SC-003).
    for (const c of list) {
      expect(c.hasApiKey).toBe(true);
      expect(c.apiKeyPreview).toBe('…test');
      expect('apiKey' in c).toBe(false);
      expect('apiKeyEncrypted' in c).toBe(false);
    }
  });

  it('does NOT include configs owned by sibling Agents in the same App', async () => {
    // A second Agent in the same org/App. Resolution always runs for one
    // App+Agent pair, so the sibling's configs must never leak into the list.
    const sibling = await db.agent.create({
      data: { id: generateId(), name: 'Sib', urn: 'acme-036:sib', organizationId: org.id },
    });
    await createConfig({ agentId: sibling.id }, 'sibling-only', { apiKey: 'sk-sib' });
    await createConfig({ agentId: agent.id }, 'mine', { apiKey: 'sk-mine' });

    const list = await resolvers.Query.resolveAiServiceConfigs(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(member.id),
    );
    const names = list.map((c) => c.name);
    expect(names).toContain('mine');
    expect(names).not.toContain('sibling-only');
  });

  it('skips disabled configs', async () => {
    await createConfig({ agentId: agent.id }, 'on', { apiKey: 'sk-on' });
    await createConfig({ agentId: agent.id }, 'off', { apiKey: 'sk-off', enabled: false });
    const list = await resolvers.Query.resolveAiServiceConfigs(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(member.id),
    );
    expect(list.map((c) => c.name)).toEqual(['on']);
  });

  it("includes the App's Org + Host, never another org", async () => {
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-agent' });
    await createConfig({ organizationId: org.id }, 'org-wide', { apiKey: 'sk-org' });
    await createConfig({ organizationId: otherOrg.id }, 'rival', { apiKey: 'sk-rival' });
    await createConfig({ hadronServerId: server.id }, 'host-wide', { apiKey: 'sk-host' });

    const list = await resolvers.Query.resolveAiServiceConfigs(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(member.id),
    );
    const names = list.map((c) => c.name);
    expect(names).toEqual(['default', 'host-wide', 'org-wide']);
    expect(names).not.toContain('rival'); // org is derived from the App, never another org
  });

  it('is visible to any App member (not just org admins)', async () => {
    await createConfig({ appId: app.id }, 'default', { apiKey: 'sk-app' });
    // `member` holds no org role at all — App membership alone grants the read.
    const list = await resolvers.Query.resolveAiServiceConfigs(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(member.id),
    );
    expect(list.map((c) => c.name)).toEqual(['default']);
  });

  it('denies non-members — including an org admin who is not an App member', async () => {
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-agent' });
    // `admin` is an ADMIN of the Agent's org but NOT an App member: the gate
    // is App membership, not org role.
    await expect(
      resolvers.Query.resolveAiServiceConfigs(
        {},
        { appRef: app.id, agentRef: agent.id },
        ctxFor(admin.id),
      ),
    ).rejects.toThrow();
    // `outsider` is unrelated entirely.
    await expect(
      resolvers.Query.resolveAiServiceConfigs({}, { agentRef: agent.id }, ctxFor(outsider.id)),
    ).rejects.toThrow();
  });

  it('denies a member of a DIFFERENT App that installs the same Agent (no cross-App read)', async () => {
    // Regression for the requireAiConfigPickerAccess bypass: when an appId is
    // given, membership of THAT App is required — being a member of another
    // App that shares the Agent must NOT grant a read of the target App's
    // (masked) configs. `app` here owns a config the attacker must not see.
    await createConfig({ appId: app.id }, 'default', { apiKey: 'sk-target-app' });
    const otherApp = await db.app.create({
      data: { id: generateId(), name: 'Other', urn: 'acme-036:other-app', organizationId: org.id },
    });
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: agent.id } });
    const otherMember = await db.user.create({
      data: { id: generateId(), handle: 'cfg-other-member', githubId: 36004, name: 'Other' },
    });
    await db.appMember.create({ data: { appId: otherApp.id, userId: otherMember.id, role: 'member' } });

    // otherMember belongs to otherApp (which installs `agent`) but NOT to `app`.
    await expect(
      resolvers.Query.resolveAiServiceConfigs(
        {},
        { appRef: app.id, agentRef: agent.id },
        ctxFor(otherMember.id),
      ),
    ).rejects.toThrow();
  });

  it('denies an Agent that is not installed in the target App (Finding 1: no cross-Agent read)', async () => {
    // With an appId given, the named Agent must be installed in THAT App, or a
    // member could point the walk at an unrelated Agent's masked configs.
    // `unrelated` shares the org but is NOT installed in `app`.
    const unrelated = await db.agent.create({
      data: { id: generateId(), name: 'Unrelated', urn: 'acme-036:unrelated', organizationId: org.id },
    });
    await createConfig({ agentId: unrelated.id }, 'secret', { apiKey: 'sk-unrelated' });
    await expect(
      resolvers.Query.resolveAiServiceConfigs(
        {},
        { appRef: app.id, agentRef: unrelated.id },
        ctxFor(member.id),
      ),
    ).rejects.toThrow();
  });

  it('denies a non-admin agent-only call without an appId (Finding 2: no Agent-home-org read)', async () => {
    // Without an appId the walk would derive the org from the Agent's HOME org;
    // non-admins must supply an App so the org is always the install org.
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-agent' });
    await expect(
      resolvers.Query.resolveAiServiceConfigs({}, { agentRef: agent.id }, ctxFor(member.id)),
    ).rejects.toThrow();
  });

  it('platform admin bypasses membership (host-only context)', async () => {
    await createConfig({ hadronServerId: server.id }, 'host', { apiKey: 'sk-host' });
    const list = await resolvers.Query.resolveAiServiceConfigs({}, {}, platformAdminCtx());
    expect(list.map((c) => c.name)).toContain('host');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T015 — US2: CRUD with masked secrets
// ─────────────────────────────────────────────────────────────────────────

describe('AiServiceConfig CRUD (US2)', () => {
  it('creates, lists, updates, deletes on an Agent owner; responses are always masked', async () => {
    const created = await resolvers.Mutation.createAiServiceConfig(
      {},
      {
        ownerType: 'AGENT',
        ownerId: agent.id,
        name: 'fast',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: 'sk-ant-secret-1234',
        params: { maxTokens: 2048 },
      },
      ctxFor(admin.id),
    );
    expect(created.ownerType).toBe('AGENT');
    expect(created.ownerId).toBe(agent.id);
    expect(created.hasApiKey).toBe(true);
    expect(created.apiKeyPreview).toBe('…1234');
    expect(created.enabled).toBe(true);
    // SC-003: no management response carries key material.
    expect(JSON.stringify(created)).not.toContain('sk-ant-secret-1234');
    const storedRaw = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: created.id } });
    expect(JSON.stringify(created)).not.toContain(storedRaw.apiKeyEncrypted);

    const listedPage = await resolvers.Query.aiServiceConfigs(
      {},
      { filter: { ownerType: 'AGENT', ownerId: agent.id } },
      ctxFor(admin.id),
    );
    const listed = listedPage!.items;
    expect(listedPage!.total).toBe(1);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('sk-ant-secret-1234');
    expect(JSON.stringify(listed)).not.toContain(storedRaw.apiKeyEncrypted);

    const updated = await resolvers.Mutation.updateAiServiceConfig(
      {},
      { id: created.id, model: 'claude-opus-4-6', enabled: false },
      ctxFor(admin.id),
    );
    expect(updated.model).toBe('claude-opus-4-6');
    expect(updated.enabled).toBe(false);
    // Key preserved when apiKey omitted (FR-010).
    const stored = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: created.id } });
    expect(decryptToken(stored.apiKeyEncrypted!)).toBe('sk-ant-secret-1234');

    expect(
      await resolvers.Mutation.deleteAiServiceConfig({}, { id: created.id }, ctxFor(admin.id)),
    ).toBe(true);
    expect(await db.aiServiceConfig.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it('supports all four owner levels with the right auth gates', async () => {
    // Org owner — org admin OK.
    const orgCfg = await resolvers.Mutation.createAiServiceConfig(
      {},
      { ownerType: 'ORGANIZATION', ownerId: org.id, name: 'default', provider: 'openai', model: 'gpt-4o' },
      ctxFor(admin.id),
    );
    expect(orgCfg.ownerType).toBe('ORGANIZATION');

    // App owner — admin of the App's org OK; outsider denied.
    await expect(
      resolvers.Mutation.createAiServiceConfig(
        {},
        { ownerType: 'APP', ownerId: app.id, name: 'default', provider: 'glm', model: 'glm-4' },
        ctxFor(outsider.id),
      ),
    ).rejects.toThrow(/Forbidden/);

    // HADRON_SERVER — org admin denied, platform admin OK.
    await expect(
      resolvers.Mutation.createAiServiceConfig(
        {},
        { ownerType: 'HADRON_SERVER', ownerId: server.id, name: 'default', provider: 'bedrock', model: 'claude-3' },
        ctxFor(admin.id),
      ),
    ).rejects.toThrow(/Forbidden/);
    const hostCfg = await resolvers.Mutation.createAiServiceConfig(
      {},
      { ownerType: 'HADRON_SERVER', ownerId: server.id, name: 'default', provider: 'bedrock', model: 'claude-3' },
      platformAdminCtx(),
    );
    expect(hostCfg.ownerType).toBe('HADRON_SERVER');

    // Listing follows the same gates.
    await expect(
      resolvers.Query.aiServiceConfigs(
        {},
        { filter: { ownerType: 'ORGANIZATION', ownerId: org.id } },
        ctxFor(outsider.id),
      ),
    ).rejects.toThrow(/Forbidden/);
  });

  it('rejects duplicate names per owner with the typed error', async () => {
    await resolvers.Mutation.createAiServiceConfig(
      {},
      { ownerType: 'AGENT', ownerId: agent.id, name: 'fast', provider: 'anthropic', model: 'm' },
      ctxFor(admin.id),
    );
    await expect(
      resolvers.Mutation.createAiServiceConfig(
        {},
        { ownerType: 'AGENT', ownerId: agent.id, name: 'fast', provider: 'openai', model: 'x' },
        ctxFor(admin.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'DuplicateAiServiceConfigNameError' } });
  });

  it('rejects unknown providers, bad params, and bad names with typed errors', async () => {
    await expect(
      resolvers.Mutation.createAiServiceConfig(
        {},
        { ownerType: 'AGENT', ownerId: agent.id, name: 'bad', provider: 'grok', model: 'm' },
        ctxFor(admin.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'UnknownAiProviderError' } });
    await expect(
      resolvers.Mutation.createAiServiceConfig(
        {},
        {
          ownerType: 'AGENT',
          ownerId: agent.id,
          name: 'bad',
          provider: 'anthropic',
          model: 'm',
          params: { maxTokens: -5 },
        },
        ctxFor(admin.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'UnknownAiProviderError' } });
    await expect(
      resolvers.Mutation.createAiServiceConfig(
        {},
        { ownerType: 'AGENT', ownerId: agent.id, name: 'Not Valid', provider: 'anthropic', model: 'm' },
        ctxFor(admin.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'AiConfigValidationError' } });
  });

  it('apiKey update semantics: empty string clears, value replaces', async () => {
    const created = await resolvers.Mutation.createAiServiceConfig(
      {},
      { ownerType: 'AGENT', ownerId: agent.id, name: 'fast', provider: 'anthropic', model: 'm', apiKey: 'sk-one' },
      ctxFor(admin.id),
    );
    const replaced = await resolvers.Mutation.updateAiServiceConfig(
      {},
      { id: created.id, apiKey: 'sk-two' },
      ctxFor(admin.id),
    );
    expect(replaced.apiKeyPreview).toBe('…-two');
    const stored = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: created.id } });
    expect(decryptToken(stored.apiKeyEncrypted!)).toBe('sk-two');

    const cleared = await resolvers.Mutation.updateAiServiceConfig(
      {},
      { id: created.id, apiKey: '' },
      ctxFor(admin.id),
    );
    expect(cleared.hasApiKey).toBe(false);
    expect(cleared.apiKeyPreview).toBeNull();
  });

  it('update/delete on unknown ids yields the typed not-found error', async () => {
    await expect(
      resolvers.Mutation.updateAiServiceConfig({}, { id: 'nope', model: 'm' }, ctxFor(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'AiServiceConfigNotFoundError' } });
    await expect(
      resolvers.Mutation.deleteAiServiceConfig({}, { id: 'nope' }, ctxFor(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'AiServiceConfigNotFoundError' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T018 — US3: legacy shims over the registry
// ─────────────────────────────────────────────────────────────────────────

describe('legacy surface shims (US3)', () => {
  it('fresh-migration state: legacy reads report "not configured" without errors', async () => {
    expect(
      await resolvers.Query.agentAIConfig({}, { agentRef: agent.id }, ctxFor(admin.id)),
    ).toBeNull();
    expect(
      await resolvers.Query.appAIConfig({}, { appRef: app.id }, ctxFor(admin.id)),
    ).toBeNull();
    const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(await resolvers.Agent.hasAiApiKey(agentRow, {}, ctxFor(admin.id))).toBe(false);
    expect(await resolvers.Agent.aiProvider(agentRow, {}, ctxFor(admin.id))).toBeNull();
  });

  it('updateAgentAIConfig upserts the default registry row; agentAIConfig returns it decrypted', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', model: 'claude-opus-4-6', apiKey: 'sk-legacy' },
      ctxFor(admin.id),
    );
    const row = await db.aiServiceConfig.findFirstOrThrow({
      where: { agentId: agent.id, name: 'default' },
    });
    expect(row.provider).toBe('anthropic');

    // Update without key keeps the stored key (legacy semantics).
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      ctxFor(admin.id),
    );
    const cfg = await resolvers.Query.agentAIConfig({}, { agentRef: agent.id }, ctxFor(admin.id));
    expect(cfg?.model).toBe('claude-haiku-4-5-20251001');
    expect(cfg?.apiKey).toBe('sk-legacy');

    // Auth: outsider denied (same gate as before).
    await expect(
      resolvers.Query.agentAIConfig({}, { agentRef: agent.id }, ctxFor(outsider.id)),
    ).rejects.toThrow(/Forbidden/);
  });

  it('clearAgentAIConfig deletes the default registry row', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'anthropic', model: 'm', apiKey: 'sk' },
      ctxFor(admin.id),
    );
    await resolvers.Mutation.clearAgentAIConfig({}, { agentId: agent.id }, ctxFor(admin.id));
    expect(
      await db.aiServiceConfig.findFirst({ where: { agentId: agent.id, name: 'default' } }),
    ).toBeNull();
  });

  it('updateApp with a partial AI config on a config-less App errors instead of silently dropping args', async () => {
    await expect(
      resolvers.Mutation.updateApp(
        {},
        { ref: app.id, aiProvider: 'anthropic' },
        { db, roles: ['ADMIN'], userId: admin.id },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'AiConfigValidationError' } });
    // Key-only CLEAR on a config-less App stays a tolerated no-op.
    const updated = await resolvers.Mutation.updateApp(
      {},
      { ref: app.id, aiApiKey: '' },
      { db, roles: ['ADMIN'], userId: admin.id },
    );
    expect(updated.id).toBe(app.id);
  });

  it('App-overrides-Agent precedence holds end-to-end through resolveAIConfig', async () => {
    await resolvers.Mutation.updateAgentAIConfig(
      {},
      { agentId: agent.id, provider: 'openai', model: 'gpt-4o', apiKey: 'sk-agent-default' },
      ctxFor(admin.id),
    );
    await resolvers.Mutation.createAiServiceConfig(
      {},
      { ownerType: 'APP', ownerId: app.id, name: 'default', provider: 'anthropic', model: 'claude-opus-4-6', apiKey: 'sk-app-override' },
      ctxFor(admin.id),
    );
    const resolved = await resolvers.Query.resolveAIConfig(
      {},
      { appRef: app.id, agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(resolved.ownerType).toBe('APP');
    expect(resolved.apiKey).toBe('sk-app-override');
    // appAIConfig keeps its single-entity contract (App row only).
    const appCfg = await resolvers.Query.appAIConfig({}, { appRef: app.id }, ctxFor(admin.id));
    expect(appCfg?.apiKey).toBe('sk-app-override');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T019 — US4: consumer name-reference contract
// ─────────────────────────────────────────────────────────────────────────

describe('consumer name references (US4)', () => {
  it('explicit name hit uses that config', async () => {
    await createConfig({ agentId: agent.id }, 'default', { apiKey: 'sk-default' });
    await createConfig({ agentId: agent.id }, 'fast', {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'sk-fast',
    });
    const resolved = await resolvers.Query.resolveAIConfig(
      {},
      { name: 'fast', agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(resolved.name).toBe('fast');
    expect(resolved.apiKey).toBe('sk-fast');
    expect(resolved.model).toBe('claude-haiku-4-5-20251001');
  });

  it('name miss falls back to default via the standard walk', async () => {
    await createConfig({ organizationId: org.id }, 'default', { apiKey: 'sk-org-default' });
    const resolved = await resolvers.Query.resolveAIConfig(
      {},
      { name: 'frontier', appRef: app.id, agentRef: agent.id },
      ctxFor(admin.id),
    );
    expect(resolved.name).toBe('default');
    expect(resolved.ownerType).toBe('ORGANIZATION');
  });

  it('total miss is a NoAiConfigAvailableError naming the request, without key material', async () => {
    let caught: GraphQLError | null = null;
    try {
      await resolvers.Query.resolveAIConfig(
        {},
        { name: 'frontier', agentRef: agent.id },
        ctxFor(admin.id),
      );
    } catch (e) {
      caught = e as GraphQLError;
    }
    expect(caught?.extensions?.code).toBe('NoAiConfigAvailableError');
    expect(caught?.message).toContain('frontier');
    expect(caught?.message).not.toMatch(/sk-/);
  });
});
