import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { buildSchema, type GraphQLInputObjectType } from 'graphql';
import { typeResolvers } from './resolvers.types.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { ensureCurrentNodeRevisionInTransaction, revisionStateHashRefreshMarker } from '../../../lib/nodeRevisionSnapshot.js';

const at = new Date('2026-09-26T20:00:00Z');
let nodeMemoryId: string;
let taskMemoryId: string;
let readerId: string;
let nodeId: string;
let taskId: string;

function reader(): Context {
  return { db, userId: readerId, roles: ['READER'] } as Context;
}

beforeEach(async () => {
  await cleanDb(db);
  const ownOrg = await db.organization.create({
    data: { id: generateId(), name: 'provenance-own', urn: 'provenance-own' },
  });
  const otherOrg = await db.organization.create({
    data: { id: generateId(), name: 'provenance-other', urn: 'provenance-other' },
  });
  const own = await db.memory.create({
    data: { id: generateId(), organizationId: ownOrg.id, urn: 'provenance-own:mem', name: 'own', class: 'knowledge' },
  });
  const other = await db.memory.create({
    data: { id: generateId(), organizationId: otherOrg.id, urn: 'provenance-other:mem', name: 'other', class: 'knowledge' },
  });
  nodeMemoryId = own.id;
  taskMemoryId = other.id;
  readerId = (await db.user.create({
    data: { githubId: 721401, githubUsername: 'prov-reader', roles: ['READER'] },
  })).id;
  await db.orgMember.create({ data: { organizationId: ownOrg.id, userId: readerId, role: 'READER' } });
  taskId = (await db.node.create({
    data: { id: generateId(), memoryId: taskMemoryId, loc: 'author-task', name: 'Author task', nodeType: 'task', revSeq: 4 },
  })).id;
  nodeId = (await db.node.create({
    data: {
      id: generateId(), memoryId: nodeMemoryId, loc: 'authored', name: 'Authored', content: 'body',
      authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 4, authoredAt: at,
    },
  })).id;
});

describe('#1326 content provenance reads', () => {
  it('keeps the old task stamp in history but clears it on an ordinary content edit', async () => {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: nodeMemoryId } });
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: memory.organizationId!, userId: readerId } },
      data: { role: 'ADMIN' },
    });
    await writeNodeCore(
      { memoryId: nodeMemoryId, loc: 'authored', content: 'new body' },
      { db, userId: readerId, roles: ['ADMIN'] } as Context,
      'update',
    );
    const live = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(live).toMatchObject({
      content: 'new body', authorshipKind: null, authoredByTask: null,
      authoredByRevision: null, authoredByHuman: null, authoredAt: null,
    });
    const old = await db.nodeRevision.findFirstOrThrow({ where: { nodeId }, orderBy: { revNo: 'desc' } });
    expect(old).toMatchObject({
      content: 'body', authorshipKind: 'TASK', authoredByTask: taskId,
      authoredByRevision: 4, authoredAt: at,
    });
  });

  it('keeps a task stamp and creates no revision for an identical save', async () => {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: nodeMemoryId } });
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: memory.organizationId!, userId: readerId } },
      data: { role: 'ADMIN' },
    });
    await writeNodeCore(
      { memoryId: nodeMemoryId, loc: 'authored', content: 'body' },
      { db, userId: readerId, roles: ['ADMIN'] } as Context,
      'update',
    );
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({
      authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 4, authoredAt: at,
    });
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
  });

  it('clears a stale stamp from both live and reconciled state after an unrevisioned raw content edit', async () => {
    // A legacy row with no fingerprint first establishes its baseline; only
    // the later raw data edit is detectable drift.
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: nodeMemoryId }));
    await db.node.update({ where: { id: nodeId }, data: { data: { raw: 'new content' } } });
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: nodeMemoryId }));
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({
      authorshipKind: null, authoredByTask: null, authoredByRevision: null, authoredAt: null,
    });
    const reconciled = await db.nodeRevision.findFirstOrThrow({ where: { nodeId }, orderBy: { revNo: 'desc' } });
    expect(reconciled).toMatchObject({
      data: { raw: 'new content' }, authorshipKind: null, authoredByTask: null, authoredByRevision: null,
    });
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: nodeMemoryId }));
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(1);
  });

  it('reconciles a stamped raw edit when authorship is the only selected Node field', async () => {
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: nodeMemoryId }));
    await db.node.update({ where: { id: nodeId }, data: { data: { raw: 'edited' } } });
    const parent = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(parent.authorshipKind).toBe('TASK'); // the raw writer left a stale stamp

    expect(await typeResolvers.Node.authorship(parent, null, reader())).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).authorshipKind).toBeNull();
    expect((await db.nodeRevision.findFirstOrThrow({ where: { nodeId } })).authorshipKind).toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(1);
    expect(await typeResolvers.Node.revision(parent, null, reader())).toBe(parent.revSeq + 1);

    // A second reader may reconcile first after this parent was selected.
    // Its unchanged authored content still must not inherit the old stamp.
    expect(await typeResolvers.Node.authorship(parent, null, reader())).toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(1);
  });

  it('does not return an unverifiable parent stamp after a concurrent authored edit', async () => {
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: nodeMemoryId }));
    await db.node.update({ where: { id: nodeId }, data: { data: { raw: 'edited' } } });
    const staleParent = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const memory = await db.memory.findUniqueOrThrow({ where: { id: nodeMemoryId } });
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: memory.organizationId!, userId: readerId } },
      data: { role: 'ADMIN' },
    });
    await writeNodeCore(
      { memoryId: nodeMemoryId, loc: 'authored', content: 'newer body' },
      { db, userId: readerId, roles: ['ADMIN'] } as Context,
      'update',
    );

    expect(await typeResolvers.Node.authorship(staleParent, null, reader())).toBeNull();
  });

  it('reconciles a raw edited source before its stamp can be carried into a clone', async () => {
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: nodeMemoryId }));
    await db.node.update({ where: { id: nodeId }, data: { data: { raw: 'edited' } } });
    const memory = await db.memory.findUniqueOrThrow({ where: { id: nodeMemoryId } });
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: memory.organizationId!, userId: readerId } },
      data: { role: 'ADMIN' },
    });
    const cloned = await resolvers.Mutation.cloneNode(
      {}, { sourceRef: nodeId, targetUrn: 'hrn:node:provenance-own:mem:clone' },
      { db, userId: readerId, roles: ['ADMIN'] } as Context,
    );
    expect(cloned).toMatchObject({ data: { raw: 'edited' }, authorshipKind: null, authoredByTask: null });
    const liveClone = await db.node.findUniqueOrThrow({ where: { id: cloned.id } });
    expect(liveClone).toMatchObject({ authorshipKind: null, authoredByTask: null });
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, cloned.id, { expectedMemoryId: nodeMemoryId }));
    expect(await db.nodeRevision.count({ where: { nodeId: cloned.id } })).toBe(0);
  });

  it('shares one locked reconcile among sibling GraphQL fields on the same parent', async () => {
    const parent = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const context = reader();
    const transactions = vi.spyOn(db, '$transaction');
    try {
      const [revision, validation, authorship] = await Promise.all([
        typeResolvers.Node.revision(parent, null, context),
        typeResolvers.Node.contentValidation(parent, null, context),
        typeResolvers.Node.authorship(parent, null, context),
      ]);
      expect(revision).toBe(parent.revSeq);
      expect(validation.state).toBe('UNVALIDATED');
      expect(authorship?.kind).toBe('TASK');
      expect(transactions).toHaveBeenCalledTimes(1);

      // Another projection of the same id is a different selected state and
      // must not borrow this parent's cached result.
      await typeResolvers.Node.revision({ ...parent }, null, context);
      expect(transactions).toHaveBeenCalledTimes(2);
    } finally {
      transactions.mockRestore();
    }
  });

  it('offers no public GraphQL setter for system-owned attribution or validation', () => {
    const schema = buildSchema(typeDefs);
    for (const name of ['NodeInput', 'CreateNodeInput', 'UpdateNodeInput']) {
      const fields = Object.keys((schema.getType(name) as GraphQLInputObjectType).getFields());
      for (const protectedField of [
        'authorshipKind', 'authoredByTask', 'authoredByRevision', 'authoredByHuman',
        'authoredAt', 'contentValidation', 'validationReport',
      ]) expect(fields).not.toContain(protectedField);
    }
  });

  it('preserves task authorship in an old snapshot, distinct from the editor', async () => {
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const revision = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId: nodeMemoryId, revNo: 1, loc: node.loc,
        name: node.name, content: node.content, authorshipKind: node.authorshipKind,
        authoredByTask: node.authoredByTask, authoredByRevision: node.authoredByRevision,
        authoredAt: node.authoredAt, editedBy: readerId,
      },
    });
    const visible = await typeResolvers.NodeRevision.authorship(revision, null, reader());
    expect(visible).toMatchObject({ kind: 'TASK', taskRef: null, taskRevision: null, human: null, authoredAt: at });
    const admin = { db, roles: ['ADMIN'], userId: readerId } as Context;
    expect(await typeResolvers.NodeRevision.authorship(revision, null, admin)).toMatchObject({
      kind: 'TASK', taskRef: 'hrn:node:provenance-other:mem:author-task', taskRevision: 4,
    });
    expect(revision.editedBy).toBe(readerId);
  });

  it('shows a human author through public identifiers without inventing a task', async () => {
    await db.user.update({ where: { id: readerId }, data: { handle: 'provenance-reader' } });
    await db.node.update({
      where: { id: nodeId },
      data: {
        authorshipKind: 'HUMAN', authoredByTask: null, authoredByRevision: null,
        authoredByHuman: readerId, revisionContentHash: revisionStateHashRefreshMarker(),
      },
    });
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(await typeResolvers.Node.authorship(node, null, reader())).toMatchObject({
      kind: 'HUMAN', taskRef: null, taskRevision: null,
      human: { handle: 'provenance-reader', urn: 'hrn:user:provenance-reader' },
    });
  });

  it('keeps report insertion separate from Node revisions and treats old reports as stale', async () => {
    const report = await db.nodeContentValidationReport.create({
      data: {
        nodeId, memoryId: nodeMemoryId, nodeRevSeq: 1,
        validationTaskId: taskId, validationTaskRevSeq: 4,
        outcome: 'FAIL', runId: generateId(),
      },
    });
    const before = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(before.revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
    const status = await typeResolvers.Node.contentValidation(before, null, reader());
    expect(status).toMatchObject({
      state: 'FAIL', latestReport: {
        nodeRevision: 1, validationTaskRef: null,
        validationTaskRevision: null, outcome: 'FAIL',
      },
    });
    // A later task revision does not change the report's binding or state.
    await db.node.update({ where: { id: taskId }, data: { revSeq: 5 } });
    expect((await typeResolvers.Node.contentValidation(before, null, reader())).state).toBe('FAIL');
    await db.node.update({ where: { id: nodeId }, data: { revSeq: 2, content: 'changed' } });
    const current = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect((await typeResolvers.Node.contentValidation(current, null, reader())).state).toBe('STALE');
    expect((await typeResolvers.NodeRevision.contentValidation({ nodeId, memoryId: nodeMemoryId, revNo: 1 }, null, reader())).state).toBe('FAIL');
    expect(await db.nodeContentValidationReport.findUnique({ where: { id: report.id } })).toMatchObject({ nodeRevSeq: 1 });
    // The raw content update above is reconciled by the exposed live read;
    // that authoring drift, unlike report insertion, creates one snapshot.
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(1);
  });

  it('does not reveal a report from a different memory through the current node', async () => {
    await db.nodeContentValidationReport.create({
      data: {
        nodeId, memoryId: taskMemoryId, nodeRevSeq: 1,
        validationTaskId: taskId, validationTaskRevSeq: 4, outcome: 'PASS',
      },
    });
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(await typeResolvers.Node.contentValidation(node, null, reader())).toEqual({
      state: 'UNVALIDATED', latestReport: null,
    });
  });

  it('rejects malformed task attribution at the database boundary', async () => {
    await expect(db.node.update({
      where: { id: nodeId },
      data: { authoredByTask: null },
    })).rejects.toThrow();
    await expect(db.node.update({
      where: { id: nodeId },
      data: { authorshipKind: 'HUMAN', authoredByHuman: readerId },
    })).rejects.toThrow();
  });
});
