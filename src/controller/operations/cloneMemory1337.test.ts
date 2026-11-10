/**
 * #1337 — `cloneMemoryGraph` carries the source's MemoryConfig and NodeRoleRule
 * rows (with `sourceTemplateId` and `locked`) into the clone, remapping the
 * three node references through the clone's old→new id map. A reference to a
 * node the clone excluded becomes null (a required task then fails closed,
 * D-2026-09-25-E); a reference into ANOTHER memory is kept on a same-org clone
 * and dropped on a cross-org one (the same isolation rule as edges, #604).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { cloneMemoryGraphInTx } from './cloneMemory.js';

let orgId: string;
let otherOrgId: string;
let srcId: string;
let foreignMemId: string;
const n = { author: generateId(), validation: generateId(), desc: generateId(), gone: generateId(), foreign: generateId() };

async function node(id: string, memoryId: string, loc: string, deletedAt?: Date) {
  await db.node.create({ data: { id, memoryId, loc, name: loc, nodeType: 'page', ...(deletedAt ? { deletedAt } : {}) } as never });
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'c1-a', urn: 'c1-a' } })).id;
  otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'c1-b', urn: 'c1-b' } })).id;
  srcId = generateId();
  foreignMemId = generateId();
  await db.memory.create({ data: { id: srcId, organizationId: orgId, name: 'src', urn: 'c1-a:src', class: 'knowledge' } as never });
  await db.memory.create({ data: { id: foreignMemId, organizationId: orgId, name: 'other', urn: 'c1-a:other', class: 'knowledge' } as never });
  await node(n.author, srcId, 'tasks:author');
  await node(n.validation, srcId, 'tasks:validate');
  await node(n.desc, srcId, 'docs:spec');
  await node(n.gone, srcId, 'tasks:gone', new Date());
  await node(n.foreign, foreignMemId, 'tasks:foreign');
});

async function seedConfig() {
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: srcId, createdBy: 'src-author' } });
  await db.nodeRoleRule.create({
    data: {
      id: generateId(), configId: config.id, role: 'spec',
      authorTaskId: n.author, authorTaskRequired: true,
      validationTaskId: n.validation, validationTaskRequired: true,
      descriptionNodeId: n.desc, strictSubRoles: true, writers: 'ADMIN', validateBy: 'PLATFORM',
      enabled: false, sourceTemplateId: 'tmpl-1', locked: true, revision: 7, createdBy: 'src-author',
    },
  });
  await db.nodeRoleRule.create({
    data: { id: generateId(), configId: config.id, role: 'review', authorTaskId: n.gone, authorTaskRequired: true, validationTaskId: n.foreign, validationTaskRequired: true, descriptionNodeId: n.gone },
  });
  return config;
}

function clone(opts: { target?: string; newUrn?: string } = {}) {
  return db.$transaction((tx) =>
    cloneMemoryGraphInTx(tx, {
      sourceMemoryId: srcId, name: 'copy', newUrn: opts.newUrn ?? 'c1-a:copy', targetOrganizationId: opts.target ?? orgId,
      ownerUserId: null, groupOwnerUserId: null, actorId: 'cloner', copierReadableMemoryIds: null,
    }),
  );
}

async function rulesOf(memoryId: string) {
  const cfg = await db.memoryConfig.findUnique({ where: { memoryId }, include: { rules: true } });
  return cfg;
}

describe('#1337 clone carries the rulebook', () => {
  it('copies each rule with locked, sourceTemplateId and every flag; new rows start at revision 1', async () => {
    const src = await seedConfig();
    const res = await clone();
    const cfg = await rulesOf(res.memoryId);
    expect(cfg, 'the clone has a config').not.toBeNull();
    expect(cfg!.id).not.toBe(src.id);
    expect(cfg!.createdBy).toBe('cloner');
    const spec = cfg!.rules.find((r) => r.role === 'spec')!;
    expect(spec).toMatchObject({
      authorTaskRequired: true, validationTaskRequired: true, strictSubRoles: true, writers: 'ADMIN',
      validateBy: 'PLATFORM', enabled: false, sourceTemplateId: 'tmpl-1', locked: true, revision: 1, createdBy: 'cloner',
    });
    expect(cfg!.rules.map((r) => r.role).sort()).toEqual(['review', 'spec']);
  });

  it('remaps the three node references to the clone\'s own nodes', async () => {
    await seedConfig();
    const res = await clone();
    const spec = (await rulesOf(res.memoryId))!.rules.find((r) => r.role === 'spec')!;
    expect(spec.authorTaskId).toBe(res.nodeIdMap.get(n.author));
    expect(spec.validationTaskId).toBe(res.nodeIdMap.get(n.validation));
    expect(spec.descriptionNodeId).toBe(res.nodeIdMap.get(n.desc));
    for (const id of [spec.authorTaskId, spec.validationTaskId, spec.descriptionNodeId]) {
      expect((await db.node.findUniqueOrThrow({ where: { id: id! } })).memoryId).toBe(res.memoryId);
    }
  });

  it('an excluded target becomes null and the required task stays required (fails closed)', async () => {
    await seedConfig();
    const res = await clone();
    const review = (await rulesOf(res.memoryId))!.rules.find((r) => r.role === 'review')!;
    expect(review.authorTaskId).toBeNull();
    expect(review.descriptionNodeId).toBeNull();
    expect(review.authorTaskRequired).toBe(true);
  });

  it('a reference into another memory is kept on a same-org clone and dropped on a cross-org clone', async () => {
    await seedConfig();
    const same = await clone();
    expect((await rulesOf(same.memoryId))!.rules.find((r) => r.role === 'review')!.validationTaskId).toBe(n.foreign);
    const cross = await clone({ target: otherOrgId, newUrn: 'c1-b:copy' });
    expect((await rulesOf(cross.memoryId))!.rules.find((r) => r.role === 'review')!.validationTaskId).toBeNull();
  });

  it('a source with no config produces no config row', async () => {
    const res = await clone();
    expect(await db.memoryConfig.count({ where: { memoryId: res.memoryId } })).toBe(0);
  });

  it('a source edit after the clone leaves the clone\'s rules unchanged', async () => {
    const src = await seedConfig();
    const res = await clone();
    await db.nodeRoleRule.updateMany({ where: { configId: src.id, role: 'spec' }, data: { writers: 'OWNER', locked: false, revision: 8 } });
    const spec = (await rulesOf(res.memoryId))!.rules.find((r) => r.role === 'spec')!;
    expect(spec).toMatchObject({ writers: 'ADMIN', locked: true, revision: 1 });
  });

  it('a failure after the copy leaves no memory and no config', async () => {
    await seedConfig();
    await expect(db.$transaction(async (tx) => {
      await cloneMemoryGraphInTx(tx, {
        sourceMemoryId: srcId, name: 'copy', newUrn: 'c1-a:copy', targetOrganizationId: orgId,
        ownerUserId: null, groupOwnerUserId: null, actorId: 'cloner', copierReadableMemoryIds: null,
      });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await db.memory.count({ where: { urn: 'c1-a:copy' } })).toBe(0);
    expect(await db.memoryConfig.count()).toBe(1);
  });
});
