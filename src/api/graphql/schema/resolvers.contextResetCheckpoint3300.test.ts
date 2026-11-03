/** #3300: checkpoint pointers are reset state, exercised through the GraphQL wire. */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { ctx, M, NEW_PROC, PROC, setUpResetFixture, type ResetFixture } from '../../../test/contextResetFixture.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn(async () => {}) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
afterAll(() => server.stop());
let f: ResetFixture;
beforeEach(async () => { f = await setUpResetFixture(); });
const inputTypes = {
  claimContextReset: 'ClaimContextResetInput',
  registerContextResetRecovery: 'RegisterContextResetRecoveryInput',
  authorizeContextResetStop: 'AuthorizeContextResetStopInput',
  reportContextResetAgentStopped: 'ContextResetStepInput',
  reportContextResetRelaunched: 'ReportContextResetRelaunchedInput',
  reportContextResetRelaunchFailed: 'ReportContextResetRelaunchFailedInput',
} as const;
type Door = keyof typeof inputTypes;
type Reset = Awaited<ReturnType<ResetFixture['collectedReset']>>;
async function wire(query: string, variables: Record<string, unknown>, context = f.keyCtx()) {
  const response = await server.executeOperation({ query, variables }, { contextValue: context });
  if (response.body.kind !== 'single') throw new Error('unexpected incremental result');
  return JSON.parse(JSON.stringify(response.body.singleResult));
}
async function step(name: Door, input: Record<string, unknown>, context = f.keyCtx()) {
  return wire(`mutation($input:${inputTypes[name]}!){${name}(input:$input){reset{id phase epoch checkpointNode} refused replayed}}`, { input: { appRef: f.app.id, ...input } }, context);
}
async function accepted(name: Door, input: Record<string, unknown>) {
  const answer = await step(name, input);
  expect(answer.errors).toBeUndefined();
  return answer.data[name];
}
async function read(reset: Reset, context = f.keyCtx(), appRef = f.app.id) {
  return wire('query($app:String!,$id:ID!){contextReset(appRef:$app,resetId:$id){id phase checkpointNode}}', { app: appRef, id: reset.resetId }, context);
}
async function pointer(reset: Reset) {
  const answer = await read(reset);
  expect(answer.errors).toBeUndefined();
  return answer.data.contextReset.checkpointNode;
}
async function claimed() {
  const s = await f.collectedReset();
  await f.step('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC });
  return s;
}
const registration = (s: Reset, extra: Record<string, unknown> = {}) => ({
  resetId: s.resetId, epoch: 1, sessionId: f.session.id, taskId: s.taskId,
  checkpoint: { title: 'Recover', content: 'Synthetic recovery content' }, ...extra,
});
async function nodeUrn(id: string) {
  const node = await db.node.findUniqueOrThrow({ where: { id }, select: { loc: true, memory: { select: { urn: true } } } });
  return emitNodeUrnV2(node.memory.urn, node.loc);
}
async function registered() {
  const s = await claimed();
  const out = await f.step('registerContextResetRecovery', registration(s));
  const nodeId = out.reset.recoveryRef.checkpointNodeId as string;
  return { s, nodeId, urn: await nodeUrn(nodeId) };
}

it('writes and returns the canonical v2 pointer over GraphQL, stored in the registration transaction', async () => {
  const s = await claimed();
  const out = await accepted('registerContextResetRecovery', registration(s));
  const row = await db.contextReset.findUniqueOrThrow({ where: { id: s.resetId } });
  const ref = row.recoveryRef as { checkpointNodeId: string; checkpointNodeUrn: string };
  const expected = await nodeUrn(ref.checkpointNodeId);
  expect(expected).toMatch(/^hrn:node:/);
  expect(expected).not.toContain('::');
  expect(out.reset.checkpointNode).toBe(expected);
  expect(ref.checkpointNodeUrn).toBe(expected);
  expect(await pointer(s)).toBe(expected);
});

it.each(['id', 'noncanonical-urn'])('legacy input %s returns a canonical pointer, never echoes the caller', async form => {
  const s = await claimed();
  const node = await f.checkpoint();
  const expected = await nodeUrn(node.id);
  const memory = await db.memory.findUniqueOrThrow({ where: { id: f.kitMemory.id } });
  const loc = (await db.node.findUniqueOrThrow({ where: { id: node.id } })).loc;
  const input = form === 'id' ? node.id : `urn:node:${memory.urn.replace(':', '::')}::${loc}`;
  expect(input).not.toBe(expected);
  const out = await accepted('registerContextResetRecovery', registration(s, { checkpoint: null, checkpointNode: input }));
  expect(out.reset.checkpointNode).toBe(expected);
  expect((await db.contextReset.findUniqueOrThrow({ where: { id: s.resetId } })).recoveryRef).toMatchObject({ checkpointNodeUrn: expected });
});

it('answers the stored pointer through all seven doors and every registered replay phase', async () => {
  const s = await f.collectedReset();
  expect(await pointer(s)).toBeNull();
  const claim = await accepted('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC });
  expect(claim.reset.checkpointNode).toBeNull();
  const first = await accepted('registerContextResetRecovery', registration(s));
  const expected = first.reset.checkpointNode;
  expect(expected).toMatch(/^hrn:node:/);
  // A claim replay after registration also carries the registered state.
  expect((await accepted('claimContextReset', { resetId: s.resetId, epoch: 0, process: PROC })).reset.checkpointNode).toBe(expected);
  const replay = async () => {
    const out = await accepted('registerContextResetRecovery', registration(s, { checkpoint: { title: 'Ignored retry', content: 'different' } }));
    expect(out).toMatchObject({ replayed: true, reset: { checkpointNode: expected } });
    expect(await pointer(s)).toBe(expected);
  };
  await replay();
  expect((await accepted('authorizeContextResetStop', { resetId: s.resetId, epoch: 1, process: PROC })).reset.checkpointNode).toBe(expected);
  await replay();
  expect((await accepted('reportContextResetAgentStopped', { resetId: s.resetId, epoch: 1 })).reset.checkpointNode).toBe(expected);
  await replay();
  expect((await accepted('reportContextResetRelaunched', { resetId: s.resetId, epoch: 1, process: NEW_PROC })).reset.checkpointNode).toBe(expected);
  await replay();
  await M.reportHostOperation({}, { input: { appRef: f.app.id, id: s.operationId, outcome: 'SUCCEEDED' } }, f.keyCtx());
  expect(await pointer(s)).toBe(expected); // ended done
});

it.each(['before-registration', 'after-registration'])('ended failure %s retains only a registered pointer', async when => {
  const s = await claimed();
  let expected: string | null = null;
  if (when === 'after-registration') expected = (await accepted('registerContextResetRecovery', registration(s))).reset.checkpointNode;
  const out = await accepted('reportContextResetRelaunchFailed', { resetId: s.resetId, epoch: 1, reason: 'RELAUNCH_UNVERIFIED' });
  expect(out).toMatchObject({ refused: 'RELAUNCH_UNVERIFIED', reset: { checkpointNode: expected, phase: 'failed' } });
  expect(await pointer(s)).toBe(expected);
});

it.each(['hard-purge', 'soft-delete', 'move'])('new registration keeps its original pointer after %s', async change => {
  const { s, nodeId, urn } = await registered();
  if (change === 'hard-purge') await db.node.delete({ where: { id: nodeId } });
  if (change === 'soft-delete') await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
  if (change === 'move') {
    const other = await db.memory.create({ data: { organizationId: f.orgId, appId: f.app.id, class: 'app', urn: `other-${generateId()}.example:kit`, name: 'Other memory' } });
    await db.node.update({ where: { id: nodeId }, data: { memoryId: other.id, loc: 'elsewhere:checkpoint' } });
    await db.worker.update({ where: { id: f.kit.id }, data: { memoryId: other.id } });
  }
  const out = await accepted('registerContextResetRecovery', registration(s, { checkpoint: { title: 'Do not recreate', content: 'different' } }));
  expect(out.replayed).toBe(true);
  expect(out.reset.checkpointNode).toBe(urn);
  expect(await pointer(s)).toBe(urn);
});

it.each(['live', 'soft-deleted', 'purged'])('old id-only row resolves a %s node, without writing a backfill', async state => {
  const { s, nodeId, urn } = await registered();
  const row = await db.contextReset.findUniqueOrThrow({ where: { id: s.resetId } });
  const { checkpointNodeUrn: _old, ...legacy } = row.recoveryRef as Record<string, string>;
  await db.contextReset.update({ where: { id: s.resetId }, data: { recoveryRef: legacy } });
  if (state === 'soft-deleted') await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
  if (state === 'purged') await db.node.delete({ where: { id: nodeId } });
  expect(await pointer(s)).toBe(state === 'purged' ? null : urn);
  expect((await db.contextReset.findUniqueOrThrow({ where: { id: s.resetId } })).recoveryRef).toEqual(legacy);
});

for (const door of ['contextReset', ...Object.keys(inputTypes)] as const) {
  it(`${door}: a different host still cannot read the pointer`, async () => {
    const { s } = await registered();
    const other = f.keyCtx(await f.hostKey('other-host'));
    const input = door === 'claimContextReset' ? { resetId: s.resetId, epoch: 0, process: PROC }
      : door === 'registerContextResetRecovery' ? registration(s)
      : door === 'authorizeContextResetStop' ? { resetId: s.resetId, epoch: 1, process: PROC }
      : door === 'reportContextResetRelaunched' ? { resetId: s.resetId, epoch: 1, process: NEW_PROC }
      : door === 'reportContextResetRelaunchFailed' ? { resetId: s.resetId, epoch: 1, reason: 'RELAUNCH_UNVERIFIED' }
      : { resetId: s.resetId, epoch: 1 };
    const answer = door === 'contextReset' ? await read(s, other) : await step(door as Door, input, other);
    expect(answer.data).toBeNull();
    expect(answer.errors?.[0].extensions.code).toBe('CONTEXT_RESET_NOT_FOUND');
  });
}

it.each(['person', 'plain-key', 'session-bound', 'revoked', 'other-app', 'not-collected'])('query keeps the existing %s host gate', async kind => {
  const { s } = await registered();
  let context = f.keyCtx();
  let appRef = f.app.id;
  let expected = 'APP_KEY_SCOPE_REQUIRED';
  if (kind === 'person') { context = ctx(f.manager.id); expected = 'HOST_KEY_REQUIRED'; }
  if (kind === 'plain-key') {
    const key = await db.appKey.create({ data: { appId: f.app.id, keyHash: generateId(), keyPreview: 'synthetic' } });
    context = f.keyCtx(key);
  }
  if (kind === 'session-bound') { context = { ...context, sessionId: f.session.id }; expected = 'APP_KEY_SESSION_BOUND'; }
  if (kind === 'revoked') await M.revokeAppKeyScope({}, { id: f.orca1.id, scope: 'host:operate' }, ctx(f.manager.id));
  if (kind === 'other-app') { appRef = generateId(); expected = 'CONTEXT_RESET_NOT_FOUND'; }
  if (kind === 'not-collected') {
    // A second fixture creates an issued reset with no collected operation.
    f = await setUpResetFixture();
    const task = await f.startedTask(); await f.finish(task.id);
    const reset = await db.contextReset.findUniqueOrThrow({ where: { taskId: task.id } });
    const answer = await read({ ...s, resetId: reset.id }, f.keyCtx());
    expect(answer.data).toBeNull();
    expect(answer.errors?.[0].extensions.code).toBe('HOST_OPERATION_NOT_COLLECTED');
    return;
  }
  const answer = await read(s, context, appRef);
  expect(answer.data).toBeNull();
  expect(answer.errors?.[0].extensions.code).toBe(expected);
});
