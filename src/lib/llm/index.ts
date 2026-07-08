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
  tool as aiTool,
  stepCountIs,
  type LanguageModel,
} from 'ai';
import { AuthorFailError, type RunToolDef, type RunToolContext } from '../runner/tools/types.js';
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
// Native structured-output attempts are hard-capped: a provider that HANGS
// (rather than erroring) must trip the fallback instead of eating the whole
// run timeout. Observed live: bedrock claude-sonnet-4-6 generateObject never
// returned on alpha (2026-07-07) — zero tokens spent, run TIMED_OUT.
const EXTRACTION_NATIVE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.LLM_EXTRACTION_NATIVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
})();

/** Providers whose native structured-output path is not trusted yet. */
const JSON_PROMPT_ONLY_PROVIDERS = new Set(['bedrock', 'glm']);

export async function generateExtraction(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
  fields: ExtractionField[],
): Promise<LlmObjectResult> {
  const { provider, model } = resolved.config;
  // Known-bad native paths skip straight to the JSON-prompt fallback
  // (bedrock: observed hang; glm: openai-compatible shim, untested).
  if (JSON_PROMPT_ONLY_PROVIDERS.has(provider)) {
    return extractViaJsonPrompt(resolved, req, fields);
  }
  try {
    const out = await aiGenerateObject({
      model: modelFor(resolved),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      schema: extractionSchema(fields),
      ...(req.maxTokens != null ? { maxOutputTokens: req.maxTokens } : {}),
      abortSignal: AbortSignal.timeout(EXTRACTION_NATIVE_TIMEOUT_MS),
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
    // Our own abort cap fired: the native path hung. Falling back is the
    // point — retrying would hit the same hang (and the abort message
    // contains "timeout", which isTransient would misread as retryable).
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return extractViaJsonPrompt(resolved, req, fields);
    }
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

// ── Tool loop (plan-tools §4, phase 1) ──────────────────────────────────────

/** Spike-verified 2026-07-07 (_hs_local/spike-tool-loop.mjs): bedrock tool-
 *  calling is healthy — the #535 hang is generateObject-specific. glm's
 *  openai-compatible shim is untested ⇒ excluded (D-TL-8). */
const TOOL_LOOP_PROVIDERS = new Set(['anthropic', 'openai', 'bedrock']);

const DEFAULT_TOOL_STEP_CAP = (() => {
  const raw = Number(process.env.RUN_MAX_TOOL_STEPS_PER_HOP);
  return Number.isFinite(raw) && raw > 0 ? raw : 8; // D-TL-4
})();

export interface ToolCallRecord {
  name: string;
  ok: boolean;
  ms: number;
}

export interface LlmToolLoopResult extends LlmResult {
  toolCalls: ToolCallRecord[];
}

/** The D-TL-3 gate said no: policy, cancellation, or exhausted action budget. */
export class ToolDeniedError extends Error {
  constructor(readonly tool: string) {
    super(`Tool "${tool}" denied (policy, cancellation, or action budget).`);
    this.name = 'ToolDeniedError';
  }
}

/** A handler threw: terminal TOOL_FAILED, never retried (D-TL-6 — tool side
 *  effects are not known-idempotent, so redelivery is unsafe). */
export class ToolExecutionError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Tool "${tool}" failed: ${message}`, options);
    this.name = 'ToolExecutionError';
  }
}

export interface ToolLoopOpts {
  /** Max LLM steps for this hop (D-TL-4). Default RUN_MAX_TOOL_STEPS_PER_HOP (8). */
  stepCap?: number;
  /** Per-call governance (D-TL-3): checkActivation('tool.<name>'). False = deny. */
  onToolCall?: (name: string, cost: 0 | 1) => Promise<boolean>;
  /** Handler context (trail logging; kernel extends per phase). */
  toolCtx: RunToolContext;
}

/**
 * Bounded multi-step tool loop — the third LLM entry point beside
 * generateText/generateExtraction: same provider dispatch, same token
 * accounting (summed across steps), same transient classification for
 * provider errors raised BEFORE any tool executed.
 *
 * Error contract (plan-tools D-TL-6): AuthorFailError and ToolDeniedError
 * and ToolExecutionError propagate to the caller un-wrapped — the kernel
 * maps them to AUTHOR_FAIL / ACTIVATION_DENIED / TOOL_FAILED. They are
 * captured OUTSIDE the SDK's own error wrapping via a closure, so SDK
 * repackaging can never swallow them.
 */
export async function generateWithTools(
  resolved: ResolvedAiConfig,
  req: LlmRequest,
  toolDefs: readonly RunToolDef[],
  opts: ToolLoopOpts,
): Promise<LlmToolLoopResult> {
  const { provider, model } = resolved.config;
  if (!TOOL_LOOP_PROVIDERS.has(provider)) {
    // Loud, non-transient: silently running a tools-node WITHOUT its tools
    // would change semantics (D-TL-8).
    throw new LlmInvocationError(
      `Provider "${provider}" is not verified for the run tool loop (NO_TOOL_SUPPORT).`,
      provider,
      false,
    );
  }

  const toolCalls: ToolCallRecord[] = [];
  // Our terminal errors, captured before the SDK can wrap them.
  let fatal: Error | null = null;

  const sdkTools = Object.fromEntries(
    toolDefs.map((def) => [
      def.name,
      aiTool({
        description: def.description,
        inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema as never),
        execute: async (args: Record<string, unknown>) => {
          const started = Date.now();
          try {
            if (opts.onToolCall && !(await opts.onToolCall(def.name, def.cost))) {
              throw new ToolDeniedError(def.name);
            }
            const result = await def.execute(opts.toolCtx, args ?? {});
            toolCalls.push({ name: def.name, ok: true, ms: Date.now() - started });
            return result;
          } catch (err) {
            toolCalls.push({ name: def.name, ok: false, ms: Date.now() - started });
            // instanceof, not name-matching: a non-Error rejection with a
            // spoofed `name` must not ride the passthrough (PR-540 Copilot).
            fatal =
              err instanceof AuthorFailError || err instanceof ToolDeniedError
                ? err
                : new ToolExecutionError(
                    def.name,
                    String((err as Error)?.message ?? err),
                    { cause: err },
                  );
            throw fatal; // abort the SDK loop
          }
        },
      }),
    ]),
  );

  try {
    const out = await aiGenerateText({
      model: modelFor(resolved),
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      tools: sdkTools,
      stopWhen: stepCountIs(opts.stepCap ?? DEFAULT_TOOL_STEP_CAP),
      ...(req.maxTokens != null ? { maxOutputTokens: req.maxTokens } : {}),
    });
    const usage = out.totalUsage ?? out.usage; // summed across steps (spike-pinned)
    return {
      text: out.text,
      tokensIn: usage?.inputTokens ?? 0,
      tokensOut: usage?.outputTokens ?? 0,
      provider,
      model,
      toolCalls,
    };
  } catch (err) {
    if (fatal) throw fatal; // our terminal errors win over SDK wrapping
    if (err instanceof LlmInvocationError) throw err;
    // Transient (⇒ bus-redelivery retry) ONLY while no SIDE-EFFECTING tool
    // has executed (D-TL-6, refined per PR-540 Gemini): cost-0 tools are
    // retry-safe — reads are pure, and hadron_log writes only to the
    // in-memory hop element, which a transient reset never persisted.
    const costOf = new Map(toolDefs.map((t) => [t.name, t.cost]));
    const sideEffectRan = toolCalls.some((c) => c.ok && (costOf.get(c.name) ?? 1) > 0);
    throw new LlmInvocationError(
      `LLM tool loop failed (${provider}/${model}): ${String((err as Error)?.message ?? err)}`,
      provider,
      isTransient(err) && !sideEffectRan,
      { cause: err },
    );
  }
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
