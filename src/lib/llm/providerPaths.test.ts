/**
 * #1374 — the HTTP path each provider shape actually calls. `modelFor` builds
 * every OpenAI-compatible model through `@ai-sdk/openai`, whose provider call
 * selects the Responses API (POST /responses) in 4.x; `glm` hosts (Zhipu,
 * Z.ai) serve only /chat/completions, so glm must build `.chat(model)`.
 *
 * No provider and no real key: a local capture server records each request.
 * `glm`'s DEFAULT base URL is a real host, so that one case stubs fetch
 * instead and records the URL it would have called.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateChatRespond, generateExtraction, generateText, generateWithTools, LlmInvocationError, NoToolSupportError } from './index.js';
import { encryptToken } from '../tokenCrypto.js';

interface Captured {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

const CHAT_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'GLM-5.3',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const RESPOND_COMPLETION = {
  ...CHAT_COMPLETION,
  choices: [{
    index: 0,
    message: {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'call-1', type: 'function',
        function: { name: 'respond', arguments: JSON.stringify({ message: 'Welcome', data: { name: 'Ada' }, next_stage: null }) },
      }],
    },
    finish_reason: 'tool_calls',
  }],
};

let server: Server;
let origin: string;
const captured: Captured[] = [];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? '';
    captured.push({ method: req.method ?? '', path, auth: req.headers.authorization, body: await readBody(req) });
    res.setHeader('content-type', 'application/json');
    if (path.startsWith('/redirect/')) {
      res.statusCode = 307;
      res.setHeader('location', `${origin}/api/paas/v4/chat/completions`);
      res.end('{}');
      return;
    }
    if (path.startsWith('/slow-body/')) {
      // Headers now, the body in two late chunks: the guarded fetch has
      // returned (and closed its per-request agent) long before the SDK
      // reads this body.
      const body = JSON.stringify(CHAT_COMPLETION);
      res.flushHeaders();
      await new Promise((r) => setTimeout(r, 150));
      res.write(body.slice(0, 20));
      await new Promise((r) => setTimeout(r, 150));
      res.end(body.slice(20));
      return;
    }
    if (path.startsWith('/chat-error/')) {
      // A hostile endpoint may echo the Authorization header in its error.
      // The wrapper must not expose it through message OR cause.
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: `echo ${req.headers.authorization}`, type: 'invalid_request_error' } }));
      return;
    }
    if (path.endsWith('/chat/completions')) {
      res.end(JSON.stringify(path.startsWith('/chat-respond/') ? RESPOND_COMPLETION : CHAT_COMPLETION));
      return;
    }
    // Anything else is what a Chat-Completions-only host answers: a 4xx the
    // SDK does not retry, so each call records exactly one request.
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `no route ${path}`, type: 'invalid_request_error' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  captured.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function resolved(
  provider: string,
  params: Record<string, unknown> | null = null,
  endpoint: string | null = null,
  apiStyle: string | null = null,
  apiKeyEncrypted: string | null = encryptToken('test-key'),
  ownerType = 'ORGANIZATION',
) {
  return {
    ownerType,
    config: { provider, model: 'GLM-5.3', apiKeyEncrypted, params, endpoint, apiStyle },
  } as never;
}

/** Record the URL of every fetch the SDK makes to a provider's REAL default host. */
function stubDefaultHost(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify(CHAT_COMPLETION), { headers: { 'content-type': 'application/json' } });
  });
  return urls;
}

describe('#1374 — outgoing API path per provider shape', () => {
  it('glm with an endpoint calls {endpoint}/chat/completions and parses the reply', async () => {
    const out = await generateText(resolved('glm', null, `${origin}/api/paas/v4`), { prompt: 'hi' });
    expect(captured.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/paas/v4/chat/completions']);
    expect(captured[0].auth).toBe('Bearer test-key');
    expect(captured[0].body).toMatchObject({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toMatchObject({ text: 'ok', tokensIn: 3, tokensOut: 1, provider: 'glm' });
  });

  it('a body that arrives after the guarded fetch returns is still read in full (#1380 review)', async () => {
    const out = await generateText(resolved('glm', null, `${origin}/slow-body/v4`), { prompt: 'hi' });
    expect(out).toMatchObject({ text: 'ok', tokensIn: 3, tokensOut: 1 });
  });

  it('glm with NO endpoint calls the default Z.ai host at /chat/completions (D1)', async () => {
    const urls = stubDefaultHost();
    const out = await generateText(resolved('glm'), { prompt: 'hi' });
    expect(urls).toEqual(['https://api.z.ai/api/paas/v4/chat/completions']);
    expect(out.text).toBe('ok');
  });

  it('openai with an endpoint and no apiStyle stays on the Responses API (never inferred from the URL)', async () => {
    const err = await generateText(resolved('openai', null, `${origin}/v1`), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(captured.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/responses']);
  });

  it('official openai (no base URL) is UNCHANGED: the Responses API', async () => {
    vi.stubEnv('OPENAI_BASE_URL', `${origin}/v1`);
    const err = await generateText(resolved('openai'), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(captured.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/responses']);
  });
});

describe('#1418 — server-owned chat provider invocation', () => {
  const respondTool = {
    description: 'Respond to the user',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        data: { type: 'object' },
        next_stage: { type: ['string', 'null'] },
      },
      required: ['message'],
    },
  };

  it('sends history and one forced respond call through the configured guarded endpoint', async () => {
    const out = await generateChatRespond(
      resolved('glm', null, `${origin}/chat-respond/v4`),
      {
        system: 'Guide the user.\n\n',
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }],
        respondTool,
        maxTokens: 80,
        timeoutMs: 1000,
      },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ path: '/chat-respond/v4/chat/completions', auth: 'Bearer test-key' });
    expect(captured[0].body).toMatchObject({
      model: 'GLM-5.3',
      messages: [
        { role: 'system', content: 'Guide the user.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
      tool_choice: { type: 'function', function: { name: 'respond' } },
      max_tokens: 80,
    });
    expect(out).toEqual({
      respond: { message: 'Welcome', data: { name: 'Ada' }, next_stage: null },
      tokensIn: 3, tokensOut: 1, provider: 'glm', model: 'GLM-5.3',
    });
  });

  it('uses a synthetic provider prompt for the welcome turn without a persisted user message', async () => {
    await generateChatRespond(resolved('glm', null, `${origin}/chat-respond/v4`), {
      messages: [], respondTool,
    });
    expect(captured[0].body.messages).toEqual([{ role: 'user', content: 'Please begin the conversation.' }]);
  });

  it('wraps plain text when the stage has no respond tool', async () => {
    const out = await generateChatRespond(resolved('glm', null, `${origin}/v4`), {
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(out.respond).toEqual({ message: 'ok', data: {}, next_stage: null });
    expect(captured[0].body).not.toHaveProperty('tools');
  });

  it('rejects an unverified compatible host before sending a tool request', async () => {
    await expect(generateChatRespond(resolved('openai-compatible', null, `${origin}/chat-respond/v1`), {
      messages: [{ role: 'user', content: 'Hello' }], respondTool,
    })).rejects.toBeInstanceOf(NoToolSupportError);
    expect(captured).toEqual([]);
  });

  it('uses chat completions for an opted-in compatible host', async () => {
    const out = await generateChatRespond(
      resolved('openai-compatible', { toolCalling: true }, `${origin}/chat-respond/v1`, 'CHAT_COMPLETIONS'),
      { messages: [{ role: 'user', content: 'Hello' }], respondTool },
    );
    expect(captured.map((call) => call.path)).toEqual(['/chat-respond/v1/chat/completions']);
    expect(out.respond.message).toBe('Welcome');
  });

  it('rejects a response without the forced tool call without leaking provider text', async () => {
    await expect(generateChatRespond(resolved('glm', null, `${origin}/v4`), {
      messages: [{ role: 'user', content: 'Hello' }], respondTool,
    })).rejects.toThrow('Chat model did not return exactly one respond call.');
  });

  it('does not expose a provider-echoed bearer key through the error cause', async () => {
    const err = await generateChatRespond(resolved('glm', null, `${origin}/chat-error/v4`), {
      messages: [{ role: 'user', content: 'Hello' }], respondTool,
    }).catch((e: unknown) => e);
    expect(captured).toHaveLength(1);
    expect(captured[0].auth).toBe('Bearer test-key');
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect((err as Error).message).toBe('Chat LLM call failed (glm/GLM-5.3).');
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(`${String(err)} ${String((err as Error & { cause?: unknown }).cause)} ${(err as Error).stack}`).not.toContain('test-key');
  });
});

describe('#1373 — AiServiceConfig.endpoint and the connect-time egress guard', () => {
  it('the endpoint column is where each provider sends its request', async () => {
    await generateText(resolved('glm', null, `${origin}/zai/v4`), { prompt: 'hi' });
    await generateText(resolved('openai', null, `${origin}/oai/v1`), { prompt: 'hi' }).catch(() => undefined);
    await generateText(resolved('anthropic', null, `${origin}/ant/v1`), { prompt: 'hi' }).catch(() => undefined);
    expect(captured.map((c) => c.path)).toEqual(['/zai/v4/chat/completions', '/oai/v1/responses', '/ant/v1/messages']);
  });

  it('a legacy params.baseUrl is not read: the request goes to the provider default (D2)', async () => {
    const urls = stubDefaultHost();
    await generateText(resolved('glm', { baseUrl: `${origin}/legacy/v4` }), { prompt: 'hi' });
    expect(urls).toEqual(['https://api.z.ai/api/paas/v4/chat/completions']);
    expect(captured).toEqual([]);
  });

  it('apiStyle picks the wire protocol (D3), both ways round', async () => {
    await generateText(resolved('openai', null, `${origin}/compat/v1`, 'CHAT_COMPLETIONS'), { prompt: 'hi' });
    await generateText(resolved('glm', null, `${origin}/zai/v4`, 'RESPONSES'), { prompt: 'hi' }).catch(() => undefined);
    expect(captured.map((c) => c.path)).toEqual(['/compat/v1/chat/completions', '/zai/v4/responses']);
  });

  it('in production a loopback endpoint is refused before any request', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const err = await generateText(resolved('glm', null, `${origin}/zai/v4`), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/not allowed/);
    expect((err as LlmInvocationError).transient).toBe(false);
    expect(captured).toEqual([]);
  });

  it('the opt-in never reaches the metadata address, even with the key in hand (#1380 review)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS', 'true');
    const err = await generateText(resolved('glm', null, 'http://169.254.169.254/v1'), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/not allowed/);
    expect((err as LlmInvocationError).transient).toBe(false);
  });

  it('the self-hosted private-network opt-in admits it in production (D4)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS', 'true');
    const out = await generateText(resolved('glm', null, `${origin}/lan/v4`), { prompt: 'hi' });
    expect(out.text).toBe('ok');
    expect(captured.map((c) => c.path)).toEqual(['/lan/v4/chat/completions']);
  });

  it('a redirect is refused, not followed (a redirect to an IP literal would skip the pin)', async () => {
    const err = await generateText(resolved('glm', null, `${origin}/redirect/v4`), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/redirected \(307\)/);
    // The failure lands in AppRun.failure, which org READERs see; the
    // endpoint's host does not (#1380 review).
    expect(String(err.message)).not.toContain('127.0.0.1');
    expect((err as LlmInvocationError).transient).toBe(false);
    expect(captured.map((c) => c.path)).toEqual(['/redirect/v4/chat/completions']);
  });
});

describe('#1373 — the generic openai-compatible provider (Holger, 2026-09-26)', () => {
  it('calls {endpoint}/chat/completions by default and parses the reply; apiStyle RESPONSES switches it', async () => {
    const out = await generateText(resolved('openai-compatible', null, `${origin}/vllm/v1`), { prompt: 'hi' });
    expect(out).toMatchObject({ text: 'ok', provider: 'openai-compatible' });
    await generateText(resolved('openai-compatible', null, `${origin}/vllm/v1`, 'RESPONSES'), { prompt: 'hi' }).catch(() => undefined);
    expect(captured.map((c) => c.path)).toEqual(['/vllm/v1/chat/completions', '/vllm/v1/responses']);
  });

  it('with no endpoint it refuses, and never falls through to OpenAI\'s own host with the key', async () => {
    const urls = stubDefaultHost();
    const err = await generateText(resolved('openai-compatible'), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect((err as LlmInvocationError).transient).toBe(false);
    expect(urls).toEqual([]);
  });

  it('extraction takes the JSON-prompt path: no native json_schema request to an unknown host', async () => {
    await generateExtraction(resolved('openai-compatible', null, `${origin}/vllm/v1`), { prompt: 'hi' }, [
      { name: 'city', type: 'string' },
    ] as never).catch(() => undefined);
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.path).toBe('/vllm/v1/chat/completions');
      expect((c.body.response_format as { type?: string } | undefined)?.type).not.toBe('json_schema');
    }
  });

  it('the tool loop is refused unless the config opts in with params.toolCalling', async () => {
    const err = await generateWithTools(resolved('openai-compatible', null, `${origin}/vllm/v1`), { prompt: 'hi' }, [], {
      toolCtx: {} as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NoToolSupportError);
    expect(captured).toEqual([]);
    const out = await generateWithTools(
      resolved('openai-compatible', { toolCalling: true }, `${origin}/vllm/v1`),
      { prompt: 'hi' },
      [],
      { toolCtx: {} as never },
    );
    expect(out.text).toBe('ok');
    expect(captured.map((c) => c.path)).toEqual(['/vllm/v1/chat/completions']);
  });
});

describe('#1389 review: the server credentials never reach a configured host', () => {
  it.each(['openai', 'glm', 'anthropic'])('%s: an explicit endpoint with no stored key is refused, even with the env key set', async (provider) => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-SERVER-AMBIENT');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-SERVER-AMBIENT');
    const err = await generateText(resolved(provider, null, `${origin}/v1`, null, null), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/no stored key/);
    expect((err as LlmInvocationError).transient).toBe(false);
    expect(captured).toEqual([]);
  });

  it('glm with no endpoint and no stored key is refused: Z.ai never receives the server OpenAI key (#1385 review)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-SERVER-AMBIENT');
    const urls = stubDefaultHost();
    const err = await generateText(resolved('glm', null, null, null, null, 'HADRON_SERVER'), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/needs a stored key/);
    expect(urls).toEqual([]);
  });

  it('a keyless ORG config is refused even at the credential issuer host (#1390)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-SERVER-AMBIENT');
    const urls = stubDefaultHost();
    const err = await generateText(resolved('openai', null, null, 'CHAT_COMPLETIONS', null), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/only the platform's own configs/);
    expect(urls).toEqual([]);
  });

  it('a keyless HADRON_SERVER openai config uses the process credential at its own host', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-SERVER-AMBIENT');
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(input instanceof Request ? input.url : input)} ${new Headers(init?.headers).get('authorization')}`);
      return new Response(JSON.stringify(CHAT_COMPLETION), { headers: { 'content-type': 'application/json' } });
    });
    await generateText(resolved('openai', null, null, 'CHAT_COMPLETIONS', null, 'HADRON_SERVER'), { prompt: 'hi' });
    expect(seen).toEqual(['https://api.openai.com/v1/chat/completions Bearer sk-SERVER-AMBIENT']);
  });
});
