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

  it('a host that does not exist (ENOTFOUND) is a permanent refusal', async () => {
    failLookupWith('ENOTFOUND');
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    const err = await generateText(resolved, { prompt: 'hi' }).catch((e) => e);
    expect((err as LlmInvocationError).transient).toBe(false);
  });

  it('a hostname that resolves to the metadata address is refused even under the private opt-in', async () => {
    vi.stubEnv('AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS', 'true');
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    await expect(guardedEndpointFetch()('https://llm.example.test/v4/chat/completions')).rejects.toBeInstanceOf(AiEndpointForbiddenError);
    vi.unstubAllEnvs();
  });
});
