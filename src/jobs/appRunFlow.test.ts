/**
 * plan-multi-node §10 — the 3-node flow fixture, end to end through the
 * PRODUCTION deps (real runTask assembly, real edge selection over real
 * Edge rows, real writeNodeCore output) with only the LLM + AI-config
 * seams mocked.
 *
 *   flow:classify  (extractionSpec: intent, confidence)
 *     ── next.1.high  [message.data.confidence > 0.8] ──▶ flow:act
 *     ── next.2.low   [no condition — fall-through]   ──▶ flow:defer
 *     ── documents    (reference edge — must NEVER route, D-MN-4)
 *
 * Pins: envelope accumulation on AppRun.data (bare fields), the
 * curNodeUrn trail, COMPLETED status, per-hop token accounting, the
 * documents-edge regression, and next*-edge exclusion from runTask's
 * reference inlining.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbRunConsentPrincipal } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';

vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps, runContext } from './appRunDeps.js';
import { resolveRunTools, hadronCreateNode, hadronUpdateNode, hadronReadNode } from '../lib/runner/tools/index.js';
import { ToolDeniedError } from '../lib/llm/index.js';
import type { AppRun } from '../generated/prisma/index.js';
import { splitNodeUrn } from '../lib/urn.js';

const ORG_URN = 'flow-int-org';
const MEM_URN = `${ORG_URN}:flowmem`;
const ENTRY = `${ORG_URN}::flowmem::flow:classify`;
// #697 Stage 2: the runner now EMITS the v2 node URN for `curNodeUrn`
// (`hrn:node:<root>:<mem>:<loc>`), so the checkpoint assertion expects that form.
const ACT = `hrn:node:${ORG_URN}:flowmem:flow:act`;
const DEFER = `${ORG_URN}::flowmem::flow:defer`;

let orgId: string;
let appId: string;
let memoryId: string;
let agentId: string;

async function makeNode(loc: string, extra: Record<string, unknown> = {}): Promise<string> {
  const node = await db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc,
      name: loc.split(':').pop()!,
      tags: [],
      ...extra,
    } as never,
  });
  return node.id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: ORG_URN, urn: ORG_URN },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'flow-app', urn: `${ORG_URN}::flow-app` },
  });
  appId = app.id;
  // Headless runs write an explicitly granted knowledge memory, not team space.
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: 'flowmem',
      urn: MEM_URN, class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  memoryId = memory.id;
  // The run principal's access rides the App's installed Agent's memory map
  // (getAppMemoryAccess): Agent + AppAgent install + read-write AgentMemoryItem.
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: 'flow-agent', urn: `${ORG_URN}:flow-agent` },
  });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  agentId = agent.id;
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.'); // #2712: a run is served its Agent's prompt
  await db.agentMemoryItem.create({
    data: { agentId: agent.id, memoryId, role: 'read-write' },
  });

  const classify = await makeNode('flow:classify', {
    content: 'Classify the report about {{topic}}. Score your confidence.',
    data: {
      extractionSpec: [
        { field: 'intent', description: 'what the user wants' },
        { field: 'confidence', shape: 'number' },
      ],
    },
  });
  const act = await makeNode('flow:act', {
    content: 'Act on the {{intent}} report about {{topic}} now.',
  });
  const defer = await makeNode('flow:defer', {
    content: 'Save the {{topic}} report for human review.',
  });
  const reference = await makeNode('reference:playbook', {
    content: 'REFERENCE PLAYBOOK CONTENT',
  });

  await db.edge.createMany({
    data: [
      {
        id: generateId(), memoryId, sourceId: classify, targetId: act,
        name: 'next.1.high', loc: deriveEdgeLoc('flow:classify', 'next.1.high', 'flow:act'),
        condition: { '>': [{ var: 'message.data.confidence' }, 0.8] } as never,
      },
      {
        id: generateId(), memoryId, sourceId: classify, targetId: defer,
        name: 'next.2.low', loc: deriveEdgeLoc('flow:classify', 'next.2.low', 'flow:defer'),
      },
      // Reference edge: has content, no condition — must inline into the
      // prompt as a reference but NEVER route (D-MN-4).
      {
        id: generateId(), memoryId, sourceId: classify, targetId: reference,
        name: 'documents', loc: deriveEdgeLoc('flow:classify', 'documents', 'reference:playbook'),
      },
    ],
  });
});

function flowDeps(confidence: number): {
  deps: RunExecutionDeps;
  llm: ReturnType<typeof vi.fn>;
  llmObject: ReturnType<typeof vi.fn>;
} {
  const llm = vi.fn(async () => ({
    text: 'done',
    tokensIn: 100,
    tokensOut: 50,
    provider: 'anthropic',
    model: 'test',
  }));
  const llmObject = vi.fn(async () => ({
    object: { intent: 'alert', confidence },
    tokensIn: 80,
    tokensOut: 20,
    provider: 'anthropic',
    model: 'test',
  }));
  const deps: RunExecutionDeps = {
    ...makeProdRunDeps(db),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm,
    llmObject,
    onTerminal: undefined, // webhook callback dispatch is out of scope here
  };
  return { deps, llm, llmObject };
}

async function mintFlow() {
  return mintAppRun(db, {
    organizationId: orgId,
    appId,
    agentId,
    triggerKind: 'MANUAL',
    entryNodeUrn: ENTRY,
    eventData: { topic: 'ticks' },
    consentPrincipal: await createDbRunConsentPrincipal(db, orgId, appId),
  });
}

describe('3-node flow through production deps (§10)', () => {
  it('high confidence routes to flow:act; envelope + trail + output land', async () => {
    const run = await mintFlow();
    const { deps, llm, llmObject } = flowDeps(0.92);
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');

    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('COMPLETED');
    // Envelope: bare extracted fields (D-MN-1), persisted on the run row.
    expect(after.data).toEqual({ intent: 'alert', confidence: 0.92 });
    // Two hops: classify (extraction) + act (text).
    expect(llmObject).toHaveBeenCalledTimes(1);
    expect(llm).toHaveBeenCalledTimes(1);
    // Hop 1's prompt was assembled from the REAL classify node + view…
    expect(llmObject.mock.calls[0][1].prompt).toContain('Classify the report about ticks');
    // …with the documents-edge reference inlined…
    expect(llmObject.mock.calls[0][1].prompt).toContain('REFERENCE PLAYBOOK CONTENT');
    // …but NOT the next-step prompts (routing edges are rails, not references).
    expect(llmObject.mock.calls[0][1].prompt).not.toContain('Act on the');
    expect(llmObject.mock.calls[0][1].prompt).not.toContain('Save the');
    // Hop 2's template saw the merged view: trigger field + extracted field.
    expect(llm.mock.calls[0][1].prompt).toContain('Act on the alert report about ticks now.');
    // Terminal default write: a run-record node beside flow:act.
    const record = await db.node.findUnique({
      where: { loc_memoryId: { loc: `runs:${run.id}`, memoryId } },
    });
    expect(record).not.toBeNull();
    expect(record!.content).toBe('done');
    expect(after.curNodeUrn).toBe(record!.id); // trail ends at the written record
    // Per-hop usage: 2 events, 250 tokens total decremented.
    expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(2);
    expect(after.budgetTokens).toBe((run.budgetTokens ?? 0) - 250);
  });

  it('low confidence falls through to flow:defer (the real JSONLogic branch)', async () => {
    const run = await mintFlow();
    const { deps, llm } = flowDeps(0.4);
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    expect(llm.mock.calls[0][1].prompt).toContain('Save the ticks report for human review.');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.data).toEqual({ intent: 'alert', confidence: 0.4 });
    const record = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: `runs:${run.id}`, memoryId } },
    });
    expect(after.curNodeUrn).toBe(record.id);
  });

  it('cancelling after hop 1 halts the flow with the checkpoint intact (§10 regression b)', async () => {
    const run = await mintFlow();
    const { deps, llm } = flowDeps(0.92);
    // The kill switch flips while hop 2's LLM call is in flight.
    llm.mockImplementationOnce(async () => {
      await db.appRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } });
      return { text: 'late', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' };
    });
    expect(await executeAppRun(db, run.id, deps)).toBe('skipped');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.curNodeUrn).toBe(ACT); // hop-1 checkpoint: position preserved
    expect(after.data).toEqual({ intent: 'alert', confidence: 0.92 }); // envelope preserved
    // No terminal record was written.
    expect(
      await db.node.findUnique({ where: { loc_memoryId: { loc: `runs:${run.id}`, memoryId } } }),
    ).toBeNull();
  });

  it('data.output.writeTo creates a MISSING target node (first live run regression, 2026-07-07)', async () => {
    // The alert-style shape: terminal node writes to a rolling node that
    // does not exist yet — the create path must derive a name.
    await db.node.update({
      where: { loc_memoryId: { loc: 'flow:act', memoryId } },
      data: { data: { output: { writeTo: `${ORG_URN}::flowmem::flow:alerts`, mode: 'append' } } as never },
    });
    const run = await mintFlow();
    const { deps } = flowDeps(0.92);
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    const created = await db.node.findUnique({
      where: { loc_memoryId: { loc: 'flow:alerts', memoryId } },
    });
    expect(created).not.toBeNull();
    expect(created!.name).toBe('alerts'); // derived from the target loc's last segment
    expect(created!.content).toBe('done');

    // Second run APPENDS and preserves the existing name.
    const run2 = await mintFlow();
    expect(await executeAppRun(db, run2.id, flowDeps(0.92).deps)).toBe('completed');
    const appended = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'flow:alerts', memoryId } },
    });
    expect(appended.name).toBe('alerts');
    expect(appended.content).toContain('---'); // append separator
  });

  it('an encrypted node anywhere in the setup graph prevents execution (#1719 R5b)', async () => {
    // The launch gate only checks the entry — the guard must also fire on
    // routed hops, where the run has no session key.
    const vault = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'vault',
        urn: `${ORG_URN}:vault`, class: 'app', appId, isEncrypted: true,
      },
    });
    const secret = await db.node.create({
      data: {
        id: generateId(), memoryId: vault.id, loc: 'flow:secret', name: 'secret',
        content: 'classified', tags: [],
      },
    });
    const deferNode = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'flow:defer', memoryId } },
      select: { id: true },
    });
    await db.edge.create({
      data: {
        id: generateId(), memoryId, sourceId: deferNode.id, targetId: secret.id,
        name: 'next', loc: deriveEdgeLoc('flow:defer', 'next', 'flow:secret'),
      },
    });

    const run = await mintFlow();
    const { deps } = flowDeps(0.4); // low confidence → defer → (routed) vault
    expect(await executeAppRun(db, run.id, deps)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('AUTOMATION_UNADOPTED');
    expect((after.failure as { message?: string }).message).toContain('re-adopt');
    expect(after.curNodeUrn).toBeNull(); // refused before even the first hop
  });

  it('an extractionSpec writing into __-plumbing fields fails the run loudly (PR-532 Copilot)', async () => {
    await db.node.update({
      where: { loc_memoryId: { loc: 'flow:classify', memoryId } },
      data: { data: { extractionSpec: [{ field: '__aiConfigName' }] } as never },
    });
    const run = await mintFlow();
    const { deps } = flowDeps(0.9);
    expect(await executeAppRun(db, run.id, deps)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('NODE_LOAD_FAILED');
    expect((after.failure as { message?: string }).message).toContain('__aiConfigName');
  });

  it('a tools flow CREATES a real node under the run principal (plan-tools phases 2+3, §7 fixture)', async () => {
    await db.node.update({
      where: { loc_memoryId: { loc: 'flow:act', memoryId } },
      data: { data: { tools: ['hadron_create_node'] } as never },
    });
    const run = await mintFlow();
    const taskUrn = `${ORG_URN}::flowmem::tasks:investigate-outage`;
    const { deps } = flowDeps(0.92);
    // Simulate the LLM's tool decision; everything below the decision is REAL:
    // registry resolution, the activation gate, the handler, writeNodeCore.
    deps.llmTools = async (r, _resolved, _req, toolNames, opts) => {
      const { tools } = resolveRunTools(toolNames);
      const create = tools.find((t) => t.name === 'hadron_create_node')!;
      if (!(await opts.onToolCall(create.policyAction ?? `tool.${create.name}`, create.cost))) throw new ToolDeniedError(create.name);
      const started = Date.now();
      await create.execute(
        { log: opts.log, db, run: r, principal: runContext(db, r) },
        // #2987 (V13): the tool defaults nodeType to 'record', and a record outside a Channel refuses an explicit seq — name an ordinary type to keep the seq-parity assertion.
        { urn: taskUrn, name: 'Investigate outage', content: 'Check MCP endpoint logs.', nodeType: 'info', seq: 3, tags: ['urgent'] },
      );
      opts.log('task node created');
      return {
        text: 'created the task node', tokensIn: 50, tokensOut: 20, provider: 'anthropic', model: 'test',
        toolCalls: [{ name: 'hadron_create_node', ok: true, ms: Date.now() - started }],
      };
    };
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    const created = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'tasks:investigate-outage', memoryId } },
    });
    expect(created.name).toBe('Investigate outage');
    expect(created.seq).toBe(3); // full arg parity — seq lands (Holger review)
    expect(created.tags).toEqual(['urgent']);
    expect(created.createdBy).toBe(`run:${run.id}`); // the run principal signed it
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    const trail = after.hops as Array<Record<string, unknown>>;
    expect(trail[1].toolCalls).toMatchObject([{ name: 'hadron_create_node', ok: true }]);
    expect(trail[1].logs).toEqual(['task node created']);
  });

  it('the tool loop is told which flow node the hop executes (#2485: node-scoped tool reach)', async () => {
    await db.node.update({
      where: { loc_memoryId: { loc: 'flow:act', memoryId } },
      data: { data: { tools: ['hadron_log'] } as never },
    });
    const run = await mintFlow();
    const { deps } = flowDeps(0.92);
    const seen: Array<string | undefined> = [];
    deps.llmTools = async (_r, _resolved, _req, _toolNames, opts) => {
      seen.push(opts.nodeUrn);
      return { text: 'ok', tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test', toolCalls: [] };
    };
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    expect(splitNodeUrn(seen[0]!).loc).toBe('flow:act');
  });

  it('a policy chain lacking tool.hadron_create_node halts the tool call BEFORE the node exists (§7 fixture)', async () => {
    await db.node.update({
      where: { loc_memoryId: { loc: 'flow:act', memoryId } },
      data: { data: { tools: ['hadron_create_node'] } as never },
    });
    // App layer allows everything EXCEPT the tool.
    await db.app.update({
      where: { id: appId },
      data: { policy: { allow: ['run.execute', 'llm.invoke', 'memory.read', 'memory.write'] } },
    });
    const run = await mintFlow();
    const taskUrn = `${ORG_URN}::flowmem::tasks:should-not-exist`;
    const { deps } = flowDeps(0.92);
    deps.llmTools = async (r, _resolved, _req, toolNames, opts) => {
      const { tools } = resolveRunTools(toolNames);
      const create = tools.find((t) => t.name === 'hadron_create_node')!;
      if (!(await opts.onToolCall(create.policyAction ?? `tool.${create.name}`, create.cost))) throw new ToolDeniedError(create.name);
      await create.execute({ log: opts.log, db, run: r, principal: runContext(db, r) }, { urn: taskUrn, name: 'x' });
      return { text: 'x', tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test', toolCalls: [] };
    };
    expect(await executeAppRun(db, run.id, deps)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('ACTIVATION_DENIED');
    expect(
      await db.node.findUnique({ where: { loc_memoryId: { loc: 'tasks:should-not-exist', memoryId } } }),
    ).toBeNull(); // denied BEFORE the side effect
  });

  it('loadNodeSpec fails loud on unknown tools and on tools×extraction (D-TL-5/-6)', async () => {
    await db.node.update({
      where: { loc_memoryId: { loc: 'flow:classify', memoryId } },
      data: { data: { tools: ['hadron_teleport'] } as never },
    });
    const r1 = await mintFlow();
    expect(await executeAppRun(db, r1.id, flowDeps(0.9).deps)).toBe('failed');
    const f1 = await db.appRun.findUniqueOrThrow({ where: { id: r1.id } });
    expect((f1.failure as { code?: string }).code).toBe('NODE_LOAD_FAILED');
    expect((f1.failure as { message?: string }).message).toContain('hadron_teleport');

    await db.node.update({
      where: { loc_memoryId: { loc: 'flow:classify', memoryId } },
      data: {
        data: {
          tools: ['hadron_log'],
          extractionSpec: [{ field: 'confidence', shape: 'number' }],
        } as never,
      },
    });
    const r2 = await mintFlow();
    expect(await executeAppRun(db, r2.id, flowDeps(0.9).deps)).toBe('failed');
    const f2 = await db.appRun.findUniqueOrThrow({ where: { id: r2.id } });
    expect((f2.failure as { message?: string }).message).toContain('D-TL-5');
  });

  it('node-tool handlers: duplicate-create rejected, update merges data shallowly, class gates hold (phase 3)', async () => {
    const run = await mintFlow();
    const r = (await db.appRun.findUniqueOrThrow({ where: { id: run.id } })) as AppRun;
    const toolCtx = { log: vi.fn(), db, run: r, principal: runContext(db, r) };
    const urn = `${ORG_URN}::flowmem::notes:standup`;

    await hadronCreateNode.execute(toolCtx, {
      urn, name: 'Standup note', content: 'first', data: { a: 1, b: 2 }, nodeType: 'info', seq: 7, // #2987: record + seq is refused outside a Channel
    });
    // Create on an occupied loc must point authors at update, not clobber.
    await expect(hadronCreateNode.execute(toolCtx, { urn, name: 'again' })).rejects.toThrow(/already exists/);

    // Shallow data merge: patch wins, unmentioned keys survive, name preserved.
    await hadronUpdateNode.execute(toolCtx, { urn, content: 'second', data: { b: 9 } });
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'notes:standup', memoryId } },
    });
    expect(node.name).toBe('Standup note');
    expect(node.content).toBe('second');
    expect(node.data).toEqual({ a: 1, b: 9 });
    expect(node.seq).toBe(7);

    // Read round-trips under the principal.
    const read = (await hadronReadNode.execute(toolCtx, { urn })) as { content: string };
    expect(read.content).toBe('second');

    // Class gates (D-2026-07-04-C): the run has NO on-behalf-of user, so a
    // personal-class memory is untouchable even inside the same org.
    const owner = await db.user.create({
      data: { githubId: 7777, githubUsername: 'flow-owner', roles: ['READER'] },
    });
    await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'diary',
        urn: `${ORG_URN}:diary`, class: 'personal', userId: owner.id,
      },
    });
    await expect(
      hadronCreateNode.execute(toolCtx, { urn: `${ORG_URN}::diary::notes:x`, name: 'x' }),
    ).rejects.toThrow();

    // Encrypted memories are denied on every tool touch, read included.
    await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'vault2',
        urn: `${ORG_URN}:vault2`, class: 'app', appId, isEncrypted: true,
      },
    });
    await expect(
      hadronReadNode.execute(toolCtx, { urn: `${ORG_URN}::vault2::notes:x` }),
    ).rejects.toThrow(/encrypted/);
  });

  it('a defer-branch flow can still route into another memory later (URN shape sanity)', async () => {
    // Guards composeNodeUrn round-tripping: the checkpointed target URN must
    // be walkable by the next hop's loadFlowNode.
    const run = await mintFlow();
    const { deps } = flowDeps(0.4);
    await executeAppRun(db, run.id, deps);
    // If the URN hadn't round-tripped, the run would have FAILED at hop 2
    // with NODE_LOAD_FAILED — COMPLETED is the assertion.
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('COMPLETED');
    expect(DEFER).toBe(`${ORG_URN}::flowmem::flow:defer`); // fixture shape pin
  });
});

/**
 * #832 — "tokens spent vs budget" on the run audit surface.
 *
 * The two derivations a client could attempt are both wrong, which is the
 * whole reason these are stored counters:
 *   - summing `hops[].tokensSpent` misses hops that FAILED mid-execution;
 *   - `initial - remaining` is clamped, because the budget decrement is
 *     `Math.min(spent, budget)` so the remainder never goes negative.
 */
describe('AppRun spend counters (#832)', () => {
  it('mint records the initial budgets alongside the live remainders', async () => {
    const run = await mintFlow();
    const row = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.budgetTokensInitial).toBe(row.budgetTokens);
    expect(row.budgetActionsInitial).toBe(row.budgetActions);
    expect(row.budgetTokensInitial).toBeGreaterThan(0);
    expect(row.tokensSpent).toBe(0);
    expect(row.actionsSpent).toBe(0);
  });

  it('tokensSpent accumulates across hops and matches initial - remaining', async () => {
    const run = await mintFlow();
    const { deps } = flowDeps(0.92);
    expect(await executeAppRun(db, run.id, deps)).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    // Two hops: llmObject (80+20) then llm (100+50).
    expect(after.tokensSpent).toBe(250);
    // In the normal (non-overage) case the clamped derivation agrees — this
    // pins that the counter isn't double-counting.
    expect(after.budgetTokensInitial! - after.budgetTokens!).toBe(after.tokensSpent);
  });

  it('tokensSpent stays TRUTHFUL in overage, where initial - remaining cannot', async () => {
    const run = await mintFlow();
    // A run MINTED with a budget smaller than one hop's cost — set both the
    // remainder and the initial so the derivation under test is the real one a
    // client would compute, not an artefact of the fixture. The decrement
    // clamps at the remainder (budgetTokens floors at 0), but the counter must
    // record what was actually spent at the provider.
    await db.appRun.update({
      where: { id: run.id },
      data: { budgetTokens: 10, budgetTokensInitial: 10 },
    });
    const { deps } = flowDeps(0.92);
    await executeAppRun(db, run.id, deps);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.budgetTokens).toBe(0);            // clamped, as designed
    expect(after.tokensSpent).toBeGreaterThan(10); // unclamped, the real cost
    // The derivation a client would have had to use under-reports here: it
    // can never exceed the initial budget (10), while the true spend is 100.
    expect(after.budgetTokensInitial! - after.budgetTokens!).toBe(10);
    expect(after.tokensSpent).toBe(100);
  });

  // PR #854 review (Copilot): this used to be LABELLED as covering a run that
  // "later failed" while executing a normal one — the label promised a
  // scenario the body never exercised. Renamed to what it actually asserts.
  it('tokensSpent is never LESS than the hop-trail sum', async () => {
    const run = await mintFlow();
    const { deps } = flowDeps(0.92);
    await executeAppRun(db, run.id, deps);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    const hopSum = Array.isArray(after.hops)
      ? (after.hops as Array<{ tokensSpent?: number }>).reduce((n, h) => n + (h.tokensSpent ?? 0), 0)
      : 0;
    // On a fully-successful run the two agree; the counter can only ever
    // exceed the trail, never trail it.
    expect(after.tokensSpent).toBeGreaterThanOrEqual(hopSum);
  });

  it('a hop whose LLM completed but whose run then FAILED is still counted', async () => {
    // The real failed-hop case the counter beats the trail on: the LLM call
    // returns (tokens billed), and the run fails afterwards.
    const run = await mintFlow();
    const { deps } = flowDeps(0.92);
    // Make the SECOND hop's text call fail after the first hop's extraction
    // already completed and was counted.
    (deps as { llm: unknown }).llm = vi.fn(async () => {
      throw new Error('provider exploded after hop 1');
    });
    await executeAppRun(db, run.id, deps);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    // Hop 1 (llmObject: 80 + 20) completed and IS counted, even though the run
    // as a whole failed.
    expect(after.tokensSpent).toBe(100);
  });

  it('a tool-loop abort that carries no measured usage counts nothing (unknown is not zero, #862)', async () => {
    // A rejection with no completed step has no partialUsage, so nothing is
    // counted. (With completed steps the kernel counts them: appRuns.test.ts.)
    const run = await mintFlow();
    const { deps } = flowDeps(0.92);
    (deps as { llmObject: unknown }).llmObject = vi.fn(async () => {
      throw new ToolDeniedError('hadron_create_node');
    });
    await executeAppRun(db, run.id, deps);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    // Nothing measured, so nothing counted — see AppRun.tokensSpent's docs.
    expect(after.tokensSpent).toBe(0);
  });

  it('actionsSpent counts admitted actions only', async () => {
    const run = await mintFlow();
    const { deps } = flowDeps(0.92);
    await executeAppRun(db, run.id, deps);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.actionsSpent).toBeGreaterThan(0);
    expect(after.budgetActionsInitial! - after.budgetActions!).toBe(after.actionsSpent);
  });
});
