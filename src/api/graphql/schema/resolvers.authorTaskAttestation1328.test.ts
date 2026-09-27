/** #1328 — a configured author task is checked at the write seam. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { resolvers } from './resolvers.js';
import { lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import type { Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let userId: string;
let memoryId: string;
let taskId: string;
const ctx = (): Context => ({ db, roles: [], userId }) as Context;
const create = (loc: string, extra: Record<string, unknown> = {}) =>
  writeNodeCore({ memoryId, loc, name: loc, content: 'body', role: 'guide', ...extra } as never, ctx(), 'create');
const update = (loc: string, extra: Record<string, unknown> = {}) =>
  writeNodeCore({ memoryId, loc, ...extra } as never, ctx(), 'update');
const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(GraphQLError);
  return (error as GraphQLError).extensions.code;
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-org', urn: 'attest-org' } });
  const user = await db.user.create({ data: { githubId: 13280, githubUsername: 'attest-admin', handle: 'attest-admin' } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'attest-org:mem', name: 'mem', class: 'knowledge' },
  })).id;
  const task = await db.node.create({ data: { id: generateId(), memoryId, loc: 'author-task', name: 'Author task', isRunnable: true, content: 'instructions' } });
  taskId = task.id;
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
});

describe('#1328 author-task attestation at writeNodeCore', () => {
  it('refuses missing, wrong and stale assertions without a node or revision', async () => {
    expect(await codeOf(create('a'))).toBe('AUTHOR_TASK_MISSING');
    expect(await codeOf(create('a', { authoredWith: { task: generateId(), revision: 1 } }))).toBe('AUTHOR_TASK_WRONG_TASK');
    expect(await codeOf(create('a', { authoredWith: { task: taskId, revision: 2 } }))).toBe('AUTHOR_TASK_STALE_REVISION');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
    expect(await db.nodeRevision.count()).toBe(0);
  });

  it('stamps a matching create and new content edit, preserving the prior stamp in history', async () => {
    const first = await create('a', { authoredWith: { task: taskId, revision: 1 } });
    expect(first).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1 });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    expect(await codeOf(update('a', { content: 'new body', authoredWith: { task: taskId, revision: 1 } }))).toBe('AUTHOR_TASK_STALE_REVISION');
    expect(await db.nodeRevision.count({ where: { nodeId: first.id } })).toBe(0);
    const second = await update('a', { content: 'new body', authoredWith: { task: taskId, revision: 2 } });
    expect(second).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 2 });
    const prior = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: first.id } });
    expect(prior).toMatchObject({ authoredByTask: taskId, authoredByRevision: 1 });
  });

  it('does not re-attest a no-op, but requires attestation to clear a governed role', async () => {
    const first = await create('a', { authoredWith: { task: taskId, revision: 1 } });
    await expect(update('a', { content: 'body' })).resolves.toMatchObject({ authoredByTask: taskId });
    await expect(writeNodeCore({ memoryId, loc: 'a', name: 'a', content: 'body', role: 'guide' }, ctx(), 'upsert'))
      .resolves.toMatchObject({ authoredByTask: taskId, authoredByRevision: 1 });
    expect(await codeOf(update('a', { role: null }))).toBe('AUTHOR_TASK_MISSING');
    const cleared = await update('a', { role: null, authoredWith: { task: taskId, revision: 1 } });
    expect(cleared).toMatchObject({ role: null, authorshipKind: 'TASK', authoredByTask: taskId });
    // Legacy upsert snapshots even an unchanged row; the attestation gate
    // itself must still preserve its live stamp instead of minting a claim.
    expect(await db.nodeRevision.count({ where: { nodeId: first.id } })).toBe(2);
  });

  it('data and properties merge mutations require and carry the current assertion', async () => {
    const first = await create('merges', { authoredWith: { task: taskId, revision: 1 } });
    const claim = { task: taskId, revision: 1 };
    const dataArgs = { nodeRef: first.id, data: { key: 'value' } };
    expect(await codeOf(resolvers.Mutation.updateNodeData({}, dataArgs, ctx()))).toBe('AUTHOR_TASK_MISSING');
    expect(await db.nodeRevision.count({ where: { nodeId: first.id } })).toBe(0);
    await resolvers.Mutation.updateNodeData({}, { ...dataArgs, authoredWith: claim }, ctx());
    expect(await db.node.findUniqueOrThrow({ where: { id: first.id } }))
      .toMatchObject({ data: { key: 'value' }, authoredByTask: taskId, authoredByRevision: 1 });

    const propertiesArgs = { nodeRef: first.id, properties: { title: 'New title' } };
    expect(await codeOf(resolvers.Mutation.updateNodeProperties({}, propertiesArgs, ctx()))).toBe('AUTHOR_TASK_MISSING');
    await resolvers.Mutation.updateNodeProperties({}, { ...propertiesArgs, authoredWith: claim }, ctx());
    expect(await db.node.findUniqueOrThrow({ where: { id: first.id } }))
      .toMatchObject({ properties: { title: 'New title' }, authoredByTask: taskId, authoredByRevision: 1 });
  });

  it('requires the prior task when changing to an unrelated role; conflicting task rules refuse a one-step switch', async () => {
    await create('a', { authoredWith: { task: taskId, revision: 1 } });
    expect(await codeOf(update('a', { role: 'notes' }))).toBe('AUTHOR_TASK_MISSING');
    const other = await db.node.create({ data: { id: generateId(), memoryId, loc: 'other-task', name: 'Other', isRunnable: true } });
    const config = await db.memoryConfig.findUniqueOrThrow({ where: { memoryId } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'manual', authorTaskId: other.id, authorTaskRequired: true } });
    expect(await codeOf(update('a', { role: 'manual', authoredWith: { task: taskId, revision: 1 } })))
      .toBe('AUTHOR_TASK_CONFLICTING_TASKS');
    const changed = await update('a', { role: 'notes', authoredWith: { task: taskId, revision: 1 } });
    expect(changed).toMatchObject({ role: 'notes', authoredByTask: taskId });
  });

  it('refuses a broken required task rather than falling back to an unguided write', async () => {
    await db.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { authorTaskId: null } });
    expect(await codeOf(create('a'))).toBe('AUTHOR_TASK_BROKEN_TASK');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });

  it('refuses an assertion whose task revision advances while the write waits for the task row', async () => {
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const changing = db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    const writing = create('racing', { authoredWith: { task: taskId, revision: 1 } });
    await waitForLockWaiters(db);
    release();
    await changing;
    expect(await codeOf(writing)).toBe('AUTHOR_TASK_STALE_REVISION');
    expect(await db.node.count({ where: { memoryId, loc: 'racing' } })).toBe(0);
  });

  it('re-reads the rule after its rulebook lock and refuses a changed author task', async () => {
    const replacement = await db.node.create({ data: { id: generateId(), memoryId, loc: 'replacement-task', name: 'Replacement', isRunnable: true } });
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const changing = db.$transaction(async (tx) => {
      await lockMemoryConfigExclusive(tx, memoryId);
      await tx.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { authorTaskId: replacement.id } });
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    const writing = create('racing', { authoredWith: { task: taskId, revision: 1 } });
    await waitForLockWaiters(db);
    release();
    await changing;
    expect(await codeOf(writing)).toBe('AUTHOR_TASK_RULE_CHANGED');
    expect(await db.node.count({ where: { memoryId, loc: 'racing' } })).toBe(0);
  });
});
