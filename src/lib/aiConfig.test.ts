import { describe, expect, it } from 'vitest';

import {
  AiConfigValidationError,
  UnknownAiProviderError,
  apiKeyPreviewOf,
  apiKeyWriteFields,
  validateAiConfigName,
  validateProviderAndParams,
} from './aiConfig.js';
import { decryptToken } from './tokenCrypto.js';

describe('validateAiConfigName', () => {
  it('accepts conventional names and trims whitespace', () => {
    expect(validateAiConfigName('default')).toBe('default');
    expect(validateAiConfigName('fast')).toBe('fast');
    expect(validateAiConfigName(' frontier ')).toBe('frontier');
    expect(validateAiConfigName('claude-3_5')).toBe('claude-3_5');
  });

  it('rejects upper-case, empty, over-long, and bad-charset names', () => {
    expect(() => validateAiConfigName('Fast')).toThrow(AiConfigValidationError);
    expect(() => validateAiConfigName('')).toThrow(AiConfigValidationError);
    expect(() => validateAiConfigName('-leading-dash')).toThrow(AiConfigValidationError);
    expect(() => validateAiConfigName('a'.repeat(65))).toThrow(AiConfigValidationError);
    expect(() => validateAiConfigName('has space')).toThrow(AiConfigValidationError);
    expect(() => validateAiConfigName('colon:name')).toThrow(AiConfigValidationError);
  });
});

describe('validateProviderAndParams', () => {
  it('accepts known providers with null params', () => {
    for (const p of ['anthropic', 'openai', 'glm', 'bedrock']) {
      expect(() => validateProviderAndParams(p, null)).not.toThrow();
    }
  });

  it('rejects unknown providers', () => {
    expect(() => validateProviderAndParams('grok', null)).toThrow(UnknownAiProviderError);
    expect(() => validateProviderAndParams('', null)).toThrow(UnknownAiProviderError);
    // Providers are lower-case canonical; no silent case folding.
    expect(() => validateProviderAndParams('Anthropic', null)).toThrow(UnknownAiProviderError);
  });

  it('type-checks well-known params and passes unknown keys through', () => {
    expect(() =>
      validateProviderAndParams('anthropic', { maxTokens: 8192, thinking: true, effort: 'high' }),
    ).not.toThrow();
    // Unknown keys are allowed (passthrough) so new provider knobs need no release.
    expect(() =>
      validateProviderAndParams('anthropic', { someFutureKnob: 'x' }),
    ).not.toThrow();
    expect(() => validateProviderAndParams('anthropic', { maxTokens: -1 })).toThrow(
      UnknownAiProviderError,
    );
    expect(() => validateProviderAndParams('anthropic', { effort: 'extreme' })).toThrow(
      UnknownAiProviderError,
    );
    expect(() => validateProviderAndParams('openai', { reasoningEffort: 'extreme' })).toThrow(
      UnknownAiProviderError,
    );
    // #1373 D2: baseUrl is no longer a params key — the endpoint column
    // replaced it, and writing one is refused by refuseLegacyBaseUrl.
  });
});

describe('apiKeyPreviewOf', () => {
  it('shows ellipsis + last 4', () => {
    expect(apiKeyPreviewOf('sk-ant-abcd1234')).toBe('…1234');
    expect(apiKeyPreviewOf('abc')).toBe('…');
  });
});

describe('apiKeyWriteFields', () => {
  it('undefined keeps the stored key (no fields)', () => {
    expect(apiKeyWriteFields(undefined)).toEqual({});
  });

  it('empty string and null clear the key', () => {
    expect(apiKeyWriteFields('')).toEqual({ apiKeyEncrypted: null, apiKeyPreview: null });
    expect(apiKeyWriteFields(null)).toEqual({ apiKeyEncrypted: null, apiKeyPreview: null });
  });

  it('a value encrypts round-trippably and sets the preview', () => {
    const fields = apiKeyWriteFields('sk-test-9876') as {
      apiKeyEncrypted: string;
      apiKeyPreview: string;
    };
    expect(fields.apiKeyPreview).toBe('…9876');
    expect(fields.apiKeyEncrypted).not.toContain('9876');
    expect(decryptToken(fields.apiKeyEncrypted)).toBe('sk-test-9876');
  });
});
