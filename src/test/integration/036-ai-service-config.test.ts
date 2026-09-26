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

  it('withholds an explicit endpoint from members; a public provider default stays visible (#1380 review)', async () => {
    const orgCfg = await createConfig({ organizationId: org.id }, 'lan', { provider: 'glm', apiKey: 'sk-lan' });
    await db.aiServiceConfig.update({ where: { id: orgCfg.id }, data: { endpoint: 'http://10.1.2.3:11434/v1' } });
    await createConfig({ organizationId: org.id }, 'default', { provider: 'glm', apiKey: 'sk-def' });
    const listed = await resolvers.Query.resolveAiServiceConfigs({}, { appRef: app.id }, ctxFor(member.id));
    const lan = listed.find((c) => c.name === 'lan')!;
    const dflt = listed.find((c) => c.name === 'default')!;
    expect([lan.endpoint, lan.effectiveEndpoint]).toEqual([null, null]);
    expect(JSON.stringify(listed)).not.toContain('10.1.2.3');
    expect(dflt.effectiveEndpoint).toBe('https://api.z.ai/api/paas/v4');
    // The owner's admins still see it through the management read.
    expect((await resolvers.Query.aiServiceConfig({}, { ref: orgCfg.id }, ctxFor(admin.id)))!.endpoint).toBe('http://10.1.2.3:11434/v1');
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

// ─────────────────────────────────────────────────────────────────────────
// #1373 — AiServiceConfig.endpoint: stored, validated, cleared, resolved
// ─────────────────────────────────────────────────────────────────────────

describe('AiServiceConfig.endpoint (#1373)', () => {
  const mk = (extra: Record<string, unknown>) =>
    resolvers.Mutation.createAiServiceConfig(
      {},
      { ownerType: 'ORGANIZATION', ownerId: org.id, name: 'zai', provider: 'glm', model: 'GLM-5.3', apiKey: 'k-1234', ...extra },
      ctxFor(admin.id),
    );

  it('stores a valid endpoint without its trailing slash, and reports it as the effective endpoint', async () => {
    const c = await mk({ endpoint: 'https://api.z.ai/api/paas/v4/' });
    expect(c).toMatchObject({ endpoint: 'https://api.z.ai/api/paas/v4', effectiveEndpoint: 'https://api.z.ai/api/paas/v4' });
    expect((await db.aiServiceConfig.findUniqueOrThrow({ where: { id: c.id } })).endpoint).toBe('https://api.z.ai/api/paas/v4');
  });

  it('with no endpoint the effective endpoint is the provider default, and resolveAIConfig reports the same', async () => {
    const c = await mk({});
    expect(c).toMatchObject({ endpoint: null, effectiveEndpoint: 'https://api.z.ai/api/paas/v4' });
    const resolved = await resolvers.Query.resolveAIConfig({}, { name: 'zai', appRef: app.id }, ctxFor(admin.id));
    expect(resolved).toMatchObject({ effectiveEndpoint: 'https://api.z.ai/api/paas/v4', effectiveApiStyle: 'CHAT_COMPLETIONS' });
  });

  it('refuses an invalid endpoint with the typed validation error and writes nothing', async () => {
    for (const bad of ['http://api.z.ai/v4', 'https://u:p@api.z.ai/v4', 'https://api.z.ai/v4?x=1', 'https://10.0.0.5/v1', 'not a url']) {
      let caught: GraphQLError | null = null;
      try {
        await mk({ endpoint: bad });
      } catch (e) {
        caught = e as GraphQLError;
      }
      expect(caught?.extensions?.code, bad).toBe('AiConfigValidationError');
    }
    expect(await db.aiServiceConfig.count()).toBe(0);
  });

  it('update: omitted keeps the endpoint, a new value replaces it, null and "" clear it', async () => {
    const c = await mk({ endpoint: 'https://api.z.ai/api/paas/v4' });
    const upd = (endpoint?: string | null) =>
      resolvers.Mutation.updateAiServiceConfig({}, { id: c.id, ...(endpoint === undefined ? {} : { endpoint }) }, ctxFor(admin.id));
    expect((await upd()).endpoint).toBe('https://api.z.ai/api/paas/v4');
    expect((await upd('https://api.z.ai/api/coding/paas/v4')).endpoint).toBe('https://api.z.ai/api/coding/paas/v4');
    expect((await upd(null)).endpoint).toBeNull();
    await upd('https://api.z.ai/api/paas/v4');
    expect((await upd('')).endpoint).toBeNull();
  });

  it('apiStyle round-trips for an OpenAI-compatible provider and is refused for a single-protocol one (D3)', async () => {
    const c = await mk({ apiStyle: 'RESPONSES' });
    expect(c).toMatchObject({ apiStyle: 'RESPONSES', effectiveApiStyle: 'RESPONSES' });
    const cleared = await resolvers.Mutation.updateAiServiceConfig({}, { id: c.id, apiStyle: null }, ctxFor(admin.id));
    expect(cleared).toMatchObject({ apiStyle: null, effectiveApiStyle: 'CHAT_COMPLETIONS' });
    await resolvers.Mutation.updateAiServiceConfig({}, { id: c.id, apiStyle: 'RESPONSES' }, ctxFor(admin.id));
    // A provider change is judged with the style it would strand.
    let caught: GraphQLError | null = null;
    try {
      await resolvers.Mutation.updateAiServiceConfig({}, { id: c.id, provider: 'anthropic' }, ctxFor(admin.id));
    } catch (e) {
      caught = e as GraphQLError;
    }
    expect(caught?.extensions?.code).toBe('AiConfigValidationError');
    expect((await db.aiServiceConfig.findUniqueOrThrow({ where: { id: c.id } })).provider).toBe('glm');
  });

  it('a legacy provider change drops a style the new provider cannot use (#1380 review)', async () => {
    const legacy = await createConfig({ agentId: agent.id }, 'default', { provider: 'openai' });
    await db.aiServiceConfig.update({ where: { id: legacy.id }, data: { apiStyle: 'CHAT_COMPLETIONS' } });
    // Same provider: the style survives the legacy write.
    await resolvers.Mutation.updateAgentAIConfig({}, { agentId: agent.id, provider: 'openai', model: 'gpt-x' }, ctxFor(admin.id));
    expect((await db.aiServiceConfig.findUniqueOrThrow({ where: { id: legacy.id } })).apiStyle).toBe('CHAT_COMPLETIONS');
    // A provider with one protocol: the stranded style is cleared.
    await resolvers.Mutation.updateAgentAIConfig({}, { agentId: agent.id, provider: 'anthropic', model: 'claude-x' }, ctxFor(admin.id));
    const row = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: legacy.id } });
    expect([row.provider, row.apiStyle]).toEqual(['anthropic', null]);
    // …and the modern surface can edit it again without tripping the pair check.
    await expect(resolvers.Mutation.updateAiServiceConfig({}, { id: legacy.id, enabled: false }, ctxFor(admin.id))).resolves.toMatchObject({ enabled: false });
  });

  it('a legacy provider change clears the endpoint too: the new key never goes to the old host (#1380 review)', async () => {
    const legacy = await createConfig({ agentId: agent.id }, 'default', { provider: 'openai' });
    await db.aiServiceConfig.update({ where: { id: legacy.id }, data: { endpoint: 'https://api.openai.com/v1' } });
    await resolvers.Mutation.updateAgentAIConfig({}, { agentId: agent.id, provider: 'openai', model: 'gpt-y' }, ctxFor(admin.id));
    expect((await db.aiServiceConfig.findUniqueOrThrow({ where: { id: legacy.id } })).endpoint).toBe('https://api.openai.com/v1');
    await resolvers.Mutation.updateAgentAIConfig({}, { agentId: agent.id, provider: 'anthropic', model: 'claude-x', apiKey: 'sk-new' }, ctxFor(admin.id));
    expect((await db.aiServiceConfig.findUniqueOrThrow({ where: { id: legacy.id } })).endpoint).toBeNull();

    const appCfg = await createConfig({ appId: app.id }, 'default', { provider: 'openai' });
    await db.aiServiceConfig.update({ where: { id: appCfg.id }, data: { endpoint: 'https://api.openai.com/v1' } });
    await resolvers.Mutation.updateApp({}, { ref: app.id, aiProvider: 'glm', aiModel: 'GLM-5.3' } as never, ctxFor(admin.id));
    expect((await db.aiServiceConfig.findUniqueOrThrow({ where: { id: appCfg.id } })).endpoint).toBeNull();
  });

  it('a legacy provider change resets even a style the new provider supports (#1380 review)', async () => {
    const legacy = await createConfig({ agentId: agent.id }, 'default', { provider: 'openai' });
    await db.aiServiceConfig.update({ where: { id: legacy.id }, data: { apiStyle: 'RESPONSES' } });
    // glm supports apiStyle, but RESPONSES was chosen for OpenAI; Z.ai serves chat.
    await resolvers.Mutation.updateAgentAIConfig({}, { agentId: agent.id, provider: 'glm', model: 'GLM-5.3', apiKey: 'k' }, ctxFor(admin.id));
    const row = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: legacy.id } });
    expect([row.provider, row.apiStyle]).toEqual(['glm', null]);
  });

  it('the member picker drops a legacy params.baseUrl (#1380 review)', async () => {
    const member = await db.user.create({ data: { id: generateId(), handle: 'cfg-member2', githubId: 36009, name: 'M2' } });
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    const legacy = await createConfig({ organizationId: org.id }, 'legacy-url', { provider: 'glm' });
    await db.aiServiceConfig.update({ where: { id: legacy.id }, data: { params: { baseUrl: 'http://10.9.9.9/v4', maxTokens: 50 } } });
    const listed = await resolvers.Query.resolveAiServiceConfigs({}, { appRef: app.id }, ctxFor(member.id));
    const row = listed.find((c) => c.name === 'legacy-url')!;
    expect(row.params).toEqual({ maxTokens: 50 });
    expect(JSON.stringify(listed)).not.toContain('10.9.9.9');
  });

  it('the legacy App AI arguments drop a stranded style too (#1380 review)', async () => {
    const legacy = await createConfig({ appId: app.id }, 'default', { provider: 'openai' });
    await db.aiServiceConfig.update({ where: { id: legacy.id }, data: { apiStyle: 'CHAT_COMPLETIONS' } });
    await resolvers.Mutation.updateApp({}, { ref: app.id, aiProvider: 'anthropic', aiModel: 'claude-x' } as never, ctxFor(admin.id));
    const row = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: legacy.id } });
    expect([row.provider, row.apiStyle]).toEqual(['anthropic', null]);
  });

  it('writing params.baseUrl is refused, but a legacy row carrying one can still be edited (D2)', async () => {
    let caught: GraphQLError | null = null;
    try {
      await mk({ params: { baseUrl: 'https://api.z.ai/api/paas/v4' } });
    } catch (e) {
      caught = e as GraphQLError;
    }
    expect(caught?.extensions?.code).toBe('AiConfigValidationError');
    const legacy = await createConfig({ organizationId: org.id }, 'legacy', { provider: 'glm' });
    await db.aiServiceConfig.update({ where: { id: legacy.id }, data: { params: { baseUrl: 'https://legacy.example/v4' } } });
    const edited = await resolvers.Mutation.updateAiServiceConfig({}, { id: legacy.id, enabled: false }, ctxFor(admin.id));
    expect(edited).toMatchObject({ enabled: false, effectiveEndpoint: 'https://api.z.ai/api/paas/v4' });
  });

  it('openai-compatible needs an endpoint on every write surface (#1373)', async () => {
    const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as GraphQLError)?.extensions?.code;
    // Modern create: refused without, accepted with.
    expect(await code(mk({ provider: 'openai-compatible', model: 'llama-3.3-70b', name: 'nope' }))).toBe('AiConfigValidationError');
    const c = await mk({ provider: 'openai-compatible', model: 'llama-3.3-70b', name: 'compat', endpoint: 'https://api.together.xyz/v1', params: { toolCalling: true } });
    expect(c).toMatchObject({ provider: 'openai-compatible', effectiveEndpoint: 'https://api.together.xyz/v1', effectiveApiStyle: 'CHAT_COMPLETIONS' });
    // Clearing its endpoint would strand it.
    expect(await code(resolvers.Mutation.updateAiServiceConfig({}, { id: c.id, endpoint: null }, ctxFor(admin.id)))).toBe('AiConfigValidationError');
    // Switching another provider to it without one is refused too.
    const other = await mk({ name: 'switch' });
    expect(await code(resolvers.Mutation.updateAiServiceConfig({}, { id: other.id, provider: 'openai-compatible' }, ctxFor(admin.id)))).toBe('AiConfigValidationError');
    // The legacy surfaces cannot set an endpoint, so they cannot create one.
    expect(await code(resolvers.Mutation.updateAgentAIConfig({}, { agentId: agent.id, provider: 'openai-compatible', model: 'x', apiKey: 'k' }, ctxFor(admin.id)))).toBe('AiConfigValidationError');
    expect(await code(resolvers.Mutation.updateApp({}, { ref: app.id, aiProvider: 'openai-compatible', aiModel: 'x', aiApiKey: 'k' } as never, ctxFor(admin.id)))).toBe('AiConfigValidationError');
    expect(await db.aiServiceConfig.count({ where: { provider: 'openai-compatible', endpoint: null } })).toBe(0);
    // A key is required too: with none stored, an SDK would reach for the
    // server's own credential and send it to this host (#1389 review).
    expect(await code(mk({ provider: 'openai-compatible', model: 'm', name: 'keyless', endpoint: 'https://api.together.xyz/v1', apiKey: undefined }))).toBe('AiConfigValidationError');
    expect(await code(resolvers.Mutation.updateAiServiceConfig({}, { id: c.id, apiKey: '' }, ctxFor(admin.id)))).toBe('AiConfigValidationError');
    // The same rule for every provider (usesProcessCredential): glm's default
    // host is Z.ai, and any explicit endpoint is admin-chosen; only a default
    // host that issued the server's credential may run keyless.
    expect(await code(mk({ provider: 'glm', model: 'm', name: 'keyless-glm', apiKey: undefined }))).toBe('AiConfigValidationError');
    expect(await code(mk({ provider: 'openai', model: 'm', name: 'keyless-ep', endpoint: 'https://llm.example.com/v1', apiKey: undefined }))).toBe('AiConfigValidationError');
    expect(await code(mk({ provider: 'openai', model: 'm', name: 'keyless-openai', apiKey: undefined }))).toBeUndefined();
    // params.toolCalling is type-checked.
    expect(await code(mk({ provider: 'openai-compatible', model: 'm', name: 'badtools', endpoint: 'https://api.together.xyz/v1', params: { toolCalling: 'yes' } }))).toBe('UnknownAiProviderError');
  });

  it('aiProviderEndpoints serves the single suggestion list: one default per listed provider, none for bedrock or an unknown provider', async () => {
    const glm = await resolvers.Query.aiProviderEndpoints({}, { provider: 'glm' });
    expect(glm.map((e) => e.url)).toEqual([
      'https://api.z.ai/api/paas/v4',
      'https://api.z.ai/api/coding/paas/v4',
      'https://open.bigmodel.cn/api/paas/v4',
    ]);
    expect(glm[0].isDefault).toBe(true);
    expect(glm.filter((e) => e.isDefault)).toHaveLength(1);
    expect(await resolvers.Query.aiProviderEndpoints({}, { provider: 'bedrock' })).toEqual([]);
    expect(await resolvers.Query.aiProviderEndpoints({}, { provider: 'toString' })).toEqual([]);
  });
});
