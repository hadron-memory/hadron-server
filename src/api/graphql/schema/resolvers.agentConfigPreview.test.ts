import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const graphql = new ApolloServer<Context>({ typeDefs, resolvers });
const PREVIEW = '…view';
const FIELDS = 'id aiApiKeyPreview hasAiApiKey aiProvider aiModel';
let vendor: string;
let customer: string;
let manager: string;
let reader: string;
let stranger: string;
let customerAdmin: string;
let agent: string;
let app: string;

const context = (userId?: string, roles: Context['roles'] = []): Context => ({ db, roles, ...(userId ? { userId } : {}) });
async function user(name: string) {
  return (await db.user.create({ data: { handle: `${name}-${generateId()}`, name, roles: ['READER'] } })).id;
}
beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  vendor = (await db.organization.create({ data: { name: 'Vendor', urn: `preview-vendor-${suffix}` } })).id;
  customer = (await db.organization.create({ data: { name: 'Customer', urn: `preview-customer-${suffix}` } })).id;
  manager = await user('manager'); reader = await user('reader'); stranger = await user('stranger'); customerAdmin = await user('customer-admin');
  await db.orgMember.createMany({ data: [
    { organizationId: vendor, userId: manager, role: 'ADMIN' },
    { organizationId: vendor, userId: reader, role: 'READER' },
    { organizationId: customer, userId: customerAdmin, role: 'ADMIN' },
  ] });
  const memory = await db.memory.create({ data: { class: 'system', organizationId: vendor, name: 'System', urn: `preview-system-${suffix}` } });
  agent = (await db.agent.create({ data: { organizationId: vendor, name: 'Public agent', urn: `preview-agent-${suffix}`, visibility: 'PUBLIC', systemMemoryId: memory.id } })).id;
  app = (await db.app.create({ data: { organizationId: customer, name: 'Customer app', urn: `preview-app-${suffix}` } })).id;
  await db.appAgent.create({ data: { appId: app, agentId: agent } });
  await db.appMember.create({ data: { appId: app, userId: customerAdmin, role: 'admin' } });
  await createDbAgentOrgGrant(db, customer, agent);
  await db.aiServiceConfig.create({ data: { agentId: agent, name: 'default', provider: 'anthropic', model: 'preview-model', apiKeyEncrypted: encryptToken('synthetic-private-key'), apiKeyPreview: PREVIEW } });
});
afterAll(async () => { await graphql.stop(); });

async function read(kind: 'point' | 'list', ctx: Context) {
  const query = kind === 'point' ? `query($ref: ID!) { agent(ref: $ref) { ${FIELDS} } }` : `query { publicAgents { items { ${FIELDS} } } }`;
  const result = await graphql.executeOperation({ query, variables: { ref: agent } }, { contextValue: ctx });
  if (result.body.kind !== 'single') throw new Error('Unexpected incremental result');
  expect(result.body.singleResult.errors).toBeUndefined();
  const data = result.body.singleResult.data as { agent?: Record<string, unknown>; publicAgents?: { items: Record<string, unknown>[] } };
  const row = kind === 'point' ? data.agent : data.publicAgents!.items.find(x => x.id === agent);
  expect(row).toBeDefined();
  return row!;
}
function identity(row: Record<string, unknown>) {
  expect(row).toMatchObject({ id: agent, hasAiApiKey: true, aiProvider: 'anthropic', aiModel: 'preview-model' });
}

describe.each(['point', 'list'] as const)('Agent config projection: %s', kind => {
  it.each(['anonymous', 'stranger', 'vendor reader', 'licensed customer admin'] as const)('masks the preview for %s while retaining identity', async who => {
    const ctx = who === 'anonymous' ? context() : context(who === 'stranger' ? stranger : who === 'vendor reader' ? reader : customerAdmin);
    const row = await read(kind, ctx);
    identity(row);
    expect(row.aiApiKeyPreview).toBeNull();
    expect(JSON.stringify(row)).not.toContain(PREVIEW);
  });
  it.each(['vendor admin', 'platform admin'] as const)('retains the preview for %s', async who => {
    const row = await read(kind, who === 'vendor admin' ? context(manager) : context(stranger, ['ADMIN']));
    identity(row);
    expect(row.aiApiKeyPreview).toBe(PREVIEW);
  });
  it('revoked source membership cannot retain preview authority', async () => {
    await db.orgMember.deleteMany({ where: { organizationId: vendor, userId: manager } });
    const row = await read(kind, context(manager));
    identity(row); expect(row.aiApiKeyPreview).toBeNull();
  });
  it('disabled config remains visible to its manager but not a public reader', async () => {
    await db.aiServiceConfig.updateMany({ where: { agentId: agent }, data: { enabled: false } });
    const own = await read(kind, context(manager)); identity(own); expect(own.aiApiKeyPreview).toBe(PREVIEW);
    const publicRow = await read(kind, context()); identity(publicRow); expect(publicRow.aiApiKeyPreview).toBeNull();
  });
});

it('a personal Agent keeps credential preview owner-only despite platform management access', async () => {
  await db.agent.update({ where: { id: agent }, data: { organizationId: null, ownerUserId: manager } });
  const own = await read('point', context(manager)); identity(own); expect(own.aiApiKeyPreview).toBe(PREVIEW);
  const platform = await read('point', context(stranger, ['ADMIN'])); identity(platform); expect(platform.aiApiKeyPreview).toBeNull();
});

it('no config answers null preview and no key without changing public readability', async () => {
  await db.aiServiceConfig.deleteMany({ where: { agentId: agent } });
  expect(await read('point', context())).toMatchObject({ id: agent, aiApiKeyPreview: null, hasAiApiKey: false, aiProvider: null, aiModel: null });
});

it('a contributor role does not become credential management', async () => {
  await db.orgMember.updateMany({ where: { organizationId: vendor, userId: reader }, data: { role: 'CONTRIBUTOR' } });
  const row = await read('point', context(reader));
  identity(row); expect(row.aiApiKeyPreview).toBeNull();
});

it('unexpected source lookup faults propagate rather than becoming a masked success', async () => {
  let calls = 0;
  const faulty = db.$extends({ query: { agent: { async findFirst({ args, query }) {
    if (args.where?.id === agent && args.select?.organizationId && args.select?.ownerUserId) {
      calls++;
      throw new Error('synthetic source lookup fault');
    }
    return query(args);
  } } } });
  await expect(resolvers.Agent.aiApiKeyPreview({ id: agent }, {}, { ...context(manager), db: faulty as unknown as Context['db'] })).rejects.toThrow('synthetic source lookup fault');
  expect(calls).toBe(1);
});

it('unexpected source-role faults propagate rather than becoming an ordinary denial', async () => {
  let calls = 0;
  const faulty = db.$extends({ query: { orgMember: { async findFirst({ args, query }) {
    if (args.where?.organizationId === vendor && args.where?.userId === manager) {
      calls++;
      throw new Error('synthetic source-role fault');
    }
    return query(args);
  } } } });
  await expect(resolvers.Agent.aiApiKeyPreview({ id: agent }, {}, { ...context(manager), db: faulty as unknown as Context['db'] })).rejects.toThrow('synthetic source-role fault');
  expect(calls).toBe(1);
});
