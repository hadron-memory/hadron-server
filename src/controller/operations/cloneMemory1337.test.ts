/**
 * #1337 — `cloneMemoryGraph` carries the source's MemoryConfig and NodeRoleRule
 * rows (with `sourceTemplateId` and `locked`) into the clone, remapping the
 * three node references through the clone's old→new id map. A reference to a
 * node the clone excluded becomes null (a required task then fails closed,
 * D-2026-09-25-E); a reference into ANOTHER memory is kept when the cloning
 * actor can read it, in any org, and nulled when not. `sourceTemplateId` is
 * kept within an org and dropped across orgs (§10: a template is not readable
 * by the target org).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { cloneMemoryGraphInTx } from './cloneMemory.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

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

function clone(opts: { target?: string; newUrn?: string; readable?: string[] | null } = {}) {
  return db.$transaction((tx) =>
    cloneMemoryGraphInTx(tx, {
      sourceMemoryId: srcId, name: 'copy', newUrn: opts.newUrn ?? 'c1-a:copy', targetOrganizationId: opts.target ?? orgId,
      ownerUserId: null, groupOwnerUserId: null, actorId: 'cloner', copierReadableMemoryIds: opts.readable === undefined ? null : opts.readable,
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

  it('a reference into another memory is kept on both same-org and cross-org clones when the copier can read it', async () => {
    await seedConfig();
    const same = await clone();
    expect((await rulesOf(same.memoryId))!.rules.find((r) => r.role === 'review')!.validationTaskId).toBe(n.foreign);
    const cross = await clone({ target: otherOrgId, newUrn: 'c1-b:copy' });
    expect((await rulesOf(cross.memoryId))!.rules.find((r) => r.role === 'review')!.validationTaskId).toBe(n.foreign);
  });

  it('sourceTemplateId is kept within an org and dropped on a cross-org clone, locked kept either way', async () => {
    await seedConfig();
    const same = (await rulesOf((await clone()).memoryId))!.rules.find((r) => r.role === 'spec')!;
    expect(same).toMatchObject({ sourceTemplateId: 'tmpl-1', locked: true });
    const cross = (await rulesOf((await clone({ target: otherOrgId, newUrn: 'c1-b:copy-t' })).memoryId))!.rules.find((r) => r.role === 'spec')!;
    expect(cross.sourceTemplateId).toBeNull();
    expect(cross.locked).toBe(true);
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

  it('a denied clone (reader in the target org) writes no memory and no config', async () => {
    await seedConfig();
    const user = await db.user.create({ data: { id: generateId(), name: 'c1-user' } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: user.id, role: 'ADMIN' } });
    await db.orgMember.create({ data: { organizationId: otherOrgId, userId: user.id, role: 'READER' } });
    const ctx = { db, userId: user.id, roles: [], clientId: `user:${user.id}` } as unknown as Context;
    const before = await db.memoryConfig.count();
    await expect((resolvers.Mutation as any).cloneMemory({}, { ref: srcId, targetUrn: 'hrn:mem:c1-b:denied' }, ctx))
      .rejects.toThrow(/Forbidden/);
    expect(await db.memory.count({ where: { urn: 'c1-b:denied' } })).toBe(0);
    expect(await db.memoryConfig.count()).toBe(before);
  });

  it('an external reference survives only when the copier can read its memory, in any org', async () => {
    await seedConfig();
    const thirdMem = generateId();
    await db.memory.create({ data: { id: thirdMem, organizationId: otherOrgId, name: 'third', urn: 'c1-b:third', class: 'knowledge' } as never });
    const thirdNode = generateId();
    await node(thirdNode, thirdMem, 'tasks:third');
    const unreadMem = generateId();
    await db.memory.create({ data: { id: unreadMem, organizationId: orgId, name: 'unread', urn: 'c1-a:unread', class: 'knowledge' } as never });
    const unreadNode = generateId();
    await node(unreadNode, unreadMem, 'tasks:unread');
    const config = await db.memoryConfig.findUniqueOrThrow({ where: { memoryId: srcId } });
    await db.nodeRoleRule.create({
      data: {
        id: generateId(), configId: config.id, role: 'ext',
        authorTaskId: thirdNode, authorTaskRequired: true,
        validationTaskId: unreadNode, validationTaskRequired: true,
        descriptionNodeId: n.foreign,
      },
    });
    const ext = async (r: { memoryId: string }) => (await rulesOf(r.memoryId))!.rules.find((x) => x.role === 'ext')!;
    // The copier reads only the foreign memory: the third-org and unreadable refs drop (flags stay), the readable one stays.
    const some = await ext(await clone({ readable: [foreignMemId], newUrn: 'c1-a:copy-r' }));
    expect(some.authorTaskId, 'third org, unreadable').toBeNull();
    expect(some.validationTaskId, 'unreadable').toBeNull();
    expect(some.descriptionNodeId, 'readable').toBe(n.foreign);
    expect(some).toMatchObject({ authorTaskRequired: true, validationTaskRequired: true });
    // A copier who reads the third org's memory keeps that reference even though it is in another org.
    const third = await ext(await clone({ readable: [thirdMem], newUrn: 'c1-a:copy-3' }));
    expect(third.authorTaskId, 'readable, third org').toBe(thirdNode);
    expect(third.validationTaskId).toBeNull();
    // An unrestricted copier keeps all three.
    const all = await ext(await clone({ readable: null, newUrn: 'c1-a:copy-u' }));
    expect([all.authorTaskId, all.validationTaskId, all.descriptionNodeId]).toEqual([thirdNode, unreadNode, n.foreign]);
  });

  it('external author/description refs and a deleted external target behave like the validation ref', async () => {
    const deletedForeign = generateId();
    await node(deletedForeign, foreignMemId, 'tasks:deleted', new Date());
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: srcId } });
    await db.nodeRoleRule.create({
      data: {
        id: generateId(), configId: config.id, role: 'ext',
        authorTaskId: n.foreign, authorTaskRequired: true,
        validationTaskId: deletedForeign, validationTaskRequired: true,
        descriptionNodeId: n.foreign,
      },
    });
    const rule = (await rulesOf((await clone()).memoryId))!.rules[0];
    expect(rule.authorTaskId).toBe(n.foreign);
    expect(rule.descriptionNodeId).toBe(n.foreign);
    expect(rule.validationTaskId, 'deleted external').toBeNull();
    expect(rule.validationTaskRequired).toBe(true);
  });

  it('a node type the clone does not copy becomes null, and an existing but empty config is carried as an empty config', async () => {
    const comment = generateId();
    await db.node.create({ data: { id: comment, memoryId: srcId, loc: 'boot:compiled', name: 'compiled', nodeType: 'compiled-boot-prompt', role: 'boot-prompt' } as never });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: srcId } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'ext', authorTaskId: comment, authorTaskRequired: true } });
    const res = await clone();
    expect((await rulesOf(res.memoryId))!.rules[0].authorTaskId, 'an uncopied node type is not carried').toBeNull();
    await db.nodeRoleRule.deleteMany({ where: { configId: config.id } });
    const empty = await clone({ newUrn: 'c1-a:copy-e' });
    const cfg = await rulesOf(empty.memoryId);
    expect(cfg, 'empty config carried').not.toBeNull();
    expect(cfg!.rules).toEqual([]);
  });

  it('a reference into a soft-deleted memory becomes null', async () => {
    const deadMem = generateId();
    await db.memory.create({ data: { id: deadMem, organizationId: orgId, name: 'dead', urn: 'c1-a:dead', class: 'knowledge', deletedAt: new Date() } as never });
    const deadNode = generateId();
    await node(deadNode, deadMem, 'tasks:dead');
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: srcId } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'ext', authorTaskId: deadNode, authorTaskRequired: true } });
    const rule = (await rulesOf((await clone()).memoryId))!.rules[0];
    expect(rule.authorTaskId).toBeNull();
    expect(rule.authorTaskRequired).toBe(true);
  });
});
