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
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';

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
import { makeProdRunDeps } from './appRunDeps.js';

const ORG_URN = 'flow-int-org';
const MEM_URN = `${ORG_URN}:flowmem`;
const ENTRY = `${ORG_URN}::flowmem::flow:classify`;
const ACT = `${ORG_URN}::flowmem::flow:act`;
const DEFER = `${ORG_URN}::flowmem::flow:defer`;

let orgId: string;
let appId: string;
let memoryId: string;

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
  // App-class memory (chk_memory_class_app_id requires appId for class=app).
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: 'flowmem',
      urn: MEM_URN, class: 'app', appId,
    },
  });
  memoryId = memory.id;
  // The run principal's access rides the App's installed Agent's memory map
  // (getAppMemoryAccess): Agent + AppAgent install + read-write AgentMemoryItem.
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: 'flow-agent', urn: `${ORG_URN}:flow-agent` },
  });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
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
    triggerKind: 'MANUAL',
    entryNodeUrn: ENTRY,
    eventData: { topic: 'ticks' },
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

  it('a flow routed into an ENCRYPTED memory fails at that hop (PR-532 Codex P2)', async () => {
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
    expect((after.failure as { code?: string }).code).toBe('NODE_LOAD_FAILED');
    expect((after.failure as { message?: string }).message).toContain('encrypted');
    expect(after.curNodeUrn).toBe(`${ORG_URN}::vault::flow:secret`); // position preserved for audit
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
