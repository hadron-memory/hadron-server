/**
 * #3437 — the #1328 pins its reviewers left optional. Each one goes red against
 * a named mutant from the seats' verdicts (Bruno's task-revision race, Riana's
 * j11, w4, s1, r1, r3, r7, r8, and the encrypted no-op Ralion probed), so a seam
 * cannot quietly stop asking for a claim. Production is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';

const hooks = vi.hoisted(() => ({ afterCheck: null as null | (() => Promise<void>) }));

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../../../integrations/localFs/saveNodeToFs.js', () => ({ saveNodeToFs: vi.fn().mockResolvedValue({}) }));
vi.mock('../../../integrations/r2/client.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
// The real check, with one seam after it: the write is admitted and has not committed.
vi.mock('../../../lib/authoringAttestation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/authoringAttestation.js')>();
  return {
    ...actual,
    assertAuthoring: async (...args: Parameters<typeof actual.assertAuthoring>) => {
      const stamp = await actual.assertAuthoring(...args);
      const hook = hooks.afterCheck;
      hooks.afterCheck = null;
      if (hook) await hook();
      return stamp;
    },
  };
});

import { db } from '../../../integrations/db/client.js';
import { deleteObject } from '../../../integrations/r2/client.js';
import { createNode as controllerCreateNode } from '../../../controller/operations/createNode.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { parseDataKey, isCiphertext } from '../../../lib/crypto.js';
import { generateId } from '../../../lib/id.js';
import { decryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { computeRevisionStateHash, ensureCurrentNodeRevisionInTransaction } from '../../../lib/nodeRevisionSnapshot.js';
import { hadronCreateNode } from '../../../lib/runner/tools/nodeTools.js';
import { hadronStoreFile } from '../../../lib/runner/tools/index.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<Record<string, unknown>>>;
const ORG = 'seams-3437';

let userId: string;
let orgId: string;
let memoryId: string;
let taskId: string;
let configId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId }) as Context;
/** The server-derived portal signal. It is what makes a request a trusted human. */
const portal = (): Context => ({ ...ctx(), portalHumanUserId: userId }) as Context;
const claim = (revision = 1) => ({ task: taskId, revision });
const create = (loc: string, extra: Record<string, unknown> = {}, c: Context = ctx()) =>
  M.createNode({}, { input: { memoryId, loc, name: loc, content: 'body', role: 'guide', ...extra } }, c);
const update = (loc: string, extra: Record<string, unknown> = {}, c: Context = ctx()) =>
  M.updateNode({}, { input: { memoryId, loc, ...extra } }, c);
const stored = (loc: string, memory = memoryId) => db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc, memoryId: memory } } });
const tombstone = (id: unknown) => db.node.update({ where: { id: id as string }, data: { deletedAt: new Date() } });
const expectRefused = async (promise: Promise<unknown>, code: string, role = 'guide') => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, 'expected a refusal').toBeInstanceOf(GraphQLError);
  expect((error as GraphQLError).extensions).toMatchObject({ code, role });
};

beforeEach(async () => {
  hooks.afterCheck = null;
  vi.clearAllMocks();
  await cleanDb(db);
  sessionKeyCache.clear();
  orgId = (await db.organization.create({ data: { id: generateId(), name: ORG, urn: ORG } })).id;
  userId = (await db.user.create({ data: { githubId: 34370, githubUsername: 'seams-admin', handle: 'seams-admin', roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${ORG}:mem`, name: 'mem', class: 'knowledge' } })).id;
  taskId = (await db.node.create({
    data: { id: generateId(), memoryId, loc: 'author-task', name: 'Author task', isRunnable: true, content: 'instructions' },
  })).id;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
});

describe('#3437 item 1: a task edit races a write, with no rulebook lock held', () => {
  it('committed while the write waits on its own row, before the check: the claim is stale', async () => {
    const first = await create('race', { authoredWith: claim() });
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holding = new Promise<void>((r) => (held = r));
    const rowHolder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${first.id as string} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;

    const writing = update('race', { content: 'edit', authoredWith: claim(1) });
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      await editTask();
      expect((await stored('author-task')).revSeq).toBe(2);
    } finally {
      release();
    }
    await rowHolder;

    await expectRefused(writing, 'AUTHORING_ATTESTATION_STALE');
    expect(await stored('race')).toMatchObject({ content: 'body', authoredByRevision: 1 });
    expect(await db.nodeRevision.count({ where: { nodeId: first.id as string } })).toBe(0);
  });

  it.each([
    ['a create', () => create('race', { authoredWith: claim(1) })],
    ['an update', async () => {
      await create('race', { authoredWith: claim(1) });
      hooks.afterCheck = editTask;
      return update('race', { content: 'edit', authoredWith: claim(1) });
    }],
  ])('committed after %s is admitted: the task edit does not wait, and the stamp keeps the admitted revision', async (name, write) => {
    if (name === 'a create') hooks.afterCheck = editTask;
    await write();
    expect(hooks.afterCheck, 'the admitted write must reach the seam').toBeNull();
    expect((await stored('author-task')).revSeq).toBe(2);
    expect(await stored('race')).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1 });
    // The write ordered first, so the next one answers to the new revision.
    await expectRefused(update('race', { content: 'later', authoredWith: claim(1) }), 'AUTHORING_ATTESTATION_STALE');
  });

  /** Runs on its own connection inside the write's open transaction, so a lock on the task would hang here. */
  async function editTask() {
    await M.updateTaskNode({}, { input: { memoryId, loc: 'author-task', content: 'instructions v2' } }, ctx());
  }
});

describe('#3437 item 3: the memory part of the URN comparison', () => {
  it('a task at the same loc in another memory is not the rule task', async () => {
    const otherId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${ORG}:other`, name: 'other', class: 'knowledge' } })).id;
    await db.node.create({ data: { id: generateId(), memoryId: otherId, loc: 'author-task', name: 'Lookalike', isRunnable: true } });
    await expectRefused(
      create('a', { authoredWith: { task: `hrn:node:${ORG}:other:author-task`, revision: 1 } }),
      'AUTHORING_ATTESTATION_WRONG_TASK',
    );
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
    await create('a', { authoredWith: { task: `hrn:node:${ORG}:mem:author-task`, revision: 1 } });
    expect(await stored('a')).toMatchObject({ authoredByTask: taskId });
  });
});

describe('#3437 item 5: a tombstone revive that changes the role', () => {
  it('answers to the rule of the role it leaves', async () => {
    const first = await create('a', { authoredWith: claim() });
    await tombstone(first.id);
    await expectRefused(create('a', { role: 'free', content: 'back' }), 'AUTHORING_ATTESTATION_MISSING');
    expect(await stored('a')).toMatchObject({ role: 'guide', content: 'body' });
    expect((await stored('a')).deletedAt).not.toBeNull();
    await create('a', { role: 'free', content: 'back', authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ role: 'free', content: 'back', deletedAt: null, authoredByTask: taskId });
  });
});

describe('#3437 item 4: the seams a `carry` context would silently open', () => {
  const runCtx = async () => {
    const appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'seams-app', urn: `${ORG}::seams-app` } })).id;
    await db.appMember.create({ data: { appId, userId, role: 'member' } });
    const agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'seams-agent', urn: `${ORG}:seams-agent` } })).id;
    await db.appAgent.create({ data: { appId, agentId } });
    await db.agentMemoryItem.create({ data: { agentId, memoryId, role: 'read-write' } });
    const run = await db.appRun.create({
      data: { id: generateId(), organizationId: orgId, appId, userId, triggerKind: 'MANUAL', entryNodeUrn: `${ORG}::mem::flow`, status: 'RUNNING' },
    });
    return { log: vi.fn(), db, run, principal: runContext(db, run) };
  };

  describe('searchReplaceInSpecNodes (s1)', () => {
    let draftId: string;
    let specId: string;
    let specTask: string;
    const request = (rest: Record<string, unknown> = {}) => ({
      memoryRef: draftId, nodeIds: [specId], oldText: 'cat', newText: 'dog', fields: ['content'], dryRun: true, ...rest,
    });
    const replace = (input: Record<string, unknown>) => resolvers.Mutation.searchReplaceInSpecNodes(null, { input } as never, ctx());

    beforeEach(async () => {
      draftId = (await resolvers.Mutation.createMemory(null, { orgId, name: 'specs-draft', draftCorpus: true }, ctx())).id;
      specTask = (await db.node.create({ data: { id: generateId(), memoryId: draftId, loc: 'author-task', name: 'T', isRunnable: true } })).id;
      const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: draftId } });
      await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'spec', authorTaskId: specTask, authorTaskRequired: true } });
      specId = (await db.node.create({ data: { id: generateId(), memoryId: draftId, loc: 'pas:010:01', name: 's', content: 'cat', role: 'spec' } })).id;
    });

    it('a real change refuses without a claim and with a stale one, and stamps a match', async () => {
      const { plan } = await replace(request()) as { plan: string };
      await expect(replace(request({ dryRun: false, expectedPlan: plan })))
        .rejects.toMatchObject({ extensions: { code: 'AUTHORING_ATTESTATION_MISSING', role: 'spec' } });
      await expect(replace(request({ dryRun: false, expectedPlan: plan, authoredWith: { task: specTask, revision: 2 } })))
        .rejects.toMatchObject({ extensions: { code: 'AUTHORING_ATTESTATION_STALE', role: 'spec' } });
      expect(await stored('pas:010:01', draftId)).toMatchObject({ content: 'cat', authorshipKind: null });
      await replace(request({ dryRun: false, expectedPlan: plan, authoredWith: { task: specTask, revision: 1 } }));
      expect(await stored('pas:010:01', draftId)).toMatchObject({ content: 'dog', authoredByTask: specTask, authoredByRevision: 1 });
    });
  });

  describe('hadron_create_node (r1)', () => {
    it('refuses a revive of a governed tombstone with no claim, and stamps a match', async () => {
      const first = await create('a', { authoredWith: claim() });
      await tombstone(first.id);
      const run = await runCtx();
      const args = { urn: `hrn:node:${ORG}:mem:a`, name: 'A', content: 'by run' };
      await expectRefused(hadronCreateNode.execute(run as never, args), 'AUTHORING_ATTESTATION_MISSING');
      expect((await stored('a')).deletedAt).not.toBeNull();
      await hadronCreateNode.execute(run as never, { ...args, authoredWith: claim() });
      expect(await stored('a')).toMatchObject({ content: 'by run', deletedAt: null, authoredByTask: taskId });
    });
  });

  describe('hadron_store_file (r3)', () => {
    it('states no claim, so a reference over a governed tombstone refuses and leaves no asset', async () => {
      const first = await create('files:report', { authoredWith: claim() });
      await tombstone(first.id);
      const run = await runCtx();
      const args = { urn: `hrn:node:${ORG}:mem:files:report`, filename: 'report.md', content: 'text' };
      await expect(hadronStoreFile.execute(run as never, args)).rejects.toMatchObject({
        extensions: { code: 'AUTHORING_ATTESTATION_MISSING', role: 'guide', taskAccess: 'READABLE' },
      });
      expect((await stored('files:report')).deletedAt).not.toBeNull();
      expect(await db.asset.count({ where: { memoryId } })).toBe(0);
      expect(deleteObject).toHaveBeenCalledTimes(1);
    });
  });

  describe('the legacy controller createNode (r7)', () => {
    it('an edit of a governed row refuses, and an identical save does not', async () => {
      await create('a', { authoredWith: claim() });
      const save = { loc: 'a', name: 'a', memoryId, content: 'body' };
      await expectRefused(controllerCreateNode({ ...save, content: 'overwritten' }), 'AUTHORING_ATTESTATION_MISSING');
      expect(await stored('a')).toMatchObject({ content: 'body', authoredByTask: taskId });
      await controllerCreateNode(save);
      expect(await stored('a')).toMatchObject({ content: 'body', authoredByTask: taskId });
    });
  });

  describe('updateTeamRole and createTeamRole (r8)', () => {
    let appRef: string;
    let systemMemoryId: string;
    beforeEach(async () => {
      const agent = await M.createAgent({}, { orgId, name: 'seams team agent' }, ctx());
      systemMemoryId = agent.systemMemoryId as string;
      appRef = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'seams-team', urn: `${ORG}:team` } })).id;
      await db.appAgent.create({ data: { appId: appRef, agentId: agent.id as string } });
      const task = await db.node.create({ data: { id: generateId(), memoryId: systemMemoryId, loc: 'author-task', name: 'T', isRunnable: true } });
      const config = await db.memoryConfig.upsert({ where: { memoryId: systemMemoryId }, update: {}, create: { id: generateId(), memoryId: systemMemoryId } });
      await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: task.id, authorTaskRequired: true } });
    });

    const seedRole = (fields: Record<string, unknown>) => db.node.create({
      data: { id: generateId(), memoryId: systemMemoryId, loc: 'roles:reviewer', name: 'reviewer', role: 'guide', description: 'old', ...fields },
    });

    it('an agent cannot edit a governed role node; the portal human can', async () => {
      await seedRole({});
      const args = { appRef, role: 'reviewer', description: 'new' };
      await expectRefused(M.updateTeamRole({}, args, ctx()), 'AUTHORING_ATTESTATION_MISSING');
      expect(await stored('roles:reviewer', systemMemoryId)).toMatchObject({ description: 'old' });
      await M.updateTeamRole({}, args, portal());
      expect(await stored('roles:reviewer', systemMemoryId)).toMatchObject({ description: 'new' });
    });

    it('an agent cannot revive a governed role tombstone either', async () => {
      await seedRole({ deletedAt: new Date() });
      // A team agent is the one holding a live role, so give it another.
      await db.node.create({ data: { id: generateId(), memoryId: systemMemoryId, loc: 'roles:author', name: 'author' } });
      const args = { appRef, role: 'reviewer', description: 'new' };
      await expectRefused(M.createTeamRole({}, args, ctx()), 'AUTHORING_ATTESTATION_MISSING');
      expect((await stored('roles:reviewer', systemMemoryId)).deletedAt).not.toBeNull();
    });
  });
});

describe('#3437 item 7: an encrypted no-op, on real ciphertext', () => {
  const dataKey = Buffer.alloc(32, 7).toString('base64');
  const key = parseDataKey(dataKey);
  let privateId: string;
  let privateTask: string;

  /** A private memory, its rules and two stamped rows, then real encryption over all of it. */
  beforeEach(async () => {
    privateId = (await resolvers.Mutation.createMemory(null, { orgId, name: 'private-draft', memoryClass: 'private', draftCorpus: true }, ctx())).id;
    privateTask = (await db.node.create({ data: { id: generateId(), memoryId: privateId, loc: 'author-task', name: 'T', isRunnable: true } })).id;
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: privateId } });
    const stamp = { authorshipKind: 'TASK' as const, authoredByTask: privateTask, authoredByRevision: 1, authoredAt: new Date() };
    for (const [loc, role] of [['pas:010:01', 'spec'], ['guide-page', 'guide']] as const) {
      await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role, authorTaskId: privateTask, authorTaskRequired: true } });
      await db.node.create({ data: { id: generateId(), memoryId: privateId, loc, name: loc, content: 'cat', role, ...stamp } });
    }
    await resolvers.Mutation.encryptMemory(null, { memoryId: privateId, dataKey }, ctx());
    sessionKeyCache.set('seams-3437', privateId, key);
  });

  const row = (loc: string) => stored(loc, privateId);
  const expectStampedAndCurrent = async (loc: string) => {
    const after = await row(loc);
    expect(isCiphertext(after.content)).toBe(true);
    expect(decryptNodeFieldsWithKey({ ...after }, key)).toMatchObject({ content: 'cat', authoredByTask: privateTask, authoredByRevision: 1 });
    expect(after.revisionContentHash).toBe(await computeRevisionStateHash(db, after.id));
    // A reconcile sees no drift, so the stamp outlives the fresh ciphertext.
    await db.$transaction((tx) => ensureCurrentNodeRevisionInTransaction(tx, after.id, { expectedMemoryId: privateId }));
    expect(await row(loc)).toMatchObject({ authoredByTask: privateTask, authoredByRevision: 1 });
  };

  it('node replace: the same text needs no claim and keeps the stamp; a real change refuses', async () => {
    const node = await row('guide-page');
    const input = { nodeIds: [node.id], fields: ['content'], oldText: 'cat' };
    await M.searchReplaceInNodes({}, { input: { ...input, newText: 'cat' } }, ctx());
    await expectStampedAndCurrent('guide-page');
    const before = await row('guide-page');
    await expectRefused(M.searchReplaceInNodes({}, { input: { ...input, newText: 'dog' } }, ctx()), 'AUTHORING_ATTESTATION_MISSING');
    expect((await row('guide-page')).content).toBe(before.content);
  });

  it('spec replace: the same text needs no claim and keeps the stamp; a real change refuses', async () => {
    const node = await row('pas:010:01');
    const input = { memoryRef: privateId, nodeIds: [node.id], fields: ['content'], oldText: 'cat', dryRun: true };
    const replace = (rest: Record<string, unknown>) => resolvers.Mutation.searchReplaceInSpecNodes(null, { input: { ...input, ...rest } } as never, ctx());
    const same = await replace({ newText: 'cat' }) as { plan: string };
    await replace({ newText: 'cat', dryRun: false, expectedPlan: same.plan });
    await expectStampedAndCurrent('pas:010:01');
    const before = await row('pas:010:01');
    const changing = await replace({ newText: 'dog' }) as { plan: string };
    await expect(replace({ newText: 'dog', dryRun: false, expectedPlan: changing.plan }))
      .rejects.toMatchObject({ extensions: { code: 'AUTHORING_ATTESTATION_MISSING', role: 'spec' } });
    expect((await row('pas:010:01')).content).toBe(before.content);
  });
});
