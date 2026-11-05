/**
 * #1332 — recording a content-validation report (hrn:node:hadronmemory.com:specs:cor:dmo:160:01).
 * Pins follow the issue's acceptance list (1-7, 5a-5e, 6a-6d) and Vera's FIT readings (#80505).
 */
import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { DIRECT_USER_REFERENCES } from '../../../controller/operations/mergeUsers.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { resolvers, type Context } from './resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

type Fn = (p: unknown, a: unknown, c: Context) => Promise<Record<string, unknown>>;
const M = resolvers.Mutation as unknown as Record<string, Fn>;
const Q = resolvers.Query as unknown as Record<string, Fn>;

let orgId: string;
let appId: string;
let mia: string; // the human author
let leo: string; // another writer
let ann: string; // a reader only
let stranger: string; // no access
let memoryId: string;
let otherMemoryId: string;
let authorTask: string;
let validationTask: string;
let nodeId: string;

const person = (userId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], userId, ...extra }) as Context;
/** A real user API key (an OAuth grant is one with scopes): the write gate reads the key row. */
async function viaKey(userId: string, oauthScopes: string[] = []): Promise<Context> {
  const key = await db.userApiKey.create({ data: { userId, keyHash: generateId(), keyPreview: 'test', oauthScopes } });
  return person(userId, { apiKeyId: key.id, oauthScopes } as Partial<Context>);
}
const portal = (userId: string): Context => person(userId, { portalHumanUserId: userId } as Partial<Context>);
const asWorker = <T>(workerId: string, userId: string, fn: () => Promise<T>) =>
  runAsActor({ workerId, agentId: 'agent-1', userId }, fn);

async function mintRun(entryNodeId: string | null, userId: string = leo) {
  return db.appRun.create({
    data: {
      id: generateId(), organizationId: orgId, appId, userId,
      triggerKind: 'MANUAL', entryNodeUrn: 'cv-org:mem:flow', entryNodeId, status: 'RUNNING',
    },
  });
}
const asRun = async <T>(run: { id: string; agentId?: string | null }, fn: (c: Context) => Promise<T>) =>
  runAsActor({ workerId: null, agentId: null, userId: null }, () => fn(runContext(db, run as never)));

const report = (c: Context, extra: Record<string, unknown> = {}) => M.recordNodeContentValidationReport({}, {
  nodeRef: nodeId, nodeRevision: 1, validationTaskRef: validationTask, validationTaskRevision: 1, outcome: 'PASS', ...extra,
}, c);

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, 'expected a refusal').toBeInstanceOf(GraphQLError);
  return (error as GraphQLError).extensions?.code;
};
const reportCount = () => db.nodeContentValidationReport.count();

/** Stamp the current revision directly: the stamp shapes are #1328/#1336's, not under test here. */
async function stamp(kind: 'HUMAN' | 'TASK' | null) {
  await db.$executeRaw`UPDATE nodes SET
    authorship_kind = ${kind}::"NodeAuthorshipKind",
    authored_by_human = ${kind === 'HUMAN' ? mia : null},
    authored_by_task = ${kind === 'TASK' ? authorTask : null},
    authored_by_revision = ${kind === 'TASK' ? 1 : null},
    authored_at = ${kind ? new Date() : null}
    WHERE id = ${nodeId}`;
  // Keep the revision fingerprint current: authorship is part of it.
  await db.$executeRaw`UPDATE nodes SET revision_content_hash = hadron_node_revision_state_hash(nodes) WHERE id = ${nodeId}`;
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cv-org', urn: 'cv-org' } })).id;
  const mk = async (h: string, role: 'ADMIN' | 'CONTRIBUTOR' | 'READER' | null) => {
    const u = await db.user.create({ data: { handle: h } });
    if (role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
    return u.id;
  };
  mia = await mk('cv-mia', 'CONTRIBUTOR');
  leo = await mk('cv-leo', 'CONTRIBUTOR');
  ann = await mk('cv-ann', 'READER');
  stranger = await mk('cv-stranger', null);
  const mkMem = async (name: string) => (await db.memory.create({
    data: { id: generateId(), organizationId: orgId, urn: `cv-org:${name}`, name, class: 'knowledge', visibility: 'ORGANIZATION' },
  })).id;
  memoryId = await mkMem('mem');
  otherMemoryId = await mkMem('other');
  authorTask = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'author-task', name: 'Author', isRunnable: true, content: 'write' } })).id;
  validationTask = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'validate-task', name: 'Validate', isRunnable: true, content: 'check' } })).id;
  for (const mem of [memoryId, otherMemoryId]) {
    const configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: mem } })).id;
    await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', validationTaskId: validationTask, validationTaskRequired: true } });
  }
  nodeId = ((await M.createNode({}, { input: { memoryId, loc: 'doc', name: 'Doc', content: 'body', role: 'guide' } }, person(leo))) as { id: string }).id;
  await stamp(null);
  // A run App whose agent may write both memories; runs act on behalf of leo (#3278).
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'cv-app', urn: 'cv-org::cv-app' } })).id;
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'cv-agent', urn: 'cv-org:cv-agent' } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId: leo, role: 'member' } });
  await db.appMember.create({ data: { appId, userId: mia, role: 'member' } });
  for (const mem of [memoryId, otherMemoryId]) await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: mem, role: 'read-write' } });
  // #1162: a WORKER reporter is a fenced Worker reference, so the workers the pins act as exist.
  for (const id of ['worker-held-by-mia', 'worker-that-wrote-r', 'w', 'wa', 'wb', 'w-1']) {
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId, agentId: agent.id, name: `cv-${id}`, slug: `cv-${id}` } });
  }
});

describe('#1332 who may record (cor:dmo:160:01 table)', () => {
  it('1. a HUMAN author is refused through every credential; a worker they hold is CHECKED', async () => {
    await stamp('HUMAN');
    expect(await refusal(report(person(mia)))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    expect(await refusal(report(portal(mia)))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    expect(await refusal(report(await viaKey(mia)))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    expect(await refusal(report(await viaKey(mia, ['mcp'])))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    expect(await reportCount()).toBe(0);
    const ok = await asWorker('worker-held-by-mia', mia, () => report(person(mia)));
    expect((ok.report as Record<string, unknown>).authorCheck).toBe('CHECKED');
    expect(await db.nodeContentValidationReport.findFirstOrThrow()).toMatchObject({ reporterKind: 'WORKER', reporterWorkerId: 'worker-held-by-mia', reporterUserId: null });
  });

  it('S4b. a run on the HUMAN author\'s behalf is not the author acting as themselves: CHECKED', async () => {
    await stamp('HUMAN');
    const run = await mintRun(validationTask, mia);
    const ok = await asRun(run, (c) => report(c));
    expect((ok.report as Record<string, unknown>).authorCheck).toBe('CHECKED');
    expect(await db.nodeContentValidationReport.findFirstOrThrow()).toMatchObject({ reporterKind: 'RUN', reporterRunId: run.id, reporterUserId: null });
  });

  it('2/6b. TASK: a run of the author task is refused, a run of another task is CHECKED, others AUTHOR_UNKNOWN', async () => {
    await stamp('TASK');
    expect(await refusal(asRun(await mintRun(authorTask), (c) => report(c)))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    expect(await reportCount()).toBe(0);
    const checked = await asRun(await mintRun(validationTask), (c) => report(c, { runId: 'r-checked' }));
    expect((checked.report as Record<string, unknown>).authorCheck).toBe('CHECKED');
    // The worker that wrote R is admitted, never compared (0191); agents are not compared either.
    const worker = await asWorker('worker-that-wrote-r', leo, () => report(person(leo), { runId: 'r-worker' }));
    expect((worker.report as Record<string, unknown>).authorCheck).toBe('AUTHOR_UNKNOWN');
    const nullEntry = await asRun(await mintRun(null), (c) => report(c, { runId: 'r-null' }));
    expect((nullEntry.report as Record<string, unknown>).authorCheck).toBe('AUTHOR_UNKNOWN');
    const direct = await report(person(mia), { runId: 'r-person' });
    expect((direct.report as Record<string, unknown>).authorCheck).toBe('AUTHOR_UNKNOWN');
  });

  it('6c. author task = validation task: every run of it is refused, a worker session is AUTHOR_UNKNOWN', async () => {
    await db.$executeRaw`UPDATE nodes SET authorship_kind = 'TASK', authored_by_task = ${validationTask}, authored_by_revision = 1, authored_at = now() WHERE id = ${nodeId}`;
    await db.$executeRaw`UPDATE nodes SET revision_content_hash = hadron_node_revision_state_hash(nodes) WHERE id = ${nodeId}`;
    expect(await refusal(asRun(await mintRun(validationTask), (c) => report(c)))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    const worker = await asWorker('w', leo, () => report(person(leo)));
    expect((worker.report as Record<string, unknown>).authorCheck).toBe('AUTHOR_UNKNOWN');
  });

  it('3. no stamp: every writer is admitted as AUTHOR_UNKNOWN', async () => {
    const ok = await report(person(mia));
    expect((ok.report as Record<string, unknown>).authorCheck).toBe('AUTHOR_UNKNOWN');
    expect(ok.state).toBe('PASS');
  });

  it('(3) a pruned past revision has no recorded stamp: AUTHOR_UNKNOWN, not refused', async () => {
    await stamp('HUMAN');
    await M.updateNode({}, { input: { memoryId, loc: 'doc', content: 'two' } }, person(leo));
    await db.nodeRevision.deleteMany({ where: { nodeId, revNo: 1 } });
    const ok = await report(person(mia), { nodeRevision: 1 });
    expect((ok.report as Record<string, unknown>).authorCheck).toBe('AUTHOR_UNKNOWN');
  });

  it('a past revision is judged by its own snapshot stamp, not the current one', async () => {
    await stamp('HUMAN');
    await M.updateNode({}, { input: { memoryId, loc: 'doc', content: 'two' } }, person(leo));
    // Revision 2 is leo's unstamped edit; revision 1 was mia's.
    expect(await refusal(report(person(mia), { nodeRevision: 1 }))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    const ok = await report(person(mia), { nodeRevision: 2 });
    expect((ok.report as Record<string, unknown>).authorCheck).toBe('AUTHOR_UNKNOWN');
  });

  it('(2) a caller that is none of the four reporter kinds is refused; the kinds take precedence run > worker > person > App key', async () => {
    const { deriveReporter } = await import('../../../lib/contentValidationReport.js');
    const unknown = await deriveReporter(db, { appId, clientId: 'agent-session-client' }).then(() => null, (e: GraphQLError) => e.extensions?.code);
    expect(unknown).toBe('CONTENT_VALIDATION_REPORTER_UNKNOWN');
    expect(await deriveReporter(db, { appId, appKeyId: 'ak', userId: mia })).toEqual({ kind: 'PERSON', userId: mia });
    expect(await deriveReporter(db, { appId, appKeyId: 'ak' })).toEqual({ kind: 'APP_KEY', appKeyId: 'ak' });
    expect(await asWorker('w', mia, () => deriveReporter(db, { userId: mia, appKeyId: 'ak' }))).toEqual({ kind: 'WORKER', workerId: 'w', agentId: 'agent-1' });
    const run = await mintRun(validationTask, mia);
    expect(await asWorker('w', mia, () => deriveReporter(db, runContext(db, run)))).toEqual({ kind: 'RUN', runId: run.id, entryNodeId: validationTask });
    // A run principal naming a run of another App, or none, is unknown.
    const foreign = await deriveReporter(db, { ...runContext(db, run), appId: 'other-app' }).then(() => null, (e: GraphQLError) => e.extensions?.code);
    expect(foreign).toBe('CONTENT_VALIDATION_REPORTER_UNKNOWN');
    const impersonating = await deriveReporter(db, { userId: mia, impersonation: { orgId } }).then(() => null, (e: GraphQLError) => e.extensions?.code);
    expect(impersonating).toBe('CONTENT_VALIDATION_REPORTER_UNKNOWN');
  });
});

describe('#1332 state and history', () => {
  it('4. a late report for N after the content reached N+1 is stored and leaves N+1 unvalidated', async () => {
    await M.updateNode({}, { input: { memoryId, loc: 'doc', content: 'two' } }, person(leo));
    const late = await report(person(mia), { nodeRevision: 1, outcome: 'PASS' });
    expect(late.state).toBe('STALE');
    expect(await reportCount()).toBe(1);
    const node = await Q.node({}, { ref: nodeId }, person(mia)) as Record<string, unknown>;
    const { typeResolvers } = await import('./resolvers.types.js');
    const cv = await (typeResolvers.Node.contentValidation as unknown as (n: unknown, a: unknown, c: Context) => Promise<{ state: string }>)(node, {}, person(mia));
    expect(cv.state).not.toBe('PASS');
  });

  it('7. end to end: author, then a separate context, then PASS, FAIL and STALE are visible', async () => {
    await stamp('TASK');
    const pass = await asRun(await mintRun(validationTask), (c) => report(c, { outcome: 'PASS' }));
    expect(pass.state).toBe('PASS');
    const fail = await asRun(await mintRun(validationTask), (c) => report(c, { outcome: 'FAIL' }));
    expect(fail.state).toBe('FAIL');
    await M.updateNode({}, { input: { memoryId, loc: 'doc', content: 'edited' } }, person(leo));
    const cur = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { revSeq: true } });
    const { resolveContentValidation } = await import('./resolvers.types.js');
    expect((await resolveContentValidation({ nodeId, memoryId, revSeq: cur.revSeq }, person(mia))).state).toBe('STALE');
    // The report never edited the node.
    expect(cur.revSeq).toBe(2);
  });
});

describe('#1332 refusal order and the report\'s own checks', () => {
  it('6a. a reader posting as the author gets FORBIDDEN, a non-reader NODE_NOT_FOUND', async () => {
    await db.$executeRaw`UPDATE nodes SET authorship_kind = 'HUMAN', authored_by_human = ${ann}, authored_at = now() WHERE id = ${nodeId}`;
    await db.$executeRaw`UPDATE nodes SET revision_content_hash = hadron_node_revision_state_hash(nodes) WHERE id = ${nodeId}`;
    expect(await refusal(report(person(ann)))).toBe('FORBIDDEN');
    expect(await refusal(report(person(stranger)))).toBe('NODE_NOT_FOUND');
    // Even with a bogus task, revision and run id, nothing past the gate is disclosed.
    expect(await refusal(report(person(stranger), { validationTaskRef: 'nope', nodeRevision: 99, runId: 'x' }))).toBe('NODE_NOT_FOUND');
    expect(await refusal(report(person(ann), { validationTaskRef: 'nope', nodeRevision: 99, runId: 'x' }))).toBe('FORBIDDEN');
    expect(await reportCount()).toBe(0);
  });

  it('6d. task and revision checks refuse with nothing written; older revisions are accepted', async () => {
    expect(await refusal(report(person(leo), { nodeRevision: 2 }))).toBe('CONTENT_VALIDATION_NODE_REVISION_INVALID');
    expect(await refusal(report(person(leo), { validationTaskRef: authorTask }))).toBe('CONTENT_VALIDATION_WRONG_TASK');
    expect(await refusal(report(person(leo), { validationTaskRevision: 2 }))).toBe('CONTENT_VALIDATION_TASK_REVISION_INVALID');
    expect(await reportCount()).toBe(0);
    // The task the rule named before is refused once the rule names another.
    const fresh = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'validate-2', name: 'V2', isRunnable: true, content: 'c' } })).id;
    await db.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { validationTaskId: fresh } });
    expect(await refusal(report(person(leo)))).toBe('CONTENT_VALIDATION_WRONG_TASK');
    // A broken reference (the task deleted) fails closed.
    await db.node.update({ where: { id: fresh }, data: { deletedAt: new Date() } });
    expect(await refusal(report(person(leo), { validationTaskRef: fresh }))).toBe('CONTENT_VALIDATION_TASK_BROKEN');
    await db.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { validationTaskId: null } });
    expect(await refusal(report(person(leo)))).toBe('CONTENT_VALIDATION_TASK_BROKEN');
    // No validation task configured for the kind.
    await db.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { validationTaskRequired: false } });
    expect(await refusal(report(person(leo)))).toBe('CONTENT_VALIDATION_NOT_CONFIGURED');
    expect(await reportCount()).toBe(0);
  });

  it('6d. a task revision older than current and an older node revision are accepted (late)', async () => {
    await db.node.update({ where: { id: validationTask }, data: { revSeq: 3 } });
    await M.updateNode({}, { input: { memoryId, loc: 'doc', content: 'two' } }, person(leo));
    const ok = await report(person(leo), { validationTaskRef: 'hrn:node:cv-org:mem:validate-task', validationTaskRevision: 2, nodeRevision: 1 });
    expect(ok.report).toMatchObject({ nodeRevision: 1, validationTaskRevision: 2 });
  });

  it('(4) a raw-writer drift that races the reconcile is a retryable CONFLICT that writes nothing', async () => {
    const { recordContentValidationReportInTx } = await import('../../../lib/contentValidationReport.js');
    await db.$executeRaw`UPDATE nodes SET content = 'raw edit' WHERE id = ${nodeId}`;
    const error = await db.$transaction((tx) => recordContentValidationReportInTx(tx, {
      nodeId, memoryId, nodeRevision: 1, validationTaskRef: validationTask, validationTaskRevision: 1,
      outcome: 'PASS', runId: null, reporter: { kind: 'PERSON', userId: leo },
    })).then(() => null, (e: unknown) => e);
    expect((error as GraphQLError).extensions?.code).toBe('CONFLICT');
    expect(await reportCount()).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).revSeq).toBe(1);
  });

  it('(4) access lost between the gate and the reconcile fence: not found, and nothing is reconciled or written', async () => {
    await db.$executeRaw`UPDATE nodes SET content = 'raw edit' WHERE id = ${nodeId}`;
    let revoked = false;
    // The first transaction of the call is the reconcile's: revoke leo's membership just before it, after the gate passed.
    const racing = new Proxy(db, {
      get(target, key, receiver) {
        if (key === '$transaction' && !revoked) {
          return async (...a: unknown[]) => {
            revoked = true;
            await db.orgMember.deleteMany({ where: { organizationId: orgId, userId: leo } });
            return (target.$transaction as (...x: unknown[]) => unknown)(...a);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(await refusal(report({ ...person(leo), db: racing } as Context))).toBe('NODE_NOT_FOUND');
    expect(revoked).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).revSeq).toBe(1);
    expect(await reportCount()).toBe(0);
  });

  it('BAD_USER_INPUT for malformed arguments, before any read', async () => {
    expect(await refusal(report(person(stranger), { runId: ' padded ' }))).toBe('BAD_USER_INPUT');
    expect(await refusal(report(person(stranger), { runId: 'x'.repeat(201) }))).toBe('BAD_USER_INPUT');
    expect(await refusal(report(person(stranger), { nodeRevision: 0 }))).toBe('BAD_USER_INPUT');
  });
});

describe('#1332 runId replay (refusal 5)', () => {
  it('5. same reporter, node, revision and task revision replays one row; any other match conflicts with no content', async () => {
    const first = await report(person(leo), { runId: 'run-x', outcome: 'PASS' });
    const again = await report(person(leo), { runId: 'run-x', outcome: 'FAIL' });
    expect(again.replayed).toBe(true);
    expect(again.report).toEqual(first.report);
    expect(await reportCount()).toBe(1);
    const conflict = await report(person(mia), { runId: 'run-x' }).then(() => null, (e: GraphQLError) => e);
    expect(conflict!.extensions).toEqual({ code: 'CONTENT_VALIDATION_RUN_ID_CONFLICT' });
    expect(conflict!.message).not.toMatch(/leo|PASS|run-x/);
    await db.node.update({ where: { id: validationTask }, data: { revSeq: 2 } });
    expect(await refusal(report(person(leo), { runId: 'run-x', validationTaskRevision: 2 }))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    expect(await reportCount()).toBe(1);
  });

  it('5a. reporter separation: user id alone never matches across kinds or workers', async () => {
    await report(person(mia), { runId: 'p' });
    // The same person through their user key: the person, so it replays.
    expect((await report(await viaKey(mia), { runId: 'p' })).replayed).toBe(true);
    // The same user through a worker they hold: another reporter.
    expect(await refusal(asWorker('wa', mia, () => report(person(mia), { runId: 'p' })))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    await asWorker('wa', mia, () => report(person(mia), { runId: 'w' }));
    expect(await refusal(asWorker('wb', mia, () => report(person(mia), { runId: 'w' })))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    // Two runs of the same task.
    await asRun(await mintRun(validationTask), (c) => report(c, { runId: 'r' }));
    expect(await refusal(asRun(await mintRun(validationTask), (c) => report(c, { runId: 'r' })))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    // An App key then a person.
    await db.$executeRaw`INSERT INTO node_content_validation_reports (id, node_id, memory_id, node_rev_seq, validation_task_id, validation_task_rev_seq, outcome, run_id, author_check, reporter_kind, reporter_app_key_id)
      VALUES (${generateId()}, ${nodeId}, ${memoryId}, 1, ${validationTask}, 1, 'PASS', 'k', 'AUTHOR_UNKNOWN', 'APP_KEY', 'app-key-1')`;
    expect(await refusal(report(person(mia), { runId: 'k' }))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    expect(await reportCount()).toBe(4);
  });

  it('5b. a run\'s reporter is its server AppRun id, never the runId it sends', async () => {
    const runA = await mintRun(validationTask);
    await asRun(runA, (c) => report(c, { runId: runA.id }));
    const runB = await mintRun(validationTask);
    // B sends A's AppRun id as its runId: it is B, so it conflicts.
    expect(await refusal(asRun(runB, (c) => report(c, { runId: runA.id })))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    expect(await db.nodeContentValidationReport.findFirstOrThrow({ where: { runId: runA.id } })).toMatchObject({ reporterRunId: runA.id });
  });

  it('5c. no cross-node or cross-memory oracle: a runId elsewhere is a fresh insert', async () => {
    await report(person(leo), { runId: 'shared' });
    const other = ((await M.createNode({}, { input: { memoryId: otherMemoryId, loc: 'doc', name: 'Doc', content: 'b', role: 'guide' } }, person(leo))) as { id: string }).id;
    const fresh = await report(person(mia), { nodeRef: other, runId: 'shared' });
    expect(fresh.replayed).toBe(false);
    // The node moves from mem to other: the old report stays in mem's snapshot.
    await db.node.delete({ where: { id: other } });
    // BLIND P3: the public move, with no fallback.
    await M.moveNode({}, { sourceRef: nodeId, targetMemoryRef: otherMemoryId }, person(leo));
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).memoryId).toBe(otherMemoryId);
    const moved = await report(person(mia), { runId: 'shared', nodeRevision: (await db.node.findUniqueOrThrow({ where: { id: nodeId } })).revSeq });
    expect(moved.replayed).toBe(false);
    expect(await db.nodeContentValidationReport.count({ where: { nodeId, runId: 'shared' } })).toBe(2);
  });

  it('5d. a null reporter never replays; a deleted reporter keeps its ids; a merged user\'s survivor replays', async () => {
    await db.nodeContentValidationReport.create({ data: { nodeId, memoryId, nodeRevSeq: 1, validationTaskId: validationTask, validationTaskRevSeq: 1, outcome: 'PASS', runId: 'legacy' } });
    expect(await refusal(report(person(leo), { runId: 'legacy' }))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');

    const gone = await db.user.create({ data: { handle: 'cv-gone' } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: gone.id, role: 'CONTRIBUTOR' } });
    await report(person(gone.id), { runId: 'gone' });
    await db.orgMember.deleteMany({ where: { userId: gone.id } });
    await db.user.delete({ where: { id: gone.id } });
    expect(await db.nodeContentValidationReport.findFirstOrThrow({ where: { runId: 'gone' } })).toMatchObject({ reporterUserId: gone.id });
    expect(await refusal(report(person(leo), { runId: 'gone' }))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');

    // The merge rewrites reporter_user_id with the other direct user references (mergeUsers).
    expect(DIRECT_USER_REFERENCES).toContainEqual(['node_content_validation_reports', 'reporter_user_id']);
    // BLIND P2-2: the real merge, which records itself before it reassigns; then a chained merge follows it.
    await report(await viaKey(mia), { runId: 'merged' });
    await mergeUsers(db, { sourceUserId: mia, targetUserId: leo });
    expect((await report(await viaKey(leo), { runId: 'merged' })).replayed).toBe(true);
    const cleo = (await db.user.create({ data: { handle: 'cv-cleo' } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: cleo, role: 'CONTRIBUTOR' } });
    await mergeUsers(db, { sourceUserId: leo, targetUserId: cleo });
    expect(await db.nodeContentValidationReport.findFirstOrThrow({ where: { runId: 'merged' } })).toMatchObject({ reporterUserId: cleo });
    expect((await report(await viaKey(cleo), { runId: 'merged' })).replayed).toBe(true);
  });

  it('5e. concurrent identical reports make one row; different reporters get one row and a conflict', async () => {
    const [a, b] = await Promise.all([report(person(leo), { runId: 'c1' }), report(person(leo), { runId: 'c1' })]);
    expect(a.report).toEqual(b.report);
    expect(await db.nodeContentValidationReport.count({ where: { runId: 'c1' } })).toBe(1);
    const results = await Promise.allSettled([report(person(leo), { runId: 'c2' }), report(person(mia), { runId: 'c2' })]);
    const codes = results.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as GraphQLError).extensions?.code));
    expect(codes.sort()).toEqual(['CONTENT_VALIDATION_RUN_ID_CONFLICT', 'ok']);
    expect(await db.nodeContentValidationReport.count({ where: { runId: 'c2' } })).toBe(1);
  });
});

describe('#1332 mutant pins (every reporter id, every broken-task shape, impersonation)', () => {
  type Reporter = Parameters<typeof import('../../../lib/contentValidationReport.js').recordContentValidationReportInTx>[1]['reporter'];
  const inTx = async (reporter: Reporter, runId = 'm1') => {
    const { recordContentValidationReportInTx } = await import('../../../lib/contentValidationReport.js');
    return db.$transaction((tx) => recordContentValidationReportInTx(tx, {
      nodeId, memoryId, nodeRevision: 1, validationTaskRef: validationTask, validationTaskRevision: 1, outcome: 'PASS', runId, reporter,
    }));
  };

  it('the same worker under another agent, and another App key, are other reporters: a conflict, never a replay', async () => {
    await inTx({ kind: 'WORKER', workerId: 'w-1', agentId: 'agent-a' });
    expect((await inTx({ kind: 'WORKER', workerId: 'w-1', agentId: 'agent-a' })).replayed).toBe(true);
    expect(await refusal(inTx({ kind: 'WORKER', workerId: 'w-1', agentId: 'agent-b' }))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    await inTx({ kind: 'APP_KEY', appKeyId: 'key-a' }, 'm2');
    expect((await inTx({ kind: 'APP_KEY', appKeyId: 'key-a' }, 'm2')).replayed).toBe(true);
    expect(await refusal(inTx({ kind: 'APP_KEY', appKeyId: 'key-b' }, 'm2'))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    expect(await reportCount()).toBe(2);
  });

  it('#1162: a WORKER reporter naming no Worker is refused by the reference fence and writes nothing', async () => {
    const error = await inTx({ kind: 'WORKER', workerId: 'no-such-worker', agentId: null }).then(() => null, (e: unknown) => e);
    expect((error as GraphQLError).extensions?.code).toBe('WORKER_REFERENCE_NOT_FOUND');
    expect(await reportCount()).toBe(0);
  });

  it('a task in a deleted memory, or no longer runnable, is broken: refused, nothing written', async () => {
    await db.node.update({ where: { id: validationTask }, data: { isRunnable: false } });
    expect(await refusal(report(person(leo)))).toBe('CONTENT_VALIDATION_TASK_BROKEN');
    await db.node.update({ where: { id: validationTask }, data: { isRunnable: true } });
    // The task lives in another memory, which is deleted.
    const elsewhere = (await db.node.create({ data: { id: generateId(), memoryId: otherMemoryId, loc: 'v-elsewhere', name: 'V', isRunnable: true, content: 'c' } })).id;
    await db.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { validationTaskId: elsewhere } });
    await db.memory.update({ where: { id: otherMemoryId }, data: { deletedAt: new Date() } });
    expect(await refusal(report(person(leo), { validationTaskRef: elsewhere }))).toBe('CONTENT_VALIDATION_TASK_BROKEN');
    expect(await reportCount()).toBe(0);
  });

  it('impersonation is FORBIDDEN (read-only on every surface), before any reporter is derived', async () => {
    expect(await refusal(report(person(leo, { impersonation: { orgId } } as Partial<Context>)))).toBe('FORBIDDEN');
    expect(await reportCount()).toBe(0);
  });
});

describe('#1332 fix head (LOCAL Bruno P2 on 21c79c2c; QA Charles observation)', () => {
  it('the receipt never projects state from a memory the node moved into after commit', async () => {
    // An org the caller (leo) is not a member of; its memory carries a FAIL for this node.
    const hiddenOrg = (await db.organization.create({ data: { id: generateId(), name: 'cv-hidden', urn: 'cv-hidden' } })).id;
    const hidden = (await db.memory.create({ data: { id: generateId(), organizationId: hiddenOrg, urn: 'cv-hidden:secret', name: 'Secret', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
    let moved = false;
    // Move the node at the first post-commit read, after the authorized write committed.
    const racing = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'node') return Reflect.get(target, key, receiver);
      return new Proxy(target.node, { get(model, op, r) {
        if (op !== 'findUnique') return Reflect.get(model, op, r);
        return async (a: { where?: { id?: string }; select?: Record<string, boolean> }) => {
          if (!moved && a.where?.id === nodeId && a.select?.revSeq && (await reportCount()) === 1) {
            moved = true;
            // An edit there (revSeq 2) must not surface either: the receipt would read STALE.
            await db.node.update({ where: { id: nodeId }, data: { memoryId: hidden, revSeq: 2 } });
            await db.nodeContentValidationReport.create({ data: { nodeId, memoryId: hidden, nodeRevSeq: 1, validationTaskId: validationTask, validationTaskRevSeq: 1, outcome: 'FAIL' } });
          }
          return (model.findUnique as (x: unknown) => unknown)(a);
        };
      } });
    } });
    const result = await report(person(leo, { db: racing as typeof db }));
    expect(moved).toBe(true);
    expect(await Q.node({}, { ref: nodeId }, person(leo))).toBeNull();
    // The authorized (node, memory, revision) snapshot: the caller's own PASS, nothing of the destination.
    expect(result.state).toBe('PASS');
    expect((result.report as Record<string, unknown>).outcome).toBe('PASS');
  });

  it('§10 P3-6: a replayed receipt answers from the authorized snapshot too, never the memory the node moved into', async () => {
    const hiddenOrg = (await db.organization.create({ data: { id: generateId(), name: 'cv-hidden-r', urn: 'cv-hidden-r' } })).id;
    const hidden = (await db.memory.create({ data: { id: generateId(), organizationId: hiddenOrg, urn: 'cv-hidden-r:secret', name: 'Secret', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
    const first = await report(person(leo), { runId: 'replay-move' });
    expect(first.replayed).toBe(false);
    let moved = false;
    // Move the node at the replay's first post-commit read (the only node read selecting revSeq).
    const racing = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'node') return Reflect.get(target, key, receiver);
      return new Proxy(target.node, { get(model, op, r) {
        if (op !== 'findUnique') return Reflect.get(model, op, r);
        return async (a: { where?: { id?: string }; select?: Record<string, boolean> }) => {
          if (!moved && a.where?.id === nodeId && a.select?.revSeq) {
            moved = true;
            await db.node.update({ where: { id: nodeId }, data: { memoryId: hidden, revSeq: 2 } });
            await db.nodeContentValidationReport.create({ data: { nodeId, memoryId: hidden, nodeRevSeq: 1, validationTaskId: validationTask, validationTaskRevSeq: 1, outcome: 'FAIL' } });
          }
          return (model.findUnique as (x: unknown) => unknown)(a);
        };
      } });
    } });
    const replay = await report(person(leo, { db: racing as typeof db }), { runId: 'replay-move' });
    expect(moved).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.state).toBe('PASS');
    expect((replay.report as Record<string, unknown>).outcome).toBe('PASS');
  });

  it('§10 P3-6: the snapshot is the LOCKED revision (a late report) on fresh and replay, and a node deleted after commit answers from it', async () => {
    const hiddenOrg = (await db.organization.create({ data: { id: generateId(), name: 'cv-hidden-l', urn: 'cv-hidden-l' } })).id;
    const hidden = (await db.memory.create({ data: { id: generateId(), organizationId: hiddenOrg, urn: 'cv-hidden-l:secret', name: 'Secret', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
    /** A db whose first post-commit node read (the only one selecting revSeq) first applies `change`. */
    const racingWith = (change: () => Promise<unknown>) => {
      let fired = false;
      const proxy = new Proxy(db, { get(target, key, receiver) {
        if (key !== 'node') return Reflect.get(target, key, receiver);
        return new Proxy(target.node, { get(model, op, r) {
          if (op !== 'findUnique') return Reflect.get(model, op, r);
          return async (a: { where?: { id?: string }; select?: Record<string, boolean> }) => {
            if (!fired && a.where?.id === nodeId && a.select?.revSeq) { fired = true; await change(); }
            return (model.findUnique as (x: unknown) => unknown)(a);
          };
        } });
      } });
      return { db: proxy as typeof db, fired: () => fired };
    };
    // The content reached revision 2; a late PASS for revision 1 leaves revision 2 STALE.
    await M.updateNode({}, { input: { memoryId, loc: 'doc', content: 'two' } }, person(leo));
    const moveOut = () => db.node.update({ where: { id: nodeId }, data: { memoryId: hidden, revSeq: 3 } });
    const fresh = racingWith(moveOut);
    const late = await report(person(mia, { db: fresh.db }), { nodeRevision: 1, runId: 'late' });
    expect(fresh.fired()).toBe(true);
    expect([late.replayed, late.state]).toEqual([false, 'STALE']);
    // Back in the authorized memory at revision 2, the replay of that late report, moved again.
    await db.node.update({ where: { id: nodeId }, data: { memoryId, revSeq: 2 } });
    const again = racingWith(moveOut);
    const replay = await report(person(mia, { db: again.db }), { nodeRevision: 1, runId: 'late' });
    expect(again.fired()).toBe(true);
    expect([replay.replayed, replay.state]).toEqual([true, 'STALE']);
    // Deleted after commit, in place, with a later revision: the receipt answers from the
    // locked revision, not the deleted row's.
    await db.node.update({ where: { id: nodeId }, data: { memoryId, revSeq: 2 } });
    const del = racingWith(() => db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date(), revSeq: 3 } }));
    const onTwo = await report(person(mia, { db: del.db }), { nodeRevision: 2, runId: 'on-two' });
    expect(del.fired()).toBe(true);
    expect([onTwo.replayed, onTwo.state]).toEqual([false, 'PASS']);
  });

  it('P3-1 (Vera, Proposed 160:01 r4): a caller who cannot read the validation task gets one WRONG_TASK for any ref and revision', async () => {
    const hiddenOrg = (await db.organization.create({ data: { id: generateId(), name: 'cv-hidden-t', urn: 'cv-hidden-t' } })).id;
    const hiddenMem = (await db.memory.create({ data: { id: generateId(), organizationId: hiddenOrg, urn: 'cv-hidden-t:tasks', name: 'Tasks', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
    const hiddenTask = (await db.node.create({ data: { id: generateId(), memoryId: hiddenMem, loc: 'validate', name: 'V', isRunnable: true, content: 'check' } })).id;
    await db.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { validationTaskId: hiddenTask } });
    // The named task with a revision past its current one, the named task's URN, and a wrong ref:
    // one answer, so a refusal confirms neither which task the rule names nor its revSeq.
    for (const extra of [
      { validationTaskRef: hiddenTask, validationTaskRevision: 99 },
      { validationTaskRef: 'hrn:node:cv-hidden-t:tasks:validate', validationTaskRevision: 99 },
      { validationTaskRef: generateId(), validationTaskRevision: 99 },
      { validationTaskRef: generateId(), validationTaskRevision: 1 },
    ]) {
      expect(await refusal(report(person(leo), extra)), JSON.stringify(extra)).toBe('CONTENT_VALIDATION_WRONG_TASK');
    }
    expect(await reportCount()).toBe(0);
    // A caller who can read the task keeps the precise refusal (the 6d pin covers the readable case
    // in the node's own memory); here a member of the task's org reads it.
    await db.orgMember.create({ data: { organizationId: hiddenOrg, userId: leo, role: 'READER' } });
    expect(await refusal(report(person(leo), { validationTaskRef: hiddenTask, validationTaskRevision: 99 }))).toBe('CONTENT_VALIDATION_TASK_REVISION_INVALID');
    expect(await reportCount()).toBe(0);
  });

  it('a named session that failed to bind (#1705) is SESSION_NOT_BOUND, never recorded as the bare credential', async () => {
    const refused = (extra: Partial<Context> = {}) => person(leo, { sessionBindingRefused: true, ...extra } as Partial<Context>);
    expect(await refusal(report(refused()))).toBe('SESSION_NOT_BOUND');
    expect(await refusal(asWorker('w', leo, () => report(refused())))).toBe('SESSION_NOT_BOUND');
    expect(await refusal(report(refused({ appKeyId: 'ak' } as Partial<Context>)))).toBe('SESSION_NOT_BOUND');
    // Refusals 1-2 still come first: a non-reader learns nothing from a refused binding.
    expect(await refusal(report(person(stranger, { sessionBindingRefused: true } as Partial<Context>)))).toBe('NODE_NOT_FOUND');
    // LOCAL Bruno P2 on c6aaa739: a reader who is not a writer gets FORBIDDEN, as without a
    // session; the refused binding never answers ahead of the writer gate.
    expect(await refusal(report(person(ann, { sessionBindingRefused: true } as Partial<Context>)))).toBe('FORBIDDEN');
    expect(await refusal(report(person(leo, { sessionBindingRefused: true, impersonation: { orgId } } as Partial<Context>)))).toBe('FORBIDDEN');
    expect(await reportCount()).toBe(0);
    // The reporter derivation refuses it too, for any other caller of the rule.
    const { deriveReporter } = await import('../../../lib/contentValidationReport.js');
    const code = await deriveReporter(db, { userId: leo, sessionBindingRefused: true }).then(() => null, (e: GraphQLError) => e.extensions?.code);
    expect(code).toBe('CONTENT_VALIDATION_REPORTER_UNKNOWN');
  });

  it('§10 P3-2: write access lost before the transaction is refused by its own gate, nothing written', async () => {
    let demoted = false;
    const racing = new Proxy(db, { get(target, key, receiver) {
      if (key !== '$transaction') return Reflect.get(target, key, receiver);
      return async (...a: unknown[]) => {
        if (!demoted) {
          demoted = true;
          await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: leo } }, data: { role: 'READER' } });
        }
        return (target.$transaction as (...x: unknown[]) => unknown).apply(target, a);
      };
    } });
    expect(await refusal(report(person(leo, { db: racing as typeof db })))).toBe('FORBIDDEN');
    expect(demoted).toBe(true);
    expect(await reportCount()).toBe(0);
  });

  it('§10 P3-3: a runId replays only for the same node revision and the same task', async () => {
    await report(person(leo), { runId: 'r' });
    await M.updateNode({}, { input: { memoryId, loc: 'doc', content: 'two' } }, person(mia));
    expect(await refusal(report(person(leo), { runId: 'r', nodeRevision: 2 }))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    // The rule now names another task: the same runId with it conflicts, never replays.
    const next = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'validate-2', name: 'V2', isRunnable: true, content: 'c' } })).id;
    await db.nodeRoleRule.updateMany({ where: { config: { memoryId } }, data: { validationTaskId: next } });
    expect(await refusal(report(person(leo), { runId: 'r', validationTaskRef: next }))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    expect(await reportCount()).toBe(1);
  });
});

describe('#1332 storage invariants', () => {
  it('the report is append-only except a recorded merge moving the person reporter', async () => {
    await report(person(leo), { runId: 'imm' });
    await expect(db.$executeRaw`UPDATE node_content_validation_reports SET outcome = 'FAIL' WHERE run_id = 'imm'`).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`UPDATE node_content_validation_reports SET reporter_kind = 'APP_KEY', reporter_user_id = NULL, reporter_app_key_id = 'k' WHERE run_id = 'imm'`).rejects.toThrow();
    // BLIND P2-2: an ordinary reassignment, with no merge recorded, is refused.
    await expect(db.$executeRaw`UPDATE node_content_validation_reports SET reporter_user_id = ${mia} WHERE run_id = 'imm'`).rejects.toThrow(/append-only/);
    // A merge recorded for another pair does not admit this one.
    await db.userMerge.create({ data: { sourceUserId: ann, targetUserId: mia } });
    await expect(db.$executeRaw`UPDATE node_content_validation_reports SET reporter_user_id = ${mia} WHERE run_id = 'imm'`).rejects.toThrow(/append-only/);
    // Exactly the recorded source to its target is admitted.
    await db.userMerge.create({ data: { sourceUserId: leo, targetUserId: mia } });
    await db.$executeRaw`UPDATE node_content_validation_reports SET reporter_user_id = ${mia} WHERE run_id = 'imm'`;
    expect(await db.nodeContentValidationReport.findFirstOrThrow({ where: { runId: 'imm' } })).toMatchObject({ reporterUserId: mia });
  });

  it('the migration carries the shared invariants file verbatim', () => {
    const shared = readFileSync('prisma/content-validation-report-invariants.sql', 'utf8');
    const migration = readFileSync('prisma/migrations/20261105170000_content_validation_reporter/migration.sql', 'utf8');
    expect(migration.endsWith(shared)).toBe(true);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('\\ir content-validation-report-invariants.sql');
  });
});
