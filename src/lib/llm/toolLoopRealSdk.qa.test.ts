/**
 * QA red test (hadron-server#862 spike point 1): generateWithTools over the REAL
 * `ai` SDK (only the provider factories are replaced, with a deterministic
 * MockLanguageModelV4). A tool terminal (hadron_fail, policy denial, handler
 * throw) must reject generateWithTools with the un-wrapped error (D-TL-6).
 */
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';

const state: { model: unknown } = { model: null };
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => state.model }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => state.model }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: () => () => state.model }));

import { generateWithTools, ToolDeniedError, ToolExecutionError } from './index.js';
import { hadronFail, AuthorFailError, type RunToolDef } from '../runner/tools/index.js';

const U = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: o, text: o, reasoning: 0 },
});
const callStep = (name: string, id: string, i: number, o: number) => ({
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: '{}' }],
  finishReason: { unified: 'tool-calls', raw: 'x' }, usage: U(i, o), warnings: [],
});
const textStep = (i: number, o: number) => ({
  content: [{ type: 'text', text: 'carried on' }],
  finishReason: { unified: 'stop', raw: 'x' }, usage: U(i, o), warnings: [],
});
const script = (...steps: unknown[]) => {
  let n = 0;
  state.model = new MockLanguageModelV4({ doGenerate: async () => steps[n++] as never });
  return () => n;
};

const resolved = { ownerType: 'HADRON_SERVER', config: { provider: 'anthropic', model: 'test' } } as never;
const stubCtx = () => ({ log: vi.fn(), db: {} as never, run: {} as never, principal: {} as never });
const req = { prompt: 'p' };
const throwing = (name: string, fn: () => unknown): RunToolDef => ({
  name, description: 'd', inputSchema: { type: 'object', properties: {} }, cost: 1, execute: (async () => fn()) as never,
});

describe('generateWithTools on the real ai SDK: tool terminals end the run', () => {
  it('a handler throw rejects with ToolExecutionError (not a normal result)', async () => {
    const steps = script(callStep('t', '1', 10, 2), textStep(20, 3));
    await expect(
      generateWithTools(resolved, req, [throwing('t', () => { throw new Error('boom'); })], { toolCtx: stubCtx() }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(steps()).toBe(1); // the loop stopped; the model was not asked again
  });

  it('a policy denial rejects with ToolDeniedError and the model is not asked again', async () => {
    const steps = script(callStep('t', '1', 10, 2), textStep(20, 3));
    const exec = vi.fn(async () => ({ ok: 1 }));
    await expect(
      generateWithTools(resolved, req, [{ ...throwing('t', () => 0), execute: exec as never }], {
        toolCtx: stubCtx(), onToolCall: async () => false,
      }),
    ).rejects.toBeInstanceOf(ToolDeniedError);
    expect(exec).not.toHaveBeenCalled();
    expect(steps()).toBe(1);
  });

  it('hadron_fail rejects with AuthorFailError', async () => {
    const steps = script(callStep('hadron_fail', '1', 10, 2), textStep(20, 3));
    await expect(
      generateWithTools(resolved, req, [hadronFail], { toolCtx: stubCtx() }),
    ).rejects.toBeInstanceOf(AuthorFailError);
    expect(steps()).toBe(1);
  });

  it('a terminal in step one means a second-step tool call never runs', async () => {
    const later = vi.fn(async () => ({ ok: 1 }));
    const steps = script(callStep('t', '1', 10, 2), callStep('later', '2', 20, 3), textStep(30, 4));
    await expect(
      generateWithTools(resolved, req, [
        throwing('t', () => { throw new Error('boom'); }),
        { ...throwing('later', () => 0), execute: later as never },
      ], { toolCtx: stubCtx() }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(later).not.toHaveBeenCalled();
    expect(steps()).toBe(1);
  });

  it('with two calls in one step the first terminal is the one that propagates', async () => {
    const steps = script({
      content: [
        { type: 'tool-call', toolCallId: '1', toolName: 'hadron_fail', input: '{}' },
        { type: 'tool-call', toolCallId: '2', toolName: 't', input: '{}' },
      ],
      finishReason: { unified: 'tool-calls', raw: 'x' }, usage: U(10, 2), warnings: [],
    }, textStep(20, 3));
    await expect(
      generateWithTools(resolved, req, [hadronFail, throwing('t', () => { throw new Error('boom'); })], { toolCtx: stubCtx() }),
    ).rejects.toBeInstanceOf(AuthorFailError);
    expect(steps()).toBe(1);
  });

  it('a sibling admitted by policy does not execute once a terminal in the same step is set (#2418)', async () => {
    // ai@7 starts both calls together. The sibling's policy admission is held on a deferred released from a
    // macrotask after the terminal threw, so the order is fixed: terminal first, sibling admitted second.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const side = vi.fn(async () => ({ sent: 1 }));
    const admitted: string[] = [];
    const steps = script({
      content: [
        { type: 'tool-call', toolCallId: '1', toolName: 'term', input: '{}' },
        { type: 'tool-call', toolCallId: '2', toolName: 'side', input: '{}' },
      ],
      finishReason: { unified: 'tool-calls', raw: 'x' }, usage: U(10, 2), warnings: [],
    }, textStep(20, 3));
    const err = await generateWithTools(resolved, req, [
      throwing('term', () => { setTimeout(release, 0); throw new Error('terminal boom'); }),
      { ...throwing('side', () => 0), execute: side as never },
    ], {
      toolCtx: stubCtx(),
      onToolCall: async (action) => { if (action === 'tool.side') await gate; admitted.push(action); return true; },
    }).catch((e: unknown) => e);
    expect(admitted).toContain('tool.side'); // admitted and charged: the stated residual
    expect(side).not.toHaveBeenCalled();     // but its side effect never ran
    expect(err).toBeInstanceOf(ToolExecutionError);
    expect((err as Error).message).toContain('terminal boom'); // the FIRST terminal's error, not a second wrapper
    expect(steps()).toBe(1);
  });

  it('control: a sibling admitted before any terminal exists still executes (#2418)', async () => {
    const side = vi.fn(async () => ({ sent: 1 }));
    script({
      content: [
        { type: 'tool-call', toolCallId: '1', toolName: 'ok1', input: '{}' },
        { type: 'tool-call', toolCallId: '2', toolName: 'side', input: '{}' },
      ],
      finishReason: { unified: 'tool-calls', raw: 'x' }, usage: U(10, 2), warnings: [],
    }, textStep(20, 3));
    const out = await generateWithTools(resolved, req, [
      throwing('ok1', () => ({ ok: 1 })),
      { ...throwing('side', () => 0), execute: side as never },
    ], { toolCtx: stubCtx() });
    expect(side).toHaveBeenCalledTimes(1);
    expect(out.toolCalls.map((c) => [c.name, c.ok])).toEqual(expect.arrayContaining([['side', true]]));
  });

  it('control: no tool failure still resolves with summed usage', async () => {
    script(callStep('t', '1', 10, 2), textStep(20, 3));
    const out = await generateWithTools(resolved, req, [throwing('t', () => ({ ok: 1 }))], { toolCtx: stubCtx() });
    expect(out.text).toBe('carried on');
    expect([out.tokensIn, out.tokensOut]).toEqual([30, 5]);
  });
});
