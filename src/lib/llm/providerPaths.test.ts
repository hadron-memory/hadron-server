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
import { generateText, LlmInvocationError } from './index.js';
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
    if (path.endsWith('/chat/completions')) {
      res.end(JSON.stringify(CHAT_COMPLETION));
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

function resolved(provider: string, params: Record<string, unknown> | null = null, endpoint: string | null = null) {
  return {
    ownerType: 'ORGANIZATION',
    config: { provider, model: 'GLM-5.3', apiKeyEncrypted: encryptToken('test-key'), params, endpoint },
  } as never;
}

describe('#1374 — outgoing API path per provider shape', () => {
  it('glm with a custom base URL calls {baseUrl}/chat/completions and parses the reply', async () => {
    const out = await generateText(resolved('glm', { baseUrl: `${origin}/api/paas/v4` }), { prompt: 'hi' });
    expect(captured.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/paas/v4/chat/completions']);
    expect(captured[0].auth).toBe('Bearer test-key');
    expect(captured[0].body).toMatchObject({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toMatchObject({ text: 'ok', tokensIn: 3, tokensOut: 1, provider: 'glm' });
  });

  it('glm with NO base URL calls the default Zhipu host at /chat/completions', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify(CHAT_COMPLETION), { headers: { 'content-type': 'application/json' } });
    });
    const out = await generateText(resolved('glm'), { prompt: 'hi' });
    expect(urls).toEqual(['https://open.bigmodel.cn/api/paas/v4/chat/completions']);
    expect(out.text).toBe('ok');
  });

  it('openai with a custom base URL is UNCHANGED: still the Responses API (a contract decision, not inferred)', async () => {
    const err = await generateText(resolved('openai', { baseUrl: `${origin}/v1` }), { prompt: 'hi' }).catch((e) => e);
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

describe('#1373 — AiServiceConfig.endpoint and the connect-time egress guard', () => {
  it('the endpoint column is where each provider sends its request', async () => {
    await generateText(resolved('glm', null, `${origin}/zai/v4`), { prompt: 'hi' });
    await generateText(resolved('openai', null, `${origin}/oai/v1`), { prompt: 'hi' }).catch(() => undefined);
    await generateText(resolved('anthropic', null, `${origin}/ant/v1`), { prompt: 'hi' }).catch(() => undefined);
    expect(captured.map((c) => c.path)).toEqual(['/zai/v4/chat/completions', '/oai/v1/responses', '/ant/v1/messages']);
  });

  it('endpoint wins over the legacy params.baseUrl', async () => {
    await generateText(resolved('glm', { baseUrl: `${origin}/legacy/v4` }, `${origin}/zai/v4`), { prompt: 'hi' });
    expect(captured.map((c) => c.path)).toEqual(['/zai/v4/chat/completions']);
  });

  it('in production a loopback endpoint is refused before any request, for endpoint AND legacy baseUrl', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const r of [resolved('glm', null, `${origin}/zai/v4`), resolved('openai', { baseUrl: `${origin}/v1` })]) {
      const err = await generateText(r, { prompt: 'hi' }).catch((e) => e);
      expect(err).toBeInstanceOf(LlmInvocationError);
      expect(String(err.message)).toMatch(/not allowed/);
      expect((err as LlmInvocationError).transient).toBe(false);
    }
    expect(captured).toEqual([]);
  });

  it('a redirect is refused, not followed (a redirect to an IP literal would skip the pin)', async () => {
    const err = await generateText(resolved('glm', null, `${origin}/redirect/v4`), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/redirected \(307\)/);
    expect((err as LlmInvocationError).transient).toBe(false);
    expect(captured.map((c) => c.path)).toEqual(['/redirect/v4/chat/completions']);
  });
});
