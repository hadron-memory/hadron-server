import { ApolloServer } from '@apollo/server';
import type { Organization, User, Agent, App, AiServiceConfig } from '../../../generated/prisma/index.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { requireAiConfigPickerAccess } from './resolvers.helpers.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const api = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
const KEY = 'fixture-provider-key';
let vendor: Organization, customer: Organization, admin: User, manager: User, member: User, agent: Agent, app: App, config: AiServiceConfig;
const ctx = (userId = admin.id): Context => ({ db, userId, roles: ['READER'] });
const ref = () => `hrn:agent:${agent.urn}`;
const query = 'query($app: ID!, $agent: ID!) { resolveAIConfig(appRef:$app, agentRef:$agent) { configId name provider model ownerType effectiveEndpoint effectiveApiStyle params apiKey } }';

async function ask(agentRef = agent.id, userId = admin.id, picker = false) {
  const result = await api.executeOperation({
    query: picker ? 'query($app: ID!, $agent: ID!) { resolveAiServiceConfigs(appRef:$app, agentRef:$agent) { id provider model ownerType hasApiKey apiKeyPreview params } }' : query,
    variables: { app: app.id, agent: agentRef },
  }, { contextValue: ctx(userId) });
  if (result.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = result.body.singleResult;
  return { data, errors };
}

function refusal(answer: Awaited<ReturnType<typeof ask>>, namedRef: string) {
  expect(answer.errors).toHaveLength(1);
  expect(answer.data?.resolveAIConfig ?? answer.data?.resolveAiServiceConfigs ?? null).toBeNull();
  const e = answer.errors![0]!;
  const { stacktrace: _stack, requestId: _request, ...extensions } = e.extensions ?? {};
  return JSON.parse(JSON.stringify({ message: e.message, extensions }).split(namedRef).join('<ref>'));
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  vendor = await db.organization.create({ data: { name: 'Vendor', urn: `vendor-${suffix}.example` } });
  customer = await db.organization.create({ data: { name: 'Customer', urn: `customer-${suffix}.example` } });
  [admin, manager, member] = await Promise.all(['admin', 'manager', 'member'].map(handle => db.user.create({ data: { handle: `${handle}-${suffix}`, roles: ['READER'] } })));
  await db.orgMember.createMany({ data: [
    { organizationId: customer.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: vendor.id, userId: manager.id, role: 'ADMIN' },
  ] });
  agent = await db.agent.create({ data: { organizationId: vendor.id, name: 'Assistant', urn: `${vendor.urn}:assistant`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { organizationId: customer.id, name: 'Workspace', urn: `${customer.urn}:workspace` } });
  await db.appMember.createMany({ data: [
    { appId: app.id, userId: admin.id, role: 'admin' },
    { appId: app.id, userId: member.id, role: 'reader' },
  ] });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await createDbAgentOrgGrant(db, customer.id, agent.id);
  config = await db.aiServiceConfig.create({ data: { agentId: agent.id, name: 'default', provider: 'openai', model: 'fixture-model', apiKeyEncrypted: encryptToken(KEY), apiKeyPreview: '…ture', enabled: true } });
});

describe('configuration resolution access', () => {
  it.each(['id', 'urn'])('licensed identity is retained without a credential (%s)', async kind => {
    const answer = await ask(kind === 'id' ? agent.id : ref());
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: config.id, provider: 'openai', model: 'fixture-model', ownerType: 'AGENT', apiKey: null });
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it('an identity-only result retains a public provider default and style', async () => {
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ effectiveEndpoint: 'https://api.openai.com/v1', effectiveApiStyle: 'RESPONSES', apiKey: null });
  });

  it('the resolver does not decrypt a credential for an identity-only answer', async () => {
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { apiKeyEncrypted: 'unreadable-fixture' } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: config.id, model: 'fixture-model', apiKey: null });
  });

  it('an identity-only answer is independent of stored key presence', async () => {
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { apiKeyEncrypted: null } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: config.id, model: 'fixture-model', apiKey: null });
  });

  it('a licensed user-owned App retains the same identity-only result', async () => {
    await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: admin.id } });
    await db.orgMember.create({ data: { organizationId: vendor.id, userId: admin.id, role: 'READER' } });
    await db.agentSubscription.create({ data: { agentId: agent.id, userId: admin.id, activatedAt: new Date() } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: config.id, ownerType: 'AGENT', apiKey: null });
  });

  it('an outer organization source follows its own credential authority', async () => {
    await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: admin.id } });
    await db.orgMember.create({ data: { organizationId: vendor.id, userId: admin.id, role: 'READER' } });
    await db.agentSubscription.create({ data: { agentId: agent.id, userId: admin.id, activatedAt: new Date() } });
    await db.aiServiceConfig.delete({ where: { id: config.id } });
    const outer = await db.aiServiceConfig.create({ data: { organizationId: vendor.id, name: 'default', provider: 'openai', model: 'outer-model', apiKeyEncrypted: encryptToken(KEY), enabled: true } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: outer.id, ownerType: 'ORGANIZATION', model: 'outer-model', apiKey: null });
  });

  it('a platform source retains identity for an authorized context without its credential', async () => {
    await db.aiServiceConfig.delete({ where: { id: config.id } });
    const host = await db.hadronServer.create({ data: { url: 'https://fixture.example' } });
    const outer = await db.aiServiceConfig.create({ data: { hadronServerId: host.id, name: 'default', provider: 'openai', model: 'outer-model', apiKeyEncrypted: encryptToken(KEY), enabled: true } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: outer.id, ownerType: 'HADRON_SERVER', model: 'outer-model', apiKey: null });
  });

  it('a source authority lookup fault is not converted into an identity answer', async () => {
    let ownerLookups = 0, refLookups = 0;
    const faulty = db.$extends({ query: { agent: { findFirst({ args, query }) {
      if (args.select?.organizationId && args.select?.ownerUserId) {
        ownerLookups++;
        throw new Error('fixture-source-fault');
      }
      if (args.select?.id) refLookups++;
      return query(args);
    } } } });
    await expect(resolvers.Query.resolveAIConfig({}, { appRef: app.id, agentRef: agent.id }, { ...ctx(), db: faulty as unknown as Context['db'] })).rejects.toThrow('fixture-source-fault');
    expect(refLookups).toBeGreaterThanOrEqual(1);
    expect(ownerLookups).toBe(1);
  });

  it('an organization source authority fault propagates instead of returning identity', async () => {
    await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: admin.id } });
    await db.orgMember.create({ data: { organizationId: vendor.id, userId: admin.id, role: 'READER' } });
    await db.agentSubscription.create({ data: { agentId: agent.id, userId: admin.id, activatedAt: new Date() } });
    await db.aiServiceConfig.delete({ where: { id: config.id } });
    await db.aiServiceConfig.create({ data: { organizationId: vendor.id, name: 'default', provider: 'openai', model: 'outer-model', apiKeyEncrypted: encryptToken(KEY), enabled: true } });
    let ownerLookups = 0;
    const faulty = db.$extends({ query: { organization: { findFirst({ args, query }) {
      if (args.where?.id === vendor.id) {
        ownerLookups++;
        throw new Error('fixture-org-source-fault');
      }
      return query(args);
    } } } });
    await expect(resolvers.Query.resolveAIConfig({}, { appRef: app.id, agentRef: agent.id }, { ...ctx(), db: faulty as unknown as Context['db'] })).rejects.toThrow('fixture-org-source-fault');
    expect(ownerLookups).toBe(1);
  });

  it('an identity-only result does not disclose configured params', async () => {
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { params: { secret: 'fixture-param-sentinel' } } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: config.id, apiKey: null, params: null });
    expect(JSON.stringify(answer)).not.toContain('fixture-param-sentinel');
  });

  it('an identity-only result does not disclose a configured private endpoint', async () => {
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { endpoint: 'https://routing-sentinel.example/v1', apiStyle: 'CHAT_COMPLETIONS' } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: config.id, apiKey: null, effectiveEndpoint: null, effectiveApiStyle: 'CHAT_COMPLETIONS' });
    expect(JSON.stringify(answer)).not.toContain('routing-sentinel');
  });

  it('a source manager retains configured params and execution details', async () => {
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { params: { secret: 'fixture-param-sentinel' }, endpoint: 'https://routing-sentinel.example/v1', apiStyle: 'CHAT_COMPLETIONS' } });
    const answer = await resolvers.Query.resolveAIConfig({}, { agentRef: agent.id }, ctx(manager.id));
    expect(answer).toMatchObject({ configId: config.id, apiKey: KEY, params: { secret: 'fixture-param-sentinel' }, effectiveEndpoint: 'https://routing-sentinel.example/v1', effectiveApiStyle: 'CHAT_COMPLETIONS' });
  });

  it.each(['revoked', 'expired', 'inactive', 'missing grant', 'missing install'].flatMap(state => ['id', 'urn'].map(kind => [state, kind])))('%s is indistinguishable from an absent install (%s)', async (state, kind) => {
    const named = kind === 'id' ? agent.id : ref();
    const absent = kind === 'id' ? generateId() : `hrn:agent:${vendor.urn}:absent`;
    if (state === 'revoked') await db.agentOrgGrant.updateMany({ data: { revokedAt: new Date() } });
    if (state === 'expired') await db.agentOrgGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    if (state === 'inactive') await db.agentOrgGrant.updateMany({ data: { activatedAt: null } });
    if (state === 'missing grant') await db.agentOrgGrant.deleteMany();
    if (state === 'missing install') await db.appAgent.deleteMany();
    expect(refusal(await ask(named), named)).toEqual(refusal(await ask(absent), absent));
  });

  it.each(['deleted agent', 'deleted app'])('%s keeps its early missing-entity refusal', async state => {
    const absent = `hrn:agent:${vendor.urn}:absent`;
    if (state === 'deleted agent') await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    if (state === 'deleted app') await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(refusal(await ask(ref()), ref())).toEqual(refusal(await ask(absent), absent));
  });

  it.each(['revoked', 'expired', 'inactive', 'missing'].flatMap(state => ['id', 'urn'].map(kind => [state, kind])))('a personal App subscription that is %s answers absent (%s)', async (state, kind) => {
    await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: admin.id } });
    await db.orgMember.create({ data: { organizationId: vendor.id, userId: admin.id, role: 'READER' } });
    await db.agentSubscription.create({ data: { agentId: agent.id, userId: admin.id, activatedAt: new Date() } });
    const named = kind === 'id' ? agent.id : ref();
    const absent = kind === 'id' ? generateId() : `hrn:agent:${vendor.urn}:absent`;
    expect((await ask(named)).errors).toBeUndefined();
    expect((await ask(named, admin.id, true)).errors).toBeUndefined();
    if (state === 'revoked') await db.agentSubscription.updateMany({ data: { revokedAt: new Date() } });
    if (state === 'expired') await db.agentSubscription.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    if (state === 'inactive') await db.agentSubscription.updateMany({ data: { activatedAt: null } });
    if (state === 'missing') await db.agentSubscription.deleteMany();
    for (const picker of [false, true]) {
      expect(refusal(await ask(named, admin.id, picker), named)).toEqual(refusal(await ask(absent, admin.id, picker), absent));
    }
  });

  it.each(['revoked', 'expired', 'inactive', 'missing install'])('the member picker refuses %s with the absent-install answer', async state => {
    const absent = `hrn:agent:${vendor.urn}:absent`;
    const expected = refusal(await ask(absent, member.id, true), absent);
    if (state === 'revoked') await db.agentOrgGrant.updateMany({ data: { revokedAt: new Date() } });
    if (state === 'expired') await db.agentOrgGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    if (state === 'inactive') await db.agentOrgGrant.updateMany({ data: { activatedAt: null } });
    if (state === 'missing install') await db.appAgent.deleteMany();
    expect(refusal(await ask(ref(), member.id, true), ref())).toEqual(expected);
  });

  it('the picker helper preserves a licensed member context', async () => {
    await expect(requireAiConfigPickerAccess(ctx(member.id), app.id, agent.id)).resolves.toBeUndefined();
  });

  it('the picker helper refuses a revoked member context', async () => {
    await db.agentOrgGrant.updateMany({ data: { revokedAt: new Date() } });
    await expect(requireAiConfigPickerAccess(ctx(member.id), app.id, agent.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('a licensed member retains picker identity', async () => {
    const answer = await ask(agent.id, member.id, true);
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAiServiceConfigs).toEqual(expect.arrayContaining([expect.objectContaining({ id: config.id, model: 'fixture-model' })]));
  });

  it('vendor READER membership does not grant source management', async () => {
    await db.orgMember.create({ data: { organizationId: vendor.id, userId: admin.id, role: 'READER' } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: config.id, apiKey: null, params: null });
  });

  it.each(['id', 'urn'])('an unlicensed personal Agent is absent before its owner gate (%s)', async kind => {
    await db.agent.update({ where: { id: agent.id }, data: { organizationId: null, ownerUserId: manager.id } });
    await db.agentOrgGrant.deleteMany();
    const named = kind === 'id' ? agent.id : ref();
    const absent = kind === 'id' ? generateId() : `hrn:agent:${vendor.urn}:absent`;
    expect(refusal(await ask(named), named)).toEqual(refusal(await ask(absent), absent));
  });

  it.each([false, true])('the non-manager picker withholds selected-source params and preview (outer=%s)', async outer => {
    if (outer) {
      await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: admin.id } });
      await db.orgMember.create({ data: { organizationId: vendor.id, userId: admin.id, role: 'READER' } });
      await db.agentSubscription.create({ data: { agentId: agent.id, userId: admin.id, activatedAt: new Date() } });
      await db.aiServiceConfig.update({ where: { id: config.id }, data: { agentId: null, organizationId: vendor.id } });
    }
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { params: { secret: 'picker-param-sentinel' } } });
    const answer = await ask(agent.id, member.id, true);
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAiServiceConfigs).toEqual(expect.arrayContaining([expect.objectContaining({ id: config.id, hasApiKey: true, apiKeyPreview: null, params: null })]));
    expect(JSON.stringify(answer)).not.toContain('picker-param-sentinel');
    expect(JSON.stringify(answer)).not.toContain('…ture');
  });

  it('a source manager using the picker retains its params and preview', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: manager.id, role: 'reader' } });
    await db.aiServiceConfig.update({ where: { id: config.id }, data: { params: { temperature: 0.4 } } });
    const answer = await ask(agent.id, manager.id, true);
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAiServiceConfigs).toEqual(expect.arrayContaining([expect.objectContaining({ id: config.id, hasApiKey: true, apiKeyPreview: '…ture', params: { temperature: 0.4 } })]));
  });

  it('an Agent manager retains its credential on the management path', async () => {
    const result = await resolvers.Query.resolveAIConfig({}, { agentRef: agent.id }, ctx(manager.id));
    expect(result.apiKey).toBe(KEY);
  });

  it('an authorized App-owned config still takes precedence', async () => {
    const own = await db.aiServiceConfig.create({ data: { appId: app.id, name: 'default', provider: 'openai', model: 'app-model', apiKeyEncrypted: encryptToken('fixture-app-key'), enabled: true } });
    const answer = await ask();
    expect(answer.errors).toBeUndefined();
    expect(answer.data?.resolveAIConfig).toMatchObject({ configId: own.id, ownerType: 'APP', apiKey: 'fixture-app-key' });
  });
});
