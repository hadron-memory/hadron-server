/** #3628 item2: the non-null setter answers the snapshot written before commit. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { resolveAppInstallation } from '../../../lib/appInstallations.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const boundary = { afterCommit: null as null | (() => Promise<void>), missSnapshot: false, armMissAfterWrite: false, snapshotSawWrite: false };
vi.mock('../../../lib/bootPromptPointer.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../../lib/bootPromptPointer.js')>();
  return { ...real, setBootPromptPointer: async (...args: Parameters<typeof real.setBootPromptPointer>) => {
    const result = await real.setBootPromptPointer(...args);
    if (boundary.armMissAfterWrite) { boundary.armMissAfterWrite = false; boundary.missSnapshot = true; }
    return result;
  } };
});
vi.mock('../../../lib/appInstallations.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../../lib/appInstallations.js')>();
  return { ...real, resolveAppInstallation: async (...args: Parameters<typeof real.resolveAppInstallation>) => {
    const answer = await real.resolveAppInstallation(...args);
    if (boundary.missSnapshot) {
      boundary.missSnapshot = false;
      const [client, appId, agentId] = args;
      const key = { appId_agentId: { appId, agentId } };
      const row = answer?.installationKind === 'ROW' ? await client.appAgent.findUnique({ where: key })
        : await (client as unknown as Pick<typeof db, 'appAgentCustomization'>).appAgentCustomization.findUnique({ where: key });
      boundary.snapshotSawWrite = row?.bootPromptNodeId != null;
      return null;
    }
    return answer;
  } };
});
vi.mock('./authorizedTx.js', async importOriginal => {
  const real = await importOriginal<typeof import('./authorizedTx.js')>();
  return { ...real, withAuthorizedTx: async (...args: Parameters<typeof real.withAuthorizedTx>) => {
    const result = await real.withAuthorizedTx(...args);
    if (boundary.afterCommit) {
      const hook = boundary.afterCommit; boundary.afterCommit = null;
      await hook();
    }
    return result;
  } };
});
beforeEach(() => cleanDb(db));
afterEach(() => { boundary.afterCommit = null; boundary.missSnapshot = false; boundary.armMissAfterWrite = false; boundary.snapshotSawWrite = false; });

async function fixture(kind: 'ROW' | 'DERIVED') {
  const key = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'Committed pointer', urn: `cp-${key}.example` } });
  const user = await db.user.create({ data: { handle: `cp-${key}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Target', urn: `${org.urn}:target` } });
  const parent = await db.agent.create({ data: { organizationId: org.id, name: 'Parent', urn: `${org.urn}:parent` } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
  if (kind === 'ROW') await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  else {
    await db.appAgent.create({ data: { appId: app.id, agentId: parent.id } });
    await createDbAgentOrgGrant(db, org.id, agent.id);
    await createDbAgentImport(db, parent.id, agent.id);
  }
  const memory = await db.memory.create({ data: { organizationId: org.id, class: 'system', appId: app.id,
    installOfAgentId: agent.id, isInstallMemory: true, name: 'Install', urn: `${org.urn}:install` } });
  const node = await withCompileWrite(() => db.node.create({ data: { memoryId: memory.id, loc: 'boot:compiled',
    name: 'Compiled', content: 'compiled', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  return { app, agent, parent, memory, node, ctx: { db, userId: user.id, roles: ['READER'] } as Context };
}

for (const kind of ['ROW', 'DERIVED'] as const) for (const clear of [false, true]) {
  it(`${kind} ${clear ? 'clear' : 'set'} returns its committed snapshot when the witness disappears after commit`, async () => {
    const f = await fixture(kind);
    const args = { appRef: f.app.id, agentRef: f.agent.id, nodeRef: f.node.id };
    const set = () => (resolvers.Mutation as any).setAppAgentBootPrompt(null, { ...args, nodeRef: clear ? null : f.node.id }, f.ctx);
    if (clear) await (resolvers.Mutation as any).setAppAgentBootPrompt(null, args, f.ctx);
    let committed = false;
    boundary.afterCommit = async () => {
      // DERIVED pointers live in customization, not the virtual membership row.
      const where = { appId_agentId: { appId: f.app.id, agentId: f.agent.id } };
      const written = kind === 'ROW' ? await db.appAgent.findUnique({ where })
        : await db.appAgentCustomization.findUnique({ where });
      expect(written?.bootPromptNodeId).toBe(clear ? null : f.node.id);
      committed = true;
      if (kind === 'ROW') await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } });
      else await db.agentImport.delete({ where: { parentAgentId_importedAgentId: { parentAgentId: f.parent.id, importedAgentId: f.agent.id } } });
    };
    const answer = await set();
    expect(committed).toBe(true);
    expect(await resolveAppInstallation(db, f.app.id, f.agent.id)).toBeNull();
    expect(answer).toMatchObject({ appId: f.app.id, agentId: f.agent.id, installationKind: kind, bootPromptNodeId: kind === 'ROW' && !clear ? f.node.id : null });
  });
  it(`${kind} ${clear ? 'clear' : 'set'} returns its committed snapshot after target soft deletion`, async () => {
    const f = await fixture(kind);
    const args = { appRef: f.app.id, agentRef: f.agent.id, nodeRef: f.node.id };
    if (clear) await (resolvers.Mutation as any).setAppAgentBootPrompt(null, args, f.ctx);
    boundary.afterCommit = async () => { await db.agent.update({ where: { id: f.agent.id }, data: { deletedAt: new Date() } }); };
    const answer = await (resolvers.Mutation as any).setAppAgentBootPrompt(null, { ...args, nodeRef: clear ? null : f.node.id }, f.ctx);
    expect(await resolveAppInstallation(db, f.app.id, f.agent.id)).toBeNull();
    expect(answer).toMatchObject({ appId: f.app.id, agentId: f.agent.id, installationKind: kind, bootPromptNodeId: kind === 'ROW' && !clear ? f.node.id : null });
  });
}

const schema = buildSchema(typeDefs);
async function wireSet(f: Awaited<ReturnType<typeof fixture>>, clear = false) {
  return graphql({ schema, source: `mutation($a:String!,$g:String!,$n:String) {
    setAppAgentBootPrompt(appRef:$a,agentRef:$g,nodeRef:$n) { __typename agent { id } bootPromptRef }
  }`, variableValues: { a: f.app.id, g: f.agent.id, n: clear ? null : f.node.id }, contextValue: f.ctx,
  fieldResolver: (parent, args, context, info) => {
    const fn = (resolvers as any)[info.parentType.name]?.[info.fieldName];
    return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
  } });
}
for (const kind of ['ROW', 'DERIVED'] as const) {
  it(`${kind} exposes the committed pointer through the actual GraphQL field, not the raw membership slot`, async () => {
    const f = await fixture(kind);
    const result = await wireSet(f);
    expect(result.errors).toBeUndefined();
    expect(result.data?.setAppAgentBootPrompt).toMatchObject({ __typename: 'AppAgent', agent: { id: f.agent.id } });
    expect((result.data?.setAppAgentBootPrompt as any).bootPromptRef).toBe(`hrn:node:${f.memory.urn}:${f.node.loc}`);
    const cleared = await wireSet(f, true);
    expect(cleared.errors).toBeUndefined();
    expect((cleared.data?.setAppAgentBootPrompt as any).bootPromptRef).toBeNull();
  });
  it(`${kind} keeps the non-null GraphQL payload when a post-commit Agent deletion masks the nullable child`, async () => {
    const f = await fixture(kind);
    boundary.afterCommit = async () => { await db.agent.update({ where: { id: f.agent.id }, data: { deletedAt: new Date() } }); };
    const result = await wireSet(f);
    expect(result.errors).toBeUndefined();
    expect(result.data?.setAppAgentBootPrompt).toMatchObject({ __typename: 'AppAgent', agent: null });
  });
  it(`${kind} refuses a pre-commit snapshot miss and rolls back the already-written pointer`, async () => {
    const f = await fixture(kind);
    boundary.armMissAfterWrite = true;
    await expect((resolvers.Mutation as any).setAppAgentBootPrompt(null,
      { appRef: f.app.id, agentRef: f.agent.id, nodeRef: f.node.id }, f.ctx)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    expect(boundary.snapshotSawWrite).toBe(true);
    const key = { appId_agentId: { appId: f.app.id, agentId: f.agent.id } };
    if (kind === 'ROW') expect((await db.appAgent.findUniqueOrThrow({ where: key })).bootPromptNodeId).toBeNull();
    else expect(await db.appAgentCustomization.findUnique({ where: key })).toBeNull();
  });
}
