/**
 * LLM invocation layer (spec 040 / headless-runner D-2026-05-09-001) — the
 * FIRST consumer of a resolved spec-036 AiServiceConfig.
 *
 * Deliberately small: single-shot text generation over the Vercel AI SDK,
 * dispatching on config.provider (anthropic | openai | glm | bedrock — glm
 * rides the OpenAI-compatible adapter). The headless runner's richer needs
 * (tool loops, streaming) grow HERE later; this module is the seed, not a
 * framework (plan §6 / 039 §7b).
 *
 * Key handling: AiServiceConfig.apiKeyEncrypted decrypts via decryptToken.
 * bedrock keys use the JSON-triple convention
 * { accessKeyId, secretAccessKey, region } (matches the embedding
 * SageMaker posture: explicit narrow credentials over ambient identity).
 */

import { generateText as aiGenerateText, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { ResolvedAiConfig } from '../aiConfig.js';
import { decryptToken } from '../tokenCrypto.js';

export interface LlmRequest {
  system?: string;
  prompt: string;
  /** Hard output ceiling — callers pass their remaining run budget. */
  maxTokens?: number;
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
}

export class LlmInvocationError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly transient: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LlmInvocationError';
  }
}

const GLM_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

function modelFor(resolved: ResolvedAiConfig): LanguageModel {
  const { provider, model, apiKeyEncrypted } = resolved.config;
  const key = apiKeyEncrypted ? decryptToken(apiKeyEncrypted) : undefined;
  const params = (resolved.config.params ?? {}) as { baseUrl?: string };
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: key })(model);
    case 'openai':
      return createOpenAI({ apiKey: key, ...(params.baseUrl ? { baseURL: params.baseUrl } : {}) })(model);
    case 'glm':
      // OpenAI-compatible endpoint (headless-runner D1 note).
      return createOpenAI({ apiKey: key, baseURL: params.baseUrl ?? GLM_DEFAULT_BASE_URL })(model);
    case 'bedrock': {
      let triple: { accessKeyId?: string; secretAccessKey?: string; region?: string } = {};
      if (key) {
        try {
          triple = JSON.parse(key) as typeof triple;
        } catch {
          throw new LlmInvocationError(
            'bedrock apiKey must be the JSON triple {accessKeyId, secretAccessKey, region}.',
            provider,
            false,
          );
        }
      }
      if (key && (!triple.accessKeyId || !triple.secretAccessKey || !triple.region)) {
        throw new LlmInvocationError(
          'bedrock apiKey JSON triple must carry accessKeyId, secretAccessKey, AND region.',
          provider,
          false,
        );
      }
      return createAmazonBedrock({
        region: triple.region,
        accessKeyId: triple.accessKeyId,
        secretAccessKey: triple.secretAccessKey,
      })(model);
    }
    default:
      // aiConfig validates providers at write time; this is defense in depth.
      throw new LlmInvocationError(`Unknown provider "${provider}".`, provider, false);
  }
}

/** Heuristic transient classification for retry/nak decisions. */
function isTransient(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const status = (err as { statusCode?: number; status?: number }).statusCode ??
    (err as { status?: number }).status;
  if (status != null) return status === 429 || status >= 500;
  return /timeout|timed out|econnre|enotfound|eai_again|socket|network|overloaded|rate.?limit/.test(msg);
}

export async function generateText(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
): Promise<LlmResult> {
  const { provider, model } = resolved.config;
  try {
    const out = await aiGenerateText({
      model: modelFor(resolved),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      ...(req.maxTokens != null ? { maxOutputTokens: req.maxTokens } : {}),
    });
    return {
      text: out.text,
      tokensIn: out.usage?.inputTokens ?? 0,
      tokensOut: out.usage?.outputTokens ?? 0,
      provider,
      model,
    };
  } catch (err) {
    if (err instanceof LlmInvocationError) throw err;
    throw new LlmInvocationError(
      `LLM call failed (${provider}/${model}): ${String((err as Error)?.message ?? err)}`,
      provider,
      isTransient(err),
      { cause: err },
    );
  }
}
