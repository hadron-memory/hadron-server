/** #3634: real fields must serialize the live licence refusal, not null plus a GraphQL error. */
import { beforeEach, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId: string, orgId: string, appId: string, workerId: string;
beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({ data: { handle: 'enum3634-owner', roles: ['READER'] } });
  userId = owner.id;
  const org = await db.organization.create({ data: { name: 'Publisher', urn: 'enum3634.test' } });
  orgId = org.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'READER' } });
  const memory = await db.memory.create({ data: { class: 'system', organizationId: orgId, name: 'System', urn: 'enum3634.test:system' } });
  const agent = await db.agent.create({ data: { organizationId: orgId, name: 'Role', urn: 'enum3634.test:role', visibility: 'ORGANIZATION', systemMemoryId: memory.id } });
  await serveAgentBootPrompt(db, agent.id, 'Readable approved prompt.');
  await db.agentSubscription.create({ data: { userId, agentId: agent.id, activatedAt: new Date('2020-01-01') } });
  const app = await db.app.create({ data: { ownerUserId: userId, name: 'Personal', urn: '@enum3634-owner:personal' } });
  appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  workerId = (await db.worker.create({ data: { appId, agentId: agent.id, name: 'Iris', slug: 'iris', signature: '', trailer: '' } })).id;
});
async function select() {
  return graphql({ schema: buildSchema(typeDefs),
    source: `query($worker: ID!, $app: ID!) {
      worker(ref: $worker) { bootPromptServe { refusal served { pointerLevel } } }
      app(ref: $app) { appAgents { bootPromptServe { refusal served { pointerLevel } } } }
    }`, variableValues: { worker: workerId, app: appId }, contextValue: { db, userId, roles: ['READER'] } satisfies Context,
    fieldResolver(parent, args, context, info) {
      const fn = (resolvers as any)[info.parentType.name]?.[info.fieldName];
      return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
    },
  });
}
it('selects readable Worker and AppAgent served positives without GraphQL errors', async () => {
  const result = await select();
  expect(result.errors).toBeUndefined();
  const outcome = { refusal: null, served: { pointerLevel: 'AGENT' } };
  expect(result.data).toEqual({ worker: { bootPromptServe: outcome }, app: { appAgents: [{ bootPromptServe: outcome }] } });
});
it('selects typed inactive-licence refusal on Worker and AppAgent after owner membership ends', async () => {
  await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId } }, data: { deletedAt: new Date() } });
  const result = await select();
  expect(result.errors).toBeUndefined();
  const outcome = { refusal: 'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE', served: null };
  expect(result.data).toEqual({ worker: { bootPromptServe: outcome }, app: { appAgents: [{ bootPromptServe: outcome }] } });
});
