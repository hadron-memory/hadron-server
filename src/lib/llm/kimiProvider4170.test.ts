/**
 * #4170 — `kimi` (Moonshot) as a named AI provider, offline. Every transport
 * is intercepted: a local capture server for explicit endpoints, a stubbed
 * `fetch` for the default host. No test reaches a real Moonshot host.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateExtraction, generateText, generateWithTools, providerSupportsTools, LlmInvocationError, NoToolSupportError } from './index.js';
import { encryptToken } from '../tokenCrypto.js';
import {
  AI_PROVIDER_ENDPOINTS,
  effectiveApiStyle,
  effectiveEndpoint,
  refuseLegacyBaseUrl,
  requireKeyFor,
  usesProcessCredential,
  validateApiStyle,
} from '../aiEndpoint.js';
import { KNOWN_AI_PROVIDERS, validateProviderAndParams } from '../aiConfig.js';
import { chatToolChoiceFor } from './chatToolChoice.js';

const MOONSHOT_INTL = 'https://api.moonshot.ai/v1';
const MOONSHOT_CN = 'https://api.moonshot.cn/v1';
const SENTINEL = 'sk-SERVER-AMBIENT-SENTINEL';

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
  model: 'kimi-k2',
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
      res.setHeader('location', `${origin}/v1/chat/completions`);
      res.end('{}');
      return;
    }
    if (path.endsWith('/chat/completions')) {
      res.end(JSON.stringify(CHAT_COMPLETION));
      return;
    }
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
  apiKeyEncrypted: string | null = encryptToken('kimi-test-key'),
  ownerType = 'ORGANIZATION',
) {
  return { ownerType, config: { provider, model: 'kimi-k2', apiKeyEncrypted, params, endpoint, apiStyle } } as never;
}

interface Seen {
  url: string;
  auth: string | null;
}
function stubDefaultHost(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      auth: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization'),
    });
    return new Response(JSON.stringify(CHAT_COMPLETION), { headers: { 'content-type': 'application/json' } });
  });
  return seen;
}

describe('#4170 acceptance 1 — default host, own key', () => {
  it('one request to api.moonshot.ai/v1/chat/completions with the config key, reply parsed', async () => {
    const seen = stubDefaultHost();
    const out = await generateText(resolved('kimi'), { prompt: 'hi' });
    expect(seen).toEqual([{ url: `${MOONSHOT_INTL}/chat/completions`, auth: 'Bearer kimi-test-key' }]);
    expect(out).toMatchObject({ text: 'ok', provider: 'kimi' });
  });
});

describe('#4170 acceptance 2 — no process-key fallback', () => {
  it.each(['HADRON_SERVER', 'ORGANIZATION', 'APP', 'AGENT'])('keyless %s kimi config refused, sentinel never sent', async (ownerType) => {
    vi.stubEnv('OPENAI_API_KEY', SENTINEL);
    const seen = stubDefaultHost();
    const err = await generateText(resolved('kimi', null, null, null, null, ownerType), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect((err as LlmInvocationError).transient).toBe(false);
    expect(String(err.message)).not.toContain(SENTINEL);
    expect(seen).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('keyless kimi with an explicit endpoint is refused too', async () => {
    vi.stubEnv('OPENAI_API_KEY', SENTINEL);
    const err = await generateText(resolved('kimi', null, `${origin}/v1`, null, null, 'HADRON_SERVER'), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(captured).toEqual([]);
  });

  it('usesProcessCredential is false and requireKeyFor refuses a keyless write for every owner', () => {
    for (const o of ['HADRON_SERVER', 'ORGANIZATION', 'APP', 'AGENT'] as const) {
      expect(usesProcessCredential({ provider: 'kimi' }, o), o).toBe(false);
      expect(() => requireKeyFor({ provider: 'kimi' }, false, o), o).toThrow();
    }
  });
});

describe('#4170 acceptance 3 — endpoint override', () => {
  it('sends {endpoint}/chat/completions with the config key; RESPONSES switches to /responses', async () => {
    await generateText(resolved('kimi', null, `${origin}/v1`), { prompt: 'hi' });
    await generateText(resolved('kimi', null, `${origin}/v1`, 'RESPONSES'), { prompt: 'hi' }).catch(() => undefined);
    expect(captured.map((c) => c.path)).toEqual(['/v1/chat/completions', '/v1/responses']);
    expect(captured[0].auth).toBe('Bearer kimi-test-key');
  });
});

describe('#4170 acceptance 4 — endpoint boundary parity with glm', () => {
  it('production refuses a loopback endpoint before any request', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const err = await generateText(resolved('kimi', null, `${origin}/v1`), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/not allowed/);
    expect(captured).toEqual([]);
  });

  it('the opt-in never reaches the metadata address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS', 'true');
    const err = await generateText(resolved('kimi', null, 'http://169.254.169.254/v1'), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/not allowed/);
  });

  it('the opt-in admits a LAN endpoint', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS', 'true');
    const out = await generateText(resolved('kimi', null, `${origin}/lan/v1`), { prompt: 'hi' });
    expect(out.text).toBe('ok');
    expect(captured.map((c) => c.path)).toEqual(['/lan/v1/chat/completions']);
  });

  it('a redirect is refused, not followed', async () => {
    const err = await generateText(resolved('kimi', null, `${origin}/redirect/v1`), { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect(String(err.message)).toMatch(/redirected \(307\)/);
    expect(captured.map((c) => c.path)).toEqual(['/redirect/v1/chat/completions']);
  });
});

describe('#4170 acceptance 5 — JSON-prompt extraction, no tools', () => {
  it('extraction sends no native json_schema response_format', async () => {
    await generateExtraction(resolved('kimi', null, `${origin}/v1`), { prompt: 'hi' }, [{ name: 'city', type: 'string' }] as never).catch(() => undefined);
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.path).toBe('/v1/chat/completions');
      expect(c.body.response_format).toBeUndefined();
    }
  });

  it('the tool loop is refused even with params.toolCalling', async () => {
    expect(providerSupportsTools({ provider: 'kimi', params: { toolCalling: true } })).toBe(false);
    const err = await generateWithTools(resolved('kimi', { toolCalling: true }, `${origin}/v1`), { prompt: 'hi' }, [], { toolCtx: {} as never }).catch((e) => e);
    expect(err).toBeInstanceOf(NoToolSupportError);
    expect(captured).toEqual([]);
  });

  it('chat tool choice stays FORCED', () => {
    expect(chatToolChoiceFor('kimi', 'kimi-k2')).toBe('FORCED');
  });
});

describe('#4170 acceptance 6 — catalogue', () => {
  it('exactly two entries, one default, in order', () => {
    expect(AI_PROVIDER_ENDPOINTS.kimi.map((e) => [e.url, e.isDefault])).toEqual([
      [MOONSHOT_INTL, true],
      [MOONSHOT_CN, false],
    ]);
    expect(effectiveEndpoint({ provider: 'kimi' })).toBe(MOONSHOT_INTL);
  });

  it('apiStyle accepted, baseUrl param refused, provider known', () => {
    expect(KNOWN_AI_PROVIDERS).toContain('kimi');
    expect(effectiveApiStyle({ provider: 'kimi' })).toBe('CHAT_COMPLETIONS');
    expect(() => validateApiStyle('kimi', 'RESPONSES')).not.toThrow();
    expect(() => validateProviderAndParams('kimi', { temperature: 0.2 })).not.toThrow();
    expect(() => refuseLegacyBaseUrl({ baseUrl: 'https://x' })).toThrow(/baseUrl/);
  });
});

describe('#4170 acceptance 7 — openai-compatible parity', () => {
  it('a Moonshot-shaped openai-compatible config is unchanged', async () => {
    await generateText(resolved('openai-compatible', null, `${origin}/v1`), { prompt: 'hi' });
    expect(captured.map((c) => c.path)).toEqual(['/v1/chat/completions']);
    expect(captured[0].auth).toBe('Bearer kimi-test-key');
    const err = await generateWithTools(resolved('openai-compatible', null, `${origin}/v1`), { prompt: 'hi' }, [], { toolCtx: {} as never }).catch((e) => e);
    expect(err).toBeInstanceOf(NoToolSupportError);
  });
});
