/**
 * #862 — generateWithTools over the REAL `ai` SDK (only the provider factories are replaced, with a deterministic
 * MockLanguageModelV4). When the call is rejected after completed steps, the thrown error carries the measured
 * usage of exactly those steps as `partialUsage`: the failing step is never included, an unmeasured run has no
 * property at all, and a measured zero is distinct from absent. Error class, provider, transient and cause are
 * untouched (cor:agt:010:02: every action decrements the run's budget on that call).
 */
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';

const state: { model: unknown } = { model: null };
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => state.model }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => state.model }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: () => () => state.model }));

import { generateWithTools, LlmInvocationError, ToolExecutionError } from './index.js';
import { hadronFail, AuthorFailError, type RunToolDef } from '../runner/tools/index.js';

type Usage = { inputTokens?: number; outputTokens?: number };
const U = (u: Usage) => ({
  inputTokens: { total: u.inputTokens, noCache: u.inputTokens, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: u.outputTokens, text: u.outputTokens, reasoning: 0 },
});
const callStep = (name: string, id: string, u: Usage) => ({
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: '{}' }],
  finishReason: { unified: 'tool-calls', raw: 'x' }, usage: U(u), warnings: [],
});
const textStep = (u: Usage) => ({
  content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'x' }, usage: U(u), warnings: [],
});
const script = (...steps: unknown[]) => {
  let n = 0;
  state.model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[n++];
      if (step instanceof Error) throw step;
      return step as never;
    },
  });
  return () => n;
};
const resolved = { ownerType: 'HADRON_SERVER', config: { provider: 'anthropic', model: 'test' } } as never;
const stubCtx = () => ({ log: vi.fn(), db: {} as never, run: {} as never, principal: {} as never });
const req = { prompt: 'p' };
const okTool: RunToolDef = { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} }, cost: 0, execute: (async () => ({ ok: 1 })) as never };
const run = (...tools: RunToolDef[]) => generateWithTools(resolved, req, tools, { toolCtx: stubCtx() });
const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { partialUsage?: unknown; provider?: string; transient?: boolean }; } throw new Error('expected a rejection'); };
const provider500 = Object.assign(new Error('provider exploded'), { statusCode: 500 });

describe('generateWithTools partialUsage on a rejected call (#862)', () => {
  it('a provider error after two completed steps carries their summed usage, once, and keeps the wrap', async () => {
    script(callStep('t', '1', { inputTokens: 10, outputTokens: 2 }), callStep('t', '2', { inputTokens: 20, outputTokens: 3 }), provider500);
    const err = await caught(run(okTool));
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(err.partialUsage).toEqual({ tokensIn: 30, tokensOut: 5, measuredSteps: 2 });
    expect(err.provider).toBe('anthropic');
    expect(err.transient).toBe(true); // 500 with only cost-0 work done: unchanged classification
    expect((err as Error).cause).toBe(provider500);
  });

  it('a rejection on the first step has no partialUsage property: unknown, not zero', async () => {
    script(provider500);
    const err = await caught(run(okTool));
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect('partialUsage' in err).toBe(false);
  });

  it('a completed step that reports zero is a measured zero, distinct from absent', async () => {
    script(callStep('t', '1', { inputTokens: 0, outputTokens: 0 }), provider500);
    const err = await caught(run(okTool));
    expect(err.partialUsage).toEqual({ tokensIn: 0, tokensOut: 0, measuredSteps: 1 });
  });

  it('a step reporting neither side is not measured; one undefined side counts as 0 on that side', async () => {
    script(callStep('t', '1', {}), provider500);
    expect('partialUsage' in await caught(run(okTool))).toBe(false);
    script(callStep('t', '1', { inputTokens: 7 }), callStep('t', '2', { outputTokens: 4 }), provider500);
    expect((await caught(run(okTool))).partialUsage).toEqual({ tokensIn: 7, tokensOut: 4, measuredSteps: 2 });
  });

  it('a tool terminal after a completed step passes through un-wrapped and still carries the measured steps', async () => {
    script(callStep('t', '1', { inputTokens: 10, outputTokens: 2 }), callStep('hadron_fail', '2', { inputTokens: 20, outputTokens: 3 }), textStep({ inputTokens: 99, outputTokens: 99 }));
    const err = await caught(run(okTool, hadronFail));
    expect(err).toBeInstanceOf(AuthorFailError);
    expect(err.partialUsage).toEqual({ tokensIn: 30, tokensOut: 5, measuredSteps: 2 });
  });

  it('an LlmInvocationError raised by the provider layer passes through the same instance and carries the steps', async () => {
    const own = new LlmInvocationError('model refused', 'anthropic', false);
    script(callStep('t', '1', { inputTokens: 10, outputTokens: 2 }), own);
    const err = await caught(run(okTool));
    expect(err).toBe(own);
    expect(err.partialUsage).toEqual({ tokensIn: 10, tokensOut: 2, measuredSteps: 1 });
  });

  it('a reused provider error carries only the current call’s steps: none when this call measured none', async () => {
    const shared = new LlmInvocationError('model refused', 'anthropic', false);
    script(callStep('t', '1', { inputTokens: 10, outputTokens: 2 }), shared);
    expect((await caught(run(okTool))).partialUsage).toEqual({ tokensIn: 10, tokensOut: 2, measuredSteps: 1 });
    script(shared); // the same instance, rejected before any step completes
    const again = await caught(run(okTool));
    expect(again).toBe(shared);
    expect('partialUsage' in again).toBe(false);
  });

  it('a handler throw keeps its ToolExecutionError class and cause and carries the steps', async () => {
    const boom = new Error('boom');
    script(callStep('t', '1', { inputTokens: 10, outputTokens: 2 }), textStep({ inputTokens: 1, outputTokens: 1 }));
    const err = await caught(run({ ...okTool, execute: (async () => { throw boom; }) as never }));
    expect(err).toBeInstanceOf(ToolExecutionError);
    expect(err.cause).toBe(boom);
    expect(err.partialUsage).toEqual({ tokensIn: 10, tokensOut: 2, measuredSteps: 1 });
  });

  it('success is unchanged: summed totalUsage on the result, nothing extra', async () => {
    script(callStep('t', '1', { inputTokens: 10, outputTokens: 2 }), textStep({ inputTokens: 20, outputTokens: 3 }));
    const out = await run(okTool);
    expect([out.tokensIn, out.tokensOut]).toEqual([30, 5]);
    expect('partialUsage' in out).toBe(false);
  });
});
