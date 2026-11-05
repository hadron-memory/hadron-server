import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1332 (cor:dmo:160:01): the two adapters of the one report write path. The rules are pinned in
 * resolvers.contentValidationReport1332.test.ts; this pins that the MCP tool and the run tool reach
 * the SAME resolver with the SAME reporter derivation (Xavier's conditions, #80510): a worker
 * session reports as the worker, a caller that is none of the reporter kinds is refused, and a run
 * is its own AppRun however it labels the report.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { runAsActor } from '../lib/requestActor.js';
import { runContext } from '../jobs/appRunDeps.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { hadronRecordContentValidation, resolveRunTools } from '../lib/runner/tools/index.js';
import type { RunToolContext } from '../lib/runner/tools/types.js';
import type { AppRun } from '../generated/prisma/index.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

type Fn = (p: unknown, a: unknown, c: Context) => Promise<Record<string, unknown>>;
const M = resolvers.Mutation as unknown as Record<string, Fn>;

let orgId: string;
let appId: string;
let agentId: string;
let workerId: string;
let mia: string; // the HUMAN author
let leo: string; // another writer
let stranger: string; // no access
let memoryId: string;
let authorTask: string;
let validationTask: string;
let nodeId: string;

const authOf = (extra: Partial<AuthContext>) => ({ roles: ['READER'], organizationId: orgId, ...extra }) as AuthContext;
const asUser = (userId: string, extra: Partial<AuthContext> = {}) =>
  createTestableMcpServer(authOf({ userId, clientId: `user:${userId}`, ...extra }), { sessionId: `cv-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const args = (extra: Record<string, unknown> = {}) => ({
  nodeRef: nodeId, nodeRevision: 1, validationTaskRef: validationTask, validationTaskRevision: 1, outcome: 'PASS', ...extra,
});
const mcpCode = (text: string) => /^\[([a-z_]+)\]/.exec(text)?.[1].toUpperCase() ?? 'NO_ERROR';
const gqlCode = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message; }
};
const reports = () => db.nodeContentValidationReport.findMany({ orderBy: { reportedAt: 'asc' } });

async function stamp(kind: 'HUMAN' | 'TASK' | null) {
  await db.$executeRaw`UPDATE nodes SET
    authorship_kind = ${kind}::"NodeAuthorshipKind",
    authored_by_human = ${kind === 'HUMAN' ? mia : null},
    authored_by_task = ${kind === 'TASK' ? authorTask : null},
    authored_by_revision = ${kind === 'TASK' ? 1 : null},
    authored_at = ${kind ? new Date() : null}
    WHERE id = ${nodeId}`;
  await db.$executeRaw`UPDATE nodes SET revision_content_hash = hadron_node_revision_state_hash(nodes) WHERE id = ${nodeId}`;
}

async function mintRun(entryNodeId: string | null): Promise<AppRun> {
  return db.appRun.create({
    data: {
      id: generateId(), organizationId: orgId, appId, userId: leo,
      triggerKind: 'MANUAL', entryNodeUrn: 'cvm-org:mem:flow', entryNodeId, status: 'RUNNING',
    },
  });
}
const toolCtx = (run: AppRun): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run) });
const runTool = (run: AppRun, a: Record<string, unknown>) =>
  runAsActor({ workerId: null, agentId: null, userId: null }, () => hadronRecordContentValidation.execute(toolCtx(run), a));

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cvm-org', urn: 'cvm-org' } })).id;
  const mk = async (h: string, role: 'CONTRIBUTOR' | null) => {
    const u = await db.user.create({ data: { handle: h } });
    if (role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
    return u.id;
  };
  mia = await mk('cvm-mia', 'CONTRIBUTOR');
  leo = await mk('cvm-leo', 'CONTRIBUTOR');
  stranger = await mk('cvm-stranger', null);
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: orgId, urn: 'cvm-org:mem', name: 'mem', class: 'knowledge', visibility: 'ORGANIZATION' },
  })).id;
  authorTask = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'author-task', name: 'Author', isRunnable: true, content: 'write' } })).id;
  validationTask = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'validate-task', name: 'Validate', isRunnable: true, content: 'check' } })).id;
  const configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', validationTaskId: validationTask, validationTaskRequired: true } });
  nodeId = ((await M.createNode({}, { input: { memoryId, loc: 'doc', name: 'Doc', content: 'body', role: 'guide' } }, { db, roles: [], userId: leo } as Context)) as { id: string }).id;
  await stamp('HUMAN');
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'cvm-app', urn: 'cvm-org:cvm-app' } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'cvm-agent', urn: 'cvm-org:cvm-agent' } })).id;
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.');
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId: leo, role: 'member' } });
  await db.appMember.create({ data: { appId, userId: mia, role: 'owner' } });
  await db.agentMemoryItem.create({ data: { agentId, memoryId, role: 'read-write' } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Iris', slug: 'iris' } })).id;
});

describe('#1332 MCP hadron_record_content_validation', () => {
  it('records as the person and refuses with the resolver\'s codes, in parity with GraphQL', async () => {
    const ok = await asUser(leo).callToolText('hadron_record_content_validation', args({ runId: 'r1' }));
    expect(ok).toMatch(/^Recorded: PASS for revision 1 of node /);
    expect(ok).toContain('author check CHECKED');
    expect(ok).toContain('Current revision state: PASS');
    expect(await reports()).toMatchObject([{ reporterKind: 'PERSON', reporterUserId: leo, runId: 'r1' }]);
    // The same call again replays and writes nothing.
    expect(await asUser(leo).callToolText('hadron_record_content_validation', args({ runId: 'r1' }))).toMatch(/^Replayed \(nothing written\)/);

    for (const [userId, expected] of [[mia, 'CONTENT_VALIDATION_REPORTER_IS_AUTHOR'], [stranger, 'NODE_NOT_FOUND']] as const) {
      expect(mcpCode(await asUser(userId).callToolText('hadron_record_content_validation', args()))).toBe(expected);
      expect(await gqlCode(M.recordNodeContentValidationReport({}, args(), { db, roles: [], userId } as Context))).toBe(expected);
    }
    // Another reporter reusing the runId: the conflict carries nothing from the stored report.
    const conflict = await asUser(mia, {}).callToolText('hadron_record_content_validation', args({ runId: 'r1', nodeRevision: 1, outcome: 'FAIL' }));
    expect(mcpCode(conflict)).not.toBe('NO_ERROR');
    expect(await reports()).toHaveLength(1);
  });

  it('a worker session presented to MCP reports as the worker, not the binding person (the HUMAN author holds it: CHECKED)', async () => {
    const sessionId = await startWorkerSessionGql({ workerRef: workerId, userId: mia, appId });
    // In process the worker session is named on the call (the gate's own `session` argument); over HTTP the
    // X-Hadron-Session header settles the same actor before the tool runs.
    const text = await asUser(mia, { appId }).callToolText('hadron_record_content_validation', { ...args(), session: sessionId });
    expect(text, text).toMatch(/^Recorded: PASS/);
    expect(text).toContain('author check CHECKED');
    expect(await reports()).toMatchObject([{ reporterKind: 'WORKER', reporterWorkerId: workerId, reporterAgentId: agentId, reporterUserId: null }]);
  });

  it('an unknown reporter writes nothing: a session the caller does not hold, or an App principal with no write', async () => {
    // A worker session named on the call that is not one of the caller's own: the gate refuses before the resolver.
    const sessionId = await startWorkerSessionGql({ workerRef: workerId, userId: mia, appId });
    const forged = await asUser(leo, { appId }).callToolText('hadron_record_content_validation', { ...args(), session: sessionId });
    expect(mcpCode(forged), forged).toBe('SESSION_NOT_BOUND');
    // An App principal (no user, no App key, no worker) reaches no write, so it is refused before any reporter is derived.
    const appMemoryId = (await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: 'cvm-org:app-mem', name: 'app-mem', class: 'app', appId },
    })).id;
    const appNode = ((await M.createNode({}, { input: { memoryId: appMemoryId, loc: 'doc', name: 'Doc', content: 'body' } }, { db, roles: [], userId: leo } as Context)) as { id: string }).id;
    const server = createTestableMcpServer(authOf({ appId, clientId: `agent:${agentId}` }), { sessionId: `cv-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    expect(mcpCode(await server.callToolText('hadron_record_content_validation', args({ nodeRef: appNode })))).toBe('FORBIDDEN');
    expect(await reports()).toHaveLength(0);
  });

  it('a malformed argument is refused by the schema before the resolver runs', async () => {
    const text = await asUser(leo).callToolText('hadron_record_content_validation', args({ outcome: 'MAYBE' }));
    expect(text).not.toMatch(/^Recorded/);
    expect(await reports()).toHaveLength(0);
  });
});

describe('#1332 run tool hadron_record_content_validation', () => {
  it('is a cost-1 run tool', () => {
    const { tools, unknown } = resolveRunTools(['hadron_record_content_validation']);
    expect(unknown).toEqual([]);
    expect(tools.find((t) => t.name === 'hadron_record_content_validation')?.cost).toBe(1);
  });

  it('records as this run whatever runId it sends: another run\'s id is a label, never an identity', async () => {
    const other = await mintRun(validationTask);
    const run = await mintRun(validationTask);
    const out = await runTool(run, args({ runId: other.id })) as Record<string, unknown>;
    expect(out).toMatchObject({ nodeId, replayed: false, outcome: 'PASS', authorCheck: 'CHECKED', state: 'PASS' });
    expect(await reports()).toMatchObject([{ reporterKind: 'RUN', reporterRunId: run.id, runId: other.id, reporterUserId: null }]);
    // The run named in runId cannot then replay that report: it is a different reporter.
    expect(await gqlCode(runTool(other, args({ runId: other.id })))).toBe('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    expect(await reports()).toHaveLength(1);
  });

  it('a run of the author task is refused through the tool; a non-string runId is BAD_USER_INPUT, not a fault', async () => {
    await stamp('TASK');
    expect(await gqlCode(runTool(await mintRun(authorTask), args()))).toBe('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    expect(await gqlCode(runTool(await mintRun(validationTask), args({ runId: 42 })))).toBe('BAD_USER_INPUT');
    expect(await reports()).toHaveLength(0);
  });

  it('§10 P2-1: the flow guards hold: a user-owned, an encrypted or a foreign-org memory is refused before anything is written', async () => {
    /** A guide node under a validation rule in the given memory, its revision fingerprint current. */
    const docIn = async (data: Record<string, unknown>) => {
      const mem = (await db.memory.create({ data: { id: generateId(), name: 'x', ...data } as never })).id;
      const configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: mem } })).id;
      await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', validationTaskId: validationTask, validationTaskRequired: true } });
      const id = (await db.node.create({ data: { id: generateId(), memoryId: mem, loc: 'doc', name: 'Doc', content: 'body', role: 'guide' } })).id;
      await db.$executeRaw`UPDATE nodes SET revision_content_hash = hadron_node_revision_state_hash(nodes) WHERE id = ${id}`;
      return id;
    };
    const otherOrg = (await db.organization.create({ data: { id: generateId(), name: 'cvm-other', urn: 'cvm-other' } })).id;
    await db.orgMember.create({ data: { organizationId: otherOrg, userId: leo, role: 'CONTRIBUTOR' } });
    const cases: Array<[string, string, RegExp]> = [
      ['user-owned', await docIn({ urn: 'cvm-leo:own', class: 'knowledge', ownerUserId: leo }), /Flow memory not found/],
      ['encrypted', await docIn({ urn: 'cvm-org:enc', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true }), /encrypted/],
      ['foreign org', await docIn({ urn: 'cvm-other:mem', organizationId: otherOrg, class: 'knowledge', visibility: 'ORGANIZATION' }), /Flow memory not found/],
    ];
    const run = await mintRun(validationTask);
    for (const [label, ref, refusal] of cases) {
      expect(await gqlCode(runTool(run, args({ nodeRef: ref }))), label).toMatch(refusal);
    }
    expect(await reports()).toHaveLength(0);
    // The same run still records in its own org's plain memory.
    expect(await gqlCode(runTool(run, args()))).toBe('NO_ERROR');
  });
});
