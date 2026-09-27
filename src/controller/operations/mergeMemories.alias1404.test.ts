/** #1404: identity-preserving memory merges must preserve published node addresses. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { resolveNodeRef } from '../../lib/entityRef/nodeRef.js';
import { recordUrnRename } from '../../lib/urnAlias.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { mergeMemoryGraph } from './mergeMemories.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let adminId: string;
let source: { id: string; urn: string };
let target: { id: string; urn: string };
let sourceReaderId: string;

const nodeUrn = (memory: { urn: string }, loc: string) => `hrn:node:${memory.urn}:${loc}`;
const ctx = (userId = adminId): Context => ({ db, userId, roles: userId === adminId ? ['ADMIN'] : [] });
const makeNode = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}` },
});
const aliasesFor = (nodeId: string) => db.urnAlias.findMany({
  where: { entityType: 'NODE', entityId: nodeId },
});
const merge = (deleteSourceMem = false) => mergeMemoryGraph(db, {
  sourceMemoryId: source.id,
  targetMemoryId: target.id,
  fields: new Set(['CONTENT', 'EDGES']),
  deleteSourceMem,
  editor: { userId: adminId },
  batchSize: 1,
  classifyPageSize: 2,
});

beforeEach(async () => {
  await cleanDb(db);
  const sourceOrg = await db.organization.create({
    data: { id: generateId(), urn: 'merge-alias-source.example', name: 'Source' },
  });
  const targetOrg = await db.organization.create({
    data: { id: generateId(), urn: 'merge-alias-target.example', name: 'Target' },
  });
  const admin = await db.user.create({
    data: { githubId: 140401, githubUsername: 'merge-alias-admin', roles: ['ADMIN'] },
  });
  const reader = await db.user.create({
    data: { githubId: 140402, githubUsername: 'merge-alias-source-reader', roles: [] },
  });
  adminId = admin.id;
  sourceReaderId = reader.id;
  await db.orgMember.createMany({ data: [
    { organizationId: sourceOrg.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: targetOrg.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: sourceOrg.id, userId: reader.id, role: 'READER' },
  ] });
  source = await db.memory.create({ data: {
    id: generateId(), organizationId: sourceOrg.id, urn: `${sourceOrg.urn}:source`,
    name: 'source', class: 'knowledge', visibility: 'ORGANIZATION',
  } });
  target = await db.memory.create({ data: {
    id: generateId(), organizationId: targetOrg.id, urn: `${targetOrg.urn}:target`,
    name: 'target', class: 'knowledge', visibility: 'ORGANIZATION',
  } });
});

describe('#1404 mergeMemories node aliases', () => {
  it('resolves an old full URN after a same-id memory relocation', async () => {
    const node = await makeNode(source.id, 'old-address');
    const old = nodeUrn(source, node.loc);
    await merge();

    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).memoryId)
      .toBe(target.id);
    expect(await resolveNodeRef(db, old)).toEqual({ id: node.id });
  });

  it('records every relocated identity, including a descendant, and resolves old read/write refs', async () => {
    const parent = await makeNode(source.id, 'folder');
    const child = await makeNode(source.id, 'folder:child');
    const oldParent = nodeUrn(source, parent.loc);
    const oldChild = nodeUrn(source, child.loc);

    await merge(true);

    expect((await aliasesFor(parent.id)).map((a) => a.urn)).toEqual([`${source.urn}:folder`]);
    expect((await aliasesFor(child.id)).map((a) => a.urn)).toEqual([`${source.urn}:folder:child`]);
    expect(await resolveNodeRef(db, oldParent)).toEqual({ id: parent.id });
    expect((await resolvers.Query.node(null, { ref: oldChild }, ctx()))?.id).toBe(child.id);
    await resolvers.Mutation.updateNode(null, {
      input: { id: oldChild, content: 'updated through predecessor' },
    }, ctx());
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).content)
      .toBe('updated through predecessor');
  });

  it('does not invent an alias from a folded source identity to its distinct survivor', async () => {
    const folded = await makeNode(source.id, 'same');
    const survivor = await makeNode(target.id, 'same');

    await merge();

    expect(await db.node.findUnique({ where: { id: folded.id } })).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: survivor.id } })).memoryId)
      .toBe(target.id);
    expect(await aliasesFor(folded.id)).toEqual([]);
  });

  it('does not record the mirror root empty loc as a published node address', async () => {
    const root = await makeNode(source.id, '');
    await merge();

    expect((await db.node.findUniqueOrThrow({ where: { id: root.id } })).memoryId)
      .toBe(target.id);
    expect(await aliasesFor(root.id)).toEqual([]);
  });

  it('reads the source URN after a concurrent Memory rename commits', async () => {
    const node = await makeNode(source.id, 'renamed-memory');
    const oldMemoryUrn = source.urn;
    const newMemoryUrn = 'merge-alias-source.example:renamed';
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseRename!: () => void;
    const held = new Promise<void>((resolve) => { releaseRename = resolve; });
    const rename = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${source.id} FOR UPDATE`;
      await recordUrnRename(tx, {
        entityType: 'MEMORY', entityId: source.id,
        oldUrn: oldMemoryUrn, newUrn: newMemoryUrn,
      });
      await tx.memory.update({ where: { id: source.id }, data: { urn: newMemoryUrn } });
      signalLocked();
      await held;
    });
    await locked;

    const merging = merge();
    try {
      await vi.waitFor(async () => {
        const waiting = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM memories WHERE id%' AND query LIKE '%FOR NO KEY UPDATE%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      releaseRename();
    }
    await rename;
    await merging;

    expect((await aliasesFor(node.id)).map((a) => a.urn))
      .toEqual([`${newMemoryUrn}:${node.loc}`]);
    expect(await resolveNodeRef(db, `hrn:node:${newMemoryUrn}:${node.loc}`))
      .toEqual({ id: node.id });
    expect(await resolveNodeRef(db, `hrn:node:${oldMemoryUrn}:${node.loc}`))
      .toEqual({ id: node.id });
  });

  it('uses the relocated target gate and gives a new live occupant precedence', async () => {
    const node = await makeNode(source.id, 'reused');
    const old = nodeUrn(source, node.loc);
    await merge();

    expect((await resolvers.Query.node(null, { ref: old }, ctx()))?.id).toBe(node.id);
    expect(await resolvers.Query.node(null, { ref: old }, ctx(sourceReaderId))).toBeNull();
    await expect(resolvers.Mutation.updateNode(null, {
      input: { id: old, content: 'denied' },
    }, ctx(sourceReaderId))).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    const occupant = await makeNode(source.id, 'reused');
    expect(await resolveNodeRef(db, old)).toEqual({ id: occupant.id });
    expect((await resolvers.Query.node(null, { ref: old }, ctx()))?.id).toBe(occupant.id);
  });

  it('resolves the predecessor after the source memory is soft-deleted', async () => {
    const node = await makeNode(source.id, 'retained');
    const old = nodeUrn(source, node.loc);
    await merge(true);

    expect((await db.memory.findUniqueOrThrow({ where: { id: source.id } })).deletedAt)
      .not.toBeNull();
    expect(await resolveNodeRef(db, old)).toEqual({ id: node.id });
    expect((await resolvers.Query.node(null, { ref: old }, ctx()))?.id).toBe(node.id);
    expect(await resolvers.Query.node(null, { ref: old }, ctx(sourceReaderId))).toBeNull();
  });

  it('rolls an alias and relocation back together when their transaction aborts', async () => {
    const node = await makeNode(source.id, 'rollback');
    const old = nodeUrn(source, node.loc);
    await expect(db.$transaction(async (tx) => {
      await recordUrnRename(tx, {
        entityType: 'NODE', entityId: node.id,
        oldUrn: `${source.urn}:${node.loc}`, newUrn: `${target.urn}:${node.loc}`,
      });
      await tx.node.update({ where: { id: node.id }, data: { memoryId: target.id } });
      throw new Error('synthetic failure after both writes');
    })).rejects.toThrow('synthetic failure after both writes');
    expect(await aliasesFor(node.id)).toEqual([]);
    expect(await resolveNodeRef(db, old)).toEqual({ id: node.id });
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).memoryId)
      .toBe(source.id);
  });
});
