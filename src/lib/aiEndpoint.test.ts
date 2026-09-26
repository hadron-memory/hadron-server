/**
 * #1373 — endpoint write validation and resolution precedence (pure).
 */

import { describe, it, expect } from 'vitest';
import { AI_PROVIDER_ENDPOINTS, effectiveEndpoint, explicitEndpoint, validateEndpoint } from './aiEndpoint.js';

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

describe('endpoint precedence', () => {
  it('endpoint beats params.baseUrl, which beats the provider default', () => {
    const glm = { provider: 'glm', params: { baseUrl: 'https://legacy.example/v4' } };
    expect(effectiveEndpoint({ ...glm, endpoint: 'https://api.z.ai/api/paas/v4' })).toBe('https://api.z.ai/api/paas/v4');
    expect(effectiveEndpoint(glm)).toBe('https://legacy.example/v4');
    expect(effectiveEndpoint({ provider: 'glm' })).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('params.baseUrl is honoured only by the providers that honoured it before (no silent host change)', () => {
    const params = { baseUrl: 'https://legacy.example/v1' };
    expect(explicitEndpoint({ provider: 'openai', params })).toBe('https://legacy.example/v1');
    expect(explicitEndpoint({ provider: 'anthropic', params })).toBeNull();
    expect(explicitEndpoint({ provider: 'bedrock', params })).toBeNull();
  });

  it('bedrock has no default endpoint (the SDK derives it from the region)', () => {
    expect(effectiveEndpoint({ provider: 'bedrock' })).toBeNull();
  });

  it('every listed provider has exactly one default, and every suggestion passes validation', () => {
    for (const [provider, list] of Object.entries(AI_PROVIDER_ENDPOINTS)) {
      if (list.length) expect(list.filter((e) => e.isDefault), provider).toHaveLength(1);
      for (const e of list) expect(validateEndpoint(e.url, prod)).toBe(e.url);
    }
  });
});
