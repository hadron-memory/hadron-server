/**
 * #1417 slice 1 — saved provider knobs reach the wire, on every call site,
 * and the report says what each one did.
 *
 * No provider and no real key: a local capture server records each request
 * body and answers in the shape each adapter parses (OpenAI Chat Completions
 * and Responses, Anthropic Messages).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callSettingsFor, withAdapterWarnings, WARNING_FEATURE } from './callSettings.js';
import { generateExtraction, generateText, generateWithTools } from './index.js';
import { encryptToken } from '../tokenCrypto.js';

/** JSON on purpose: the extraction path parses the reply. */
const REPLY = '{"answer":"ok"}';

let server: Server;
let origin: string;
const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? '';
    const body = await readBody(req);
    bodies.push({ path, body });
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/chat/completions')) {
      res.end(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    } else if (path.endsWith('/responses')) {
      res.end(JSON.stringify({
        id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: body.model,
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: REPLY, annotations: [] }] }],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      }));
    } else if (path.endsWith('/messages')) {
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route ${path}` } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  bodies.length = 0;
});

function config(
  provider: string,
  params: Record<string, unknown> | null,
  opts: { model?: string; apiStyle?: string | null; endpointPath?: string } = {},
) {
  return {
    ownerType: 'ORGANIZATION',
    config: {
      provider,
      model: opts.model ?? 'test-model',
      apiKeyEncrypted: encryptToken('test-key'),
      params,
      endpoint: `${origin}${opts.endpointPath ?? '/v1'}`,
      apiStyle: opts.apiStyle ?? null,
    },
  } as never;
}

const lastBody = () => bodies[bodies.length - 1].body;

describe('callSettingsFor — the params → settings map', () => {
  it('maps temperature everywhere, reasoningEffort on openai, effort on anthropic', () => {
    expect(callSettingsFor({ provider: 'glm', params: { temperature: 0.3 } }).settings).toEqual({ temperature: 0.3 });
    expect(callSettingsFor({ provider: 'openai', params: { reasoningEffort: 'high' } }).settings).toEqual({
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    expect(callSettingsFor({ provider: 'anthropic', params: { effort: 'low', temperature: 0 } }).settings).toEqual({
      temperature: 0,
      providerOptions: { anthropic: { effort: 'low' } },
    });
  });

  it('slice 2: anthropic thinking:true is sent as ADAPTIVE; false is the default and not sent', () => {
    expect(callSettingsFor({ provider: 'anthropic', params: { thinking: true, effort: 'low' } })).toEqual({
      settings: { providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'low' } } },
      knobs: [{ param: 'thinking', state: 'SENT', detail: 'adaptive' }, { param: 'effort', state: 'SENT' }],
    });
    const off = callSettingsFor({ provider: 'anthropic', params: { thinking: false } });
    expect(off.settings).toEqual({});
    expect(off.knobs).toEqual([expect.objectContaining({ param: 'thinking', state: 'NOT_SENT' })]);
  });

  it('forwards nothing unmapped: a knob on the wrong provider, passthrough keys (accepted, labelled not sent)', () => {
    const { settings, knobs } = callSettingsFor({
      provider: 'anthropic',
      params: { reasoningEffort: 'high', bedrockRegion: 'us-east-1' },
    });
    expect(settings).toEqual({});
    expect(knobs.map((k) => [k.param, k.state])).toEqual([['reasoningEffort', 'NOT_SENT'], ['bedrockRegion', 'NOT_SENT']]);
  });

  it('slice 2: maxTokens is a per-config CEILING, min(params.maxTokens, the caller\'s budget)', () => {
    expect(callSettingsFor({ provider: 'glm', params: { maxTokens: 50 } }, 200)).toEqual({
      settings: { maxOutputTokens: 50 },
      knobs: [{ param: 'maxTokens', state: 'SENT', detail: 'output ceiling 50' }],
    });
    // The caller's own budget is never raised by a config.
    expect(callSettingsFor({ provider: 'glm', params: { maxTokens: 50 } }, 16)).toEqual({
      settings: { maxOutputTokens: 16 },
      knobs: [{ param: 'maxTokens', state: 'ADJUSTED', detail: expect.stringMatching(/own budget \(16\)/) }],
    });
    expect(callSettingsFor({ provider: 'glm', params: { maxTokens: 50 } }).settings).toEqual({ maxOutputTokens: 50 });
    // No config ceiling: the caller's budget passes through, unreported.
    expect(callSettingsFor({ provider: 'glm', params: null }, 200)).toEqual({ settings: { maxOutputTokens: 200 }, knobs: [] });
  });

  it('toolCalling stays out of both the settings and the report', () => {
    expect(callSettingsFor({ provider: 'openai-compatible', params: { toolCalling: true } })).toEqual({ settings: {}, knobs: [] });
    expect(callSettingsFor({ provider: 'glm', params: null })).toEqual({ settings: {}, knobs: [] });
  });
});

describe('withAdapterWarnings — the adapter has the last word', () => {
  const sent = [{ param: 'temperature', state: 'SENT' as const }, { param: 'effort', state: 'SENT' as const }];

  it('a clamp is ADJUSTED, a removal is DROPPED, and the adapter text is kept', () => {
    expect(withAdapterWarnings(sent, [{ type: 'unsupported', feature: 'temperature', details: '1.5 exceeds anthropic maximum of 1.0. clamped to 1.0' }])[0])
      .toEqual({ param: 'temperature', state: 'ADJUSTED', detail: '1.5 exceeds anthropic maximum of 1.0. clamped to 1.0' });
    expect(withAdapterWarnings(sent, [{ type: 'unsupported', feature: 'temperature', details: 'temperature is not supported for reasoning models' }])[0])
      .toMatchObject({ state: 'DROPPED' });
  });

  it('every param the mapper can send has a warning feature, so no adapter drop reads as SENT (#1485 QA)', () => {
    const sendable = new Set<string>();
    for (const provider of ['anthropic', 'openai', 'glm', 'bedrock', 'openai-compatible']) {
      const { knobs } = callSettingsFor({ provider, params: { temperature: 0.5, reasoningEffort: 'low', effort: 'low', thinking: true, maxTokens: 50 } });
      for (const k of knobs) if (k.state !== 'NOT_SENT') sendable.add(k.param);
    }
    expect([...sendable].sort()).toEqual(Object.keys(WARNING_FEATURE).sort());
  });

  it('a warning about some other feature changes nothing', () => {
    expect(withAdapterWarnings(sent, [{ type: 'unsupported', feature: 'topK' }])).toEqual(sent);
    expect(withAdapterWarnings(sent, undefined)).toEqual(sent);
  });
});

describe('#1417 — the knobs on the wire, per call site', () => {
  it('generateText: varying temperature changes the request body (the #1417 repro, inverted)', async () => {
    await generateText(config('glm', { temperature: 0 }), { prompt: 'hi', maxTokens: 16 });
    await generateText(config('glm', { temperature: 0.7 }), { prompt: 'hi', maxTokens: 16 });
    await generateText(config('glm', null), { prompt: 'hi', maxTokens: 16 });
    expect(bodies.map((b) => b.body.temperature)).toEqual([0, 0.7, undefined]);
  });

  it('generateText reports each knob it sent', async () => {
    const out = await generateText(config('glm', { temperature: 0.2, maxTokens: 50, bogus: 1 }), { prompt: 'hi' });
    expect(out.knobs).toEqual([
      { param: 'temperature', state: 'SENT' },
      { param: 'maxTokens', state: 'SENT', detail: 'output ceiling 50' },
      expect.objectContaining({ param: 'bogus', state: 'NOT_SENT' }),
    ]);
    // Slice 2 (Holger 2026-09-30): the config's maxTokens is the output ceiling.
    expect(lastBody().max_tokens).toBe(50);
  });

  it('generateWithTools: the tool loop sends the same settings', async () => {
    const out = await generateWithTools(
      config('openai-compatible', { toolCalling: true, temperature: 0.4 }, { apiStyle: 'CHAT_COMPLETIONS' }),
      { prompt: 'hi' },
      [],
      { toolCtx: {} as never },
    );
    expect(lastBody().temperature).toBe(0.4);
    expect(out.knobs).toEqual([{ param: 'temperature', state: 'SENT' }]);
  });

  it('generateExtraction: the native structured path sends them too', async () => {
    const out = await generateExtraction(
      config('openai', { temperature: 0.1 }, { model: 'gpt-4.1', apiStyle: 'CHAT_COMPLETIONS' }),
      { prompt: 'hi' },
      [{ field: 'answer' }],
    );
    expect(bodies[0].body.temperature).toBe(0.1);
    expect(bodies[0].body.response_format).toBeDefined(); // the native path, not the fallback
    expect(out.knobs).toEqual([{ param: 'temperature', state: 'SENT' }]);
  });

  it('generateExtraction: and so does the JSON-prompt fallback', async () => {
    const out = await generateExtraction(config('glm', { temperature: 0.6 }), { prompt: 'hi' }, [{ field: 'answer' }]);
    expect(lastBody().temperature).toBe(0.6);
    expect(out.knobs).toEqual([{ param: 'temperature', state: 'SENT' }]);
  });

  it('openai reasoningEffort reaches Chat Completions as reasoning_effort', async () => {
    const out = await generateText(
      config('openai', { reasoningEffort: 'low' }, { model: 'o3-mini', apiStyle: 'CHAT_COMPLETIONS' }),
      { prompt: 'hi' },
    );
    expect(lastBody().reasoning_effort).toBe('low');
    expect(out.knobs).toEqual([{ param: 'reasoningEffort', state: 'SENT' }]);
  });

  it('openai reasoningEffort reaches the Responses API as reasoning.effort', async () => {
    await generateText(config('openai', { reasoningEffort: 'medium' }, { model: 'o3-mini' }), { prompt: 'hi' });
    expect(bodies[0].path).toMatch(/\/responses$/);
    expect(lastBody().reasoning).toMatchObject({ effort: 'medium' });
  });

  it('negative: reasoningEffort on a NON-reasoning Responses model is DROPPED by the adapter and reported so (#1485 QA, Charles)', async () => {
    const out = await generateText(
      config('openai', { temperature: 0.3, reasoningEffort: 'low' }, { model: 'gpt-4.1' }),
      { prompt: 'hi' },
    );
    expect(bodies[0].path).toMatch(/\/responses$/);
    expect(lastBody().reasoning).toBeUndefined();
    expect(lastBody().temperature).toBe(0.3);
    expect(out.knobs).toEqual([
      { param: 'temperature', state: 'SENT' },
      { param: 'reasoningEffort', state: 'DROPPED', detail: expect.stringMatching(/non-reasoning/) },
    ]);
  });

  it('negative: temperature on an openai reasoning model is DROPPED by the adapter and reported so', async () => {
    const out = await generateText(
      config('openai', { temperature: 0.5 }, { model: 'o3-mini', apiStyle: 'CHAT_COMPLETIONS' }),
      { prompt: 'hi' },
    );
    expect(lastBody().temperature).toBeUndefined();
    expect(out.knobs).toEqual([
      { param: 'temperature', state: 'DROPPED', detail: expect.stringMatching(/reasoning models/) },
    ]);
  });

  it('anthropic effort reaches the wire as output_config.effort; a clamped temperature is ADJUSTED', async () => {
    const out = await generateText(
      config('anthropic', { effort: 'high', temperature: 1.5 }, { model: 'claude-sonnet-4-5' }),
      { prompt: 'hi', maxTokens: 16 },
    );
    expect(bodies[0].path).toMatch(/\/messages$/);
    expect(lastBody().output_config).toMatchObject({ effort: 'high' });
    expect(lastBody().temperature).toBe(1);
    expect(out.knobs).toEqual([
      { param: 'effort', state: 'SENT' },
      { param: 'temperature', state: 'ADJUSTED', detail: expect.stringMatching(/clamped/) },
    ]);
  });

  it('slice 2: anthropic thinking reaches the wire as ADAPTIVE, with no budget on top of max_tokens', async () => {
    const out = await generateText(
      config('anthropic', { thinking: true }, { model: 'claude-sonnet-4-5' }),
      { prompt: 'hi', maxTokens: 16 },
    );
    expect(lastBody().thinking).toEqual({ type: 'adaptive' });
    expect(lastBody().max_tokens).toBe(16);
    expect(out.knobs).toEqual([{ param: 'thinking', state: 'SENT', detail: 'adaptive' }]);
  });

  it('slice 2: with thinking on, the adapter drops temperature and the report says so', async () => {
    const out = await generateText(
      config('anthropic', { thinking: true, temperature: 0.4 }, { model: 'claude-sonnet-4-5' }),
      { prompt: 'hi', maxTokens: 16 },
    );
    expect(lastBody().temperature).toBeUndefined();
    expect(out.knobs).toContainEqual({ param: 'temperature', state: 'DROPPED', detail: expect.stringMatching(/thinking/) });
  });

  it('slice 2: the maxTokens ceiling binds every call site: runs, the tool loop, and extraction', async () => {
    await generateText(config('glm', { maxTokens: 40 }), { prompt: 'hi', maxTokens: 500 });
    expect(lastBody().max_tokens).toBe(40);
    await generateWithTools(
      config('openai-compatible', { toolCalling: true, maxTokens: 41 }, { apiStyle: 'CHAT_COMPLETIONS' }),
      { prompt: 'hi', maxTokens: 500 }, [], { toolCtx: {} as never },
    );
    expect(lastBody().max_tokens).toBe(41);
    await generateExtraction(
      config('openai', { maxTokens: 42 }, { model: 'gpt-4.1', apiStyle: 'CHAT_COMPLETIONS' }),
      { prompt: 'hi', maxTokens: 500 }, [{ field: 'answer' }],
    );
    expect(bodies[bodies.length - 1].body.max_tokens ?? bodies[bodies.length - 1].body.max_completion_tokens).toBe(42);
    // A smaller caller budget wins: a run never spends past what it has left.
    const out = await generateText(config('glm', { maxTokens: 40 }), { prompt: 'hi', maxTokens: 10 });
    expect(lastBody().max_tokens).toBe(10);
    expect(out.knobs).toEqual([expect.objectContaining({ param: 'maxTokens', state: 'ADJUSTED' })]);
  });

  it('slice 2: a ceiling above the model\'s own maximum is limited by the adapter and reported ADJUSTED', async () => {
    const out = await generateText(config('anthropic', { maxTokens: 10_000_000 }, { model: 'claude-sonnet-4-5' }), { prompt: 'hi' });
    expect(lastBody().max_tokens).toBeLessThan(10_000_000);
    expect(out.knobs).toEqual([{ param: 'maxTokens', state: 'ADJUSTED', detail: expect.stringMatching(/limited to/) }]);
  });

  it('negative: a knob validated for another provider rides passthrough on glm and is NOT sent', async () => {
    const out = await generateText(config('glm', { reasoningEffort: 'high' }), { prompt: 'hi' });
    expect(lastBody().reasoning_effort).toBeUndefined();
    expect(out.knobs).toEqual([expect.objectContaining({ param: 'reasoningEffort', state: 'NOT_SENT' })]);
  });
});
