/**
 * #1373 — endpoint write validation and resolution precedence (pure).
 */

import { describe, it, expect } from 'vitest';
import {
  AI_PROVIDER_ENDPOINTS,
  effectiveApiStyle,
  effectiveEndpoint,
  explicitEndpoint,
  isPrivateNetworkAddress,
  refuseLegacyBaseUrl,
  requireEndpointFor,
  usesProcessCredential,
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

  it('never echoes the raw value: credentials in a refused URL stay out of the error (#1380 review)', () => {
    let message = '';
    try {
      validateEndpoint('https://user:s3cret-key@api.z.ai/v4', dev);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/credentials in the URL are not allowed/);
    expect(message).toContain("host 'api.z.ai'");
    expect(message).not.toContain('s3cret-key');
    expect(() => validateEndpoint('https://api.z.ai/v4?token=abc123', dev)).toThrow(/^(?!.*abc123)/);
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

  it('it never admits link-local (metadata), multicast, unspecified or other reserved ranges (#1380 review)', () => {
    for (const url of ['http://169.254.169.254/latest', 'http://[fe80::1]/v1', 'http://[fec0::1]/v1', 'http://224.0.0.1/v1', 'http://0.0.0.0/v1', 'http://[::]/v1', 'http://[fd00:ec2::254]/latest', 'http://[fd00:0ec2::254]/latest']) {
      expect(() => validateEndpoint(url, optIn), url).toThrow(/never allowed/);
    }
    for (const url of ['http://172.16.4.2/v1', 'http://192.168.1.9/v1', 'http://[fd12:3456::1]/v1', 'http://127.0.0.1/v1']) {
      expect(validateEndpoint(url, optIn), url).toBe(url);
    }
  });

  it('isPrivateNetworkAddress: RFC 1918, ULA and loopback, mapped forms included; nothing reserved', () => {
    for (const ip of ['10.1.2.3', '172.31.0.1', '192.168.0.1', '127.0.0.1', '::1', 'fd00::1', 'fc00::5', '::ffff:10.0.0.1']) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(true);
    }
    for (const ip of ['169.254.169.254', '172.32.0.1', '8.8.8.8', 'fe80::1', '224.0.0.1', '0.0.0.0', '::', 'ff02::1', '100.64.0.1', 'fd00:ec2::254', 'fd00:0ec2:0:0:0:0:0:254', 'fd00:ec2:1::5']) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(false);
    }
  });

  it('plain http is only for a private network: a public IP literal is refused at write (#1380 review)', () => {
    expect(() => validateEndpoint('http://8.8.8.8/v1', optIn)).toThrow(/plain http is allowed only to a private-network address/);
    expect(validateEndpoint('https://8.8.8.8/v1', optIn)).toBe('https://8.8.8.8/v1');
    // A hostname's class is unknown until it resolves: allowed here, checked at connect.
    expect(validateEndpoint('http://ollama.lan/v1', optIn)).toBe('http://ollama.lan/v1');
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

describe('openai-compatible (#1373)', () => {
  it('has no default endpoint and no suggestions: the host IS the configuration', () => {
    expect(effectiveEndpoint({ provider: 'openai-compatible' })).toBeNull();
    expect(AI_PROVIDER_ENDPOINTS['openai-compatible']).toEqual([]);
  });

  it('requires an endpoint; other providers do not', () => {
    expect(() => requireEndpointFor('openai-compatible', null)).toThrow(/needs an endpoint/);
    expect(() => requireEndpointFor('openai-compatible', 'https://api.together.xyz/v1')).not.toThrow();
    expect(() => requireEndpointFor('glm', null)).not.toThrow();
  });

  it('speaks Chat Completions by default, and either style may be chosen', () => {
    expect(effectiveApiStyle({ provider: 'openai-compatible' })).toBe('CHAT_COMPLETIONS');
    expect(() => validateApiStyle('openai-compatible', 'RESPONSES')).not.toThrow();
  });
});

describe('usesProcessCredential: which keyless configs may run on the server credential (#1385 review)', () => {
  it('only the platform config, only at a default host that issued it', () => {
    for (const provider of ['openai', 'anthropic', 'bedrock']) expect(usesProcessCredential({ provider }, 'HADRON_SERVER'), provider).toBe(true);
    for (const provider of ['glm', 'openai-compatible', 'mystery']) expect(usesProcessCredential({ provider }, 'HADRON_SERVER'), provider).toBe(false);
    expect(usesProcessCredential({ provider: 'openai', endpoint: 'https://llm.example.com/v1' }, 'HADRON_SERVER')).toBe(false);
  });

  it('never a tenant config: org, App and Agent configs need their own key (#1390)', () => {
    for (const owner of ['ORGANIZATION', 'APP', 'AGENT'] as const) {
      expect(usesProcessCredential({ provider: 'openai' }, owner), owner).toBe(false);
    }
  });
});
