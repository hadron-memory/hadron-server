/**
 * #1328 — authoring attestation at the shared node-write seams.
 *
 * The rule (D-2026-09-24-003): a write that authors a node whose rule names an
 * author task states `authoredWith { task, revision }`; the server compares it
 * with the rule's task and that task's current `revSeq`, refuses a missing,
 * wrong or stale claim, and stamps a matching one. It proves neither that the
 * task was read nor that it was followed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, parse, type InputObjectTypeDefinitionNode } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { attestedAuthoring, judgeAuthoring } from '../../../lib/authoringAttestation.js';
import { lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { hadronUpdateNode } from '../../../lib/runner/tools/nodeTools.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<Record<string, unknown>>>;

let userId: string;
let memoryId: string;
let taskId: string;
let configId: string;
const ctx = (): Context => ({ db, roles: [], userId }) as Context;
/** The server-derived portal signal. Set only by the /graphql Apollo context. */
const portal = (): Context => ({ ...ctx(), portalHumanUserId: userId }) as Context;
const claim = (revision = 1) => ({ task: taskId, revision });
const create = (loc: string, extra: Record<string, unknown> = {}, c: Context = ctx()) =>
  M.createNode({}, { input: { memoryId, loc, name: loc, content: 'body', role: 'guide', ...extra } }, c);
const update = (loc: string, extra: Record<string, unknown> = {}, c: Context = ctx()) =>
  M.updateNode({}, { input: { memoryId, loc, ...extra } }, c);
const stored = (loc: string) => db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc, memoryId } } });
const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, 'expected a refusal').toBeInstanceOf(GraphQLError);
  return error as GraphQLError;
};
const expectRefused = async (promise: Promise<unknown>, code: string, role = 'guide') => {
  const e = await codeOf(promise);
  expect(e.extensions).toMatchObject({ code, role });
  // #1329 owns the task, revision and remedy: this issue discloses code and role only.
  expect(Object.keys(e.extensions).sort()).toEqual(['code', 'role']);
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-org', urn: 'attest-org' } });
  userId = (await db.user.create({ data: { githubId: 13280, githubUsername: 'attest-admin', handle: 'attest-admin' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'attest-org:mem', name: 'mem', class: 'knowledge' },
  })).id;
  taskId = (await db.node.create({
    data: { id: generateId(), memoryId, loc: 'author-task', name: 'Author task', isRunnable: true, content: 'instructions' },
  })).id;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await db.nodeRoleRule.create({
    data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true },
  });
});

describe('#1328 create and update', () => {
  it('refuses a missing, wrong or stale claim and leaves no node or revision', async () => {
    await expectRefused(create('a'), 'AUTHORING_ATTESTATION_MISSING');
    await expectRefused(create('a', { authoredWith: { task: generateId(), revision: 1 } }), 'AUTHORING_ATTESTATION_WRONG_TASK');
    await expectRefused(create('a', { authoredWith: claim(2) }), 'AUTHORING_ATTESTATION_STALE');
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
    expect(await db.nodeRevision.count()).toBe(0);
  });

  it('stamps a matching create, and keeps the old stamp in history when an edit re-attests', async () => {
    const first = await create('a', { authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1 });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    await expectRefused(update('a', { content: 'new', authoredWith: claim(1) }), 'AUTHORING_ATTESTATION_STALE');
    expect(await db.nodeRevision.count({ where: { nodeId: first.id as string } })).toBe(0);
    await update('a', { content: 'new', authoredWith: claim(2) });
    expect(await stored('a')).toMatchObject({ content: 'new', authoredByTask: taskId, authoredByRevision: 2 });
    expect(await db.nodeRevision.findFirstOrThrow({ where: { nodeId: first.id as string } }))
      .toMatchObject({ authoredByTask: taskId, authoredByRevision: 1 });
  });

  it('accepts the task by its canonical URN as well as its id', async () => {
    await create('a', { authoredWith: { task: 'hrn:node:attest-org:mem:author-task', revision: 1 } });
    expect(await stored('a')).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId });
  });

  it('an identical save needs no claim and keeps the stamp, even with a stale claim', async () => {
    await create('a', { authoredWith: claim() });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 5 } });
    await update('a', { content: 'body' });
    await update('a', { content: 'body', authoredWith: claim(1) });
    expect(await stored('a')).toMatchObject({ authoredByTask: taskId, authoredByRevision: 1 });
  });

  it('a role change is judged on both sides, so clearing a role cannot shed the requirement', async () => {
    await create('a', { authoredWith: claim() });
    await expectRefused(update('a', { role: null }), 'AUTHORING_ATTESTATION_MISSING');
    await expectRefused(update('a', { role: 'free' }), 'AUTHORING_ATTESTATION_MISSING');
    await update('a', { role: null, authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ role: null, authoredByTask: taskId });
  });

  it('a role change across two required tasks cannot be satisfied by one claim', async () => {
    await create('a', { authoredWith: claim() });
    const other = await db.node.create({ data: { id: generateId(), memoryId, loc: 'other', name: 'Other', isRunnable: true } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'manual', authorTaskId: other.id, authorTaskRequired: true } });
    await expectRefused(update('a', { role: 'manual', authoredWith: claim() }), 'AUTHORING_ATTESTATION_WRONG_TASK', 'manual');
    await expectRefused(update('a', { role: 'manual', authoredWith: { task: other.id, revision: 1 } }), 'AUTHORING_ATTESTATION_WRONG_TASK', 'guide');
  });

  it('a resurrected tombstone is a new authored state, with the tombstone role judged', async () => {
    const first = await create('a', { authoredWith: claim() });
    await db.node.update({ where: { id: first.id as string }, data: { deletedAt: new Date() } });
    await expectRefused(M.createNode({}, { input: { memoryId, loc: 'a', name: 'a', content: 'back' } }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    await M.createNode({}, { input: { memoryId, loc: 'a', name: 'a', content: 'back', authoredWith: claim() } }, ctx());
    expect(await stored('a')).toMatchObject({ deletedAt: null, authoredByTask: taskId });
  });

  it('a sub-role inherits its nearest rule, and a disabled rule requires nothing', async () => {
    await expectRefused(create('a', { role: 'guide.deep' }), 'AUTHORING_ATTESTATION_MISSING', 'guide.deep');
    await db.nodeRoleRule.updateMany({ where: { configId }, data: { enabled: false } });
    await create('b');
    expect(await stored('b')).toMatchObject({ authorshipKind: null });
  });

  it('a rule on `task` governs a runnable node whatever its role, as the writer level does', async () => {
    await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'task', authorTaskId: taskId, authorTaskRequired: true } });
    await expectRefused(
      M.createTaskNode({}, { input: { memoryId, loc: 'run', name: 'run', content: 'do', isRunnable: true } }, ctx()),
      'AUTHORING_ATTESTATION_MISSING', 'task',
    );
    await M.createTaskNode({}, { input: { memoryId, loc: 'run', name: 'run', content: 'do', isRunnable: true, authoredWith: claim() } }, ctx());
    expect(await stored('run')).toMatchObject({ authoredByTask: taskId });
  });

  it('a claim on an ungoverned node is ignored: no rule, no stamp', async () => {
    await M.createNode({}, { input: { memoryId, loc: 'free', name: 'free', content: 'x', authoredWith: claim(9) } }, ctx());
    expect(await stored('free')).toMatchObject({ authorshipKind: null, authoredByTask: null });
  });

  it('an edge-only update is not authored: it needs no claim and keeps the stamp', async () => {
    await create('a', { authoredWith: claim() });
    await update('a', { edges: [] });
    await update('a', { ownerRepo: 'org/repo' });
    expect(await stored('a')).toMatchObject({ authoredByTask: taskId, authoredByRevision: 1 });
  });

  it('a clean existing node stays valid: unrelated structure is not an authored edit', async () => {
    const legacy = await db.node.create({ data: { id: generateId(), memoryId, loc: 'legacy', name: 'legacy', role: 'guide', content: 'old' } });
    await update('legacy', { content: 'old' });
    expect(await stored('legacy')).toMatchObject({ id: legacy.id, authorshipKind: null });
  });
});

describe('#1328 a broken required task fails closed (H5)', () => {
  it('a rule whose task was deleted refuses even a write with a claim', async () => {
    await db.nodeRoleRule.updateMany({ where: { configId }, data: { authorTaskId: null } });
    await expectRefused(create('a'), 'AUTHOR_TASK_BROKEN');
    await expectRefused(create('a', { authoredWith: claim() }), 'AUTHOR_TASK_BROKEN');
  });

  it('a soft-deleted, unrunnable or memory-deleted task is broken, and takes precedence over a missing claim', async () => {
    await db.node.update({ where: { id: taskId }, data: { deletedAt: new Date() } });
    await expectRefused(create('a'), 'AUTHOR_TASK_BROKEN');
    await db.node.update({ where: { id: taskId }, data: { deletedAt: null, isRunnable: false } });
    await expectRefused(create('a', { authoredWith: claim() }), 'AUTHOR_TASK_BROKEN');
    await db.node.update({ where: { id: taskId }, data: { isRunnable: true } });
    const org = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
    const elsewhere = await db.memory.create({ data: { id: generateId(), organizationId: org.organizationId, urn: 'attest-org:gone', name: 'gone', class: 'knowledge', deletedAt: new Date() } });
    await db.node.update({ where: { id: taskId }, data: { memoryId: elsewhere.id } });
    await expectRefused(create('a', { authoredWith: claim() }), 'AUTHOR_TASK_BROKEN');
  });
});

describe('#1328 trusted portal human', () => {
  it('the portal path writes without a claim and records no task', async () => {
    await create('a', {}, portal());
    expect(await stored('a')).toMatchObject({ role: 'guide', authoredByTask: null, authorshipKind: null });
  });

  it('no write input carries a human flag', () => {
    const doc = parse(typeDefs);
    for (const name of ['CreateNodeInput', 'UpdateNodeInput', 'ImportNodeInput', 'MergeNodesInput', 'SearchReplaceInNodesInput', 'AuthoredWithInput']) {
      const input = doc.definitions.find((d) => d.kind === 'InputObjectTypeDefinition' && d.name.value === name);
      expect(input, name).toBeTruthy();
      const fields = (input as InputObjectTypeDefinitionNode).fields!.map((f) => f.name.value.toLowerCase());
      expect(fields.filter((f) => f.includes('human') || f.includes('portal') || f.includes('surface'))).toEqual([]);
    }
  });

  it('the signal names a different user than the request: not trusted', async () => {
    await expectRefused(create('a', {}, { ...ctx(), portalHumanUserId: generateId() } as Context), 'AUTHORING_ATTESTATION_MISSING');
  });

  it('does not reach import, which always attests', async () => {
    await create('imp', { authoredWith: claim() });
    await expectRefused(
      M.importNode({}, { input: { memoryId, loc: 'imp', content: 'x', contentType: 'text/markdown' } }, portal()),
      'AUTHORING_ATTESTATION_MISSING',
    );
  });

  it('a sign-in JWT with no worker session is the only credential that derives it', async () => {
    const { portalHumanUserId } = await import('../../../middleware/auth.js') as unknown as {
      portalHumanUserId: (auth: Record<string, unknown>) => string | undefined;
    };
    const jwt = { userId, signInCredential: true };
    expect(portalHumanUserId(jwt)).toBe(userId);
    expect(portalHumanUserId({ userId })).toBeUndefined();
    expect(portalHumanUserId({ ...jwt, apiKeyId: 'k' })).toBeUndefined();
    expect(portalHumanUserId({ ...jwt, appId: 'a' })).toBeUndefined();
    expect(portalHumanUserId({ ...jwt, sessionId: 's' })).toBeUndefined();
    expect(portalHumanUserId({ ...jwt, sessionBindingRefused: true })).toBeUndefined();
    expect(portalHumanUserId({ ...jwt, impersonation: { sessionId: 's' } })).toBeUndefined();
  });
});

describe('#1328 merges and bulk edits', () => {
  it('updateNodeData and updateNodeProperties attest', async () => {
    const first = await create('a', { authoredWith: claim() });
    await expectRefused(M.updateNodeData({}, { nodeRef: first.id, data: { k: 'v' } }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    await M.updateNodeData({}, { nodeRef: first.id, data: { k: 'v' }, authoredWith: claim() }, ctx());
    await expectRefused(M.updateNodeProperties({}, { nodeRef: first.id, properties: { t: 1 } }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    await M.updateNodeProperties({}, { nodeRef: first.id, properties: { t: 1 }, authoredWith: claim() }, ctx());
    expect(await stored('a')).toMatchObject({ data: { k: 'v' }, properties: { t: 1 }, authoredByTask: taskId });
  });

  it('mergeNodes judges the surviving target, refuses before any revision, and stamps it', async () => {
    const target = await create('t', { authoredWith: claim() });
    const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 's', name: 's', content: 'more' } });
    const input = { source: source.id, target: target.id as string };
    await expectRefused(M.mergeNodes({}, { input }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    expect(await stored('t')).toMatchObject({ content: 'body', authoredByTask: taskId });
    expect(await db.nodeRevision.count({ where: { nodeId: target.id as string } })).toBe(0);
    await M.mergeNodes({}, { input: { ...input, authoredWith: claim() } }, ctx());
    expect(await stored('t')).toMatchObject({ authoredByTask: taskId, authoredByRevision: 1 });
    expect((await stored('t')).content).toContain('more');
  });

  it('searchReplaceInNodes refuses the whole batch on one governed node, and one claim stamps the changed nodes', async () => {
    await create('a', { content: 'alpha', authoredWith: claim() });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'plain', name: 'plain', content: 'alpha' } });
    const input = { oldText: 'alpha', newText: 'beta', memoryIds: [memoryId], fields: ['content'] };
    await expectRefused(M.searchReplaceInNodes({}, { input }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    expect((await stored('plain')).content).toBe('alpha');
    expect((await stored('a')).content).toBe('alpha');
    await M.searchReplaceInNodes({}, { input: { ...input, authoredWith: claim() } }, ctx());
    expect(await stored('a')).toMatchObject({ content: 'beta', authoredByTask: taskId });
    expect(await stored('plain')).toMatchObject({ content: 'beta', authoredByTask: null });
  });

  it('searchReplaceInNodes judges each row on what it changes: a no-op row needs no claim and keeps its stamp', async () => {
    await create('a', { content: 'alpha', authoredWith: claim() });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'plain', name: 'plain', content: 'ALPHA' } });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 5 } });
    const input = { oldText: 'alpha', newText: 'alpha', caseInsensitive: true, memoryIds: [memoryId], fields: ['content'] };
    await M.searchReplaceInNodes({}, { input }, ctx());
    expect(await stored('a')).toMatchObject({ content: 'alpha', authoredByTask: taskId, authoredByRevision: 1 });
    expect((await stored('plain')).content).toBe('alpha');
  });

  it('searchReplaceInNodes still demands a claim for a row that changes beside a no-op row', async () => {
    await create('a', { content: 'alpha', authoredWith: claim() });
    await create('b', { content: 'ALPHA', authoredWith: claim() });
    const input = { oldText: 'alpha', newText: 'alpha', caseInsensitive: true, memoryIds: [memoryId], fields: ['content'] };
    await expectRefused(M.searchReplaceInNodes({}, { input }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    expect((await stored('b')).content).toBe('ALPHA');
  });

  it('a dry run needs no claim', async () => {
    await create('a', { content: 'alpha', authoredWith: claim() });
    const input = { oldText: 'alpha', newText: 'beta', memoryIds: [memoryId], fields: ['content'], dryRun: true };
    await expect(M.searchReplaceInNodes({}, { input }, ctx())).resolves.toBeTruthy();
  });

  it('importNode carries its claim', async () => {
    await create('imp', { authoredWith: claim() });
    const base = { memoryId, loc: 'imp', content: 'imported', contentType: 'text/markdown' };
    await expectRefused(M.importNode({}, { input: base }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    expect((await stored('imp')).content).toBe('body');
    await M.importNode({}, { input: { ...base, authoredWith: claim() } }, ctx());
    expect(await stored('imp')).toMatchObject({ content: 'imported', authoredByTask: taskId });
  });
});

describe('#1328 runner tools', () => {
  it('hadron_update_node attests through ctx.principal and ignores the portal signal', async () => {
    await create('a', { authoredWith: claim() });
    const org = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
    const run = { principal: portal(), db, run: { id: 'run', organizationId: org.organizationId } } as never;
    const args = { urn: 'hrn:node:attest-org:mem:a', content: 'by run' };
    await expectRefused(hadronUpdateNode.execute(run, args), 'AUTHORING_ATTESTATION_MISSING');
    await hadronUpdateNode.execute(run, { ...args, authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ content: 'by run', authoredByTask: taskId });
  });
});

describe('#1328 carrying paths', () => {
  it('cloneNode carries the stamp into a memory whose rule the clone did not attest', async () => {
    const first = await create('a', { authoredWith: claim() });
    await M.cloneNode({}, { sourceRef: first.id, targetUrn: 'hrn:node:attest-org:mem:b' }, ctx());
    expect(await stored('b')).toMatchObject({ authoredByTask: taskId, authoredByRevision: 1 });
  });

  it('restoring a revision carries that revision\'s stamp, with no claim', async () => {
    const first = await create('a', { authoredWith: claim() });
    await update('a', { content: 'second', authoredWith: claim() });
    const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: first.id as string } });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 9 } });
    await M.restoreNodeRevision({}, { revisionId: revision.id }, ctx());
    expect(await stored('a')).toMatchObject({ content: 'body', authoredByTask: taskId, authoredByRevision: 1 });
  });
});

describe('#1328 races: the rulebook lock orders the check against a rule change', () => {
  const holdExclusive = async (during: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void> = async () => {}) => {
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const gate = new Promise<void>((r) => (release = r));
    const done = db.$transaction(async (tx) => {
      await lockMemoryConfigExclusive(tx, memoryId);
      await during(tx);
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    return { release, done };
  };

  it('the check itself waits for a rule write, for a seam with no writer-level lock of its own', async () => {
    await db.nodeRoleRule.deleteMany({ where: { configId } });
    const rule = await holdExclusive((tx) => tx.nodeRoleRule.create({
      data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true },
    }).then(() => undefined));
    const judged = db.$transaction((tx) => judgeAuthoring(tx, memoryId, {
      priorRole: null, priorRunnable: null, role: 'guide', runnable: null, authoredChange: true,
    }, attestedAuthoring(null)));
    await waitForLockWaitersOfType(db, 'advisory', 1);
    rule.release();
    await rule.done;
    await expect(judged).resolves.toMatchObject({ refused: 'AUTHORING_ATTESTATION_MISSING', role: 'guide' });
  });

  it('a rule created while the write waits governs it (the absent-rule phantom)', async () => {
    await db.nodeRoleRule.deleteMany({ where: { configId } });
    const rule = await holdExclusive((tx) => tx.nodeRoleRule.create({
      data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true },
    }).then(() => undefined));
    const writing = create('race');
    await waitForLockWaitersOfType(db, 'advisory', 1);
    rule.release();
    await rule.done;
    await expectRefused(writing, 'AUTHORING_ATTESTATION_MISSING');
    expect(await db.node.count({ where: { memoryId, loc: 'race' } })).toBe(0);
  });

  it('a task revision committed while the write waits makes the claim stale', async () => {
    const rule = await holdExclusive((tx) => tx.node.update({ where: { id: taskId }, data: { revSeq: 2 } }).then(() => undefined));
    const writing = create('race', { authoredWith: claim(1) });
    await waitForLockWaitersOfType(db, 'advisory', 1);
    rule.release();
    await rule.done;
    await expectRefused(writing, 'AUTHORING_ATTESTATION_STALE');
    expect(await db.node.count({ where: { memoryId, loc: 'race' } })).toBe(0);
  });

  it('the other commit order: the write commits first, and a later task revision leaves it valid', async () => {
    await create('race', { authoredWith: claim(1) });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    expect(await stored('race')).toMatchObject({ authoredByRevision: 1, authoredByTask: taskId });
  });

  it('a rule repointed while the write waits refuses the old task and leaves no revision', async () => {
    const other = await db.node.create({ data: { id: generateId(), memoryId, loc: 'other', name: 'Other', isRunnable: true } });
    const first = await create('race', { authoredWith: claim() });
    const rule = await holdExclusive((tx) => tx.nodeRoleRule.updateMany({ where: { configId }, data: { authorTaskId: other.id } }).then(() => undefined));
    const writing = update('race', { content: 'edit', authoredWith: claim() });
    await waitForLockWaitersOfType(db, 'advisory', 1);
    rule.release();
    await rule.done;
    await expectRefused(writing, 'AUTHORING_ATTESTATION_WRONG_TASK');
    expect(await stored('race')).toMatchObject({ content: 'body', authoredByTask: taskId });
    expect(await db.nodeRevision.count({ where: { nodeId: first.id as string } })).toBe(0);
  });
});
