/**
 * plan-tools phase 1 — generateWithTools over a MOCKED AI SDK. The mock's
 * generateText drives the provided tools' execute() the way the real loop
 * would, so the gate/error/accounting contracts are pinned without network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
  jsonSchema: (s: unknown) => s,
  tool: (t: unknown) => t,
  stepCountIs: (n: number) => ({ kind: 'stepCountIs', n }),
}));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => ({ modelId: 'mock' }) }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => ({ modelId: 'mock' }) }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: () => () => ({ modelId: 'mock' }) }));

import { generateText as aiGenerateText } from 'ai';
import {
  generateWithTools,
  ToolDeniedError,
  ToolExecutionError,
  LlmInvocationError,
} from './index.js';
import { hadronLog, hadronFail, AuthorFailError, type RunToolDef } from '../runner/tools/index.js';

const mockedGenerate = aiGenerateText as unknown as ReturnType<typeof vi.fn>;

const resolved = { ownerType: 'HADRON_SERVER', config: { provider: 'anthropic', model: 'test' } } as never;
const stubCtx = (log = vi.fn()) => ({ log, db: {} as never, run: {} as never, principal: {} as never });

const req = { prompt: 'do the thing' };

/** Drive each named tool once, then "answer". Mirrors the SDK loop shape. */
function sdkRunsTools(...calls: Array<{ name: string; args: Record<string, unknown> }>) {
  mockedGenerate.mockImplementationOnce(async (opts: {
    tools: Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>;
  }) => {
    for (const c of calls) await opts.tools[c.name].execute(c.args);
    return {
      text: 'final answer',
      totalUsage: { inputTokens: 120, outputTokens: 30 },
      usage: { inputTokens: 40, outputTokens: 10 },
      steps: [1, 2],
    };
  });
}

const echoTool: RunToolDef = {
  name: 'hadron_echo',
  description: 'test tool',
  inputSchema: { type: 'object', properties: {} },
  cost: 1,
  execute: vi.fn(async (_ctx, args) => ({ echoed: args })),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateWithTools', () => {
  it('records tool calls and sums usage across steps (totalUsage over usage)', async () => {
    sdkRunsTools({ name: 'hadron_echo', args: { x: 1 } });
    const out = await generateWithTools(resolved, req, [echoTool], { toolCtx: stubCtx() });
    expect(out.text).toBe('final answer');
    expect(out.tokensIn).toBe(120); // totalUsage, not per-step usage
    expect(out.toolCalls).toMatchObject([{ name: 'hadron_echo', ok: true }]);
  });

  it('gates every call (D-TL-3): a false gate surfaces ToolDeniedError un-wrapped', async () => {
    sdkRunsTools({ name: 'hadron_echo', args: {} });
    const gate = vi.fn(async () => false);
    await expect(
      generateWithTools(resolved, req, [echoTool], { toolCtx: stubCtx(), onToolCall: gate }),
    ).rejects.toBeInstanceOf(ToolDeniedError);
    expect(gate).toHaveBeenCalledWith('tool.hadron_echo', 1);
    expect(echoTool.execute).not.toHaveBeenCalled(); // denied BEFORE the side effect
  });

  it('uses a tool definition shared policy action instead of its concrete name', async () => {
    const shared: RunToolDef = {
      ...echoTool,
      name: 'web_poll_start',
      policyAction: 'tool.web_poll',
    };
    sdkRunsTools({ name: shared.name, args: {} });
    const gate = vi.fn(async () => true);

    await generateWithTools(resolved, req, [shared], { toolCtx: stubCtx(), onToolCall: gate });

    expect(gate).toHaveBeenCalledWith('tool.web_poll', 1);
  });

  it('a handler throw becomes ToolExecutionError carrying the tool name (D-TL-6)', async () => {
    const broken: RunToolDef = { ...echoTool, name: 'hadron_broken', execute: async () => { throw new Error('boom'); } };
    sdkRunsTools({ name: 'hadron_broken', args: {} });
    const err = await generateWithTools(resolved, req, [broken], { toolCtx: stubCtx() }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolExecutionError);
    expect((err as ToolExecutionError).tool).toBe('hadron_broken');
  });

  it('AuthorFailError from hadron_fail passes through un-wrapped (intent, not malfunction)', async () => {
    sdkRunsTools({ name: 'hadron_fail', args: { reason: 'stop here' } });
    await expect(
      generateWithTools(resolved, req, [hadronFail], { toolCtx: stubCtx() }),
    ).rejects.toBeInstanceOf(AuthorFailError);
  });

  it('hadron_log writes through the tool context to the trail sink', async () => {
    sdkRunsTools({ name: 'hadron_log', args: { message: 'took the urgent branch' } });
    const log = vi.fn();
    const out = await generateWithTools(resolved, req, [hadronLog], { toolCtx: stubCtx(log) });
    expect(log).toHaveBeenCalledWith('took the urgent branch');
    expect(out.toolCalls[0]).toMatchObject({ name: 'hadron_log', ok: true });
  });

  it('a provider error is transient ONLY while no SIDE-EFFECTING tool has executed (D-TL-6)', async () => {
    // Before any tool ran: transient provider blip → retryable.
    mockedGenerate.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { statusCode: 529 }));
    const e1 = await generateWithTools(resolved, req, [echoTool], { toolCtx: stubCtx() }).catch((e) => e);
    expect(e1).toBeInstanceOf(LlmInvocationError);
    expect((e1 as LlmInvocationError).transient).toBe(true);

    // After a side-effecting (cost 1) tool ran: the SAME blip must be terminal.
    mockedGenerate.mockImplementationOnce(async (opts: {
      tools: Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>;
    }) => {
      await opts.tools.hadron_echo.execute({});
      throw Object.assign(new Error('overloaded'), { statusCode: 529 });
    });
    const e2 = await generateWithTools(resolved, req, [echoTool], { toolCtx: stubCtx() }).catch((e) => e);
    expect(e2).toBeInstanceOf(LlmInvocationError);
    expect((e2 as LlmInvocationError).transient).toBe(false);
  });

  it('cost-0 tools do NOT forfeit transient retry (PR-540 Gemini): logs/reads are retry-safe', async () => {
    mockedGenerate.mockImplementationOnce(async (opts: {
      tools: Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>;
    }) => {
      await opts.tools.hadron_log.execute({ message: 'about to act' });
      throw Object.assign(new Error('overloaded'), { statusCode: 529 });
    });
    const err = await generateWithTools(resolved, req, [hadronLog], { toolCtx: stubCtx() }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect((err as LlmInvocationError).transient).toBe(true); // the log ran, retry stays safe
  });

  it('an unverified provider fails loud with NO_TOOL_SUPPORT semantics (D-TL-8)', async () => {
    const glm = { config: { provider: 'glm', model: 'test' } } as never;
    const err = await generateWithTools(glm, req, [echoTool], { toolCtx: stubCtx() }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect((err as Error).message).toContain('NO_TOOL_SUPPORT');
    expect((err as LlmInvocationError).transient).toBe(false);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('passes the step cap through stopWhen (D-TL-4)', async () => {
    sdkRunsTools();
    await generateWithTools(resolved, req, [echoTool], { toolCtx: stubCtx(), stepCap: 3 });
    // The step cap plus a predicate that stops the loop once a tool terminal is set (#2412).
    const stopWhen = mockedGenerate.mock.calls[0][0].stopWhen as unknown[];
    expect(stopWhen).toHaveLength(2);
    expect(stopWhen[0]).toEqual({ kind: 'stepCountIs', n: 3 });
    expect(typeof stopWhen[1]).toBe('function');
  });
});
