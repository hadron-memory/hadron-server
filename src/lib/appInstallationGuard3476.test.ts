/** #3476: discriminate the retained g3/c5/c11 guards without their callers' earlier fences. */
import { beforeEach, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../test/helpers.js';
import { generateId } from './id.js';
import { listAppInstallations } from './appInstallations.js';
import { compileChain } from './effectiveSystemMemory.js';
import { instantiateAgentTickerTemplates } from './tickers/agentTickerTemplates.js';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';

beforeEach(() => cleanDb(db));
async function fixture(kind: 'ROW' | 'DERIVED') {
  const org = async (name: string) => db.organization.create({ data: { name, urn: `guard-${generateId().toLowerCase()}.example` } });
  const [holder, owner, importer] = await Promise.all([org('Holder'), org('Owner'), org('Importer')]);
  const system = await db.memory.create({ data: { organizationId: owner.id, class: 'system', name: 'System', urn: `guard-${generateId().toLowerCase()}:system` } });
  const target = await db.agent.create({ data: { organizationId: owner.id, name: 'Target', urn: `${owner.urn}:target`, systemMemoryId: system.id } });
  const parent = await db.agent.create({ data: { organizationId: importer.id, name: 'Parent', urn: `${importer.urn}:parent` } });
  const app = await db.app.create({ data: { organizationId: holder.id, name: 'Guard app', urn: `${holder.urn}:app` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: parent.id } });
  await createDbAgentOrgGrant(db, holder.id, target.id);
  if (kind === 'ROW') await db.appAgent.create({ data: { appId: app.id, agentId: target.id } });
  else {
    await createDbAgentOrgGrant(db, importer.id, target.id);
    await createDbAgentImport(db, parent.id, target.id);
  }
  return { holder, owner, parent, target, app, system };
}

it.each(['ROW', 'DERIVED'] as const)('g3 keeps physical semantics but excludes a %s foreign-owner tombstone', async kind => {
  const f = await fixture(kind);
  expect((await listAppInstallations(db, f.app.id)).map(row => row.agentId)).toContain(f.target.id);
  await db.organization.update({ where: { id: f.owner.id }, data: { deletedAt: new Date() } });
  const targets = (await listAppInstallations(db, f.app.id)).filter(row => row.agentId === f.target.id);
  expect(targets).toHaveLength(kind === 'ROW' ? 1 : 0);
});

it.each(['ROW', 'DERIVED'] as const)('c11 a retained install memory cannot contribute after %s membership disappears', async kind => {
  const f = await fixture(kind);
  const install = await db.memory.create({ data: {
    organizationId: f.holder.id, appId: f.app.id, installOfAgentId: f.target.id,
    isInstallMemory: true, class: 'system', name: 'Retained install', urn: `${f.holder.urn}:install`,
  } });
  const target = { appId: f.app.id, agentId: f.target.id };
  expect((await compileChain(db, target)).installMemoryId).toBe(install.id);
  if (kind === 'ROW') await db.appAgent.delete({ where: { appId_agentId: target } });
  else await db.agentImport.delete({ where: { parentAgentId_importedAgentId: { parentAgentId: f.parent.id, importedAgentId: f.target.id } } });
  const after = await compileChain(db, target);
  expect(after.installMemoryId).toBeNull();
  expect(after.links.map(link => link.memoryId)).toEqual([f.system.id]);
  expect(await db.memory.findUnique({ where: { id: install.id } })).not.toBeNull();
});

it.each(['ROW', 'DERIVED'] as const)('c5 template instantiation itself fences the %s witness, without a cast pre-fence', async kind => {
  const f = await fixture(kind);
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: f.app.id, agentId: f.target.id, name: 'Fixture', slug: 'fixture' } });
  await db.agentTickerTemplate.create({ data: { agentId: f.target.id, name: 'Guard', cadenceSeconds: 600, reasons: ['read-team-channel'] } });
  let removal = '';
  await db.$transaction(async tx => {
    const created = await instantiateAgentTickerTemplates(tx, { appId: f.app.id, agentId: f.target.id, worker, createdBy: null });
    expect(created).toHaveLength(1);
    removal = await db.$transaction(async other => {
      await other.$executeRaw`SET LOCAL lock_timeout = '150ms'`;
      if (kind === 'ROW') await other.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.target.id } } });
      else await other.agentImport.delete({ where: { parentAgentId_importedAgentId: { parentAgentId: f.parent.id, importedAgentId: f.target.id } } });
      return 'committed';
    }).then(String, (error: Error) => error.message);
  }, { timeout: 15_000 });
  expect(removal).toMatch(/lock timeout|canceling statement/i);
  expect(await db.ticker.count({ where: { generatedForWorkerId: worker.id, deletedAt: null } })).toBe(1);
  expect(kind === 'ROW'
    ? await db.appAgent.count({ where: { appId: f.app.id, agentId: f.target.id } })
    : await db.agentImport.count({ where: { parentAgentId: f.parent.id, importedAgentId: f.target.id } })).toBe(1);
}, 20_000);
