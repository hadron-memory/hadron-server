/**
 * #2047 (S10, cor:agt:040:03/:10) — the RUN surface: a run that names an Agent is refused at launch, with the bind's typed
 * refusal, when its boot prompt cannot be served; an approved one is recorded with the run and prefixed to the run's system
 * prompt with the recorded variables; the run finishes under that revision; derived blocks go to the run's own log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { computeApprovalHash } from '../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../lib/bootCompile/provenance.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const attention = vi.hoisted(() => ({ text: '' }));
vi.mock('../lib/channelReadState.js', async (orig) => ({
  ...(await orig<typeof import('../lib/channelReadState.js')>()),
  renderAttentionSection: vi.fn(async () => ({ text: attention.text, captured: [] })),
}));

const aiConfigFault = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../lib/aiConfig.js', async (orig) => {
  const real = await orig<typeof import('../lib/aiConfig.js')>();
  return { ...real, resolveAiConfigWithFallback: vi.fn(async (...a: Parameters<typeof real.resolveAiConfigWithFallback>) => { if (aiConfigFault.error) throw aiConfigFault.error; return real.resolveAiConfigWithFallback(...a); }) };
});

import { executeAppRun, mintAppRun, type RunExecutionDeps } from './appRuns.js';

let orgId: string, appId: string, userId: string, agentId: string, memoryId: string;

const deps = (llm = vi.fn(async (_c: unknown, _r: { system?: string; prompt: string }) => ({ text: 'out', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' }))) => ({
  llm,
  deps: {
    verifyAutomation: vi.fn(async () => undefined),
    assemble: vi.fn(async () => '# Task'),
    loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false })),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm,
    llmObject: vi.fn(), llmTools: vi.fn(),
    writeOutput: vi.fn(async () => 'node-id-1'),
    selectNext: vi.fn(async () => null),
  } as unknown as RunExecutionDeps,
});
const mint = (extra: Record<string, unknown> = {}) =>
  mintAppRun(db, { organizationId: orgId, appId, triggerKind: 'MANUAL', entryNodeUrn: 'run-org::runmem::tasks:briefing', publish: false, ...extra } as never);
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };

const provenance = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});
async function compiledPointer(content: string) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: 'boot:compiled', name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: provenance() as never, occurrenceCount: 1 } });
  await db.node.update({ where: { id: node.id }, data: { approvedRevNo: 1, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: 'compiled', abstract: null, content }) } });
  await db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: node.id, bootPromptUrn: `u:${node.id}` } });
  return node.id as string;
}

beforeEach(async () => {
  vi.clearAllMocks();
  attention.text = '';
  aiConfigFault.error = null;
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'run-org', urn: 'run-org' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'run-app', urn: 'run-org::run-app' } })).id;
  userId = (await db.user.create({ data: { githubId: 92047200, githubUsername: 'run-user', roles: ['READER'] } })).id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'run-org:sys', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Runner', urn: 'run-org:runner', organizationId: orgId, systemMemoryId: memoryId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
});

describe('#2047 run', () => {
  it('a run that names no Agent is refused BOOT_PROMPT_NOT_SET and no run is created (R74)', async () => {
    const runs = await db.appRun.count();
    expect(await code(mint({ userId }))).toBe('BOOT_PROMPT_NOT_SET');
    expect(await db.appRun.count()).toBe(runs);
    expect(await db.servedPrompt.count()).toBe(0);
  });

  it('a run minted inside the caller\'s transaction (webfetch ingress) records with the run and rolls back with it', async () => {
    const node = await compiledPointer('v1');
    const run = await db.$transaction(async (tx) => mintAppRun(tx as never, { organizationId: orgId, appId, agentId, userId, triggerKind: 'MANUAL', entryNodeUrn: 'run-org::runmem::tasks:briefing', publish: false } as never));
    expect(await db.servedPrompt.count({ where: { runId: run.id, compiledNodeId: node } })).toBe(1);
    const runs = await db.appRun.count();
    await expect(db.$transaction(async (tx) => {
      await mintAppRun(tx as never, { organizationId: orgId, appId, agentId, userId, triggerKind: 'MANUAL', entryNodeUrn: 'run-org::runmem::tasks:briefing', publish: false } as never);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.appRun.count()).toBe(runs);
    expect(await db.servedPrompt.count()).toBe(1);
  });

  it('no pointer: the launch is refused with the typed refusal and no run is created', async () => {
    const runs = await db.appRun.count();
    expect(await code(mint({ userId, agentId }))).toBe('BOOT_PROMPT_NOT_SET');
    expect(await db.appRun.count()).toBe(runs);
  });

  it('#2047 PR-C: the revision is selected inside the launch transaction, so one approved after the preflight is the one recorded', async () => {
    const node = await compiledPointer('v1');
    const racing = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return async (...args: unknown[]) => {
          // Between the refusal preflight and the transaction: revision 2 is compiled and approved.
          const n = await db.node.findUniqueOrThrow({ where: { id: node } });
          await db.nodeRevision.create({ data: { nodeId: node, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
          await withCompileWrite(() => db.node.update({ where: { id: node }, data: { content: 'v2', revSeq: 2, contentRevSeq: 2 } }));
          await db.compiledPromptRevision.create({ data: { compiledNodeId: node, compiledRevNo: 2, contentHash: sha256Hex('v2'), targetKind: 'AGENT', targetAgentId: agentId, provenance: provenance() as never, occurrenceCount: 1 } });
          await db.node.update({ where: { id: node }, data: { approvedRevNo: 2, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: 'compiled', abstract: null, content: 'v2' }) } });
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as typeof db;
    const run = await mintAppRun(racing, { organizationId: orgId, appId, agentId, userId, triggerKind: 'MANUAL', entryNodeUrn: 'run-org::runmem::tasks:briefing', publish: false } as never);
    expect((await db.servedPrompt.findFirstOrThrow({ where: { runId: run.id } })).servedRevSeq).toBe(2);
  });

  it('records the serve with the run and prefixes the compiled text, variables filled, to the system prompt', async () => {
    const node = await compiledPointer('You are {{agent.name}}.');
    const run = await mint({ userId, agentId });
    const rec = await db.servedPrompt.findFirstOrThrow({ where: { runId: run.id } });
    expect(rec).toMatchObject({ kind: 'RUN', appId, agentId, pointerLevel: 'AGENT', compiledNodeId: node, servedRevSeq: 1 });
    expect(rec.variables).toMatchObject({ 'agent.name': 'Runner' });
    const { deps: d, llm } = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    const system = llm.mock.calls[0]![1].system!;
    expect(system.startsWith('You are Runner.\n\n')).toBe(true);
  });

  it('a run whose recorded revision was deleted fails with the typed code, not newer text', async () => {
    const node = await compiledPointer('v1');
    const run = await mint({ userId, agentId });
    await db.node.update({ where: { id: node }, data: { deletedAt: new Date() } });
    const { deps: d, llm } = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    expect(llm).not.toHaveBeenCalled();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'BOOT_PROMPT_RECORDED_REVISION_DELETED' });
  });

  it('derived blocks go to the run log, not the boot record, and an unchanged or absent block adds no entry', async () => {
    await compiledPointer('x');
    const none = await mint({ userId, agentId });
    await executeAppRun(db, none.id, deps().deps);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: none.id } })).derivedLog).toBeNull();
    attention.text = 'ATTENTION BLOCK';
    const some = await mint({ userId, agentId });
    await executeAppRun(db, some.id, deps().deps);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: some.id } })).derivedLog).toEqual([{ hop: 0, blocks: ['ATTENTION BLOCK'] }]);
    const rec = await db.servedPrompt.findFirstOrThrow({ where: { runId: some.id } });
    expect(JSON.stringify(rec)).not.toContain('ATTENTION BLOCK');
  });

  it('session.llmModel is the model the run resolves: recorded at the mint and substituted into the served text', async () => {
    await db.aiServiceConfig.create({ data: { id: generateId(), name: 'default', organizationId: orgId, provider: 'anthropic', model: 'run-model-7' } });
    await compiledPointer('Model={{session.llmModel}}.');
    const run = await mint({ userId, agentId });
    const rec = await db.servedPrompt.findFirstOrThrow({ where: { runId: run.id } });
    expect(rec.variables).toMatchObject({ 'session.llmModel': 'run-model-7' });
    const { deps: d, llm } = deps();
    await executeAppRun(db, run.id, d);
    expect(llm.mock.calls[0]![1].system!.startsWith('Model=run-model-7.\n\n')).toBe(true);
  });

  it('the mint resolves the model through the trigger override (__aiConfigName), as resolveConfig does', async () => {
    await db.aiServiceConfig.create({ data: { id: generateId(), name: 'default', organizationId: orgId, provider: 'anthropic', model: 'default-model' } });
    await db.aiServiceConfig.create({ data: { id: generateId(), name: 'alt', organizationId: orgId, provider: 'anthropic', model: 'alt-model' } });
    await compiledPointer('Model={{session.llmModel}}.');
    const run = await mint({ userId, agentId, eventData: { __aiConfigName: 'alt' } });
    expect((await db.servedPrompt.findFirstOrThrow({ where: { runId: run.id } })).variables).toMatchObject({ 'session.llmModel': 'alt-model' });
  });

  it('with no AI config the mint records an empty model (the run itself fails NO_AI_CONFIG); any other resolve failure is not swallowed', async () => {
    await compiledPointer('Model={{session.llmModel}}.');
    const run = await mint({ userId, agentId });
    expect((await db.servedPrompt.findFirstOrThrow({ where: { runId: run.id } })).variables).toMatchObject({ 'session.llmModel': '' });
    aiConfigFault.error = new Error('registry down');
    expect(await code(mint({ userId, agentId }))).toBe('registry down');
  });
});

// #1772 step 3 (review P2): a run replays its RECORDED revision and variables, so a legacy token in that revision still binds from
// the recorded values: a retained record is reconstructed as it was served, whatever the live binding does today.
describe('#1772 step 3: a recorded run still binds legacy {{name}} / {{role}} from its recorded values', () => {
  it('binds {{name}} and {{role}} from the values recorded with the run', async () => {
    await db.agent.update({ where: { id: agentId }, data: { personaRole: 'runner-role' } });
    await compiledPointer('You are {{name}}, the {{role}}.');
    const run = await mint({ userId, agentId });
    const { deps: d, llm } = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    const system = llm.mock.calls[0]![1].system!;
    expect(system.startsWith('You are Runner, the runner-role.\n\n')).toBe(true);
    expect(system).not.toMatch(/\{\{(name|role)\}\}/);
  });
});
