/**
 * #1380 review (Codex P2): a temporary resolver failure is RETRYABLE, not a
 * refusal — otherwise a run on an explicit endpoint fails for good on a DNS
 * blip instead of being redelivered. The resolver is mocked; nothing resolves
 * or connects for real.
 */

import { describe, it, expect, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookupMock(...args) }));

import { generateText, LlmInvocationError } from './index.js';
import { AiEndpointForbiddenError, AiEndpointResolveError, guardedEndpointFetch } from './endpointFetch.js';
import { encryptToken } from '../tokenCrypto.js';

const resolved = {
  ownerType: 'ORGANIZATION',
  config: { provider: 'glm', model: 'GLM-5.3', apiKeyEncrypted: encryptToken('k'), params: null, endpoint: 'https://llm.example.test/v4', apiStyle: null },
} as never;

const dnsError = (code: string) => Object.assign(new Error(`getaddrinfo ${code} llm.example.test`), { code });
// An async throw, not mockRejectedValue: that builds its rejected promise
// eagerly, and vitest reports the unobserved rejection as the test failure.
// Each test sets its own implementation; a beforeEach mockReset() here made
// vitest report the (handled) rejection as the test's failure.
const failLookupWith = (code: string) =>
  lookupMock.mockImplementation(async () => {
    throw dnsError(code);
  });

describe('connect-time resolution failures', () => {
  it.each(['EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL'])('%s is a retryable resolve error, and the run failure is transient', async (code) => {
    failLookupWith(code);
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointResolveError);
    const err = await generateText(resolved, { prompt: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInvocationError);
    expect((err as LlmInvocationError).transient).toBe(true);
  });

  it('a resolver that hangs is bounded by the caller deadline (#1385 review)', async () => {
    lookupMock.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const err = await guardedEndpointFetch()('https://llm.example.test/v4/chat/completions', { signal: AbortSignal.timeout(50) }).catch((e) => e);
    expect((err as Error).name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('an already-aborted request never starts the DNS lookup (#1385 review)', async () => {
    lookupMock.mockClear();
    lookupMock.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
    const ctrl = new AbortController();
    ctrl.abort(new Error('gave up'));
    const err = await guardedEndpointFetch()('https://llm.example.test/v4/chat/completions', { signal: ctrl.signal }).catch((e) => e);
    expect((err as Error).message).toBe('gave up');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('a host that does not exist (ENOTFOUND) is a permanent refusal', async () => {
    failLookupWith('ENOTFOUND');
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    const err = await generateText(resolved, { prompt: 'hi' }).catch((e) => e);
    expect((err as LlmInvocationError).transient).toBe(false);
  });

  it('plain http to a hostname that resolves to a PUBLIC address is refused at connect (#1380 review)', async () => {
    vi.stubEnv('AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS', 'true');
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const err = await guardedEndpointFetch()('http://llm.example.test/v4/chat/completions').catch((e) => e);
    expect(err).toBeInstanceOf(AiEndpointForbiddenError);
    expect(String(err.message)).toMatch(/plain http is allowed only to a private-network address/);
    // A mixed answer is refused too: every address must be private.
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }, { address: '93.184.216.34', family: 4 }]);
    await expect(guardedEndpointFetch()('http://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    vi.unstubAllEnvs();
  });

  it('a hostname that resolves to the metadata address is refused even under the private opt-in', async () => {
    vi.stubEnv('AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS', 'true');
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    // AWS's IPv6 instance metadata sits inside the ULA block the opt-in admits.
    lookupMock.mockResolvedValue([{ address: 'fd00:ec2::254', family: 6 }]);
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    vi.unstubAllEnvs();
  });
});
