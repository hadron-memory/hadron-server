/**
 * #1336 — the HUMAN authorship stamp, minted only on #1328's trusted portal path
 * (D-2026-09-24-003/-004, D-2026-09-26-D; pending codification in `cor:acl`).
 *
 * Mint matrix: an authoring write the portal human makes (create, update, data and
 * properties merges, search-and-replace) records HUMAN + the session user + now,
 * task and revision NULL. Restore, clone and a node-merge fold never mint it.
 * Every other surface keeps #1328's attestation, and a forged signal stays inert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeResolvers } from './resolvers.types.js';
import { hadronUpdateNode } from '../../../lib/runner/tools/nodeTools.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<Record<string, unknown>>>;

let userId: string;
let otherUserId: string;
let memoryId: string;
let taskId: string;
let configId: string;
const ctx = (): Context => ({ db, roles: [], userId }) as Context;
const portal = (): Context => ({ ...ctx(), portalHumanUserId: userId }) as Context;
const claim = () => ({ task: taskId, revision: 1 });
const create = (loc: string, extra: Record<string, unknown> = {}, c: Context = ctx()) =>
  M.createNode({}, { input: { memoryId, loc, name: loc, content: 'body', role: 'guide', ...extra } }, c);
const update = (loc: string, extra: Record<string, unknown> = {}, c: Context = ctx()) =>
  M.updateNode({}, { input: { memoryId, loc, ...extra } }, c);
const stored = (loc: string) => db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc, memoryId } } });
const NO_STAMP = { authorshipKind: null, authoredByTask: null, authoredByRevision: null, authoredByHuman: null, authoredAt: null };
const refusedWith = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, 'expected a refusal').toBeInstanceOf(GraphQLError);
  return (error as GraphQLError).extensions?.code;
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'human-org', urn: 'human-org' } });
  userId = (await db.user.create({ data: { githubId: 13360, githubUsername: 'human-admin', handle: 'human-admin' } })).id;
  otherUserId = (await db.user.create({ data: { githubId: 13361, githubUsername: 'human-other', handle: 'human-other' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'human-org:mem', name: 'mem', class: 'knowledge' },
  })).id;
  taskId = (await db.node.create({
    data: { id: generateId(), memoryId, loc: 'author-task', name: 'Author task', isRunnable: true, content: 'instructions' },
  })).id;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
});

describe('#1336 the portal human mints HUMAN', () => {
  it('create and update under a task-required rule store the session user, now, and no task', async () => {
    const before = Date.now();
    await create('a', {}, portal());
    const made = await stored('a');
    expect(made).toMatchObject({ authorshipKind: 'HUMAN', authoredByHuman: userId, authoredByTask: null, authoredByRevision: null });
    expect(made.authoredAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    await update('a', { content: 'second' }, portal());
    expect(await stored('a')).toMatchObject({ authorshipKind: 'HUMAN', authoredByHuman: userId, authoredByTask: null, authoredByRevision: null });
  });

  it('an ungoverned node is stamped too: the node records who wrote it', async () => {
    await create('free', { role: undefined }, portal());
    expect(await stored('free')).toMatchObject({ authorshipKind: 'HUMAN', authoredByHuman: userId });
  });

  it('a person edit replaces a TASK stamp, and the old stamp stays in history', async () => {
    const first = await create('a', { authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId });
    await update('a', { content: 'by hand' }, portal());
    expect(await stored('a')).toMatchObject({ authorshipKind: 'HUMAN', authoredByHuman: userId, authoredByTask: null });
    expect(await db.nodeRevision.findFirstOrThrow({ where: { nodeId: first.id as string } })).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId });
  });

  it('an identical save changes nothing authored: no mint, the stamp is kept', async () => {
    await create('a', { authoredWith: claim() });
    await update('a', { content: 'body' }, portal());
    expect(await stored('a')).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId });
  });

  it('data and properties merges and search-and-replace mint on the portal path', async () => {
    const node = await create('a', { authoredWith: claim() });
    await M.updateNodeData({}, { nodeRef: node.id, data: { k: 'v' } }, portal());
    expect(await stored('a')).toMatchObject({ authorshipKind: 'HUMAN', authoredByHuman: userId });
    await update('a', { content: 'body', authoredWith: claim() }, ctx());
    await M.updateNodeProperties({}, { nodeRef: node.id, properties: { t: 1 } }, portal());
    expect(await stored('a')).toMatchObject({ authorshipKind: 'HUMAN', authoredByHuman: userId, authoredByTask: null });
    await update('a', { content: 'body', authoredWith: claim() }, ctx());
    await M.searchReplaceInNodes({}, { input: { oldText: 'body', newText: 'edited', fields: ['content'], nodeIds: [node.id as string] } }, portal());
    expect(await stored('a')).toMatchObject({ content: 'edited', authorshipKind: 'HUMAN', authoredByHuman: userId, authoredByTask: null });
  });
});

describe('#1336 no other path mints HUMAN', () => {
  it('the same user without the portal signal still attests, and a different user in the signal is not trusted', async () => {
    expect(await refusedWith(create('a', {}, ctx()))).toBe('AUTHORING_ATTESTATION_MISSING');
    expect(await refusedWith(create('a', {}, { ...ctx(), portalHumanUserId: otherUserId } as Context))).toBe('AUTHORING_ATTESTATION_MISSING');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
  });

  it('an attested write by the same user stamps TASK, never HUMAN', async () => {
    await create('a', { authoredWith: claim() }, ctx());
    expect(await stored('a')).toMatchObject({ authorshipKind: 'TASK', authoredByHuman: null });
  });

  it('a runner tool ignores the portal signal and mints no HUMAN', async () => {
    await create('a', { authoredWith: claim() });
    const org = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
    const run = { principal: portal(), db, run: { id: 'run', organizationId: org.organizationId } } as never;
    const args = { urn: 'hrn:node:human-org:mem:a', content: 'by run' };
    expect(await refusedWith(hadronUpdateNode.execute(run, args))).toBe('AUTHORING_ATTESTATION_MISSING');
    expect(await stored('a')).toMatchObject({ authorshipKind: 'TASK', authoredByHuman: null });
  });

  it('import attests and never mints, even with the portal signal on the request', async () => {
    await create('imp', { authoredWith: claim() });
    const base = { memoryId, loc: 'imp', content: 'imported', contentType: 'text/markdown' };
    expect(await refusedWith(M.importNode({}, { input: base }, portal()))).toBe('AUTHORING_ATTESTATION_MISSING');
    await M.importNode({}, { input: { ...base, authoredWith: claim() } }, portal());
    expect(await stored('imp')).toMatchObject({ authorshipKind: 'TASK', authoredByHuman: null });
  });
});

describe('#1336 carry and clear sites never mint', () => {
  it('restoring a revision by the portal human carries that revision\'s stamp', async () => {
    const first = await create('a', { authoredWith: claim() });
    await update('a', { content: 'second', authoredWith: claim() });
    const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: first.id as string } });
    await M.restoreNodeRevision({}, { revisionId: revision.id }, portal());
    expect(await stored('a')).toMatchObject({ content: 'body', authorshipKind: 'TASK', authoredByTask: taskId, authoredByHuman: null });
  });

  it('cloning by the portal human carries the stamp', async () => {
    const first = await create('a', { authoredWith: claim() });
    await M.cloneNode({}, { sourceRef: first.id, targetUrn: 'hrn:node:human-org:mem:b' }, portal());
    expect(await stored('b')).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByHuman: null });
  });

  it('a mergeNodes fold by the portal human clears the surviving stamp, never HUMAN', async () => {
    const target = await create('t', { authoredWith: claim() });
    const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 's', name: 's', content: 'more' } });
    await M.mergeNodes({}, { input: { source: source.id, target: target.id as string } }, portal());
    expect((await stored('t')).content).toContain('more');
    expect(await stored('t')).toMatchObject(NO_STAMP);
  });
});

describe('#1336 paired controls and read side', () => {
  it('a portal user with no write access is refused as before and mints nothing', async () => {
    await create('a', { authoredWith: claim() });
    const outsider = { db, roles: [], userId: otherUserId, portalHumanUserId: otherUserId } as Context;
    await update('a', { content: 'nope' }, outsider).then(() => { throw new Error('expected refusal'); }, () => undefined);
    expect(await stored('a')).toMatchObject({ content: 'body', authorshipKind: 'TASK', authoredByHuman: null });
  });

  it('the node reads back the person, and the earlier validation report is historical after the edit', async () => {
    const node = await create('a', { authoredWith: claim() });
    await db.nodeContentValidationReport.create({
      data: { nodeId: node.id as string, memoryId, nodeRevSeq: 1, validationTaskId: taskId, validationTaskRevSeq: 1, outcome: 'PASS', runId: generateId() },
    });
    await update('a', { content: 'by hand' }, portal());
    const current = await stored('a');
    const reader = { db, roles: [], userId } as Context;
    expect((await typeResolvers.Node.authorship(current as never, null, reader))).toMatchObject({ kind: 'HUMAN', taskRef: null, taskRevision: null });
    expect((await typeResolvers.Node.contentValidation(current as never, null, reader)).state).toBe('STALE');
  });
});
