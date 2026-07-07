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

import {
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  jsonSchema,
  type LanguageModel,
} from 'ai';
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

// ── Structured extraction (plan-multi-node D-MN-2) ──────────────────────────

/** One extraction-spec entry as carried on Node.data.extractionSpec. */
export interface ExtractionField {
  field: string;
  description?: string;
  shape?: string;
}

export interface LlmObjectResult {
  /** Extracted fields, restricted to the declared spec. */
  object: Record<string, unknown>;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
}

/**
 * v1 shape vocabulary (D-MN-2): number / boolean / string[] map to their
 * JSON-schema types; anything else — including absent — degrades to string,
 * never throws. Fields are best-effort (the model may not find them), so
 * none are `required`.
 */
function shapeToJsonSchema(shape: string | undefined): Record<string, unknown> {
  // `shape` crosses a JSON boundary (Node.data) — a non-string value is
  // malformed data, which degrades to string like any unknown shape
  // (PR-532 review, Gemini).
  switch (typeof shape === 'string' ? shape.trim() : 'string') {
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'string[]': return { type: 'array', items: { type: 'string' } };
    default: return { type: 'string' };
  }
}

function extractionSchema(fields: ExtractionField[]) {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    properties[f.field] = {
      ...shapeToJsonSchema(f.shape),
      ...(f.description ? { description: f.description } : {}),
    };
  }
  return jsonSchema<Record<string, unknown>>({
    type: 'object',
    properties,
    additionalProperties: false,
  });
}

/** Keep only declared fields — the object merges into a persisted envelope. */
function restrictToSpec(
  raw: unknown,
  fields: ExtractionField[],
): Record<string, unknown> {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (obj[f.field] !== undefined) out[f.field] = obj[f.field];
  }
  return out;
}

/**
 * Structured single-shot extraction — the flow walker calls this instead of
 * `generateText` when the node declares `data.extractionSpec`. Same provider
 * dispatch, same token accounting, same transient classification.
 *
 * Providers without native structured output fall back — inside this
 * wrapper, invisible to the runner — to one JSON-mode text completion
 * parsed for the first JSON object in the reply.
 */
export async function generateExtraction(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
  fields: ExtractionField[],
): Promise<LlmObjectResult> {
  const { provider, model } = resolved.config;
  try {
    const out = await aiGenerateObject({
      model: modelFor(resolved),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      schema: extractionSchema(fields),
      ...(req.maxTokens != null ? { maxOutputTokens: req.maxTokens } : {}),
    });
    return {
      object: restrictToSpec(out.object, fields),
      tokensIn: out.usage?.inputTokens ?? 0,
      tokensOut: out.usage?.outputTokens ?? 0,
      provider,
      model,
    };
  } catch (err) {
    if (err instanceof LlmInvocationError) throw err;
    if (isTransient(err)) {
      throw new LlmInvocationError(
        `LLM extraction failed (${provider}/${model}): ${String((err as Error)?.message ?? err)}`,
        provider,
        true,
        { cause: err },
      );
    }
    // Non-transient — most likely a provider without native structured
    // output. One JSON-prompted text completion, then parse.
    return extractViaJsonPrompt(resolved, req, fields);
  }
}

async function extractViaJsonPrompt(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
  fields: ExtractionField[],
): Promise<LlmObjectResult> {
  const fieldLines = fields
    .map((f) => {
      // Same JSON-boundary defense as shapeToJsonSchema (PR-532 review).
      const shape = typeof f.shape === 'string' ? f.shape.trim() : 'string';
      return `- "${f.field}" (${shape})${f.description ? `: ${f.description}` : ''}`;
    })
    .join('\n');
  const out = await generateText(resolved, {
    ...(req.system ? { system: req.system } : {}),
    prompt:
      `${req.prompt}\n\n` +
      `Respond with ONLY a JSON object (no prose, no code fence) carrying these fields:\n${fieldLines}`,
    ...(req.maxTokens != null ? { maxTokens: req.maxTokens } : {}),
  });
  const start = out.text.indexOf('{');
  const end = out.text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new LlmInvocationError(
      `LLM extraction fallback returned no JSON object (${resolved.config.provider}/${resolved.config.model}).`,
      resolved.config.provider,
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.text.slice(start, end + 1));
  } catch {
    throw new LlmInvocationError(
      `LLM extraction fallback returned unparsable JSON (${resolved.config.provider}/${resolved.config.model}).`,
      resolved.config.provider,
      false,
    );
  }
  return {
    object: restrictToSpec(parsed, fields),
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    provider: out.provider,
    model: out.model,
  };
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
