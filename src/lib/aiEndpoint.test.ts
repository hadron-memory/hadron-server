/**
 * #1373 — endpoint write validation and resolution precedence (pure).
 */

import { describe, it, expect } from 'vitest';
import {
  AI_PROVIDER_ENDPOINTS,
  effectiveApiStyle,
  effectiveEndpoint,
  explicitEndpoint,
  refuseLegacyBaseUrl,
  validateApiStyle,
  validateEndpoint,
} from './aiEndpoint.js';

const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('validateEndpoint', () => {
  it('accepts an https URL and strips trailing slashes', () => {
    expect(validateEndpoint('https://api.z.ai/api/paas/v4//', prod)).toBe('https://api.z.ai/api/paas/v4');
  });

  it.each([
    ['plain http to a public host', 'http://api.z.ai/v4'],
    ['credentials', 'https://user:pw@api.z.ai/v4'],
    ['a query', 'https://api.z.ai/v4?key=1'],
    ['a fragment', 'https://api.z.ai/v4#x'],
    ['a private IPv4 literal', 'https://10.1.2.3/v1'],
    ['the metadata address', 'https://169.254.169.254/latest'],
    ['a non-http scheme', 'ftp://api.z.ai/v4'],
    ['a relative URL', '/api/paas/v4'],
  ])('refuses %s', (_why, url) => {
    expect(() => validateEndpoint(url, dev)).toThrow(/Invalid endpoint/);
  });

  it('allows loopback (http included) only outside production', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
      expect(validateEndpoint(url, dev)).toBe(url);
      expect(() => validateEndpoint(url, prod), url).toThrow(/loopback/);
    }
  });
});

describe('endpoint resolution (D1, D2)', () => {
  it('an endpoint wins; an unset endpoint ALWAYS means the provider default', () => {
    expect(effectiveEndpoint({ provider: 'glm', endpoint: 'https://open.bigmodel.cn/api/paas/v4' })).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(effectiveEndpoint({ provider: 'glm' })).toBe('https://api.z.ai/api/paas/v4');
    expect(effectiveEndpoint({ provider: 'openai' })).toBe('https://api.openai.com/v1');
  });

  it('params.baseUrl is never read, and writing one is refused with a pointer to endpoint', () => {
    const legacy = { provider: 'openai', params: { baseUrl: 'https://legacy.example/v1' } };
    expect(explicitEndpoint(legacy)).toBeNull();
    expect(effectiveEndpoint(legacy)).toBe('https://api.openai.com/v1');
    expect(() => refuseLegacyBaseUrl({ baseUrl: 'https://legacy.example/v1' })).toThrow(/set the config's endpoint/);
    expect(() => refuseLegacyBaseUrl({ maxTokens: 10 })).not.toThrow();
    expect(() => refuseLegacyBaseUrl(null)).not.toThrow();
  });

  it('bedrock has no default endpoint (the SDK derives it from the region)', () => {
    expect(effectiveEndpoint({ provider: 'bedrock' })).toBeNull();
  });

  it('every listed provider has exactly one default, and every suggestion passes validation', () => {
    for (const [provider, list] of Object.entries(AI_PROVIDER_ENDPOINTS)) {
      if (list.length) expect(list.filter((e) => e.isDefault), provider).toHaveLength(1);
      for (const e of list) expect(validateEndpoint(e.url, prod)).toBe(e.url);
    }
    expect(AI_PROVIDER_ENDPOINTS.glm.find((e) => e.isDefault)!.url).toBe('https://api.z.ai/api/paas/v4');
  });
});

describe('private endpoints (D4)', () => {
  const optIn = { NODE_ENV: 'production', AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS: 'true' } as NodeJS.ProcessEnv;

  it('the self-hosted opt-in admits private and loopback hosts, plain http included', () => {
    for (const url of ['http://10.0.0.5:11434/v1', 'http://localhost:11434/v1', 'http://ollama.lan/v1']) {
      expect(validateEndpoint(url, optIn)).toBe(url);
    }
  });

  it('without it, production refuses them exactly as before', () => {
    expect(() => validateEndpoint('http://10.0.0.5:11434/v1', prod)).toThrow(/Invalid endpoint/);
    expect(() => validateEndpoint('http://localhost:11434/v1', prod)).toThrow(/loopback/);
    expect(() => validateEndpoint('https://10.0.0.5/v1', { ...prod, AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS: 'yes' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('it never admits credentials, a query or a fragment', () => {
    expect(() => validateEndpoint('http://u:p@10.0.0.5/v1', optIn)).toThrow(/credentials/);
    expect(() => validateEndpoint('http://10.0.0.5/v1?x=1', optIn)).toThrow(/query/);
  });
});

describe('apiStyle (D3)', () => {
  it('defaults by provider, and a stored style wins', () => {
    expect(effectiveApiStyle({ provider: 'glm' })).toBe('CHAT_COMPLETIONS');
    expect(effectiveApiStyle({ provider: 'openai' })).toBe('RESPONSES');
    expect(effectiveApiStyle({ provider: 'openai', apiStyle: 'CHAT_COMPLETIONS' })).toBe('CHAT_COMPLETIONS');
    expect(effectiveApiStyle({ provider: 'anthropic' })).toBeNull();
  });

  it('is refused for a single-protocol provider and for an unknown value', () => {
    expect(() => validateApiStyle('anthropic', 'CHAT_COMPLETIONS')).toThrow(/OpenAI-compatible providers only/);
    expect(() => validateApiStyle('bedrock', 'RESPONSES')).toThrow(/OpenAI-compatible providers only/);
    expect(() => validateApiStyle('openai', 'COMPLETIONS')).toThrow(/Unknown apiStyle/);
    expect(() => validateApiStyle('anthropic', null)).not.toThrow();
    expect(() => validateApiStyle('glm', 'RESPONSES')).not.toThrow();
  });
});
