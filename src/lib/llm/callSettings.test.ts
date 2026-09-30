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
import { callSettingsFor, withAdapterWarnings } from './callSettings.js';
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

  it('forwards nothing it is not ruled to: thinking, a knob on the wrong provider, passthrough keys', () => {
    const { settings, knobs } = callSettingsFor({
      provider: 'anthropic',
      params: { thinking: true, reasoningEffort: 'high', bedrockRegion: 'us-east-1' },
    });
    expect(settings).toEqual({});
    expect(knobs.map((k) => [k.param, k.state])).toEqual([
      ['thinking', 'NOT_SENT'],
      ['reasoningEffort', 'NOT_SENT'],
      ['bedrockRegion', 'NOT_SENT'],
    ]);
    expect(knobs[0].detail).toMatch(/#1417/);
  });

  it('leaves the caller-shaped params out of both the settings and the report', () => {
    expect(callSettingsFor({ provider: 'openai-compatible', params: { maxTokens: 99, toolCalling: true } })).toEqual({
      settings: {},
      knobs: [],
    });
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
      expect.objectContaining({ param: 'bogus', state: 'NOT_SENT' }),
    ]);
    // maxTokens is the caller's: it is not forwarded from params.
    expect(lastBody().max_tokens).toBeUndefined();
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

  it('negative: anthropic thinking is validated but NOT sent, and no budget rides on top of max_tokens', async () => {
    const out = await generateText(
      config('anthropic', { thinking: true }, { model: 'claude-sonnet-4-5' }),
      { prompt: 'hi', maxTokens: 16 },
    );
    expect(lastBody().thinking).toBeUndefined();
    expect(lastBody().max_tokens).toBe(16);
    expect(out.knobs).toEqual([expect.objectContaining({ param: 'thinking', state: 'NOT_SENT' })]);
  });

  it('negative: a knob validated for another provider rides passthrough on glm and is NOT sent', async () => {
    const out = await generateText(config('glm', { reasoningEffort: 'high' }), { prompt: 'hi' });
    expect(lastBody().reasoning_effort).toBeUndefined();
    expect(out.knobs).toEqual([expect.objectContaining({ param: 'reasoningEffort', state: 'NOT_SENT' })]);
  });
});
