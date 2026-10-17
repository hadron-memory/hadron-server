import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import * as tokenCrypto from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const api = new ApolloServer<Context>({ typeDefs, resolvers });
afterAll(() => api.stop());
let ownerId: string;
let adminId: string;
let agentId: string;
let otherAgentId: string;
let orgId: string;
const context = (userId: string, roles: string[] = ['READER']): Context => ({ db, userId, roles });

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { id: generateId(), handle: 'clear-owner', roles: ['READER'] } })).id;
  adminId = (await db.user.create({ data: { id: generateId(), handle: 'clear-admin', roles: ['ADMIN'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'Clear controls', urn: 'clear-controls.test' } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Target', urn: 'clear-owner:target', visibility: 'PERSONAL' } })).id;
  otherAgentId = (await db.agent.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Other', urn: 'clear-owner:other', visibility: 'PERSONAL' } })).id;
});

async function config(target: string, name: string, enabled = true) {
  return db.aiServiceConfig.create({ data: {
    id: generateId(), agentId: target, name, provider: 'openai', model: 'fixture-model', enabled,
    apiKeyEncrypted: tokenCrypto.encryptToken(`sk-1882-${target}-${name}`), apiKeyPreview: '...1882', createdBy: ownerId,
  } });
}
const configs = () => db.aiServiceConfig.findMany({ orderBy: { id: 'asc' } });

describe('#1882 — platform clear of user-owned Agent credentials', () => {
  it.each(['ADMIN', 'OWNER'])(
    '%s removes every named config, including disabled rows, without touching another Agent or exposing keys',
    async (role) => {
      await db.user.update({ where: { id: adminId }, data: { roles: [role] } });
      for (const name of ['default', 'backup', 'disabled']) await config(agentId, name, name !== 'disabled');
      await config(otherAgentId, 'default');
      await config(otherAgentId, 'backup');
      const otherBefore = await db.aiServiceConfig.findMany({ where: { agentId: otherAgentId }, orderBy: { id: 'asc' } });
      const decrypt = vi.spyOn(tokenCrypto, 'decryptToken');
      const response = await api.executeOperation({
        query: 'mutation($ref: ID!) { clearAgentAIConfig(agentId: $ref) { id name aiProvider aiModel aiApiKeyPreview hasAiApiKey } }',
        variables: { ref: `hrn:agent:clear-owner:target` },
      }, { contextValue: context(adminId, [role]) });
      expect(response.body.kind).toBe('single');
      if (response.body.kind !== 'single') throw new Error('Unexpected incremental response');
      expect(response.body.singleResult.errors).toBeUndefined();
      expect(await db.aiServiceConfig.count({ where: { agentId } }), '#1882: platform clear must remove named configs as well as default').toBe(0);
      expect(await db.aiServiceConfig.findMany({ where: { agentId: otherAgentId }, orderBy: { id: 'asc' } })).toEqual(otherBefore);
      expect(response.body.singleResult.data?.clearAgentAIConfig).toMatchObject({ id: agentId, aiProvider: null, aiModel: null, aiApiKeyPreview: null, hasAiApiKey: false });
      expect(decrypt).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body.singleResult)).not.toMatch(/sk-1882|apiKeyEncrypted|fixture-model|1882/);
      await resolvers.Mutation.clearAgentAIConfig({}, { agentId }, context(adminId, [role]));
      expect(await db.aiServiceConfig.count({ where: { agentId } })).toBe(0);
    },
  );

  it('clears a named-only user-owned Agent when no default exists', async () => {
    await config(agentId, 'only-backup');
    await resolvers.Mutation.clearAgentAIConfig({}, { agentId }, context(adminId, ['ADMIN']));
    expect(await db.aiServiceConfig.count({ where: { agentId } }), '#1882: absence of default must not skip the named clear').toBe(0);
  });

  it('CONTROL: an org-owned Agent keeps its named config when its default is cleared', async () => {
    const orgAgent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'Org Agent', urn: 'clear-controls.test:agent', visibility: 'ORGANIZATION' } });
    await config(orgAgent.id, 'default');
    const backup = await config(orgAgent.id, 'backup');
    await resolvers.Mutation.clearAgentAIConfig({}, { agentId: orgAgent.id }, context(adminId, ['ADMIN']));
    expect(await db.aiServiceConfig.findMany({ where: { agentId: orgAgent.id } })).toEqual([backup]);
  });

  it('CONTROL: an ordinary outsider and an impersonated admin cannot clear a user-owned Agent', async () => {
    await config(agentId, 'default');
    await config(agentId, 'backup');
    const before = await configs();
    for (const caller of [context(adminId), { ...context(adminId, ['ADMIN']), impersonation: { orgId, sessionId: 'support', actorUserId: adminId } } as Context]) {
      await expect(resolvers.Mutation.clearAgentAIConfig({}, { agentId }, caller)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
      expect(await configs()).toEqual(before);
    }
  });
});
