/**
 * Spec 040 — run kernel integration (real hadron_test DB, bus mocked,
 * execution deps injected).
 *
 * What this file pins:
 *   - mintAppRun launch gate: app-liveness, on-behalf-of relationship
 *     re-verification, trigger-policy floor, run-quota consumption + refund.
 *   - executeAppRun: claim idempotency; happy path (COMPLETED + budget
 *     decrement + usage event); assembly failure → FAILED (observable, D20);
 *     transient LLM → PENDING reset + 'transient' (bus redelivery contract);
 *     the kill switch (CANCELLED before execution → ACTIVATION_DENIED).
 *   - consumeQuota: headroom semantics + window roll.
 *   - schedulerTick: due claim advances nextRunAt atomically; overlap skip
 *     STILL advances; invalid cron disables the schedule.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';

vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null), // sweep/standalone mode in tests
}));

// #2412: the real `ai` SDK drives one test below; only the provider factories are replaced.
const sdkModel: { model: unknown } = { model: null };
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => sdkModel.model }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => sdkModel.model }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: () => () => sdkModel.model }));

import {
  mintAppRun,
  executeAppRun,
  consumeQuota,
  recordQuotaUsage,
  parseRunPolicySnapshot,
  setQuotaLimit,
  ensureQuotaRowsForScope,
  defaultQuotaLimit,
  RunLaunchDeniedError,
  type RunExecutionDeps,
} from './appRuns.js';
import { schedulerTick } from './scheduler.js';

let orgId: string;
let appId: string;
let userId: string;
let agentId: string;

function deps(overrides: Partial<RunExecutionDeps> = {}): RunExecutionDeps {
  return {
    verifyAutomation: vi.fn(async () => undefined),
    assemble: vi.fn(async () => '# Task\n\nDo the thing.'),
    // Default: a plain node — no extraction, no output spec (the terminal
    // default-write still fires), no outgoing routing edge = 1-hop flow.
    loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false })),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm: vi.fn(async () => ({
      text: 'the briefing',
      tokensIn: 100,
      tokensOut: 50,
      provider: 'anthropic',
      model: 'test',
    })),
    llmObject: vi.fn(async () => ({
      object: { confidence: 0.9 },
      tokensIn: 80,
      tokensOut: 20,
      provider: 'anthropic',
      model: 'test',
    })),
    llmTools: vi.fn(async () => ({
      text: 'tooled result',
      tokensIn: 60,
      tokensOut: 20,
      provider: 'anthropic',
      model: 'test',
      toolCalls: [{ name: 'hadron_log', ok: true, ms: 1 }],
    })),
    writeOutput: vi.fn(async () => 'node-id-1'),
    selectNext: vi.fn(async () => null),
    ...overrides,
  };
}

async function mint(extra: Record<string, unknown> = {}) {
  return mintAppRun(db, {
    organizationId: orgId,
    appId,
    agentId, // #2712: a run needs an Agent with a served boot prompt (R74)
    triggerKind: 'MANUAL',
    entryNodeUrn: 'run-org::runmem::tasks:briefing',
    ...extra,
  } as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'run-org', urn: 'run-org' },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'run-app', urn: 'run-org::run-app' },
  });
  appId = app.id;
  const user = await db.user.create({
    data: { githubId: 9991, githubUsername: 'run-user', roles: ['READER'] },
  });
  userId = user.id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: 'run-org:runner', name: 'runner' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.');
});

// ───── launch gate ──────────────────────────────────────────────────────────

describe('mintAppRun — launch gate (cor:acl:050:01)', () => {
  it('mints a PENDING run with default budgets', async () => {
    const run = await mint();
    expect(run.status).toBe('PENDING');
    expect(run.budgetTokens).toBeGreaterThan(0);
    expect(run.budgetActions).toBeGreaterThan(0);
    expect(run.triggerKind).toBe('MANUAL');
  });

  it('rejects a dead or foreign App', async () => {
    await expect(
      mint({ appId: generateId() }),
    ).rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
  });

  it('re-verifies the on-behalf-of relationship at launch (cor:agt:010:01)', async () => {
    await expect(mint({ userId })).rejects.toMatchObject({ code: 'RELATIONSHIP_MISSING' });
    await db.appMember.create({ data: { appId, userId, role: 'member' } });
    const run = await mint({ userId });
    expect(run.userId).toBe(userId);
  });

  it('denies when the trigger policy does not allow run.execute', async () => {
    await expect(mint({ policy: { allow: ['memory.read'] } })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('rejects an agentId not installed in the App (PR-493 Codex P1 — foreign AI-config leak)', async () => {
    const foreignAgent = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: 'run-org:foreign', name: 'foreign' },
    });
    await expect(mint({ agentId: foreignAgent.id })).rejects.toMatchObject({
      code: 'AGENT_NOT_INSTALLED',
    });
    await db.appAgent.create({ data: { appId, agentId: foreignAgent.id } });
    await serveAgentBootPrompt(db, foreignAgent.id, 'Foreign boot prompt.');
    const run = await mint({ agentId: foreignAgent.id });
    expect(run.agentId).toBe(foreignAgent.id);
  });

  it('denies launches whose entry node lives in an encrypted memory (spec 041, D-2026-07-06-B)', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const memory = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'vault', urn: 'run-org:vault',
        class: 'private', userId: user.id, isEncrypted: true,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'tasks:secret', name: 'Secret task', tags: [] },
    });
    await expect(mint({ entryNodeUrn: 'run-org::vault::tasks:secret' })).rejects.toMatchObject({
      code: 'ENCRYPTED_MEMORY_UNSUPPORTED',
    });
    // The same entry in a PLAINTEXT memory mints fine (guard is encryption-keyed).
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: false } });
    const run = await mint({ entryNodeUrn: 'run-org::vault::tasks:secret' });
    expect(run.status).toBe('PENDING');
  });

  it('rejects an entry node outside the App\'s org at the gate (PR-532 Codex P2)', async () => {
    const foreignOrg = await db.organization.create({
      data: { id: generateId(), name: 'foreign-org', urn: 'foreign-org' },
    });
    const foreignMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: foreignOrg.id, name: 'pubmem',
        urn: 'foreign-org:pubmem', class: 'knowledge',
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: foreignMem.id, loc: 'tasks:other', name: 'Other', tags: [] },
    });
    // Without the gate this would mint, consume quota, and always fail in
    // the worker (loadFlowNode is org-scoped).
    await expect(mint({ entryNodeUrn: 'foreign-org::pubmem::tasks:other' })).rejects.toMatchObject({
      code: 'ENTRY_NOT_IN_ORG',
    });
  });

  it('denies NEW launches when the daily token ledger is at its stored limit (PR-493 Codex P2)', async () => {
    // Simulate yesterday's overage: record spend far past the default limit.
    await recordQuotaUsage(db, 'app', appId, 'llm.tokens', 1_000, 5_000);
    await expect(mint()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('enforces the app run quota and refunds on org denial', async () => {
    // Exhaust the app counter artificially.
    await db.quotaCounter.create({
      data: {
        id: generateId(), scopeKind: 'app', scopeId: appId, action: 'run.execute',
        window: 'day', used: 999_999, limit: 1_000_000, resetAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.quotaCounter.update({
      where: { scopeKind_scopeId_action_window: { scopeKind: 'app', scopeId: appId, action: 'run.execute', window: 'day' } },
      data: { limit: 999_999 },
    });
    await expect(mint()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

// ───── consumeQuota ─────────────────────────────────────────────────────────

describe('consumeQuota', () => {
  it('consumes to the limit, then denies', async () => {
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 2)).toBe(true);
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 2)).toBe(true);
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 2)).toBe(false);
  });

  it('respects the STORED row limit over the default parameter (PR-493 Gemini)', async () => {
    // Seed with default limit 1, exhaust it…
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(true);
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(false);
    // …then an operator raises the ROW limit; the same default param no
    // longer caps it.
    await db.quotaCounter.updateMany({
      where: { scopeKind: 'app', scopeId: appId, action: 'run.execute' },
      data: { limit: 5 },
    });
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(true);
  });

  it('recordQuotaUsage writes into overage (the honest ledger)', async () => {
    await recordQuotaUsage(db, 'app', appId, 'llm.tokens', 100, 250);
    const row = await db.quotaCounter.findFirst({
      where: { scopeKind: 'app', scopeId: appId, action: 'llm.tokens' },
    });
    expect(row?.used).toBe(250);
    expect(row?.limit).toBe(100);
  });

  it('rolls the window when resetAt has passed', async () => {
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(true);
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(false);
    await db.quotaCounter.updateMany({
      where: { scopeKind: 'app', scopeId: appId },
      data: { resetAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 1)).toBe(true);
  });
});

// ───── execution ────────────────────────────────────────────────────────────

describe('executeAppRun — kernel + activation contract (cor:agt:010:02)', () => {
  it('happy path: COMPLETED, budgets decremented, usage recorded', async () => {
    const run = await mint();
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('COMPLETED');
    expect(after.budgetTokens).toBe((run.budgetTokens ?? 0) - 150);
    expect(after.budgetActions).toBe((run.budgetActions ?? 0) - 1);
    expect(after.curNodeUrn).toBe('node-id-1');
    const usage = await db.usageEvent.findFirst({ where: { type: 'app-run' } });
    expect(usage?.tokensIn).toBe(100);
  });

  it('claim is idempotent — a second delivery skips', async () => {
    const run = await mint();
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    expect(await executeAppRun(db, run.id, d)).toBe('skipped');
    expect(d.assemble).toHaveBeenCalledTimes(1);
  });

  it('assembly failure is an OBSERVABLE failed run (D20)', async () => {
    const run = await mint();
    const outcome = await executeAppRun(
      db,
      run.id,
      deps({ assemble: vi.fn(async () => { throw new Error('entry node not found'); }) }),
    );
    expect(outcome).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    expect((after.failure as { code?: string }).code).toBe('ASSEMBLY_FAILED');
  });

  it('transient LLM failure resets the claim for bus redelivery', async () => {
    const run = await mint();
    const { LlmInvocationError } = await import('../lib/llm/index.js');
    const outcome = await executeAppRun(
      db,
      run.id,
      deps({
        llm: vi.fn(async () => {
          throw new LlmInvocationError('rate limited', 'anthropic', true);
        }),
      }),
    );
    expect(outcome).toBe('transient');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('PENDING'); // ready for the next delivery
  });

  it('the kill switch: a CANCELLED run never reaches the LLM', async () => {
    const run = await mint();
    // Cancel between mint and delivery (the manual handle).
    await db.appRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } });
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('skipped'); // claim finds no PENDING
    expect(d.llm).not.toHaveBeenCalled();
  });

  it('a concurrent cancel is never overwritten by COMPLETED/FAILED (PR-493 Gemini)', async () => {
    const run = await mint();
    const d = deps({
      llm: vi.fn(async () => {
        // Cancel arrives while the model call is in flight.
        await db.appRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } });
        return { text: 'late result', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' };
      }),
    });
    const outcome = await executeAppRun(db, run.id, d);
    expect(outcome).toBe('skipped');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('CANCELLED'); // audit log keeps the cancellation
  });

  it('a run-layer policy denying llm.invoke fails before the LLM', async () => {
    const run = await mint({ policy: { allow: ['run.execute', 'memory.write'] } });
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('ACTIVATION_DENIED');
    expect(d.llm).not.toHaveBeenCalled();
  });
});

// ───── multi-node flows (plan-multi-node §4/§8) ─────────────────────────────

describe('executeAppRun — edge-walking loop (plan-multi-node)', () => {
  const NODE_A = 'run-org::runmem::tasks:briefing'; // = entryNodeUrn from mint()
  const NODE_B = 'run-org::runmem::flow:step-b';
  const NODE_C = 'run-org::runmem::flow:step-c';
  const hop = (targetUrn: string) => ({ edgeId: generateId(), edgeName: 'next', targetUrn });

  it('walks a 2-hop flow: checkpoint trail, per-hop usage, terminal default write', async () => {
    const run = await mint();
    const d = deps({
      selectNext: vi.fn(async (_run, nodeUrn) => (nodeUrn === NODE_A ? hop(NODE_B) : null)),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('COMPLETED');
    expect(after.curNodeUrn).toBe('node-id-1'); // terminal write ref, as today
    // Both hops assembled, in flow order, against their own node URNs.
    expect((d.assemble as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual([NODE_A, NODE_B]);
    // Two LLM calls decrement the token budget twice…
    expect(after.budgetTokens).toBe((run.budgetTokens ?? 0) - 300);
    // …the SECOND hop costs one action (D-MN-3) + one for the terminal write.
    expect(after.budgetActions).toBe((run.budgetActions ?? 0) - 2);
    // One usage event per hop, honest ledger.
    expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(2);
    // Interior node (A) wrote nothing; terminal (B) wrote the default record.
    expect(d.writeOutput).toHaveBeenCalledTimes(1);
    expect((d.writeOutput as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(NODE_B);
  });

  it('extraction hop: llmObject fills the envelope; the view feeds the next hop (D-MN-1/D-MN-2)', async () => {
    const run = await mint({
      eventData: { topic: 'ticks', confidence: 0.1, __aiConfigName: 'plumbing' },
    });
    const d = deps({
      loadNodeSpec: vi.fn(async (_run, nodeUrn) =>
        nodeUrn === NODE_A
          ? { extractionSpec: [{ field: 'confidence', shape: 'number' }], hasOutput: false }
          : { extractionSpec: null, hasOutput: false },
      ),
      selectNext: vi.fn(async (_run, nodeUrn) => (nodeUrn === NODE_A ? hop(NODE_B) : null)),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    // Extraction node used the structured surface, not generateText.
    expect(d.llmObject).toHaveBeenCalledTimes(1);
    expect(d.llm).toHaveBeenCalledTimes(1); // hop 2 only
    // Routing view: envelope overrode the trigger hint; __-plumbing stripped.
    const routingView = (d.selectNext as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(routingView).toEqual({ topic: 'ticks', confidence: 0.9 });
    // The SAME merged view reached hop 2's template args (D-MN-1).
    expect((d.assemble as ReturnType<typeof vi.fn>).mock.calls[1][2]).toEqual({
      topic: 'ticks',
      confidence: 0.9,
    });
    // Envelope persisted on the terminal row — bare fields (D-MN-1).
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.data).toEqual({ confidence: 0.9 });
  });

  it('an interior node with data.output writes mid-flow', async () => {
    const run = await mint();
    const d = deps({
      loadNodeSpec: vi.fn(async (_run, nodeUrn) => ({
        extractionSpec: null,
        hasOutput: nodeUrn === NODE_A, // interior A declares an output spec
      })),
      selectNext: vi.fn(async (_run, nodeUrn) => (nodeUrn === NODE_A ? hop(NODE_B) : null)),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    expect((d.writeOutput as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual([
      NODE_A, // declared output, mid-flow
      NODE_B, // terminal default
    ]);
  });

  it('a routing cycle trips MAX_RUN_HOPS into an observable FAILED run (D-MN-3)', async () => {
    const run = await mint();
    const d = deps({
      selectNext: vi.fn(async (_run, nodeUrn) => hop(nodeUrn === NODE_B ? NODE_C : NODE_B)),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('MAX_HOPS_EXCEEDED');
  }, 15_000);

  it('the action budget bounds LLM hops (D-MN-3: hops past the first cost 1 action)', async () => {
    const run = await mint();
    await db.appRun.update({ where: { id: run.id }, data: { budgetActions: 0 } });
    const d = deps({ selectNext: vi.fn(async () => hop(NODE_B)) });
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('ACTIVATION_DENIED');
    expect(d.llm).toHaveBeenCalledTimes(1); // hop 1 ran; hop 2 was denied
  });

  it('a transient failure mid-flow resumes at the CHECKPOINT, not the entry (D-MN-5)', async () => {
    const run = await mint();
    const { LlmInvocationError } = await import('../lib/llm/index.js');
    // Attempt 1: hop A succeeds, hop B's LLM call is rate-limited.
    const first = deps({
      selectNext: vi.fn(async (_run, nodeUrn) => (nodeUrn === NODE_A ? hop(NODE_B) : null)),
      llm: vi
        .fn()
        .mockResolvedValueOnce({ text: 'a-ok', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' })
        .mockRejectedValueOnce(new LlmInvocationError('rate limited', 'anthropic', true)),
    });
    expect(await executeAppRun(db, run.id, first)).toBe('transient');
    const parked = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(parked.status).toBe('PENDING'); // ready for redelivery
    expect(parked.curNodeUrn).toBe(NODE_B); // the checkpoint: resume HERE

    // Attempt 2 (the redelivery): picks up at B — A never re-runs.
    const second = deps({
      selectNext: vi.fn(async () => null),
    });
    expect(await executeAppRun(db, run.id, second)).toBe('completed');
    expect((second.assemble as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual([NODE_B]);
    expect(second.llm).toHaveBeenCalledTimes(1);
  });

  it('a mid-flow cancel halts at the next hop; the last checkpoint survives', async () => {
    const run = await mint();
    const d = deps({
      selectNext: vi.fn(async (_run, nodeUrn) => (nodeUrn === NODE_A ? hop(NODE_B) : null)),
      llm: vi
        .fn()
        // Hop A completes normally…
        .mockResolvedValueOnce({ text: 'a-ok', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' })
        // …the kill switch flips while hop B's call is in flight.
        .mockImplementationOnce(async () => {
          await db.appRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } });
          return { text: 'late', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' };
        }),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('skipped');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('CANCELLED'); // audit log keeps the cancellation
    expect(after.curNodeUrn).toBe(NODE_B); // hop-A checkpoint intact
    expect(d.writeOutput).not.toHaveBeenCalled(); // B's write never happened
  });

  it('an unevaluable edge condition fails the run loudly (D15-sub)', async () => {
    const { EdgeConditionEvalError } = await import('../lib/runner/selectNextEdge.js');
    const run = await mint();
    const d = deps({
      selectNext: vi.fn(async () => {
        throw new EdgeConditionEvalError('unknown operator "frobnicate"', 'edge-1', 'UNKNOWN_OPERATOR');
      }),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('EDGE_CONDITION_ERROR');
  });

  it('persists the walked path — one trail element per completed hop (#538)', async () => {
    const run = await mint();
    const d = deps({
      selectNext: vi.fn(async (_run, nodeUrn) => (nodeUrn === NODE_A ? hop(NODE_B) : null)),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    const trail = after.hops as Array<Record<string, unknown>>;
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ node: NODE_A, edgeOut: 'next', tokensSpent: 150 });
    expect(trail[1]).toMatchObject({ node: NODE_B, edgeOut: null });
    expect(typeof trail[0].startedAt).toBe('number');
    expect(typeof trail[1].finishedAt).toBe('number');
  });

  it('a transient resume appends each hop exactly once — no duplicate trail elements (#538)', async () => {
    const run = await mint();
    const { LlmInvocationError } = await import('../lib/llm/index.js');
    const first = deps({
      selectNext: vi.fn(async (_run, nodeUrn) => (nodeUrn === NODE_A ? hop(NODE_B) : null)),
      llm: vi
        .fn()
        .mockResolvedValueOnce({ text: 'a-ok', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'test' })
        .mockRejectedValueOnce(new LlmInvocationError('rate limited', 'anthropic', true)),
    });
    expect(await executeAppRun(db, run.id, first)).toBe('transient');
    const parked = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((parked.hops as unknown[]) ?? []).toHaveLength(1); // only hop A completed
    expect(await executeAppRun(db, run.id, deps({ selectNext: vi.fn(async () => null) }))).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    const trail = after.hops as Array<Record<string, unknown>>;
    expect(trail).toHaveLength(2); // A once, B once — the failed attempt left no element
    expect(trail.map((h) => h.node)).toEqual([NODE_A, NODE_B]);
  });

  it('a tools hop runs the loop, gates each call through the activation row, and lands the audit on the trail (plan-tools phase 2)', async () => {
    const run = await mint();
    const d = deps({
      loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: ['hadron_create_node'] })),
      llmTools: vi.fn(async (_run, _resolved, _req, toolNames, opts) => {
        expect(toolNames).toEqual(['hadron_create_node']);
        // Simulate the loop: one costed call + one author log line.
        expect(await opts.onToolCall('tool.hadron_create_node', 1)).toBe(true);
        opts.log('created the task node');
        return {
          text: 'done acting', tokensIn: 60, tokensOut: 20, provider: 'anthropic', model: 'test',
          toolCalls: [{ name: 'hadron_create_node', ok: true, ms: 12 }],
        };
      }),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    // The gated call cost 1 action + 1 for the terminal write.
    expect(after.budgetActions).toBe((run.budgetActions ?? 0) - 2);
    const trail = after.hops as Array<Record<string, unknown>>;
    expect(trail[0].toolCalls).toEqual([{ name: 'hadron_create_node', ok: true, ms: 12 }]);
    expect(trail[0].logs).toEqual(['created the task node']);
    expect(d.llm).not.toHaveBeenCalled(); // tool hops use the loop, not plain text
  });

  it('hadron_fail maps to AUTHOR_FAIL — deliberate, not malfunction (D-TL-6)', async () => {
    const { AuthorFailError } = await import('../lib/runner/tools/index.js');
    const run = await mint();
    const d = deps({
      loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: ['hadron_log'] })),
      llmTools: vi.fn(async () => { throw new AuthorFailError('note has no recipient'); }),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.failure).toMatchObject({ code: 'AUTHOR_FAIL', message: 'note has no recipient' });
  });

  it('a denied tool call maps to ACTIVATION_DENIED; a handler throw to TOOL_FAILED (D-TL-3/-6)', async () => {
    const { ToolDeniedError, ToolExecutionError } = await import('../lib/llm/index.js');
    const r1 = await mint();
    const d1 = deps({
      loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: ['hadron_log'] })),
      llmTools: vi.fn(async () => { throw new ToolDeniedError('hadron_create_node'); }),
    });
    expect(await executeAppRun(db, r1.id, d1)).toBe('failed');
    expect(((await db.appRun.findUniqueOrThrow({ where: { id: r1.id } })).failure as { code?: string }).code)
      .toBe('ACTIVATION_DENIED');

    const r2 = await mint();
    const d2 = deps({
      loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: ['hadron_log'] })),
      llmTools: vi.fn(async () => { throw new ToolExecutionError('hadron_create_node', 'boom'); }),
    });
    expect(await executeAppRun(db, r2.id, d2)).toBe('failed');
    expect(((await db.appRun.findUniqueOrThrow({ where: { id: r2.id } })).failure as { code?: string }).code)
      .toBe('TOOL_FAILED');
  });

  it.each([
    ['hadron_fail', 'AUTHOR_FAIL'],
    ['denied', 'ACTIVATION_DENIED'],
    ['throws', 'TOOL_FAILED'],
  ])('#2412: on the real ai SDK a %s terminal fails the run as %s and the model is asked once', async (kind, code) => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const { generateWithTools } = await import('../lib/llm/index.js');
    const { hadronFail } = await import('../lib/runner/tools/index.js');
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
    const tool = kind === 'hadron_fail' ? 'hadron_fail' : 't';
    const steps = [
      { content: [{ type: 'tool-call', toolCallId: '1', toolName: tool, input: '{}' }], finishReason: { unified: 'tool-calls', raw: 'x' }, usage, warnings: [] },
      { content: [{ type: 'text', text: 'carried on' }], finishReason: { unified: 'stop', raw: 'x' }, usage, warnings: [] },
    ];
    let asked = 0;
    sdkModel.model = new MockLanguageModelV4({ doGenerate: async () => steps[asked++] as never });
    const t = { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} }, cost: 1, execute: async () => { throw new Error('boom'); } };
    const run = await mint();
    const d = deps({
      loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: ['hadron_log'] })),
      resolveConfig: vi.fn(async () => ({ ownerType: 'HADRON_SERVER', config: { provider: 'anthropic', model: 'test' } }) as never),
      llmTools: async (r, resolved, req, _names, opts) => generateWithTools(resolved, req, [hadronFail, t as never], {
        onToolCall: kind === 'denied' ? async () => false : opts.onToolCall,
        toolCtx: { log: opts.log, db, run: r, principal: {} as never },
      }),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.failure, JSON.stringify(after.failure)).toMatchObject({ code });
    expect(asked).toBe(1);
  });

  // ── #862: usage of steps completed before a rejected tool-loop call is counted ─────────────────────────
  describe('#862 a rejected tool-loop call counts the steps that completed (real ai SDK)', () => {
    const UU = (i: number | undefined, o: number | undefined) => ({
      inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: o, text: o, reasoning: 0 },
    });
    const call = (name: string, id: string, i: number, o: number) => ({
      content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: 'x' }, usage: UU(i, o), warnings: [],
    });
    const text = (i: number, o: number) => ({
      content: [{ type: 'text', text: 'all done' }], finishReason: { unified: 'stop', raw: 'x' }, usage: UU(i, o), warnings: [],
    });
    const script = async (...steps: unknown[]) => {
      const { MockLanguageModelV4 } = await import('ai/test');
      let n = 0;
      sdkModel.model = new MockLanguageModelV4({
        doGenerate: async () => { const step = steps[n++]; if (step instanceof Error) throw step; return step as never; },
      });
      return () => n;
    };
    const readOnly = (over: Record<string, unknown> = {}) => ({
      name: 't', description: 'd', inputSchema: { type: 'object', properties: {} }, cost: 0, execute: async () => ({ ok: 1 }), ...over,
    });
    const realDeps = async (tools: unknown[]) => {
      const { generateWithTools } = await import('../lib/llm/index.js');
      return deps({
        loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: ['hadron_log'] })),
        resolveConfig: vi.fn(async () => ({ ownerType: 'HADRON_SERVER', config: { provider: 'anthropic', model: 'test' } }) as never),
        llmTools: async (r, resolved, req, _names, opts) => generateWithTools(resolved, req, tools as never, {
          onToolCall: opts.onToolCall,
          toolCtx: { log: opts.log, db, run: r, principal: {} as never },
        }),
      });
    };
    const providerError = new Error('provider refused the request');
    const quota = async (kind: 'app' | 'org') => (await db.quotaCounter.findFirst({
      where: { scopeKind: kind, scopeId: kind === 'app' ? appId : orgId, action: 'llm.tokens' },
    }))?.used ?? 0;

    it('charges the completed steps once to the run, both quotas and one usage event, and keeps the failure code', async () => {
      await script(call('t', '1', 10, 2), call('t', '2', 20, 3), providerError);
      const run = await mint();
      expect(await executeAppRun(db, run.id, await realDeps([readOnly()]))).toBe('failed');
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect((after.failure as { code?: string }).code).toBe('LLM_FAILED');
      expect(after.tokensSpent).toBe(35);
      expect((run.budgetTokens ?? 0) - (after.budgetTokens ?? 0)).toBe(35);
      expect(await quota('app')).toBe(35);
      expect(await quota('org')).toBe(35);
      const events = await db.usageEvent.findMany({ where: { type: 'app-run' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ tokensIn: 30, tokensOut: 5, provider: 'anthropic', model: 'test' });
    });

    it('a rejection before any step completed counts nothing: unknown is not zero', async () => {
      await script(providerError);
      const run = await mint();
      expect(await executeAppRun(db, run.id, await realDeps([readOnly()]))).toBe('failed');
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.tokensSpent).toBe(0);
      expect(after.budgetTokens).toBe(run.budgetTokens);
      expect(await quota('app')).toBe(0);
      expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(0);
    });

    it('a completed step that measured zero is recorded as a measured zero (one event, no tokens)', async () => {
      await script(call('t', '1', 0, 0), providerError);
      const run = await mint();
      await executeAppRun(db, run.id, await realDeps([readOnly()]));
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.tokensSpent).toBe(0);
      expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(1);
    });

    it('a transient rejection charges the failed attempt before the reset, and the retry adds only its own steps', async () => {
      await script(call('t', '1', 10, 2), call('t', '2', 20, 3), Object.assign(new Error('upstream unavailable'), { statusCode: 503 }));
      const run = await mint();
      const d = await realDeps([readOnly()]);
      expect(await executeAppRun(db, run.id, d)).toBe('transient');
      const parked = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(parked.status).toBe('PENDING');
      expect(parked.tokensSpent).toBe(35);
      await script(call('t', '1', 5, 1), text(6, 2));
      expect(await executeAppRun(db, run.id, d)).toBe('completed');
      const done = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(done.tokensSpent).toBe(35 + 14); // the failed attempt once, the retry's own totalUsage once
      const hops = done.hops as Array<{ tokensSpent: number }>;
      expect(hops).toHaveLength(1);
      expect(hops[0].tokensSpent).toBe(14); // the failed attempt is not in the checkpoint
      expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(2);
    });

    it('a tool terminal after a completed step counts that step too and still maps to AUTHOR_FAIL', async () => {
      const { hadronFail } = await import('../lib/runner/tools/index.js');
      await script(call('t', '1', 10, 2), call('hadron_fail', '2', 20, 3), text(1, 1));
      const run = await mint();
      await executeAppRun(db, run.id, await realDeps([readOnly(), hadronFail]));
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect((after.failure as { code?: string }).code).toBe('AUTHOR_FAIL');
      expect(after.tokensSpent).toBe(35);
    });

    it('an accounting fault keeps the original failure and charges nothing twice', async () => {
      await script(call('t', '1', 10, 2), call('t', '2', 20, 3), providerError);
      const run = await mint();
      const d = await realDeps([readOnly()]);
      const broken = new Proxy(db, {
        get: (target, key) => (key === 'quotaCounter'
          ? new Proxy({}, { get: () => async () => { throw new Error('quota store down'); } })
          : Reflect.get(target, key)),
      });
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await executeAppRun(broken as never, run.id, d)).toBe('failed');
      quiet.mockRestore();
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect((after.failure as { code?: string }).code).toBe('LLM_FAILED'); // not replaced by the quota fault
      expect(after.tokensSpent).toBe(35); // persisted once, never retried
    });

    // Fault injection for the accounting branches of the rejected-call charge (#2427). Each fault
    // throws on the FIRST matching write only, and `hits` counts how often that write was attempted.
    const faulting = (where: 'counter' | 'orgQuota') => {
      const hits = { n: 0 };
      const wrap = <T extends object>(model: T, hit: (args: never) => boolean) => new Proxy(model, {
        get: (target, key) => (key === 'updateMany'
          ? async (args: never) => { if (hit(args)) { hits.n += 1; throw new Error('accounting store down'); } return (target as never as { updateMany: (a: never) => unknown }).updateMany(args); }
          : Reflect.get(target, key)),
      });
      const proxied = new Proxy(db, {
        get: (target, key) => {
          if (where === 'counter' && key === 'appRun') {
            return wrap(target.appRun, (a: { data?: { tokensSpent?: unknown } }) => a?.data?.tokensSpent !== undefined);
          }
          if (where === 'orgQuota' && key === 'quotaCounter') {
            return wrap(target.quotaCounter, (a: { where?: { scopeKind?: string } }) => a?.where?.scopeKind === 'org');
          }
          return Reflect.get(target, key);
        },
      });
      return { db: proxied as never, hits };
    };

    it('a fault on the run-counter write keeps the original failure and charges nothing', async () => {
      await script(call('t', '1', 10, 2), call('t', '2', 20, 3), providerError);
      const run = await mint();
      const d = await realDeps([readOnly()]);
      const f = faulting('counter');
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await executeAppRun(f.db, run.id, d)).toBe('failed');
      quiet.mockRestore();
      expect(f.hits.n).toBe(1);
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect((after.failure as { code?: string }).code).toBe('LLM_FAILED'); // not replaced by the counter fault
      expect(after.tokensSpent).toBe(0);
      expect(after.budgetTokens).toBe(run.budgetTokens);
      expect(await quota('app')).toBe(0);
      expect(await quota('org')).toBe(0);
      expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(0);
    });

    it('an org-quota fault after the app quota persisted is not retried, so nothing is counted twice', async () => {
      await script(call('t', '1', 10, 2), call('t', '2', 20, 3), providerError);
      const run = await mint();
      const d = await realDeps([readOnly()]);
      const f = faulting('orgQuota');
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await executeAppRun(f.db, run.id, d)).toBe('failed');
      quiet.mockRestore();
      expect(f.hits.n).toBe(1); // attempted once, never retried
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect((after.failure as { code?: string }).code).toBe('LLM_FAILED');
      expect(after.tokensSpent).toBe(35);
      expect(await quota('app')).toBe(35);
      expect(await quota('org')).toBe(0);
      expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(0); // the fault precedes the event
    });

    it('a transient rejection whose charge faulted still resets to PENDING, and the retry does not charge the failed attempt again', async () => {
      await script(call('t', '1', 10, 2), call('t', '2', 20, 3), Object.assign(new Error('upstream unavailable'), { statusCode: 503 }));
      const run = await mint();
      const d = await realDeps([readOnly()]);
      const f = faulting('orgQuota');
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await executeAppRun(f.db, run.id, d)).toBe('transient');
      quiet.mockRestore();
      expect(f.hits.n).toBe(1);
      const parked = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(parked.status).toBe('PENDING');
      expect(parked.tokensSpent).toBe(35);
      expect(await quota('app')).toBe(35);
      await script(call('t', '1', 5, 1), text(6, 2));
      expect(await executeAppRun(db, run.id, d)).toBe('completed');
      const done = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(done.tokensSpent).toBe(35 + 14); // the failed attempt once, the retry's own steps once
      expect(await quota('app')).toBe(35 + 14);
      expect(await quota('org')).toBe(14); // the faulted attempt's org share is lost, never re-charged
      expect(await db.usageEvent.count({ where: { type: 'app-run' } })).toBe(1); // only the retry's
    });

    it('charging never resurrects a run that was cancelled mid-hop', async () => {
      await script(call('t', '1', 10, 2), providerError);
      const run = await mint();
      const cancelling = readOnly({ execute: async () => { await db.appRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } }); return { ok: 1 }; } });
      await executeAppRun(db, run.id, await realDeps([cancelling]));
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.status).toBe('CANCELLED');
      expect(after.tokensSpent).toBe(12); // the provider already billed the step
    });
  });

  it('an unverified tool-loop provider maps to NO_TOOL_SUPPORT (D-TL-8)', async () => {
    const { NoToolSupportError } = await import('../lib/llm/index.js');
    const run = await mint();
    const d = deps({
      loadNodeSpec: vi.fn(async () => ({ extractionSpec: null, hasOutput: false, tools: ['hadron_log'] })),
      llmTools: vi.fn(async () => {
        throw new NoToolSupportError('glm');
      }),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    expect(((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure as { code?: string }).code)
      .toBe('NO_TOOL_SUPPORT');
  });

  it('__-keys are stripped from BOTH view sources — a persisted envelope is not a trusted channel (PR-532 Copilot)', async () => {
    const run = await mint({ eventData: { topic: 'ticks', __aiConfigName: 'plumbing' } });
    // Simulate a resume from a checkpoint whose envelope carries plumbing.
    await db.appRun.update({ where: { id: run.id }, data: { data: { __sneak: 1, ok: 2 } } });
    const d = deps();
    expect(await executeAppRun(db, run.id, d)).toBe('completed');
    expect((d.assemble as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ topic: 'ticks', ok: 2 });
    expect((d.selectNext as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ topic: 'ticks', ok: 2 });
  });

  it('a mid-flow node that cannot be loaded is an observable failure (D20 analog)', async () => {
    const run = await mint();
    const d = deps({
      loadNodeSpec: vi.fn(async () => {
        throw new Error('Flow node not found: "run-org::runmem::tasks:briefing".');
      }),
    });
    expect(await executeAppRun(db, run.id, d)).toBe('failed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.failure as { code?: string }).code).toBe('NODE_LOAD_FAILED');
  });
});

// ───── scheduler ────────────────────────────────────────────────────────────

describe('schedulerTick (plan §7)', () => {
  async function makeSchedule(extra: Record<string, unknown> = {}) {
    return db.agentSchedule.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        appId,
        name: 'morning briefing',
        cron: '0 7 * * *',
        timezone: 'UTC',
        agentId,
        entryNodeUrn: 'run-org::runmem::tasks:briefing',
        enabled: true,
        nextRunAt: new Date(Date.now() - 60_000), // due
        ...extra,
      } as never,
    });
  }

  it('mints a run for a due schedule and advances nextRunAt', async () => {
    const s = await makeSchedule();
    const minted = await schedulerTick(db);
    expect(minted).toBe(1);
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after.lastRunAt).not.toBeNull();
    const run = await db.appRun.findFirst({ where: { triggerId: s.id } });
    expect(run?.triggerKind).toBe('SCHEDULE');
    expect(run?.status).toBe('PENDING');
  });

  it('overlap skip STILL advances nextRunAt (no back-to-back storm)', async () => {
    const s = await makeSchedule();
    await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgId, appId, triggerKind: 'SCHEDULE',
        triggerId: s.id, entryNodeUrn: s.entryNodeUrn, status: 'RUNNING',
      },
    });
    const minted = await schedulerTick(db);
    expect(minted).toBe(0);
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now()); // advanced despite skip
    expect(await db.appRun.count({ where: { triggerId: s.id } })).toBe(1); // no double-mint
  });

  it('an invalid cron disables the schedule loudly instead of looping', async () => {
    const s = await makeSchedule({ cron: 'not a cron' });
    await schedulerTick(db);
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.enabled).toBe(false);
  });

  it('a not-yet-due schedule is untouched', async () => {
    await makeSchedule({ nextRunAt: new Date(Date.now() + 3_600_000) });
    expect(await schedulerTick(db)).toBe(0);
  });

  it('a due one-shot (runAt, no cron) fires once and disables itself (#510)', async () => {
    const s = await makeSchedule({ cron: null, runAt: new Date(Date.now() - 60_000) });
    expect(await schedulerTick(db)).toBe(1);
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull(); // the disable IS the claim
    expect(await db.appRun.count({ where: { triggerId: s.id } })).toBe(1);
    // A later tick never re-fires the row.
    expect(await schedulerTick(db)).toBe(0);
    expect(await db.appRun.count({ where: { triggerId: s.id } })).toBe(1);
  });
});

// ───── policy chain (#510) ──────────────────────────────────────────────────

describe('mintAppRun — conjunctive chain assembly (#510, cor:acl:040:02)', () => {
  it('an org-layer link that omits run.execute denies every mint in the org', async () => {
    await db.organization.update({
      where: { id: orgId },
      data: { policy: { allow: ['memory.read'] } },
    });
    await expect(mint()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('snapshots the PRESENT links as {chain: [...]} on the run row', async () => {
    await db.organization.update({ where: { id: orgId }, data: { policy: { allow: ['*'] } } });
    await db.app.update({
      where: { id: appId },
      data: { policy: { allow: ['run.execute', 'llm.invoke', 'memory.*'] } },
    });
    const run = await mint({ policy: { allow: ['run.execute', 'llm.invoke'] } });
    expect(run.policy).toEqual({
      chain: [
        { allow: ['*'] },
        { allow: ['run.execute', 'llm.invoke', 'memory.*'] },
        { allow: ['run.execute', 'llm.invoke'] },
      ],
    });
  });

  it('the user layer joins the conjunction for on-behalf-of runs', async () => {
    await db.appMember.create({ data: { appId, userId, role: 'member' } });
    await db.user.update({
      where: { id: userId },
      data: { policy: { allow: ['memory.read'] } }, // no run.execute
    });
    await expect(mint({ userId })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // The same user WITHOUT on-behalf-of does not constrain the App's runs.
    const run = await mint();
    expect(run.status).toBe('PENDING');
  });

  it('an app link narrower than the trigger link halts the run at the action gate', async () => {
    // Chain allows the mint (run.execute) but NOT llm.invoke — the per-action
    // re-check inside the kernel must stop it (kill-switch contract).
    await db.app.update({
      where: { id: appId },
      data: { policy: { allow: ['run.execute'] } },
    });
    const run = await mint();
    const d = deps();
    await executeAppRun(db, run.id, d);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    expect((after.failure as { code?: string })?.code).toBe('ACTIVATION_DENIED');
    expect(d.llm).not.toHaveBeenCalled();
  });

  it('parseRunPolicySnapshot accepts the pre-#510 single-link shape', () => {
    expect(parseRunPolicySnapshot({ allow: ['run.execute'] })).toEqual([
      { allow: ['run.execute'] },
    ]);
    expect(parseRunPolicySnapshot({ chain: [{ allow: ['*'] }, { allow: ['llm.invoke'] }] })).toEqual([
      { allow: ['*'] },
      { allow: ['llm.invoke'] },
    ]);
    expect(parseRunPolicySnapshot(null)).toEqual([null]); // absent = no restriction
  });
});

// ───── quota admin helpers (#510) ───────────────────────────────────────────

describe('setQuotaLimit + ensureQuotaRowsForScope (#510)', () => {
  it('materializes every counter-action row with the platform defaults', async () => {
    await ensureQuotaRowsForScope(db, 'org', orgId);
    const rows = await db.quotaCounter.findMany({ where: { scopeKind: 'org', scopeId: orgId } });
    expect(rows.map((r) => r.action).sort()).toEqual(['email.send', 'llm.tokens', 'run.execute', 'sms.send']);
    expect(rows.every((r) => r.limit === defaultQuotaLimit('org', r.action as never))).toBe(true);
  });

  it('the stored limit persists across a window roll (limit is the dial, used resets)', async () => {
    await setQuotaLimit(db, 'app', appId, 'run.execute', 3);
    // Expire the window, then touch it again via consume.
    await db.quotaCounter.updateMany({
      where: { scopeKind: 'app', scopeId: appId, action: 'run.execute' },
      data: { used: 3, resetAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeQuota(db, 'app', appId, 'run.execute', 999)).toBe(true); // rolled: used 0
    const row = await db.quotaCounter.findFirstOrThrow({
      where: { scopeKind: 'app', scopeId: appId, action: 'run.execute' },
    });
    expect(row.limit).toBe(3); // NOT re-seeded from env
    expect(row.used).toBe(1);
  });
});

describe('a headless run writes as its agent (#1610)', () => {
  it('executes inside an actor scope carrying AppRun.agentId, and as nobody without one', async () => {
    const { currentActor } = await import('../lib/requestActor.js');
    const agent = await db.agent.create({ data: { id: generateId(), urn: 'run-org::run-agent', name: 'run-agent', organizationId: orgId } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    await serveAgentBootPrompt(db, agent.id, 'Run agent boot prompt.');
    const seen: Array<{ workerId: string | null; agentId: string | null }> = [];
    const capture = deps({
      llm: vi.fn(async () => {
        seen.push({ ...currentActor() });
        return { text: 'done', tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test' };
      }),
    });
    const withAgent = await mint({ agentId: agent.id });
    expect(await executeAppRun(db, withAgent.id, capture)).toBe('completed');
    // #2712: R74 refuses minting a run with no Agent; a legacy row without one still runs as nobody.
    const without = await db.appRun.create({ data: {
      id: generateId(), organizationId: orgId, appId, triggerKind: 'MANUAL', entryNodeUrn: withAgent.entryNodeUrn,
      budgetTokens: withAgent.budgetTokensInitial, budgetActions: withAgent.budgetActionsInitial,
      budgetTokensInitial: withAgent.budgetTokensInitial, budgetActionsInitial: withAgent.budgetActionsInitial,
      costMicroCents: 0n, timeoutMs: withAgent.timeoutMs,
    } });
    expect(await executeAppRun(db, without.id, capture)).toBe('completed');
    expect(seen).toEqual([{ workerId: null, agentId: agent.id }, { workerId: null, agentId: null }]);
    // Outside the run nothing leaks.
    expect(currentActor()).toEqual({ workerId: null, agentId: null });
  });

  it('a run edit stamps the node with the run\'s user, the same user its revision records (#2176, Brooks P2-1)', async () => {
    const { editorFromAuth } = await import('../lib/nodeRevisionSnapshot.js');
    const { runAuthContext } = await import('../lib/auth/runPrincipal.js');
    const { createDbOrgAndGraph, createDbNode } = await import('../test/helpers.js');
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'run-edit-org', graphName: 'run-edit' });
    const node = await createDbNode(db, { loc: 'note', memoryId: graph.id, content: 'before' });
    const edits: Array<{ revisionEditor: string | null }> = [];
    let runId = '';
    const capture = deps({
      llm: vi.fn(async () => {
        const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
        edits.push({ revisionEditor: editorFromAuth(runAuthContext(run)).userId ?? null });
        await db.node.update({ where: { id: node.id }, data: { content: 'run edit' } });
        return { text: 'done', tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test' };
      }),
    });
    await db.appMember.create({ data: { appId, userId, role: 'member' } });
    runId = (await mint({ userId })).id;
    expect(await executeAppRun(db, runId, capture)).toBe('completed');
    expect(edits).toEqual([{ revisionEditor: userId }]);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).updatedByUserId).toBe(userId);
  });
});
