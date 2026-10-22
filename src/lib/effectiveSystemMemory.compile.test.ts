/**
 * #2044 (S7), cor:agt:040:16 / cor:dmo:050:14 (R8) — a COMPILE reads, nearest
 * first: the App's install memory, the Agent's own system memory, then each
 * base. Ordinary reads of the Agent's system memory never see an install memory.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent } from '../test/helpers.js';
import { generateId } from './id.js';
import { compileChain, findCompileNodeIdByLoc, findEffectiveNodeIdByLoc, systemMemoryChain } from './effectiveSystemMemory.js';

let orgId: string;
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cc-org', urn: 'cc-org' } })).id;
});

async function sysMemory(name: string) {
  return db.memory.create({ data: { id: generateId(), class: 'system', name, urn: `${orgId}:${name}`, organizationId: orgId } });
}
async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'page', ...extra } });
}

async function fixture() {
  const baseMem = await sysMemory('base-sys');
  const childMem = await sysMemory('child-sys');
  const base = await db.agent.create({ data: { id: generateId(), name: 'Base', urn: `${orgId}:base`, organizationId: orgId, systemMemoryId: baseMem.id } });
  const child = await db.agent.create({
    data: { id: generateId(), name: 'Child', urn: `${orgId}:child`, organizationId: orgId, systemMemoryId: childMem.id, extendsAgentId: base.id },
  });
  const apps = [];
  for (const name of ['app-one', 'app-two']) {
    const { app } = await createDbAppWithKey(db, name, orgId);
    await createDbAppAgent(db, app.id, child.id);
    const install = await db.memory.create({
      data: { id: generateId(), class: 'system', name: `${name}-install`, urn: `${orgId}:${name}-install`, organizationId: orgId, appId: app.id, installOfAgentId: child.id, isInstallMemory: true },
    });
    apps.push({ app, install });
  }
  return { baseMem, childMem, base, child, apps };
}

describe('#2044 compileChain / findCompileNodeIdByLoc', () => {
  it('install → child → base, nearest wins, whole-node replacement by address', async () => {
    const f = await fixture();
    const nBase = await node(f.baseMem.id, 'only:base');
    const nBoth = await node(f.baseMem.id, 'shared:loc');
    const nChild = await node(f.childMem.id, 'shared:loc');
    const nInstall = await node(f.apps[0]!.install.id, 'shared:loc');
    const target = { appId: f.apps[0]!.app.id, agentId: f.child.id };
    const chain = await compileChain(db, target);
    expect(chain.links.map((l) => l.memoryId)).toEqual([f.apps[0]!.install.id, f.childMem.id, f.baseMem.id]);
    expect((await findCompileNodeIdByLoc(db, target, 'shared:loc'))?.id).toBe(nInstall.id);
    expect((await findCompileNodeIdByLoc(db, target, 'only:base'))?.id).toBe(nBase.id);
    await db.node.delete({ where: { id: nInstall.id } });
    expect((await findCompileNodeIdByLoc(db, target, 'shared:loc'))?.id).toBe(nChild.id);
    await db.node.delete({ where: { id: nChild.id } });
    expect((await findCompileNodeIdByLoc(db, target, 'shared:loc'))?.id).toBe(nBoth.id);
    expect(await findCompileNodeIdByLoc(db, target, 'nowhere')).toBeNull();
  });

  it('a base\'s boot prompt is never a candidate, but the install memory\'s and the Agent\'s own are', async () => {
    const f = await fixture();
    const target = { appId: f.apps[0]!.app.id, agentId: f.child.id };
    await node(f.baseMem.id, 'boot', { role: 'boot-prompt' });
    expect(await findCompileNodeIdByLoc(db, target, 'boot')).toBeNull();
    const own = await node(f.childMem.id, 'boot', { role: 'boot-prompt' });
    expect((await findCompileNodeIdByLoc(db, target, 'boot'))?.id).toBe(own.id);
    const inst = await node(f.apps[0]!.install.id, 'boot', { role: 'boot-prompt' });
    const hit = await findCompileNodeIdByLoc(db, target, 'boot');
    expect(hit).toMatchObject({ id: inst.id, fromInstall: true });
  });

  it('two Apps with distinct overrides each compile their own, and neither sees the other\'s', async () => {
    const f = await fixture();
    const a = await node(f.apps[0]!.install.id, 'prompts:lane');
    const b = await node(f.apps[1]!.install.id, 'prompts:lane');
    expect((await findCompileNodeIdByLoc(db, { appId: f.apps[0]!.app.id, agentId: f.child.id }, 'prompts:lane'))?.id).toBe(a.id);
    expect((await findCompileNodeIdByLoc(db, { appId: f.apps[1]!.app.id, agentId: f.child.id }, 'prompts:lane'))?.id).toBe(b.id);
  });

  it('no install memory, a deleted App or an uninstalled Agent contribute nothing', async () => {
    const f = await fixture();
    await node(f.apps[0]!.install.id, 'prompts:lane');
    const own = await node(f.childMem.id, 'prompts:lane');
    const target = { appId: f.apps[0]!.app.id, agentId: f.child.id };
    await db.app.update({ where: { id: f.apps[0]!.app.id }, data: { deletedAt: new Date() } });
    expect((await findCompileNodeIdByLoc(db, target, 'prompts:lane'))?.id).toBe(own.id);
    await db.app.update({ where: { id: f.apps[0]!.app.id }, data: { deletedAt: null } });
    await db.appAgent.delete({ where: { appId_agentId: target } });
    expect((await compileChain(db, target)).installMemoryId).toBeNull();
  });

  it('ordinary reads of the Agent\'s system memory never see an install node', async () => {
    const f = await fixture();
    await node(f.apps[0]!.install.id, 'prompts:lane');
    expect(await findEffectiveNodeIdByLoc(db, f.childMem.id, 'prompts:lane')).toBeNull();
    expect((await systemMemoryChain(db, f.childMem.id)).map((l) => l.memoryId)).toEqual([f.childMem.id, f.baseMem.id]);
  });
});
