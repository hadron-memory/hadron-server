/** #3628 item2: the non-null setter answers the snapshot written before commit. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { resolveAppInstallation } from '../../../lib/appInstallations.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const boundary = { afterCommit: null as null | (() => Promise<void>) };
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
afterEach(() => { boundary.afterCommit = null; });

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
  return { app, agent, parent, node, ctx: { db, userId: user.id, roles: ['READER'] } as Context };
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
